import { randomUUID } from 'node:crypto';
import type { ClassId, QuestionId, QuestionKind, QuestionTemplateId } from '../../domain/types.js';
import type { QuestionBankOption, QuestionBankRepository, QuestionDraftRecord, QuestionTemplateRecord, TeacherAuthorizationPort, TemplateInput } from './types.js';

const MAX_PROMPT_LENGTH = 2_000;
const MAX_OPTION_LABEL_LENGTH = 500;
const MAX_SHORT_ANSWER_LENGTH = 2_000;
const MAX_OPTIONS = 20;

export type QuestionBankServiceDependencies = Readonly<{
  repository: QuestionBankRepository;
  teacherAuthorization: TeacherAuthorizationPort;
  createTemplateId?: () => QuestionTemplateId;
  createQuestionId?: () => QuestionId;
  createOptionId?: () => string;
}>;

/** Teacher-only command boundary. It deliberately works with snapshots, not live template references. */
export class QuestionBankService {
  private readonly createTemplateId: () => QuestionTemplateId;
  private readonly createQuestionId: () => QuestionId;
  private readonly createOptionId: () => string;

  constructor(private readonly dependencies: QuestionBankServiceDependencies) {
    this.createTemplateId = dependencies.createTemplateId ?? (() => randomUUID() as QuestionTemplateId);
    this.createQuestionId = dependencies.createQuestionId ?? (() => randomUUID() as QuestionId);
    this.createOptionId = dependencies.createOptionId ?? randomUUID;
  }

  listTemplates(context: unknown): readonly QuestionTemplateRecord[] { this.authorize(context); return this.dependencies.repository.listTemplates(); }
  getTemplate(context: unknown, id: QuestionTemplateId): QuestionTemplateRecord {
    this.authorize(context);
    return this.dependencies.repository.getTemplate(id) ?? fail('QUESTION_TEMPLATE_NOT_FOUND');
  }
  createTemplate(context: unknown, input: TemplateInput): QuestionTemplateRecord {
    this.authorize(context);
    const fields = this.validate(input);
    return this.dependencies.repository.createTemplate({ id: this.createTemplateId(), ...fields });
  }
  updateTemplate(context: unknown, id: QuestionTemplateId, input: TemplateInput): QuestionTemplateRecord {
    this.authorize(context);
    const current = this.dependencies.repository.getTemplate(id) ?? fail('QUESTION_TEMPLATE_NOT_FOUND');
    // Existing option ids are immutable. Reordering is represented solely by ordinal;
    // callers cannot replace an option id and silently alter a saved answer meaning.
    return this.dependencies.repository.updateTemplate(id, this.validate(input, current.options)) ?? fail('QUESTION_TEMPLATE_NOT_FOUND');
  }
  deleteTemplate(context: unknown, id: QuestionTemplateId): void {
    this.authorize(context);
    if (!this.dependencies.repository.deleteTemplate(id)) fail('QUESTION_TEMPLATE_NOT_FOUND');
  }
  createDraft(context: unknown, classId: ClassId, input: Readonly<{ templateId?: string; question?: TemplateInput }>): QuestionDraftRecord {
    this.authorize(context);
    if (input.templateId !== undefined && input.question !== undefined) fail('QUESTION_DRAFT_INVALID');
    const source = input.templateId === undefined
      ? this.validate(requireValue(input.question, 'QUESTION_DRAFT_REQUIRED'))
      : this.snapshot(this.dependencies.repository.getTemplate(input.templateId as QuestionTemplateId) ?? fail('QUESTION_TEMPLATE_NOT_FOUND'));
    return this.dependencies.repository.createDraft({ id: this.createQuestionId(), classId, templateId: (input.templateId as QuestionTemplateId | undefined) ?? null, ...source, state: 'draft' });
  }
  getDraft(context: unknown, classId: ClassId, id: QuestionId): QuestionDraftRecord {
    this.authorize(context);
    return this.dependencies.repository.getDraft(classId, id) ?? fail('QUESTION_DRAFT_NOT_FOUND');
  }
  updateDraft(context: unknown, classId: ClassId, id: QuestionId, input: TemplateInput): QuestionDraftRecord {
    this.authorize(context);
    const current = this.dependencies.repository.getDraft(classId, id) ?? fail('QUESTION_DRAFT_NOT_FOUND');
    return this.dependencies.repository.updateDraft(classId, id, this.validate(input, current.options)) ?? fail('QUESTION_DRAFT_NOT_FOUND');
  }

