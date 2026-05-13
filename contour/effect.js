// pixart/contour — isoline topography on source luminance.
//
// Marching squares (Lorensen & Cline, SIGGRAPH 1987 — 2D specialisation).
// Per cell of the luminance grid: compute a 4-bit case index from corners
// above/below the isovalue, look up 0/1/2 line segments in the 16-case
// table, place endpoints by LINEAR INTERPOLATION along the crossing edge,
// stroke. Repeat for each of `levels` evenly-spaced isovalues.
//
// Output reads as a topographic-map drawing on cream paper: face shape,
// cheeks, brow ridge, hair mass, all traced by concentric contours.
'use strict';

const CYCLE_MS = 0;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  levels:      12,
  smoothing:   0.5,
  lineWidth:   1.2,
  lineColor:   '#0d0d0d',
  bgColor:     '#f4ead2',
  fillBands:   false,
  showEffect:  true,
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let lumGrid = null;
let lumW = 0, lumH = 0;
let dirty = { pre: true, paint: true };
let rafQueued = false;

// ── helpers ──────────────────────────────────────────────────
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

function schedule(level){
  if(level === 'pre') dirty.pre = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre) preprocess();
    paint();
    dirty.pre = dirty.paint = false;
  });
}

function fitCanvas(){
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ── preprocessor: draw source, smooth, compute Rec.709 luminance ─────
function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = 600;
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

  const smooth = clamp(params.smoothing, 0, 1) * 4;
  if(smooth > 0){
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const t = tmp.getContext('2d');
    t.filter = `blur(${smooth.toFixed(2)}px)`;
    t.drawImage(srcBuf, 0, 0);
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(tmp, 0, 0);
  }

  const id = sctx.getImageData(0, 0, W, H);
  const px = id.data;
  preprocessed = id;

  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    lumGrid[j] = 0.2126 * px[i] + 0.7152 * px[i+1] + 0.0722 * px[i+2];
  }
  lumW = W; lumH = H;
}

// ── marching squares 16-case table ───────────────────────────
// Edge ids: 0=top, 1=right, 2=bottom, 3=left.
const CASES = [
  [],
  [[3, 0]],
  [[0, 1]],
  [[3, 1]],
  [[2, 1]],
  [[3, 0], [2, 1]], // ambiguous (5)
  [[0, 2]],
  [[3, 2]],
  [[3, 2]],
  [[0, 2]],
  [[3, 2], [0, 1]], // ambiguous (10)
  [[2, 1]],
  [[3, 1]],
  [[0, 1]],
  [[3, 0]],
  [],
];

function edgePoint(edge, x, y, tl, tr, br, bl, th){
  switch(edge){
    case 0: { const t = (th - tl) / ((tr - tl) || 1e-6); return [x + clamp(t, 0, 1), y]; }
    case 1: { const t = (th - tr) / ((br - tr) || 1e-6); return [x + 1, y + clamp(t, 0, 1)]; }
    case 2: { const t = (th - bl) / ((br - bl) || 1e-6); return [x + clamp(t, 0, 1), y + 1]; }
    case 3: { const t = (th - tl) / ((bl - tl) || 1e-6); return [x, y + clamp(t, 0, 1)]; }
  }
  return [x, y];
}

function traceLevel(th, ox, oy, scale, strokeColor){
  const W = lumW, H = lumH;
  ctx.strokeStyle = strokeColor;
  ctx.beginPath();
  for(let y = 0; y < H - 1; y++){
    const yOff = y * W;
    for(let x = 0; x < W - 1; x++){
      const i = x + yOff;
      const tl = lumGrid[i];
      const tr = lumGrid[i + 1];
      const bl = lumGrid[i + W];
      const br = lumGrid[i + W + 1];
      let ci = 0;
      if(tl > th) ci |= 8;
      if(tr > th) ci |= 4;
      if(br > th) ci |= 2;
      if(bl > th) ci |= 1;
      if(ci === 0 || ci === 15) continue;
      let segList = CASES[ci];
      if(ci === 5 || ci === 10){
        const avg = (tl + tr + br + bl) * 0.25;
        if(avg > th){
          segList = ci === 5 ? [[0, 1], [2, 3]] : [[3, 2], [0, 1]];
        }
      }
      for(let s = 0; s < segList.length; s++){
        const [eA, eB] = segList[s];
        const [ax, ay] = edgePoint(eA, x, y, tl, tr, br, bl, th);
        const [bx, by] = edgePoint(eB, x, y, tl, tr, br, bl, th);
        ctx.moveTo(ox + ax * scale, oy + ay * scale);
        ctx.lineTo(ox + bx * scale, oy + by * scale);
      }
    }
  }
  ctx.stroke();
}

function paintBands(ox, oy, scale, levels){
  const W = lumW, H = lumH;
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const octx2 = off.getContext('2d');
  const id = octx2.createImageData(W, H);
  const d = id.data;
  const N = levels.length;
  for(let i = 0, j = 0; i < d.length; i += 4, j++){
    const L = lumGrid[j];
    let b = N;
    for(let k = 0; k < N; k++){ if(L < levels[k]){ b = k; break; } }
    const v = Math.round(255 * (b / N));
    d[i] = v; d[i+1] = v; d[i+2] = v; d[i+3] = 255;
  }
  octx2.putImageData(id, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, ox, oy, W * scale, H * scale);
}

// ── paint ────────────────────────────────────────────────────
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!lumGrid){ ctx.restore(); return; }

  const aspect = lumW / lumH;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / lumW;

  ctx.fillStyle = params.bgColor;
  ctx.fillRect(ox, oy, dw, dh);

  if(!params.showEffect){
    // Draw the smoothed source through, no contour overlay.
    if(preprocessed){
      const off = document.createElement('canvas');
      off.width = lumW; off.height = lumH;
      off.getContext('2d').putImageData(preprocessed, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, ox, oy, dw, dh);
    }
    ctx.restore();
    return;
  }

  const N = Math.max(2, Math.round(params.levels));
  const lo = 16, hi = 240;
  const span = (hi - lo) / (N + 1);
  const levels = [];
  for(let k = 1; k <= N; k++) levels.push(lo + k * span);

  if(params.fillBands){
    paintBands(ox, oy, scale, levels);
  }

  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(0.3, params.lineWidth) * Math.max(0.6, scale * 0.6);

  for(let k = 0; k < levels.length; k++){
    traceLevel(levels[k], ox, oy, scale, params.lineColor);
  }

  ctx.restore();
}

// ── WAEffect contract (no animation) ─────────────────────────
window.WAEffect = {
  cycleMs: 0,
  renderAt: () => paint(),
  pauseRender: () => {},
  resumeRender: () => paint(),
};

const PRE_KEYS = new Set(['smoothing','fit','bg']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(PRE_KEYS.has(key)) schedule('pre');
    else                  schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-contour',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
}

document.addEventListener('DOMContentLoaded', init);
