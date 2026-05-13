// pixart/dots — port of tooooools.app/effects/dots.
//
// Halftone screen of rounded squares: a rotated grid of dots, each sized by
// local luminance, with optional Perlin jitter (displacementFactor) and a
// Benday half-cell stagger. Print-paper default: black ink on white.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const DOT_FILL = '#000000';
const PAPER    = '#ffffff';

const params = {
  // Preprocessor.
  canvasSize:        600,
  blur:              0,
  grain:             0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Dots core.
  lightnessThreshold: 200,
  minDotSize:         1,
  maxDotSize:         14,
  stepSize:           8,
  displacementFactor: 2,
  cornerRadius:       12,
  gridType:           'Regular',
  angle:              15,
  // Paint.
  showEffect:         true,
  // Animation + interactive (Step 2).
  animate:            false,
  mode:               'breath',
  interactive:        false,
  // Shared chrome.
  fit:                'cover',
  bg:                 '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let lumGrid = null;
let dots = null;
let dotCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

let _rng = Math.random;

// ---------- deterministic value noise ----------
const NOISE_GRID = 256;
const NOISE_MASK = NOISE_GRID - 1;
const noiseField = (() => {
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
  const rng = mulberry32(0xDEADBEEF);
  const a = new Float32Array(NOISE_GRID * NOISE_GRID);
  for(let i = 0; i < a.length; i++) a[i] = rng();
  return a;
})();
function smoothstep(t){ return t * t * (3 - 2 * t); }
function noise2D(x, y){
  const X = Math.floor(x), Y = Math.floor(y);
  const fx = x - X, fy = y - Y;
  const ix0 = X & NOISE_MASK, iy0 = Y & NOISE_MASK;
  const ix1 = (X + 1) & NOISE_MASK, iy1 = (Y + 1) & NOISE_MASK;
  const v00 = noiseField[ix0 + iy0 * NOISE_GRID];
  const v10 = noiseField[ix1 + iy0 * NOISE_GRID];
  const v01 = noiseField[ix0 + iy1 * NOISE_GRID];
  const v11 = noiseField[ix1 + iy1 * NOISE_GRID];
  const sx = smoothstep(fx), sy = smoothstep(fy);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
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
    if(dirty.build) buildDots();
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

// ---------- preprocessor ----------
function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
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
  const g  = params.grain;
  const gm = params.gamma;
  const bp = params.blackPoint;
  const wp = params.whitePoint;
  const span = Math.max(1, wp - bp);
  const scale = 255 / span;
  const rnd = _rng;
  const doGrain  = g !== 0;
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
    if(doGamma){ r = lut[r|0]; gg = lut[gg|0]; b = lut[b|0]; }
    if(doLevels){
      r  = clamp((r  - bp) * scale, 0, 255);
      gg = clamp((gg - bp) * scale, 0, 255);
      b  = clamp((b  - bp) * scale, 0, 255);
    }
    px[i] = r; px[i+1] = gg; px[i+2] = b;
  }
  sctx.putImageData(id, 0, 0);
  preprocessed = id;

  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    const a = px[i+3] / 255;
    lumGrid[j] = (lerp(255, px[i], a) + lerp(255, px[i+1], a) + lerp(255, px[i+2], a)) / 3;
  }
}

function sampleLum(x, y){
  const W = preprocessed.width, H = preprocessed.height;
  let xi = Math.floor(x); if(xi < 0) xi = 0; else if(xi > W - 1) xi = W - 1;
  let yi = Math.floor(y); if(yi < 0) yi = 0; else if(yi > H - 1) yi = H - 1;
  return lumGrid[xi + yi * W];
}

// ---------- build dots ----------
let _buildAngle = 0;

