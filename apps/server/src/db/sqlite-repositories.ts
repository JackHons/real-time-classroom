import { randomUUID } from 'node:crypto';
import { assertLifecycleTransition } from '../domain/state-machine.js';
import type { AnswerAtClose, AnswerCurrent, AnswerPayload, AuthorizedStudentContext, AuthorizedTeacherContext, Class, FileSubmissionTaskId, IsoUtc, LifecycleState, Question, QuestionId, QuestionResultSnapshot, Student, StudentId, StudentSession, UploadSessionId } from '../domain/types.js';
import type { SqliteDatabase } from './connection.js';
import type { CreateQuestion, DomainRepository, FileMetadataRepository, SubmitAnswer } from './repositories.js';

type QuestionRow = { id: string; class_id: string; template_id: string | null; kind: Question['kind']; prompt: string; reference_answer: string | null; state: LifecycleState; opened_at_utc: string | null; closed_at_utc: string | null };
type AnswerRow = { id: string; student_id: string; revision: number; idempotency_key: string; payload_json: string; submitted_at_utc: string; late: number };

export class SqliteDomainRepository implements DomainRepository {
  constructor(private readonly database: SqliteDatabase, private readonly now: () => string = () => new Date().toISOString()) {}

  createClass(input: Class): void {
    this.database.prepare('INSERT INTO classes (id,name,created_at_utc,updated_at_utc) VALUES (?,?,?,?)').run(input.id, input.name, input.createdAtUtc, input.updatedAtUtc);
  }

