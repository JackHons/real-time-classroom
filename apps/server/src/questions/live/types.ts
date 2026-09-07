import type { IncomingMessage } from 'node:http';
import type { AnswerAtClose, AnswerCurrent, AnswerPayload, AuthorizedStudentContext, DeleteConfirmation, Question, QuestionId, QuestionResultSnapshot, StudentId } from '../../domain/types.js';

/** Composition must authenticate the request before handing it to this module. */
export interface LiveTeacherAuthorization {
  assertAuthorized(context: unknown): void;
}

/** A student token is useful only for the student and class returned by this port. */
export interface LiveStudentAuthorization {
  assertAuthorized(context: unknown): AuthorizedStudentContext;
}

export type AnswerInput = Readonly<{
  revision: number;
  idempotencyKey: string;
  payload: AnswerPayload;
}>;

export type OpenQuestionView = Readonly<{
  question: Question;
  aggregate: Readonly<{ eligibleStudentCount: number; answeredStudentCount: number; counts: Readonly<Record<string, number>>; shortTextResponseCount: number }>;
}>;

export type ClosedNamedAnswer = Readonly<{
  studentId: StudentId;
  answer: AnswerAtClose | undefined;
}>;

export type ClosedQuestionView = Readonly<{
  question: Question;
  snapshot: QuestionResultSnapshot;
  answers: readonly ClosedNamedAnswer[];
}>;

export type StudentQuestionView = Readonly<{
  question: Question;
  answer: AnswerCurrent | undefined;
  answerAtClose: AnswerAtClose | undefined;
}>;

/**
 * Task 2 owns durable question/answer tables. This narrow port deliberately
 * has no SQL or HTTP concerns so it can be wired into a later composition root.
 */
export interface LiveQuestionRepository {
  question(questionId: QuestionId): Question;
  open(questionId: QuestionId): void;
  submit(studentId: StudentId, input: Readonly<AnswerInput & { questionId: QuestionId; requestFingerprint: string }>): AnswerCurrent;
  close(questionId: QuestionId): QuestionResultSnapshot;
  currentAnswer(questionId: QuestionId, studentId: StudentId): AnswerCurrent | undefined;
  answerAtClose(questionId: QuestionId, studentId: StudentId): AnswerAtClose | undefined;
  openAggregate(questionId: QuestionId): OpenQuestionView['aggregate'];
  closedAnswers(questionId: QuestionId): readonly ClosedNamedAnswer[];
  snapshot(questionId: QuestionId): QuestionResultSnapshot | undefined;
  deleteAnswer(questionId: QuestionId, studentId: StudentId, confirmation: DeleteConfirmation): void;
}

export type LiveQuestionRouteDependencies = Readonly<{
  service: LiveQuestionServicePort;
  teacherContext: (request: IncomingMessage) => unknown;
  studentContext: (request: IncomingMessage) => unknown;
}>;

export interface LiveQuestionServicePort {
  open(teacherContext: unknown, questionId: QuestionId): void;
  answer(studentContext: unknown, questionId: QuestionId, input: AnswerInput): AnswerCurrent;
  update(studentContext: unknown, questionId: QuestionId, input: AnswerInput): AnswerCurrent;
  close(teacherContext: unknown, questionId: QuestionId): QuestionResultSnapshot;
  readForTeacher(teacherContext: unknown, questionId: QuestionId): OpenQuestionView | ClosedQuestionView;
  readForStudent(studentContext: unknown, questionId: QuestionId): StudentQuestionView;
  deleteAnswer(teacherContext: unknown, questionId: QuestionId, studentId: StudentId, confirmation: DeleteConfirmation): void;
}
