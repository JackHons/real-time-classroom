import type { IncomingMessage, ServerResponse } from 'node:http';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteDatabase } from '../db/connection.js';
import type { ClassId, QuestionId, QuestionKind } from '../domain/types.js';
import { csvRow } from './csv.js';

const EXPORT_BATCH_SIZE = 250;
// A separate SQLite file bounds snapshot storage without retaining an HTTP
// request's read transaction (and its WAL pages) for the duration of a slow
// download.  128 MiB is deliberately below the application's 100 MiB upload
// ceiling while still allowing a substantial roster/answer export.
const EXPORT_SNAPSHOT_MAX_PAGES = 32_768;

export type ExportRouteDependencies = Readonly<{
  database: SqliteDatabase;
  /** Composition authenticates even safe GETs before export begins. */
  teacherContext: (request: IncomingMessage) => unknown;
}>;

/** Teacher-only, keyset/batch-backed CSV exports with no route aliases. */
export function createExportRoutes(dependencies: ExportRouteDependencies): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    if (request.method !== 'GET') return false;
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const answerMatch = /^\/api\/questions\/([^/]+)\/answers\/export\.csv$/.exec(pathname);
    if (answerMatch?.[1] !== undefined) {
      dependencies.teacherContext(request);
      await streamClosedAnswerExport(response, dependencies.database, decodeURIComponent(answerMatch[1]) as QuestionId);
      return true;
    }
    const rosterMatch = /^\/api\/classes\/([^/]+)\/roster\/export\.csv$/.exec(pathname);
    if (rosterMatch?.[1] !== undefined) {
      dependencies.teacherContext(request);
      await streamRosterExport(response, dependencies.database, decodeURIComponent(rosterMatch[1]) as ClassId);
      return true;
    }
    return false;
  };
}

async function streamClosedAnswerExport(response: ServerResponse, database: SqliteDatabase, questionId: QuestionId): Promise<void> {
  const snapshot = materializeClosedAnswerSnapshot(database, questionId);
  try {
    const read = snapshot.database.prepare('SELECT ordinal,student_number,display_name,status,answer,closed_at_utc FROM answer_rows WHERE ordinal>? ORDER BY ordinal LIMIT ?');
    await stream(response, 'question-answers.csv', csvRow(['studentNumber', 'displayName', 'status', 'answer', 'closedAtUtc']), async (write) => {
      let cursor = 0;
      while (true) {
        const rows = read.all(cursor, EXPORT_BATCH_SIZE) as readonly AnswerExportRow[];
        if (rows.length === 0) return;
        for (const row of rows) {
          await write(csvRow([row.student_number, row.display_name, row.status, row.answer, row.closed_at_utc]));
        }
        const last = rows.at(-1);
        if (last === undefined || rows.length < EXPORT_BATCH_SIZE) return;
        cursor = last.ordinal;
      }
    });
  } finally {
    snapshot.dispose();
  }
}

async function streamRosterExport(response: ServerResponse, database: SqliteDatabase, classId: ClassId): Promise<void> {
  const snapshot = materializeRosterSnapshot(database, classId);
  try {
    const read = snapshot.database.prepare('SELECT ordinal,student_number,display_name,is_temporary,approved_at_utc FROM roster_rows WHERE ordinal>? ORDER BY ordinal LIMIT ?');
    await stream(response, 'class-roster.csv', csvRow(['studentNumber', 'displayName', 'isTemporary', 'approvedAtUtc']), async (write) => {
      let cursor = 0;
      while (true) {
        const rows = read.all(cursor, EXPORT_BATCH_SIZE) as readonly RosterExportRow[];
        if (rows.length === 0) return;
        for (const row of rows) await write(csvRow([row.student_number, row.display_name, row.is_temporary === 1 ? 'true' : 'false', row.approved_at_utc]));
        const last = rows.at(-1);
        if (last === undefined || rows.length < EXPORT_BATCH_SIZE) return;
        cursor = last.ordinal;
      }
    });
  } finally {
    snapshot.dispose();
  }
}

