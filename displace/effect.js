// pixart/displace — faithful port of tooooools.app/effects/displace with
// Step 2 pattern-set (animation + interactive) bolted on top.
//
// Algorithm (the simple original, pre-3D-bolt-on):
//   1. Preprocess the source: blur → grain → gamma → levels.
//   2. Walk the preprocessed buffer on a `stepSize` grid.
//   3. For each cell, draw a `dotSize` dot at the source position, vertically
//      offset by `displacement * (luminance / 255)`.
//
// Defaults were chosen by sweeping each control alone against `portrait.jpg`
// in Playwright (see docs/step2-screenshots/ and docs/step2-research.md).
// Sweet spot for "field of dots reads AND portrait stays recognizable":
//
//   displacement=180  — reference default; portrait reads, top edge streaks
//                       (the signature look). swell mode passes 0 mid-loop.
//   stepSize=8        — reference default; finer = mushy, coarser = mosaic.
//   dotSize=8         — slight overlap into the displaced field; readable.
//   whitePoint=255    — full range; tone mode shifts it down to 192±63.
//
// Animation modes (each = a gentle cosine envelope across cycleMs=15000):
//
//   swell  — displacement = base * cos(2π t). Pingpongs default ↔ 0 ↔ -default
//            ↔ 0 ↔ default. Dots "breathe" up and down through the resting
//            portrait position.
//   tone   — whitePoint drifts 130 ↔ 255 (centre 192, amp 62). Levels-driven
//            contrast pulses; the dot field brightens and dims.
//   breath — dotSize pingpongs between 4 and 16 (centre 10, amp 6). Dots
//            inhale and exhale; field opens and closes.
//
// Interactive: cursor X drives displacement (-150..150), cursor Y drives
// dotSize (4..24). One metaphor: cursor is the wind shaping the dot field.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  canvasSize:   600,
  blur:         0,
  grain:        0,
  gamma:        1,
  blackPoint:   0,
  whitePoint:   255,
  stepSize:     8,
  displacement: 180,
  dotSize:      8,
  animate:      false,
  mode:         'swell',
  interactive:  false,
  showEffect:   true,
  fit:          'cover',
  bg:           '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let dirty = { pre: true, paint: true };
let rafQueued = false;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

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

  const sw = preprocessed.width, sh = preprocessed.height;
  const px = preprocessed.data;
  const stride = Math.max(1, params.stepSize | 0);
  const disp = params.displacement;

  // Fit source rect inside canvas.
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.9; dw = dh * aspect; }
  else              { dw = W * 0.9; dh = dw / aspect; }
  const fitScale = dw / sw;
  const ox = (W - dw) / 2;
  const oy = (H - dh) / 2;

  const ds = Math.max(1, params.dotSize * fitScale * 0.5);
  const useRects = params.dotSize * fitScale < 5;

  for(let y = 0; y < sh; y += stride){
    for(let x = 0; x < sw; x += stride){
      const i = (x + y * sw) * 4;
      const r = px[i], g = px[i+1], b = px[i+2];
      const a = px[i+3] / 255;
      const lr = 255 + (r - 255) * a;
      const lg = 255 + (g - 255) * a;
      const lb = 255 + (b - 255) * a;
      const lum = (lr + lg + lb) / 3;
      const dy = disp * (lum / 255);
      const sx = ox + x * fitScale;
      const sy = oy + (y + dy) * fitScale;
      ctx.fillStyle = 'rgb(' + (r|0) + ',' + (g|0) + ',' + (b|0) + ')';
      if(useRects){
        ctx.fillRect(sx - ds, sy - ds, ds * 2, ds * 2);
      } else {
        ctx.beginPath();
        ctx.arc(sx, sy, ds, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.restore();
}

// ---------- animation (matches bevel pattern) ----------
const CYCLE_MS = 15000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'swell'){
    // displacement = base * cos(2π t). Sweeps base → 0 → -base → 0 → base.
    // Dots breathe vertically through the resting portrait position.
    const base = params.displacement;
    params.displacement = base * Math.cos(t01 * Math.PI * 2);
    return () => { params.displacement = base; };
  }
  if(mode === 'tone'){
    // Drift whitePoint 130 ↔ 255 cosine. Touches preprocess so caller re-runs.
    const base = params.whitePoint;
    params.whitePoint = 192 + 63 * Math.cos(t01 * Math.PI * 2);
    return () => { params.whitePoint = base; };
  }
  if(mode === 'breath'){
    // Dot size inhales/exhales 4 ↔ 16, pingPong so 4 at t=0 and t=1, 16 at 0.5.
    const base = params.dotSize;
    params.dotSize = 4 + 12 * pingPong(t01);
    return () => { params.dotSize = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseDisp = params.displacement;
  const baseDot  = params.dotSize;
  // X: -150..150 displacement. Centre = 0 (dots at rest), edges = streaks.
  params.displacement = (ax - 0.5) * 300;
  // Y: 4..24 dot size. Top = small, bottom = chunky.
  params.dotSize = 4 + ay * 20;
  return () => { params.displacement = baseDisp; params.dotSize = baseDot; };
}

// Track tone-mode preprocess pollution (same gotcha as bevel).
let preprocessedIsToneModulated = false;
function renderAt(t01){
  const isTone = params.animate && params.mode === 'tone';
  const needsPre = isTone || preprocessedIsToneModulated;
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  if(needsPre) preprocess();
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

const PRE_KEYS = new Set(['canvasSize','blur','grain','gamma','blackPoint','whitePoint','fit','bg']);

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
    if(PRE_KEYS.has(key)) schedule('pre');
    else                  schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-displace',
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
