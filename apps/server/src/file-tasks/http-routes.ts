import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClassId, DeleteConfirmation, FileSubmissionTaskId, StudentId } from '../domain/types.js';
import { readBoundedJsonObject } from '../http/bounded-json.js';
import type { FileTaskDraftInput, FileTaskRouteDependencies } from './types.js';

const MAX_BODY_BYTES = 16 * 1024;

/** Opt-in boundary. Application composition supplies Origin, session and CSRF checks before bodies are parsed. */
export function createFileTaskRoutes(dependencies: FileTaskRouteDependencies): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const action = /^\/api\/classes\/([^/]+)\/file-tasks\/([^/]+)\/(open|close)$/.exec(url.pathname);
    if (request.method === 'POST' && action !== null) {
      requireEmpty(await body(request));
      const taskId = decodeURIComponent(action[2]!) as FileSubmissionTaskId;
      return respond(response, 200, action[3] === 'open'
        ? dependencies.service.open(dependencies.teacherContext(request), taskId)
        : dependencies.service.close(dependencies.teacherContext(request), taskId));
    }
    const submission = /^\/api\/classes\/([^/]+)\/file-tasks\/([^/]+)\/submissions\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'DELETE' && submission !== null) {
      dependencies.service.deleteSubmission(dependencies.teacherContext(request), decodeURIComponent(submission[2]!) as FileSubmissionTaskId, decodeURIComponent(submission[3]!) as StudentId, confirmation(await body(request)));
      return respond(response, 204);
    }
    const base = /^\/api\/classes\/([^/]+)\/file-tasks(?:\/([^/]+))?$/.exec(url.pathname);
    if (base === null) return false;
    const classId = decodeURIComponent(base[1]!) as ClassId;
    const taskId = base[2] === undefined ? undefined : decodeURIComponent(base[2]) as FileSubmissionTaskId;
    if (request.method === 'POST' && taskId === undefined) return respond(response, 201, dependencies.service.createDraft(dependencies.teacherContext(request), classId, draft(await body(request))));
    if (taskId === undefined) return false;
    if (request.method === 'GET') {
      const actor = url.searchParams.get('as') === 'student'
        ? dependencies.service.readForStudent(dependencies.studentContext(request), taskId)
        : dependencies.service.readForTeacher(dependencies.teacherContext(request), taskId);
      return respond(response, 200, actor);
    }
    if (request.method === 'PUT') return respond(response, 200, dependencies.service.updateDraft(dependencies.teacherContext(request), taskId, draft(await body(request))));
    if (request.method === 'DELETE') { dependencies.service.deleteTask(dependencies.teacherContext(request), taskId, confirmation(await body(request))); return respond(response, 204); }
    return false;
  };
}
function draft(input: Record<string, unknown>): FileTaskDraftInput { exact(input, ['title', 'description', 'deadlineAtUtc']); return { title: input.title as string, description: input.description as string, deadlineAtUtc: input.deadlineAtUtc as string }; }
function confirmation(input: Record<string, unknown>): DeleteConfirmation { if (input.confirmed !== true || input.impactAcknowledged !== true) throw new Error('DELETE_CONFIRMATION_REQUIRED'); return { confirmed: true, impactAcknowledged: true }; }
function requireEmpty(input: Record<string, unknown>): void { exact(input, []); }
function exact(input: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error('REQUEST_UNEXPECTED_FIELD'); }
function body(request: IncomingMessage): Promise<Record<string, unknown>> { return readBoundedJsonObject(request, MAX_BODY_BYTES); }
function respond(response: ServerResponse, status: number, value?: unknown): true { response.writeHead(status, { 'cache-control': 'no-store', ...(status === 204 ? {} : { 'content-type': 'application/json; charset=utf-8' }) }); response.end(status === 204 ? undefined : JSON.stringify(value)); return true; }
