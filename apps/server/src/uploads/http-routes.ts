import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClassId, FileSubmissionTaskId, StudentId } from '../domain/types.js';
import type { FileTaskRepository } from '../file-tasks/types.js';
import { UploadStorage } from './storage.js';
import { MAX_UPLOAD_BYTES, UploadPipelineError } from './types.js';

export type UploadRouteDependencies = Readonly<{
  pipeline: Readonly<{ ingest: (input: Readonly<{ taskId: FileSubmissionTaskId; studentId: StudentId; bytes: AsyncIterable<Uint8Array>; originalFilename?: string; declaredMimeType?: string | null; expectedBytes?: number; expectedSha256?: string; signal?: Readonly<{ aborted: boolean }> }>) => Promise<Readonly<{ byteLength: number; sha256: string; receivedCompleteAtUtc: string }>> }>;
  repository: Pick<FileTaskRepository, 'task' | 'studentSubmission'>;
  storage: UploadStorage;
  studentContext: (request: IncomingMessage) => Readonly<{ studentId: StudentId; classId: ClassId }>;
  teacherContext: (request: IncomingMessage) => unknown;
  /** Lower only in focused tests; each timer aborts the actual HTTP stream. */
  idleTimeoutMs?: number;
  absoluteRequestTimeoutMs?: number;
}>;

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 5 * 60_000;

/** Raw-body upload and teacher-only download boundary.  It never parses or buffers a multipart body. */
export function createUploadRoutes(dependencies: UploadRouteDependencies): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const timeouts = uploadTimeouts(dependencies);
  return async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://lan-classroom.local').pathname;
    const upload = /^\/api\/classes\/([^/]+)\/file-tasks\/([^/]+)\/(?:upload|submission)$/.exec(path);
    if (request.method === 'POST' && upload !== null) {
      const classId = decodeURIComponent(upload[1]!) as ClassId;
      const taskId = decodeURIComponent(upload[2]!) as FileSubmissionTaskId;
      const student = dependencies.studentContext(request); // Origin + CSRF are checked before this session touch.
      const expectedBytes = contentLength(request);
      requireOpenTaskClass(dependencies, classId, taskId);
      const expectedSha256 = header(request, 'x-content-sha256');
      const result = await dependencies.pipeline.ingest({
        taskId,
        studentId: student.studentId,
        bytes: boundedRequestBytes(request, timeouts),
        originalFilename: header(request, 'x-upload-filename') ?? header(request, 'x-filename') ?? 'upload.bin',
        declaredMimeType: mediaType(request.headers['content-type']),
        ...(expectedBytes === undefined ? {} : { expectedBytes }),
        ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
        signal: request
      });
      json(response, 201, { submitted: true, byteLength: result.byteLength, sha256: result.sha256, receivedCompleteAtUtc: result.receivedCompleteAtUtc });
      return true;
    }

    const download = /^\/api\/classes\/([^/]+)\/file-tasks\/([^/]+)\/submissions\/([^/]+)\/download$/.exec(path);
    if (request.method === 'GET' && download !== null) {
      dependencies.teacherContext(request);
      const classId = decodeURIComponent(download[1]!) as ClassId;
      const taskId = decodeURIComponent(download[2]!) as FileSubmissionTaskId;
      const task = dependencies.repository.task(taskId);
      if (task === undefined || task.classId !== classId || task.state !== 'closed') throw new Error('FILE_TASK_NOT_FOUND');
      const submission = dependencies.repository.studentSubmission(taskId, decodeURIComponent(download[3]!) as StudentId);
      if (submission === undefined || !await dependencies.storage.existsFinal(submission.storageKey)) throw new Error('FILE_SUBMISSION_NOT_FOUND');
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${headerFilename(submission.displayFilename)}"`,
        'x-content-type-options': 'nosniff',
        'content-length': String(submission.byteLength)
      });
      await pipe(createReadStream(dependencies.storage.finalPath(submission.storageKey)), response);
      return true;
    }
    return false;
  };
}

