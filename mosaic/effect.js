// pixart/mosaic — triangulated tile mosaic.
//
// Square grid (cellSize), each cell split along the / diagonal into two
// triangles. Each triangle is filled with the mean colour of its source
// region. Optional vertex jitter pushes the diagonal off-axis so the field
// reads as hand-cut tile rather than a regular grid.
//
// Modes (cosine envelope across cycleMs=20000):
//   shimmer — per-tile brightness modulated by sin(kx + ky + 2π t).
//             A wave of light rolls across the field. Paint-time only.
//   tilt    — each triangle rotates around its centroid by 2π·t.
//             Tiles waltz; loops seamless. Paint-time only.
//   breath  — cellSize scales 0.7×↔1.0× of slider via pingpong.
//             Requires rebuild each frame; cell count keeps it fast.
//
// Interactive: cursor X → cellSize (8..60), cursor Y → jitter (0..1).
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  canvasSize:  600,
  cellSize:    24,
  gap:         0.5,
  jitter:      0.25,
  saturation:  1,
  animate:     false,
  mode:        'shimmer',
  interactive: false,
  showEffect:  true,
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let tiles = null;   // {cx,cy,verts:[6 floats],r,g,b} × N — packed as parallel arrays
let tileCount = 0;
let _builtForCell = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

function schedule(level){
  if(level === 'pre')   dirty.pre = true;
  if(level === 'pre' || level === 'build') dirty.build = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre)   preprocess();
    if(dirty.build) buildTiles();
    paint();
    dirty.pre = dirty.build = dirty.paint = false;
  });
}

function fitCanvas(){
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = params.canvasSize;
  const H = Math.max(1, Math.round(W * aspect));
  if(srcBuf.width !== W || srcBuf.height !== H){ srcBuf.width = W; srcBuf.height = H; }
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  preprocessed = sctx.getImageData(0, 0, W, H);
}

// Deterministic per-cell jitter (stable across frames) via cheap hash.
function hash01(i, j, k){
  let h = (i * 374761393) ^ (j * 668265263) ^ (k * 2147483647);
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 10000) / 10000;
}

