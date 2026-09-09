<script lang="ts">
  import { onMount } from 'svelte';
  import { RealtimeClient, type RealtimeStatus } from '$lib/realtime/client';
  import { isSessionExpired, studentApi } from '$lib/student/api';
  import type { PublicClass, StudentActivities } from '$lib/student/types';

  let classes: readonly PublicClass[] = [];
  let classId = '';
  let displayName = '';
  let studentNumber = '';
  let state: 'loading' | 'form' | 'joining' | 'pending' | 'denied' | 'active' | 'session-expired' | 'error' = 'loading';
  let message = '';
  let activities: StudentActivities | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshInFlight = false;
  let refreshGeneration = 0;
  let refreshController: AbortController | undefined;
  let mounted = false;
  let activitiesError = '';
  let loadingMore = false;
  let realtime: RealtimeClient | undefined;
  let realtimeStatus: RealtimeStatus | undefined;

  async function expireSession(): Promise<void> {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = undefined;
    refreshController?.abort();
    realtime?.stop();
    realtime = undefined;
    await studentApi.endSession();
    state = 'session-expired';
    message = '登入已失效，為保護你的資料，本機未同步答案已捨棄。請重新加入課堂。';
  }

  async function refreshActivities(): Promise<void> {
    if (refreshInFlight) return;
    refreshInFlight = true;
    activitiesError = '';
    const generation = refreshGeneration;
    const controller = new AbortController();
    refreshController = controller;
    try {
      const next = await studentApi.activities(fetch, controller.signal);
      if (mounted && generation === refreshGeneration) activities = next;
    } catch (error) {
      if (isSessionExpired(error)) { await expireSession(); return; }
      if (!(error instanceof DOMException && error.name === 'AbortError') && mounted && generation === refreshGeneration) {
        activitiesError = '活動清單暫時無法更新，請檢查網路後重新整理。';
      }
    } finally {
      if (refreshController === controller) refreshController = undefined;
      refreshInFlight = false;
    }
  }
  function startPolling(): void {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!realtime?.isLive()) void refreshActivities(); }, 15_000);
  }
  function startRealtime(): void {
    realtime?.stop();
    realtime = new RealtimeClient({
      resources: ['question', 'file-task'],
      resync: refreshActivities,
      onStatus: (status) => { if (mounted) realtimeStatus = status; }
    });
    realtime.start();
  }
  async function loadMoreActivities(): Promise<void> {
    const questionCursor = activities?.questions.nextCursor;
    const fileTaskCursor = activities?.fileTasks.nextCursor;
    if ((questionCursor === undefined && fileTaskCursor === undefined) || loadingMore) return;
    const currentActivities = activities;
    if (currentActivities === undefined) return;
    loadingMore = true;
    try {
      const next = await studentApi.activities(fetch, undefined, questionCursor, fileTaskCursor);
      if (!mounted) return;
      activities = {
        // The endpoint returns both collections. Only append the collection for
        // which this click supplied its original cursor; the completed side is
        // intentionally preserved without re-fetching/re-appending page one.
        questions: questionCursor === undefined ? currentActivities.questions : { items: [...currentActivities.questions.items, ...next.questions.items], ...(next.questions.nextCursor === undefined ? {} : { nextCursor: next.questions.nextCursor }) },
        fileTasks: fileTaskCursor === undefined ? currentActivities.fileTasks : { items: [...currentActivities.fileTasks.items, ...next.fileTasks.items], ...(next.fileTasks.nextCursor === undefined ? {} : { nextCursor: next.fileTasks.nextCursor }) }
      };
    } catch (error) { if (isSessionExpired(error)) await expireSession(); else activitiesError = '無法載入更多活動，請稍後再試。'; }
    finally { loadingMore = false; }
  }

  async function initialise(): Promise<void> {
    try {
      const session = await studentApi.restoreSession();
      if (session) { classId = session.classId; state = 'active'; message = '你已登入課堂。'; await refreshActivities(); startPolling(); startRealtime(); return; }
      classes = await studentApi.listClasses();
      state = 'form';
    } catch { state = 'error'; message = '現在無法連線到課堂，請稍後再試。'; }
  }
  onMount(() => { mounted = true; void initialise(); return () => { mounted = false; refreshGeneration += 1; refreshController?.abort(); realtime?.stop(); if (refreshTimer !== undefined) clearInterval(refreshTimer); }; });
  async function join(): Promise<void> {
    state = 'joining';
    try {
      const outcome = await studentApi.join(fetch, classId, displayName, studentNumber);
      if (outcome === 'active') { state = 'active'; message = '已加入課堂。'; await refreshActivities(); startPolling(); startRealtime(); }
      else if (outcome === 'pending') { state = 'pending'; message = '加入申請已送出，請等待老師核准後再登入。'; }
      else { state = 'denied'; message = '目前無法加入課堂。請向老師確認核准狀態或是否已有另一個登入。'; }
    } catch { state = 'error'; message = '送出失敗，請檢查網路後重試。'; }
  }
