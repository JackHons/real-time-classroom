export type PublicClass = Readonly<{ id: string; name: string }>;

export type AnswerPayload = Readonly<{
  kind: 'single_choice' | 'multiple_choice' | 'short_text';
  selectedOptions?: readonly string[];
  text?: string;
}>;

export type StudentQuestion = Readonly<{
  question: Readonly<{
    id: string;
    classId: string;
    kind: AnswerPayload['kind'];
    prompt: string;
    options: readonly Readonly<{ key: string; label: string }>[];
    state: 'draft' | 'open' | 'closed';
  }>;
  answer?: Readonly<{ revision: number; payload: AnswerPayload }>;
  answerAtClose?: Readonly<{ payload?: AnswerPayload; noAnswer: boolean }>;
}>;

export type StudentFileTask = Readonly<{
  task: Readonly<{
    id: string;
    classId: string;
    title: string;
    description: string;
    state: 'draft' | 'open' | 'closed';
    deadlineAtUtc: string;
    maxBytes: number;
    reopenedAtUtc: string | null;
  }>;
  submission: Readonly<{ submitted: boolean; displayFilename?: string; submittedAtUtc?: string }>;
}>;

/** Navigation-only data: no answer key or classmate identity is exposed. */
export type StudentActivities = Readonly<{
  questions: Readonly<{ items: readonly Readonly<{ id: string; prompt: string; kind: AnswerPayload['kind']; state: 'open' | 'closed' }>[]; nextCursor?: string }>;
  fileTasks: Readonly<{ items: readonly Readonly<{ id: string; title: string; description: string; state: 'open' | 'closed'; deadlineAtUtc: string }>[]; nextCursor?: string }>;
  materials: Readonly<{ items: readonly Readonly<{ id: string; classId: string; displayFilename: string; declaredMimeType: string; byteLength: number; createdAtUtc: string }>[] }>;
}>;

export type QueuedAnswer = Readonly<{
  id: string;
  questionId: string;
  revision: number;
  idempotencyKey: string;
  payload: AnswerPayload;
  createdAt: number;
}>;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'ApiError';
  }
}
