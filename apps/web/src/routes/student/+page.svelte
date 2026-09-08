<script lang="ts">
  import { onMount } from 'svelte';
  import { studentApi } from '$lib/student/api';
  import type { PublicClass, StudentActivities } from '$lib/student/types';

  let classes: readonly PublicClass[] = [];
  let classId = '';
  let displayName = '';
  let studentNumber = '';
  let state: 'loading' | 'form' | 'joining' | 'pending' | 'denied' | 'active' | 'error' = 'loading';
  let message = '';
  let activities: StudentActivities | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  async function refreshActivities(): Promise<void> { activities = await studentApi.activities(); }

  async function initialise(): Promise<void> {
    try {
      const session = await studentApi.restoreSession();
      if (session) { classId = session.classId; state = 'active'; message = '你已登入課堂。活動清單會定時更新。'; await refreshActivities(); refreshTimer = setInterval(() => { void refreshActivities(); }, 15_000); return; }
      classes = await studentApi.listClasses();
      state = 'form';
    } catch { state = 'error'; message = '現在無法連線到課堂，請稍後再試。'; }
  }
  onMount(() => { void initialise(); return () => { if (refreshTimer !== undefined) clearInterval(refreshTimer); }; });
  async function join(): Promise<void> {
    state = 'joining';
    try {
      const outcome = await studentApi.join(fetch, classId, displayName, studentNumber);
      if (outcome === 'active') { state = 'active'; message = '已加入課堂。'; await refreshActivities(); refreshTimer = setInterval(() => { void refreshActivities(); }, 15_000); }
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
        <section aria-labelledby="activities-title"><h2 id="activities-title">目前活動</h2><button onclick={() => void refreshActivities()}>重新整理</button>
          {#if activities?.questions.length === 0 && activities?.fileTasks.length === 0}<p>目前沒有已開放或已結束的活動。</p>{/if}
          {#if activities && activities.questions.length > 0}<h3>即時題</h3><ul>{#each activities.questions as question}<li><a href={`/student/question/${encodeURIComponent(question.id)}`}>{question.state === 'open' ? '進行中' : '已結束'}｜{question.prompt}</a></li>{/each}</ul>{/if}
          {#if activities && activities.fileTasks.length > 0}<h3>檔案作業</h3><ul>{#each activities.fileTasks as task}<li><a href={`/student/task/${encodeURIComponent(task.id)}?class=${encodeURIComponent(classId)}`}>{task.state === 'open' ? '開放中' : '已結束'}｜{task.title}</a></li>{/each}</ul>{/if}
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
  :focus-visible { outline: 3px solid #f59e0b; outline-offset: 2px; }
  .skip { position: absolute; left: -999px; } .skip:focus { left: 1rem; top: 1rem; background: white; padding: .5rem; }
  @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
</style>
