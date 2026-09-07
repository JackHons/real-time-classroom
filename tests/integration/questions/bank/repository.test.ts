import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite, type SqliteDatabase } from '../../../../apps/server/src/db/connection.js';
import { migrate } from '../../../../apps/server/src/db/migrator.js';
import { SqliteQuestionBankRepository } from '../../../../apps/server/src/db/question-bank-repository.js';
import { QuestionBankService } from '../../../../apps/server/src/questions/bank/service.js';

let database: SqliteDatabase | undefined;
function setup(): QuestionBankService {
  database = openSqlite(':memory:'); migrate(database); let id = 0;
  database.prepare('INSERT INTO classes (id,name,created_at_utc,updated_at_utc) VALUES (?,?,?,?)').run('class-1', '1A', 'now', 'now');
  return new QuestionBankService({ repository: new SqliteQuestionBankRepository(database, () => '2026-09-07T00:00:00.000Z'), teacherAuthorization: { assertAuthorized: (value) => { if (value !== 'teacher') throw new Error('TEACHER_AUTH_REQUIRED'); } }, createTemplateId: () => `template-${++id}` as never, createQuestionId: () => `draft-${++id}` as never, createOptionId: () => `option-${++id}` });
}
afterEach(() => { database?.close(); database = undefined; });

describe('SQLite question bank adapter', () => {
  it('keeps persisted draft snapshots when a template is edited or deleted', () => {
    const service = setup();
    const template = service.createTemplate('teacher', { kind: 'single_choice', prompt: 'Original', options: [{ label: 'A' }, { label: 'B' }], referenceAnswer: 'option-1' });
    const draft = service.createDraft('teacher', 'class-1' as never, { templateId: template.id });
    service.updateTemplate('teacher', template.id, { kind: 'single_choice', prompt: 'Edited source', options: [{ id: 'option-1', label: 'Changed' }, { id: 'option-2', label: 'B' }], referenceAnswer: 'option-1' });
    expect(service.getDraft('teacher', 'class-1' as never, draft.id)).toMatchObject({ templateId: template.id, prompt: 'Original', options: [{ label: 'A' }, { label: 'B' }] });
    service.deleteTemplate('teacher', template.id);
    expect(service.getDraft('teacher', 'class-1' as never, draft.id)).toMatchObject({ templateId: null, prompt: 'Original', options: [{ label: 'A' }, { label: 'B' }] });
  });

  it('uses class-scoped lookups and rolls back an invalid template option write', () => {
    const service = setup();
    const draft = service.createDraft('teacher', 'class-1' as never, { question: { kind: 'short_text', prompt: 'Why?', referenceAnswer: 'Because' } });
    expect(() => service.getDraft('teacher', 'other-class' as never, draft.id)).toThrow('QUESTION_DRAFT_NOT_FOUND');
    expect(() => database?.prepare('INSERT INTO question_template_options (id,template_id,option_key,label,ordinal) VALUES (?,?,?,?,?)').run('bad', 'missing', 'x', 'x', 0)).toThrow();
    expect(database?.prepare('SELECT count(*) AS count FROM question_template_options').get()).toEqual({ count: 0 });
  });
});
