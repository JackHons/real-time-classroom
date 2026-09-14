import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteDatabase } from '../db/connection.js';
import type { AuthorizedStudentContext } from '../domain/types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type TeacherContext = (request: IncomingMessage) => unknown;
type StudentContext = (request: IncomingMessage) => AuthorizedStudentContext;
type Cursor = readonly [string, ...string[]];
type Page<T> = Readonly<{ items: readonly T[]; nextCursor?: string }>;
type ClassRow = Readonly<{ id: string; name: string; createdAtUtc: string; updatedAtUtc: string }>;
type StudentRow = Readonly<{ id: string; displayName: string; studentNumber: string; isTemporary: number; approvedAtUtc: string }>;
type PendingRow = Readonly<{ id: string; classId: string; displayName: string; studentNumber: string; requestedAtUtc: string }>;
type QuestionRow = Readonly<{ id: string; classId: string; kind: string; prompt: string; state: string; templateId: string | null; createdAtUtc: string }>;
type FileTaskRow = Readonly<{ id: string; classId: string; title: string; description: string; state: string; deadlineAtUtc: string; maxBytes: number; reopenedAtUtc: string | null; createdAtUtc: string }>;
type StudentQuestionRow = Readonly<{ id: string; prompt: string; kind: string; state: string; openedAtUtc: string; stateOrder: number }>;
type StudentFileTaskRow = Readonly<{ id: string; title: string; description: string; state: string; deadlineAtUtc: string; stateOrder: number }>;

/**
 * Read-only navigation DTOs. Every collection uses a keyset cursor and a
 * LIMIT + 1 query: no endpoint turns an unbounded SQLite result into memory.
 * Cursors carry their route scope, so a token cannot be replayed for a
 * different class or resource. DTOs omit answer keys, reference answers,
 * session material and every other student's identity from student responses.
 */
export function createActivityRoutes(dependencies: Readonly<{ database: SqliteDatabase; teacherContext: TeacherContext; studentContext: StudentContext }>): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'GET') return false;

    const teacherClass = /^\/api\/teacher\/classes\/([^/]+)\/(roster|pending-student-requests|questions|file-tasks)$/.exec(url.pathname);
    if (teacherClass !== null) {
      dependencies.teacherContext(request);
      const classId = decodeURIComponent(teacherClass[1]!);
      if (!classExists(dependencies.database, classId)) throw new Error('CLASS_NOT_FOUND');
      const limit = readLimit(url);
      const resource = teacherClass[2]!;
      if (resource === 'roster') return send(response, students(dependencies.database, classId, limit, readCursor(url, `teacher:${classId}:roster`)));
      if (resource === 'pending-student-requests') return send(response, pending(dependencies.database, classId, limit, readCursor(url, `teacher:${classId}:pending`)));
      if (resource === 'questions') return send(response, questions(dependencies.database, classId, limit, readCursor(url, `teacher:${classId}:questions`)));
      return send(response, fileTasks(dependencies.database, classId, limit, readCursor(url, `teacher:${classId}:file-tasks`)));
    }
    if (url.pathname === '/api/teacher/classes') {
      dependencies.teacherContext(request);
      const limit = readLimit(url);
      return send(response, classes(dependencies.database, limit, readCursor(url, 'teacher:classes')));
    }
    if (url.pathname === '/api/student/activities') {
      const student = dependencies.studentContext(request);
      const limit = readLimit(url);
      return send(response, {
        questions: studentQuestions(dependencies.database, student.classId, limit, readCursor(url, `student:${student.classId}:questions`, 'questionCursor', 3)),
        fileTasks: studentFileTasks(dependencies.database, student.classId, limit, readCursor(url, `student:${student.classId}:file-tasks`, 'fileTaskCursor', 3))
      });
    }
    return false;
  };
}

function classExists(database: SqliteDatabase, classId: string): boolean { return database.prepare('SELECT 1 FROM classes WHERE id=?').get(classId) !== undefined; }

