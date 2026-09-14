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
  <a class:active={current === 'home'} href="/teacher">總覽</a>
  <a class:active={current === 'roster'} href="/teacher/roster">班級與已加入學生</a>
  <a class:active={current === 'questions'} href="/teacher/questions">題庫與即時題</a>
  <a class:active={current === 'assignments'} href="/teacher/assignments">收功課</a>
  <a class:active={current === 'materials'} href="/teacher/materials">教材</a>
</nav>

<style>
  .top{display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap;border-bottom:2px solid #d6deea;margin-bottom:1rem}.eyebrow{color:#36527b;font-weight:700;letter-spacing:.08em;font-size:.8rem;margin-bottom:0}h1{line-height:1.2}button{min-height:44px;padding:.55rem .9rem;border:1px solid #50627d;border-radius:.45rem;color:#172033;background:#fff;cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #005fcc;outline-offset:2px}nav{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1.25rem}a{color:#003f88;font-weight:700;min-height:44px;padding:.55rem .7rem;border-radius:.4rem;text-decoration:none}a:hover,a.active{background:#dceafb;color:#00336e}
</style>
