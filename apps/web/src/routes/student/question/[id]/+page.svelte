<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import QuestionAnswer from '$lib/student/QuestionAnswer.svelte';
  import { studentApi } from '$lib/student/api';
  import { createAnswerQueue, flushAnswers } from '$lib/student/answer-queue';
  import type { AnswerPayload, QueuedAnswer, StudentQuestion } from '$lib/student/types';

  const queue = createAnswerQueue();
  let view = $state<StudentQuestion | undefined>();
  let state = $state<'loading' | 'ready' | 'saving' | 'queued' | 'closed' | 'error'>('loading');
  let notice = $state('');
  const questionId = $derived(page.params.id);

  async function refresh(): Promise<StudentQuestion> {
    const latest = await studentApi.readQuestion(fetch, questionId);
    view = latest;
    if (latest.question.state === 'closed') state = 'closed';
    return latest;
  }
  async function sync(answer: QueuedAnswer): Promise<void> {
    const latest = await refresh();
    if (latest.question.state === 'closed') return;
    await studentApi.submitAnswer(fetch, answer.questionId, latest.answer?.revision ?? answer.revision, answer.payload, answer.idempotencyKey);
  }
  async function reconnect(): Promise<void> {
    try {
      await flushAnswers(queue, sync);
      if (state !== 'closed') { state = 'ready'; notice = '未同步的答案已重新送出。'; }
    } catch { notice = '仍未能同步答案；答案安全保留在此裝置。'; }
  }
  onMount(() => {
    window.addEventListener('online', reconnect);
    void (async () => {
      try { await refresh(); if (state !== 'closed') state = 'ready'; await reconnect(); }
      catch { state = 'error'; notice = '無法讀取題目，請檢查網路後重試。'; }
    })();
    return () => window.removeEventListener('online', reconnect);
  });
  async function submit(payload: AnswerPayload): Promise<void> {
    if (!view) return;
    state = 'saving';
    const queued: QueuedAnswer = { id: crypto.randomUUID(), questionId, revision: view.answer?.revision ?? 0, idempotencyKey: crypto.randomUUID(), payload, createdAt: Date.now() };
    try {
      await studentApi.submitAnswer(fetch, queued.questionId, queued.revision, queued.payload, queued.idempotencyKey);
      await refresh(); state = 'ready'; notice = '答案已送出。';
    } catch {
      await queue.put(queued); state = 'queued'; notice = '目前離線或送出失敗；答案只保存在這台裝置，恢復連線後會自動送出。';
    }
  }
</script>

<svelte:head><title>回答題目｜LAN 課堂互動平台</title></svelte:head>
<main>
  <a class="skip" href="#content">跳到主要內容</a>
  <div id="content" aria-live="polite" class="notice">{notice}</div>
  {#if view}<QuestionAnswer {view} onSubmit={submit} pending={state === 'saving'} />
  {:else if state === 'loading'}<p role="status">正在讀取題目…</p>
  {:else}<button onclick={() => location.reload()}>重新載入</button>{/if}
</main>

<style>
  main { max-width: 48rem; margin: auto; padding: 1rem; color: #172554; font: 1rem/1.55 system-ui, sans-serif; }
  .notice { min-height: 1.5rem; color: #075985; font-weight: 600; }
  button { min-height: 44px; padding: .6rem 1rem; color: white; background: #075985; border: 0; border-radius: .4rem; font: inherit; }
  :focus-visible { outline: 3px solid #f59e0b; outline-offset: 2px; }
  .skip { position: absolute; left: -999px; } .skip:focus { left: 1rem; top: 1rem; background:white; padding:.5rem; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
