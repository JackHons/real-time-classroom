<script lang="ts">
  import { onMount } from 'svelte';
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
      if (session !== undefined) { openActivities(); return; }
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
    const trimmedNumber = studentNumber.trim();
    if (!/^[0-9]+$/.test(trimmedNumber)) {
      message = '學號只能輸入半形數字（0–9），不可包含英文字母、符號、小數點或全形數字。';
      state = 'form';
      return;
    }
    message = '';
    state = 'joining';
    try {
      const outcome = await studentApi.join(fetch, match.classId, trimmedNumber);
      if (outcome === 'active') { openActivities(); return; }
      // A prior POST can have created this browser's cookie even if a route
      // navigation was interrupted.  Restore only this browser's cookie; we
      // never revoke or displace an unknown device's active student session.
      const session = await studentApi.restoreSession();
      if (session !== undefined) { openActivities(); return; }
      state = 'error';
      message = '加入課堂未完成，請重新嘗試。';
    } catch {
      state = 'error';
      message = '送出失敗，請檢查網路後重試。';
    }
  }

  function openActivities(): void {
    // A full navigation makes the successful login resilient to an interrupted
    // client-side router transition. The HttpOnly session cookie is already
    // committed before the API response resolves.
    globalThis.location.assign('/student/activities');
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
      <!-- Keep the numeric input hint/pattern, but let the explicit JS message
           explain invalid pasted values instead of the browser silently
           blocking submission with an unlocalised native validation bubble. -->
      <form novalidate onsubmit={(event) => { event.preventDefault(); void join(); }}>
        <label for="class">班級代碼</label>
        <input id="class" bind:value={classReference} list="class-suggestions" required autocomplete="organization" placeholder="例如 F7A" disabled={state === 'joining' || classes.length === 0}/>
        <datalist id="class-suggestions">{#each classes as item}<option value={item.name}>{item.name}</option>{/each}</datalist>
        <label for="number">學號</label>
        <input id="number" bind:value={studentNumber} required autocomplete="username" inputmode="numeric" pattern="[0-9]*" aria-describedby="number-help" disabled={state === 'joining'} />
        <p id="number-help" class="hint">只可輸入半形數字 0–9。</p>
        <button type="submit" class="primary" disabled={state === 'joining' || classes.length === 0}>{state === 'joining' ? '正在送出…' : '加入課堂'}</button>
      </form>
      {#if message}<p class="error" role="alert">{message}</p>{/if}
    {:else}
      <p role="status" aria-live="polite" class:error={state === 'denied' || state === 'error'}>{message}</p>
      <button onclick={() => { state = 'loading'; void initialise(); }}>重新嘗試</button>
    {/if}
  </section>
</StudentShell>

<style>
  .hero { max-width: 48rem; margin-bottom: 1.35rem; }
  h1 { margin: 0; font-size: clamp(2rem, 5vw, 3.15rem); }
  .hero p { max-width: 66ch; margin-top: .8rem; color: var(--color-muted); font-size: 1.08rem; }
  h2 { margin-top: 0; font-size: 1.3rem; }
  .card {
    max-width: 40rem;
    margin-top: 1rem;
    background: #fff;
  }
  form { display: grid; gap: .35rem; margin-top: 1.15rem; }
  form label { margin-top: .7rem; }
  form button { width: 100%; margin-top: .65rem; }
  .hint { margin: -.05rem 0 .35rem; font-size: .92rem; }
  #number { letter-spacing: .035em; }
</style>
