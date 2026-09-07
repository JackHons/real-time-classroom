import { describe, expect, it } from 'vitest';
import { assertTemplateSnapshotMatches } from '../../../apps/server/src/domain/template-consistency.js';
import type { QuestionTemplate } from '../../../apps/server/src/domain/types.js';

const template: QuestionTemplate = {
  id: 'template-1' as QuestionTemplate['id'],
  kind: 'single_choice',
  prompt: 'Pick one',
  options: [{ key: 'a', label: 'Alpha', ordinal: 0 }, { key: 'b', label: 'Beta', ordinal: 1 }],
  referenceAnswer: 'a'
};

describe('template-backed question snapshots', () => {
  it('accepts the exact persisted template snapshot', () => {
    expect(() => assertTemplateSnapshotMatches(template, { kind: 'single_choice', prompt: 'Pick one', options: [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }], referenceAnswer: 'a' })).not.toThrow();
  });

  it('rejects template IDs paired with altered options', () => {
    expect(() => assertTemplateSnapshotMatches(template, { kind: 'single_choice', prompt: 'Pick one', options: [{ key: 'a', label: 'Changed' }, { key: 'b', label: 'Beta' }], referenceAnswer: 'a' })).toThrow('QUESTION_TEMPLATE_SNAPSHOT_MISMATCH');
  });
});
