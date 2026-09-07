import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClassId, FileSubmissionTaskId, StudentId } from '../domain/types.js';
import type { FileTaskRepository, FileTaskServicePort } from '../file-tasks/types.js';
import { UploadStorage } from './storage.js';
import { MAX_UPLOAD_BYTES } from './types.js';

export type UploadRouteDependencies = Readonly<{
  pipeline: Readonly<{ ingest: (input: Readonly<{ taskId: FileSubmissionTaskId; studentId: StudentId; bytes: AsyncIterable<Uint8Array>; originalFilename?: string; declaredMimeType?: string | null; expectedBytes?: number; expectedSha256?: string; signal?: Readonly<{ aborted: boolean }> }>) => Promise<Readonly<{ byteLength: number; sha256: string; receivedCompleteAtUtc: string }>> }>;
  service: Pick<FileTaskServicePort, 'prepareSubmission'>;
  repository: Pick<FileTaskRepository, 'task' | 'studentSubmission'>;
  storage: UploadStorage;
  studentContext: (request: IncomingMessage) => Readonly<{ studentId: StudentId; classId: ClassId }>;
  teacherContext: (request: IncomingMessage) => unknown;
}>;

/** Raw-body upload and teacher-only download boundary.  It never parses or buffers a multipart body. */
export function createUploadRoutes(dependencies: UploadRouteDependencies): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://lan-classroom.local').pathname;
    const upload = /^\/api\/classes\/([^/]+)\/file-tasks\/([^/]+)\/(?:upload|submission)$/.exec(path);
    if (request.method === 'POST' && upload !== null) {
      const classId = decodeURIComponent(upload[1]!) as ClassId;
      const taskId = decodeURIComponent(upload[2]!) as FileSubmissionTaskId;
      const student = dependencies.studentContext(request); // Origin + CSRF are checked before this session touch.
      const task = dependencies.service.prepareSubmission(student, taskId);
      if (task.classId !== classId) throw new Error('FILE_TASK_NOT_FOUND');
      const expectedBytes = contentLength(request);
      const expectedSha256 = header(request, 'x-content-sha256');
      const result = await dependencies.pipeline.ingest({
        taskId,
        studentId: student.studentId,
        bytes: request as AsyncIterable<Uint8Array>,
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
      if (task === undefined || task.classId !== classId) throw new Error('FILE_TASK_NOT_FOUND');
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
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error('UPLOAD_INVALID_CONTENT_LENGTH');
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > MAX_UPLOAD_BYTES) throw new Error('UPLOAD_TOO_LARGE');
  return length;
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
