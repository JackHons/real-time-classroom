import type { AnswerAtClose, AnswerCurrent, ClassId, DeleteConfirmation, IsoUtc, Question, QuestionId, QuestionResultSnapshot, StudentId } from '../domain/types.js';
import type { DomainRepository } from './repositories.js';
import type { SqliteDatabase } from './connection.js';
import type { ClosedNamedAnswer, LiveQuestionRepository, OpenQuestionView } from '../questions/live/types.js';

/**
 * Read adapter for the Task 2 immutable question tables. Writes delegate to
 * DomainRepository so close remains its existing single database transaction.
 * This has no migration of its own: it requires Task 2 schema revision 0001.
 */
export class SqliteLiveQuestionRepository implements LiveQuestionRepository {
  constructor(private readonly database: SqliteDatabase, private readonly domain: DomainRepository) {}

  question(questionId: QuestionId): Question {
    const row = this.database.prepare('SELECT id,class_id,template_id,kind,prompt,reference_answer,state,opened_at_utc,closed_at_utc FROM questions WHERE id=?').get(questionId) as QuestionRow | undefined;
    if (row === undefined) throw new Error('QUESTION_NOT_FOUND');
    const options = this.database.prepare('SELECT option_key,label,ordinal FROM question_options WHERE question_id=? ORDER BY ordinal').all(questionId) as readonly OptionRow[];
    return {
      id: row.id as QuestionId, classId: row.class_id as ClassId, templateId: row.template_id as Question['templateId'], kind: row.kind,
      prompt: row.prompt, referenceAnswer: row.reference_answer, state: row.state,
      openedAtUtc: row.opened_at_utc as IsoUtc | null, closedAtUtc: row.closed_at_utc as IsoUtc | null,
      options: options.map((option) => ({ key: option.option_key, label: option.label, ordinal: option.ordinal }))
    };
  }

  open(questionId: QuestionId): void { this.domain.transitionQuestion(questionId, 'open'); }
  submit(studentId: StudentId, input: Parameters<LiveQuestionRepository['submit']>[1]): AnswerCurrent { return this.domain.submitAnswer(studentId, input); }
  close(questionId: QuestionId): QuestionResultSnapshot { return this.domain.closeQuestion(questionId); }
  deleteAnswer(questionId: QuestionId, studentId: StudentId, confirmation: DeleteConfirmation): void { this.domain.deleteAnswer(questionId, studentId, confirmation); }

  currentAnswer(questionId: QuestionId, studentId: StudentId): AnswerCurrent | undefined {
    const row = this.database.prepare('SELECT id,revision,idempotency_key,payload_json,submitted_at_utc,late FROM answer_current WHERE question_id=? AND student_id=?').get(questionId, studentId) as AnswerCurrentRow | undefined;
    return row === undefined ? undefined : {
      id: row.id as AnswerCurrent['id'], questionId, studentId, revision: row.revision, idempotencyKey: row.idempotency_key,
      payload: JSON.parse(row.payload_json) as AnswerCurrent['payload'], submittedAtUtc: row.submitted_at_utc as IsoUtc, late: row.late === 1
    };
  }

  answerAtClose(questionId: QuestionId, studentId: StudentId): AnswerAtClose | undefined { return this.domain.answerAtClose(questionId, studentId); }

  openAggregate(questionId: QuestionId): OpenQuestionView['aggregate'] {
    const question = this.question(questionId);
    const eligible = this.database.prepare('SELECT COUNT(*) AS count FROM students WHERE class_id=?').get(question.classId) as CountRow;
    const rows = this.database.prepare('SELECT payload_json FROM answer_current WHERE question_id=? AND late=0').all(questionId) as readonly { payload_json: string }[];
    const counts: Record<string, number> = {};
    let shortTextResponseCount = 0;
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as AnswerCurrent['payload'];
      if (payload.kind === 'short_text') shortTextResponseCount += 1;
      else for (const key of payload.selectedOptions ?? []) counts[key] = (counts[key] ?? 0) + 1;
    }
    return { eligibleStudentCount: eligible.count, answeredStudentCount: rows.length, counts, shortTextResponseCount };
  }

  closedAnswers(questionId: QuestionId): readonly ClosedNamedAnswer[] {
    const question = this.question(questionId);
    const students = this.database.prepare('SELECT id FROM students WHERE class_id=? ORDER BY id').all(question.classId) as readonly { id: string }[];
    return students.map((student) => ({ studentId: student.id as StudentId, answer: this.answerAtClose(questionId, student.id as StudentId) }));
  }

  snapshot(questionId: QuestionId): QuestionResultSnapshot | undefined {
    const row = this.database.prepare('SELECT closed_at_utc,counts_json,short_text_response_count FROM question_result_snapshots WHERE question_id=?').get(questionId) as SnapshotRow | undefined;
    return row === undefined ? undefined : { questionId, closedAtUtc: row.closed_at_utc as IsoUtc, counts: JSON.parse(row.counts_json) as Record<string, number>, shortTextResponseCount: row.short_text_response_count };
  }
}

type QuestionRow = Readonly<{ id: string; class_id: string; template_id: string | null; kind: Question['kind']; prompt: string; reference_answer: string | null; state: Question['state']; opened_at_utc: string | null; closed_at_utc: string | null }>;
type OptionRow = Readonly<{ option_key: string; label: string; ordinal: number }>;
type AnswerCurrentRow = Readonly<{ id: string; revision: number; idempotency_key: string; payload_json: string; submitted_at_utc: string; late: number }>;
type CountRow = Readonly<{ count: number }>;
type SnapshotRow = Readonly<{ closed_at_utc: string; counts_json: string; short_text_response_count: number }>;
