import { describe, expect, it } from 'vitest';
import { QuestionBankService } from '../../../../apps/server/src/questions/bank/service.js';
import type { QuestionBankRepository, QuestionDraftRecord, QuestionTemplateRecord } from '../../../../apps/server/src/questions/bank/types.js';

function setup() {
  const templates = new Map<string, QuestionTemplateRecord>(); const drafts = new Map<string, QuestionDraftRecord>(); let id = 0;
  const repository: QuestionBankRepository = {
    createTemplate: (value) => { templates.set(value.id, value); return value; }, getTemplate: (id) => templates.get(id), listTemplates: () => [...templates.values()],
    updateTemplate: (id, value) => { const found = templates.get(id); if (found === undefined) return undefined; const next = { id, ...value }; templates.set(id, next); return next; }, deleteTemplate: (id) => templates.delete(id),
    createDraft: (value) => { drafts.set(value.id, value); return value; }, getDraft: (classId, id) => { const found = drafts.get(id); return found?.classId === classId ? found : undefined; },
    updateDraft: (classId, id, value) => { const found = drafts.get(id); if (found === undefined || found.classId !== classId) return undefined; const next = { ...found, ...value }; drafts.set(id, next); return next; }
  };
  return { templates, drafts, service: new QuestionBankService({ repository, teacherAuthorization: { assertAuthorized: (context) => { if (context !== 'teacher') throw new Error('TEACHER_AUTH_REQUIRED'); } }, createTemplateId: () => `template-${++id}` as never, createQuestionId: () => `draft-${++id}` as never, createOptionId: () => `option-${++id}` }) };
}

describe('question bank service', () => {
  it('normalizes input, preserves option identifiers during a reorder, and snapshots a template into a draft', () => {
    const { service } = setup();
    const template = service.createTemplate('teacher', { kind: 'multiple_choice', prompt: '  Ｐｉｃｋ  ', options: [{ label: ' A ' }, { label: 'Ｂ' }], referenceAnswer: ['option-1'] });
    expect(template).toMatchObject({ prompt: 'Pick', options: [{ id: 'option-1', label: 'A', ordinal: 0 }, { id: 'option-2', label: 'B', ordinal: 1 }] });
    const updated = service.updateTemplate('teacher', template.id, { kind: 'multiple_choice', prompt: 'Changed', options: [{ id: 'option-2', label: 'Second' }, { id: 'option-1', label: 'First' }], referenceAnswer: ['option-2'] });
    expect(updated.options.map((option) => option.id)).toEqual(['option-2', 'option-1']);
    const draft = service.createDraft('teacher', 'class-1' as never, { templateId: template.id });
    service.updateTemplate('teacher', template.id, { kind: 'multiple_choice', prompt: 'Later template edit', options: [{ id: 'option-2', label: 'Later' }, { id: 'option-1', label: 'First' }], referenceAnswer: ['option-2'] });
    expect(service.getDraft('teacher', 'class-1' as never, draft.id)).toMatchObject({ prompt: 'Changed', options: [{ label: 'Second' }, { label: 'First' }] });
  });

  it('rejects unauthorized and malformed or option-id-substitution writes', () => {
    const { service } = setup();
    expect(() => service.createTemplate('student', { kind: 'short_text', prompt: 'x' })).toThrow('TEACHER_AUTH_REQUIRED');
    expect(() => service.createTemplate('teacher', { kind: 'single_choice', prompt: 'x', options: [{ label: 'only one' }] })).toThrow('QUESTION_OPTIONS_INVALID');
    const template = service.createTemplate('teacher', { kind: 'single_choice', prompt: 'x', options: [{ label: 'a' }, { label: 'b' }], referenceAnswer: 'option-1' });
    expect(() => service.updateTemplate('teacher', template.id, { kind: 'single_choice', prompt: 'x', options: [{ id: 'attacker-controlled', label: 'a' }, { id: 'option-2', label: 'b' }], referenceAnswer: 'option-2' })).toThrow('QUESTION_OPTION_ID_INVALID');
    expect(() => service.createTemplate('teacher', { kind: 'short_text', prompt: 'x', options: [{ label: 'not allowed' }] })).toThrow('QUESTION_OPTIONS_FORBIDDEN');
  });
});
