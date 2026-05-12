// Global keyboard shortcuts + splash overlay for pixart.
// 16 effects total; keys 1-9 map to the first 9 alphabetically, 0 to the 10th.
// The remaining six are nav-only.
(function(){
  'use strict';
  const EFFECTS = [
    'ascii','bevel','cellular','crt','displace','distort','dithering','dots','edge',
    'gradients','patterns','recolor','scatter','slide','stack','stippling'
  ];
  const KEY_MAP = {}; // key char → slug
  for(let i = 0; i < 9; i++) KEY_MAP[String(i+1)] = EFFECTS[i];      // 1-9 → 0..8
  KEY_MAP['0'] = EFFECTS[9];                                          // 0 → 9th
  const SEEN = 'pix.splash.seen';

  function clickRow(key){
    const row = document.querySelector(`.wg-row[data-key="${key}"]`);
    row?.querySelector('input[type=checkbox]')?.click();
  }
  function go(slug){
    const parts = location.pathname.split('/').filter(Boolean);
    const px = parts.indexOf('pixart');
    const base = px >= 0 ? '/' + parts.slice(0, px + 1).join('/') + '/' : '../';
    location.href = base + slug + '/';
  }
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
    '/': () => showSplash(),
    'escape': () => hideSplash(),
  };

  function typingTarget(t){
    if(!t) return false;
    if(typeof t.matches === 'function' && t.matches('input, textarea, select')) return true;
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
  }

  document.addEventListener('keydown', (e) => {
    if(typingTarget(e.target)) return;
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

  function buildSplash(){
    if(document.getElementById('pix-splash')) return;
    const el = document.createElement('div');
    el.id = 'pix-splash';
    el.className = 'wa-splash';
    // Build the 1-9+0 shortcut row dynamically (only 10 numbered slots).
    const numbered = EFFECTS.slice(0, 10).map((s, i) => `<kbd>${i === 9 ? 0 : i+1}</kbd>`).join('');
    el.innerHTML = `
      <div class="wa-splash-inner">
        <div class="wa-splash-title">pixart</div>
        <div class="wa-splash-tag">drop an image or video. then play.</div>
        <div class="wa-splash-grid">
          <span>${numbered}</span><span>jump to effect (1–9, 0)</span>
          <span><kbd>←</kbd> <kbd>→</kbd></span><span>previous / next effect</span>
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
    if(!localStorage.getItem(SEEN)) showSplash();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.WAKeys = { show: showSplash, hide: hideSplash };
})();