  private authorize(context: unknown): void { this.dependencies.teacherAuthorization.assertAuthorized(context); }
  private snapshot(template: QuestionTemplateRecord): Omit<QuestionDraftRecord, 'id' | 'classId' | 'templateId' | 'state'> {
    return { kind: template.kind, prompt: template.prompt, options: template.options.map((option) => ({ ...option })), referenceAnswer: copyAnswer(template.referenceAnswer) };
  }
  private validate(input: TemplateInput, existing: readonly QuestionBankOption[] = []): Omit<QuestionTemplateRecord, 'id'> {
    if (!isRecord(input) || !isKind(input.kind)) fail('QUESTION_KIND_INVALID');
    const prompt = normalizedText(input.prompt, MAX_PROMPT_LENGTH, 'QUESTION_PROMPT');
    const options = validateOptions(input.kind, input.options, existing, this.createOptionId);
    return { kind: input.kind, prompt, options, referenceAnswer: validateReferenceAnswer(input.kind, input.referenceAnswer, options) };
  }
}

function validateOptions(kind: QuestionKind, raw: TemplateInput['options'], existing: readonly QuestionBankOption[], createId: () => string): readonly QuestionBankOption[] {
  if (kind === 'short_text') {
    if (raw !== undefined && raw.length !== 0) fail('QUESTION_OPTIONS_FORBIDDEN');
    return [];
  }
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_OPTIONS) fail('QUESTION_OPTIONS_INVALID');
  const existingIds = new Set(existing.map((option) => option.id));
  const used = new Set<string>();
  return raw.map((option, ordinal) => {
    if (!isRecord(option) || typeof option.label !== 'string' || (option.id !== undefined && typeof option.id !== 'string')) fail('QUESTION_OPTION_INVALID');
    const id = option.id === undefined ? createId() : normalizedId(option.id);
    if ((option.id !== undefined && !existingIds.has(id)) || used.has(id)) fail('QUESTION_OPTION_ID_INVALID');
    used.add(id);
    return { id, label: normalizedText(option.label, MAX_OPTION_LABEL_LENGTH, 'QUESTION_OPTION_LABEL'), ordinal };
  });
}

function validateReferenceAnswer(kind: QuestionKind, raw: unknown, options: readonly QuestionBankOption[]): string | readonly string[] | null {
  if (raw === undefined || raw === null) return null;
  if (kind === 'short_text') {
    if (typeof raw !== 'string') fail('QUESTION_REFERENCE_ANSWER_INVALID');
    return normalizedText(raw, MAX_SHORT_ANSWER_LENGTH, 'QUESTION_REFERENCE_ANSWER');
  }
  const ids = new Set(options.map((option) => option.id));
  if (kind === 'single_choice') {
    if (typeof raw !== 'string' || !ids.has(raw)) fail('QUESTION_REFERENCE_ANSWER_INVALID');
    return raw;
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((value) => typeof value !== 'string') || new Set(raw).size !== raw.length || raw.some((value) => !ids.has(value))) fail('QUESTION_REFERENCE_ANSWER_INVALID');
  return [...raw] as readonly string[];
}

function normalizedText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== 'string') fail(`${code}_REQUIRED`);
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length === 0 || normalized.length > maximum) fail(`${code}_INVALID`);
  return normalized;
}
function normalizedId(value: string): string { const normalized = value.normalize('NFKC').trim(); if (normalized.length === 0 || normalized.length > 128) fail('QUESTION_OPTION_ID_INVALID'); return normalized; }
function isKind(value: unknown): value is QuestionKind { return value === 'single_choice' || value === 'multiple_choice' || value === 'short_text'; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function requireValue<T>(value: T | undefined, code: string): T { return value ?? fail(code); }
function copyAnswer(answer: string | readonly string[] | null): string | readonly string[] | null { return Array.isArray(answer) ? [...answer] : answer; }
function fail(code: string): never { throw new Error(code); }
