import type { ClassId, QuestionId, QuestionKind, QuestionTemplateId } from '../../domain/types.js';

export type QuestionBankOption = Readonly<{ id: string; label: string; ordinal: number }>;
export type ReferenceAnswer = string | readonly string[] | null;
export type QuestionTemplateRecord = Readonly<{
  id: QuestionTemplateId;
  kind: QuestionKind;
  prompt: string;
  options: readonly QuestionBankOption[];
  referenceAnswer: ReferenceAnswer;
}>;
export type QuestionDraftRecord = Readonly<{
  id: QuestionId;
  classId: ClassId;
  templateId: QuestionTemplateId | null;
  kind: QuestionKind;
  prompt: string;
  options: readonly QuestionBankOption[];
  referenceAnswer: ReferenceAnswer;
  state: 'draft';
}>;

export type TemplateInput = Readonly<{
  kind: QuestionKind;
  prompt: string;
  options?: readonly Readonly<{ id?: string; label: string }>[];
  referenceAnswer?: unknown;
}>;

export interface QuestionBankRepository {
  createTemplate(input: QuestionTemplateRecord): QuestionTemplateRecord;
  getTemplate(id: QuestionTemplateId): QuestionTemplateRecord | undefined;
  listTemplates(): readonly QuestionTemplateRecord[];
  updateTemplate(id: QuestionTemplateId, input: Omit<QuestionTemplateRecord, 'id'>): QuestionTemplateRecord | undefined;
  /** Existing question rows keep their copied fields; SQLite then sets template_id to NULL. */
  deleteTemplate(id: QuestionTemplateId): boolean;
  createDraft(input: QuestionDraftRecord): QuestionDraftRecord;
  getDraft(classId: ClassId, id: QuestionId): QuestionDraftRecord | undefined;
  updateDraft(classId: ClassId, id: QuestionId, input: Omit<QuestionDraftRecord, 'id' | 'classId' | 'templateId' | 'state'>): QuestionDraftRecord | undefined;
}

export interface TeacherAuthorizationPort { assertAuthorized(context: unknown): void; }
