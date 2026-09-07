import type { ClassId, QuestionId, QuestionKind, QuestionTemplateId } from '../domain/types.js';
import type { SqliteDatabase } from './connection.js';
import type { QuestionBankOption, QuestionBankRepository, QuestionDraftRecord, QuestionTemplateRecord, ReferenceAnswer } from '../questions/bank/types.js';

type TemplateRow = Readonly<{ id: string; kind: QuestionKind; prompt: string; reference_answer: string | null }>;
type DraftRow = Readonly<{ id: string; class_id: string; template_id: string | null; kind: QuestionKind; prompt: string; reference_answer: string | null; state: 'draft' }>;
type OptionRow = Readonly<{ option_key: string; label: string; ordinal: number }>;

/** A deliberately narrow adapter over the schema supplied by Task 2. No migration ownership leaks into Task 4. */
export class SqliteQuestionBankRepository implements QuestionBankRepository {
  constructor(private readonly database: SqliteDatabase, private readonly now: () => string = () => new Date().toISOString()) {}

  createTemplate(input: QuestionTemplateRecord): QuestionTemplateRecord {
    const now = this.now();
    this.database.transaction(() => {
      this.database.prepare('INSERT INTO question_templates (id,kind,prompt,reference_answer,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?)').run(input.id, input.kind, input.prompt, encodeAnswer(input.referenceAnswer), now, now);
      this.insertTemplateOptions(input.id, input.options);
    })();
    return required(this.getTemplate(input.id), 'QUESTION_TEMPLATE_NOT_FOUND');
  }
  getTemplate(id: QuestionTemplateId): QuestionTemplateRecord | undefined {
    const row = this.database.prepare('SELECT id,kind,prompt,reference_answer FROM question_templates WHERE id=?').get(id) as TemplateRow | undefined;
    return row === undefined ? undefined : { id: row.id as QuestionTemplateId, kind: row.kind, prompt: row.prompt, options: this.templateOptions(id), referenceAnswer: decodeAnswer(row.kind, row.reference_answer) };
  }
  listTemplates(): readonly QuestionTemplateRecord[] {
    const rows = this.database.prepare('SELECT id FROM question_templates ORDER BY created_at_utc,id').all() as readonly Readonly<{ id: string }>[];
    return rows.map((row) => required(this.getTemplate(row.id as QuestionTemplateId), 'QUESTION_TEMPLATE_NOT_FOUND'));
  }
  updateTemplate(id: QuestionTemplateId, input: Omit<QuestionTemplateRecord, 'id'>): QuestionTemplateRecord | undefined {
    const changed = this.database.transaction(() => {
      const now = this.now();
      const result = this.database.prepare('UPDATE question_templates SET kind=?,prompt=?,reference_answer=?,updated_at_utc=? WHERE id=?').run(input.kind, input.prompt, encodeAnswer(input.referenceAnswer), now, id);
      if (result.changes !== 1) return false;
      this.database.prepare('DELETE FROM question_template_options WHERE template_id=?').run(id);
      this.insertTemplateOptions(id, input.options);
      return true;
    })();
    return changed ? this.getTemplate(id) : undefined;
  }
  deleteTemplate(id: QuestionTemplateId): boolean {
    // Questions retain their independent prompt/options/reference fields. The FK's
    // ON DELETE SET NULL makes the former source explicit without mutating a draft.
    return this.database.prepare('DELETE FROM question_templates WHERE id=?').run(id).changes === 1;
  }
  createDraft(input: QuestionDraftRecord): QuestionDraftRecord {
    const now = this.now();
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO questions (id,class_id,template_id,kind,prompt,reference_answer,state,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?, 'draft',NULL,NULL,?,?)").run(input.id, input.classId, input.templateId, input.kind, input.prompt, encodeAnswer(input.referenceAnswer), now, now);
      this.insertDraftOptions(input.id, input.options);
    })();
    return required(this.getDraft(input.classId, input.id), 'QUESTION_DRAFT_NOT_FOUND');
  }
  getDraft(classId: ClassId, id: QuestionId): QuestionDraftRecord | undefined {
    const row = this.database.prepare("SELECT id,class_id,template_id,kind,prompt,reference_answer,state FROM questions WHERE id=? AND class_id=? AND state='draft'").get(id, classId) as DraftRow | undefined;
    return row === undefined ? undefined : { id: row.id as QuestionId, classId: row.class_id as ClassId, templateId: row.template_id as QuestionTemplateId | null, kind: row.kind, prompt: row.prompt, options: this.draftOptions(id), referenceAnswer: decodeAnswer(row.kind, row.reference_answer), state: 'draft' };
  }
  updateDraft(classId: ClassId, id: QuestionId, input: Omit<QuestionDraftRecord, 'id' | 'classId' | 'templateId' | 'state'>): QuestionDraftRecord | undefined {
    const changed = this.database.transaction(() => {
      const result = this.database.prepare("UPDATE questions SET kind=?,prompt=?,reference_answer=?,updated_at_utc=? WHERE id=? AND class_id=? AND state='draft'").run(input.kind, input.prompt, encodeAnswer(input.referenceAnswer), this.now(), id, classId);
      if (result.changes !== 1) return false;
      this.database.prepare('DELETE FROM question_options WHERE question_id=?').run(id);
      this.insertDraftOptions(id, input.options);
      return true;
    })();
    return changed ? this.getDraft(classId, id) : undefined;
  }

  private insertTemplateOptions(templateId: QuestionTemplateId, options: readonly QuestionBankOption[]): void {
    const insert = this.database.prepare('INSERT INTO question_template_options (id,template_id,option_key,label,ordinal) VALUES (?,?,?,?,?)');
    for (const option of options) insert.run(`${templateId}:${option.id}`, templateId, option.id, option.label, option.ordinal);
  }
  private insertDraftOptions(questionId: QuestionId, options: readonly QuestionBankOption[]): void {
    const insert = this.database.prepare('INSERT INTO question_options (id,question_id,option_key,label,ordinal) VALUES (?,?,?,?,?)');
    for (const option of options) insert.run(`${questionId}:${option.id}`, questionId, option.id, option.label, option.ordinal);
  }
  private templateOptions(id: QuestionTemplateId): readonly QuestionBankOption[] { return this.options('question_template_options', 'template_id', id); }
  private draftOptions(id: QuestionId): readonly QuestionBankOption[] { return this.options('question_options', 'question_id', id); }
  private options(table: 'question_template_options' | 'question_options', column: 'template_id' | 'question_id', id: string): readonly QuestionBankOption[] {
    const rows = this.database.prepare(`SELECT option_key,label,ordinal FROM ${table} WHERE ${column}=? ORDER BY ordinal`).all(id) as readonly OptionRow[];
    return rows.map((row) => ({ id: row.option_key, label: row.label, ordinal: row.ordinal }));
  }
}

function encodeAnswer(answer: ReferenceAnswer): string | null { return answer === null ? null : typeof answer === 'string' ? answer : JSON.stringify(answer); }
function decodeAnswer(kind: QuestionKind, value: string | null): ReferenceAnswer {
  if (value === null) return null;
  if (kind !== 'multiple_choice') return value;
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed as readonly string[] : []; } catch { return []; }
}
function required<T>(value: T | undefined, code: string): T { if (value === undefined) throw new Error(code); return value; }
