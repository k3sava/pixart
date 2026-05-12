// Theme switcher — kami pattern: pill toggles a picker with 5 options.
// data-theme on <html>: classic (default = no attr), brutalist, editorial,
// terminal (labelled "phosphor"), zen. Persisted in localStorage.
(function(){
  'use strict';
  const THEMES = [
    { id:'default',   label:'classic',   icon:'○' },
    { id:'brutalist', label:'brutalist', icon:'■' },
    { id:'editorial', label:'editorial', icon:'¶' },
    { id:'terminal',  label:'phosphor',  icon:'>' },
    { id:'zen',       label:'zen',       icon:'◯' },
  ];
  const KEY = 'wa.theme';

  function apply(id){
    if(id === 'default'){ document.documentElement.removeAttribute('data-theme'); }
    else { document.documentElement.setAttribute('data-theme', id); }
    const meta = THEMES.find(t => t.id === id) || THEMES[0];
    const pill = document.querySelector('.theme-switcher-pill');
    if(pill){
      pill.setAttribute('title', meta.label);
      pill.setAttribute('aria-label', `Current theme: ${meta.label}. Click to change.`);
      const icon = pill.querySelector('.theme-switcher-pill-icon');
      if(icon) icon.textContent = meta.icon;
    }
    document.querySelectorAll('.theme-switcher-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.theme === id);
    });
  }
  function current(){ return localStorage.getItem(KEY) || 'default'; }
  function set(id){ localStorage.setItem(KEY, id); apply(id); }

  // Mount: build the picker dropdown if not already there.
  function attach(){
    const container = document.querySelector('.theme-switcher-container');
    if(!container) return;
    let picker = container.querySelector('.theme-switcher-picker');
    if(!picker){
      picker = document.createElement('div');
      picker.className = 'theme-switcher-picker';
      for(const t of THEMES){
        const b = document.createElement('button');
        b.className = 'theme-switcher-option';
        b.dataset.theme = t.id;
        b.innerHTML = `<span class="theme-switcher-option-icon">${t.icon}</span><span>${t.label}</span>`;
        b.addEventListener('click', () => { set(t.id); container.classList.remove('open'); });
        picker.appendChild(b);
      }
      container.appendChild(picker);
    }
    const pill = container.querySelector('.theme-switcher-pill');
    if(pill && !pill.dataset.wired){
      pill.dataset.wired = '1';
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        container.classList.toggle('open');
      });
    }
    document.addEventListener('click', (e) => {
      if(!container.contains(e.target)) container.classList.remove('open');
    });
    apply(current());
  }

  apply(current());
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if(t && typeof t.matches === 'function' && t.matches('input, textarea')) return;
    if(e.key === 't' || e.key === 'T'){
      // T cycles to next theme.
      const i = THEMES.findIndex(t => t.id === current());
      set(THEMES[(i + 1) % THEMES.length].id);
    }
  });

  window.WATheme = { set, apply, current, THEMES };
})();