function classes(database: SqliteDatabase, limit: number, cursor: Cursor | undefined): Page<ClassRow> {
  const rows = cursor === undefined
    ? database.prepare('SELECT id,name,created_at_utc AS createdAtUtc,updated_at_utc AS updatedAtUtc FROM classes ORDER BY name,id LIMIT ?').all(limit + 1) as readonly ClassRow[]
    : database.prepare('SELECT id,name,created_at_utc AS createdAtUtc,updated_at_utc AS updatedAtUtc FROM classes WHERE name>? OR (name=? AND id>?) ORDER BY name,id LIMIT ?').all(cursor[0], cursor[0], cursor[1], limit + 1) as readonly ClassRow[];
  return page(rows, limit, 'teacher:classes', (row) => [row.name, row.id]);
}
function students(database: SqliteDatabase, classId: string, limit: number, cursor: Cursor | undefined): Page<StudentRow> {
  const rows = cursor === undefined
    ? database.prepare('SELECT id,display_name AS displayName,raw_student_number AS studentNumber,is_temporary AS isTemporary,approved_at_utc AS approvedAtUtc FROM students WHERE class_id=? ORDER BY display_name,id LIMIT ?').all(classId, limit + 1) as readonly StudentRow[]
    : database.prepare('SELECT id,display_name AS displayName,raw_student_number AS studentNumber,is_temporary AS isTemporary,approved_at_utc AS approvedAtUtc FROM students WHERE class_id=? AND (display_name>? OR (display_name=? AND id>?)) ORDER BY display_name,id LIMIT ?').all(classId, cursor[0], cursor[0], cursor[1], limit + 1) as readonly StudentRow[];
  return page(rows, limit, `teacher:${classId}:roster`, (row) => [row.displayName, row.id]);
}
function pending(database: SqliteDatabase, classId: string, limit: number, cursor: Cursor | undefined): Page<PendingRow> {
  const rows = cursor === undefined
    ? database.prepare("SELECT id,class_id AS classId,display_name AS displayName,raw_student_number AS studentNumber,requested_at_utc AS requestedAtUtc FROM pending_student_requests WHERE class_id=? AND status='pending' ORDER BY requested_at_utc,id LIMIT ?").all(classId, limit + 1) as readonly PendingRow[]
    : database.prepare("SELECT id,class_id AS classId,display_name AS displayName,raw_student_number AS studentNumber,requested_at_utc AS requestedAtUtc FROM pending_student_requests WHERE class_id=? AND status='pending' AND (requested_at_utc>? OR (requested_at_utc=? AND id>?)) ORDER BY requested_at_utc,id LIMIT ?").all(classId, cursor[0], cursor[0], cursor[1], limit + 1) as readonly PendingRow[];
  return page(rows, limit, `teacher:${classId}:pending`, (row) => [row.requestedAtUtc, row.id]);
}
function questions(database: SqliteDatabase, classId: string, limit: number, cursor: Cursor | undefined): Page<QuestionRow> {
  const rows = cursor === undefined
    ? database.prepare('SELECT id,class_id AS classId,kind,prompt,state,template_id AS templateId,created_at_utc AS createdAtUtc FROM questions WHERE class_id=? ORDER BY created_at_utc DESC,id DESC LIMIT ?').all(classId, limit + 1) as readonly QuestionRow[]
    : database.prepare('SELECT id,class_id AS classId,kind,prompt,state,template_id AS templateId,created_at_utc AS createdAtUtc FROM questions WHERE class_id=? AND (created_at_utc<? OR (created_at_utc=? AND id<?)) ORDER BY created_at_utc DESC,id DESC LIMIT ?').all(classId, cursor[0], cursor[0], cursor[1], limit + 1) as readonly QuestionRow[];
  return page(rows, limit, `teacher:${classId}:questions`, (row) => [row.createdAtUtc, row.id]);
}
function fileTasks(database: SqliteDatabase, classId: string, limit: number, cursor: Cursor | undefined): Page<FileTaskRow> {
  const rows = cursor === undefined
    ? database.prepare('SELECT id,class_id AS classId,title,description,state,deadline_at_utc AS deadlineAtUtc,max_bytes AS maxBytes,reopened_at_utc AS reopenedAtUtc,created_at_utc AS createdAtUtc FROM file_submission_tasks WHERE class_id=? ORDER BY created_at_utc DESC,id DESC LIMIT ?').all(classId, limit + 1) as readonly FileTaskRow[]
    : database.prepare('SELECT id,class_id AS classId,title,description,state,deadline_at_utc AS deadlineAtUtc,max_bytes AS maxBytes,reopened_at_utc AS reopenedAtUtc,created_at_utc AS createdAtUtc FROM file_submission_tasks WHERE class_id=? AND (created_at_utc<? OR (created_at_utc=? AND id<?)) ORDER BY created_at_utc DESC,id DESC LIMIT ?').all(classId, cursor[0], cursor[0], cursor[1], limit + 1) as readonly FileTaskRow[];
  return page(rows, limit, `teacher:${classId}:file-tasks`, (row) => [row.createdAtUtc, row.id]);
}
function studentQuestions(database: SqliteDatabase, classId: string, limit: number, cursor: Cursor | undefined): Page<StudentQuestionRow> {
  const sql = "SELECT id,prompt,kind,state,COALESCE(opened_at_utc,'') AS openedAtUtc,CASE state WHEN 'open' THEN 0 ELSE 1 END AS stateOrder FROM questions WHERE class_id=? AND state IN ('open','closed')";
  const rows = cursor === undefined
    ? database.prepare(`${sql} ORDER BY stateOrder,opened_at_utc DESC,id DESC LIMIT ?`).all(classId, limit + 1) as readonly StudentQuestionRow[]
    : database.prepare(`${sql} AND (CASE state WHEN 'open' THEN 0 ELSE 1 END>? OR (CASE state WHEN 'open' THEN 0 ELSE 1 END=? AND (COALESCE(opened_at_utc,'')<? OR (COALESCE(opened_at_utc,'')=? AND id<?)))) ORDER BY stateOrder,opened_at_utc DESC,id DESC LIMIT ?`).all(classId, Number(cursor[0]), Number(cursor[0]), cursor[1], cursor[1], cursor[2], limit + 1) as readonly StudentQuestionRow[];
  return page(rows, limit, `student:${classId}:questions`, (row) => [String(row.stateOrder), row.openedAtUtc, row.id]);
}
function studentFileTasks(database: SqliteDatabase, classId: string, limit: number, cursor: Cursor | undefined): Page<StudentFileTaskRow> {
  const sql = "SELECT id,title,description,state,deadline_at_utc AS deadlineAtUtc,CASE state WHEN 'open' THEN 0 ELSE 1 END AS stateOrder FROM file_submission_tasks WHERE class_id=? AND state IN ('open','closed')";
  const rows = cursor === undefined
    ? database.prepare(`${sql} ORDER BY stateOrder,deadline_at_utc,id LIMIT ?`).all(classId, limit + 1) as readonly StudentFileTaskRow[]
    : database.prepare(`${sql} AND (CASE state WHEN 'open' THEN 0 ELSE 1 END>? OR (CASE state WHEN 'open' THEN 0 ELSE 1 END=? AND (deadline_at_utc>? OR (deadline_at_utc=? AND id>?)))) ORDER BY stateOrder,deadline_at_utc,id LIMIT ?`).all(classId, Number(cursor[0]), Number(cursor[0]), cursor[1], cursor[1], cursor[2], limit + 1) as readonly StudentFileTaskRow[];
  return page(rows, limit, `student:${classId}:file-tasks`, (row) => [String(row.stateOrder), row.deadlineAtUtc, row.id]);
}

function page<T>(rows: readonly T[], limit: number, scope: string, key: (row: T) => Cursor): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return rows.length <= limit || last === undefined ? { items } : { items, nextCursor: encodeCursor(scope, key(last)) };
}
function readLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('REQUEST_CURSOR_INVALID');
  return Math.min(value, MAX_LIMIT);
}
function readCursor(url: URL, scope: string, parameter = 'cursor', keyLength = 2): Cursor | undefined {
  const raw = url.searchParams.get(parameter);
  if (raw === null) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new Error();
    const value = decoded as { v?: unknown; s?: unknown; k?: unknown };
    if (value.v !== 1 || value.s !== scope || !Array.isArray(value.k) || value.k.length !== keyLength || value.k.some((part) => typeof part !== 'string')) throw new Error();
    return value.k as unknown as Cursor;
  } catch { throw new Error('REQUEST_CURSOR_INVALID'); }
}
function encodeCursor(scope: string, key: Cursor): string { return Buffer.from(JSON.stringify({ v: 1, s: scope, k: key })).toString('base64url'); }
function send(response: ServerResponse, value: unknown): true { response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); return true; }