  createStudent(input: Student): void {
    this.database.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)').run(input.id, input.classId, input.displayName, input.rawStudentNumber, input.normalizedStudentNumber, Number(input.isTemporary), input.approvedAtUtc);
  }

  createStudentSession(input: StudentSession): void {
    const now = this.now();
    this.database.transaction(() => {
      // SQLite's partial index cannot express moving time. Expired rows are
      // revoked inside this transaction before the active-session insert.
      this.database.prepare('UPDATE student_sessions SET revoked_at_utc=? WHERE student_id=? AND revoked_at_utc IS NULL AND (absolute_expires_at_utc <= ? OR idle_expires_at_utc <= ?)').run(now, input.studentId, now, now);
      this.database.prepare('INSERT INTO student_sessions (id,student_id,class_id,token_hash,created_at_utc,last_seen_at_utc,absolute_expires_at_utc,idle_expires_at_utc,revoked_at_utc) VALUES (?,?,?,?,?,?,?,?,?)').run(input.id, input.studentId, input.classId, input.tokenHash, input.createdAtUtc, input.lastSeenAtUtc, input.absoluteExpiresAtUtc, input.idleExpiresAtUtc, input.revokedAtUtc);
    })();
  }

  createQuestion(context: AuthorizedTeacherContext, input: CreateQuestion): Question {
    void context;
    const now = this.now();
    this.database.transaction(() => {
      this.database.prepare('INSERT INTO questions (id,class_id,template_id,kind,prompt,reference_answer,state,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?,\'draft\',NULL,NULL,?,?)').run(input.id, input.classId, null, input.kind, input.prompt, input.referenceAnswer ?? null, now, now);
      const option = this.database.prepare('INSERT INTO question_options (id,question_id,option_key,label,ordinal) VALUES (?,?,?,?,?)');
      input.options.forEach((value, ordinal) => option.run(`${input.id}:${value.key}`, input.id, value.key, value.label, ordinal));
    })();
    return this.getQuestion(input.id);
  }

  transitionQuestion(context: AuthorizedTeacherContext, questionId: QuestionId, to: LifecycleState): void {
    void context;
    if (to === 'closed') { this.closeQuestion(context, questionId); return; }
    const question = this.row(questionId);
    assertLifecycleTransition(question.state, to);
    const now = this.now();
    this.database.prepare('UPDATE questions SET state=?, opened_at_utc=?, updated_at_utc=? WHERE id=?').run(to, now, now, questionId);
  }

  submitAnswer(context: AuthorizedStudentContext, input: SubmitAnswer): AnswerCurrent {
    const transaction = this.database.transaction(() => {
      const prior = this.database.prepare('SELECT request_fingerprint,response_json FROM answer_submission_idempotency WHERE student_id=? AND question_id=? AND idempotency_key=?').get(context.studentId, input.questionId, input.idempotencyKey) as { request_fingerprint: string; response_json: string } | undefined;
      if (prior !== undefined) {
        if (prior.request_fingerprint !== input.requestFingerprint) throw new Error('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
        return JSON.parse(prior.response_json) as AnswerCurrent;
      }
      const question = this.row(input.questionId);
      if (question.class_id !== context.classId || question.state === 'draft') throw new Error('QUESTION_NOT_ANSWERABLE');
      const existing = this.database.prepare('SELECT id,student_id,revision,idempotency_key,payload_json,submitted_at_utc,late FROM answer_current WHERE question_id=? AND student_id=?').get(input.questionId, context.studentId) as AnswerRow | undefined;
      if (existing !== undefined && input.revision <= existing.revision) throw new Error('STALE_ANSWER_REVISION');
      const now = this.now() as IsoUtc;
      const answer: AnswerCurrent = { id: (existing?.id ?? randomUUID()) as AnswerCurrent['id'], questionId: input.questionId, studentId: context.studentId, revision: input.revision, idempotencyKey: input.idempotencyKey, payload: input.payload, submittedAtUtc: now, late: question.state === 'closed' };
      if (existing === undefined) this.database.prepare('INSERT INTO answer_current (id,question_id,student_id,revision,idempotency_key,payload_json,submitted_at_utc,late) VALUES (?,?,?,?,?,?,?,?)').run(answer.id, answer.questionId, answer.studentId, answer.revision, answer.idempotencyKey, JSON.stringify(answer.payload), answer.submittedAtUtc, Number(answer.late));
      else this.database.prepare('UPDATE answer_current SET revision=?,idempotency_key=?,payload_json=?,submitted_at_utc=?,late=? WHERE id=?').run(answer.revision, answer.idempotencyKey, JSON.stringify(answer.payload), answer.submittedAtUtc, Number(answer.late), answer.id);
      this.database.prepare('INSERT INTO answer_submission_idempotency (student_id,question_id,idempotency_key,request_fingerprint,answer_id,response_json,outcome_code,created_at_utc,expires_at_utc) VALUES (?,?,?,?,?,?,?,?,?)').run(context.studentId, input.questionId, input.idempotencyKey, input.requestFingerprint, answer.id, JSON.stringify(answer), 'ACCEPTED', now, new Date(new Date(now).getTime() + 86_400_000).toISOString());
      return answer;
    });
    return transaction();
  }

  closeQuestion(context: AuthorizedTeacherContext, questionId: QuestionId): QuestionResultSnapshot {
    void context;
    return this.database.transaction(() => {
      const question = this.row(questionId);
      if (question.state !== 'open') throw new Error('QUESTION_NOT_OPEN');
      const closedAtUtc = this.now() as IsoUtc;
      this.database.prepare('UPDATE questions SET state=\'closed\',closed_at_utc=?,updated_at_utc=? WHERE id=?').run(closedAtUtc, closedAtUtc, questionId);
      const students = this.database.prepare('SELECT id FROM students WHERE class_id=?').all(question.class_id) as readonly { id: string }[];
      const answers = this.database.prepare('SELECT id,student_id,revision,idempotency_key,payload_json,submitted_at_utc,late FROM answer_current WHERE question_id=?').all(questionId) as readonly AnswerRow[];
      const byStudent = new Map(answers.map((answer) => [answer.student_id, answer]));
      const insertClose = this.database.prepare('INSERT INTO answer_at_close (question_id,student_id,revision,submitted_at_utc,payload_json,no_answer,closed_at_utc) VALUES (?,?,?,?,?,?,?)');
      const counts: Record<string, number> = {};
      let shortTextResponseCount = 0;
      for (const student of students) {
        const answer = byStudent.get(student.id);
        if (answer === undefined) { insertClose.run(questionId, student.id, null, null, null, 1, closedAtUtc); continue; }
        const payload = JSON.parse(answer.payload_json) as AnswerPayload;
        insertClose.run(questionId, student.id, answer.revision, answer.submitted_at_utc, answer.payload_json, 0, closedAtUtc);
        if (payload.kind === 'short_text') shortTextResponseCount += 1;
        else for (const option of payload.selectedOptions ?? []) counts[option] = (counts[option] ?? 0) + 1;
      }
      const snapshot: QuestionResultSnapshot = { questionId, closedAtUtc, counts, shortTextResponseCount };
      this.database.prepare('INSERT INTO question_result_snapshots (question_id,closed_at_utc,counts_json,short_text_response_count) VALUES (?,?,?,?)').run(questionId, closedAtUtc, JSON.stringify(counts), shortTextResponseCount);
      return snapshot;
    })();
  }

  answerAtClose(questionId: QuestionId, studentId: StudentId): AnswerAtClose | undefined {
    const row = this.database.prepare('SELECT revision,submitted_at_utc,payload_json,no_answer,closed_at_utc FROM answer_at_close WHERE question_id=? AND student_id=?').get(questionId, studentId) as { revision: number | null; submitted_at_utc: string | null; payload_json: string | null; no_answer: number; closed_at_utc: string } | undefined;
    return row === undefined ? undefined : { questionId, studentId, revision: row.revision, submittedAtUtc: row.submitted_at_utc as IsoUtc | null, payload: row.payload_json === null ? null : JSON.parse(row.payload_json) as AnswerPayload, noAnswer: row.no_answer === 1, closedAtUtc: row.closed_at_utc as IsoUtc };
  }

  deleteAnswer(context: AuthorizedTeacherContext, questionId: QuestionId, studentId: StudentId, confirmation: { confirmed: true; impactAcknowledged: true }): void {
    void context;
    if (!confirmation.confirmed || !confirmation.impactAcknowledged) throw new Error('DELETE_CONFIRMATION_REQUIRED');
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM answer_current WHERE question_id=? AND student_id=?').run(questionId, studentId);
      this.database.prepare('DELETE FROM answer_at_close WHERE question_id=? AND student_id=?').run(questionId, studentId);
      this.database.prepare('INSERT INTO answer_deletion_markers (question_id,student_id,deleted_at_utc) VALUES (?,?,?) ON CONFLICT(question_id,student_id) DO UPDATE SET deleted_at_utc=excluded.deleted_at_utc').run(questionId, studentId, this.now());
    })();
  }

  createFileTask(context: AuthorizedTeacherContext, input: Readonly<{ id: FileSubmissionTaskId; classId: Question['classId']; title: string; description: string; deadlineAtUtc: string }>): void {
    void context;
    const now = this.now();
    this.database.prepare('INSERT INTO file_submission_tasks (id,class_id,title,description,state,max_bytes,deadline_at_utc,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES (?,?,?,?,\'draft\',100000000,?,NULL,NULL,?,?)').run(input.id, input.classId, input.title, input.description, input.deadlineAtUtc, now, now);
  }

  private row(questionId: QuestionId): QuestionRow {
    const row = this.database.prepare('SELECT id,class_id,template_id,kind,prompt,reference_answer,state,opened_at_utc,closed_at_utc FROM questions WHERE id=?').get(questionId) as QuestionRow | undefined;
    if (row === undefined) throw new Error('QUESTION_NOT_FOUND');
    return row;
  }

  private getQuestion(questionId: QuestionId): Question {
    const row = this.row(questionId);
    const options = this.database.prepare('SELECT option_key,label,ordinal FROM question_options WHERE question_id=? ORDER BY ordinal').all(questionId) as readonly { option_key: string; label: string; ordinal: number }[];
    return { id: row.id as QuestionId, classId: row.class_id as Question['classId'], templateId: row.template_id as Question['templateId'], kind: row.kind, prompt: row.prompt, options: options.map((option) => ({ key: option.option_key, label: option.label, ordinal: option.ordinal })), referenceAnswer: row.reference_answer, state: row.state, openedAtUtc: row.opened_at_utc as IsoUtc | null, closedAtUtc: row.closed_at_utc as IsoUtc | null };
  }
}

export class SqliteFileMetadataRepository implements FileMetadataRepository {
  constructor(private readonly database: SqliteDatabase, private readonly now: () => string = () => new Date().toISOString()) {}

  commitAfterFileRename(uploadSessionId: UploadSessionId): void {
    this.database.prepare("UPDATE upload_sessions SET state='metadata_committed',updated_at_utc=? WHERE id=? AND state='file_committed'").run(this.now(), uploadSessionId);
  }

  markRecoveryPending(uploadSessionId: UploadSessionId, errorCode: string): void {
    this.database.prepare("UPDATE upload_sessions SET state='recovery_pending',error_code=?,updated_at_utc=? WHERE id=? AND state='file_committed'").run(errorCode, this.now(), uploadSessionId);
  }
}
