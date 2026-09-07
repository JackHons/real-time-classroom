import type { AnswerAtClose, AnswerCurrent, AnswerPayload, AuthorizedStudentContext, AuthorizedTeacherContext, Class, ClassId, DeleteConfirmation, FileSubmissionTaskId, LifecycleState, Question, QuestionId, QuestionResultSnapshot, Student, StudentId, StudentSession, UploadSessionId } from '../domain/types.js';

export type CreateQuestion = Readonly<{ id: QuestionId; classId: ClassId; kind: Question['kind']; prompt: string; options: readonly Readonly<{ key: string; label: string }>[]; referenceAnswer?: string | null }>;
export type SubmitAnswer = Readonly<{ questionId: QuestionId; revision: number; idempotencyKey: string; requestFingerprint: string; payload: AnswerPayload }>;
export interface DomainRepository {
  createClass(input: Class): void;
  createStudent(input: Student): void;
  createStudentSession(input: StudentSession): void;
  createQuestion(context: AuthorizedTeacherContext, input: CreateQuestion): Question;
  transitionQuestion(context: AuthorizedTeacherContext, questionId: QuestionId, to: LifecycleState): void;
  submitAnswer(context: AuthorizedStudentContext, input: SubmitAnswer): AnswerCurrent;
  closeQuestion(context: AuthorizedTeacherContext, questionId: QuestionId): QuestionResultSnapshot;
  answerAtClose(questionId: QuestionId, studentId: StudentId): AnswerAtClose | undefined;
  deleteAnswer(context: AuthorizedTeacherContext, questionId: QuestionId, studentId: StudentId, confirmation: DeleteConfirmation): void;
  createFileTask(context: AuthorizedTeacherContext, input: Readonly<{ id: FileSubmissionTaskId; classId: ClassId; title: string; description: string; deadlineAtUtc: string }>): void;
}

/**
 * Task 5 supplies the filesystem side. It must rename the verified file before
 * `commitAfterFileRename`, and must mark recovery pending if the metadata
 * transaction fails. No upload bytes are handled by this Task 2 contract.
 */
export interface FileMetadataRepository {
  commitAfterFileRename(uploadSessionId: UploadSessionId): void;
  markRecoveryPending(uploadSessionId: UploadSessionId, errorCode: string): void;
}
