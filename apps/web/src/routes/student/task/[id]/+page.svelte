<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { RealtimeClient, type RealtimeStatus } from '$lib/realtime/client';
  import { isSessionExpired, studentApi } from '$lib/student/api';
  import StudentShell from '$lib/student/StudentShell.svelte';
  import type { StudentFileTask } from '$lib/student/types';

  let view: StudentFileTask | undefined;
  let file: File | undefined;
  let progress = 0;
  let notice = '';
  let uploading = false;
  let uploadController: AbortController | undefined;
  let deadlinePassed = false;
  let lateReopened = false;
  let acceptingSubmissions = false;
  let sessionExpired = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let realtime: RealtimeClient | undefined;
  let realtimeStatus: RealtimeStatus | undefined;
  const taskId = page.params.id ?? '';
  const classId = page.url.searchParams.get('class') ?? '';
  $: deadlinePassed = view ? new Date(view.task.deadlineAtUtc).getTime() <= Date.now() : false;
  $: lateReopened = view?.task.state === 'open' && typeof view.task.reopenedAtUtc === 'string';
  $: acceptingSubmissions = view?.task.state === 'open' && (!deadlinePassed || lateReopened);
  async function load(): Promise<void> {
    if (!classId) { notice = '缺少課堂資訊；請使用老師提供的作業連結。'; return; }
    try { view = await studentApi.readFileTask(fetch, classId, taskId); }
    catch (error) {
      if (isSessionExpired(error)) { realtime?.stop(); await studentApi.endSession(); sessionExpired = true; notice = '登入已失效；請回到學生首頁重新加入課堂。'; }
      else notice = '無法讀取作業。請確認登入與連線。';
    }
  }
  function startRealtime(): void {
    realtime?.stop();
    realtime = new RealtimeClient({
      resources: ['file-task'],
      resync: load,
      onStatus: (status) => realtimeStatus = status
    });
    realtime.start();
  }
  onMount(() => {
    void (async () => { await load(); if (!sessionExpired) { startRealtime(); refreshTimer = setInterval(() => { if (!realtime?.isLive()) void load(); }, 15_000); } })();
    return () => { uploadController?.abort(); realtime?.stop(); if (refreshTimer !== undefined) clearInterval(refreshTimer); };
  });
  function selectFile(event: Event): void {
    const candidate = (event.currentTarget as HTMLInputElement).files?.[0];
    if (candidate === undefined) return;
    if (view !== undefined && candidate.size > view.task.maxBytes) {
      file = undefined;
      notice = `檔案超過 ${Math.round(view.task.maxBytes / 1_000_000)} MB 上限，未開始上傳。`;
      (event.currentTarget as HTMLInputElement).value = '';
      return;
    }
    file = candidate; notice = '';
  }
  async function upload(): Promise<void> {
    if (!file || !view || !acceptingSubmissions || view.submission.submitted) return;
    uploading = true; notice = '';
    uploadController = new AbortController();
    try { await studentApi.uploadFile(fetch, classId, taskId, file, (value) => progress = value, uploadController.signal); await load(); notice = '檔案已成功繳交，不能再替換。'; }
    catch (error) {
      if (isSessionExpired(error)) { realtime?.stop(); await studentApi.endSession(); sessionExpired = true; notice = '登入已失效；未儲存檔案內容，請回到學生首頁重新加入課堂。'; }
      else notice = error instanceof Error && error.message === 'UPLOAD_ABORTED' ? '已取消上傳；未儲存檔案內容。' : '上傳失敗；未儲存檔案內容，請在期限內重新選擇後上傳。';
    }
    finally { uploadController = undefined; uploading = false; }
  }
</script>

<StudentShell title="繳交作業">
  {#if realtimeStatus === 'offline' || realtimeStatus === 'reconnecting'}<p class="connection">即時更新暫時中斷，作業狀態仍會定時重新確認。</p>{/if}
  {#if view && !sessionExpired}
    <section class="panel task-card" aria-labelledby="task-title">
      <h1 id="task-title">{view.task.title}</h1>
      <p>{view.task.description}</p>
      <p class:urgent={deadlinePassed && !lateReopened}><strong>原截止時間：</strong>{new Date(view.task.deadlineAtUtc).toLocaleString('zh-Hant-TW')} {deadlinePassed ? (lateReopened ? '（已過；教師重新開放中）' : '（已截止）') : ''}</p>
      {#if view.submission.submitted}
        <p role="status">已繳交 {view.submission.displayFilename ?? '檔案'}。繳交成功後不可替換。</p>
      {:else if !acceptingSubmissions}
        <p role="status">此作業目前不接受上傳。</p>
      {:else}
        <form onsubmit={(event) => { event.preventDefault(); upload(); }}>
          <label for="file">選擇一個檔案（上限 {Math.round(view.task.maxBytes / 1_000_000)} MB）</label>
          <input id="file" type="file" required onchange={selectFile} />
          {#if file}<p>已選擇：{file.name}（不會預覽或執行檔案）</p>{/if}
          <progress aria-label="上傳進度" value={progress} max="100">{progress}%</progress>
          <button type="submit" disabled={uploading}>{uploading ? `正在上傳 ${progress}%` : '上傳並繳交'}</button>
          {#if uploading}<button type="button" onclick={() => uploadController?.abort()}>取消上傳</button>{/if}
        </form>
      {/if}
    </section>
  {:else}<p role="status">{notice || '正在讀取作業…'}</p>{/if}
  <p role="status" aria-live="polite">{notice}</p>
</StudentShell>

<style>
  .task-card { max-width: 56rem; }
  .task-card h1 { margin-top: 0; font-size: clamp(1.7rem, 4vw, 2.5rem); }
  .task-card > p { max-width: 72ch; }
  .task-card form { display: grid; gap: .75rem; margin-top: 1.1rem; }
  .task-card form label { margin-top: 0; }
  .task-card input[type="file"] { padding: .55rem; background: #fbfdfc; }
  .task-card progress { height: .9rem; }
  .task-card form button { justify-self: start; }
  .connection { color: var(--color-muted); font-size: .94rem; }
  .urgent { color: var(--color-danger); font-weight: 750; }
</style>
