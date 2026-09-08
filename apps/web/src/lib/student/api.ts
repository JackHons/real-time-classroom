/* global RequestInit, Headers, File, XMLHttpRequest, Storage, sessionStorage, AbortSignal */
import { ApiError, type AnswerPayload, type PublicClass, type StudentActivities, type StudentFileTask, type StudentQuestion } from './types';

type Fetcher = typeof fetch;
let csrfToken: string | undefined;
let queueOwner: string | undefined;
const QUEUE_OWNER_KEY = 'lan-classroom-answer-queue-owner';

function rememberCsrf(token: string | undefined): void {
  csrfToken = token;
}

function storage(): Storage | undefined { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage; }
function createQueueOwner(): string {
  const owner = idempotencyKey();
  storage()?.setItem(QUEUE_OWNER_KEY, owner);
  queueOwner = owner;
  return owner;
}
function restoreQueueOwner(): string { return queueOwner ?? storage()?.getItem(QUEUE_OWNER_KEY) ?? createQueueOwner(); }
function forgetSession(): void { csrfToken = undefined; queueOwner = undefined; storage()?.removeItem(QUEUE_OWNER_KEY); }

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
      const session = await request<{ csrfToken?: string }>(fetcher, '/api/auth/student/join', {
        method: 'POST', body: JSON.stringify({ classId, displayName, studentNumber })
      });
      rememberCsrf(session.csrfToken);
      // New authentication must never inherit a previous student's queue.
      createQueueOwner();
      return 'active';
    } catch (error) {
      // Approval state and another active session intentionally use one public message.
      if (error instanceof ApiError && (error.status === 403 || error.status === 401 || error.status === 429)) return 'denied';
      throw error;
    }
  },
  async restoreSession(fetcher: Fetcher = fetch): Promise<{ classId: string; queueOwner: string } | undefined> {
    try {
      const result = await request<{ actor: string; classId?: string }>(fetcher, '/api/auth/session');
      if (result.actor !== 'student' || typeof result.classId !== 'string') { forgetSession(); return undefined; }
      // Tokens never persist in IndexedDB/sessionStorage. A fresh, derived token
      // is requested only after the cookie-authenticated session is restored.
      const csrf = await request<{ csrfToken: string }>(fetcher, '/api/auth/student/csrf');
      rememberCsrf(csrf.csrfToken);
      return { classId: result.classId, queueOwner: restoreQueueOwner() };
    } catch (error) { if (error instanceof ApiError && error.status === 401) { forgetSession(); return undefined; } throw error; }
  },
  queueOwner(): string | undefined { return queueOwner; },
  readQuestion(fetcher: Fetcher, id: string, signal?: AbortSignal): Promise<StudentQuestion> {
    return request(fetcher, `/api/questions/${encodeURIComponent(id)}?as=student`, signal === undefined ? {} : { signal });
  },
  activities(fetcher: Fetcher = fetch, signal?: AbortSignal, cursor?: string): Promise<StudentActivities> {
    const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
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
