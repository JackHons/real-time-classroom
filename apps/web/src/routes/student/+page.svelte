<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import StudentShell from '$lib/student/StudentShell.svelte';
  import { studentApi } from '$lib/student/api';
  import type { PublicClass } from '$lib/student/types';

  let classes: readonly PublicClass[] = [];
  // The server uses an opaque class id, but students should never have to
  // discover or copy it.  They can enter the teacher-facing class name (for
  // example "F7A") or choose it from the suggestions below.
  let classReference = '';
  let studentNumber = '';
  let state: 'loading' | 'form' | 'joining' | 'denied' | 'error' = 'loading';
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
    const match = resolveClassId(classReference);
    if (match.kind !== 'matched') {
      message = match.kind === 'ambiguous'
        ? '有多個課堂使用這個班級代碼。請聯絡老師使用不重複的班級代碼。'
        : '找不到這個課堂。請輸入老師提供的班級代碼，例如 F7A，或從建議清單選擇。';
      return;
    }
    message = '';
    state = 'joining';
    try {
      const outcome = await studentApi.join(fetch, match.classId, studentNumber);
      if (outcome === 'active') { await goto('/student/activities'); return; }
      state = 'denied';
      message = '目前無法加入課堂。此學號可能已在另一部裝置登入，請先關閉原本的學生頁面後再試。';
    } catch {
      state = 'error';
      message = '送出失敗，請檢查網路後重試。';
    }
  }

  type ClassMatch = Readonly<{ kind: 'matched'; classId: string }> | Readonly<{ kind: 'missing' | 'ambiguous' }>;

  function resolveClassId(value: string): ClassMatch {
    const normalized = value.normalize('NFKC').trim();
    if (normalized.length === 0) return { kind: 'missing' };

    // Match what teachers and students see, not a database identifier. NFKC
    // accepts full-width characters, while the locale-neutral case mapping
    // makes F7A / f7a behave identically across devices.
    const classId = classes.find((item) => item.id === normalized)?.id;
    if (classId !== undefined) return { kind: 'matched', classId };
    const name = normalized.toUpperCase();
    const matches = classes.filter((item) => item.name.normalize('NFKC').trim().toUpperCase() === name);
    if (matches.length === 1) return { kind: 'matched', classId: matches[0]!.id };
    return { kind: matches.length === 0 ? 'missing' : 'ambiguous' };
  }
</script>

<StudentShell title="加入課堂">
  <section class="hero" aria-labelledby="title">
    <h1 id="title">加入課堂</h1>
    <p>輸入老師提供的班級代碼（例如 F7A）及學號即可加入。加入後可在「我的課堂」分開查看即時題和檔案作業。</p>
  </section>

  <section class="card" aria-labelledby="join-title">
    <h2 id="join-title">學生登入</h2>
    {#if state === 'loading'}
      <p role="status">正在準備課堂資料…</p>
    {:else if state === 'form' || state === 'joining'}
      {#if classes.length === 0}<p class="error" role="status">目前沒有可加入的課堂，請向老師確認課堂是否已建立。</p>{/if}
      <form onsubmit={(event) => { event.preventDefault(); void join(); }}>
        <label for="class">班級代碼</label>
        <input id="class" bind:value={classReference} list="class-suggestions" required autocomplete="organization" placeholder="例如 F7A" disabled={state === 'joining' || classes.length === 0}/>
        <datalist id="class-suggestions">{#each classes as item}<option value={item.name}>{item.name}</option>{/each}</datalist>
        <label for="number">學號</label>
        <input id="number" bind:value={studentNumber} required autocomplete="username" disabled={state === 'joining'} />
        <button type="submit" disabled={state === 'joining' || classes.length === 0}>{state === 'joining' ? '正在送出…' : '加入課堂'}</button>
      </form>
      {#if message}<p class="error" role="alert">{message}</p>{/if}
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
  input, button { min-height: 44px; font: inherit; border-radius: .45rem; }
  input { width: 100%; border: 1px solid #64748b; padding: .5rem .65rem; background: #fff; }
  button { margin-top: .5rem; border: 0; padding: .6rem 1rem; background: #075985; color: #fff; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: .65; cursor: wait; }
  .error { color: #7f1d1d; background: #fef2f2; border-left: 4px solid #b91c1c; padding: .7rem; }
</style>