</script>

<svelte:head><title>學生加入課堂｜LAN 課堂互動平台</title></svelte:head>
<main>
  <a class="skip" href="#content">跳到主要內容</a>
  <section id="content" aria-labelledby="title">
    <h1 id="title">加入課堂</h1>
    {#if state === 'loading'}<p role="status">正在準備課堂資料…</p>
    {:else if state === 'form' || state === 'joining'}
      <p>選擇課堂後輸入姓名與學號。首次加入可能需要老師核准。</p>
      <form onsubmit={(event) => { event.preventDefault(); join(); }}>
        <label for="class">課堂</label>
        <select id="class" bind:value={classId} required disabled={state === 'joining'}>
          <option value="" disabled>請選擇課堂</option>
          {#each classes as item}<option value={item.id}>{item.name}</option>{/each}
        </select>
        <label for="name">姓名</label><input id="name" bind:value={displayName} required autocomplete="name" disabled={state === 'joining'} />
        <label for="number">學號</label><input id="number" bind:value={studentNumber} required autocomplete="username" disabled={state === 'joining'} />
        <button type="submit" disabled={state === 'joining'}>{state === 'joining' ? '正在送出…' : '加入課堂'}</button>
      </form>
    {:else}
      <p role="status" aria-live="polite">{message}</p>
      {#if state === 'active'}
        <section aria-labelledby="activities-title"><h2 id="activities-title">目前活動</h2><button onclick={() => void refreshActivities()} disabled={refreshInFlight}>{refreshInFlight ? '更新中…' : '重新整理'}</button>
          {#if realtimeStatus === 'offline' || realtimeStatus === 'reconnecting'}<p class="connection">即時更新暫時中斷，仍會定時檢查活動。</p>{/if}
          {#if activitiesError}<p class="error" role="status">{activitiesError}</p>{/if}
          {#if activities?.questions.items.length === 0 && activities?.fileTasks.items.length === 0}<p>目前沒有已開放或已結束的活動。</p>{/if}
          {#if activities && activities.questions.items.length > 0}<h3>即時題</h3><ul>{#each activities.questions.items as question}<li><a href={`/student/question/${encodeURIComponent(question.id)}`}>{question.state === 'open' ? '進行中' : '已結束'}｜{question.prompt}</a></li>{/each}</ul>{/if}
          {#if activities && activities.fileTasks.items.length > 0}<h3>檔案作業</h3><ul>{#each activities.fileTasks.items as task}<li><a href={`/student/task/${encodeURIComponent(task.id)}?class=${encodeURIComponent(classId)}`}>{task.state === 'open' ? '開放中' : '已結束'}｜{task.title}</a></li>{/each}</ul>{/if}
          {#if activities?.questions.nextCursor || activities?.fileTasks.nextCursor}<button onclick={() => void loadMoreActivities()} disabled={loadingMore}>{loadingMore ? '載入中…' : '載入更多活動'}</button>{/if}
        </section>
      {:else}<button onclick={() => state = 'form'}>重新嘗試</button>{/if}
    {/if}
  </section>
</main>

<style>
  main { max-width: 42rem; margin: 0 auto; padding: 1rem; color: #172554; font: 1rem/1.55 system-ui, sans-serif; }
  h1 { font-size: clamp(1.8rem, 5vw, 2.6rem); }
  form { display: grid; gap: .55rem; margin-top: 1rem; }
  input, select, button { min-height: 44px; font: inherit; border-radius: .4rem; }
  input, select { border: 2px solid #475569; padding: .4rem .6rem; }
  button { border: 0; padding: .5rem 1rem; background: #075985; color: #fff; font-weight: 700; margin-top: .5rem; }
  .error { color: #7f1d1d; background: #fef2f2; border-left: 4px solid #b91c1c; padding: .7rem; }
  .connection { color: #475569; font-size: .9rem; }
  :focus-visible { outline: 3px solid #f59e0b; outline-offset: 2px; }
  .skip { position: absolute; left: -999px; } .skip:focus { left: 1rem; top: 1rem; background: white; padding: .5rem; }
  @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
</style>
