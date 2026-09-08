export type ClassRoom = Readonly<{ id: string; name: string; createdAtUtc: string; updatedAtUtc: string }>;
export type Page<T> = Readonly<{ items: readonly T[]; nextCursor?: string }>;
export type CsvIssue = Readonly<{ line: number; message: string }>;
export type CsvPreview = Readonly<{ rows: readonly Readonly<{ displayName: string; rawStudentNumber: string; normalizedStudentNumber: string }>[]; issues: readonly CsvIssue[] }>;
export type PendingApproval = Readonly<{ id: string; classId: string; displayName: string; studentNumber: string }>;
export type RosterStudent = Readonly<{ id: string; displayName: string; studentNumber: string; isTemporary: boolean; approvedAtUtc: string }>;
export type QuestionSummary = Readonly<{ id: string; classId: string; templateId: string | null; kind: QuestionKind; prompt: string; state: 'draft' | 'open' | 'closed' }>;
export type QuestionKind = 'single_choice' | 'multiple_choice' | 'short_text';
export type Option = Readonly<{ id: string; label: string; ordinal: number }>;
export type ReferenceAnswer = string | readonly string[] | null;
export type Template = Readonly<{ id: string; kind: QuestionKind; prompt: string; options: readonly Option[]; referenceAnswer: ReferenceAnswer }>;
export type Draft = Readonly<{ id: string; classId: string; templateId: string | null; kind: QuestionKind; prompt: string; options: readonly Option[]; referenceAnswer: ReferenceAnswer; state: 'draft' }>;
export type Question = Readonly<{ id: string; classId: string; kind: QuestionKind; prompt: string; options: readonly Option[]; referenceAnswer: ReferenceAnswer; state: 'draft' | 'open' | 'closed' }>;
export type OpenQuestionView = Readonly<{ question: Question; aggregate: Readonly<{ eligibleStudentCount: number; answeredStudentCount: number; counts: Record<string, number>; shortTextResponseCount: number }> }>;
export type ClosedQuestionView = Readonly<{ question: Question; snapshot: Record<string, unknown>; answers: readonly Readonly<{ studentId: string; displayName: string; studentNumber: string; answer?: unknown }>[]; nextCursor?: string }>;
export type FileTask = Readonly<{ id: string; classId: string; title: string; description: string; state: 'draft' | 'open' | 'closed'; deadlineAtUtc: string; maxBytes: number }>;
export type FileTaskView = Readonly<{ task: FileTask; completion?: Readonly<{ eligibleStudentCount: number; submittedStudentCount: number }>; submissions?: readonly Readonly<{ studentId: string; displayName: string; studentNumber: string; displayFilename: string; byteLength: number; receivedCompleteAtUtc: string }>[] }>;
export type TemplateInput = Readonly<{ kind: QuestionKind; prompt: string; options?: readonly Readonly<{ id?: string; label: string }>[]; referenceAnswer?: ReferenceAnswer }>;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export class TeacherApi {
  private csrfToken: string | undefined;

  async health(): Promise<Readonly<{ status: string; reason?: string }>> { return this.request('/health', { method: 'GET' }); }
  async session(): Promise<Readonly<{ actor: 'teacher' | 'student' }>> { return this.request('/api/auth/session', { method: 'GET' }); }
  async login(password: string): Promise<void> {
    const result = await this.request<Readonly<{ actor: 'teacher'; csrfToken: string }>>('/api/auth/teacher/login', { method: 'POST', body: { password }, csrf: false });
    this.csrfToken = result.csrfToken;
  }
  async logout(): Promise<void> { await this.request('/api/auth/logout', { method: 'POST', body: {} }); this.csrfToken = undefined; }
  async classes(cursor?: string): Promise<Page<ClassRoom>> { return this.request(`/api/teacher/classes${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { method: 'GET' }); }
  async roster(classId: string, cursor?: string): Promise<Page<RosterStudent>> { return this.request(`/api/teacher/classes/${encodeURIComponent(classId)}/roster${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { method: 'GET' }); }
  async pending(classId: string, cursor?: string): Promise<Page<PendingApproval>> { return this.request(`/api/teacher/classes/${encodeURIComponent(classId)}/pending-student-requests${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { method: 'GET' }); }
  async questions(classId: string, cursor?: string): Promise<Page<QuestionSummary>> { return this.request(`/api/teacher/classes/${encodeURIComponent(classId)}/questions${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { method: 'GET' }); }
  async fileTasks(classId: string, cursor?: string): Promise<Page<FileTask>> { return this.request(`/api/teacher/classes/${encodeURIComponent(classId)}/file-tasks${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { method: 'GET' }); }
  async createClass(name: string): Promise<ClassRoom> { return this.request('/api/classes', { method: 'POST', body: { name } }); }
  async deleteClass(id: string): Promise<void> { await this.request(`/api/classes/${encodeURIComponent(id)}`, { method: 'DELETE', body: { confirmed: true, impactAcknowledged: true } }); }
  async previewRoster(id: string, csv: string): Promise<CsvPreview> { return this.request(`/api/classes/${encodeURIComponent(id)}/roster/preview`, { method: 'POST', body: { csv } }); }
  async importRoster(id: string, csv: string): Promise<CsvPreview> { return this.request(`/api/classes/${encodeURIComponent(id)}/roster/import`, { method: 'POST', body: { csv } }); }
  async approvePending(id: string): Promise<PendingApproval> { return this.request(`/api/pending-student-requests/${encodeURIComponent(id)}/approve`, { method: 'POST', body: {} }); }
  async templates(): Promise<readonly Template[]> { return this.request('/api/question-templates', { method: 'GET' }); }
  async createTemplate(input: TemplateInput): Promise<Template> { return this.request('/api/question-templates', { method: 'POST', body: input }); }
  async updateTemplate(id: string, input: TemplateInput): Promise<Template> { return this.request(`/api/question-templates/${encodeURIComponent(id)}`, { method: 'PUT', body: input }); }
  async deleteTemplate(id: string): Promise<void> { await this.request(`/api/question-templates/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} }); }
  async createDraft(classId: string, input: Readonly<{ templateId?: string; question?: TemplateInput }>): Promise<Draft> { return this.request(`/api/classes/${encodeURIComponent(classId)}/question-drafts`, { method: 'POST', body: input }); }
  async updateDraft(classId: string, id: string, input: TemplateInput): Promise<Draft> { return this.request(`/api/classes/${encodeURIComponent(classId)}/question-drafts/${encodeURIComponent(id)}`, { method: 'PUT', body: input }); }
  async openQuestion(id: string): Promise<void> { await this.request(`/api/questions/${encodeURIComponent(id)}/open`, { method: 'POST', body: {} }); }
  async closeQuestion(id: string): Promise<unknown> { return this.request(`/api/questions/${encodeURIComponent(id)}/close`, { method: 'POST', body: {} }); }
  async question(id: string, cursor?: string): Promise<OpenQuestionView | ClosedQuestionView> { return this.request(`/api/questions/${encodeURIComponent(id)}${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { method: 'GET' }); }
  async deleteAnswer(questionId: string, studentId: string): Promise<void> { await this.request(`/api/questions/${encodeURIComponent(questionId)}/answers/${encodeURIComponent(studentId)}`, { method: 'DELETE', body: { confirmed: true, impactAcknowledged: true } }); }
  async createFileTask(classId: string, input: Readonly<{ title: string; description: string; deadlineAtUtc: string }>): Promise<FileTask> { return this.request(`/api/classes/${encodeURIComponent(classId)}/file-tasks`, { method: 'POST', body: input }); }
  async fileTask(classId: string, id: string): Promise<FileTaskView> { return this.request(`/api/classes/${encodeURIComponent(classId)}/file-tasks/${encodeURIComponent(id)}`, { method: 'GET' }); }
  async updateFileTask(classId: string, id: string, input: Readonly<{ title: string; description: string; deadlineAtUtc: string }>): Promise<FileTask> { return this.request(`/api/classes/${encodeURIComponent(classId)}/file-tasks/${encodeURIComponent(id)}`, { method: 'PUT', body: input }); }
  async openFileTask(classId: string, id: string): Promise<FileTask> { return this.request(`/api/classes/${encodeURIComponent(classId)}/file-tasks/${encodeURIComponent(id)}/open`, { method: 'POST', body: {} }); }
  async closeFileTask(classId: string, id: string): Promise<FileTask> { return this.request(`/api/classes/${encodeURIComponent(classId)}/file-tasks/${encodeURIComponent(id)}/close`, { method: 'POST', body: {} }); }
  async deleteFileTask(classId: string, id: string): Promise<void> { await this.request(`/api/classes/${encodeURIComponent(classId)}/file-tasks/${encodeURIComponent(id)}`, { method: 'DELETE', body: { confirmed: true, impactAcknowledged: true } }); }
  async deleteSubmission(classId: string, taskId: string, studentId: string): Promise<void> { await this.request(`/api/classes/${encodeURIComponent(classId)}/file-tasks/${encodeURIComponent(taskId)}/submissions/${encodeURIComponent(studentId)}`, { method: 'DELETE', body: { confirmed: true, impactAcknowledged: true } }); }
  downloadUrl(classId: string, taskId: string, studentId: string): string { return `/api/classes/${encodeURIComponent(classId)}/file-tasks/${encodeURIComponent(taskId)}/submissions/${encodeURIComponent(studentId)}/download`; }

  private async request<T>(path: string, init: Readonly<{ method: string; body?: unknown; csrf?: boolean }>): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.method !== 'GET' && init.csrf !== false) {
      if (this.csrfToken === undefined) throw new ApiError(401, '請重新登入以取得安全權杖');
      headers['x-csrf-token'] = this.csrfToken;
    }
    const response = await fetch(path, { method: init.method, headers, credentials: 'same-origin', ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: unknown };
      throw new ApiError(response.status, typeof body.error === 'string' ? body.error : 'REQUEST_FAILED');
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}

export function readableError(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}${error.status === 429 ? '；請稍候再試。' : ''}`;
  return '連線或伺服器發生問題，請稍後再試。';
}
