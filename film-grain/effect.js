// pixart/film-grain — cinematic film-stock emulation (static).
//
// Pipeline applied to the source frame:
//   1. Film-stock LUT       — per-stock 1-D tone curves applied per-channel.
//                             (Portra 400, Vision3 5219, Ektar 100, Velvia 50,
//                              Tri-X 400, Cinestill 800T).
//   2. Halation             — bright pixels bleed RED through a separable
//                             box-blur. Cinestill's defining trait (remjet
//                             anti-halation layer removed; red light scatters
//                             back through the emulsion around highlights).
//   3. Temperature tint     — additive warm/cool shift on R↔B.
//   4. Grain                — deterministic mulberry32 luminance noise.
//   5. Vignette             — radial darkening (quadratic falloff).
//
// Step 2 (pattern-set): animation + interactive cursor layered on top.
//
// Defaults were chosen by sweeping each control alone against `portrait.jpg` in
// Playwright. Sweet spot for "shot on film AND portrait stays recognizable":
//
//   filmStock=portra-400 — neutral cinematic skin tones.
//   grainAmount=0.3      — visible grain texture, face still reads.
//   halation=0.4         — gentle red bleed in highlights without melting.
//   vignette=0.3         — corners gently darken; subject pops.
//   temperature=0        — neutral; mode shifts it.
//
// Animation modes (each = a gentle cosine envelope across cycleMs=15000):
//
//   breath — grainAmount pingpongs 0.05 ↔ 0.6 (grain density swells/fades).
//   tone   — temperature drifts -0.6 ↔ +0.6 (cool ↔ warm; dusk-to-dawn feel).
//   bloom  — halation pingpongs 0.1 ↔ 0.85 (highlights bloom and recede).
//
// Interactive: cursor X drives halation (0..1, left=clean, right=glowing),
// cursor Y drives grainAmount (0..1, top=fine, bottom=heavy texture).
// Cursor IS the projector lens — bloom across, grain down.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Offscreen buffer for the resampled source.
const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });
// Working buffer for the pipeline output.
const workBuf = document.createElement('canvas');
const wctx    = workBuf.getContext('2d', { willReadFrequently: true });

const params = {
  canvasSize:      600,
  // Film stock LUT (6 named curves).
  filmStock:       'portra-400',
  // Grain controls.
  grainAmount:     0.3,
  grainSize:       1.2,
  // Halation (red-bleed around highlights).
  halation:        0.4,
  halationRadius:  8,
  // Vignette.
  vignette:        0.3,
  // Warm / cool tint.
  temperature:     0,
  // Bypass effect entirely (pass-through source).
  showEffect:      true,
  // Animation + interactive.
  animate:         false,
  mode:            'breath',
  interactive:     false,
  // Shared chrome.
  fit:             'cover',
  bg:              '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

// Fixed seed — the grain pattern is stable across renders.
const GRAIN_SEED = 1337;

let gui;
let resampled = null;
let dirty = { resample: true, paint: true };
let rafQueued = false;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

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

function schedule(level){
  if(level === 'resample') dirty.resample = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.resample) resample();
    paint();
    dirty.resample = dirty.paint = false;
  });
}

