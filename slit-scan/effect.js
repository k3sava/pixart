// pixart/slit-scan — spatial slit-scan (sheared read).
//
// Slit-scan is fundamentally temporal: for video, each output row is sampled
// from a different past frame. This static effect uses the spatial-shear
// fallback: for each row y, shift the source horizontally (axis=horizontal)
// or each column x vertically (axis=vertical) by (u-0.5) * spread * extent.
// `tilt` rotates the slit's reference axis, so the slit direction wobbles.
//
// Step 2 (pattern-set): animation + interactive cursor layered on top.
//
// Defaults were chosen by sweeping spread/tilt/axis against `portrait.jpg`
// (see docs/step2-screenshots/ and docs/step2-research.md).
//
//   axis=horizontal   — most legible: face stretches along columns,
//                        rows shift sideways. Vertical is offered as a mode.
//   spread=0.6        — clearly slanted, portrait still recognisable.
//                        ≥1.4 the head smears past the frame.
//   tilt=0            — clean horizontal slit. ±45 still reads.
//
// Animation modes (gentle cosine envelopes across cycleMs=15000):
//
//   breath — spread cosine pingpongs 0 ↔ 1.2 (shear grows and recedes).
//   tilt   — tilt cosine ±45 (slit angle wobbles around 0).
//
// Interactive: cursor X → spread (0..1.2), cursor Y → tilt (-45..+45).
// One metaphor: cursor IS the slit head — drag to shear.
'use strict';

const CYCLE_MS = 20000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d');

const params = {
  axis:        'horizontal',
  spread:      0.6,
  tilt:        0,
  animate:     false,
  mode:        'breath',
  interactive: false,
  showEffect:  true,
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

const SRC_WIDTH = 600;

let gui;
let preprocessed = null;
let outData = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

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
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = SRC_WIDTH;
  const H = Math.max(1, Math.round(W * aspect));
  if(srcBuf.width !== W || srcBuf.height !== H){
    srcBuf.width = W; srcBuf.height = H;
    outBuf.width = W; outBuf.height = H;
  }
  sctx.save();
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  sctx.restore();
  preprocessed = sctx.getImageData(0, 0, W, H);
  if(!outData || outData.width !== W || outData.height !== H){
    outData = octx.createImageData(W, H);
  }
}

// Spatial slit-scan shear: for axis=horizontal, shift each row by an amount
// derived from rotated y; axis=vertical shears columns.
function buildOutput(){
  if(!preprocessed || !outData) return;
  const W = preprocessed.width, H = preprocessed.height;
  const src = preprocessed.data;
  const dst = outData.data;

  const axis = params.axis;
  const tiltRad = params.tilt * Math.PI / 180;
  const cosT = Math.cos(tiltRad), sinT = Math.sin(tiltRad);
  const cx = W / 2, cy = H / 2;

  const maxShearX = params.spread * W;
  const maxShearY = params.spread * H;

  for(let y = 0; y < H; y++){
    for(let x = 0; x < W; x++){
      const dx = x - cx, dy = y - cy;
      let u, sx = x, sy = y;
      if(axis === 'horizontal'){
        const yr = dy * cosT - dx * sinT;
        u = clamp((yr / H) + 0.5, 0, 1);
        sx = x + (u - 0.5) * maxShearX;
      } else {
        const xr = dx * cosT + dy * sinT;
        u = clamp((xr / W) + 0.5, 0, 1);
        sy = y + (u - 0.5) * maxShearY;
      }
      sx = clamp(sx, 0, W - 1);
      sy = clamp(sy, 0, H - 1);
      const sOff = ((sy | 0) * W + (sx | 0)) * 4;
      const dOff = (y * W + x) * 4;
      dst[dOff]   = src[sOff];
      dst[dOff+1] = src[sOff+1];
      dst[dOff+2] = src[sOff+2];
      dst[dOff+3] = src[sOff+3];
    }
  }
  octx.putImageData(outData, 0, 0);
}

function paint(){
  window.WAGUI?.flashValues(params);
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);
  if(!preprocessed){ ctx.restore(); return; }

  if(!params.showEffect){
    const srcCv = window.PIXSource?.getCanvas();
    if(srcCv){
      const sw = preprocessed.width, sh = preprocessed.height;
      const aspect = sw / sh;
      let dw, dh;
      if(W / H > aspect){ dh = H; dw = H * aspect; }
      else              { dw = W; dh = W / aspect; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(srcCv, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    ctx.restore();
    return;
  }

  const sw = outBuf.width, sh = outBuf.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(outBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ---------- animation ----------
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'breath'){
    const base = params.spread;
    // 0 → 1.2 → 0 — shear grows and recedes around the recognisable midband.
    params.spread = 1.2 * pingPong(t01);
    return () => { params.spread = base; };
  }
  if(mode === 'tilt'){
    const base = params.tilt;
    // ±45° cosine — slit wobbles around the user's tilt anchor.
    params.tilt = 45 * Math.cos(t01 * Math.PI * 2);
    return () => { params.tilt = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseSpread = params.spread;
  const baseTilt = params.tilt;
  // X → spread 0..1.2; Y → tilt -45..+45 (top = -45, bottom = +45).
  params.spread = ax * 1.2;
  params.tilt   = (ay - 0.5) * 90;
  return () => { params.spread = baseSpread; params.tilt = baseTilt; };
}

function renderAt(t01){
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  buildOutput();
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
const BUILD_KEYS = new Set(['axis','spread','tilt']);

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
    if(key === 'showEffect') { schedule('paint'); return; }
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
      canvas: cv, name: 'pixart-slit-scan',
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
