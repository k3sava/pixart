// pixart/collapse — Color grid cells that shrink to dot centroids and re-expand.
//
// The image is divided into a regular grid of cells. Each cell computes its
// average colour. During animation, cells progressively shrink from their
// full tile size toward a 1-pixel dot at the centre (showing the average
// colour), then re-expand back. The effect creates a mosaic that breathes
// between photo and colour abstraction.
//
// Algorithm:
//   1. preprocess: draw source → srcBuf, apply standard filters.
//   2. buildOutput: for every cell, compute average R,G,B from the source
//      pixel data. Store cells array with position, size, and avgColor.
//   3. paint: draw each cell at a size governed by collapseFactor f:
//        f=0 → full tile (shows source region scaled).
//        f=1 → 1px dot (shows average colour only).
//        0<f<1 → lerped tile showing average colour (clean solid fill).
//
// Modes:
//   collapse — each cell has a random phase offset so cells breathe
//              asynchronously, creating a shimmering wave of collapse.
//   dissolve — all cells move together (synchronised pingpong).
//   cascade  — cells collapse row by row from top to bottom.
//
// Interactive: X → cellSize (8..80), Y → sets collapseFactor directly (0→1)
//              so you can scrub through the collapse by moving the cursor.
//
// WAEffect contract: { cycleMs: 20000, renderAt(t), pauseRender(), resumeRender() }
'use strict';

const CYCLE_MS = 20000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  canvasSize:  600,
  fit:         'cover',
  bg:          '#0a0a0a',
  blur:        0,
  grain:       0,
  gamma:       1,
  blackPoint:  0,
  whitePoint:  255,
  // Collapse-specific.
  cellSize:    24,   // 8..80, step 2
  // Animation / interactive.
  animate:     false,
  mode:        'collapse',
  interactive: false,
  showEffect:  true,
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let cells        = null;   // Array of { x, y, w, h, r, g, b, phase }
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

// Deterministic pseudo-random seeded by cell index (mulberry32 one-shot).
function seededRand(seed){
  let a = (seed ^ 0xDEAD1337) >>> 0;
  a = (a + 0x6D2B79F5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Smooth 0→1→0 pingpong using cosine.
function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function schedule(level){
  if(level === 'pre') dirty.pre = true;
  if(level === 'pre' || level === 'build') dirty.build = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre)   preprocess();
    if(dirty.build) buildOutput();
    paint();
    dirty.pre = dirty.build = dirty.paint = false;
  });
}

function fitCanvas(){
  const w = cv.clientWidth  || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ---------- preprocessor ----------
function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = (window.PIXSource?.height || srcCv.height) /
                 (window.PIXSource?.width  || srcCv.width);
  const W = params.canvasSize;
  const H = Math.max(1, Math.round(W * aspect));
  if(srcBuf.width !== W || srcBuf.height !== H){
    srcBuf.width = W; srcBuf.height = H;
  }

  sctx.save();
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  sctx.restore();

  if(params.blur > 0){
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const t = tmp.getContext('2d');
    t.filter = `blur(${params.blur}px)`;
    t.drawImage(srcBuf, 0, 0);
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(tmp, 0, 0);
  }

  const id = sctx.getImageData(0, 0, W, H);
  const px = id.data;
  const g   = params.grain;
  const gm  = params.gamma;
  const bp  = params.blackPoint;
  const wp  = params.whitePoint;
  const span  = Math.max(1, wp - bp);
  const scale = 255 / span;
  const rnd = Math.random;
  const doGrain  = g  !== 0;
  const doGamma  = gm !== 1;
  const doLevels = bp !== 0 || wp !== 255;
  let lut = null;
  if(doGamma){
    lut = new Uint8ClampedArray(256);
    for(let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, gm));
  }
  for(let i = 0; i < px.length; i += 4){
    let r = px[i], gg = px[i+1], b = px[i+2];
    if(doGrain){
      const n = (0.5 - rnd()) * g * 255;
      r  = clamp(r  + n, 0, 255);
      gg = clamp(gg + n, 0, 255);
      b  = clamp(b  + n, 0, 255);
    }
    if(doGamma){
      r  = lut[r  | 0];
      gg = lut[gg | 0];
      b  = lut[b  | 0];
    }
    if(doLevels){
      r  = clamp((r  - bp) * scale, 0, 255);
      gg = clamp((gg - bp) * scale, 0, 255);
      b  = clamp((b  - bp) * scale, 0, 255);
    }
    px[i] = r; px[i+1] = gg; px[i+2] = b;
  }
  sctx.putImageData(id, 0, 0);
  preprocessed = id;
}

