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
      const teacher = dependencies.teacherContext(request);
      requireTaskClass(dependencies, decodeURIComponent(action[1]!) as ClassId, decodeURIComponent(action[2]!) as FileSubmissionTaskId);
      requireEmpty(await body(request));
      const taskId = decodeURIComponent(action[2]!) as FileSubmissionTaskId;
      return respond(response, 200, action[3] === 'open'
        ? dependencies.service.open(teacher, taskId)
        : dependencies.service.close(teacher, taskId));
    }
    const submission = /^\/api\/classes\/([^/]+)\/file-tasks\/([^/]+)\/submissions\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'DELETE' && submission !== null) {
      const teacher = dependencies.teacherContext(request);
      const taskId = decodeURIComponent(submission[2]!) as FileSubmissionTaskId;
      requireTaskClass(dependencies, decodeURIComponent(submission[1]!) as ClassId, taskId);
      dependencies.service.deleteSubmission(teacher, taskId, decodeURIComponent(submission[3]!) as StudentId, confirmation(await body(request)));
      return respond(response, 204);
    }
    const base = /^\/api\/classes\/([^/]+)\/file-tasks(?:\/([^/]+))?$/.exec(url.pathname);
    if (base === null) return false;
    const classId = decodeURIComponent(base[1]!) as ClassId;
    const taskId = base[2] === undefined ? undefined : decodeURIComponent(base[2]) as FileSubmissionTaskId;
    if (request.method === 'POST' && taskId === undefined) {
      const teacher = dependencies.teacherContext(request);
      return respond(response, 201, dependencies.service.createDraft(teacher, classId, draft(await body(request))));
    }
    if (taskId === undefined) return false;
    if (request.method === 'GET' && url.searchParams.get('as') === 'student') {
      const student = dependencies.studentContext(request);
      requireTaskClass(dependencies, classId, taskId);
      return respond(response, 200, dependencies.service.readForStudent(student, taskId));
    }
    const teacher = dependencies.teacherContext(request);
    requireTaskClass(dependencies, classId, taskId);
    if (request.method === 'GET') {
      return respond(response, 200, dependencies.service.readForTeacher(teacher, taskId));
    }
    if (request.method === 'PUT') return respond(response, 200, dependencies.service.updateDraft(teacher, taskId, draft(await body(request))));
    if (request.method === 'DELETE') { dependencies.service.deleteTask(teacher, taskId, confirmation(await body(request))); return respond(response, 204); }
    return false;
  };
}
function requireTaskClass(dependencies: FileTaskRouteDependencies, classId: ClassId, taskId: FileSubmissionTaskId): void {
  const task = dependencies.repository.task(taskId);
  if (task === undefined || task.classId !== classId) throw new Error('FILE_TASK_NOT_FOUND');
}
function draft(input: Record<string, unknown>): FileTaskDraftInput { exact(input, ['title', 'description', 'deadlineAtUtc']); return { title: input.title as string, description: input.description as string, deadlineAtUtc: input.deadlineAtUtc as string }; }
function confirmation(input: Record<string, unknown>): DeleteConfirmation { if (input.confirmed !== true || input.impactAcknowledged !== true) throw new Error('DELETE_CONFIRMATION_REQUIRED'); return { confirmed: true, impactAcknowledged: true }; }
function requireEmpty(input: Record<string, unknown>): void { exact(input, []); }
function exact(input: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error('REQUEST_UNEXPECTED_FIELD'); }
function body(request: IncomingMessage): Promise<Record<string, unknown>> { return readBoundedJsonObject(request, MAX_BODY_BYTES); }
function respond(response: ServerResponse, status: number, value?: unknown): true { response.writeHead(status, { 'cache-control': 'no-store', ...(status === 204 ? {} : { 'content-type': 'application/json; charset=utf-8' }) }); response.end(status === 204 ? undefined : JSON.stringify(value)); return true; }
