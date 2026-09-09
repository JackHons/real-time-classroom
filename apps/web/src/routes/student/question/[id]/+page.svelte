<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import QuestionAnswer from '$lib/student/QuestionAnswer.svelte';
  import { isSessionExpired, studentApi } from '$lib/student/api';
  import { createAnswerQueue, flushAnswers, type AnswerQueue } from '$lib/student/answer-queue';
  import type { AnswerPayload, QueuedAnswer, StudentQuestion } from '$lib/student/types';

  let queue: AnswerQueue | undefined;
  let view: StudentQuestion | undefined;
  let state: 'loading' | 'ready' | 'saving' | 'queued' | 'closed' | 'session-expired' | 'error' = 'loading';
  let notice = '';
  let mounted = false;
  let refreshInFlight = false;
  let generation = 0;
  let refreshController: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const questionId = page.params.id ?? '';

  async function expireSession(): Promise<void> {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = undefined;
    refreshController?.abort();
    await queue?.discard();
    queue = undefined;
    await studentApi.endSession();
    state = 'session-expired';
    notice = '登入已失效，為保護你的資料，本機未同步答案已捨棄。請回到學生首頁重新加入課堂。';
  }

  async function refresh(): Promise<StudentQuestion | undefined> {
    if (refreshInFlight) return view;
    refreshInFlight = true;
    const currentGeneration = generation;
    const controller = new AbortController();
    refreshController = controller;
    try {
      const latest = await studentApi.readQuestion(fetch, questionId, controller.signal);
      if (!mounted || currentGeneration !== generation) return undefined;
      view = latest;
      if (latest.question.state === 'closed') state = 'closed';
      return latest;
    } finally {
      if (refreshController === controller) refreshController = undefined;
      refreshInFlight = false;
    }
  }
  async function sync(answer: QueuedAnswer): Promise<void> {
    const latest = await refresh();
    if (latest === undefined || latest.question.state === 'closed') return;
    await studentApi.submitAnswer(fetch, answer.questionId, latest.answer?.revision ?? answer.revision, answer.payload, answer.idempotencyKey);
  }
  async function reconnect(): Promise<void> {
    try {
      if (queue === undefined) return;
      await flushAnswers(queue, sync);
      if (state !== 'closed') { state = 'ready'; notice = '未同步的答案已重新送出。'; }
    } catch (error) {
      if (isSessionExpired(error)) await expireSession();
      else notice = '仍未能同步答案；答案安全保留在此裝置。';
    }
  }
  async function poll(): Promise<void> {
    try { await refresh(); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (isSessionExpired(error)) { await expireSession(); return; }
      if (mounted) notice = '更新題目狀態失敗，請檢查網路後按「重新整理」。';
    }
  }
  onMount(() => {
    mounted = true;
    const online = () => { void reconnect(); };
    window.addEventListener('online', online);
    void (async () => {
      try {
        const session = await studentApi.restoreSession();
        if (session === undefined) { state = 'session-expired'; notice = '登入已失效，請回到學生首頁重新加入課堂。'; return; }
        queue = createAnswerQueue(session.queueOwner);
        await refresh(); if (state !== 'closed') state = 'ready'; await reconnect();
        refreshTimer = setInterval(() => { void poll(); }, 15_000);
      } catch (error) {
        if (isSessionExpired(error)) await expireSession();
        else { state = 'error'; notice = '無法讀取題目，請檢查網路後按「重新整理」。'; }
      }
    })();
    return () => { mounted = false; generation += 1; refreshController?.abort(); if (refreshTimer !== undefined) clearInterval(refreshTimer); window.removeEventListener('online', online); };
  });
  async function submit(payload: AnswerPayload): Promise<void> {
    if (!view) return;
    state = 'saving';
    const queued: QueuedAnswer = { id: crypto.randomUUID(), questionId, revision: view.answer?.revision ?? 0, idempotencyKey: crypto.randomUUID(), payload, createdAt: Date.now() };
    try {
      await studentApi.submitAnswer(fetch, queued.questionId, queued.revision, queued.payload, queued.idempotencyKey);
      await refresh(); state = 'ready'; notice = '答案已送出。';
    } catch (error) {
      if (isSessionExpired(error)) { await expireSession(); return; }
      if (queue === undefined) { state = 'session-expired'; notice = '登入已失效，無法安全儲存答案；請重新登入後再試。'; return; }
      const maintenance = await queue.put(queued); state = 'queued';
      notice = maintenance.storagePressure
        ? '目前離線或送出失敗；答案已安全保留。此裝置累積許多未同步答案，請恢復連線後重新送出或明確捨棄不需要的答案。'
        : '目前離線或送出失敗；答案只保存在這台裝置的目前登入階段，恢復連線後會自動送出。';
    }
  }
</script>

<svelte:head><title>回答題目｜LAN 課堂互動平台</title></svelte:head>
<main>
  <a class="skip" href="#content">跳到主要內容</a>
  <div id="content" aria-live="polite" class="notice">{notice}</div>
  {#if view}<QuestionAnswer {view} onSubmit={submit} pending={state === 'saving'} />
  {#if state === 'queued'}<button class="discard" onclick={() => void (async () => { await queue?.discard(); state = 'ready'; notice = '本機未同步答案已捨棄。'; })()}>捨棄本機未同步答案</button>{/if}
  {:else if state === 'loading'}<p role="status">正在讀取題目…</p>
  {:else}<button onclick={() => void poll()}>重新整理</button>{/if}
</main>

<style>
  main { max-width: 48rem; margin: auto; padding: 1rem; color: #172554; font: 1rem/1.55 system-ui, sans-serif; }
  .notice { min-height: 1.5rem; color: #075985; font-weight: 600; }
  button { min-height: 44px; padding: .6rem 1rem; color: white; background: #075985; border: 0; border-radius: .4rem; font: inherit; }
  .discard { display: block; margin-top: .75rem; background: #991b1b; }
  :focus-visible { outline: 3px solid #f59e0b; outline-offset: 2px; }
  .skip { position: absolute; left: -999px; } .skip:focus { left: 1rem; top: 1rem; background:white; padding:.5rem; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
