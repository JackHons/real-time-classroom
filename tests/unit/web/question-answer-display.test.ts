import { describe, expect, it } from 'vitest';
import { displayAnswer, questionKindLabel } from '../../../apps/web/src/lib/question-answer-display.js';

const choiceQuestion = { kind: 'single_choice' as const, options: [{ key: 'opaque-option-id', label: '王小明' }] };

describe('question answer display', () => {
  it('renders choice labels, never storage option ids', () => {
    expect(displayAnswer(choiceQuestion, { kind: 'single_choice', selectedOptions: ['opaque-option-id'] })).toBe('單選：王小明');
    expect(displayAnswer({ ...choiceQuestion, kind: 'multiple_choice' as const }, { kind: 'multiple_choice', selectedOptions: ['opaque-option-id'] })).toBe('複選：王小明');
  });

  it('renders saved short text and the distinct no-answer state', () => {
    expect(displayAnswer({ kind: 'short_text', options: [] }, { kind: 'short_text', text: '  我的答案  ' })).toBe('短答：我的答案');
    expect(displayAnswer(choiceQuestion, undefined)).toBe('未作答');
    expect(questionKindLabel('short_text')).toBe('短答題');
  });
});
