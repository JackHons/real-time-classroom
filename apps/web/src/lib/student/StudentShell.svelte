<script lang="ts">
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
    <a href="/student">加入課堂</a>
    <a href="/student/activities">我的課堂</a>
  </nav>
</header>
<main id="content">
  <p class="eyebrow">{eyebrow}</p>
  {@render children()}
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; background: #f5f8fc; color: #172554; font: 1rem/1.55 system-ui, "Noto Sans TC", sans-serif; }
  header { min-height: 4.25rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .7rem max(1rem, calc((100% - 68rem) / 2)); background: #fff; border-bottom: 1px solid #cbd5e1; }
  .brand { color: #0c4a6e; font-weight: 800; text-decoration: none; white-space: nowrap; }
  nav { display: flex; flex-wrap: wrap; gap: .25rem .8rem; }
  nav a { min-height: 44px; display: inline-flex; align-items: center; color: #075985; font-weight: 700; text-decoration: none; padding: .35rem .5rem; border-radius: .4rem; }
  nav a:hover { background: #e0f2fe; }
  main { width: min(100% - 2rem, 68rem); margin: 0 auto; padding: 1.4rem 0 2.5rem; }
  .eyebrow { margin: 0 0 .25rem; color: #0369a1; font-size: .85rem; font-weight: 800; letter-spacing: .08em; }
  .skip { position: absolute; z-index: 3; left: -100vw; top: .5rem; background: #fff; color: #172554; padding: .55rem; }
  .skip:focus { left: .5rem; }
  :global(:focus-visible) { outline: 3px solid #f59e0b; outline-offset: 2px; }
  @media (max-width: 32rem) { header { align-items: flex-start; flex-direction: column; gap: .15rem; } main { width: min(100% - 1.5rem, 68rem); } }
  @media (prefers-reduced-motion: reduce) { :global(*) { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
</style>
