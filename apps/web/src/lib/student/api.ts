/* global RequestInit, Headers, File, XMLHttpRequest, AbortSignal, URLSearchParams */
import { ApiError, type AnswerPayload, type PublicClass, type StudentActivities, type StudentFileTask, type StudentQuestion } from './types';
import { discardAnswerQueueOwner, discardOtherAnswerQueueOwners } from './answer-queue';

type Fetcher = typeof fetch;
let csrfToken: string | undefined;
let queueOwner: string | undefined;

function rememberCsrf(token: string | undefined): void {
  csrfToken = token;
}

async function rememberQueueOwner(sessionId: string): Promise<string> {
  const nextOwner = `student-session:${sessionId}`;
  // A successful authentication replaces the former browser session, not its
  // pending answers.
  if (queueOwner !== undefined && queueOwner !== nextOwner) await discardAnswerQueueOwner(queueOwner);
  // A browser cookie identifies one active student; all other queue namespaces
  // are orphaned and contain only answer JSON, never tokens or uploads.
  await discardOtherAnswerQueueOwners(nextOwner);
  queueOwner = nextOwner;
  return queueOwner;
}
async function forgetSession(): Promise<void> {
  const formerOwner = queueOwner;
  csrfToken = undefined;
  queueOwner = undefined;
  if (formerOwner === undefined) await discardOtherAnswerQueueOwners(undefined);
  else await discardAnswerQueueOwner(formerOwner);
}

export function isSessionExpired(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function request<T>(fetcher: Fetcher, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = init.method?.toUpperCase() ?? 'GET';
  if (method !== 'GET') {
    headers.set('content-type', headers.get('content-type') ?? 'application/json');
    if (csrfToken !== undefined) headers.set('x-csrf-token', csrfToken);
  }
  const response = await fetcher(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const code = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error : 'REQUEST_FAILED';
    throw new ApiError(response.status, code);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const studentApi = {
  listClasses(fetcher: Fetcher = fetch): Promise<readonly PublicClass[]> {
    return request(fetcher, '/api/classes');
  },
  /** First create/reuse a public request, then obtain the cookie session only for an approved roster match. */
  async join(fetcher: Fetcher, classId: string, displayName: string, studentNumber: string): Promise<'active' | 'pending' | 'denied'> {
    try {
      const joined = await request<{ outcome?: string }>(fetcher, `/api/classes/${encodeURIComponent(classId)}/join`, {
        method: 'POST', body: JSON.stringify({ displayName, studentNumber })
      });
      if (joined.outcome !== 'matched') return 'pending';
      const session = await request<{ csrfToken?: string; sessionId?: string }>(fetcher, '/api/auth/student/join', {
        method: 'POST', body: JSON.stringify({ classId, displayName, studentNumber })
      });
      rememberCsrf(session.csrfToken);
      // New authentication must never inherit a previous student's queue.
      if (typeof session.sessionId !== 'string') throw new ApiError(500, 'SESSION_ID_REQUIRED');
      await rememberQueueOwner(session.sessionId);
      return 'active';
    } catch (error) {
      // Approval state and another active session intentionally use one public message.
      if (error instanceof ApiError && (error.status === 403 || error.status === 401 || error.status === 429)) return 'denied';
      throw error;
    }
  },
  async restoreSession(fetcher: Fetcher = fetch): Promise<{ classId: string; queueOwner: string } | undefined> {
    try {
      const result = await request<{ actor: string; classId?: string; sessionId?: string }>(fetcher, '/api/auth/session');
      if (result.actor !== 'student' || typeof result.classId !== 'string' || typeof result.sessionId !== 'string') { await forgetSession(); return undefined; }
      // Tokens never persist in IndexedDB/sessionStorage. A fresh, derived token
      // is requested only after the cookie-authenticated session is restored.
      const csrf = await request<{ csrfToken: string }>(fetcher, '/api/auth/student/csrf', { method: 'POST', headers: { 'x-csrf-bootstrap': '1' } });
      rememberCsrf(csrf.csrfToken);
      return { classId: result.classId, queueOwner: await rememberQueueOwner(result.sessionId) };
    } catch (error) { if (isSessionExpired(error)) { await forgetSession(); return undefined; } throw error; }
  },
  queueOwner(): string | undefined { return queueOwner; },
  /** Session expiry/logout drops only the current owner's local answer JSON. */
  endSession(): Promise<void> { return forgetSession(); },
  readQuestion(fetcher: Fetcher, id: string, signal?: AbortSignal): Promise<StudentQuestion> {
    return request(fetcher, `/api/questions/${encodeURIComponent(id)}?as=student`, signal === undefined ? {} : { signal });
  },
  activities(fetcher: Fetcher = fetch, signal?: AbortSignal, questionCursor?: string, fileTaskCursor?: string): Promise<StudentActivities> {
    const params = new URLSearchParams(); if (questionCursor !== undefined) params.set('questionCursor', questionCursor); if (fileTaskCursor !== undefined) params.set('fileTaskCursor', fileTaskCursor);
    const query = params.size === 0 ? '' : `?${params}`;
    return request(fetcher, `/api/student/activities${query}`, signal === undefined ? {} : { signal });
  },
  async submitAnswer(fetcher: Fetcher, questionId: string, revision: number, payload: AnswerPayload, key = idempotencyKey()): Promise<void> {
    await request(fetcher, `/api/questions/${encodeURIComponent(questionId)}/answers`, {
      method: 'PUT', body: JSON.stringify({ revision, idempotencyKey: key, payload })
    });
  },
  readFileTask(fetcher: Fetcher, classId: string, taskId: string): Promise<StudentFileTask> {
    return request(fetcher, `/api/classes/${encodeURIComponent(classId)}/file-tasks/${encodeURIComponent(taskId)}?as=student`);
  },
  async uploadFile(fetcher: Fetcher, classId: string, taskId: string, file: File, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<void> {
    // XMLHttpRequest is used solely to expose upload progress; it sends the raw file and never reads it back.
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/classes/${encodeURIComponent(classId)}/file-tasks/${encodeURIComponent(taskId)}/upload`);
      xhr.withCredentials = true;
      if (csrfToken !== undefined) xhr.setRequestHeader('x-csrf-token', csrfToken);
      xhr.setRequestHeader('x-upload-filename', file.name);
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, 'UPLOAD_FAILED'));
      xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR'));
      const abort = () => { xhr.abort(); reject(new ApiError(0, 'UPLOAD_ABORTED')); };
      signal?.addEventListener('abort', abort, { once: true });
      xhr.send(file);
    });
  }
};