function contentLength(request: IncomingMessage): number | undefined {
  const value = header(request, 'content-length');
  if (value === undefined) return undefined; // Chunked uploads remain bounded while streaming.
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) { drainRejectedRequest(request); throw new Error('UPLOAD_INVALID_CONTENT_LENGTH'); }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > MAX_UPLOAD_BYTES) { drainRejectedRequest(request); throw new Error('UPLOAD_TOO_LARGE'); }
  return length;
}
function requireOpenTaskClass(dependencies: UploadRouteDependencies, classId: ClassId, taskId: FileSubmissionTaskId): void {
  const task = dependencies.repository.task(taskId);
  if (task === undefined || task.classId !== classId || task.state !== 'open') throw new Error('FILE_TASK_NOT_FOUND');
}
function drainRejectedRequest(request: IncomingMessage): void {
  // Do not retain an oversized body. Resume puts the parser into discard mode
  // so the application can still emit its one deterministic 400/413 response.
  request.once('error', () => undefined);
  request.resume();
}
type UploadTimeouts = Readonly<{ idleMs: number; absoluteMs: number }>;
function uploadTimeouts(dependencies: UploadRouteDependencies): UploadTimeouts {
  const idleMs = dependencies.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const absoluteMs = dependencies.absoluteRequestTimeoutMs ?? DEFAULT_ABSOLUTE_TIMEOUT_MS;
  if (!Number.isSafeInteger(idleMs) || !Number.isSafeInteger(absoluteMs) || idleMs < 1 || absoluteMs < idleMs) throw new Error('INVALID_UPLOAD_TIMEOUT_CONFIGURATION');
  return { idleMs, absoluteMs };
}
/** Timers abort the socket and await its iterator before pipeline admission releases. */
async function* boundedRequestBytes(request: IncomingMessage, timeouts: UploadTimeouts): AsyncGenerator<Uint8Array> {
  const iterator = request[Symbol.asyncIterator]();
  const absoluteEndsAt = Date.now() + timeouts.absoluteMs;
  let reachedEnd = false;
  try {
    for (;;) {
      const absoluteRemaining = absoluteEndsAt - Date.now();
      if (absoluteRemaining <= 0) throw await abortAndAwait(request, iterator.next(), 'UPLOAD_REQUEST_DEADLINE_EXCEEDED');
      const next = iterator.next();
      const result = await nextBefore(request, next, Math.min(timeouts.idleMs, absoluteRemaining), absoluteRemaining <= timeouts.idleMs ? 'UPLOAD_REQUEST_DEADLINE_EXCEEDED' : 'UPLOAD_IDLE_TIMEOUT');
      if (result.done) { reachedEnd = true; return; }
      yield result.value;
    }
  } finally {
    // Oversize/hash failures stop consuming this generator. Drain rather than
    // buffer the remaining request; timeout paths above destroy and await it.
    if (!reachedEnd && !request.destroyed) request.resume();
  }
}
async function nextBefore(request: IncomingMessage, next: Promise<IteratorResult<Uint8Array>>, milliseconds: number, timeoutCode: string): Promise<IteratorResult<Uint8Array>> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = globalThis.setTimeout(() => resolve('timeout'), milliseconds); });
  try {
    const result = await Promise.race([next, timeout]);
    if (result !== 'timeout') return result;
    throw await abortAndAwait(request, next, timeoutCode);
  } finally { if (timer !== undefined) globalThis.clearTimeout(timer); }
}
async function abortAndAwait(request: IncomingMessage, pending: Promise<IteratorResult<Uint8Array>>, code: string): Promise<never> {
  const error = new UploadPipelineError(code);
  request.destroy(error);
  try { await pending; } catch { /* destroy settles the iterator before release */ }
  throw error;
}
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}
function mediaType(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const type = value.split(';', 1)[0]!.trim().toLowerCase();
  return type.length > 0 && type.length <= 255 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : null;
}
function headerFilename(value: string): string { return value.replace(/["\\\r\n]/g, '_').slice(0, 255) || 'download'; }
function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
function pipe(input: ReturnType<typeof createReadStream>, response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => { input.once('error', reject); response.once('error', reject); response.once('finish', resolve); input.pipe(response); });
}
