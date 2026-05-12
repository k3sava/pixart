// Global keyboard shortcuts + splash + nav overlay for pixart.
// 28 effects total; keys 1-9 map to the first 9 alphabetically, 0 to the 10th.
// The remaining 18 are reachable via the overlay nav (⌘K, /, or chevron click).
(function(){
  'use strict';
  // Source of truth — mirrored in pixart/index.html and scripts/sync-nav.py.
  const EFFECTS = [
    'ascii','bevel','cellular','contour','crt',
    'displace','distort','dithering','dots','edge',
    'film-grain','flow-field','gradients','halftone-cmyk',
    'ink-wash','kaleidoscope','patterns','pixel-sort',
    'recolor','rgb-shift','scatter','slide','slit-scan',
    'stack','stippling','voronoi','watercolor','zoom-blur',
  ];
  // Categories: same partition as the homepage chips.
  const CATEGORIES = [
    ['Type',       ['ascii']],
    ['Tonal',      ['bevel','contour','edge','gradients','recolor']],
    ['Halftone',   ['dithering','dots','halftone-cmyk','stippling']],
    ['Geometric',  ['displace','distort','kaleidoscope','voronoi']],
    ['Cinematic',  ['crt','film-grain','rgb-shift','zoom-blur']],
    ['Painterly',  ['ink-wash','watercolor']],
    ['Glitch',     ['pixel-sort','scatter','slit-scan']],
    ['Generative', ['cellular','flow-field','patterns']],
    ['Motion',     ['slide','stack']],
  ];
  window.PIXART_EFFECTS = EFFECTS;
  window.PIXART_CATEGORIES = CATEGORIES;

  const KEY_MAP = {};
  for(let i = 0; i < 9; i++) KEY_MAP[String(i+1)] = EFFECTS[i];  // 1-9 → 0..8
  KEY_MAP['0'] = EFFECTS[9];                                     // 0 → 10th (edge)
  const SEEN = 'pix.splash.seen';

  function clickRow(key){
    const row = document.querySelector(`.wg-row[data-key="${key}"]`);
    row?.querySelector('input[type=checkbox]')?.click();
  }
  function basePath(){
    const parts = location.pathname.split('/').filter(Boolean);
    const px = parts.indexOf('pixart');
    return px >= 0 ? '/' + parts.slice(0, px + 1).join('/') + '/' : '../';
  }
  function go(slug){ location.href = basePath() + slug + '/'; }
  function goHome(){ location.href = basePath(); }
  function currentSlug(){
    for(const s of EFFECTS) if(location.pathname.indexOf(`/${s}/`) >= 0) return s;
    return null;
  }
  function cycle(delta){
    const cur = currentSlug();
    if(!cur) return;
    const i = EFFECTS.indexOf(cur);
    const next = EFFECTS[(i + delta + EFFECTS.length) % EFFECTS.length];
    go(next);
  }

  const CMDS = {
    'a': () => clickRow('animate'),
    'i': () => clickRow('interactive'),
    ' ': () => clickRow('animate'),
    'p': () => document.getElementById('export-png')?.click(),
    'm': () => document.getElementById('export-mp4')?.click(),
    'c': () => document.querySelector('.wg-collapse')?.click(),
    'r': () => document.querySelector('.wg-file .wg-shuffle')?.click(),
    'o': () => document.querySelector('.wg-file input[type=file]')?.click(),
    'arrowright': () => cycle(+1),
    'arrowleft':  () => cycle(-1),
    '?': () => showSplash(),
    'escape': () => { hideOverlay(); hideSplash(); },
  };

  function typingTarget(t){
    if(!t) return false;
    if(typeof t.matches === 'function' && t.matches('input, textarea, select')) return true;
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
  }

  document.addEventListener('keydown', (e) => {
    // ⌘K / Ctrl+K — open nav overlay, focus its search (even from inputs).
    if((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')){
      e.preventDefault();
      showOverlay();
      return;
    }
    if(typingTarget(e.target)){
      // Inside overlay search: handled by its own listener.
      return;
    }
    // "/" → open overlay (nav search) instead of splash; splash still on "?".
    if(e.key === '/'){
      e.preventDefault();
      showOverlay();
      return;
    }
    if(KEY_MAP[e.key]){
      const slug = KEY_MAP[e.key];
      if(slug && location.pathname.indexOf(`/${slug}/`) < 0){ go(slug); e.preventDefault(); }
      return;
    }
    if(e.key === 't' || e.key === 'T') return; // theme.js owns
    const k = e.key.toLowerCase();
    const fn = CMDS[k];
    if(fn){ e.preventDefault(); fn(e); }
  });

  // ---------- Nav overlay (⌘K / / / chevron) ----------
  function buildOverlay(){
    if(document.getElementById('pix-nav-overlay')) return;
    const el = document.createElement('div');
    el.id = 'pix-nav-overlay';
    el.className = 'pix-nav-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Browse effects');
    const cur = currentSlug();
    const groupsHTML = CATEGORIES.map(([cat, slugs]) => {
      const items = slugs.map(s =>
        `<a href="${basePath()}${s}/" data-slug="${s}" class="pix-nav-item${s === cur ? ' active' : ''}">${s}</a>`
      ).join('');
      return `<div class="pix-nav-group">
        <div class="pix-nav-group-title">${cat.toLowerCase()}</div>
        <div class="pix-nav-group-items">${items}</div>
      </div>`;
    }).join('');
    el.innerHTML = `
      <div class="pix-nav-overlay-bg"></div>
      <div class="pix-nav-overlay-panel" role="document">
        <div class="pix-nav-overlay-head">
          <span class="pix-nav-overlay-icon">⌕</span>
          <input type="search" id="pix-nav-search" autocomplete="off" placeholder="search 28 effects…" aria-label="Search effects">
          <button type="button" class="pix-nav-overlay-close" aria-label="Close">esc</button>
        </div>
        <div class="pix-nav-overlay-body">${groupsHTML}</div>
        <div class="pix-nav-overlay-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>`;
    document.body.appendChild(el);

    const $bg    = el.querySelector('.pix-nav-overlay-bg');
    const $close = el.querySelector('.pix-nav-overlay-close');
    const $input = el.querySelector('#pix-nav-search');
    const $body  = el.querySelector('.pix-nav-overlay-body');

    $bg.addEventListener('click', hideOverlay);
    $close.addEventListener('click', hideOverlay);

    $input.addEventListener('input', () => {
      const q = $input.value.trim().toLowerCase();
      let visible = 0;
      $body.querySelectorAll('.pix-nav-item').forEach(a => {
        const m = !q || a.dataset.slug.includes(q);
        a.style.display = m ? '' : 'none';
        if(m) visible++;
      });
      $body.querySelectorAll('.pix-nav-group').forEach(g => {
        const any = [...g.querySelectorAll('.pix-nav-item')].some(a => a.style.display !== 'none');
        g.style.display = any ? '' : 'none';
      });
    });

    $input.addEventListener('keydown', (e) => {
      const items = [...$body.querySelectorAll('.pix-nav-item')].filter(a => a.style.display !== 'none');
      const focused = document.activeElement;
      let idx = items.indexOf(focused);
      if(e.key === 'ArrowDown'){ e.preventDefault(); (items[idx + 1] || items[0])?.focus(); }
      else if(e.key === 'ArrowUp'){ e.preventDefault(); (items[idx - 1] || items[items.length - 1])?.focus(); }
      else if(e.key === 'Enter'){
        e.preventDefault();
        const target = items[idx] || items[0];
        if(target) location.href = target.href;
      } else if(e.key === 'Escape'){ hideOverlay(); }
    });

    $body.addEventListener('keydown', (e) => {
      const items = [...$body.querySelectorAll('.pix-nav-item')].filter(a => a.style.display !== 'none');
      const idx = items.indexOf(document.activeElement);
      if(e.key === 'ArrowDown'){ e.preventDefault(); (items[idx + 1] || items[0])?.focus(); }
      else if(e.key === 'ArrowUp'){ e.preventDefault(); (items[idx - 1] || items[items.length - 1])?.focus(); }
      else if(e.key === 'Escape'){ hideOverlay(); }
      else if(e.key.length === 1 && /[a-z0-9-]/.test(e.key)){
        $input.focus(); $input.value += e.key; $input.dispatchEvent(new Event('input'));
      }
    });
  }
  function showOverlay(){
    buildOverlay();
    const el = document.getElementById('pix-nav-overlay');
    if(!el) return;
    el.classList.add('visible');
    document.getElementById('effect-nav-open')?.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => document.getElementById('pix-nav-search')?.focus());
  }
  function hideOverlay(){
    const el = document.getElementById('pix-nav-overlay');
    if(el) el.classList.remove('visible');
    document.getElementById('effect-nav-open')?.setAttribute('aria-expanded', 'false');
  }
  window.PixartNav = { open: showOverlay, close: hideOverlay };

  // ---------- Splash (help / first-run) ----------
  function buildSplash(){
    if(document.getElementById('pix-splash')) return;
    const el = document.createElement('div');
    el.id = 'pix-splash';
    el.className = 'wa-splash';
    const numbered = EFFECTS.slice(0, 10).map((s, i) => `<kbd>${i === 9 ? 0 : i+1}</kbd>`).join('');
    el.innerHTML = `
      <div class="wa-splash-inner">
        <div class="wa-splash-title">pixart</div>
        <div class="wa-splash-tag">28 effects. drop an image or video. then play.</div>
        <div class="wa-splash-grid">
          <span>${numbered}</span><span>jump to first 10 effects</span>
          <span><kbd>←</kbd> <kbd>→</kbd></span><span>previous / next (28 total)</span>
          <span><kbd>/</kbd> or <kbd>⌘</kbd><kbd>K</kbd></span><span>open nav · search all 28</span>
          <span><kbd>T</kbd></span><span>cycle theme</span>
          <span><kbd>O</kbd></span><span>open file picker</span>
          <span><kbd>R</kbd></span><span>cycle sample</span>
          <span><kbd>A</kbd> / <kbd>Space</kbd></span><span>animate</span>
          <span><kbd>I</kbd></span><span>interactive</span>
          <span><kbd>P</kbd></span><span>export PNG</span>
          <span><kbd>M</kbd></span><span>export 15 s MP4</span>
          <span><kbd>C</kbd></span><span>collapse panel</span>
          <span><kbd>?</kbd></span><span>show this again</span>
        </div>
        <div class="wa-splash-tap">drag any image or video onto the page, or click to begin</div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', hideSplash);
  }
  function showSplash(){ buildSplash(); document.getElementById('pix-splash')?.classList.add('visible'); }
  function hideSplash(){
    const el = document.getElementById('pix-splash');
    if(el && el.classList.contains('visible')){
      el.classList.remove('visible');
      try { localStorage.setItem(SEEN, '1'); } catch(_){}
    }
  }

  function init(){
    buildSplash();
    const helpBtn = document.getElementById('help-btn');
    if(helpBtn) helpBtn.addEventListener('click', showSplash);
    // Wire the compact-nav chevron button.
    const openBtn = document.getElementById('effect-nav-open');
    if(openBtn) openBtn.addEventListener('click', showOverlay);
    if(!localStorage.getItem(SEEN)) showSplash();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.WAKeys = { show: showSplash, hide: hideSplash };
})();
