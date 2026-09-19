type QuestionOption = Readonly<{ key: string; label: string }>;
type QuestionForDisplay = Readonly<{ kind: 'single_choice' | 'multiple_choice' | 'short_text'; options: readonly QuestionOption[] }>;
type Payload = Readonly<{ kind: QuestionForDisplay['kind']; selectedOptions?: readonly string[]; text?: string }>;

/** Present saved answers to people; option keys are implementation details. */
export function displayAnswer(question: QuestionForDisplay, payload: Payload | null | undefined): string {
  if (payload === null || payload === undefined) return '未作答';
  if (payload.kind === 'short_text') return `短答：${payload.text?.trim() || '（空白）'}`;
  const labels = (payload.selectedOptions ?? []).map((key) => question.options.find((option) => option.key === key)?.label ?? '（已不存在的選項）');
  const prefix = payload.kind === 'single_choice' ? '單選' : '複選';
  return `${prefix}：${labels.length === 0 ? '（未選擇）' : labels.join('、')}`;
}

export function questionKindLabel(kind: QuestionForDisplay['kind']): string {
  return kind === 'single_choice' ? '單選題' : kind === 'multiple_choice' ? '複選題' : '短答題';
}
