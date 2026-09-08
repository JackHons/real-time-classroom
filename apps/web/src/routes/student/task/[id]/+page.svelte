<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { isSessionExpired, studentApi } from '$lib/student/api';
  import type { StudentFileTask } from '$lib/student/types';

  let view: StudentFileTask | undefined;
  let file: File | undefined;
  let progress = 0;
  let notice = '';
  let uploading = false;
  let uploadController: AbortController | undefined;
  let deadlinePassed = false;
  let sessionExpired = false;
  const taskId = page.params.id ?? '';
  const classId = page.url.searchParams.get('class') ?? '';
  $: deadlinePassed = view ? new Date(view.task.deadlineAtUtc).getTime() <= Date.now() : false;
  async function load(): Promise<void> {
    if (!classId) { notice = '缺少課堂資訊；請使用老師提供的作業連結。'; return; }
    try { view = await studentApi.readFileTask(fetch, classId, taskId); }
    catch (error) {
      if (isSessionExpired(error)) { await studentApi.endSession(); sessionExpired = true; notice = '登入已失效；請回到學生首頁重新加入課堂。'; }
      else notice = '無法讀取作業。請確認登入與連線。';
    }
  }
  onMount(() => { void load(); return () => uploadController?.abort(); });
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
    if (!file || !view || deadlinePassed || view.submission.submitted) return;
    uploading = true; notice = '';
    uploadController = new AbortController();
    try { await studentApi.uploadFile(fetch, classId, taskId, file, (value) => progress = value, uploadController.signal); await load(); notice = '檔案已成功繳交，不能再替換。'; }
    catch (error) {
      if (isSessionExpired(error)) { await studentApi.endSession(); sessionExpired = true; notice = '登入已失效；未儲存檔案內容，請回到學生首頁重新加入課堂。'; }
      else notice = error instanceof Error && error.message === 'UPLOAD_ABORTED' ? '已取消上傳；未儲存檔案內容。' : '上傳失敗；未儲存檔案內容，請在期限內重新選擇後上傳。';
    }
    finally { uploadController = undefined; uploading = false; }
  }
</script>

<svelte:head><title>繳交作業｜LAN 課堂互動平台</title></svelte:head>
<main>
  <a class="skip" href="#content">跳到主要內容</a>
  {#if view && !sessionExpired}
    <section id="content" aria-labelledby="task-title">
      <h1 id="task-title">{view.task.title}</h1>
      <p>{view.task.description}</p>
      <p class:urgent={deadlinePassed}><strong>截止時間：</strong>{new Date(view.task.deadlineAtUtc).toLocaleString('zh-Hant-TW')} {deadlinePassed ? '（已截止）' : ''}</p>
      {#if view.submission.submitted}
        <p role="status">已繳交 {view.submission.displayFilename ?? '檔案'}。繳交成功後不可替換。</p>
      {:else if view.task.state !== 'open' || deadlinePassed}
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
</main>

<style>
  main { max-width: 48rem; margin: auto; padding: 1rem; color: #172554; font: 1rem/1.55 system-ui, sans-serif; }
  form { display:grid; gap:.7rem; } input, button { min-height:44px; font:inherit; } button { border:0; border-radius:.4rem; background:#075985; color:white; padding:.6rem 1rem; font-weight:700; } progress { width:100%; height:1.5rem; } .urgent { color:#9f1239; font-weight:700; } :focus-visible { outline:3px solid #f59e0b; outline-offset:2px; } .skip { position:absolute; left:-999px; } .skip:focus { left:1rem; top:1rem; background:#fff; padding:.5rem; }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; } }
</style>
