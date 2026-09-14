<script lang="ts">
  import { onMount } from 'svelte'; import { goto } from '$app/navigation';
  import { TeacherApi, readableError, type ClassRoom, type CsvPreview, type RosterStudent } from '$lib/teacher-api'; import TeacherNav from '$lib/teacher/TeacherNav.svelte'; import '$lib/teacher/teacher.css';
  const api = new TeacherApi(); let ready = false; let busy = false; let error = ''; let notice = '';
  let classes: readonly ClassRoom[] = []; let selectedClassId = ''; let className = ''; let roster: readonly RosterStudent[] = [];
  let csv = '學號,姓名\n'; let preview: CsvPreview | undefined;
  onMount(() => { void initialise(); });
  async function initialise(): Promise<void> { if (!await api.restoreTeacher()) { await goto('/'); return; } ready = true; await refresh(); }
  async function work(action: () => Promise<void>): Promise<void> { busy = true; error = ''; notice = ''; try { await action(); } catch (cause) { error = readableError(cause); } finally { busy = false; } }
  async function refresh(): Promise<void> { const page = await api.classes(); classes = page.items; if (!classes.some((room) => room.id === selectedClassId)) selectedClassId = classes[0]?.id ?? ''; await refreshRoster(); }
  async function refreshRoster(): Promise<void> { roster = selectedClassId ? (await api.roster(selectedClassId)).items : []; }
  async function createClass(): Promise<void> { await work(async () => { const created = await api.createClass(className); className = ''; selectedClassId = created.id; await refresh(); notice = `已建立「${created.name}」。`; }); }
  function ignoredColumnsNotice(result: CsvPreview): string { const lines = result.ignoredColumnLines ?? []; return lines.length === 0 ? '' : ` 第三欄及之後的資料未儲存（第 ${lines.join('、')} 列）。`; }
  async function inspect(): Promise<void> { if (!selectedClassId) { error = '請先建立或選擇班級。'; return; } await work(async () => { preview = await api.previewRoster(selectedClassId, csv); notice = preview.issues.length === 0 ? `格式正確，共 ${preview.rows.length} 位學生。${ignoredColumnsNotice(preview)}` : '請先修正標示的資料列。'; }); }
  async function importRoster(): Promise<void> { if (!selectedClassId) { error = '請先建立或選擇班級。'; return; } await work(async () => { const result = await api.importRoster(selectedClassId, csv); preview = result; if (result.issues.length > 0) { error = '名單尚未匯入；請修正問題後再試。'; return; } await refreshRoster(); notice = `已成功匯入 ${result.rows.length} 位學生，名單已更新。${ignoredColumnsNotice(result)}`; }); }
  async function readFile(event: Event): Promise<void> { const file = (event.currentTarget as HTMLInputElement).files?.[0]; if (!file) return; await work(async () => { csv = await file.text(); preview = undefined; notice = `已讀取 ${file.name}，請預覽後確認匯入。`; }); }
  async function logout(): Promise<void> { await api.logout(); await goto('/'); }
</script>
<main aria-busy={!ready}>
  <TeacherNav current="roster" onLogout={logout}/>
  {#if !ready}<p>正在確認教師登入狀態…</p>{:else}
    <h2>班級與學生名單</h2><div class="feedback" aria-live="polite">{#if notice}<p class="notice">{notice}</p>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}</div>
    <div class="grid two"><form class="panel" on:submit|preventDefault={() => void createClass()}><h3>建立班級</h3><label for="class-name">班級名稱</label><input id="class-name" bind:value={className} required maxlength="200"/><button class="primary" disabled={busy}>建立班級</button></form>
      <section class="panel"><h3>目前班級</h3><label for="class-picker">選擇班級</label><select id="class-picker" bind:value={selectedClassId} on:change={() => void work(refreshRoster)}>{#each classes as room}<option value={room.id}>{room.name}</option>{/each}</select><button on:click={() => void work(refresh)} disabled={busy}>重新整理</button></section></div>
    <div class="grid two"><section class="panel"><h3>匯入名單</h3><p class="muted">每行格式：<code>學號,姓名</code>。可含標題列；也支援 <code>姓名,學號</code>。第三欄及之後可保留在來源檔，但不會儲存，預覽時會清楚提示。重複學號或空白資料會顯示列號，且不會部分匯入。</p><label for="csv-file">從 CSV 檔讀取</label><input id="csv-file" type="file" accept=".csv,text/csv" on:change={(event) => void readFile(event)}/><label for="csv">CSV 內容</label><textarea id="csv" rows="8" bind:value={csv} spellcheck="false"></textarea><div class="actions"><button on:click={() => void inspect()} disabled={busy}>預覽格式</button><button class="primary" on:click={() => void importRoster()} disabled={busy}>確認匯入</button></div></section>
      <section class="panel"><h3>已匯入名單（{roster.length}）</h3>{#if roster.length === 0}<p class="muted">尚未有學生名單。</p>{:else}<div class="table-wrap"><table><thead><tr><th>學號</th><th>姓名</th><th>來源</th></tr></thead><tbody>{#each roster as student}<tr><td>{student.studentNumber}</td><td>{student.displayName}</td><td>{student.isTemporary ? '臨時核准' : '匯入名單'}</td></tr>{/each}</tbody></table></div>{/if}</section></div>
    {#if preview}<section class="panel"><h3>匯入預覽</h3>{#if preview.issues.length > 0}<ul class="issues">{#each preview.issues as issue}<li>第 {issue.line} 列：{issue.message}</li>{/each}</ul>{:else}<p class="notice">可安全匯入 {preview.rows.length} 位學生。</p><div class="table-wrap"><table><thead><tr><th>學號</th><th>姓名</th></tr></thead><tbody>{#each preview.rows as row}<tr><td>{row.rawStudentNumber}</td><td>{row.displayName}</td></tr>{/each}</tbody></table></div>{/if}</section>{/if}
  {/if}
</main>
