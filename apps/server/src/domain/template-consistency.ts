import type { QuestionTemplate } from './types.js';

type TemplateOptionInput = Readonly<{ key: string; label: string }>;

export type QuestionTemplateSnapshotInput = Readonly<{
  kind: QuestionTemplate['kind'];
  prompt: string;
  options: readonly TemplateOptionInput[];
  referenceAnswer?: string | null;
}>;

/**
 * A template-backed question is an immutable copy of its source at creation.
 * Keeping the input exact prevents a template ID from being attached to an
 * unrelated prompt or option set.
 */
export function assertTemplateSnapshotMatches(template: QuestionTemplate, input: QuestionTemplateSnapshotInput): void {
  const referenceAnswer = input.referenceAnswer ?? null;
  const optionsMatch = template.options.length === input.options.length
    && template.options.every((option, index) => option.ordinal === index
      && option.key === input.options[index]?.key
      && option.label === input.options[index]?.label);
  if (template.kind !== input.kind || template.prompt !== input.prompt || template.referenceAnswer !== referenceAnswer || !optionsMatch) {
    throw new Error('QUESTION_TEMPLATE_SNAPSHOT_MISMATCH');
  }
}
