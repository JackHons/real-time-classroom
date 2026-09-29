<script lang="ts">
  export let current: 'home' | 'roster' | 'questions' | 'assignments' | 'materials';
  export let onLogout: () => Promise<void>;
  let busy = false;
  async function logout(): Promise<void> { busy = true; try { await onLogout(); } finally { busy = false; } }
</script>

<header class="top">
  <div><p class="eyebrow">LAN CLASSROOM</p><h1>教師管理</h1></div>
  <button on:click={() => void logout()} disabled={busy}>{busy ? '登出中…' : '登出'}</button>
</header>
<nav aria-label="教師功能">
  <a class:active={current === 'home'} aria-current={current === 'home' ? 'page' : undefined} href="/teacher">總覽</a>
  <a class:active={current === 'roster'} aria-current={current === 'roster' ? 'page' : undefined} href="/teacher/roster">班級與已加入學生</a>
  <a class:active={current === 'questions'} aria-current={current === 'questions' ? 'page' : undefined} href="/teacher/questions">題庫與即時題</a>
  <a class:active={current === 'assignments'} aria-current={current === 'assignments' ? 'page' : undefined} href="/teacher/assignments">收功課</a>
  <a class:active={current === 'materials'} aria-current={current === 'materials' ? 'page' : undefined} href="/teacher/materials">教材</a>
</nav>

<style>
  .top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--color-border); }
  .top > div { min-width: 0; }
  .eyebrow { margin: 0 0 .25rem; color: var(--color-accent); font-size: .77rem; font-weight: 800; letter-spacing: .12em; }
  h1 { margin: 0; color: #183f3c; font-size: clamp(1.6rem, 3.5vw, 2.25rem); }
  .top > button { min-height: 42px; color: #345250; background: transparent; border-color: #b5c8c4; box-shadow: none; }
  .top > button:hover:not(:disabled) { color: var(--color-primary-strong); background: var(--color-primary-soft); }
  nav { display: flex; flex-wrap: wrap; gap: .4rem; margin-block: 1rem 1.6rem; padding: .4rem; background: #eaf2f0; border: 1px solid #d4e1de; border-radius: .9rem; }
  nav a { min-height: 44px; display: inline-flex; align-items: center; padding: .55rem .8rem; color: #385552; border: 1px solid transparent; border-radius: .65rem; font-weight: 700; text-decoration: none; transition: color 160ms ease, background-color 160ms ease, border-color 160ms ease; }
  nav a:hover { color: #183f3c; background: #f8fbfa; }
  nav a.active { color: #fff; background: var(--color-primary); border-color: var(--color-primary); }
  @media (max-width: 40rem) {
    .top { align-items: center; }
    nav { gap: .25rem; padding: .3rem; }
    nav a { flex: 1 1 auto; justify-content: center; padding-inline: .55rem; text-align: center; }
  }
</style>
