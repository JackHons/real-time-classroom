import type { AnswerAtClose, AnswerCurrent, AnswerPayload, Class, ClassId, DeleteConfirmation, FileSubmissionTaskId, LifecycleState, Question, QuestionId, QuestionResultSnapshot, QuestionTemplate, QuestionTemplateId, Student, StudentId, StudentSession, UploadSessionId } from '../domain/types.js';

export type TemplateOptionInput = Readonly<{ key: string; label: string }>;
export type CreateQuestionTemplate = Readonly<{ id: QuestionTemplateId; kind: Question['kind']; prompt: string; options: readonly TemplateOptionInput[]; referenceAnswer?: string | null }>;
export type CreateQuestion = Readonly<{ id: QuestionId; classId: ClassId; templateId?: QuestionTemplateId | null; kind: Question['kind']; prompt: string; options: readonly TemplateOptionInput[]; referenceAnswer?: string | null }>;
export type SubmitAnswer = Readonly<{ questionId: QuestionId; revision: number; idempotencyKey: string; requestFingerprint: string; payload: AnswerPayload }>;
/** Trusted-internal persistence API. Task 3 services/routes authenticate and authorize before calling it. */
export interface DomainRepository {
  createClass(input: Class): void;
  createStudent(input: Student): void;
  createStudentSession(input: StudentSession): void;
  createQuestionTemplate(input: CreateQuestionTemplate): QuestionTemplate;
  listQuestionTemplates(): readonly QuestionTemplate[];
  createQuestion(input: CreateQuestion): Question;
  transitionQuestion(questionId: QuestionId, to: LifecycleState): void;
  submitAnswer(studentId: StudentId, input: SubmitAnswer): AnswerCurrent;
  closeQuestion(questionId: QuestionId): QuestionResultSnapshot;
  answerAtClose(questionId: QuestionId, studentId: StudentId): AnswerAtClose | undefined;
  deleteAnswer(questionId: QuestionId, studentId: StudentId, confirmation: DeleteConfirmation): void;
  createFileTask(input: Readonly<{ id: FileSubmissionTaskId; classId: ClassId; title: string; description: string; deadlineAtUtc: string }>): void;
}

/**
 * Task 5 supplies the filesystem side. It must rename the verified file before
 * `commitAfterFileRename`, and must mark recovery pending if the metadata
 * transaction fails. No upload bytes are handled by this Task 2 contract.
 */
export interface FileMetadataRepository {
  commitAfterFileRename(input: Readonly<{ uploadSessionId: UploadSessionId; finalStorageKey: string }>): void;
  markRecoveryPending(uploadSessionId: UploadSessionId, errorCode: string): void;
}
