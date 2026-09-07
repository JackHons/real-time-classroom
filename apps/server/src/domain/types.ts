export type Brand<T, Name extends string> = T & Readonly<{ readonly __brand: Name }>;
export type ClassId = Brand<string, 'ClassId'>;
export type StudentId = Brand<string, 'StudentId'>;
export type StudentSessionId = Brand<string, 'StudentSessionId'>;
export type TeacherSessionId = Brand<string, 'TeacherSessionId'>;
export type PendingStudentRequestId = Brand<string, 'PendingStudentRequestId'>;
export type QuestionId = Brand<string, 'QuestionId'>;
export type QuestionTemplateId = Brand<string, 'QuestionTemplateId'>;
export type AnswerId = Brand<string, 'AnswerId'>;
export type FileSubmissionTaskId = Brand<string, 'FileSubmissionTaskId'>;
export type UploadSessionId = Brand<string, 'UploadSessionId'>;
export type FileSubmissionId = Brand<string, 'FileSubmissionId'>;

export type QuestionKind = 'single_choice' | 'multiple_choice' | 'short_text';
export type LifecycleState = 'draft' | 'open' | 'closed';
export type UploadState = 'queued' | 'staging' | 'validating' | 'file_committed' | 'metadata_committed' | 'recovery_pending' | 'failed';
export type IsoUtc = Brand<string, 'IsoUtc'>;

export type AuthorizedTeacherContext = Readonly<{ teacherSessionId: TeacherSessionId; csrfValidated: true }>;
export type AuthorizedStudentContext = Readonly<{ studentSessionId: StudentSessionId; studentId: StudentId; classId: ClassId; csrfValidated: true }>;
export type DeleteConfirmation = Readonly<{ confirmed: true; impactAcknowledged: true }>;

export type SessionTimes = Readonly<{
  createdAtUtc: IsoUtc;
  lastSeenAtUtc: IsoUtc;
  absoluteExpiresAtUtc: IsoUtc;
  idleExpiresAtUtc: IsoUtc;
  revokedAtUtc: IsoUtc | null;
}>;

export type Student = Readonly<{ id: StudentId; classId: ClassId; displayName: string; rawStudentNumber: string; normalizedStudentNumber: string; isTemporary: boolean; approvedAtUtc: IsoUtc }>;
export type PendingStudentRequest = Readonly<{ id: PendingStudentRequestId; classId: ClassId; displayName: string; rawStudentNumber: string; normalizedStudentNumber: string; requestedAtUtc: IsoUtc; status: 'pending' | 'approved' | 'rejected' }>;
export type AppSettingKey = 'teacher_shared_password_hash';
export type AppSetting = Readonly<{ key: AppSettingKey; value: string }>;
export type StudentSession = Readonly<{ id: StudentSessionId; studentId: StudentId; classId: ClassId; tokenHash: string } & SessionTimes>;
export type TeacherSession = Readonly<{ id: TeacherSessionId; tokenHash: string } & SessionTimes>;
export type Class = Readonly<{ id: ClassId; name: string; createdAtUtc: IsoUtc; updatedAtUtc: IsoUtc }>;
export type QuestionOption = Readonly<{ key: string; label: string; ordinal: number }>;
export type QuestionTemplate = Readonly<{ id: QuestionTemplateId; kind: QuestionKind; prompt: string; options: readonly QuestionOption[]; referenceAnswer: string | null }>;
export type Question = Readonly<{ id: QuestionId; classId: ClassId; templateId: QuestionTemplateId | null; kind: QuestionKind; prompt: string; options: readonly QuestionOption[]; referenceAnswer: string | null; state: LifecycleState; openedAtUtc: IsoUtc | null; closedAtUtc: IsoUtc | null }>;
export type AnswerPayload = Readonly<{ kind: QuestionKind; selectedOptions?: readonly string[]; text?: string }>;
export type AnswerCurrent = Readonly<{ id: AnswerId; questionId: QuestionId; studentId: StudentId; revision: number; idempotencyKey: string; payload: AnswerPayload; submittedAtUtc: IsoUtc; late: boolean }>;
export type AnswerAtClose = Readonly<{ questionId: QuestionId; studentId: StudentId; revision: number | null; submittedAtUtc: IsoUtc | null; payload: AnswerPayload | null; noAnswer: boolean; closedAtUtc: IsoUtc }>;
export type QuestionResultSnapshot = Readonly<{ questionId: QuestionId; closedAtUtc: IsoUtc; counts: Readonly<Record<string, number>>; shortTextResponseCount: number }>;
export type FileSubmissionTask = Readonly<{ id: FileSubmissionTaskId; classId: ClassId; title: string; description: string; state: LifecycleState; maxBytes: 100000000; deadlineAtUtc: IsoUtc; openedAtUtc: IsoUtc | null; closedAtUtc: IsoUtc | null }>;
export type UploadSession = Readonly<{ id: UploadSessionId; taskId: FileSubmissionTaskId; studentId: StudentId; idempotencyKey: string; state: UploadState; stagingKey: string | null; finalStorageKey: string | null; bytesReceived: number; sha256: string | null; receivedCompleteAtUtc: IsoUtc | null; errorCode: string | null; createdAtUtc: IsoUtc; updatedAtUtc: IsoUtc }>;
export type FileSubmission = Readonly<{ id: FileSubmissionId; taskId: FileSubmissionTaskId; studentId: StudentId; originalFilename: string; displayFilename: string; storageKey: string; declaredMimeType: string | null; byteLength: number; sha256: string; receivedCompleteAtUtc: IsoUtc; deletedAtUtc: IsoUtc | null }>;
