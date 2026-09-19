import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../../apps/server/src/application.js';
import { openSqlite, type SqliteDatabase } from '../../../apps/server/src/db/connection.js';
import { migrate } from '../../../apps/server/src/db/migrator.js';
import { startServer, type RunningServer } from '../../../apps/server/src/server.js';

const origin = 'http://classroom.test';
let database: SqliteDatabase | undefined;
let directory: string | undefined;
let server: RunningServer | undefined;

afterEach(async () => {
  await server?.close(); server = undefined;
  database?.close(); database = undefined;
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

async function applicationBase(): Promise<string> {
  directory = mkdtempSync(join(tmpdir(), 'lan-classroom-task4-'));
  database = openSqlite(join(directory, 'classroom.sqlite'));
  migrate(database);
  database.prepare("INSERT INTO app_settings (key,value,created_at_utc,updated_at_utc) VALUES ('teacher_shared_password_hash',?,?,?)")
    .run('$argon2id$test', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z');
  const application = createApplication({ database, allowedOrigin: origin, csrfSecret: 'a'.repeat(32), passwordVerifier: async (password) => password === 'correct' });
  server = await startServer({ host: '127.0.0.1', port: 0, apiHandler: application.apiHandler });
  return `http://${server.host}:${server.port}`;
}

type Login = Readonly<{ cookie: string; csrf: string }>;

async function login(base: string, path: string, body: unknown): Promise<Login> {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined) throw new Error('test setup missing session cookie');
  return { cookie, csrf: (await response.json() as { csrfToken: string }).csrfToken };
}

function headers(session: Login): Record<string, string> {
  return { origin, cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
}

async function createClass(base: string, teacher: Login, name: string, csv: string): Promise<string> {
  const created = await fetch(`${base}/api/classes`, { method: 'POST', headers: headers(teacher), body: JSON.stringify({ name }) });
  expect(created.status).toBe(201);
  const classroom = await created.json() as { id: string };
  const imported = await fetch(`${base}/api/classes/${classroom.id}/roster/import`, { method: 'POST', headers: headers(teacher), body: JSON.stringify({ csv }) });
  expect(imported.status).toBe(200);
  return classroom.id;
}

describe('Task 4 composed question API', () => {
  it('preserves authenticated class-scoped question and answer lifecycle boundaries', async () => {
    const base = await applicationBase();
    const teacher = await login(base, '/api/auth/teacher/login', { password: 'correct' });
    const classA = await createClass(base, teacher, '1A', 'name,studentNumber\nAda,1001\nBob,1002');
    const classB = await createClass(base, teacher, '1B', 'name,studentNumber\nBea,2001');
    const ada = await login(base, '/api/auth/student/join', { classId: classA, displayName: 'Ada', studentNumber: '1001' });
    await login(base, '/api/auth/student/join', { classId: classA, displayName: 'Bob', studentNumber: '1002' });
    const bea = await login(base, '/api/auth/student/join', { classId: classB, displayName: 'Bea', studentNumber: '2001' });

    const csrfRejected = await fetch(`${base}/api/question-templates`, { method: 'POST', headers: { origin, cookie: teacher.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'single_choice', prompt: 'Q?', options: [{ label: 'Yes' }, { label: 'No' }] }) });
    expect(csrfRejected.status).toBe(403);
    const templateResponse = await fetch(`${base}/api/question-templates`, { method: 'POST', headers: headers(teacher), body: JSON.stringify({ kind: 'single_choice', prompt: 'Ready?', options: [{ label: 'Yes' }, { label: 'No' }] }) });
    expect(templateResponse.status).toBe(201);
    const template = await templateResponse.json() as { id: string; options: Array<{ id: string }> };

    const drafted = await fetch(`${base}/api/classes/${classA}/question-drafts`, { method: 'POST', headers: headers(teacher), body: JSON.stringify({ templateId: template.id }) });
    expect(drafted.status).toBe(201);
    const question = await drafted.json() as { id: string };
    const draftRead = await fetch(`${base}/api/questions/${question.id}?as=student`, { headers: { cookie: ada.cookie } });
    const missingRead = await fetch(`${base}/api/questions/not-a-question?as=student`, { headers: { cookie: ada.cookie } });
    expect(draftRead.status).toBe(404);
    expect(await draftRead.json()).toEqual(await missingRead.json());
    const oversizedOpen = await fetch(`${base}/api/questions/${question.id}/open`, { method: 'POST', headers: headers(teacher), body: JSON.stringify({ padding: 'x'.repeat(100 * 1024) }) });
    expect(oversizedOpen.status).toBe(413);
    expect(oversizedOpen.headers.get('cache-control')).toBe('no-store');
    const opened = await fetch(`${base}/api/questions/${question.id}/open`, { method: 'POST', headers: headers(teacher) });
    expect(opened.status).toBe(204);
    expect(opened.headers.get('cache-control')).toBe('no-store');

    const crossClass = await fetch(`${base}/api/questions/${question.id}/answers`, { method: 'POST', headers: headers(bea), body: JSON.stringify({ revision: 0, idempotencyKey: 'bea-0', payload: { kind: 'single_choice', selectedOptions: [template.options[0]?.id] } }) });
    const missingAnswer = await fetch(`${base}/api/questions/not-a-question/answers`, { method: 'POST', headers: headers(bea), body: JSON.stringify({ revision: 0, idempotencyKey: 'missing-0', payload: { kind: 'single_choice', selectedOptions: [template.options[0]?.id] } }) });
    expect(crossClass.status).toBe(404);
    expect(await crossClass.json()).toEqual(await missingAnswer.json());
    expect(crossClass.headers.get('cache-control')).toBe('no-store');
    const studentCsrfRejected = await fetch(`${base}/api/questions/${question.id}/answers`, { method: 'POST', headers: { origin, cookie: ada.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ revision: 0, idempotencyKey: 'ada-0', payload: { kind: 'single_choice', selectedOptions: [template.options[0]?.id] } }) });
    expect(studentCsrfRejected.status).toBe(403);

    const input = { revision: 0, idempotencyKey: 'ada-0', payload: { kind: 'single_choice', selectedOptions: [template.options[0]?.id] } };
    const answered = await fetch(`${base}/api/questions/${question.id}/answers`, { method: 'POST', headers: headers(ada), body: JSON.stringify(input) });
    expect(answered.status).toBe(200);
    const firstAnswer = await answered.json() as { id: string; revision: number; late: boolean };
    expect(firstAnswer).toMatchObject({ revision: 0, late: false });
    const replay = await fetch(`${base}/api/questions/${question.id}/answers`, { method: 'POST', headers: headers(ada), body: JSON.stringify(input) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: firstAnswer.id, revision: 0, late: false });
    const revision = await fetch(`${base}/api/questions/${question.id}/answers`, { method: 'PUT', headers: headers(ada), body: JSON.stringify({ revision: 1, idempotencyKey: 'ada-1', payload: { kind: 'single_choice', selectedOptions: [template.options[1]?.id] } }) });
    expect(revision.status).toBe(200);

    const openTeacherView = await fetch(`${base}/api/questions/${question.id}`, { headers: { cookie: teacher.cookie } });
    expect(openTeacherView.status).toBe(200);
    const openView = await openTeacherView.json() as { aggregate: { answeredStudentCount: number }; answers?: unknown };
    expect(openView.aggregate.answeredStudentCount).toBe(1);
    expect(openView.answers).toBeUndefined();

    const closed = await fetch(`${base}/api/questions/${question.id}/close`, { method: 'POST', headers: headers(teacher) });
    expect(closed.status).toBe(200);
    expect(closed.headers.get('cache-control')).toBe('no-store');
    expect(await closed.json()).toMatchObject({ counts: { [template.options[1]?.id ?? 'missing']: 1 } });
    const late = await fetch(`${base}/api/questions/${question.id}/answers`, { method: 'PUT', headers: headers(ada), body: JSON.stringify({ revision: 2, idempotencyKey: 'ada-2', payload: { kind: 'single_choice', selectedOptions: [template.options[0]?.id] } }) });
    expect(late.status).toBe(200);
    expect(await late.json()).toMatchObject({ revision: 2, late: true });

    const closedTeacherView = await fetch(`${base}/api/questions/${question.id}`, { headers: { cookie: teacher.cookie } });
    const closedView = await closedTeacherView.json() as {
      snapshot: { counts: Record<string, number> };
      summary: { eligibleStudentCount: number; answeredStudentCount: number; unansweredStudentCount: number };
      answers: Array<{ studentId: string; answer?: { noAnswer: boolean; payload: unknown } }>;
    };
    expect(closedView.snapshot.counts).toEqual({ [template.options[1]?.id ?? 'missing']: 1 });
    expect(closedView.summary).toEqual({ eligibleStudentCount: 2, answeredStudentCount: 1, unansweredStudentCount: 1 });
    expect(closedView.answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId: expect.any(String), answer: expect.objectContaining({ noAnswer: false, payload: expect.objectContaining({ selectedOptions: [template.options[1]?.id] }) }) }),
      expect.objectContaining({ studentId: expect.any(String), answer: expect.objectContaining({ noAnswer: true, payload: null }) })
    ]));
    database?.prepare("UPDATE questions SET reference_answer='teacher-secret' WHERE id=?").run(question.id);
    const studentRead = await fetch(`${base}/api/questions/${question.id}?as=student`, { headers: { cookie: ada.cookie } });
    expect(studentRead.status).toBe(200);
    const studentView = await studentRead.json() as { question: Record<string, unknown>; answer: { revision: number; late: boolean }; answerAtClose: { revision: number } };
    expect(studentView).toMatchObject({ answer: { revision: 2, late: true }, answerAtClose: { revision: 1 } });
    expect(studentView.question).not.toHaveProperty('referenceAnswer');
    expect(JSON.stringify(studentView)).not.toContain('teacher-secret');

    const deletion = { confirmed: true, impactAcknowledged: true };
    const deleted = await fetch(`${base}/api/questions/${question.id}/answers/${firstAnswer.id}`, { method: 'DELETE', headers: headers(teacher), body: JSON.stringify(deletion) });
    // An answer id is not a student id: use the actual student id from the durable row.
    expect(deleted.status).toBe(404);
    const studentId = database?.prepare('SELECT id FROM students WHERE class_id=?').get(classA) as { id: string };
    const deletedByStudent = await fetch(`${base}/api/questions/${question.id}/answers/${studentId.id}`, { method: 'DELETE', headers: headers(teacher), body: JSON.stringify(deletion) });
    expect(deletedByStudent.status).toBe(204);
    const deleteReplay = await fetch(`${base}/api/questions/${question.id}/answers/${studentId.id}`, { method: 'DELETE', headers: headers(teacher), body: JSON.stringify(deletion) });
    expect(deleteReplay.status).toBe(204);
    expect(database?.prepare('SELECT count(*) AS count FROM answer_current WHERE question_id=?').get(question.id)).toEqual({ count: 0 });
    // Deleting Ada's answer does not erase Bob's close-time no-answer audit row.
    expect(database?.prepare('SELECT count(*) AS count FROM answer_at_close WHERE question_id=?').get(question.id)).toEqual({ count: 1 });
    const afterDelete = await (await fetch(`${base}/api/questions/${question.id}`, { headers: { cookie: teacher.cookie } })).json() as {
      summary: { eligibleStudentCount: number; answeredStudentCount: number; unansweredStudentCount: number };
      answers: Array<{ studentId: string; answer?: unknown }>;
    };
    expect(afterDelete.summary).toEqual({ eligibleStudentCount: 2, answeredStudentCount: 0, unansweredStudentCount: 2 });
    expect(afterDelete.answers.some((answer) => !Object.hasOwn(answer, 'answer'))).toBe(true);
  });

  it('bounds named closed-answer pages for a large roster', async () => {
    const base = await applicationBase();
    const teacher = await login(base, '/api/auth/teacher/login', { password: 'correct' });
    const roster = ['name,studentNumber', ...Array.from({ length: 75 }, (_, index) => `Student ${index},S${index}`)].join('\n');
    const classId = await createClass(base, teacher, 'large roster', roster);
    const templateResponse = await fetch(`${base}/api/question-templates`, { method: 'POST', headers: headers(teacher), body: JSON.stringify({ kind: 'short_text', prompt: 'Respond' }) });
    expect(templateResponse.status).toBe(201);
    const template = await templateResponse.json() as { id: string };
    const drafted = await fetch(`${base}/api/classes/${classId}/question-drafts`, { method: 'POST', headers: headers(teacher), body: JSON.stringify({ templateId: template.id }) });
    const question = await drafted.json() as { id: string };
    expect((await fetch(`${base}/api/questions/${question.id}/open`, { method: 'POST', headers: headers(teacher) })).status).toBe(204);
    expect((await fetch(`${base}/api/questions/${question.id}/close`, { method: 'POST', headers: headers(teacher) })).status).toBe(200);

    const first = await fetch(`${base}/api/questions/${question.id}`, { headers: { cookie: teacher.cookie } });
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const firstPage = await first.json() as { answers: Array<{ studentId: string }>; nextCursor?: string };
    expect(firstPage.answers).toHaveLength(50);
    expect(firstPage.nextCursor).toBe('50');

    const second = await fetch(`${base}/api/questions/${question.id}?cursor=${firstPage.nextCursor}&limit=1000`, { headers: { cookie: teacher.cookie } });
    const secondPage = await second.json() as { answers: Array<{ studentId: string }>; nextCursor?: string };
    // Requesting a larger limit cannot bypass the route's maximum of 100.
    expect(secondPage.answers).toHaveLength(25);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(new Set([...firstPage.answers, ...secondPage.answers].map((answer) => answer.studentId))).toHaveLength(75);
  });
});