// ---------- build ----------
function buildOutput(){
  if(!preprocessed){ cells = null; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const px = preprocessed.data;
  const cs = Math.max(2, params.cellSize | 0);

  const cols = Math.ceil(W / cs);
  const rows = Math.ceil(H / cs);

  cells = new Array(cols * rows);
  let idx = 0;

  for(let row = 0; row < rows; row++){
    for(let col = 0; col < cols; col++){
      const x0 = col * cs;
      const y0 = row * cs;
      const x1 = Math.min(x0 + cs, W);
      const y1 = Math.min(y0 + cs, H);
      const cw = x1 - x0;
      const ch = y1 - y0;

      let sumR = 0, sumG = 0, sumB = 0, count = 0;
      for(let py = y0; py < y1; py++){
        const rowOff = py * W;
        for(let px2 = x0; px2 < x1; px2++){
          const pi = (rowOff + px2) * 4;
          sumR += px[pi]; sumG += px[pi+1]; sumB += px[pi+2];
          count++;
        }
      }
      const avgR = count > 0 ? sumR / count : 0;
      const avgG = count > 0 ? sumG / count : 0;
      const avgB = count > 0 ? sumB / count : 0;

      cells[idx] = {
        x: x0, y: y0, w: cw, h: ch,
        r: avgR, g: avgG, b: avgB,
        // Random phase [0,1) for async collapse mode.
        phase: seededRand(idx),
        row, col, numRows: rows,
      };
      idx++;
    }
  }
}

// ---------- animation state ----------
let _animT01   = 0;
let _cursorF   = -1; // -1 = not active; 0..1 = interactive override

// ---------- paint ----------
function paint(){
  window.WAGUI?.flashValues(params);
  fitCanvas();
  const cW = cv.width, cH = cv.height;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, cW, cH);

  if(!preprocessed){ ctx.restore(); return; }

  const W = srcBuf.width, H = srcBuf.height;
  const aspect = W / H;
  let dw, dh;
  if(cW / cH > aspect){ dh = cH; dw = dh * aspect; }
  else                 { dw = cW; dh = dw / aspect; }
  const ox = (cW - dw) / 2;
  const oy = (cH - dh) / 2;

  if(!params.showEffect || !cells){
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcBuf, ox, oy, dw, dh);
    ctx.restore();
    return;
  }

  const scaleX = dw / W;
  const scaleY = dh / H;
  const t      = _animT01;
  const mode   = params.mode;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  for(let i = 0; i < cells.length; i++){
    const cell = cells[i];

    // Compute collapseFactor f in [0,1].
    let f;
    if(_cursorF >= 0){
      // Interactive override: cursor Y directly drives f.
      f = _cursorF;
    } else if(mode === 'dissolve'){
      // All cells move together.
      f = pingPong(t);
    } else if(mode === 'collapse'){
      // Each cell has a random phase offset for async collapse.
      const shifted = (t + cell.phase * 0.35) % 1;
      f = pingPong(shifted);
    } else {
      // cascade: cells collapse row by row from top to bottom.
      const rowDelay = (cell.row / cell.numRows) * 0.7;
      const localT   = clamp((t - rowDelay) / 0.3, 0, 1);
      f = pingPong(localT);
    }

    f = clamp(f, 0, 1);

    // Cell screen rect (in canvas space).
    const sx = ox + cell.x * scaleX;
    const sy = oy + cell.y * scaleY;
    const sw = cell.w * scaleX;
    const sh = cell.h * scaleY;

    // Compute shrunken draw rect centered on the cell.
    const drawW = Math.max(1, sw * (1 - f));
    const drawH = Math.max(1, sh * (1 - f));
    const drawX = sx + (sw - drawW) / 2;
    const drawY = sy + (sh - drawH) / 2;

    if(f < 0.5){
      // Show source image region scaled into the shrinking rect.
      ctx.drawImage(srcBuf,
        cell.x, cell.y, cell.w, cell.h,
        drawX, drawY, drawW, drawH);
    } else {
      // Fill with average colour.
      ctx.fillStyle = `rgb(${cell.r | 0},${cell.g | 0},${cell.b | 0})`;
      ctx.fillRect(drawX, drawY, drawW, drawH);
    }
  }

  ctx.restore();
}

// ---------- animation ----------
let animationId        = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function applyMode(t01){
  _animT01 = t01;
  return () => { _animT01 = 0; };
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r  = cv.getBoundingClientRect();
  const ax = clamp(mouseX / (r.width  || 1), 0, 1);
  const ay = clamp(mouseY / (r.height || 1), 0, 1);

  // X → cellSize (8..80), Y → collapseFactor override.
  const baseSize = params.cellSize;
  const prevF    = _cursorF;
  params.cellSize = Math.round(8 + ax * 72);
  // Only rebuild cells if cellSize actually changed.
  if(params.cellSize !== baseSize) buildOutput();
  _cursorF = ay; // 0=full, 1=collapsed
  return () => {
    params.cellSize = baseSize;
    _cursorF = prevF;
  };
}

function renderAt(t01){
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  paint();
  restoreInt();
  restoreMode();
}

function animationLoop(){
  if(!params.animate){ animationId = null; return; }
  const elapsed = performance.now() - animationStartTime;
  renderAt((elapsed % CYCLE_MS) / CYCLE_MS);
  animationId = requestAnimationFrame(animationLoop);
}

function startAnimation(){
  if(animationId) return;
  animationStartTime = performance.now();
  animationLoop();
}
function stopAnimation(){
  if(animationId){ cancelAnimationFrame(animationId); animationId = null; }
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else paint();
    return cv;
  },
};

// Pipeline key sets.
const PRE_KEYS   = new Set(['canvasSize','blur','grain','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['cellSize']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation(); else { stopAnimation(); schedule('paint'); }
      return;
    }
    if(key === 'mode' || key === 'interactive'){
      if(!params.animate) schedule('paint');
      return;
    }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(params.animate) return;
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  cv.addEventListener('mousemove', e => {
    const r = cv.getBoundingClientRect();
    mouseX = e.clientX - r.left; mouseY = e.clientY - r.top; hasMouse = true;
    if(params.interactive && !params.animate) renderAt(0);
  });
  cv.addEventListener('mouseleave', () => {
    hasMouse = false; _cursorF = -1;
    if(!params.animate) schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-collapse',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
  if(params.animate) startAnimation();
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
