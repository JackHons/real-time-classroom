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
  .eyebrow { color: #075985; font-weight: 700; }
  h1 { font-size: clamp(1.5rem, 4vw, 2.2rem); }
  fieldset { border: 0; padding: 0; display: grid; gap: .75rem; }
  legend { font-weight: 700; margin-bottom: .75rem; }
  .choice { display: flex; align-items: center; gap: .75rem; min-height: 44px; padding: .5rem; border: 1px solid #64748b; border-radius: .5rem; }
  textarea { width: 100%; font: inherit; border: 2px solid #475569; border-radius: .4rem; padding: .65rem; }
  button { min-height: 44px; margin-top: 1rem; padding: .65rem 1rem; background: #075985; color: white; border: 0; border-radius: .4rem; font: inherit; font-weight: 700; }
  button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 3px solid #f59e0b; outline-offset: 2px; }
  .status { background: #e0f2fe; padding: .8rem; border-left: 4px solid #0369a1; }
  .saved-answer { padding: .75rem; background: #f1f5f9; border-radius: .4rem; overflow-wrap: anywhere; }
</style>
