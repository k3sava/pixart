// wordart GUI controller — binds .wg-row elements to a params object and emits
// change events. Slider rows support click + drag on the track; the number
// input is editable directly.
(function(){
  'use strict';

  function clamp(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }
  function quantize(v, step){
    if(!step) return v;
    return Math.round(v / step) * step;
  }

  window.WAGui = class {
    constructor(panelEl, params){
      this.el = panelEl;
      this.params = params;
      this.listeners = new Set();
      this.rows = new Map();
      this._initTitle();
      this._initCollapse();
      panelEl.querySelectorAll('.wg-row').forEach(r => this._bindRow(r));
    }
    on(fn){ this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(key){
      // Forward shared-state keys (fit / bg / ratio / playRate / loopVideo)
      // to PIXSource so every effect's panel is wired without per-effect
      // boilerplate. The effect-level gui.on handler still fires for its own
      // bookkeeping.
      if(window.PIXSource && window.PIXSource.SHARED_KEYS &&
         window.PIXSource.SHARED_KEYS.includes(key)){
        window.PIXSource.setParam(key, this.params[key]);
      }
      for(const fn of this.listeners) fn(key, this.params);
    }
    syncFromParams(){
      for(const [key, row] of this.rows){
        this._writeRow(row, this.params[key]);
      }
    }
    _initTitle(){
      // No-op. The title used to toggle a vertical collapse (.is-collapsed
      // hides the body) but we only want the sideways slide via the chevron
      // handle. Clicking the title now does nothing — keep it as a header.
    }
    _initCollapse(){
      // Add a vertical collapse handle on the left edge. Click to slide
      // the panel off-screen leaving only the handle.
      let handle = this.el.querySelector('.wg-collapse');
      if(!handle){
        handle = document.createElement('button');
        handle.className = 'wg-collapse';
        handle.type = 'button';
        handle.setAttribute('aria-label', 'Collapse controls');
        this.el.prepend(handle);
      }
      const KEY = 'wa.panel.collapsed';
      const apply = (collapsed) => {
        this.el.classList.toggle('collapsed', !!collapsed);
        document.body.classList.toggle('panel-collapsed', !!collapsed);
        handle.setAttribute('aria-label', collapsed ? 'Expand controls' : 'Collapse controls');
        // The .wa-stage right inset toggles via CSS the moment .panel-collapsed
        // flips, so stage.clientWidth is already new. But the panel itself
        // slides under a 220ms transition — schedule a second resize after
        // the slide settles in case any effect's layout depends on the slot
        // having fully cleared.
        const kick = () => {
          // Re-run applyRatio so the canvas style W/H pick up the new
          // stage.clientWidth AND fire the resize event that effect.js'
          // fitCanvas() listens to.
          window.PIXSource?.applyRatio?.();
          window.dispatchEvent(new Event('resize'));
        };
        kick();
        setTimeout(kick, 260);
      };
      apply(localStorage.getItem(KEY) === '1');
      handle.addEventListener('click', () => {
        const next = !this.el.classList.contains('collapsed');
        apply(next);
        localStorage.setItem(KEY, next ? '1' : '0');
      });
    }
    _bindRow(row){
      const key = row.dataset.key;
      if(!key) return;
      this.rows.set(key, row);
      if(row.classList.contains('wg-slider')) this._bindSlider(row, key);
      else if(row.classList.contains('wg-bool')) this._bindBool(row, key);
      else if(row.classList.contains('wg-text')) this._bindText(row, key);
      else if(row.classList.contains('wg-color')) this._bindColor(row, key);
      else if(row.classList.contains('wg-select')) this._bindSelect(row, key);
      else if(row.classList.contains('wg-file')) this._bindFile(row, key);
    }
    _bindSelect(row, key){
      // Each wg-select row gets rendered as a row of radio "pills" so a
      // choice is one click and an instant visible change — no dropdown,
      // no select-and-confirm step. The original <select> stays in the DOM
      // (display:none) as the source of truth for accessibility, form
      // serialisation and existing tests; the pills mirror its value.
      const select = row.querySelector('select');
      if(!select) return;
      const widget = row.querySelector('.wg-widget') || row;
      let pillGroup = widget.querySelector('.wg-pills');
      if(!pillGroup){
        pillGroup = document.createElement('div');
        pillGroup.className = 'wg-pills';
        pillGroup.setAttribute('role', 'radiogroup');
        pillGroup.setAttribute('aria-label', key);
        for(const opt of select.options){
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'wg-pill';
          b.dataset.value = opt.value;
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', 'false');
          b.textContent = opt.textContent || opt.value;
          pillGroup.appendChild(b);
        }
        widget.appendChild(pillGroup);
        select.style.display = 'none';
      }
      const pills = [...pillGroup.querySelectorAll('.wg-pill')];
      const write = (v) => {
        this.params[key] = v;
        select.value = String(v);
        for(const p of pills){
          const on = p.dataset.value === String(v);
          p.classList.toggle('active', on);
          p.setAttribute('aria-checked', on ? 'true' : 'false');
        }
        this.emit(key);
      };
      row._write = write;
      // Hydrate from PIXSource for shared keys (ratio/fit/bg/etc) so pills
      // reflect the persisted cross-effect choice; fall back to effect
      // params; final fallback to the markup default.
      let initial;
      if(window.PIXSource && window.PIXSource.SHARED_KEYS &&
         window.PIXSource.SHARED_KEYS.includes(key) && key in window.PIXSource.params){
        initial = window.PIXSource.params[key];
      } else if(key in this.params){
        initial = this.params[key];
      } else {
        initial = select.value;
      }
      write(initial);
      for(const p of pills){
        p.addEventListener('click', () => write(p.dataset.value));
      }
    }
    _bindFile(row, key){
      // File input row (image/video). data-handler="pix-source" pipes through PIXSource.
      // The native <input type=file> is display:none — its job is purely to host the
      // file picker. The visible label and `+` button proxy clicks to it.
      const input = row.querySelector('input[type=file]');
      const label = row.querySelector('.wg-file-label');
      const openBtn = row.querySelector('.wg-file-open');
      const sampleBtn = row.querySelector('.wg-shuffle');
      const write = (v) => { this.params[key] = v; this.emit(key); };
      row._write = write;
      const openPicker = () => input?.click();
      label?.addEventListener('click', openPicker);
      openBtn?.addEventListener('click', openPicker);
      input?.addEventListener('change', () => {
        const f = input.files && input.files[0];
        if(!f) return;
        if(label) label.textContent = f.name.length > 18 ? f.name.slice(0, 15) + '…' : f.name;
        if(window.PIXSource && row.dataset.handler === 'pix-source'){
          window.PIXSource.loadFile(f).catch(err => console.warn(err));
        }
        write(f.name);
        // Native <input type=file> won't re-fire `change` if the same filename
        // is picked twice. Reset the value so consecutive picks of the same
        // file still trigger a reload (useful when re-cropping externally).
        input.value = '';
      });
      sampleBtn?.addEventListener('click', () => {
        if(window.PIXSource && row.dataset.handler === 'pix-source'){
          window.PIXSource.cycleSample();
          if(label) label.textContent = 'sample';
          write('sample');
        }
      });
    }
    _bindSlider(row, key){
      const min = +row.dataset.min, max = +row.dataset.max, step = +row.dataset.step || 0;
      const track = row.querySelector('.wg-track');
      const fill = row.querySelector('.wg-fill');
      const input = row.querySelector('input[type=number]');
      input.min = min; input.max = max; if(step) input.step = step;
      const write = (v) => {
        v = clamp(quantize(v, step), min, max);
        this.params[key] = v;
        const pct = ((v - min) / (max - min)) * 100;
        fill.style.width = pct + '%';
        track.style.setProperty('--wg-knob-x', pct + '%');
        if(document.activeElement !== input) input.value = step >= 1 ? Math.round(v) : (Math.round(v*100)/100);
        this.emit(key);
      };
      row._write = write;
      write(this.params[key]);
      const dragValueAt = (e) => {
        const r = track.getBoundingClientRect();
        const x = clamp(((e.clientX ?? e.touches?.[0]?.clientX) - r.left) / r.width, 0, 1);
        return min + x * (max - min);
      };
      let dragging = false;
      track.addEventListener('pointerdown', (e) => {
        dragging = true; track.setPointerCapture(e.pointerId);
        write(dragValueAt(e));
      });
      track.addEventListener('pointermove', (e) => { if(dragging) write(dragValueAt(e)); });
      track.addEventListener('pointerup',   (e) => { dragging = false; try{track.releasePointerCapture(e.pointerId);}catch(_){} });
      input.addEventListener('input', () => { const n = +input.value; if(!Number.isNaN(n)) write(n); });
    }
    _bindBool(row, key){
      const input = row.querySelector('input[type=checkbox]');
      const write = (v) => { this.params[key] = !!v; input.checked = !!v; this.emit(key); };
      row._write = write;
      write(this.params[key]);
      input.addEventListener('change', () => write(input.checked));
    }
    _bindText(row, key){
      const widget = row.querySelector('.wg-widget');
      const input = row.querySelector('input[type=text]');
      // Inject a shuffle button beside the text input — pulls a fresh
      // phrase from the cross-effect phrase banks.
      if(widget && !widget.querySelector('.wg-shuffle') && window.WAState && window.WAState.randomPhrase){
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-shuffle';
        btn.title = 'Shuffle to a new phrase';
        btn.textContent = '↻';
        btn.addEventListener('click', () => {
          const next = window.WAState.randomPhrase();
          if(!next) return;
          input.value = next;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        widget.appendChild(btn);
      }
      const write = (v) => { this.params[key] = String(v ?? ''); if(document.activeElement !== input) input.value = String(v ?? ''); this.emit(key); };
      row._write = write;
      write(this.params[key]);
      input.addEventListener('input', () => write(input.value));
    }
    _bindColor(row, key){
      const swatch = row.querySelector('.wg-swatch');
      const colorIn = row.querySelector('input[type=color]');
      const textIn = row.querySelector('input[type=text]');
      const write = (v) => {
        const hex = normaliseHex(v) || this.params[key] || '#000000';
        this.params[key] = hex;
        swatch.style.background = hex;
        colorIn.value = hex;
        if(document.activeElement !== textIn) textIn.value = hex.replace('#','');
        this.emit(key);
      };
      row._write = write;
      write(this.params[key]);
      colorIn.addEventListener('input', () => write(colorIn.value));
      textIn.addEventListener('input', () => write('#' + textIn.value.replace(/^#/,'')));
    }
    _writeRow(row, v){ if(row && typeof row._write === 'function') row._write(v); }
  };

  function normaliseHex(s){
    if(!s) return null;
    s = String(s).trim();
    if(/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    if(/^[0-9a-fA-F]{6}$/.test(s)) return ('#' + s).toLowerCase();
    if(/^#[0-9a-fA-F]{3}$/.test(s)){
      const c = s.slice(1).split('').map(ch => ch+ch).join('');
      return '#' + c.toLowerCase();
    }
    return null;
  }
  window.normaliseHex = normaliseHex;
})();
