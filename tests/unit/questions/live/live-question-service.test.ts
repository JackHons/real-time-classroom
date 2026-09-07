import { describe, expect, it } from 'vitest';
import { LiveQuestionService } from '../../../../apps/server/src/questions/live/live-question-service.js';
import type { AnswerAtClose, AnswerCurrent, AuthorizedStudentContext, Question, QuestionId, QuestionResultSnapshot, StudentId } from '../../../../apps/server/src/domain/types.js';
import type { LiveQuestionRepository } from '../../../../apps/server/src/questions/live/types.js';

const question: Question = { id: 'q1' as QuestionId, classId: 'class-a' as never, templateId: null, kind: 'single_choice', prompt: 'Pick', options: [{ key: 'a', label: 'A', ordinal: 0 }, { key: 'b', label: 'B', ordinal: 1 }], referenceAnswer: null, state: 'open', openedAtUtc: '2026-01-01T00:00:00.000Z' as never, closedAtUtc: null };
const student: AuthorizedStudentContext = { studentSessionId: 'session' as never, studentId: 'student-a' as StudentId, classId: 'class-a' as never, csrfValidated: true };

function service(repository: Partial<LiveQuestionRepository>, context = student): LiveQuestionService {
  return new LiveQuestionService({
    repository: { question: () => question, open: () => undefined, submit: () => answer(), close: () => snapshot(), currentAnswer: () => undefined, answerAtClose: () => undefined, openAggregate: () => ({ eligibleStudentCount: 2, answeredStudentCount: 1, counts: { a: 1 }, shortTextResponseCount: 0 }), closedAnswers: () => [{ studentId: 'student-a' as StudentId, displayName: 'Ada', studentNumber: 'A1', answer: atClose() }], snapshot: () => snapshot(), deleteAnswer: () => undefined, ...repository },
    teacherAuthorization: { assertAuthorized: () => undefined }, studentAuthorization: { assertAuthorized: () => context }
  });
}
function answer(): AnswerCurrent { return { id: 'answer' as never, questionId: question.id, studentId: student.studentId, revision: 1, idempotencyKey: 'idempotent', payload: { kind: 'single_choice', selectedOptions: ['a'] }, submittedAtUtc: '2026-01-01T00:00:01.000Z' as never, late: false }; }
function atClose(): AnswerAtClose { return { questionId: question.id, studentId: student.studentId, revision: 1, submittedAtUtc: '2026-01-01T00:00:01.000Z' as never, payload: { kind: 'single_choice', selectedOptions: ['a'] }, noAnswer: false, closedAtUtc: '2026-01-01T00:01:00.000Z' as never }; }
function snapshot(): QuestionResultSnapshot { return { questionId: question.id, closedAtUtc: '2026-01-01T00:01:00.000Z' as never, counts: { a: 1 }, shortTextResponseCount: 0 }; }

describe('live question service', () => {
  it('normalizes a valid choice and creates a stable replay fingerprint', () => {
    let received: Parameters<LiveQuestionRepository['submit']>[1] | undefined;
    const result = service({ submit: (_student, input) => { received = input; return answer(); } }).answer(student, question.id, { revision: 1, idempotencyKey: 'same', payload: { kind: 'single_choice', selectedOptions: ['a'] } });
    expect(result.id).toBe('answer');
    expect(received).toMatchObject({ requestFingerprint: '{"revision":1,"payload":{"kind":"single_choice","selectedOptions":["a"]}}', payload: { selectedOptions: ['a'] } });
  });

  it('rejects payloads that would make aggregate data invalid', () => {
    const target = service({});
    expect(() => target.answer(student, question.id, { revision: 0, idempotencyKey: 'x', payload: { kind: 'single_choice', selectedOptions: ['a', 'b'] } })).toThrow('ANSWER_SINGLE_CHOICE_INVALID');
    expect(() => target.answer(student, question.id, { revision: 0, idempotencyKey: 'x', payload: { kind: 'single_choice', selectedOptions: ['missing'] } })).toThrow('ANSWER_OPTIONS_INVALID');
  });

  it('makes another-class, missing, and draft questions indistinguishable to students', () => {
    const other = { ...student, classId: 'class-b' as never };
    const target = service({}, other);
    expect(() => target.readForStudent(other, question.id)).toThrow('QUESTION_NOT_FOUND');
    expect(() => target.answer(other, question.id, { revision: 1, idempotencyKey: 'x', payload: { kind: 'single_choice', selectedOptions: ['a'] } })).toThrow('QUESTION_NOT_FOUND');
    expect(() => service({ question: () => { throw new Error('QUESTION_NOT_FOUND'); } }).readForStudent(student, 'missing' as never)).toThrow('QUESTION_NOT_FOUND');
    expect(() => service({ question: () => ({ ...question, state: 'draft' }) }).readForStudent(student, question.id)).toThrow('QUESTION_NOT_FOUND');
  });

  it('never returns the teacher reference answer to a student', () => {
    const target = service({ question: () => ({ ...question, referenceAnswer: 'teacher-secret' }) });
    const result = target.readForStudent(student, question.id);
    expect(result.question).not.toHaveProperty('referenceAnswer');
    expect(JSON.stringify(result)).not.toContain('referenceAnswer');
    expect(JSON.stringify(result)).not.toContain('teacher-secret');
  });

  it('shows teachers only anonymous aggregates while open, and named answers only after close', () => {
    const target = service({});
    expect(target.readForTeacher('teacher', question.id)).toEqual({ question, aggregate: { eligibleStudentCount: 2, answeredStudentCount: 1, counts: { a: 1 }, shortTextResponseCount: 0 } });
    const closed = { ...question, state: 'closed' as const, closedAtUtc: '2026-01-01T00:01:00.000Z' as never };
    const closedTarget = service({ question: () => closed });
    expect(closedTarget.readForTeacher('teacher', question.id)).toMatchObject({ answers: [{ studentId: 'student-a' }] });
  });

  it('uses the repository close transaction and never supplies a client clock', () => {
    let closed: QuestionId | undefined;
    const target = service({ close: (id) => { closed = id; return snapshot(); } });
    expect(target.close('teacher', question.id)).toEqual(snapshot());
    expect(closed).toBe(question.id);
  });
});
