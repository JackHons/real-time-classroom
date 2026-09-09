import { Buffer } from 'node:buffer';
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

describe('CSV exports v1', () => {
  it('exports only close snapshots with Excel-safe RFC4180 UTF-8 data', async () => {
    const base = await applicationBase();
    const teacher = await teacherLogin(base);
    const classId = await createClass(base, teacher, '1A');
    const imported = await fetch(`${base}/api/classes/${classId}/roster/import`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ csv: 'name,studentNumber\n"=SUM(1,1)","\t@A1"' }) });
    expect(imported.status).toBe(200);
    const joined = await studentLogin(base, classId, '=SUM(1,1)', '\t@A1');
    const questionId = await createShortTextQuestion(base, teacher, classId);
    expect((await fetch(`${base}/api/questions/${questionId}/open`, { method: 'POST', headers: teacherHeaders(teacher), body: '{}' })).status).toBe(204);
    const answer = '臺灣,"quoted"\nnext\u0000';
    expect((await fetch(`${base}/api/questions/${questionId}/answers`, { method: 'POST', headers: studentHeaders(joined), body: JSON.stringify({ revision: 0, idempotencyKey: 'answer-0', payload: { kind: 'short_text', text: answer } }) })).status).toBe(200);
    expect((await fetch(`${base}/api/questions/${questionId}/close`, { method: 'POST', headers: teacherHeaders(teacher), body: '{}' })).status).toBe(200);
    // A late mutable answer must not replace the immutable answer_at_close row.
    expect((await fetch(`${base}/api/questions/${questionId}/answers`, { method: 'PUT', headers: studentHeaders(joined), body: JSON.stringify({ revision: 1, idempotencyKey: 'answer-1', payload: { kind: 'short_text', text: 'late replacement' } }) })).status).toBe(200);

    const response = await fetch(`${base}/api/questions/${questionId}/answers/export.csv`, { headers: { cookie: teacher.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toContain('question-answers.csv');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const csv = bytes.subarray(3).toString('utf8');
    expect(csv).toContain('studentNumber,displayName,status,answer,closedAtUtc\r\n');
    // Roster normalization trims the tab before storage; the persisted @ value
    // remains formula-safe in the actual download.
    expect(csv).toContain("'@A1");
    expect(csv).toContain("\"'=SUM(1,1)\"");
    expect(csv).toContain('"臺灣,""quoted""\nnext�"');
    expect(csv).not.toContain('late replacement');
    expect(csv).toContain(',answered,');
  });

  it('requires a teacher, refuses open question exports, and exports a private roster without IDs', async () => {
    const base = await applicationBase();
    const teacher = await teacherLogin(base);
    const classId = await createClass(base, teacher, 'Roster');
    await fetch(`${base}/api/classes/${classId}/roster/import`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ csv: 'name,studentNumber\nAda,A1' }) });
    const questionId = await createShortTextQuestion(base, teacher, classId);
    expect((await fetch(`${base}/api/questions/${questionId}/answers/export.csv`)).status).toBe(401);
    const open = await fetch(`${base}/api/questions/${questionId}/answers/export.csv`, { headers: { cookie: teacher.cookie } });
    expect(open.status).toBe(409);
    expect(await open.json()).toEqual({ error: 'QUESTION_EXPORT_CLOSED_REQUIRED' });
    const roster = await fetch(`${base}/api/classes/${classId}/roster/export.csv`, { headers: { cookie: teacher.cookie } });
    expect(roster.status).toBe(200);
    const csv = Buffer.from(await roster.arrayBuffer()).subarray(3).toString('utf8');
    expect(csv).toBe('studentNumber,displayName,isTemporary,approvedAtUtc\r\nA1,Ada,false,2026-09-09T00:00:00.000Z\r\n');
    expect(csv).not.toContain('student-');
    expect(csv).not.toContain('normalized');
  });

  it('renders selected option labels in the question snapshot ordinal order', async () => {
    const base = await applicationBase();
    const teacher = await teacherLogin(base);
    const classId = await createClass(base, teacher, 'Choices');
    await fetch(`${base}/api/classes/${classId}/roster/import`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ csv: 'name,studentNumber\nAda,A1' }) });
    const student = await studentLogin(base, classId, 'Ada', 'A1');
    const drafted = await fetch(`${base}/api/classes/${classId}/question-drafts`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ question: { kind: 'multiple_choice', prompt: 'Pick', options: [{ label: 'Second' }, { label: 'First' }] } }) });
    const question = await drafted.json() as { id: string; options: readonly { id: string }[] };
    const first = question.options[0]; const second = question.options[1];
    if (first === undefined || second === undefined) throw new Error('missing draft options');
    expect((await fetch(`${base}/api/questions/${question.id}/open`, { method: 'POST', headers: teacherHeaders(teacher), body: '{}' })).status).toBe(204);
    expect((await fetch(`${base}/api/questions/${question.id}/answers`, { method: 'POST', headers: studentHeaders(student), body: JSON.stringify({ revision: 0, idempotencyKey: 'choices-0', payload: { kind: 'multiple_choice', selectedOptions: [second.id, first.id] } }) })).status).toBe(200);
    expect((await fetch(`${base}/api/questions/${question.id}/close`, { method: 'POST', headers: teacherHeaders(teacher), body: '{}' })).status).toBe(200);
    const csv = Buffer.from(await (await fetch(`${base}/api/questions/${question.id}/answers/export.csv`, { headers: { cookie: teacher.cookie } })).arrayBuffer()).subarray(3).toString('utf8');
    expect(csv).toContain('A1,Ada,answered,Second; First,');
  });

  it('keyset streams large snapshots and retains only an immutable deleted status row', async () => {
    const base = await applicationBase();
    const teacher = await teacherLogin(base);
    const classId = await createClass(base, teacher, 'Large');
    const db = database as SqliteDatabase;
    const students = db.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)');
    for (let index = 0; index < 501; index += 1) students.run(`student-${String(index).padStart(4, '0')}`, classId, `Student ${index}`, `S${index}`, `S${index}`, 0, '2026-09-09T00:00:00.000Z');
    const questionId = await createShortTextQuestion(base, teacher, classId);
    expect((await fetch(`${base}/api/questions/${questionId}/open`, { method: 'POST', headers: teacherHeaders(teacher), body: '{}' })).status).toBe(204);
    expect((await fetch(`${base}/api/questions/${questionId}/close`, { method: 'POST', headers: teacherHeaders(teacher), body: '{}' })).status).toBe(200);
    const firstStudent = 'student-0000';
    expect((await fetch(`${base}/api/questions/${questionId}/answers/${firstStudent}`, { method: 'DELETE', headers: teacherHeaders(teacher), body: JSON.stringify({ confirmed: true, impactAcknowledged: true }) })).status).toBe(204);
    // Simulate an old migration row and a later roster rename. Export remains
    // fail-private rather than joining mutable student data.
    db.prepare('UPDATE answer_at_close SET display_name=NULL,student_number=NULL WHERE question_id=? AND student_id=?').run(questionId, 'student-0001');
    db.prepare('UPDATE students SET display_name=? WHERE id=?').run('Renamed today', 'student-0001');
    const response = await fetch(`${base}/api/questions/${questionId}/answers/export.csv`, { headers: { cookie: teacher.cookie } });
    const csv = Buffer.from(await response.arrayBuffer()).subarray(3).toString('utf8');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(502);
    expect(csv).toContain('S0,Student 0,deleted,,');
    expect(csv).toContain('Unknown,Unknown student,noAnswer,,');
    expect(csv).not.toContain('Renamed today');
  });
});

