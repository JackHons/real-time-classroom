import type { AnswerCurrent, AuthorizedStudentContext, DeleteConfirmation, Question, QuestionId, QuestionResultSnapshot, StudentId } from '../../domain/types.js';
import type { AnswerInput, ClosedQuestionView, LiveQuestionRepository, LiveStudentAuthorization, LiveTeacherAuthorization, OpenQuestionView, StudentQuestionView } from './types.js';

export type LiveQuestionServiceDependencies = Readonly<{
  repository: LiveQuestionRepository;
  teacherAuthorization: LiveTeacherAuthorization;
  studentAuthorization: LiveStudentAuthorization;
  /** Best-effort event delivery only; persistence is complete before this is called. */
  notify?: (event: Readonly<{ type: 'question_opened' | 'answer_updated' | 'question_closed'; questionId: QuestionId; classId: Question['classId'] }>) => void;
}>;

export class LiveQuestionService {
  constructor(private readonly dependencies: LiveQuestionServiceDependencies) {}

  open(teacherContext: unknown, questionId: QuestionId): void {
    this.dependencies.teacherAuthorization.assertAuthorized(teacherContext);
    const question = this.dependencies.repository.question(questionId);
    this.dependencies.repository.open(questionId);
    this.notify('question_opened', question);
  }

  answer(studentContext: unknown, questionId: QuestionId, input: AnswerInput): AnswerCurrent {
    const student = this.dependencies.studentAuthorization.assertAuthorized(studentContext);
    const question = this.studentQuestion(questionId, student);
    const normalized = normalizeAndValidateAnswer(question, input);
    const answer = this.dependencies.repository.submit(student.studentId, {
      questionId,
      revision: normalized.revision,
      idempotencyKey: normalized.idempotencyKey,
      payload: normalized.payload,
      requestFingerprint: fingerprint(normalized)
    });
    this.notify('answer_updated', question);
    return answer;
  }

  /** PUT and POST use identical server-side revision/idempotency semantics. */
  update(studentContext: unknown, questionId: QuestionId, input: AnswerInput): AnswerCurrent {
    return this.answer(studentContext, questionId, input);
  }

  close(teacherContext: unknown, questionId: QuestionId): QuestionResultSnapshot {
    this.dependencies.teacherAuthorization.assertAuthorized(teacherContext);
    const question = this.dependencies.repository.question(questionId);
    const snapshot = this.dependencies.repository.close(questionId);
    this.notify('question_closed', question);
    return snapshot;
  }

  readForTeacher(teacherContext: unknown, questionId: QuestionId): OpenQuestionView | ClosedQuestionView {
    this.dependencies.teacherAuthorization.assertAuthorized(teacherContext);
    const question = this.dependencies.repository.question(questionId);
    if (question.state === 'closed') {
      const snapshot = this.dependencies.repository.snapshot(questionId);
      if (snapshot === undefined) throw new Error('QUESTION_CLOSE_SNAPSHOT_MISSING');
      const answers = this.dependencies.repository.closedAnswers(questionId);
      // `answer_at_close` intentionally records every eligible student.  A
      // noAnswer row is an attendance/result snapshot, never a submission.
      const answeredStudentCount = answers.filter((entry) => entry.answer !== undefined && !entry.answer.noAnswer && entry.answer.payload !== null).length;
      return {
        question,
        snapshot,
        summary: {
          eligibleStudentCount: answers.length,
          answeredStudentCount,
          unansweredStudentCount: answers.length - answeredStudentCount
        },
        answers
      };
    }
    // Draft and open views must never expose student-level answer data.
    return { question, aggregate: this.dependencies.repository.openAggregate(questionId) };
  }

  readForStudent(studentContext: unknown, questionId: QuestionId): StudentQuestionView {
    const student = this.dependencies.studentAuthorization.assertAuthorized(studentContext);
    const question = this.studentQuestion(questionId, student);
    return {
      question: withoutReferenceAnswer(question),
      answer: this.dependencies.repository.currentAnswer(questionId, student.studentId),
      answerAtClose: question.state === 'closed' ? this.dependencies.repository.answerAtClose(questionId, student.studentId) : undefined
    };
  }

  deleteAnswer(teacherContext: unknown, questionId: QuestionId, studentId: StudentId, confirmation: DeleteConfirmation): void {
    this.dependencies.teacherAuthorization.assertAuthorized(teacherContext);
    // Resolve first so a nonsensical id cannot turn into a cross-question delete.
    const question = this.dependencies.repository.question(questionId);
    this.dependencies.repository.deleteAnswer(questionId, studentId, confirmation);
    this.notify('answer_updated', question);
  }

  private notify(type: 'question_opened' | 'answer_updated' | 'question_closed', question: Question): void {
    try { this.dependencies.notify?.({ type, questionId: question.id, classId: question.classId }); }
    catch { /* Socket delivery must not roll back a durable REST write. */ }
  }

  /**
   * Students receive one indistinguishable outcome for a missing, draft, or
   * other-class question. This prevents the question id endpoint becoming an
   * existence oracle across classes or before publication.
   */
  private studentQuestion(questionId: QuestionId, student: AuthorizedStudentContext): Question {
    const question = this.dependencies.repository.question(questionId);
    if (question.classId !== student.classId || question.state === 'draft') throw new Error('QUESTION_NOT_FOUND');
    return question;
  }
}

function withoutReferenceAnswer(question: Question): StudentQuestionView['question'] {
  return {
    id: question.id,
    classId: question.classId,
    templateId: question.templateId,
    kind: question.kind,
    prompt: question.prompt,
    options: question.options,
    state: question.state,
    openedAtUtc: question.openedAtUtc,
    closedAtUtc: question.closedAtUtc
  };
}

function normalizeAndValidateAnswer(question: Question, input: AnswerInput): AnswerInput {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('ANSWER_REVISION_INVALID');
  if (input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > 200) throw new Error('IDEMPOTENCY_KEY_INVALID');
  const payload = input.payload;
  if (payload.kind !== question.kind) throw new Error('ANSWER_KIND_MISMATCH');
  if (question.kind === 'short_text') {
    if (typeof payload.text !== 'string' || payload.selectedOptions !== undefined) throw new Error('ANSWER_SHORT_TEXT_INVALID');
    const text = payload.text.normalize('NFKC').trim();
    if (text.length === 0 || text.length > 4_000) throw new Error('ANSWER_SHORT_TEXT_INVALID');
    return { revision: input.revision, idempotencyKey: input.idempotencyKey, payload: { kind: 'short_text', text } };
  }
  if (!Array.isArray(payload.selectedOptions) || payload.text !== undefined) throw new Error('ANSWER_OPTIONS_INVALID');
  const selectedOptions = payload.selectedOptions.map((value) => typeof value === 'string' ? value : '');
  const validKeys = new Set(question.options.map((option) => option.key));
  if (selectedOptions.length === 0 || selectedOptions.some((key) => key.length === 0 || !validKeys.has(key)) || new Set(selectedOptions).size !== selectedOptions.length) throw new Error('ANSWER_OPTIONS_INVALID');
  if (question.kind === 'single_choice' && selectedOptions.length !== 1) throw new Error('ANSWER_SINGLE_CHOICE_INVALID');
  return { revision: input.revision, idempotencyKey: input.idempotencyKey, payload: { kind: question.kind, selectedOptions: [...selectedOptions].sort() } };
}

/** Stable, typed fingerprint: replay must not be confused by object key order. */
function fingerprint(input: AnswerInput): string {
  return JSON.stringify({ revision: input.revision, payload: input.payload });
}
