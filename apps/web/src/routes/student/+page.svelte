<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import StudentShell from '$lib/student/StudentShell.svelte';
  import { studentApi } from '$lib/student/api';
  import type { PublicClass } from '$lib/student/types';

  let classes: readonly PublicClass[] = [];
  let classId = '';
  let displayName = '';
  let studentNumber = '';
  let state: 'loading' | 'form' | 'joining' | 'pending' | 'denied' | 'error' = 'loading';
  let message = '';

  onMount(() => { void initialise(); });

  async function initialise(): Promise<void> {
    try {
      const session = await studentApi.restoreSession();
      if (session !== undefined) { await goto('/student/activities'); return; }
      classes = await studentApi.listClasses();
      state = 'form';
    } catch {
      state = 'error';
      message = '現在無法連線到課堂，請稍後再試。';
    }
  }

  async function join(): Promise<void> {
    state = 'joining';
    try {
      const outcome = await studentApi.join(fetch, classId, displayName, studentNumber);
      if (outcome === 'active') { await goto('/student/activities'); return; }
      if (outcome === 'pending') {
        state = 'pending';
        message = '加入申請已送出，請等待老師核准後再登入。';
      } else {
        state = 'denied';
        message = '目前無法加入課堂。請向老師確認核准狀態或是否已有另一個登入。';
      }
    } catch {
      state = 'error';
      message = '送出失敗，請檢查網路後重試。';
    }
  }
</script>

<StudentShell title="加入課堂">
  <section class="hero" aria-labelledby="title">
    <h1 id="title">加入課堂</h1>
    <p>輸入老師提供的課堂、姓名及學號。加入後可在「我的課堂」分開查看即時題和檔案作業。</p>
  </section>

  <section class="card" aria-labelledby="join-title">
    <h2 id="join-title">學生登入</h2>
    {#if state === 'loading'}
      <p role="status">正在準備課堂資料…</p>
    {:else if state === 'form' || state === 'joining'}
      {#if classes.length === 0}<p class="error" role="status">目前沒有可加入的課堂，請向老師確認課堂是否已建立。</p>{/if}
      <form onsubmit={(event) => { event.preventDefault(); void join(); }}>
        <label for="class">課堂</label>
        <select id="class" bind:value={classId} required disabled={state === 'joining' || classes.length === 0}>
          <option value="" disabled>請選擇課堂</option>
          {#each classes as item}<option value={item.id}>{item.name}</option>{/each}
        </select>
        <label for="name">姓名</label>
        <input id="name" bind:value={displayName} required autocomplete="name" disabled={state === 'joining'} />
        <label for="number">學號</label>
        <input id="number" bind:value={studentNumber} required autocomplete="username" disabled={state === 'joining'} />
        <button type="submit" disabled={state === 'joining' || classes.length === 0}>{state === 'joining' ? '正在送出…' : '加入課堂'}</button>
      </form>
    {:else}
      <p role="status" aria-live="polite" class:error={state === 'denied' || state === 'error'}>{message}</p>
      <button onclick={() => { state = 'loading'; void initialise(); }}>重新嘗試</button>
    {/if}
  </section>
</StudentShell>

<style>
  .hero { max-width: 44rem; }
  h1 { margin: 0; font-size: clamp(2rem, 6vw, 3.2rem); line-height: 1.15; }
  h2 { margin-top: 0; font-size: 1.3rem; }
  .card { max-width: 38rem; margin-top: 1.4rem; padding: 1.2rem; border: 1px solid #cbd5e1; border-radius: .8rem; background: #fff; box-shadow: 0 1px 2px #17255412; }
  form { display: grid; gap: .55rem; margin-top: 1rem; }
  label { font-weight: 700; }
  input, select, button { min-height: 44px; font: inherit; border-radius: .45rem; }
  input, select { width: 100%; border: 1px solid #64748b; padding: .5rem .65rem; background: #fff; }
  button { margin-top: .5rem; border: 0; padding: .6rem 1rem; background: #075985; color: #fff; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: .65; cursor: wait; }
  .error { color: #7f1d1d; background: #fef2f2; border-left: 4px solid #b91c1c; padding: .7rem; }
</style>
