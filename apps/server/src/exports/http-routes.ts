import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteDatabase } from '../db/connection.js';
import type { ClassId, QuestionId, QuestionKind } from '../domain/types.js';
import { csvRow } from './csv.js';

const EXPORT_BATCH_SIZE = 250;

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
  const question = database.prepare('SELECT state,closed_at_utc,kind FROM questions WHERE id=?').get(questionId) as QuestionRow | undefined;
  if (question === undefined) throw new Error('QUESTION_NOT_FOUND');
  if (question.state !== 'closed' || question.closed_at_utc === null) throw new Error('QUESTION_EXPORT_CLOSED_REQUIRED');
  const closedAtUtc = question.closed_at_utc;
  const options = database.prepare('SELECT option_key,label,ordinal FROM question_options WHERE question_id=? ORDER BY ordinal').all(questionId) as readonly OptionRow[];
  const labels = new Map(options.map((option) => [option.option_key, option]));
  const read = database.prepare(`
    WITH immutable_rows AS (
      SELECT student_id,display_name,student_number,payload_json,no_answer,closed_at_utc,'active' AS row_state FROM answer_at_close WHERE question_id=?
      UNION ALL
      SELECT student_id,display_name,student_number,NULL AS payload_json,0 AS no_answer,closed_at_utc,'deleted' AS row_state FROM answer_deletion_markers WHERE question_id=? AND closed_at_utc IS NOT NULL
    )
    SELECT student_id,display_name,student_number,payload_json,no_answer,closed_at_utc,row_state FROM immutable_rows WHERE student_id>? ORDER BY student_id LIMIT ?
  `);
  await stream(response, 'question-answers.csv', csvRow(['studentNumber', 'displayName', 'status', 'answer', 'closedAtUtc']), async (write) => {
    let cursor = '';
    while (true) {
      const rows = read.all(questionId, questionId, cursor, EXPORT_BATCH_SIZE) as readonly ClosedAnswerRow[];
      if (rows.length === 0) return;
      for (const row of rows) {
        const deleted = row.row_state === 'deleted';
        const noAnswer = !deleted && row.no_answer === 1;
        await write(csvRow([
          // NULL legacy snapshots must never fall back to today's mutable roster.
          row.student_number ?? 'Unknown', row.display_name ?? 'Unknown student',
          deleted ? 'deleted' : noAnswer ? 'noAnswer' : 'answered',
          deleted || noAnswer ? '' : answerText(row.payload_json, question.kind, labels), row.closed_at_utc ?? closedAtUtc
        ]));
      }
      const last = rows.at(-1);
      if (last === undefined || rows.length < EXPORT_BATCH_SIZE) return;
      cursor = last.student_id;
    }
  });
}

async function streamRosterExport(response: ServerResponse, database: SqliteDatabase, classId: ClassId): Promise<void> {
  if (database.prepare('SELECT 1 FROM classes WHERE id=?').get(classId) === undefined) throw new Error('CLASS_NOT_FOUND');
  const read = database.prepare('SELECT id,display_name,raw_student_number,is_temporary,approved_at_utc FROM students WHERE class_id=? AND id>? ORDER BY id LIMIT ?');
  await stream(response, 'class-roster.csv', csvRow(['studentNumber', 'displayName', 'isTemporary', 'approvedAtUtc']), async (write) => {
    let cursor = '';
    while (true) {
      const rows = read.all(classId, cursor, EXPORT_BATCH_SIZE) as readonly RosterRow[];
      if (rows.length === 0) return;
      for (const row of rows) await write(csvRow([row.raw_student_number, row.display_name, row.is_temporary === 1 ? 'true' : 'false', row.approved_at_utc]));
      const last = rows.at(-1);
      if (last === undefined || rows.length < EXPORT_BATCH_SIZE) return;
      cursor = last.id;
    }
  });
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

class ExportAbortedError extends Error {}
type QuestionRow = Readonly<{ state: string; closed_at_utc: string | null; kind: QuestionKind }>;
type OptionRow = Readonly<{ option_key: string; label: string; ordinal: number }>;
type ClosedAnswerRow = Readonly<{ student_id: string; display_name: string | null; student_number: string | null; payload_json: string | null; no_answer: number; closed_at_utc: string | null; row_state: 'active' | 'deleted' }>;
type RosterRow = Readonly<{ id: string; display_name: string; raw_student_number: string; is_temporary: number; approved_at_utc: string }>;