async function stream(response: ServerResponse, filename: string, header: string, body: (write: (chunk: string) => Promise<void>) => Promise<void>): Promise<void> {
  response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"; filename*=UTF-8''${filename}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  let aborted = false;
  const abort = (): void => { aborted = true; };
  response.once('close', abort);
  response.once('error', abort);
  try {
    const write = async (chunk: string): Promise<void> => {
      if (aborted || response.destroyed) throw new ExportAbortedError();
      if (!response.write(chunk, 'utf8')) {
        await waitForWritable(response);
        if (aborted || response.destroyed) throw new ExportAbortedError();
      }
    };
    await write('\ufeff'); await write(header); await body(write);
    if (!aborted) response.end();
  } catch (error) {
    if (!(error instanceof ExportAbortedError) && !response.destroyed) response.destroy(error instanceof Error ? error : undefined);
  } finally {
    response.off('close', abort); response.off('error', abort);
  }
}

function waitForWritable(response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', drained); response.off('close', closed); response.off('error', failed);
    };
    const drained = (): void => { cleanup(); resolve(); };
    const closed = (): void => { cleanup(); reject(new ExportAbortedError()); };
    const failed = (): void => { cleanup(); reject(new ExportAbortedError()); };
    response.once('drain', drained); response.once('close', closed); response.once('error', failed);
  });
}

function answerText(payloadJson: string | null, kind: QuestionKind, labels: ReadonlyMap<string, OptionRow>): string {
  if (payloadJson === null) return '';
  const payload = JSON.parse(payloadJson) as Readonly<{ selectedOptions?: unknown; text?: unknown }>;
  if (kind === 'short_text') return typeof payload.text === 'string' ? payload.text : '';
  if (!Array.isArray(payload.selectedOptions) || !payload.selectedOptions.every((value) => typeof value === 'string')) return '';
  return [...payload.selectedOptions].map((key) => ({ key, option: labels.get(key) }))
    .sort((left, right) => (left.option?.ordinal ?? Number.MAX_SAFE_INTEGER) - (right.option?.ordinal ?? Number.MAX_SAFE_INTEGER) || left.key.localeCompare(right.key))
    .map(({ key, option }) => option?.label ?? key).join('; ');
}

/** Creates a bounded on-disk copy while the source is held in one short read transaction. */
function materializeRosterSnapshot(database: SqliteDatabase, classId: ClassId): ExportSnapshot {
  const snapshot = createExportSnapshot();
  try {
    snapshot.database.exec('CREATE TABLE roster_rows (ordinal INTEGER PRIMARY KEY, student_number TEXT NOT NULL, display_name TEXT NOT NULL, is_temporary INTEGER NOT NULL, approved_at_utc TEXT NOT NULL)');
    const insert = snapshot.database.prepare('INSERT INTO roster_rows (ordinal,student_number,display_name,is_temporary,approved_at_utc) VALUES (?,?,?,?,?)');
    const read = database.prepare('SELECT id,display_name,raw_student_number,is_temporary,approved_at_utc FROM students WHERE class_id=? AND id>? ORDER BY id LIMIT ?');
    database.transaction(() => {
      if (database.prepare('SELECT 1 FROM classes WHERE id=?').get(classId) === undefined) throw new Error('CLASS_NOT_FOUND');
      let cursor = '';
      let ordinal = 0;
      while (true) {
        const rows = read.all(classId, cursor, EXPORT_BATCH_SIZE) as readonly RosterRow[];
        if (rows.length === 0) return;
        for (const row of rows) {
          ordinal += 1;
          insert.run(ordinal, row.raw_student_number, row.display_name, row.is_temporary, row.approved_at_utc);
        }
        const last = rows.at(-1);
        if (last === undefined || rows.length < EXPORT_BATCH_SIZE) return;
        cursor = last.id;
      }
    })();
    return snapshot;
  } catch (error) {
    snapshot.dispose();
    throw error;
  }
}

