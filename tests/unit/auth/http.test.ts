import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { BoundedPasswordVerificationLimiter, createAuthHttpHandler, LoginRateLimiter, type PasswordVerifier, type PasswordVerificationLimiter, type StudentJoinPort } from '../../../apps/server/src/auth/http.js';
import { AuthSessions, type Clock, type SessionToken } from '../../../apps/server/src/auth/session.js';
import type { AuthSessionRepository } from '../../../apps/server/src/db/auth-session-repository.js';
import type { ClassId, IsoUtc, Student, StudentId, StudentSession, TeacherSession } from '../../../apps/server/src/domain/types.js';

class TestRepository implements AuthSessionRepository {
  readonly teachers = new Map<string, TeacherSession>(); readonly students = new Map<string, StudentSession>();
  teacherPasswordHash(): string | undefined { return '$argon2id$fake'; }
  setTeacherPasswordHashIfAbsent(): boolean { return false; }
  createTeacherSession(value: TeacherSession): void { this.teachers.set(value.tokenHash, value); }
  createStudentSession(value: StudentSession): void { if ([...this.students.values()].some((existing) => existing.studentId === value.studentId && existing.revokedAtUtc === null)) throw new Error('STUDENT_SESSION_ALREADY_ACTIVE'); this.students.set(value.tokenHash, value); }
  findTeacherSession(hash: string): TeacherSession | undefined { return this.teachers.get(hash); } findStudentSession(hash: string): StudentSession | undefined { return this.students.get(hash); }
  touchTeacherSession(hash: string, now: IsoUtc, idle: IsoUtc): TeacherSession | undefined { const value = this.teachers.get(hash); if (value === undefined || value.revokedAtUtc !== null || value.idleExpiresAtUtc <= now || value.absoluteExpiresAtUtc <= now) return undefined; const next = { ...value, lastSeenAtUtc: now, idleExpiresAtUtc: idle }; this.teachers.set(hash, next); return next; }
  touchStudentSession(hash: string, now: IsoUtc, idle: IsoUtc): StudentSession | undefined { const value = this.students.get(hash); if (value === undefined || value.revokedAtUtc !== null || value.idleExpiresAtUtc <= now || value.absoluteExpiresAtUtc <= now) return undefined; const next = { ...value, lastSeenAtUtc: now, idleExpiresAtUtc: idle }; this.students.set(hash, next); return next; }
  revokeTeacherSession(hash: string, now: IsoUtc): boolean { return revoke(this.teachers, hash, now); } revokeStudentSession(hash: string, now: IsoUtc): boolean { return revoke(this.students, hash, now); }
  revokeTeacherSessionById(): boolean { return false; } revokeStudentSessionById(): boolean { return false; }
}
function revoke<T extends TeacherSession | StudentSession>(map: Map<string, T>, hash: string, now: IsoUtc): boolean { const value = map.get(hash); if (value === undefined || value.revokedAtUtc !== null) return false; map.set(hash, { ...value, revokedAtUtc: now } as T); return true; }
class FixedClock implements Clock { now(): Date { return new Date('2026-09-07T00:00:00.000Z'); } }
let server: Server | undefined;
let auditCodes: string[];
afterEach(async () => { await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve()); server = undefined; });

async function authServer(join: StudentJoinPort, overrides: Readonly<{ passwordVerifier?: PasswordVerifier; loginRateLimiter?: LoginRateLimiter; passwordVerificationLimiter?: PasswordVerificationLimiter }> = {}): Promise<string> {
  const repository = new TestRepository();
  auditCodes = [];
  let nextToken = 0;
  const handler = createAuthHttpHandler({ sessions: new AuthSessions(repository, new FixedClock(), () => `${nextToken === 0 ? 'teacher' : 'session'}-token-${nextToken++}` as SessionToken), sessionRepository: repository, studentJoin: join, allowedOrigin: 'http://classroom.test', csrfSecret: 'test-secret', passwordVerifier: overrides.passwordVerifier ?? (async (password) => password === 'correct'), loginRateLimiter: overrides.loginRateLimiter ?? new LoginRateLimiter(2, 60_000), ...(overrides.passwordVerificationLimiter === undefined ? {} : { passwordVerificationLimiter: overrides.passwordVerificationLimiter }), auditStudentJoinDenial: (entry) => { auditCodes.push(entry.code); } });
  server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing address'); return `http://127.0.0.1:${address.port}`;
}

