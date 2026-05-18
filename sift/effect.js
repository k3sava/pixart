// pixart/sift — Horizontal band slicing with sine-wave offsets.
//
// The image is sliced into N horizontal bands. Each band is drawn at a
// different horizontal (X) offset, animated by a sine wave specific to that
// band. The offsets create a shimmering parallax/interference effect where
// bands slide past each other in a toroidal wrap.
//
// Algorithm:
//   1. preprocess: draw source → srcBuf, apply standard filters.
//   2. paint: for each of N horizontal bands, compute a sine-driven X offset
//      and blit the band slice from srcBuf at that offset, wrapping toroidally.
//      No separate buildOutput — offsets are trivially cheap per-frame.
//
// Modes:
//   wave   — phase offset advances smoothly each frame (continuous scroll).
//   ripple — phase advances as a travelling wave downward (bands cascade).
//   pulse  — all bands spike to maximum offset and quickly return.
//
// Interactive: X → amplitude (0..100), Y → phaseWrap (0.5..8).
//
// WAEffect contract: { cycleMs: 20000, renderAt(t), pauseRender(), resumeRender() }
'use strict';

const CYCLE_MS = 20000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d');

const params = {
  canvasSize:  600,
  fit:         'cover',
  bg:          '#0a0a0a',
  blur:        0,
  grain:       0,
  gamma:       1,
  blackPoint:  0,
  whitePoint:  255,
  // Sift-specific.
  bandCount:   20,   // 5..60
  amplitude:   30,   // 0..100 px max shift
  phaseWrap:   2,    // 0.5..8 wave cycles across all bands
  speed:       1.0,  // 0.1..3 animation speed multiplier
  // Animation / interactive.
  animate:     false,
  mode:        'wave',
  interactive: false,
  showEffect:  true,
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

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

// buildOutput is a no-op for sift — all work happens in paint().
function buildOutput(){ /* nothing */ }

// ---------- animation state ----------
let _animT01 = 0;

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

  if(!params.showEffect){
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcBuf, ox, oy, dw, dh);
    ctx.restore();
    return;
  }

  // Ensure outBuf matches srcBuf dimensions.
  if(outBuf.width !== W || outBuf.height !== H){
    outBuf.width = W; outBuf.height = H;
  }

  // Clear outBuf.
  octx.clearRect(0, 0, W, H);

  const N    = Math.max(2, params.bandCount | 0);
  const bandH = H / N;
  const amp  = params.amplitude;
  const wrap = params.phaseWrap;
  const t    = _animT01;
  const mode = params.mode;

  for(let i = 0; i < N; i++){
    const bY = i * bandH;
    const bH = Math.ceil(bandH) + 1; // +1 to avoid 1-px gaps between bands

    let phase;
    if(mode === 'wave'){
      // All bands drift at the same rate; each band has a fixed phase offset.
      phase = (i / N) * Math.PI * 2 * wrap + t * Math.PI * 2 * params.speed;
    } else if(mode === 'ripple'){
      // Travelling wave downward: band i's local t is shifted by i/N.
      phase = (i / N + t * params.speed) * Math.PI * 2 * wrap;
    } else {
      // pulse: sine spike at t=0.5, all bands share the same spike scaled by band phase.
      phase = (i / N) * Math.PI * 2 * wrap;
    }

    let dx;
    if(mode === 'pulse'){
      const spike = Math.pow(Math.sin(t * Math.PI), 2);
      dx = amp * spike * Math.sin(phase);
    } else {
      dx = amp * Math.sin(phase);
    }
    dx = Math.round(dx);

    // Draw band slice with toroidal X wrapping.
    octx.drawImage(srcBuf, 0, bY, W, bH, dx,     bY, W, bH);
    if(dx > 0) octx.drawImage(srcBuf, 0, bY, W, bH, dx - W, bY, W, bH);
    if(dx < 0) octx.drawImage(srcBuf, 0, bY, W, bH, dx + W, bY, W, bH);
  }

  // Draw outBuf to main canvas (centred, fitted).
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(outBuf, ox, oy, dw, dh);
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
  const baseAmp  = params.amplitude;
  const baseWrap = params.phaseWrap;
  params.amplitude  = ax * 100;
  params.phaseWrap  = 0.5 + ay * 7.5;
  return () => {
    params.amplitude  = baseAmp;
    params.phaseWrap  = baseWrap;
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
const BUILD_KEYS = new Set(['bandCount','amplitude','phaseWrap']);

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
    else if(BUILD_KEYS.has(key)) schedule('paint');
    else                         schedule('paint');
  });
  cv.addEventListener('mousemove', e => {
    const r = cv.getBoundingClientRect();
    mouseX = e.clientX - r.left; mouseY = e.clientY - r.top; hasMouse = true;
    if(params.interactive && !params.animate) renderAt(0);
  });
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-sift',
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
