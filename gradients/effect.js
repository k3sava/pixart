// pixart/gradients — single-effect build.
//
// Scanline brightness segmentation, each segment painted with a 1-px-wide
// black→white palette stretched over the segment's horizontal extent.
// Hardcoded palette (tooooools default: white→black). Step 2 adds animation
// modes + cursor-interactive control.
//
// Defaults (sweep-verified against portrait.jpg):
//
//   stepSize=8           — fine bands; portrait recognizable.
//   lightnessThreshold=32 — moderate segmentation; subject reads cleanly.
//   whitePoint=255       — full range; mode shifts it.
//
// Animation modes (cosine envelope, cycleMs=15000):
//
//   breath — stepSize cosine pingpongs 4↔40. Bands grow and shrink, like
//            relief lines breathing across the subject.
//   tone   — whitePoint drifts 130↔255 around 192. Palette range tightens
//            and opens; the picture's contrast pulses warm/cold.
//   reveal — lightnessThreshold pingpongs 4↔120. Few segments → many
//            segments → few. The portrait dissolves into a single tonal
//            stripe and re-resolves into bands.
//
// Interactive: cursor X drives stepSize (4..40), cursor Y drives
// lightnessThreshold (32..220). One metaphor: cursor sculpts the band
// resolution — drag right for chunkier bands, drag down for fewer, denser
// segments.

'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });
const palBuf = document.createElement('canvas');
const pctx   = palBuf.getContext('2d');

const params = {
  canvasSize:         600,
  blur:               0,
  grain:              0,
  gamma:              1,
  blackPoint:         0,
  whitePoint:         255,
  showEffect:         true,
  lightnessThreshold: 32,
  stepSize:           8,
  shapeType:          'rect',
  animate:            false,
  mode:               'breath',
  interactive:        false,
  fit:                'cover',
  bg:                 '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let lumGrid      = null;
let strips       = null;
let dirty = { pre: true, build: true, paint: true, palette: true };
let rafQueued = false;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

function schedule(level){
  if(level === 'pre')   dirty.pre = true;
  if(level === 'pre' || level === 'build') dirty.build = true;
  if(level === 'palette') dirty.palette = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre)     preprocess();
    if(dirty.palette) rebuildPalette();
    if(dirty.build)   buildStrips();
    paint();
    dirty.pre = dirty.build = dirty.paint = dirty.palette = false;
  });
}

function fitCanvas(){
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// Hardcoded black→white gradient (tooooools default).
function rebuildPalette(){
  const W = Math.max(2, params.canvasSize | 0);
  if(palBuf.width !== W){ palBuf.width = W; palBuf.height = 1; }
  const grad = pctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#000000');
  grad.addColorStop(1, '#ffffff');
  pctx.fillStyle = grad;
  pctx.fillRect(0, 0, W, 1);
}

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

function buildStrips(){
  strips = [];
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;
  const step = Math.max(1, params.stepSize | 0);
  const th   = params.lightnessThreshold;
  const rows = Math.floor(H / step);
  for(let s = 0; s < rows; s++){
    const y0 = s * step;
    const segs = [];
    let prevB = 0, segStart = 0;
    for(let x = 0; x < W; x++){
      let sum = 0;
      for(let yy = y0; yy < y0 + step; yy++){
        sum += lumGrid[x + yy * W];
      }
      const avgB = sum / step;
      if(Math.abs(prevB - avgB) > th){
        segs.push({ start: segStart, end: x, br: prevB });
        segStart = x;
        prevB    = avgB;
      }
    }
    segs.push({ start: segStart, end: W, br: prevB });
    strips.push({ y: y0, segs });
  }
}

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

  if(!strips || strips.length === 0){ ctx.restore(); return; }

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scaleP = dw / sw;
  const step   = Math.max(1, params.stepSize | 0);

  const palW = palBuf.width;
  for(const strip of strips){
    const y  = oy + strip.y * scaleP;
    const stripH = step * scaleP;
    for(const seg of strip.segs){
      const x = ox + seg.start * scaleP;
      const w = (seg.end - seg.start) * scaleP;
      if(w < 0.5) continue;
      if(params.shapeType === 'ellipse'){
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + stripH / 2, w / 2, stripH / 2, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(palBuf, 0, 0, palW, 1, x, y, w, stripH);
        ctx.restore();
      } else {
        ctx.drawImage(palBuf, 0, 0, palW, 1, x, y, w, stripH);
      }
    }
  }

  ctx.restore();
}

// ---------- animation ----------
const CYCLE_MS = 15000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'breath'){
    // stepSize 4..40 cosine pingpong. Bands grow then shrink.
    const base = params.stepSize;
    params.stepSize = Math.round(4 + 36 * pingPong(t01));
    return () => { params.stepSize = base; };
  }
  if(mode === 'tone'){
    // whitePoint 130..255, centred at 192, amplitude 62. Pre-key.
    const base = params.whitePoint;
    params.whitePoint = 192 + 62 * Math.cos(t01 * Math.PI * 2);
    return () => { params.whitePoint = base; };
  }
  if(mode === 'reveal'){
    // lightnessThreshold 4..120 cosine pingpong. Few↔many segments.
    const base = params.lightnessThreshold;
    params.lightnessThreshold = 4 + 116 * pingPong(t01);
    return () => { params.lightnessThreshold = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseStep = params.stepSize;
  const baseTh   = params.lightnessThreshold;
  params.stepSize = Math.round(4 + ax * 36);     // 4..40
  params.lightnessThreshold = 32 + ay * 188;     // 32..220
  return () => { params.stepSize = baseStep; params.lightnessThreshold = baseTh; };
}

// Tone-mode bakes whitePoint into the preprocessed buffer; clear next frame.
let preprocessedIsToneModulated = false;
function renderAt(t01){
  const isTone = params.animate && params.mode === 'tone';
  const needsPre = isTone || preprocessedIsToneModulated;
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  if(needsPre) preprocess();
  buildStrips();
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
const BUILD_KEYS = new Set(['lightnessThreshold','stepSize']);
const PAINT_KEYS = new Set(['shapeType','showEffect']);

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
    if(params.animate) return; // animation loop owns the canvas
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
      canvas: cv, name: 'pixart-gradients',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  rebuildPalette();
  schedule('pre');
  if(params.animate) startAnimation();
}

document.addEventListener('DOMContentLoaded', init);
