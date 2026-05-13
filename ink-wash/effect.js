// pixart/ink-wash — sumi-e / Japanese ink-painting stylisation.
//
// Pipeline: Sobel edges become brushstrokes. Stroke radius scales with edge
// magnitude × pressure. Stroke alpha scales with inkDensity, modulated by a
// symmetric dry-brush falloff so stroke ends fade. A Gaussian blur of the
// stroke layer lays down a bleed halo beneath the strokes. Paper grain is
// deterministic value-noise tinted with ink, alpha-overlaid on the paper
// tone. Output reads as monochrome sumi-e on warm washi.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const inkBuf  = document.createElement('canvas');
const inkCtx  = inkBuf.getContext('2d');
const bleedBuf = document.createElement('canvas');
const bleedCtx = bleedBuf.getContext('2d');

const PAPER_TYPES = {
  kozo:     { tone: '#f0e8d4' },
  mulberry: { tone: '#ece8dc' },
  gampi:    { tone: '#f5edc8' },
  bamboo:   { tone: '#e8dbb0' },
};

// Fixed deterministic seed for paper grain RNG.
const GRAIN_SEED = 7;

const params = {
  canvasSize:    600,
  blurAmount:    0,
  grainAmount:   0,
  gamma:         1,
  blackPoint:    0,
  whitePoint:    255,
  inkColor:      '#0d0d0d',
  paperColor:    '#f0e8d4',
  brushPressure: 1.0,
  inkDensity:    0.85,
  bleed:         8,
  dryBrush:      0.4,
  paperGrain:    0.25,
  paperType:     'kozo',
  animate:       false,
  mode:          'breath',
  interactive:   false,
  showEffect:    true,
  fit:           'cover',
  bg:            '#1a1612',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let edgeMag = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex){
  const m = /^#?([a-f0-9]{6})$/i.exec(hex || '');
  if(!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function schedule(level){
  if(level === 'pre') dirty.pre = true;
  if(level === 'pre' || level === 'build') dirty.build = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre)   preprocess();
    if(dirty.build) buildEdges();
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
  if(srcBuf.width !== W || srcBuf.height !== H){
    srcBuf.width = W; srcBuf.height = H;
    inkBuf.width = W; inkBuf.height = H;
    bleedBuf.width = W; bleedBuf.height = H;
  }
  sctx.save();
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  sctx.restore();

  const id = sctx.getImageData(0, 0, W, H);
  preprocessed = id;
}

function buildEdges(){
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;
  const px = preprocessed.data;
  const N = W * H;
  if(!edgeMag || edgeMag.length !== N){
    edgeMag = new Float32Array(N);
  } else {
    edgeMag.fill(0);
  }
  const lum = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    lum[j] = 0.299 * px[i] + 0.587 * px[i+1] + 0.114 * px[i+2];
  }
  for(let y = 1; y < H - 1; y++){
    const yi0 = (y - 1) * W, yi1 = y * W, yi2 = (y + 1) * W;
    for(let x = 1; x < W - 1; x++){
      const p00 = lum[yi0 + x - 1], p01 = lum[yi0 + x], p02 = lum[yi0 + x + 1];
      const p10 = lum[yi1 + x - 1],                       p12 = lum[yi1 + x + 1];
      const p20 = lum[yi2 + x - 1], p21 = lum[yi2 + x], p22 = lum[yi2 + x + 1];
      const gx = -p00 + p02 - 2*p10 + 2*p12 - p20 + p22;
      const gy = -p00 - 2*p01 - p02 + p20 + 2*p21 + p22;
      edgeMag[yi1 + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
}

function renderInkAndBleed(){
  if(!preprocessed || !edgeMag) return;
  const W = preprocessed.width, H = preprocessed.height;

  const paperHex = params.paperColor;
  inkCtx.save();
  inkCtx.globalCompositeOperation = 'source-over';
  inkCtx.fillStyle = paperHex;
  inkCtx.fillRect(0, 0, W, H);

  if(params.paperGrain > 0){
    const rng = mulberry32(GRAIN_SEED);
    const grainImg = inkCtx.createImageData(W, H);
    const gdata = grainImg.data;
    const inkRgb = hexToRgb(params.inkColor);
    const alphaScale = params.paperGrain * 255;
    for(let i = 0; i < gdata.length; i += 4){
      const v = (rng() * 0.65 + rng() * 0.35);
      const a = Math.max(0, (v - 0.55)) * alphaScale;
      gdata[i] = inkRgb.r; gdata[i+1] = inkRgb.g; gdata[i+2] = inkRgb.b;
      gdata[i+3] = a;
    }
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    tmp.getContext('2d').putImageData(grainImg, 0, 0);
    inkCtx.globalAlpha = 1;
    inkCtx.drawImage(tmp, 0, 0);
  }

  const baseTh = 40;
  const pressure = clamp(params.brushPressure, 0, 4);
  const density  = clamp(params.inkDensity, 0, 1);
  const dryBrush = clamp(params.dryBrush, 0, 1);
  const ink = hexToRgb(params.inkColor);
  inkCtx.fillStyle = `rgb(${ink.r},${ink.g},${ink.b})`;
  inkCtx.globalCompositeOperation = 'source-over';

  for(let y = 1; y < H - 1; y++){
    for(let x = 1; x < W - 1; x++){
      const m = edgeMag[y * W + x];
      if(m < baseTh) continue;
      const mN = clamp((m - baseTh) / (200 - baseTh), 0, 1);
      const r = (0.4 + mN * 1.6) * pressure;
      if(r < 0.25) continue;
      const dry = 1 - dryBrush * (1 - 4 * mN * (1 - mN));
      const a = density * dry;
      if(a <= 0.01) continue;
      inkCtx.globalAlpha = a;
      inkCtx.beginPath();
      inkCtx.arc(x, y, r, 0, Math.PI * 2);
      inkCtx.fill();
    }
  }
  inkCtx.globalAlpha = 1;
  inkCtx.restore();

  const bleedR = Math.max(0, params.bleed);
  if(bleedR > 0.5){
    bleedCtx.save();
    bleedCtx.clearRect(0, 0, W, H);
    bleedCtx.filter = `blur(${bleedR}px)`;
    bleedCtx.drawImage(inkBuf, 0, 0);
    bleedCtx.filter = 'none';
    inkCtx.save();
    inkCtx.globalCompositeOperation = 'destination-over';
    inkCtx.globalAlpha = 0.55;
    inkCtx.drawImage(bleedBuf, 0, 0);
    inkCtx.restore();
    bleedCtx.restore();
  }
}

function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);
  if(!preprocessed){ ctx.restore(); return; }

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if(!params.showEffect){
    ctx.drawImage(srcBuf, ox, oy, dw, dh);
    ctx.restore();
    return;
  }

  renderInkAndBleed();
  ctx.drawImage(inkBuf, ox, oy, dw, dh);
  ctx.restore();
}

// ---------- animation ----------
// Modes (all cosine-modulated across cycleMs=15000):
//   breath — brushPressure pingpongs 0.4 ↔ 1.6 (strokes thicken/thin).
//   bleed  — bleed pingpongs 2 ↔ 22 (ink halo spreads/contracts).
//   dry    — dryBrush pingpongs 0.05 ↔ 0.9 (full stroke ↔ broken stroke).
// Interactive: cursor X → brushPressure 0.3..2, cursor Y → bleed 0..30.
const CYCLE_MS = 15000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'breath'){
    const base = params.brushPressure;
    params.brushPressure = 0.4 + 1.2 * pingPong(t01);
    return () => { params.brushPressure = base; };
  }
  if(mode === 'bleed'){
    const base = params.bleed;
    params.bleed = 2 + 20 * pingPong(t01);
    return () => { params.bleed = base; };
  }
  if(mode === 'dry'){
    const base = params.dryBrush;
    params.dryBrush = 0.05 + 0.85 * pingPong(t01);
    return () => { params.dryBrush = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseP = params.brushPressure;
  const baseB = params.bleed;
  params.brushPressure = 0.3 + ax * 1.7;
  params.bleed = ay * 30;
  return () => { params.brushPressure = baseP; params.bleed = baseB; };
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

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  hasMouse = true;
  if(params.interactive && !params.animate){
    renderAt(0);
  }
}

window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else { paint(); }
    return cv;
  },
};

const PRE_KEYS   = new Set(['fit','bg']);
const BUILD_KEYS = new Set([]);
const PAINT_KEYS = new Set(['inkColor','paperColor','brushPressure','inkDensity','bleed','dryBrush','paperGrain','paperType','showEffect']);

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
    if(params.animate) return;
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(key === 'paperType'){
      const pt = PAPER_TYPES[params.paperType];
      if(pt){
        params.paperColor = pt.tone;
        gui?.rows.get('paperColor')?._write(pt.tone);
      }
      schedule('paint');
      return;
    }
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(params.animate) startAnimation();
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-ink-wash',
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