/** Includes question metadata, labels and rows in the same source snapshot. */
function materializeClosedAnswerSnapshot(database: SqliteDatabase, questionId: QuestionId): ExportSnapshot {
  const snapshot = createExportSnapshot();
  try {
    snapshot.database.exec('CREATE TABLE answer_rows (ordinal INTEGER PRIMARY KEY, student_number TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL, answer TEXT NOT NULL, closed_at_utc TEXT NOT NULL)');
    const insert = snapshot.database.prepare('INSERT INTO answer_rows (ordinal,student_number,display_name,status,answer,closed_at_utc) VALUES (?,?,?,?,?,?)');
    const read = database.prepare(`
      WITH immutable_rows AS (
        SELECT student_id,display_name,student_number,payload_json,no_answer,closed_at_utc,'active' AS row_state FROM answer_at_close WHERE question_id=?
        UNION ALL
        SELECT student_id,display_name,student_number,NULL AS payload_json,0 AS no_answer,closed_at_utc,'deleted' AS row_state FROM answer_deletion_markers WHERE question_id=? AND closed_at_utc IS NOT NULL
      )
      SELECT student_id,display_name,student_number,payload_json,no_answer,closed_at_utc,row_state FROM immutable_rows WHERE student_id>? ORDER BY student_id LIMIT ?
    `);
    database.transaction(() => {
      const question = database.prepare('SELECT state,closed_at_utc,kind FROM questions WHERE id=?').get(questionId) as QuestionRow | undefined;
      if (question === undefined) throw new Error('QUESTION_NOT_FOUND');
      if (question.state !== 'closed' || question.closed_at_utc === null) throw new Error('QUESTION_EXPORT_CLOSED_REQUIRED');
      const options = database.prepare('SELECT option_key,label,ordinal FROM question_options WHERE question_id=? ORDER BY ordinal').all(questionId) as readonly OptionRow[];
      const labels = new Map(options.map((option) => [option.option_key, option]));
      let cursor = '';
      let ordinal = 0;
      while (true) {
        const rows = read.all(questionId, questionId, cursor, EXPORT_BATCH_SIZE) as readonly ClosedAnswerRow[];
        if (rows.length === 0) return;
        for (const row of rows) {
          const deleted = row.row_state === 'deleted';
          const noAnswer = !deleted && row.no_answer === 1;
          ordinal += 1;
          insert.run(ordinal, row.student_number ?? 'Unknown', row.display_name ?? 'Unknown student', deleted ? 'deleted' : noAnswer ? 'noAnswer' : 'answered', deleted || noAnswer ? '' : answerText(row.payload_json, question.kind, labels), row.closed_at_utc ?? question.closed_at_utc);
        }
        const last = rows.at(-1);
        if (last === undefined || rows.length < EXPORT_BATCH_SIZE) return;
        cursor = last.student_id;
      }
    })();
    return snapshot;
  } catch (error) {
    snapshot.dispose();
    throw error;
  }
}

function createExportSnapshot(): ExportSnapshot {
  const directory = mkdtempSync(join(tmpdir(), 'lan-classroom-export-snapshot-'));
  let snapshotDatabase: SqliteDatabase | undefined;
  try {
    snapshotDatabase = new Database(join(directory, 'snapshot.sqlite'));
    snapshotDatabase.pragma('journal_mode = DELETE');
    snapshotDatabase.pragma('page_size = 4096');
    snapshotDatabase.pragma(`max_page_count = ${EXPORT_SNAPSHOT_MAX_PAGES}`);
    const database = snapshotDatabase;
    return {
      database,
      dispose: () => {
        database.close();
        rmSync(directory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    snapshotDatabase?.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

class ExportAbortedError extends Error {}
type ExportSnapshot = Readonly<{ database: SqliteDatabase; dispose: () => void }>;
type QuestionRow = Readonly<{ state: string; closed_at_utc: string | null; kind: QuestionKind }>;
type OptionRow = Readonly<{ option_key: string; label: string; ordinal: number }>;
type ClosedAnswerRow = Readonly<{ student_id: string; display_name: string | null; student_number: string | null; payload_json: string | null; no_answer: number; closed_at_utc: string | null; row_state: 'active' | 'deleted' }>;
type RosterRow = Readonly<{ id: string; display_name: string; raw_student_number: string; is_temporary: number; approved_at_utc: string }>;
type RosterExportRow = Readonly<{ ordinal: number; student_number: string; display_name: string; is_temporary: number; approved_at_utc: string }>;
type AnswerExportRow = Readonly<{ ordinal: number; student_number: string; display_name: string; status: string; answer: string; closed_at_utc: string }>;