describe('auth HTTP listener', () => {
  it('sets the required private-LAN cookie attributes after same-origin login', async () => {
    const base = await authServer({ join: () => undefined });
    const response = await fetch(`${base}/api/auth/teacher/login`, { method: 'POST', headers: { origin: 'http://classroom.test', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct' }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/teacher_session=teacher-token-0; Max-Age=43200; Path=\/; HttpOnly; SameSite=Lax/);
    await expect(response.json()).resolves.toMatchObject({ actor: 'teacher', csrfToken: expect.any(String) });
  });

  it('requires origin and rate-limits only repeated failed teacher credentials', async () => {
    const base = await authServer({ join: () => undefined });
    const missingOrigin = await fetch(`${base}/api/auth/teacher/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct' }) });
    expect(missingOrigin.status).toBe(403);
    const invalid = () => fetch(`${base}/api/auth/teacher/login`, { method: 'POST', headers: { origin: 'http://classroom.test', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    expect((await invalid()).status).toBe(401);
    // A successful authentication is never consumed as an attempt and clears
    // the preceding failures for this teacher/IP bucket.
    expect((await fetch(`${base}/api/auth/teacher/login`, { method: 'POST', headers: { origin: 'http://classroom.test', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct' }) })).status).toBe(200);
    expect((await invalid()).status).toBe(401);
    expect((await invalid()).status).toBe(401);
    expect((await invalid()).status).toBe(429);
  });

  it('closes 256 slow unauthorized body streams without retaining keep-alive sockets', async () => {
    const base = await authServer({ join: () => undefined });
    const port = Number(new URL(base).port);
    const responses: string[] = [];
    for (let offset = 0; offset < 256; offset += 16) {
      responses.push(...await Promise.all(Array.from({ length: 16 }, (_, index) => {
        const ordinal = offset + index;
        return slowRejectedRequest(port, ordinal % 2 === 0 ? 1 : 100_000_000, ordinal % 2 === 0);
      })));
    }
    expect(responses).toHaveLength(256);
    for (const response of responses) {
      expect(response).toMatch(/^HTTP\/1\.1 403 /);
      expect(response).toMatch(/\r\nconnection: close\r\n/i);
    }
  }, 10_000);

  it('reserves teacher capacity before concurrent password verification', async () => {
    let verifierCalls = 0;
    const base = await authServer(
      { join: () => undefined },
      {
        loginRateLimiter: new LoginRateLimiter(2, 60_000),
        passwordVerifier: async () => {
          verifierCalls += 1;
          await delay(25);
          return false;
        }
      }
    );
    const request = () => fetch(`${base}/api/auth/teacher/login`, { method: 'POST', headers: { origin: 'http://classroom.test', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    const responses = await Promise.all(Array.from({ length: 20 }, request));
    expect(verifierCalls).toBe(2);
    expect(responses.filter((response) => response.status === 401)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(18);
  });

  it('caps password verification globally across many source addresses', async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const base = await authServer(
      { join: () => undefined },
      {
        loginRateLimiter: new LoginRateLimiter(2, 60_000),
        passwordVerificationLimiter: new BoundedPasswordVerificationLimiter(2, 8),
        passwordVerifier: async () => {
          calls += 1;
          active += 1;
          peak = Math.max(peak, active);
          await delay(20);
          active -= 1;
          return false;
        }
      }
    );
    const port = Number(new URL(base).port);
    const responses = await Promise.all(Array.from({ length: 40 }, (_, index) => rawTeacherLogin(port, `127.0.0.${index + 2}`)));
    expect(peak).toBeLessThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(10);
    expect(responses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });

  it('keeps failure buckets bounded and expires old identities', () => {
    const limiter = new LoginRateLimiter(1, 1_000, 2);
    const start = new Date('2026-09-07T00:00:00.000Z');
    limiter.recordFailure('first', start);
    limiter.recordFailure('second', new Date(start.getTime() + 1));
    limiter.recordFailure('third', new Date(start.getTime() + 2));
    expect(limiter.allow('first', new Date(start.getTime() + 3))).toBe(true);
    expect(limiter.allow('second', new Date(start.getTime() + 3))).toBe(false);
    expect(limiter.allow('second', new Date(start.getTime() + 1_001))).toBe(true);
  });

  it('makes active-device, unknown, and unapproved student joins externally indistinguishable', async () => {
    const student: Student = { id: 'student-1' as StudentId, classId: 'class-1' as ClassId, displayName: 'Ada', rawStudentNumber: 'A1', normalizedStudentNumber: 'A1', isTemporary: false, approvedAtUtc: '2026-09-07T00:00:00.000Z' as never };
    const base = await authServer({ join: ({ displayName }) => displayName === 'Ada' ? student : undefined });
    const join = (displayName: string) => fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin: 'http://classroom.test', 'content-type': 'application/json' }, body: JSON.stringify({ classId: 'class-1', displayName, studentNumber: 'A1' }) });
    expect((await join('Ada')).status).toBe(200);
    const secondDevice = await join('Ada');
    const unknown = await join('Unknown');
    expect(secondDevice.status).toBe(403);
    expect(await secondDevice.json()).toEqual({ error: 'STUDENT_ACCESS_DENIED' });
    expect(unknown.status).toBe(secondDevice.status);
    expect(await unknown.json()).toEqual({ error: 'STUDENT_ACCESS_DENIED' });
    expect(auditCodes).toEqual(['STUDENT_SESSION_ALREADY_ACTIVE', 'STUDENT_JOIN_NOT_APPROVED']);
  });

  it('does not let successful student joins behind one NAT consume its failure budget', async () => {
    const students = new Map(Array.from({ length: 6 }, (_, index) => [`Student ${index}`, { id: `student-${index}` as StudentId, classId: 'class-1' as ClassId, displayName: `Student ${index}`, rawStudentNumber: `S${index}`, normalizedStudentNumber: `S${index}`, isTemporary: false, approvedAtUtc: '2026-09-07T00:00:00.000Z' as never }]));
    const base = await authServer({ join: ({ displayName }) => students.get(displayName) });
    for (const index of Array.from({ length: 6 }, (_, item) => item)) {
      const response = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin: 'http://classroom.test', 'content-type': 'application/json' }, body: JSON.stringify({ classId: 'class-1', displayName: `Student ${index}`, studentNumber: `S${index}` }) });
      expect(response.status).toBe(200);
    }
  });

  it('requires the session-derived CSRF token before logout', async () => {
    const base = await authServer({ join: () => undefined });
    const login = await fetch(`${base}/api/auth/teacher/login`, { method: 'POST', headers: { origin: 'http://classroom.test', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct' }) });
    const csrfToken = (await login.json() as { csrfToken: string }).csrfToken;
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (cookie === undefined) throw new Error('missing session cookie');
    const logout = (headers: Record<string, string>) => fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { origin: 'http://classroom.test', cookie, ...headers } });
    expect((await logout({})).status).toBe(403);
    const accepted = await logout({ 'x-csrf-token': csrfToken });
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('restores a teacher CSRF token only after same-origin bootstrap proof', async () => {
    const base = await authServer({ join: () => undefined });
    const login = await fetch(`${base}/api/auth/teacher/login`, { method: 'POST', headers: { origin: 'http://classroom.test', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (cookie === undefined) throw new Error('missing session cookie');
    const rejected = await fetch(`${base}/api/auth/teacher/csrf`, { method: 'POST', headers: { cookie, 'x-csrf-bootstrap': '1' } });
    expect(rejected.status).toBe(403);
    const accepted = await fetch(`${base}/api/auth/teacher/csrf`, { method: 'POST', headers: { cookie, origin: 'http://classroom.test', 'x-csrf-bootstrap': '1', 'sec-fetch-site': 'same-origin' } });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ csrfToken: expect.any(String) });
  });
});

function rawTeacherLogin(port: number, localAddress: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ password: 'wrong' });
    const socket = connect({ host: '127.0.0.1', port, localAddress });
    let received = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => { received += chunk; });
    socket.once('end', () => {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(received);
      if (match === null) reject(new Error(`missing HTTP status: ${received}`));
      else resolve(Number(match[1]));
    });
    socket.once('connect', () => {
      socket.write(`POST /api/auth/teacher/login HTTP/1.1\r\nHost: classroom.test\r\nOrigin: http://classroom.test\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
}

function slowRejectedRequest(port: number, contentLength: number, writeOneByte: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let received = '';
    const timeout = globalThis.setTimeout(() => {
      socket.destroy(); reject(new Error('unauthorized request did not close promptly'));
    }, 2_000);
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => { received += chunk; });
    socket.once('end', () => { globalThis.clearTimeout(timeout); resolve(received); });
    socket.once('connect', () => {
      socket.write(`POST /api/auth/teacher/login HTTP/1.1\r\nHost: classroom.test\r\nContent-Type: application/json\r\nContent-Length: ${contentLength}\r\n\r\n${writeOneByte ? 'x' : ''}`);
    });
  });
}