async function applicationBase(): Promise<string> {
  directory = mkdtempSync(join(tmpdir(), 'lan-classroom-export-'));
  database = openSqlite(join(directory, 'classroom.sqlite')); migrate(database);
  database.prepare("INSERT INTO app_settings (key,value,created_at_utc,updated_at_utc) VALUES ('teacher_shared_password_hash',?,?,?)").run('$argon2id$test', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
  const app = createApplication({ database, allowedOrigin: origin, csrfSecret: 'a'.repeat(32), passwordVerifier: async (password) => password === 'correct', uploadStorageRoot: join(directory, 'uploads'), clock: { now: () => new Date('2026-09-09T00:00:00.000Z') } });
  await app.reconcileUploads();
  server = await startServer({ host: '127.0.0.1', port: 0, apiHandler: app.apiHandler });
  return `http://${server.host}:${server.port}`;
}

async function teacherLogin(base: string): Promise<Readonly<{ cookie: string; csrf: string }>> {
  const response = await fetch(`${base}/api/auth/teacher/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct' }) });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined) throw new Error('missing teacher cookie');
  return { cookie, csrf: (await response.json() as { csrfToken: string }).csrfToken };
}

async function studentLogin(base: string, classId: string, displayName: string, studentNumber: string): Promise<Readonly<{ cookie: string; csrf: string }>> {
  const response = await fetch(`${base}/api/auth/student/join`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ classId, displayName, studentNumber }) });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined) throw new Error('missing student cookie');
  return { cookie, csrf: (await response.json() as { csrfToken: string }).csrfToken };
}

async function createClass(base: string, teacher: Readonly<{ cookie: string; csrf: string }>, name: string): Promise<string> {
  const response = await fetch(`${base}/api/classes`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ name }) });
  return (await response.json() as { id: string }).id;
}

async function createShortTextQuestion(base: string, teacher: Readonly<{ cookie: string; csrf: string }>, classId: string): Promise<string> {
  const response = await fetch(`${base}/api/classes/${classId}/question-drafts`, { method: 'POST', headers: teacherHeaders(teacher), body: JSON.stringify({ question: { kind: 'short_text', prompt: 'Explain' } }) });
  return (await response.json() as { id: string }).id;
}

function teacherHeaders(login: Readonly<{ cookie: string; csrf: string }>): Record<string, string> { return { origin, cookie: login.cookie, 'x-csrf-token': login.csrf, 'content-type': 'application/json' }; }
function studentHeaders(login: Readonly<{ cookie: string; csrf: string }>): Record<string, string> { return { origin, cookie: login.cookie, 'x-csrf-token': login.csrf, 'content-type': 'application/json' }; }
