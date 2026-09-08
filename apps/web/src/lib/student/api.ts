import { ApiError, type AnswerPayload, type PublicClass, type StudentFileTask, type StudentQuestion } from './types';

type Fetcher = typeof fetch;
let csrfToken: string | undefined;
const CSRF_STORAGE_KEY = 'lan-classroom-student-csrf';

function rememberCsrf(token: string | undefined): void {
  csrfToken = token;
  if (token !== undefined && typeof sessionStorage !== 'undefined') sessionStorage.setItem(CSRF_STORAGE_KEY, token);
}

function restoreCsrf(): void {
  if (csrfToken === undefined && typeof sessionStorage !== 'undefined') csrfToken = sessionStorage.getItem(CSRF_STORAGE_KEY) ?? undefined;
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
      const session = await request<{ csrfToken?: string }>(fetcher, '/api/auth/student/join', {
        method: 'POST', body: JSON.stringify({ classId, displayName, studentNumber })
      });
      rememberCsrf(session.csrfToken);
      return 'active';
    } catch (error) {
      // Approval state and another active session intentionally use one public message.
      if (error instanceof ApiError && (error.status === 403 || error.status === 401 || error.status === 429)) return 'denied';
      throw error;
    }
  },
  async restoreSession(fetcher: Fetcher = fetch): Promise<{ classId: string } | undefined> {
    try {
      const result = await request<{ actor: string; classId?: string }>(fetcher, '/api/auth/session');
      restoreCsrf();
      return result.actor === 'student' && typeof result.classId === 'string' ? { classId: result.classId } : undefined;
    } catch (error) { if (error instanceof ApiError && error.status === 401) return undefined; throw error; }
  },
  readQuestion(fetcher: Fetcher, id: string): Promise<StudentQuestion> {
    return request(fetcher, `/api/questions/${encodeURIComponent(id)}?as=student`);
  },
  async submitAnswer(fetcher: Fetcher, questionId: string, revision: number, payload: AnswerPayload, key = idempotencyKey()): Promise<void> {
    await request(fetcher, `/api/questions/${encodeURIComponent(questionId)}/answers`, {
      method: 'PUT', body: JSON.stringify({ revision, idempotencyKey: key, payload })
    });
  },
  readFileTask(fetcher: Fetcher, classId: string, taskId: string): Promise<StudentFileTask> {
    return request(fetcher, `/api/classes/${encodeURIComponent(classId)}/file-tasks/${encodeURIComponent(taskId)}?as=student`);
  },
  async uploadFile(fetcher: Fetcher, classId: string, taskId: string, file: File, onProgress: (percent: number) => void): Promise<void> {
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
      xhr.send(file);
    });
  }
};