function buildDots(){
  if(!preprocessed){ dotCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const ang = (params.angle || 0) * Math.PI / 180;
  const cosR = Math.cos(ang), sinR = Math.sin(ang);
  const r = Math.abs(cosR) + Math.abs(sinR);

  const baseStep = Math.max(1, params.stepSize | 0);
  const l = baseStep, o = baseStep;

  const th    = params.lightnessThreshold;
  const minD  = params.minDotSize;
  const maxD  = params.maxDotSize;
  const dispF = params.displacementFactor;
  const benday = params.gridType === 'Benday';

  const i = Math.sqrt(W * W + H * H);
  const s = W / 2;
  const u = H / 2;
  const d = Math.ceil(i / o) + 4;
  const p = Math.ceil(i / l) + 4;
  const f = (W % l) / 2;
  const m = (H % o) / 2;
  const y = 0.5 / Math.max(1, dispF / 50);
  const v = maxD / r + dispF;

  const cap = (2 * d) * (2 * p);
  if(!dots || dots.length < cap * 3) dots = new Float32Array(cap * 3);
  let n = 0;

  for(let ii = -d; ii < d; ii++){
    const bend = benday ? (l / 2) * (((ii % 2) + 2) % 2) : 0;
    for(let h = -p; h < p; h++){
      const px = h * l + bend + f - s;
      const py = ii * o + m - u;
      const wx = s + px * cosR - py * sinR;
      const wy = u + px * sinR + py * cosR;
      if(wx < -v || wx > W + v || wy < -v || wy > H + v) continue;

      let dx = wx, dy = wy;
      if(dispF > 0){
        const t1 = noise2D(wx * y, wy * y);
        const t2 = noise2D(wx * y + 100, wy * y + 100);
        dx = wx + (t1 - 0.5) * dispF * 2;
        dy = wy + (t2 - 0.5) * dispF * 2;
      }
      const lum = sampleLum(dx, dy);
      let k = (lum < th)
        ? (maxD + (minD - maxD) * (lum / Math.max(0.0001, th))) / r
        : minD / r;
      if(k <= 0) continue;

      const j = n * 3;
      dots[j]   = dx;
      dots[j+1] = dy;
      dots[j+2] = k;
      n++;
      if(n >= cap) break;
    }
    if(n >= cap) break;
  }
  dotCount = n;
  _buildAngle = ang;
}

// ---------- shape draw (round only) ----------
function drawDot(ctx, hs, sz, cr){
  const hasRR = typeof ctx.roundRect === 'function';
  if(hasRR && cr > 0.5){
    const rr = Math.min(cr, hs);
    ctx.beginPath();
    ctx.roundRect(-hs, -hs, sz, sz, rr);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, hs, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- paint ----------
function paint(){
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

  if(!dots || dotCount === 0){ ctx.restore(); return; }

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  ctx.fillStyle = PAPER;
  ctx.fillRect(ox, oy, dw, dh);

  ctx.beginPath();
  ctx.rect(ox, oy, dw, dh);
  ctx.clip();

  ctx.fillStyle = DOT_FILL;
  const ang = _buildAngle;
  const cr = Math.max(0, params.cornerRadius) * scale;

  for(let kk = 0; kk < dotCount; kk++){
    const j = kk * 3;
    const cx = ox + dots[j]   * scale;
    const cy = oy + dots[j+1] * scale;
    const sz = dots[j+2] * scale;
    if(sz <= 0.25) continue;
    const hs = sz / 2;
    ctx.save();
    ctx.translate(cx, cy);
    if(ang) ctx.rotate(ang);
    drawDot(ctx, hs, sz, cr);
    ctx.restore();
  }

  ctx.restore();
}

// ---------- animation + interactive (Step 2) ----------
//
// Three modes, each cosine-enveloped across CYCLE_MS=15000:
//   breath — maxDotSize pingpongs 4 ↔ base ↔ 24 (dots inflate/deflate).
//   tone   — whitePoint cosine 130 ↔ 255 (highlights drift; preprocessor key,
//            so re-runs preprocess each frame in tone-mode only).
//   spin   — angle sweeps 0 → 360° once per cycle (halftone screen rotates).
//
// Interactive metaphor: cursor X → maxDotSize 4..30, cursor Y → angle 0..360.
// One sentence: cursor IS the screen's caliper + rotation.
const CYCLE_MS = 15000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'breath'){
    const base = params.maxDotSize;
    // 4 ↔ 24 cosine — dots inflate and deflate around the visual centre.
    params.maxDotSize = 4 + 20 * pingPong(t01);
    return () => { params.maxDotSize = base; };
  }
  if(mode === 'tone'){
    const base = params.whitePoint;
    params.whitePoint = 192 + 63 * Math.cos(t01 * Math.PI * 2);
    return () => { params.whitePoint = base; };
  }
  if(mode === 'spin'){
    const base = params.angle;
    params.angle = (t01 * 360) % 360;
    return () => { params.angle = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseMax = params.maxDotSize;
  const baseAng = params.angle;
  params.maxDotSize = 4 + ax * 26;   // 4..30
  params.angle      = ay * 360;       // 0..360
  return () => { params.maxDotSize = baseMax; params.angle = baseAng; };
}

let preprocessedIsToneModulated = false;
function renderAt(t01){
  const isTone = params.animate && params.mode === 'tone';
  const needsPre = isTone || preprocessedIsToneModulated;
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  if(needsPre) preprocess();
  buildDots();
  paint();
  restoreInt();
  restoreMode();
  preprocessedIsToneModulated = isTone;
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

const PRE_KEYS   = new Set(['canvasSize','blur','grain','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['lightnessThreshold','stepSize','minDotSize','maxDotSize','displacementFactor','gridType','angle']);
const PAINT_KEYS = new Set(['cornerRadius','showEffect']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('paint'); }
      return;
    }
    if(key === 'mode'){
      if(!params.animate) schedule('paint');
      return;
    }
    if(key === 'interactive'){
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
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-dots',
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
