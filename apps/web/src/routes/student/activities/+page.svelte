<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { RealtimeClient, type RealtimeStatus } from '$lib/realtime/client';
  import StudentShell from '$lib/student/StudentShell.svelte';
  import { isSessionExpired, studentApi } from '$lib/student/api';
  import type { StudentActivities } from '$lib/student/types';

  let classId = '';
  let activities: StudentActivities | undefined;
  let state: 'loading' | 'ready' | 'session-expired' | 'error' = 'loading';
  let message = '';
  let activitiesError = '';
  let refreshInFlight = false;
  let loadingMore = false;
  let mounted = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshController: AbortController | undefined;
  let realtime: RealtimeClient | undefined;
  let realtimeStatus: RealtimeStatus | undefined;
  let leaving = false;
  let leaveError = '';

  async function expireSession(): Promise<void> {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = undefined;
    refreshController?.abort();
    realtime?.stop();
    realtimeStatus = undefined;
    await studentApi.endSession();
    state = 'session-expired';
    message = '登入已失效。請重新加入課堂。';
  }

  async function leaveClass(): Promise<void> {
    if (!globalThis.confirm('確定要退出這個課堂嗎？你將需要重新輸入學號才能再次加入。已提交的作業與作答紀錄不會被刪除。')) return;
    leaving = true;
    leaveError = '';
    try {
      refreshController?.abort();
      realtime?.stop();
      await studentApi.leaveClass(fetch);
      await goto('/student');
    } catch (error) {
      if (isSessionExpired(error)) { await expireSession(); return; }
      leaveError = '暫時無法退出課堂，請稍後再試。';
    } finally { leaving = false; }
  }

  async function refreshActivities(): Promise<void> {
    if (refreshInFlight) return;
    refreshInFlight = true;
    activitiesError = '';
    const controller = new AbortController();
    refreshController = controller;
    try {
      const next = await studentApi.activities(fetch, controller.signal);
      if (mounted) activities = next;
    } catch (error) {
      if (isSessionExpired(error)) await expireSession();
      else if (!(error instanceof DOMException && error.name === 'AbortError') && mounted) activitiesError = '活動清單暫時無法更新，請檢查網路後重新整理。';
    } finally {
      if (refreshController === controller) refreshController = undefined;
      refreshInFlight = false;
    }
  }

  async function loadMoreActivities(): Promise<void> {
    const questionCursor = activities?.questions.nextCursor;
    const fileTaskCursor = activities?.fileTasks.nextCursor;
    const current = activities;
    if ((questionCursor === undefined && fileTaskCursor === undefined) || loadingMore || current === undefined) return;
    loadingMore = true;
    try {
      const next = await studentApi.activities(fetch, undefined, questionCursor, fileTaskCursor);
      if (!mounted) return;
      activities = {
        questions: questionCursor === undefined ? current.questions : { items: [...current.questions.items, ...next.questions.items], ...(next.questions.nextCursor === undefined ? {} : { nextCursor: next.questions.nextCursor }) },
        fileTasks: fileTaskCursor === undefined ? current.fileTasks : { items: [...current.fileTasks.items, ...next.fileTasks.items], ...(next.fileTasks.nextCursor === undefined ? {} : { nextCursor: next.fileTasks.nextCursor }) },
        materials: next.materials
      };
    } catch (error) {
      if (isSessionExpired(error)) await expireSession();
      else activitiesError = '無法載入更多活動，請稍後再試。';
    } finally { loadingMore = false; }
  }

  function startRealtime(): void {
    realtime?.stop();
    realtime = new RealtimeClient({
      resources: ['question', 'file-task'],
      resync: refreshActivities,
      onStatus: (next) => { if (mounted) realtimeStatus = next; }
    });
    realtime.start();
  }

  onMount(() => {
    mounted = true;
    void (async () => {
      try {
        const session = await studentApi.restoreSession();
        if (session === undefined) { await goto('/student'); return; }
        classId = session.classId;
        state = 'ready';
        await refreshActivities();
        startRealtime();
        refreshTimer = setInterval(() => { if (!realtime?.isLive()) void refreshActivities(); }, 15_000);
      } catch {
        state = 'error';
        message = '現在無法讀取你的課堂，請稍後再試。';
      }
    })();
    return () => { mounted = false; refreshController?.abort(); realtime?.stop(); if (refreshTimer !== undefined) clearInterval(refreshTimer); };
  });
</script>

