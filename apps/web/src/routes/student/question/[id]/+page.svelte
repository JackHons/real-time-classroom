<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { RealtimeClient, type RealtimeStatus } from '$lib/realtime/client';
  import QuestionAnswer from '$lib/student/QuestionAnswer.svelte';
  import StudentShell from '$lib/student/StudentShell.svelte';
  import { isSessionExpired, studentApi } from '$lib/student/api';
  import { createAnswerQueue, flushAnswers, type AnswerQueue } from '$lib/student/answer-queue';
  import type { AnswerPayload, QueuedAnswer, StudentQuestion } from '$lib/student/types';

  let queue: AnswerQueue | undefined;
  let queueOwner = '';
  let view: StudentQuestion | undefined;
  let state: 'loading' | 'ready' | 'saving' | 'queued' | 'closed' | 'session-expired' | 'error' = 'loading';
  let notice = '';
  let mounted = false;
  let refreshInFlight = false;
  let generation = 0;
  let refreshController: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let realtime: RealtimeClient | undefined;
  let realtimeStatus: RealtimeStatus | undefined;
  const questionId = page.params.id ?? '';

  async function expireSession(): Promise<void> {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = undefined;
    refreshController?.abort();
    realtime?.stop();
    realtime = undefined;
    await queue?.discard();
    queue = undefined;
    queueOwner = '';
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
  /** A queue is replayed only after cookie session + REST both confirm it is open. */
  async function resyncAfterRealtime(): Promise<void> {
    const session = await studentApi.restoreSession();
    if (session === undefined) { await expireSession(); return; }
    if (session.queueOwner !== queueOwner) { await expireSession(); return; }
    const latest = await refresh();
    if (latest?.question.state === 'open') await reconnect();
  }
  function startRealtime(): void {
    realtime?.stop();
    realtime = new RealtimeClient({
      resources: ['question'],
      resync: resyncAfterRealtime,
      onStatus: (status) => { if (mounted) realtimeStatus = status; }
    });
    realtime.start();
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
    const online = () => { void resyncAfterRealtime(); };
    window.addEventListener('online', online);
    void (async () => {
      try {
        const session = await studentApi.restoreSession();
        if (session === undefined) { state = 'session-expired'; notice = '登入已失效，請回到學生首頁重新加入課堂。'; return; }
        queueOwner = session.queueOwner;
        queue = createAnswerQueue(queueOwner);
        await refresh(); if (state !== 'closed') state = 'ready'; await reconnect();
        refreshTimer = setInterval(() => { if (!realtime?.isLive()) void poll(); }, 15_000);
        startRealtime();
      } catch (error) {
        if (isSessionExpired(error)) await expireSession();
        else { state = 'error'; notice = '無法讀取題目，請檢查網路後按「重新整理」。'; }
      }
    })();
    return () => { mounted = false; generation += 1; refreshController?.abort(); realtime?.stop(); if (refreshTimer !== undefined) clearInterval(refreshTimer); window.removeEventListener('online', online); };
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

<StudentShell title="回答題目">
  <div aria-live="polite" class="notice">{notice}</div>
  {#if realtimeStatus === 'offline' || realtimeStatus === 'reconnecting'}<p class="connection">即時更新暫時中斷，題目狀態仍會定時重新確認。</p>{/if}
  {#if view}<QuestionAnswer {view} onSubmit={submit} pending={state === 'saving'} />
  {#if state === 'queued'}<button class="discard" onclick={() => void (async () => { await queue?.discard(); state = 'ready'; notice = '本機未同步答案已捨棄。'; })()}>捨棄本機未同步答案</button>{/if}
  {:else if state === 'loading'}<p role="status">正在讀取題目…</p>
  {:else}<button onclick={() => void poll()}>重新整理</button>{/if}
</StudentShell>

<style>
  .notice { min-height: 1.5rem; color: #075985; font-weight: 600; }
  .connection { color: #475569; font-size: .9rem; }
  button { min-height: 44px; padding: .6rem 1rem; color: white; background: #075985; border: 0; border-radius: .4rem; font: inherit; }
  .discard { display: block; margin-top: .75rem; background: #991b1b; }
</style>
