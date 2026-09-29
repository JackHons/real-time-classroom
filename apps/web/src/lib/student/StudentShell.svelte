<script lang="ts">
  import { page } from '$app/state';
  import '../ui-theme.css';

  let { title, eyebrow = '學生課堂', children }: {
    title: string;
    eyebrow?: string;
    children: import('svelte').Snippet;
  } = $props();
</script>

<svelte:head><title>{title}｜LAN 課堂互動平台</title></svelte:head>

<a class="skip" href="#content">跳到主要內容</a>
<header>
  <a class="brand" href="/student">LAN 課堂</a>
  <nav aria-label="學生導覽">
    <a class:active={page.url.pathname === '/student'} aria-current={page.url.pathname === '/student' ? 'page' : undefined} href="/student">加入課堂</a>
    <a class:active={page.url.pathname.startsWith('/student/activities')} aria-current={page.url.pathname.startsWith('/student/activities') ? 'page' : undefined} href="/student/activities">我的課堂</a>
  </nav>
</header>
<main id="content">
  <p class="eyebrow">{eyebrow}</p>
  {@render children()}
</main>

<style>
  header {
    min-height: 4.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: .65rem max(1rem, calc((100% - 72rem) / 2));
    background: rgb(255 255 255 / 94%);
    border-bottom: 1px solid var(--color-border);
    box-shadow: none;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: .6rem;
    color: #174a46;
    font-weight: 850;
    letter-spacing: -.02em;
    text-decoration: none;
    white-space: nowrap;
  }
  .brand::before {
    content: "";
    width: .7rem;
    height: .7rem;
    border-radius: .25rem;
    background: var(--color-primary);
    outline: 3px solid var(--color-primary-soft);
  }
  nav { display: flex; flex-wrap: wrap; gap: .35rem; }
  nav a {
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    padding: .45rem .8rem;
    color: #3c5957;
    border: 1px solid transparent;
    border-radius: 999px;
    font-weight: 700;
    text-decoration: none;
    transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease;
  }
  nav a:hover { color: var(--color-primary-strong); background: var(--color-primary-soft); border-color: #c3e4df; }
  nav a.active { color: var(--color-primary-strong); background: #e7f3f0; border-color: #c8e2dc; }
  main { width: min(100% - 2rem, 72rem); margin: 0 auto; padding: clamp(1.25rem, 3vw, 2.25rem) 0 3rem; }
  .eyebrow { margin: 0 0 .45rem; color: var(--color-accent); font-size: .82rem; font-weight: 800; letter-spacing: .085em; text-transform: uppercase; }
  @media (max-width: 36rem) {
    header { align-items: flex-start; flex-direction: column; gap: .35rem; padding: .8rem 1rem; }
    nav { width: 100%; gap: .2rem; }
    nav a { padding-inline: .65rem; }
    main { width: min(100% - 1.25rem, 72rem); }
  }
</style>