function buildTiles(){
  if(!preprocessed){ tileCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const px = preprocessed.data;
  const cs = Math.max(2, params.cellSize | 0);
  const jit = params.jitter;
  const cols = Math.ceil(W / cs);
  const rows = Math.ceil(H / cs);
  const cap = cols * rows * 2;
  // Per-tile: cx,cy, x0,y0,x1,y1,x2,y2, r,g,b — 11 floats.
  if(!tiles || tiles.length < cap * 11) tiles = new Float32Array(cap * 11);

  let n = 0;
  for(let j = 0; j < rows; j++){
    for(let i = 0; i < cols; i++){
      const x0 = i * cs, y0 = j * cs;
      const x1 = Math.min(W, x0 + cs), y1 = Math.min(H, y0 + cs);

      // Mean colour over the cell (single quick block sample).
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      const step = Math.max(1, (cs / 6) | 0);
      for(let y = y0; y < y1; y += step){
        for(let x = x0; x < x1; x += step){
          const o = (x + y * W) * 4;
          rSum += px[o]; gSum += px[o+1]; bSum += px[o+2];
          count++;
        }
      }
      if(count === 0) continue;
      const r = rSum / count, g = gSum / count, b = bSum / count;

      // Diagonal vertex with optional jitter.
      const jx = (hash01(i, j, 1) - 0.5) * cs * jit;
      const jy = (hash01(i, j, 2) - 0.5) * cs * jit;
      const mx = (x0 + x1) / 2 + jx;
      const my = (y0 + y1) / 2 + jy;

      // Triangle A: top-left, top-right, midpoint
      const oa = n * 11;
      tiles[oa]   = (x0 + x1) / 2; tiles[oa+1] = (y0 + y1) / 2;
      tiles[oa+2] = x0; tiles[oa+3] = y0;
      tiles[oa+4] = x1; tiles[oa+5] = y0;
      tiles[oa+6] = mx; tiles[oa+7] = my;
      tiles[oa+8] = r; tiles[oa+9] = g; tiles[oa+10] = b;
      n++;

      // Triangle B: bottom-left, bottom-right, midpoint
      const ob = n * 11;
      tiles[ob]   = (x0 + x1) / 2; tiles[ob+1] = (y0 + y1) / 2;
      tiles[ob+2] = x0; tiles[ob+3] = y1;
      tiles[ob+4] = x1; tiles[ob+5] = y1;
      tiles[ob+6] = mx; tiles[ob+7] = my;
      tiles[ob+8] = r; tiles[ob+9] = g; tiles[ob+10] = b;
      n++;
    }
  }
  tileCount = n;
  _builtForCell = cs;
}

// Paint-time modulation state.
let _shimmerPhase = 0;
let _tiltPhase = 0;

function paint(){
  window.WAGUI?.flashValues(params);
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!preprocessed){ ctx.restore(); return; }
  if(!params.showEffect){
    const aspect = preprocessed.width / preprocessed.height;
    let dw, dh;
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }
  if(tileCount === 0){ ctx.restore(); return; }

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  const fitScale = dw / sw;
  const ox = (W - dw) / 2;
  const oy = (H - dh) / 2;

  const gap = Math.max(0, params.gap) * fitScale;
  const sat = params.saturation;
  const useTilt = _tiltPhase !== 0;
  const tiltCos = Math.cos(_tiltPhase);
  const tiltSin = Math.sin(_tiltPhase);

  for(let k = 0; k < tileCount; k++){
    const o = k * 11;
    let r = tiles[o+8], g = tiles[o+9], b = tiles[o+10];

    // Saturation around per-pixel mean.
    if(sat !== 1){
      const m = (r + g + b) / 3;
      r = clamp(m + (r - m) * sat, 0, 255);
      g = clamp(m + (g - m) * sat, 0, 255);
      b = clamp(m + (b - m) * sat, 0, 255);
    }

    // Shimmer brightness modulation.
    if(_shimmerPhase !== 0){
      const cx = tiles[o], cy = tiles[o+1];
      const w = Math.sin(cx * 0.025 + cy * 0.025 + _shimmerPhase);
      const k2 = 1 + w * 0.35;
      r = clamp(r * k2, 0, 255);
      g = clamp(g * k2, 0, 255);
      b = clamp(b * k2, 0, 255);
    }

    const cx = tiles[o], cy = tiles[o+1];
    let p0x = tiles[o+2] - cx, p0y = tiles[o+3] - cy;
    let p1x = tiles[o+4] - cx, p1y = tiles[o+5] - cy;
    let p2x = tiles[o+6] - cx, p2y = tiles[o+7] - cy;

    // Gap: pull each vertex toward the centroid by `gap` source-pixels.
    if(gap > 0){
      const shrink = (gap / fitScale) / params.cellSize;
      p0x *= (1 - shrink); p0y *= (1 - shrink);
      p1x *= (1 - shrink); p1y *= (1 - shrink);
      p2x *= (1 - shrink); p2y *= (1 - shrink);
    }

    // Tilt: rotate around centroid by tilt phase.
    if(useTilt){
      const a0x = p0x * tiltCos - p0y * tiltSin;
      const a0y = p0x * tiltSin + p0y * tiltCos;
      const a1x = p1x * tiltCos - p1y * tiltSin;
      const a1y = p1x * tiltSin + p1y * tiltCos;
      const a2x = p2x * tiltCos - p2y * tiltSin;
      const a2y = p2x * tiltSin + p2y * tiltCos;
      p0x = a0x; p0y = a0y;
      p1x = a1x; p1y = a1y;
      p2x = a2x; p2y = a2y;
    }

    const sx = ox + cx * fitScale;
    const sy = oy + cy * fitScale;

    ctx.fillStyle = 'rgb(' + (r|0) + ',' + (g|0) + ',' + (b|0) + ')';
    ctx.beginPath();
    ctx.moveTo(sx + p0x * fitScale, sy + p0y * fitScale);
    ctx.lineTo(sx + p1x * fitScale, sy + p1y * fitScale);
    ctx.lineTo(sx + p2x * fitScale, sy + p2y * fitScale);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ---------- animation ----------
const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;
function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'shimmer'){
    _shimmerPhase = t01 * Math.PI * 2;
    return () => { _shimmerPhase = 0; };
  }
  if(mode === 'tilt'){
    _tiltPhase = t01 * Math.PI * 2;
    return () => { _tiltPhase = 0; };
  }
  if(mode === 'breath'){
    const base = params.cellSize;
    params.cellSize = Math.max(4, Math.round(base * (0.7 + 0.3 * pingPong(t01))));
    return () => { params.cellSize = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseCell = params.cellSize;
  const baseJit  = params.jitter;
  params.cellSize = Math.max(4, Math.round(8 + ax * 52));
  params.jitter   = ay;
  return () => { params.cellSize = baseCell; params.jitter = baseJit; };
}

function renderAt(t01){
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  if(params.cellSize !== _builtForCell) buildTiles();
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
function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  hasMouse = true;
  if(params.interactive && !params.animate) renderAt(0);
}

window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){ if(params.animate) startAnimation(); else paint(); return cv; },
};

const PRE_KEYS   = new Set(['canvasSize','fit','bg']);
const BUILD_KEYS = new Set(['cellSize','jitter']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('paint'); }
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
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){ window.PIXSource.onChange(() => schedule('pre')); }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-mosaic',
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
document.addEventListener('DOMContentLoaded', init);
