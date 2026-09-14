<script lang="ts">
  import { onMount } from 'svelte'; import { goto } from '$app/navigation';
  import { TeacherApi } from '$lib/teacher-api'; import TeacherNav from '$lib/teacher/TeacherNav.svelte'; import '$lib/teacher/teacher.css';
  const api = new TeacherApi(); let ready = false;
  onMount(() => { void (async () => { if (!await api.restoreTeacher()) await goto('/'); else ready = true; })(); });
  async function logout(): Promise<void> { await api.logout(); await goto('/'); }
</script>
<main aria-busy={!ready}>
  <TeacherNav current="home" onLogout={logout}/>
  {#if ready}<section class="panel"><h2>教師工作台</h2><p>各項功能已分為獨立頁面，方便在課堂中快速切換。</p><div class="grid two"><a class="button" href="/teacher/roster">班級與名單：建立班級、匯入學生</a><a class="button" href="/teacher/questions">題庫與即時題：暫存、建立草稿、開放及收答</a><a class="button" href="/teacher/assignments">收功課：進度、交件清單、預覽及下載</a></div></section>{:else}<p>正在確認教師登入狀態…</p>{/if}
</main>
