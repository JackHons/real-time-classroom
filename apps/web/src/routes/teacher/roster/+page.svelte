<script lang="ts">
  import { onMount } from 'svelte'; import { goto } from '$app/navigation';
  import { TeacherApi, readableError, type ClassDeletionImpact, type ClassRoom, type JoinedStudent } from '$lib/teacher-api'; import TeacherNav from '$lib/teacher/TeacherNav.svelte'; import '$lib/teacher/teacher.css';
  const api = new TeacherApi(); let ready = false; let busy = false; let error = ''; let notice = '';
  let classes: readonly ClassRoom[] = []; let selectedClassId = ''; let className = ''; let joined: readonly JoinedStudent[] = [];
  let deletion: ClassDeletionImpact | undefined; let confirmationName = ''; let deleteDialog: HTMLDialogElement | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  onMount(() => { void initialise(); return () => { if (refreshTimer !== undefined) clearInterval(refreshTimer); }; });
  async function initialise(): Promise<void> { if (!await api.restoreTeacher()) { await goto('/teacher'); return; } ready = true; await refresh(); refreshTimer = setInterval(() => { void refreshJoined(); }, 10_000); }
  async function work(action: () => Promise<void>): Promise<void> { busy = true; error = ''; notice = ''; try { await action(); } catch (cause) { error = readableError(cause); } finally { busy = false; } }
  async function refresh(): Promise<void> { const page = await api.classes(); classes = page.items; if (!classes.some((room) => room.id === selectedClassId)) selectedClassId = classes[0]?.id ?? ''; await refreshJoined(); }
  async function refreshJoined(): Promise<void> { joined = selectedClassId ? (await api.joinedStudents(selectedClassId)).items : []; }
  async function createClass(): Promise<void> { await work(async () => { const created = await api.createClass(className); className = ''; selectedClassId = created.id; await refresh(); notice = `已建立「${created.name}」。學生現在可以只輸入學號加入。`; }); }
  async function askDelete(): Promise<void> { await work(async () => { if (!selectedClassId) return; deletion = await api.classDeletionImpact(selectedClassId); confirmationName = ''; deleteDialog?.showModal(); }); }
  async function deleteClass(): Promise<void> { await work(async () => { if (deletion === undefined || selectedClassId !== deletion.classId) return; const removed = deletion.className; await api.deleteClass(deletion.classId, confirmationName); deleteDialog?.close(); deletion = undefined; await refresh(); notice = `已刪除「${removed}」及其班級資料。`; }); }
  function closeDelete(): void { deleteDialog?.close(); deletion = undefined; confirmationName = ''; }
  async function logout(): Promise<void> { await api.logout(); await goto('/teacher'); }
</script>
<main aria-busy={!ready}>
  <TeacherNav current="roster" onLogout={logout}/>
  {#if !ready}<p>正在確認教師登入狀態…</p>{:else}
    <h2>班級與已加入學生</h2>
    <p class="muted">不需要預先匯入名單。學生選擇班級並輸入學號後，會立即出現在此處。</p>
    <div class="feedback" aria-live="polite">{#if notice}<p class="notice">{notice}</p>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}</div>
    <div class="grid two"><form class="panel" on:submit|preventDefault={() => void createClass()}><h3>建立班級</h3><label for="class-name">班級名稱</label><input id="class-name" bind:value={className} required maxlength="200"/><button class="primary" disabled={busy}>建立班級</button></form>
      <section class="panel"><h3>班級管理</h3><label for="class-picker">選擇班級</label><select id="class-picker" bind:value={selectedClassId} on:change={() => void work(refreshJoined)}>{#each classes as room}<option value={room.id}>{room.name}</option>{/each}</select><div class="actions"><button on:click={() => void work(refresh)} disabled={busy}>重新整理</button><button class="danger" on:click={() => void askDelete()} disabled={busy || !selectedClassId}>刪除班級</button></div><p class="muted">刪除會移除本班學生加入紀錄、教材、題目、作業及交件，且不能復原。</p></section></div>
    <section class="panel" aria-labelledby="joined-title"><div class="actions"><h3 id="joined-title">已加入學生（{joined.filter((student) => student.leftAtUtc === null).length} 位在課／{joined.length} 筆紀錄）</h3><button on:click={() => void work(refreshJoined)} disabled={busy || !selectedClassId}>更新名單</button></div>
      {#if !selectedClassId}<p class="muted">請先建立班級。</p>{:else if joined.length === 0}<p class="muted">尚未有學生加入。請請學生前往學生入口，選擇此班並輸入學號。</p>{:else}<div class="table-wrap"><table><thead><tr><th>學號</th><th>顯示名稱</th><th>狀態</th><th>首次加入</th><th>最近加入</th><th>退出時間</th></tr></thead><tbody>{#each joined as student}<tr><td>{student.studentNumber}</td><td>{student.displayName}</td><td>{student.leftAtUtc === null ? '在課中' : '已退出'}</td><td>{new Date(student.joinedAtUtc).toLocaleString()}</td><td>{new Date(student.lastJoinedAtUtc).toLocaleString()}</td><td>{student.leftAtUtc === null ? '—' : new Date(student.leftAtUtc).toLocaleString()}</td></tr>{/each}</tbody></table></div>{/if}
    </section>
  {/if}
</main>
<dialog bind:this={deleteDialog} aria-labelledby="delete-class-title" on:close={() => { deletion = undefined; confirmationName = ''; }}>
  {#if deletion}<form class="dialog" on:submit|preventDefault={() => void deleteClass()}><h2 id="delete-class-title">刪除「{deletion.className}」？</h2><p class="error">此操作不能復原，會永久移除以下資料：</p><ul><li>已加入學生：{deletion.joinedStudents}（學生紀錄共 {deletion.students}）</li><li>教材：{deletion.materials}</li><li>即時題：{deletion.questions}</li><li>作業：{deletion.fileTasks}</li><li>已交文件：{deletion.submissions}</li></ul><label for="delete-confirmation">請輸入班級名稱「{deletion.className}」以確認</label><input id="delete-confirmation" bind:value={confirmationName} autocomplete="off" required/><div class="actions"><button type="button" on:click={closeDelete}>取消</button><button type="submit" class="danger" disabled={busy || confirmationName.normalize('NFKC').trim() !== deletion.className}>永久刪除班級</button></div></form>{/if}
</dialog>
<style>
  dialog{max-width:36rem;border:0;border-radius:.7rem;box-shadow:0 16px 50px #0008;padding:0}
  dialog::backdrop{background:#07132599}.dialog{padding:1.25rem}
</style>
