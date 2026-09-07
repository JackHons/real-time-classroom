import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthHttpHandler, LoginRateLimiter, type StudentJoinPort } from '../../../apps/server/src/auth/http.js';
import { AuthSessions, type Clock, type SessionToken } from '../../../apps/server/src/auth/session.js';
import type { AuthSessionRepository } from '../../../apps/server/src/db/auth-session-repository.js';
import type { IsoUtc, StudentSession, TeacherSession } from '../../../apps/server/src/domain/types.js';

class TestRepository implements AuthSessionRepository {
  readonly teachers = new Map<string, TeacherSession>(); readonly students = new Map<string, StudentSession>();
  teacherPasswordHash(): string | undefined { return '$argon2id$fake'; }
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
afterEach(async () => { await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve()); server = undefined; });

async function authServer(join: StudentJoinPort): Promise<string> {
  const repository = new TestRepository();
  const handler = createAuthHttpHandler({ sessions: new AuthSessions(repository, new FixedClock(), () => 'teacher-token' as SessionToken), sessionRepository: repository, studentJoin: join, allowedOrigin: 'http://classroom.test', csrfSecret: 'test-secret', passwordVerifier: async (password) => password === 'correct', loginRateLimiter: new LoginRateLimiter(1, 60_000) });
  server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing address'); return `http://127.0.0.1:${address.port}`;
}

describe('auth HTTP listener', () => {
  it('sets the required private-LAN cookie attributes after same-origin login', async () => {
    const base = await authServer({ join: () => undefined });
    const response = await fetch(`${base}/api/auth/teacher/login`, { method: 'POST', headers: { origin: 'http://classroom.test', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct' }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/teacher_session=teacher-token; Max-Age=43200; Path=\/; HttpOnly; SameSite=Lax/);
    await expect(response.json()).resolves.toMatchObject({ actor: 'teacher', csrfToken: expect.any(String) });
  });

  it('requires origin and rate-limits failed teacher credentials', async () => {
    const base = await authServer({ join: () => undefined });
    const missingOrigin = await fetch(`${base}/api/auth/teacher/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct' }) });
    expect(missingOrigin.status).toBe(403);
    const invalid = () => fetch(`${base}/api/auth/teacher/login`, { method: 'POST', headers: { origin: 'http://classroom.test', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    expect((await invalid()).status).toBe(401);
    expect((await invalid()).status).toBe(429);
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
});
