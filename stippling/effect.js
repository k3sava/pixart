// pixart/stippling — port of tooooools.app/effects/stipping.
//
// Algorithm: rotated halftone grid. For each cell, sample luminance under
// the cell centre and emit a vertical rectangle whose width maps darkness →
// width.
//
// Step 2 (pattern-set): animation + interactive cursor layered on top of the
// static grid renderer. Defaults verified against portrait.jpg — portrait stays
// recognisable in the rotated halftone-bar pattern at xSquares=90, ySquares=90,
// maxSquareWidth=5, angle=15.
//
// Animation modes (each = a gentle cosine envelope across cycleMs=15000):
//
//   breath — maxSquareWidth pingpongs 1.5 ↔ 6.5 (bars grow/shrink). Subject
//            "inhales" then "exhales" tonal density.
//   spin   — angle drifts ±15° around user default. Halftone screen rotates
//            back and forth like a turning gauze.
//   tone   — whitePoint drifts 130 ↔ 255. Tonal floor rises and falls so the
//            stipple field washes out and recovers.
//
// Interactive: cursor X → angle (-45..45), cursor Y → maxSquareWidth (1..40).
// Metaphor: cursor IS the halftone screen — drag it to rotate / press to
// darken.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (shared with Displace / Edge / Cellular).
  canvasSize:        600,
  blur:              0,
  grain:             0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Stippling.
  lightnessThreshold: 200,
  ySquares:           90,
  xSquares:           90,
  minSquareWidth:     1,
  maxSquareWidth:     5,
  gridType:           'Regular',  // 'Regular' | 'Benday'
  angle:              15,
  // Animation + interactive.
  animate:            false,
  mode:               'breath',
  interactive:        false,
  showEffect:         true,
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

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }
function mapRange(v, a, b, c, d){ return c + (d - c) * ((v - a) / (b - a)); }

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
      const n = (0.5 - Math.random()) * g * 255;
      r  = clamp(r  + n, 0, 255);
      gg = clamp(gg + n, 0, 255);
      b  = clamp(b  + n, 0, 255);
    }
    if(doGamma){
      r  = lut[r | 0];
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
function buildDots(){
  if(!preprocessed){ dotCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;

  const angleDeg = params.angle;
  const xSq = Math.max(1, params.xSquares | 0);
  const ySq = Math.max(1, params.ySquares | 0);
  const r = (angleDeg || 0) * Math.PI / 180;
  const cosR = Math.cos(r), sinR = Math.sin(r);
  const n = Math.abs(cosR) + Math.abs(sinR);

  const l = H / ySq / n;
  const o = W / xSq / n;
  const th = params.lightnessThreshold;
  const minW = clamp(params.minSquareWidth, 0, 50);
  const maxW = clamp(params.maxSquareWidth, 0, 50);
  const benday = params.gridType === 'Benday';

  const i = W / 2;
  const s = H / 2;
  const u = Math.sqrt(W * W + H * H);
  const d = u / 2 + Math.max(o, l);
  const p = (l - 0.1) * 0.99;
  const c = (o - 0.1) * 0.99;

  const rowsApprox = Math.ceil((u + 2 * d) / Math.max(0.001, p)) + 2;
  const colsApprox = Math.ceil((u + 2 * d) / Math.max(0.001, c)) + 2;
  const cap = rowsApprox * colsApprox;
  if(!dots || dots.length < cap * 5) dots = new Float32Array(cap * 5);

  let nDots = 0;
  for(let f = -d; f < u + d; f += p){
    const yOffset = benday ? ((o - 0.1) / 2) * ((Math.floor(f / p) % 2 + 2) % 2) : 0;
    for(let oo = -d; oo < u + d; oo += c){
      const uu = oo + yOffset;
      const dd = f;
      const pCanvas = i + uu * cosR - dd * sinR;
      const cCanvas = s + uu * sinR + dd * cosR;

      const lum = sampleLum(pCanvas, cCanvas);

      let x = (lum < th)
        ? mapRange(lum, 0, th, maxW, minW)
        : minW;
      const C = (x > 1 ? x + 0.05 : x) / n;

      if(C === 0 || l === 0) continue;

      const v = C / 2, M = l / 2;
      const E = Math.abs(v * cosR) + Math.abs(M * sinR);
      const P = Math.abs(v * sinR) + Math.abs(M * cosR);
      if(!(pCanvas + E >= -v && pCanvas - E <= W + v &&
           cCanvas + P >= -M && cCanvas - P <= H + M)) continue;

      const j = nDots * 5;
      dots[j]   = pCanvas;
      dots[j+1] = cCanvas;
      dots[j+2] = C;
      dots[j+3] = l;
      dots[j+4] = r;
      nDots++;
      if(nDots >= cap) break;
    }
    if(nDots >= cap) break;
  }
  dotCount = nDots;
}

// ---------- paint ----------
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

  if(!dots || dotCount === 0){ ctx.restore(); return; }

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  // Hardcoded paper-white background, ink-black dots (tooooools default).
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(ox, oy, dw, dh);

  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.rect(ox, oy, dw, dh);
  ctx.clip();

  for(let k = 0; k < dotCount; k++){
    const j = k * 5;
    const cx = ox + dots[j]   * scale;
    const cy = oy + dots[j+1] * scale;
    const w  = dots[j+2] * scale;
    const h  = dots[j+3] * scale;
    const a  = dots[j+4];
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
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
  if(mode === 'breath'){
    // maxSquareWidth pingpongs around user's value with amplitude 2.5.
    const base = params.maxSquareWidth;
    const amp = 2.5;
    params.maxSquareWidth = clamp(base - amp + (2 * amp) * pingPong(t01), 0.5, 50);
    return () => { params.maxSquareWidth = base; };
  }
  if(mode === 'spin'){
    // angle drifts ±15° from user default (smooth cosine).
    const base = params.angle;
    params.angle = base + 15 * Math.cos(t01 * Math.PI * 2);
    return () => { params.angle = base; };
  }
  if(mode === 'tone'){
    // whitePoint drifts 130 ↔ 255, centred 192, amp 62.
    const base = params.whitePoint;
    params.whitePoint = 192 + 63 * Math.cos(t01 * Math.PI * 2);
    return () => { params.whitePoint = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseAngle = params.angle;
  const baseMaxW  = params.maxSquareWidth;
  params.angle          = -45 + ax * 90;       // X → -45..45
  params.maxSquareWidth = 1   + ay * 39;       // Y → 1..40
  return () => { params.angle = baseAngle; params.maxSquareWidth = baseMaxW; };
}

// Track whether the previous frame baked a modulated whitePoint into the
// preprocessed buffer; if so, the next non-tone frame must re-preprocess.
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
const BUILD_KEYS = new Set(['lightnessThreshold','xSquares','ySquares','minSquareWidth','maxSquareWidth','gridType','angle']);
const PAINT_KEYS = new Set(['showEffect']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('build'); }
      return;
    }
    if(key === 'mode'){
      if(!params.animate) schedule('paint');
      return;
    }
    if(key === 'interactive'){
      if(!params.animate) schedule('build');
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
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('build'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-stippling',
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
