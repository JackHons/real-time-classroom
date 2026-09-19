import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplication, FirstRunSetupRequiredError } from '../../apps/server/src/application.js';
import { StudentJoinRateLimiter } from '../../apps/server/src/auth/http.js';
import type { Clock } from '../../apps/server/src/auth/session.js';
import { openSqlite, type SqliteDatabase } from '../../apps/server/src/db/connection.js';
import { migrate } from '../../apps/server/src/db/migrator.js';
import { SqliteFileSubmissionTaskRepository } from '../../apps/server/src/db/file-submission-task-repository.js';
import { SqliteUploadPipelineRepository } from '../../apps/server/src/db/upload-pipeline-repository.js';
import { startServer, type RunningServer } from '../../apps/server/src/server.js';
import { UploadStorage } from '../../apps/server/src/uploads/storage.js';

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

async function applicationBase(clock?: Clock, studentJoinRateLimiter?: StudentJoinRateLimiter): Promise<string> {
  const app = createApplication({ database: databaseWithTeacherHash(), allowedOrigin: origin, csrfSecret: 'a'.repeat(32), passwordVerifier: async (password) => password === 'correct', uploadStorageRoot: join(directory as string, 'uploads'), ...(clock === undefined ? {} : { clock }), ...(studentJoinRateLimiter === undefined ? {} : { studentJoinRateLimiter }) });
  await app.reconcileUploads();
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

  it('requires an authenticated, CSRF-protected typed class name before deleting only that class', async () => {
    const base = await applicationBase();
    const teacher = await teacherLogin(base);
    const create = async (name: string): Promise<{ id: string }> => {
      const response = await fetch(`${base}/api/classes`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ name }) });
      expect(response.status).toBe(201); return response.json() as Promise<{ id: string }>;
    };
    const first = await create('1A'); const second = await create('1B');
    const anonymousImpact = await fetch(`${base}/api/classes/${first.id}`);
    expect(anonymousImpact.status).toBe(401);
    const impact = await fetch(`${base}/api/classes/${first.id}`, { headers: { cookie: teacher.cookie } });
    expect(impact.status).toBe(200);
    expect(await impact.json()).toMatchObject({ classId: first.id, className: '1A', students: 0, materials: 0, submissions: 0 });
    const wrongName = await fetch(`${base}/api/classes/${first.id}`, { method: 'DELETE', headers: teacherHeaders(teacher), body: JSON.stringify({ confirmationName: '1B', impactAcknowledged: true }) });
    expect(wrongName.status).toBe(400);
    expect(await wrongName.json()).toEqual({ error: 'CLASS_DELETE_NAME_CONFIRMATION_REQUIRED' });
    const csrfMissing = await fetch(`${base}/api/classes/${first.id}`, { method: 'DELETE', headers: { origin, cookie: teacher.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ confirmationName: '1A', impactAcknowledged: true }) });
    expect(csrfMissing.status).toBe(403);
    const deleted = await fetch(`${base}/api/classes/${first.id}`, { method: 'DELETE', headers: teacherHeaders(teacher), body: JSON.stringify({ confirmationName: '1A', impactAcknowledged: true }) });
    expect(deleted.status).toBe(204);
    expect((await (await fetch(`${base}/api/classes`)).json()) as unknown).toEqual([{ id: second.id, name: '1B' }]);
    expect((await fetch(`${base}/api/classes/${first.id}`, { headers: { cookie: teacher.cookie } })).status).toBe(404);
  });

  it('promptly closes unauthorized upload and teacher-mutation bodies at 1 byte and 100 MiB', async () => {
    const base = await applicationBase();
    const port = Number(new URL(base).port);
    const responses = await Promise.all([
      rawRejectedBody(port, '/api/classes/not-a-class/file-tasks/not-a-task/upload', 1, true),
      rawRejectedBody(port, '/api/classes/not-a-class/file-tasks/not-a-task/upload', 100_000_000, false),
      rawRejectedBody(port, '/api/classes', 100_000_000, false)
    ]);
    for (const response of responses) {
      expect(response).toMatch(/^HTTP\/1\.1 401 /);
      expect(response).toMatch(/\r\nconnection: close\r\n/i);
    }
  }, 10_000);

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

  it('creates a student session directly from a class and student number', async () => {
    const clock = new MutableClock(new Date('2026-09-07T00:00:00.000Z'));
    const base = await applicationBase(clock);
    const login = await teacherLogin(base);
    const created = await fetch(`${base}/api/classes`, { method: 'POST', headers: teacherHeaders(login), body: JSON.stringify({ name: '1A' }) });
    const classroom = await created.json() as { id: string };
    const imported = await fetch(`${base}/api/classes/${classroom.id}/roster/import`, { method: 'POST', headers: teacherHeaders(login), body: JSON.stringify({ csv: 'name,studentNumber\nAda,1001' }) });
    expect(imported.status).toBe(200);

    const matched = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, displayName: ' Ada ', studentNumber: ' 1001 ' }) });
    expect(matched.status).toBe(200);
    expect(matched.headers.get('set-cookie')).toContain('student_session=');
    expect(database?.prepare('SELECT count(*) AS count FROM student_sessions').get()).toEqual({ count: 1 });

    const direct = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, studentNumber: '1002' }) });
    expect(direct.status).toBe(200);
    expect(database?.prepare('SELECT count(*) AS count FROM student_sessions').get()).toEqual({ count: 2 });

    const unknown = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: 'unknown-class', displayName: 'Unauthorised', studentNumber: '1002' }) });
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual({ error: 'STUDENT_ACCESS_DENIED' });

    expect(database?.prepare('SELECT count(*) AS count FROM student_class_joins WHERE class_id=?').get(classroom.id)).toEqual({ count: 2 });
    const activeEntryBeforeRetry = database?.prepare('SELECT last_joined_at_utc,left_at_utc FROM student_class_joins WHERE class_id=? AND student_id=(SELECT id FROM students WHERE class_id=? AND raw_student_number=?)').get(classroom.id, classroom.id, '1002');
    clock.advance(60_000);
    const secondDevice = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, displayName: 'Unauthorised', studentNumber: '1002' }) });
    expect(secondDevice.status).toBe(403);
    expect(await secondDevice.json()).toEqual({ error: 'STUDENT_ACCESS_DENIED' });
    // The conflict is deliberately non-destructive: it cannot refresh the
    // first device's entry or make a left student appear rejoined.
    expect(database?.prepare('SELECT last_joined_at_utc,left_at_utc FROM student_class_joins WHERE class_id=? AND student_id=(SELECT id FROM students WHERE class_id=? AND raw_student_number=?)').get(classroom.id, classroom.id, '1002')).toEqual(activeEntryBeforeRetry);
  });

  it('does not consume the join failure budget for successful number-only joins', async () => {
    const base = await applicationBase(undefined, new StudentJoinRateLimiter(1, 20, 60_000));
    const login = await teacherLogin(base);
    const created = await fetch(`${base}/api/classes`, { method: 'POST', headers: teacherHeaders(login), body: JSON.stringify({ name: '1A' }) });
    const classroom = await created.json() as { id: string };
    const imported = await fetch(`${base}/api/classes/${classroom.id}/roster/import`, { method: 'POST', headers: teacherHeaders(login), body: JSON.stringify({ csv: 'name,studentNumber\nAda,1001' }) });
    expect(imported.status).toBe(200);

    // Exact roster matches release their reservations, so the same identity can
    // immediately use the session-producing route.
    const publicMatch = await fetch(`${base}/api/classes/${classroom.id}/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Ada', studentNumber: '1001' }) });
    expect(publicMatch.status).toBe(202);
    expect(await publicMatch.json()).toEqual({ outcome: 'accepted' });
    const authMatch = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, displayName: 'Ada', studentNumber: '1001' }) });
    expect(authMatch.status).toBe(200);

    const publicPending = await fetch(`${base}/api/classes/${classroom.id}/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ studentNumber: '1002' }) });
    expect(publicPending.status).toBe(202);
    const directJoin = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, studentNumber: '1002' }) });
    expect(directJoin.status).toBe(200);
    expect(database?.prepare('SELECT count(*) AS count FROM pending_student_requests').get()).toEqual({ count: 0 });
  });

  it('rejects non-digit identities on the public compatibility join route too', async () => {
    const base = await applicationBase();
    const teacher = await teacherLogin(base);
    const created = await fetch(`${base}/api/classes`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ name: '1A' }) });
    const classroom = await created.json() as { id: string };
    const invalid = await fetch(`${base}/api/classes/${classroom.id}/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ studentNumber: 'A100' }) });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'JOIN_STUDENT_NUMBER_DIGITS_ONLY' });
    expect(database?.prepare('SELECT count(*) AS count FROM students WHERE class_id=?').get(classroom.id)).toEqual({ count: 0 });
  });

  it('lets a student leave only their own current class while preserving the audit and student record', async () => {
    const base = await applicationBase();
    const teacher = await teacherLogin(base);
    const created = await fetch(`${base}/api/classes`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ name: '1A' }) });
    const classroom = await created.json() as { id: string };
    const secondCreated = await fetch(`${base}/api/classes`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ name: '1B' }) });
    const secondClassroom = await secondCreated.json() as { id: string };
    const joined = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, studentNumber: '1001' }) });
    expect(joined.status).toBe(200);
    const session = await joined.json() as { csrfToken: string };
    const cookie = joined.headers.get('set-cookie')?.split(';')[0];
    if (cookie === undefined) throw new Error('test setup missing student cookie');

    // A separate student's valid class scope must survive the first student's
    // leave.  Seed durable answer/submission rows too: leave is a membership
    // change only, never a destructive academic-data operation.
    const otherJoined = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: secondClassroom.id, studentNumber: '2002' }) });
    expect(otherJoined.status).toBe(200);
    const otherCookie = otherJoined.headers.get('set-cookie')?.split(';')[0];
    if (otherCookie === undefined) throw new Error('test setup missing other student cookie');
    const student = database?.prepare('SELECT id FROM students WHERE class_id=? AND raw_student_number=?').get(classroom.id, '1001') as { id: string };
    const at = '2026-09-17T00:00:00.000Z';
    database?.prepare("INSERT INTO questions (id,class_id,template_id,kind,prompt,reference_answer,state,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES ('leave-question',?,NULL,'short_text','Keep this answer',NULL,'open',?,NULL,?,?)").run(classroom.id, at, at, at);
    database?.prepare("INSERT INTO answer_current (id,question_id,student_id,revision,idempotency_key,payload_json,submitted_at_utc,late) VALUES ('leave-answer','leave-question',?,0,'leave-key','{\"kind\":\"short_text\",\"text\":\"retained\"}',?,0)").run(student.id, at);
    database?.prepare("INSERT INTO file_submission_tasks (id,class_id,title,description,state,max_bytes,deadline_at_utc,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES ('leave-task',?,'Keep this file','','closed',100000000,?,?,?,?,?)").run(classroom.id, at, at, at, at, at);
    database?.prepare("INSERT INTO file_submissions (id,task_id,student_id,original_filename,display_filename,storage_key,declared_mime_type,byte_length,sha256,received_complete_at_utc,deleted_at_utc) VALUES ('leave-submission','leave-task',?,'retained.txt','retained.txt','11111111-1111-4111-8111-111111111111','text/plain',1,?, ?,NULL)").run(student.id, 'a'.repeat(64), at);
    const durableBefore = database?.prepare("SELECT (SELECT count(*) FROM answer_current WHERE student_id=?) AS answers,(SELECT count(*) FROM file_submissions WHERE student_id=?) AS submissions").get(student.id, student.id);

    const noCsrf = await fetch(`${base}/api/auth/student/leave`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: '{}' });
    expect(noCsrf.status).toBe(403);
    const leave = await fetch(`${base}/api/auth/student/leave`, { method: 'POST', headers: { origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: '{}' });
    expect(leave.status).toBe(204);
    expect(leave.headers.get('set-cookie')).toContain('student_session=; Max-Age=0');
    expect((await fetch(`${base}/api/student/activities`, { headers: { cookie } })).status).toBe(401);
    expect(database?.prepare('SELECT count(*) AS count FROM students WHERE class_id=?').get(classroom.id)).toEqual({ count: 1 });
    expect(database?.prepare("SELECT (SELECT count(*) FROM answer_current WHERE student_id=?) AS answers,(SELECT count(*) FROM file_submissions WHERE student_id=?) AS submissions").get(student.id, student.id)).toEqual(durableBefore);
    expect((await fetch(`${base}/api/student/activities`, { headers: { cookie: otherCookie } })).status).toBe(200);
    expect(database?.prepare('SELECT left_at_utc FROM student_class_joins WHERE class_id=?').get(secondClassroom.id)).toEqual({ left_at_utc: null });
    const audit = database?.prepare('SELECT left_at_utc FROM student_class_joins WHERE class_id=?').get(classroom.id) as { left_at_utc: string | null };
    expect(audit.left_at_utc).toEqual(expect.any(String));
    const teacherView = await fetch(`${base}/api/teacher/classes/${classroom.id}/joined-students`, { headers: { cookie: teacher.cookie } });
    expect(await teacherView.json()).toEqual({ items: [expect.objectContaining({ studentNumber: '1001', leftAtUtc: expect.any(String) })] });
    // A retry cannot change unrelated data after the session is already revoked.
    expect((await fetch(`${base}/api/auth/student/leave`, { method: 'POST', headers: { origin, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    const rejoined = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, studentNumber: '1001' }) });
    expect(rejoined.status).toBe(200);
    expect(database?.prepare('SELECT left_at_utc FROM student_class_joins WHERE class_id=?').get(classroom.id)).toEqual({ left_at_utc: null });
    expect(database?.prepare('SELECT count(*) AS count FROM students WHERE class_id=?').get(classroom.id)).toEqual({ count: 1 });
  });

  it('serves authenticated teacher navigation and student-safe activity DTOs from the real server', async () => {
    const base = await applicationBase();
    const teacher = await teacherLogin(base);
    const created = await fetch(`${base}/api/classes`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ name: '1A' }) });
    const classroom = await created.json() as { id: string };
    await fetch(`${base}/api/classes/${classroom.id}/roster/import`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ csv: 'name,studentNumber\nAda,1001' }) });
    const pending = await fetch(`${base}/api/classes/${classroom.id}/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Unauthorised', studentNumber: '1002' }) });
    expect(pending.status).toBe(202);
    const draft = await fetch(`${base}/api/classes/${classroom.id}/question-drafts`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ question: { kind: 'short_text', prompt: 'Explain' } }) });
    const question = await draft.json() as { id: string };
    await fetch(`${base}/api/questions/${question.id}/open`, { method: 'POST', headers: teacherHeaders(teacher), body: '{}' });
    const taskResponse = await fetch(`${base}/api/classes/${classroom.id}/file-tasks`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ title: 'Upload', description: '', deadlineAtUtc: '2099-01-01T00:00:00.000Z' }) });
    const task = await taskResponse.json() as { id: string };
    await fetch(`${base}/api/classes/${classroom.id}/file-tasks/${task.id}/open`, { method: 'POST', headers: teacherHeaders(teacher), body: '{}' });

    expect((await fetch(`${base}/api/teacher/classes`)).status).toBe(401);
    const roster = await fetch(`${base}/api/teacher/classes/${classroom.id}/roster`, { headers: { cookie: teacher.cookie } });
    expect(await roster.json()).toEqual({ items: expect.arrayContaining([expect.objectContaining({ displayName: 'Ada', studentNumber: '1001' })]) });
    const teacherPending = await fetch(`${base}/api/teacher/classes/${classroom.id}/pending-student-requests`, { headers: { cookie: teacher.cookie } });
    expect(await teacherPending.json()).toEqual({ items: [] });
    expect(await (await fetch(`${base}/api/teacher/classes/${classroom.id}/questions`, { headers: { cookie: teacher.cookie } })).json()).toEqual({ items: [expect.objectContaining({ id: question.id, state: 'open' })] });
    expect(await (await fetch(`${base}/api/teacher/classes/${classroom.id}/file-tasks`, { headers: { cookie: teacher.cookie } })).json()).toEqual({ items: [expect.objectContaining({ id: task.id, state: 'open' })] });

    const join = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, displayName: 'Ada', studentNumber: '1001' }) });
    const studentCookie = join.headers.get('set-cookie')?.split(';')[0] as string;
    const csrf = await fetch(`${base}/api/auth/student/csrf`, { method: 'POST', headers: { origin, cookie: studentCookie, 'x-csrf-bootstrap': '1', 'sec-fetch-site': 'same-origin' } });
    expect(csrf.status).toBe(200);
    const csrfBody = await csrf.json() as { csrfToken: string };
    expect(csrfBody.csrfToken).not.toContain('teacher_shared_password_hash');
    expect((await fetch(`${base}/api/auth/student/csrf`, { method: 'POST', headers: { cookie: studentCookie } })).status).toBe(403);
    expect((await fetch(`${base}/api/auth/student/csrf`, { method: 'POST', headers: { origin: 'http://wrong-origin.test', cookie: studentCookie, 'x-csrf-bootstrap': '1', 'sec-fetch-site': 'same-origin' } })).status).toBe(403);
    const activities = await fetch(`${base}/api/student/activities`, { headers: { cookie: studentCookie } });
    expect(activities.headers.get('cache-control')).toBe('no-store');
    expect(await activities.json()).toEqual({ questions: { items: [expect.objectContaining({ id: question.id, prompt: 'Explain', state: 'open' })] }, fileTasks: { items: [expect.objectContaining({ id: task.id, title: 'Upload', state: 'open' })] }, materials: { items: [] } });
  });

  it('lets a teacher explicitly reopen a closed task after its original deadline', async () => {
    const clock = new MutableClock(new Date('2026-09-07T12:00:00.000Z'));
    const base = await applicationBase(clock);
    const teacher = await teacherLogin(base);
    const created = await fetch(`${base}/api/classes`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ name: 'Late reopen class' }) });
    const classroom = await created.json() as { id: string };
    database?.prepare("INSERT INTO file_submission_tasks (id,class_id,title,description,state,max_bytes,deadline_at_utc,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES (?,?,?,'','closed',100000000,?,?,?,?,?)")
      .run('late-task', classroom.id, 'Late upload', '2026-09-07T10:00:00.000Z', '2026-09-07T09:00:00.000Z', '2026-09-07T10:00:00.000Z', '2026-09-07T09:00:00.000Z', '2026-09-07T10:00:00.000Z');
    const reopened = await fetch(`${base}/api/classes/${classroom.id}/file-tasks/late-task/open`, { method: 'POST', headers: teacherHeaders(teacher), body: '{}' });
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({ state: 'open', reopenedAtUtc: '2026-09-07T12:00:00.000Z' });
    const view = await fetch(`${base}/api/classes/${classroom.id}/file-tasks/late-task`, { headers: { cookie: teacher.cookie } });
    expect(await view.json()).toMatchObject({ task: { state: 'open', deadlineAtUtc: '2026-09-07T10:00:00.000Z', reopenedAtUtc: '2026-09-07T12:00:00.000Z' } });
  });

  it('keyset-pages large teacher and student activity collections without unbounded responses', async () => {
    const base = await applicationBase();
    const teacher = await teacherLogin(base);
    const created = await fetch(`${base}/api/classes`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ name: 'Paging class' }) });
    const classroom = await created.json() as { id: string };
    const db = database as SqliteDatabase;
    const at = (index: number) => `2026-09-08T00:00:00.${String(index).padStart(3, '0')}Z`;
    const insertStudent = db.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)');
    const insertPending = db.prepare("INSERT INTO pending_student_requests (id,class_id,display_name,raw_student_number,normalized_student_number,requested_at_utc,status,resolved_at_utc) VALUES (?,?,?,?,?,?, 'pending',NULL)");
    const insertQuestion = db.prepare("INSERT INTO questions (id,class_id,template_id,kind,prompt,reference_answer,state,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES (?,?,NULL,'short_text',?,NULL,'open',?,NULL,?,?)");
    const insertTask = db.prepare("INSERT INTO file_submission_tasks (id,class_id,title,description,state,max_bytes,deadline_at_utc,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES (?,?,?,'','open',100000000,?,?,NULL,?,?)");
    for (let index = 0; index < 105; index += 1) {
      const value = String(index).padStart(3, '0');
      insertStudent.run(`student-${value}`, classroom.id, `Student ${value}`, `S${value}`, `S${value}`, 0, at(index));
      insertPending.run(`pending-${value}`, classroom.id, `Pending ${value}`, `P${value}`, `P${value}`, at(index));
      insertQuestion.run(`question-${value}`, classroom.id, `Question ${value}`, at(index), at(index), at(index));
      insertTask.run(`task-${value}`, classroom.id, `Task ${value}`, `2099-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`, at(index), at(index), at(index));
      db.prepare('INSERT INTO classes (id,name,created_at_utc,updated_at_utc) VALUES (?,?,?,?)').run(`extra-class-${value}`, `Extra ${value}`, at(index), at(index));
    }

    type Page = Readonly<{ items: readonly Readonly<{ id: string }>[]; nextCursor?: string }>;
    const allTeacher = async (path: string): Promise<readonly string[]> => {
      let cursor: string | undefined; const ids: string[] = [];
      do {
        const response = await fetch(`${base}${path}?limit=13${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, { headers: { cookie: teacher.cookie } });
        expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
        const page = await response.json() as Page; expect(page.items.length).toBeLessThanOrEqual(13); ids.push(...page.items.map((item) => item.id)); cursor = page.nextCursor;
      } while (cursor !== undefined);
      return ids;
    };
    for (const path of ['/api/teacher/classes', `/api/teacher/classes/${classroom.id}/roster`, `/api/teacher/classes/${classroom.id}/pending-student-requests`, `/api/teacher/classes/${classroom.id}/questions`, `/api/teacher/classes/${classroom.id}/file-tasks`]) {
      const ids = await allTeacher(path); expect(ids).toHaveLength(path === '/api/teacher/classes' ? 106 : 105); expect(new Set(ids)).toHaveLength(ids.length);
    }
    const invalid = await fetch(`${base}/api/teacher/classes/${classroom.id}/roster?cursor=not-a-cursor`, { headers: { cookie: teacher.cookie } });
    expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: 'INVALID_REQUEST' });

    const joined = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, displayName: 'Student 000', studentNumber: '100000' }) });
    const studentCookie = joined.headers.get('set-cookie')?.split(';')[0] as string;
    let questionCursor: string | undefined; let fileTaskCursor: string | undefined; const questionIds: string[] = []; const taskIds: string[] = [];
    do {
      const response = await fetch(`${base}/api/student/activities?limit=13${questionCursor === undefined ? '' : `&questionCursor=${encodeURIComponent(questionCursor)}`}${fileTaskCursor === undefined ? '' : `&fileTaskCursor=${encodeURIComponent(fileTaskCursor)}`}`, { headers: { cookie: studentCookie } });
      expect(response.status).toBe(200);
      const body = await response.json() as Readonly<{ questions: Page; fileTasks: Page }>;
      expect(body.questions.items.length).toBeLessThanOrEqual(13); expect(body.fileTasks.items.length).toBeLessThanOrEqual(13);
      questionIds.push(...body.questions.items.map((item) => item.id)); taskIds.push(...body.fileTasks.items.map((item) => item.id)); questionCursor = body.questions.nextCursor; fileTaskCursor = body.fileTasks.nextCursor;
    } while (questionCursor !== undefined || fileTaskCursor !== undefined);
    expect(new Set(questionIds)).toHaveLength(105); expect(new Set(taskIds)).toHaveLength(105);
  });

  it('keeps the application not-ready for a persistent staging cleanup failure and retries it after restart', async () => {
    const db = databaseWithTeacherHash();
    db.prepare("INSERT INTO classes (id,name,created_at_utc,updated_at_utc) VALUES ('class-1','1A','now','now')").run();
    db.prepare("INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES ('student-1','class-1','Ada','A1','A1',0,'now')").run();
    db.prepare("INSERT INTO file_submission_tasks (id,class_id,title,description,state,max_bytes,deadline_at_utc,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES ('task-1','class-1','Upload','', 'open',100000000,'2099-01-01T00:00:00.000Z','now',NULL,'now','now')").run();
    const storage = new UploadStorage(join(directory as string, 'uploads'));
    const repository = new SqliteUploadPipelineRepository(db);
    const session = randomUUID() as never;
    const stagingKey = storage.stagingKey(session);
    repository.begin({ uploadSessionId: session, taskId: 'task-1' as never, studentId: 'student-1' as never, stagingKey, originalFilename: 'partial.txt', displayFilename: 'partial.txt', declaredMimeType: null });
    const handle = await storage.openExclusiveStaging(stagingKey); await handle.write(Buffer.from('partial')); await handle.close();
    const physicalRemove = storage.removeStaging.bind(storage);
    const remove = vi.spyOn(storage, 'removeStaging').mockRejectedValue(new Error('simulated permission failure'));
    const app = createApplication({ database: db, allowedOrigin: origin, csrfSecret: 'a'.repeat(32), passwordVerifier: async () => true, uploadStorage: storage });

    await expect(app.reconcileUploads()).rejects.toThrow('UPLOAD_STORAGE_INTEGRITY_FAILED');
    expect(new SqliteFileSubmissionTaskRepository(db).deleteEmptyTask('task-1' as never)).toBe(false);
    expect(db.prepare('SELECT state,staging_key FROM upload_sessions WHERE id=?').get(session)).toEqual({ state: 'failed', staging_key: stagingKey });

    remove.mockImplementation(physicalRemove);
    const restarted = createApplication({ database: db, allowedOrigin: origin, csrfSecret: 'a'.repeat(32), passwordVerifier: async () => true, uploadStorage: storage });
    await expect(restarted.reconcileUploads()).resolves.toMatchObject({ cleanupFailed: 0, cleaned: 1 });
    expect(db.prepare('SELECT state,staging_key FROM upload_sessions WHERE id=?').get(session)).toEqual({ state: 'failed', staging_key: null });
    expect(db.prepare('SELECT cleanup_code FROM upload_staging_cleanup_records WHERE upload_session_id=?').get(session)).toEqual({ cleanup_code: 'RESTART_STAGING_CLEANED' });
  });

  it('streams a CSRF-protected student upload and exposes it only to a teacher download', async () => {
    const base = await applicationBase();
    const teacher = await teacherLogin(base);
    const created = await fetch(`${base}/api/classes`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ name: '1A' }) });
    const classroom = await created.json() as { id: string };
    await fetch(`${base}/api/classes/${classroom.id}/roster/import`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ csv: 'name,studentNumber\nAda,1001' }) });
    const join = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId: classroom.id, displayName: 'Ada', studentNumber: '1001' }) });
    const studentCookie = join.headers.get('set-cookie')?.split(';')[0];
    const studentCsrf = (await join.json() as { csrfToken: string }).csrfToken;
    if (studentCookie === undefined) throw new Error('test setup missing student cookie');
    const drafted = await fetch(`${base}/api/classes/${classroom.id}/file-tasks`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ title: 'Upload', description: '', deadlineAtUtc: '2099-01-01T00:00:00.000Z' }) });
    const task = await drafted.json() as { id: string };
    expect((await fetch(`${base}/api/classes/${classroom.id}/file-tasks/${task.id}/open`, { method: 'POST', headers: teacherHeaders(teacher), body: '{}' })).status).toBe(200);
    const studentHeaders = { origin, cookie: studentCookie, 'x-csrf-token': studentCsrf, 'content-type': 'application/octet-stream', 'x-upload-filename': '../answer.txt' };
    const uploaded = await fetch(`${base}/api/classes/${classroom.id}/file-tasks/${task.id}/upload`, { method: 'POST', headers: studentHeaders, body: 'answer' });
    expect(uploaded.status).toBe(201);
    expect(database?.prepare('SELECT original_filename,storage_key FROM file_submissions').get()).toMatchObject({ original_filename: 'answer.txt' });
    const denied = await fetch(`${base}/api/classes/${classroom.id}/file-tasks/${task.id}/upload`, { method: 'POST', headers: { ...studentHeaders, 'x-csrf-token': 'wrong' }, body: 'different' });
    expect(denied.status).toBe(403);
    const stored = database?.prepare('SELECT student_id FROM file_submissions').get() as { student_id: string };
    const openDownload = await fetch(`${base}/api/classes/${classroom.id}/file-tasks/${task.id}/submissions/${stored.student_id}/download`, { headers: { cookie: teacher.cookie } });
    expect(openDownload.status).toBe(404);
    expect(await openDownload.json()).toEqual({ error: 'FILE_TASK_NOT_FOUND' });
    const openArchive = await fetch(`${base}/api/classes/${classroom.id}/file-tasks/${task.id}/submissions.zip`, { headers: { cookie: teacher.cookie } });
    expect(openArchive.status).toBe(404);
    expect((await fetch(`${base}/api/classes/${classroom.id}/file-tasks/${task.id}/close`, { method: 'POST', headers: teacherHeaders(teacher), body: '{}' })).status).toBe(200);
    const download = await fetch(`${base}/api/classes/${classroom.id}/file-tasks/${task.id}/submissions/${stored.student_id}/download`, { headers: { cookie: teacher.cookie } });
    expect(download.status).toBe(200);
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('content-disposition')).toContain('answer.txt');
    expect(await download.text()).toBe('answer');
    const archive = await fetch(`${base}/api/classes/${classroom.id}/file-tasks/${task.id}/submissions.zip`, { headers: { cookie: teacher.cookie } });
    expect(archive.status).toBe(200);
    expect(archive.headers.get('content-type')).toContain('application/zip');
    expect(archive.headers.get('cache-control')).toBe('no-store');
    expect(archive.headers.get('content-disposition')).toContain('filename*=UTF-8');
    expect(Buffer.from(await archive.arrayBuffer()).toString('utf8')).toContain('1001_Ada_answer.txt');
  });

  it('streams a verified, flat fifty-file ZIP only for its closed class', async () => {
    const base = await applicationBase();
    const teacher = await teacherLogin(base);
    const db = database as SqliteDatabase;
    const at = '2026-09-09T00:00:00.000Z';
    db.prepare('INSERT INTO classes (id,name,created_at_utc,updated_at_utc) VALUES (?,?,?,?)').run('archive-class', 'Archive class', at, at);
    db.prepare('INSERT INTO classes (id,name,created_at_utc,updated_at_utc) VALUES (?,?,?,?)').run('other-class', 'Other class', at, at);
    db.prepare("INSERT INTO file_submission_tasks (id,class_id,title,description,state,max_bytes,deadline_at_utc,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES (?,?,?,'','closed',100000000,?,?,?,?,?)")
      .run('archive-task', 'archive-class', 'Archive', '2099-01-01T00:00:00.000Z', at, at, at, at);
    const student = db.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)');
    const submission = db.prepare('INSERT INTO file_submissions (id,task_id,student_id,original_filename,display_filename,storage_key,declared_mime_type,byte_length,sha256,received_complete_at_utc,deleted_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)');
    let missingKey = '';
    for (let index = 0; index < 50; index += 1) {
      const studentId = `archive-student-${index}`; const key = randomUUID(); const content = Buffer.from(`verified-${index}`);
      student.run(studentId, 'archive-class', `Name${index === 0 ? '/evil' : index === 1 ? '\\evil' : index}`, `S${String(index).padStart(2, '0')}`, `S${String(index).padStart(2, '0')}`, 0, at);
      // The first two normalize to colliding flat names; neither path syntax can
      // survive the server-generated archive entry boundary.
      const filename = index === 0 ? '../report.txt' : index === 1 ? '..\\report.txt' : 'answer.txt';
      submission.run(randomUUID(), 'archive-task', studentId, filename, 'answer.txt', key, null, content.length, createHash('sha256').update(content).digest('hex'), at);
      writeFileSync(join(directory as string, 'uploads', 'files', key), content);
      if (index === 49) missingKey = key;
    }
    expect((await fetch(`${base}/api/classes/archive-class/file-tasks/archive-task/submissions.zip`)).status).toBe(401);
    expect((await fetch(`${base}/api/classes/other-class/file-tasks/archive-task/submissions.zip`, { headers: { cookie: teacher.cookie } })).status).toBe(404);
    const archive = await fetch(`${base}/api/classes/archive-class/file-tasks/archive-task/submissions.zip`, { headers: { cookie: teacher.cookie } });
    expect(archive.status).toBe(200);
    expect(archive.headers.get('cache-control')).toBe('no-store');
    expect(archive.headers.get('x-content-type-options')).toBe('nosniff');
    const names = zipEntryNames(Buffer.from(await archive.arrayBuffer()));
    expect(names).toHaveLength(50);
    expect(new Set(names.map((name) => name.toLocaleLowerCase('en-US'))).size).toBe(50);
    expect(names.every((name) => !/[\\/:]/.test(name) && !name.includes('..'))).toBe(true);
    rmSync(join(directory as string, 'uploads', 'files', missingKey));
    const missing = await fetch(`${base}/api/classes/archive-class/file-tasks/archive-task/submissions.zip`, { headers: { cookie: teacher.cookie } });
    expect(missing.status).toBe(400);
    expect(missing.headers.get('content-type')).toContain('application/json');
  });
});

function rawRejectedBody(port: number, path: string, contentLength: number, writeOneByte: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let received = '';
    const timeout = globalThis.setTimeout(() => {
      socket.destroy(); reject(new Error('unauthorized body stream did not close promptly'));
    }, 2_000);
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => { received += chunk; });
    socket.once('end', () => { globalThis.clearTimeout(timeout); resolve(received); });
    socket.once('connect', () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${contentLength}\r\n\r\n${writeOneByte ? 'x' : ''}`);
    });
  });
}

/** Read central-directory names instead of trusting the byte stream as text. */
function zipEntryNames(archive: Buffer): readonly string[] {
  let offset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const names: string[] = [];
  while (offset >= 0 && archive.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = archive.readUInt16LE(offset + 28); const extraLength = archive.readUInt16LE(offset + 30); const commentLength = archive.readUInt16LE(offset + 32);
    names.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}
