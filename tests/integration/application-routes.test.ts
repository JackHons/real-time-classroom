import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApplication, FirstRunSetupRequiredError } from '../../apps/server/src/application.js';
import type { Clock } from '../../apps/server/src/auth/session.js';
import { openSqlite, type SqliteDatabase } from '../../apps/server/src/db/connection.js';
import { migrate } from '../../apps/server/src/db/migrator.js';
import { startServer, type RunningServer } from '../../apps/server/src/server.js';

const origin = 'http://classroom.test';
let database: SqliteDatabase | undefined;
let directory: string | undefined;
let server: RunningServer | undefined;

class MutableClock implements Clock {
  constructor(private current: Date) {}
  now(): Date { return this.current; }
  advance(milliseconds: number): void { this.current = new Date(this.current.getTime() + milliseconds); }
}

afterEach(async () => {
  await server?.close(); server = undefined;
  database?.close(); database = undefined;
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function databaseWithTeacherHash(): SqliteDatabase {
  directory = mkdtempSync(join(tmpdir(), 'lan-classroom-app-'));
  database = openSqlite(join(directory, 'classroom.sqlite'));
  migrate(database);
  database.prepare("INSERT INTO app_settings (key,value,created_at_utc,updated_at_utc) VALUES ('teacher_shared_password_hash',?,?,?)")
    .run('$argon2id$test', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z');
  return database;
}

async function applicationBase(clock?: Clock): Promise<string> {
  const app = createApplication({ database: databaseWithTeacherHash(), allowedOrigin: origin, csrfSecret: 'a'.repeat(32), passwordVerifier: async (password) => password === 'correct', ...(clock === undefined ? {} : { clock }) });
  server = await startServer({ host: '127.0.0.1', port: 0, apiHandler: app.apiHandler });
  return `http://${server.host}:${server.port}`;
}

async function teacherLogin(base: string): Promise<Readonly<{ cookie: string; csrf: string }>> {
  const response = await fetch(`${base}/api/auth/teacher/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct' }) });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined) throw new Error('test setup missing teacher cookie');
  return { cookie, csrf: (await response.json() as { csrfToken: string }).csrfToken };
}

function teacherHeaders(login: Readonly<{ cookie: string; csrf: string }>): Record<string, string> {
  return { origin, cookie: login.cookie, 'x-csrf-token': login.csrf, 'content-type': 'application/json' };
}

describe('Task 3 composed API routes', () => {
  it('keeps unconfigured instances closed except for the host health endpoint', async () => {
    directory = mkdtempSync(join(tmpdir(), 'lan-classroom-first-run-'));
    database = openSqlite(join(directory, 'classroom.sqlite'));
    expect(() => createApplication({ database: database as SqliteDatabase, allowedOrigin: origin, csrfSecret: 'a'.repeat(32) })).toThrow(FirstRunSetupRequiredError);
    server = await startServer({ host: '127.0.0.1', port: 0 });
    const base = `http://${server.host}:${server.port}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/classes`)).status).toBe(404);
  });

  it('enforces Origin, a teacher session, and CSRF on every teacher mutation', async () => {
    const base = await applicationBase();
    const anonymous = await fetch(`${base}/api/classes`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: '1A' }) });
    expect(anonymous.status).toBe(401);
    const login = await teacherLogin(base);
    const csrfMissing = await fetch(`${base}/api/classes`, { method: 'POST', headers: { origin, cookie: login.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: '1A' }) });
    expect(csrfMissing.status).toBe(403);
    const created = await fetch(`${base}/api/classes`, { method: 'POST', headers: teacherHeaders(login), body: JSON.stringify({ name: '1A' }) });
    expect(created.status).toBe(201);
    const classroom = await created.json() as { id: string };
    expect((await (await fetch(`${base}/api/classes`)).json()) as unknown).toEqual([{ id: classroom.id, name: '1A' }]);
    const noOrigin = await fetch(`${base}/api/classes/${classroom.id}`, { method: 'DELETE', headers: { cookie: login.cookie, 'x-csrf-token': login.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, impactAcknowledged: true }) });
    expect(noOrigin.status).toBe(403);
  });

  it('does not refresh a teacher idle session for rejected Origin or CSRF requests', async () => {
    const clock = new MutableClock(new Date('2026-09-07T00:00:00.000Z'));
    const base = await applicationBase(clock);
    const login = await teacherLogin(base);
    const before = database?.prepare('SELECT last_seen_at_utc,idle_expires_at_utc FROM teacher_sessions').get();
    clock.advance(60_000);
    const csrfRejected = await fetch(`${base}/api/classes`, { method: 'POST', headers: { origin, cookie: login.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: '1A' }) });
    expect(csrfRejected.status).toBe(403);
    const originRejected = await fetch(`${base}/api/classes`, { method: 'POST', headers: { cookie: login.cookie, 'x-csrf-token': login.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: '1A' }) });
    expect(originRejected.status).toBe(403);
    expect(database?.prepare('SELECT last_seen_at_utc,idle_expires_at_utc FROM teacher_sessions').get()).toEqual(before);
  });

  it('creates sessions only for exact roster matches, never for pending joins', async () => {
    const base = await applicationBase();
    const login = await teacherLogin(base);
    const created = await fetch(`${base}/api/classes`, { method: 'POST', headers: teacherHeaders(login), body: JSON.stringify({ name: '1A' }) });
    const classroom = await created.json() as { id: string };
    const imported = await fetch(`${base}/api/classes/${classroom.id}/roster/import`, { method: 'POST', headers: teacherHeaders(login), body: JSON.stringify({ csv: 'name,studentNumber\nAda,A1' }) });
    expect(imported.status).toBe(200);

    const matched = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, displayName: ' Ada ', studentNumber: ' a1 ' }) });
    expect(matched.status).toBe(200);
    expect(matched.headers.get('set-cookie')).toContain('student_session=');
    expect(database?.prepare('SELECT count(*) AS count FROM student_sessions').get()).toEqual({ count: 1 });

    const pending = await fetch(`${base}/api/classes/${classroom.id}/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Unauthorised', studentNumber: 'S2' }) });
    expect(pending.status).toBe(202);
    const request = await pending.json() as { request: { id: string } };
    const denied = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, displayName: 'Unauthorised', studentNumber: 'S2' }) });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'STUDENT_ACCESS_DENIED' });
    expect(database?.prepare('SELECT count(*) AS count FROM student_sessions').get()).toEqual({ count: 1 });

    const unknown = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: 'unknown-class', displayName: 'Unauthorised', studentNumber: 'S2' }) });
    expect(unknown.status).toBe(denied.status);
    expect(await unknown.json()).toEqual({ error: 'STUDENT_ACCESS_DENIED' });

    const approved = await fetch(`${base}/api/pending-student-requests/${request.request.id}/approve`, { method: 'POST', headers: teacherHeaders(login) });
    expect(approved.status).toBe(201);
    const approvedJoin = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, displayName: 'Unauthorised', studentNumber: 'S2' }) });
    expect(approvedJoin.status).toBe(200);
    expect(database?.prepare('SELECT count(*) AS count FROM student_sessions').get()).toEqual({ count: 2 });
    const secondDevice = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, displayName: 'Unauthorised', studentNumber: 'S2' }) });
    expect(secondDevice.status).toBe(403);
    expect(await secondDevice.json()).toEqual({ error: 'STUDENT_ACCESS_DENIED' });
  });
});
