<script lang="ts">
  import type { AnswerPayload, StudentQuestion } from './types';
  import { displayAnswer, questionKindLabel } from '$lib/question-answer-display';

  let { view, onSubmit, pending = false }: { view: StudentQuestion; onSubmit: (payload: AnswerPayload) => void; pending?: boolean } = $props();
  let selected = $state<string[]>([]);
  let text = $state('');
  const question = $derived(view.question);
  const closed = $derived(question.state === 'closed');
  const submitted = $derived(view.answer?.payload);

  $effect(() => {
    selected = [...(view.answer?.payload.selectedOptions ?? [])];
    text = view.answer?.payload.text ?? '';
  });

  function toggle(key: string, checked: boolean): void {
    selected = checked ? [...selected, key] : selected.filter((value) => value !== key);
  }
  function submit(): void {
    if (question.kind === 'short_text') onSubmit({ kind: question.kind, text: text.trim() });
    else onSubmit({ kind: question.kind, selectedOptions: selected });
  }
</script>

<section aria-labelledby="question-title">
  <p class="eyebrow">{closed ? '題目已結束' : '進行中的題目'}</p>
  <h1 id="question-title">{question.prompt}</h1>
  {#if closed}
    <p class="status" role="status">此題已結束，答案不再接受。{view.answerAtClose?.noAnswer ? '結束時未收到你的答案。' : '已提交，以下是結束時保存的答案。'}</p>
    <p class="saved-answer">{displayAnswer(question, view.answerAtClose?.noAnswer ? undefined : view.answerAtClose?.payload)}</p>
  {:else}
    {#if submitted}<p class="status" role="status">已提交（{questionKindLabel(question.kind)}）：{displayAnswer(question, submitted)}。你可在題目結束前修改後再次送出。</p>{/if}
    <form onsubmit={(event) => { event.preventDefault(); submit(); }}>
      <fieldset disabled={pending}>
        <legend>請選擇或輸入你的答案</legend>
        {#if question.kind === 'short_text'}
          <label for="answer">答案</label>
          <textarea id="answer" bind:value={text} required maxlength="2000" rows="5"></textarea>
        {:else}
          {#each question.options as option}
            <label class="choice" for={`option-${option.key}`}>
              <input id={`option-${option.key}`} type={question.kind === 'single_choice' ? 'radio' : 'checkbox'} name="answer" value={option.key}
                checked={selected.includes(option.key)}
                onchange={(event) => question.kind === 'single_choice' ? selected = [option.key] : toggle(option.key, (event.currentTarget as HTMLInputElement).checked)} />
              {option.label}
            </label>
          {/each}
        {/if}
      </fieldset>
      <button type="submit">{pending ? '正在儲存…' : '送出答案'}</button>
    </form>
  {/if}
</section>

<style>
  section { max-width: 54rem; padding: clamp(1rem, 3vw, 1.6rem); background: #fff; border: 1px solid var(--color-surface-border); border-radius: var(--radius-card); box-shadow: var(--shadow-card); }
  .eyebrow { color: var(--color-primary-strong); font-weight: 800; }
  h1 { margin-top: .2rem; font-size: clamp(1.65rem, 4vw, 2.35rem); }
  fieldset { display: grid; gap: .75rem; min-width: 0; padding: 0; border: 0; }
  legend { margin-bottom: .8rem; color: #284846; font-weight: 750; }
  .choice { display: flex; align-items: center; gap: .8rem; min-height: 48px; padding: .65rem .8rem; background: #fbfdfc; border: 1px solid var(--color-border); border-radius: .75rem; cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease; }
  .choice:hover { background: var(--color-primary-soft); border-color: #94c4bc; }
  .choice input { flex: none; width: 1.2rem; min-height: 1.2rem; height: 1.2rem; margin: 0; accent-color: var(--color-primary); }
  textarea { min-height: 9rem; }
  form > button { min-width: 10rem; margin-top: .45rem; }
  .status { padding: .85rem 1rem; color: #1b514d; background: var(--color-primary-soft); border-left: 4px solid var(--color-primary); border-radius: .55rem; }
  .saved-answer { padding: .85rem; color: #354b49; background: var(--color-surface-muted); border-radius: .65rem; overflow-wrap: anywhere; white-space: pre-wrap; }
</style>