function fitCanvas(){
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ---------- resample ----------
function resample(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = params.canvasSize;
  const H = Math.max(1, Math.round(W * aspect));
  if(srcBuf.width !== W || srcBuf.height !== H){
    srcBuf.width = W; srcBuf.height = H;
    workBuf.width = W; workBuf.height = H;
  }
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  resampled = sctx.getImageData(0, 0, W, H);
}

// ---------- film-stock LUTs ----------
const STOCK_LUTS = {};
function buildStockLUTs(){
  const curve = (lo, mid, hi) => i => {
    const t = i / 255;
    const v = t < 0.5
      ? lerp(lo, mid, t * 2)
      : lerp(mid, hi, (t - 0.5) * 2);
    return clamp(Math.round(v * 255), 0, 255);
  };
  STOCK_LUTS['portra-400'] = {
    r: bake(curve(0.06, 0.55, 0.98)),
    g: bake(curve(0.04, 0.50, 0.97)),
    b: bake(curve(0.03, 0.42, 0.94)),
    sat: 0.92,
  };
  STOCK_LUTS['vision3-5219'] = {
    r: bake(curve(0.02, 0.50, 0.95)),
    g: bake(curve(0.03, 0.51, 0.96)),
    b: bake(curve(0.08, 0.54, 0.97)),
    sat: 0.95,
  };
  STOCK_LUTS['ektar-100'] = {
    r: bake(curve(0.00, 0.48, 1.00)),
    g: bake(curve(0.00, 0.47, 1.00)),
    b: bake(curve(0.00, 0.46, 1.00)),
    sat: 1.18,
  };
  STOCK_LUTS['velvia-50'] = {
    r: bake(curve(0.00, 0.45, 1.00)),
    g: bake(curve(0.00, 0.46, 1.00)),
    b: bake(curve(0.00, 0.40, 0.95)),
    sat: 1.35,
  };
  STOCK_LUTS['tri-x-400'] = {
    r: bake(curve(0.02, 0.50, 0.96)),
    g: bake(curve(0.02, 0.50, 0.96)),
    b: bake(curve(0.02, 0.50, 0.96)),
    sat: 0,
  };
  STOCK_LUTS['cinestill-800t'] = {
    r: bake(curve(0.05, 0.56, 1.00)),
    g: bake(curve(0.04, 0.50, 0.94)),
    b: bake(curve(0.10, 0.52, 0.90)),
    sat: 1.02,
    halationBoost: 1.6,
  };
}
function bake(fn){
  const a = new Uint8ClampedArray(256);
  for(let i = 0; i < 256; i++) a[i] = fn(i);
  return a;
}
buildStockLUTs();

// ---------- pipeline ----------
function applyPipeline(){
  if(!resampled) return null;
  const W = resampled.width, H = resampled.height;
  const id = wctx.createImageData(W, H);
  const o = id.data;
  const s = resampled.data;

  const stock = STOCK_LUTS[params.filmStock] || STOCK_LUTS['portra-400'];
  const rL = stock.r, gL = stock.g, bL = stock.b;
  const sat = stock.sat;
  const temp = params.temperature;
  const tempR = temp > 0 ? temp * 30 : 0;
  const tempB = temp < 0 ? -temp * 30 : 0;

  // Pass 1 — stock LUT + saturation + temperature.
  for(let i = 0; i < s.length; i += 4){
    let r = rL[s[i]];
    let g = gL[s[i+1]];
    let b = bL[s[i+2]];
    if(sat !== 1){
      const y = 0.299*r + 0.587*g + 0.114*b;
      r = clamp(lerp(y, r, sat), 0, 255);
      g = clamp(lerp(y, g, sat), 0, 255);
      b = clamp(lerp(y, b, sat), 0, 255);
    }
    r = clamp(r + tempR - tempB * 0.3, 0, 255);
    b = clamp(b + tempB - tempR * 0.3, 0, 255);
    o[i] = r; o[i+1] = g; o[i+2] = b; o[i+3] = s[i+3];
  }

  // Pass 2 — halation.
  const hal = params.halation * (stock.halationBoost || 1);
  const hr  = params.halationRadius | 0;
  if(hal > 0 && hr > 0){
    applyHalation(o, W, H, hr, hal);
  }

  // Pass 3 — grain (deterministic, fixed seed).
  const ga = clamp(params.grainAmount, 0, 1);
  if(ga > 0){
    applyGrain(o, W, H, ga, params.grainSize, GRAIN_SEED);
  }

  // Pass 4 — vignette.
  const vig = clamp(params.vignette, 0, 1);
  if(vig > 0){
    const cx = W / 2, cy = H / 2;
    const maxR2 = cx*cx + cy*cy;
    for(let y = 0; y < H; y++){
      const dy = y - cy;
      for(let x = 0; x < W; x++){
        const dx = x - cx;
        const r2 = dx*dx + dy*dy;
        const k = 1 - vig * (r2 / maxR2);
        const i = (x + y * W) * 4;
        o[i]   = clamp(o[i]   * k, 0, 255);
        o[i+1] = clamp(o[i+1] * k, 0, 255);
        o[i+2] = clamp(o[i+2] * k, 0, 255);
      }
    }
  }

  wctx.putImageData(id, 0, 0);
  return workBuf;
}

function applyHalation(o, W, H, hr, hal){
  const mask = new Float32Array(W * H);
  for(let i = 0, j = 0; i < o.length; i += 4, j++){
    const y = 0.299*o[i] + 0.587*o[i+1] + 0.114*o[i+2];
    const k = clamp((y - 180) / 75, 0, 1);
    mask[j] = k * k;
  }
  const tmp = new Float32Array(W * H);
  const r = hr;
  for(let y = 0; y < H; y++){
    const row = y * W;
    let sum = 0;
    for(let x = -r; x <= r; x++){
      const xi = x < 0 ? 0 : (x >= W ? W - 1 : x);
      sum += mask[row + xi];
    }
    const norm = 1 / (2 * r + 1);
    for(let x = 0; x < W; x++){
      tmp[row + x] = sum * norm;
      const xAdd = x + r + 1, xSub = x - r;
      const ai = xAdd >= W ? W - 1 : xAdd;
      const si = xSub < 0 ? 0 : xSub;
      sum += mask[row + ai] - mask[row + si];
    }
  }
  for(let x = 0; x < W; x++){
    let sum = 0;
    for(let y = -r; y <= r; y++){
      const yi = y < 0 ? 0 : (y >= H ? H - 1 : y);
      sum += tmp[x + yi * W];
    }
    const norm = 1 / (2 * r + 1);
    for(let y = 0; y < H; y++){
      mask[x + y * W] = sum * norm;
      const yAdd = y + r + 1, ySub = y - r;
      const ai = yAdd >= H ? H - 1 : yAdd;
      const si = ySub < 0 ? 0 : ySub;
      sum += tmp[x + ai * W] - tmp[x + si * W];
    }
  }
  const amp = hal * 180;
  for(let j = 0, i = 0; j < mask.length; j++, i += 4){
    const m = mask[j];
    o[i]   = clamp(o[i]   + amp * m,        0, 255);
    o[i+1] = clamp(o[i+1] + amp * m * 0.25, 0, 255);
    o[i+2] = clamp(o[i+2] + amp * m * 0.10, 0, 255);
  }
}

function applyGrain(o, W, H, amount, size, seed){
  const rng = mulberry32(seed);
  const sz = Math.max(0.5, size);
  const nW = sz > 1 ? Math.max(1, Math.floor(W / sz)) : W;
  const nH = sz > 1 ? Math.max(1, Math.floor(H / sz)) : H;
  const noise = new Float32Array(nW * nH);
  for(let i = 0; i < noise.length; i++) noise[i] = rng() - 0.5;
  const sx = nW / W, sy = nH / H;
  const amp = amount * 90;
  for(let y = 0; y < H; y++){
    const ny = Math.min(nH - 1, (y * sy) | 0);
    for(let x = 0; x < W; x++){
      const nx = Math.min(nW - 1, (x * sx) | 0);
      const n = noise[nx + ny * nW] * amp;
      const i = (x + y * W) * 4;
      o[i]   = clamp(o[i]   + n, 0, 255);
      o[i+1] = clamp(o[i+1] + n, 0, 255);
      o[i+2] = clamp(o[i+2] + n, 0, 255);
    }
  }
}

// ---------- paint ----------
function paint(){
  window.WAGUI?.flashValues(params);
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);
  if(!resampled){ ctx.restore(); return; }

  const surface = params.showEffect ? (applyPipeline() || srcBuf) : srcBuf;

  const sw = surface.width, sh = surface.height;
  const aspect = sw / sh;
  let dw, dh;
  if(params.fit === 'contain'){
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
  } else {
    if(W / H > aspect){ dw = W; dh = W / aspect; }
    else              { dh = H; dw = H * aspect; }
  }
  const ox = (W - dw) / 2;
  const oy = (H - dh) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(surface, ox, oy, dw, dh);

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
  if(mode === 'breath'){
    const base = params.grainAmount;
    params.grainAmount = 0.05 + 0.55 * pingPong(t01);
    return () => { params.grainAmount = base; };
  }
  if(mode === 'tone'){
    const base = params.temperature;
    params.temperature = 0.6 * Math.cos(t01 * Math.PI * 2);
    return () => { params.temperature = base; };
  }
  if(mode === 'bloom'){
    const base = params.halation;
    params.halation = 0.1 + 0.75 * pingPong(t01);
    return () => { params.halation = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseH = params.halation;
  const baseG = params.grainAmount;
  params.halation    = ax;
  params.grainAmount = ay;
  return () => { params.halation = baseH; params.grainAmount = baseG; };
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

// ---------- WAEffect contract ----------
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

const RESAMPLE_KEYS = new Set(['canvasSize','fit']);

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
      if(key === 'fit') schedule('resample'); else schedule('paint');
      return;
    }
    if(params.animate) return;
    if(RESAMPLE_KEYS.has(key)) schedule('resample');
    else schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('resample'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-film-grain',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('resample');
  if(params.animate) startAnimation();
}

document.addEventListener('DOMContentLoaded', init);