<StudentShell title="我的課堂">
  <section class="intro" aria-labelledby="title">
    <div><h1 id="title">我的課堂</h1><p>即時題與檔案作業分開顯示；開放、關閉或交件狀態會自動更新。</p></div>
    {#if state === 'ready'}<div class="actions"><button class="secondary" onclick={() => void refreshActivities()} disabled={refreshInFlight || leaving}>{refreshInFlight ? '更新中…' : '重新整理'}</button><button class="leave" onclick={() => void leaveClass()} disabled={leaving}>{leaving ? '正在退出…' : '退出課堂'}</button></div>{/if}
  </section>

  {#if realtimeStatus === 'offline' || realtimeStatus === 'reconnecting'}<p class="connection" role="status">即時更新暫時中斷，系統仍會定時檢查活動。</p>{/if}
  {#if activitiesError}<p class="error" role="status">{activitiesError}</p>{/if}
  {#if leaveError}<p class="error" role="alert">{leaveError}</p>{/if}
  {#if state === 'loading'}<p role="status">正在讀取課堂活動…</p>
  {:else if state === 'session-expired' || state === 'error'}<section class="empty"><p role="status">{message}</p><a class="button" href="/student">返回加入課堂</a></section>
  {:else}
    <h2 class="activities-heading">目前活動</h2>
    <div class="columns">
      <section class="panel" aria-labelledby="questions-title">
        <div class="section-title"><h2 id="questions-title">即時題</h2><span>{activities?.questions.items.length ?? 0} 項</span></div>
        {#if activities?.questions.items.length === 0}<p class="muted">老師尚未開放即時題。</p>
        {:else}<ul class="activity-list">{#each activities?.questions.items ?? [] as question}<li><a href={`/student/question/${encodeURIComponent(question.id)}`}><span class:open={question.state === 'open'} class="badge">{question.state === 'open' ? '進行中' : '已結束'}</span><strong>{question.prompt}</strong><small>{question.kind === 'short_text' ? '短答題' : question.kind === 'multiple_choice' ? '複選題' : '單選題'}</small></a></li>{/each}</ul>{/if}
      </section>
      <section class="panel" aria-labelledby="tasks-title">
        <div class="section-title"><h2 id="tasks-title">檔案作業</h2><span>{activities?.fileTasks.items.length ?? 0} 項</span></div>
        {#if activities?.fileTasks.items.length === 0}<p class="muted">老師尚未開放檔案作業。</p>
        {:else}<ul class="activity-list">{#each activities?.fileTasks.items ?? [] as task}<li><a href={`/student/task/${encodeURIComponent(task.id)}?class=${encodeURIComponent(classId)}`}><span class:open={task.state === 'open'} class="badge">{task.state === 'open' ? '開放繳交' : '已結束'}</span><strong>{task.title}</strong><small>截止：{new Date(task.deadlineAtUtc).toLocaleString('zh-Hant-TW')}</small></a></li>{/each}</ul>{/if}
      </section>
    </div>
    <section class="panel materials" aria-labelledby="materials-title"><div class="section-title"><h2 id="materials-title">老師教材</h2><span>{activities?.materials.items.length ?? 0} 份</span></div>{#if activities?.materials.items.length === 0}<p class="muted">老師尚未上傳教材。</p>{:else}<ul class="activity-list">{#each activities?.materials.items ?? [] as material}<li><a href={`/api/classes/${encodeURIComponent(classId)}/materials/${encodeURIComponent(material.id)}/download`}><strong>{material.displayFilename}</strong><small>{(material.byteLength / 1024).toFixed(1)} KB · {new Date(material.createdAtUtc).toLocaleString('zh-Hant-TW')}</small></a></li>{/each}</ul>{/if}</section>
    {#if activities?.questions.nextCursor || activities?.fileTasks.nextCursor}<button class="more" onclick={() => void loadMoreActivities()} disabled={loadingMore}>{loadingMore ? '載入中…' : '載入更多活動'}</button>{/if}
  {/if}
</StudentShell>

<style>
  .intro { display: flex; align-items: end; justify-content: space-between; gap: 1.25rem; margin-bottom: 1.5rem; }
  .intro h1 { margin: 0; font-size: clamp(2rem, 5vw, 3rem); }
  .intro p { max-width: 68ch; margin-bottom: 0; color: var(--color-muted); }
  .intro .actions { display: flex; flex-wrap: wrap; gap: .55rem; }
  .columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
  .activities-heading { margin: 1.7rem 0 .8rem; font-size: 1.35rem; }
  .section-title { display: flex; align-items: baseline; justify-content: space-between; gap: .75rem; padding-bottom: .8rem; border-bottom: 1px solid #dce6e3; }
  .section-title h2 { margin: 0; font-size: 1.3rem; }
  .section-title span { flex: none; padding: .22rem .65rem; color: #315653; background: var(--color-surface-muted); border-radius: 999px; font-size: .88rem; font-weight: 750; }
  .activity-list { display: grid; gap: .7rem; padding: 0; list-style: none; }
  .activity-list li { margin: 0; }
  .activity-list a {
    display: grid;
    gap: .35rem;
    min-height: 6.25rem;
    padding: .9rem;
    color: var(--color-foreground);
    background: #fff;
    border: 1px solid var(--color-surface-border);
    border-radius: .75rem;
    text-decoration: none;
    transition: background-color 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
  }
  .activity-list a:hover { background: #f0f8f6; border-color: #8dbdb5; }
  .activity-list a:focus-visible { outline-offset: 3px; }
  .badge { width: max-content; padding: .16rem .55rem; color: #4d5e5d; background: #edf2f1; border-radius: 999px; font-size: .82rem; font-weight: 750; }
  .badge.open { color: #155738; background: #e4f4e9; }
  .activity-list small { font-size: .91rem; }
  button, .button { min-height: 46px; border: 1px solid transparent; border-radius: .7rem; padding: .6rem .95rem; color: #fff; background: var(--color-primary); font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; }
  button:hover:not(:disabled), .button:hover { background: var(--color-primary-strong); }
  button:disabled { opacity: .58; cursor: not-allowed; }
  .secondary { color: #20524e; background: #e5f2ef; border-color: #c6ded9; }
  .secondary:hover:not(:disabled) { color: #173c39; background: #d7ebe6; }
  .leave { color: #852d25; background: #fff; border-color: #e4b9b2; }
  .leave:hover:not(:disabled) { color: #fff; background: #9d382d; }
  .more { display: flex; margin: 1rem auto; }
  .connection { margin: 1rem 0; padding: .75rem .9rem; color: #20524e; background: #e7f4f1; border-left: 4px solid var(--color-primary); border-radius: .5rem; }
  .empty { max-width: 42rem; }
  .materials { margin-top: 1rem; }
  @media (max-width: 52rem) { .columns { grid-template-columns: minmax(0, 1fr); } }
  @media (max-width: 38rem) {
    .intro { align-items: flex-start; flex-direction: column; }
    .intro .actions { width: 100%; }
    .intro .actions > button { flex: 1; }
    .activity-list a { min-height: 5.5rem; }
  }
</style>
