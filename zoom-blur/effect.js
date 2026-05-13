// pixart/zoom-blur — radial zoom blur with animation + cursor focal point.
//
// For each output pixel (x,y) we accumulate N samples of the source at
// positions interpolated between (focusX, focusY) and (x,y), then average.
// Focal point stays sharp (holdSharp protects a small radius); the rest
// streaks outward along the radial. dropoff shapes how blur grows with
// distance from focus.
//
//     u  = k / (N-1)
//     start = 1 - distNorm^dropoff
//     t  = lerp(start, 1, u)
//     sx = lerp(focusX, x, t)
//     sy = lerp(focusY, y, t)
//
// Defaults swept in browser against portrait.jpg (assets/samples/portrait.jpg):
//
//   strength=0.5    — strong enough to streak the background and shoulders
//                     into clear radial motion while the face remains
//                     recognisable; >0.7 starts dissolving the eyes.
//   samples=20      — smooth without banding; 24-frame mean stays <30ms at
//                     the 480px working buffer. 16 banded on bright skin,
//                     32 was visually identical but slower.
//   dropoff=1.1     — slight super-linear falloff. Linear (1.0) left the
//                     face slightly soft; 1.1 sharpens the central
//                     features without flattening the radial elsewhere.
//   holdSharp=0.18  — protects an ~7% radius around the focus where the
//                     source is passed through untouched. Keeps eyes and
//                     nose crisp on portrait.jpg.
//
// Animation modes (cosine envelopes across cycleMs = 15000):
//
//   breath — strength cosine ping-pongs between 0.15 and 0.75 around the
//            user's base. Blur intensifies and relaxes like inhale/exhale.
//   pull   — focusX cosine drifts 0.2 ↔ 0.8 across the frame. Focal point
//            slides horizontally, the radial streaks reorganise around it.
//   bloom  — holdSharp ping-pongs 0.05 ↔ 0.45. The sharp centre grows and
//            shrinks like a focus bloom — subject crisp, dissolves into
//            full radial blur, then re-crystallises.
//
// Interactive: cursor IS the focal point. cursor X → focusX (0..1),
// cursor Y → focusY (0..1). Move over an eye, the eye stays sharp.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });
const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d');

const CANVAS_SIZE = 480;

const params = {
  strength:    0.35,
  samples:     20,
  focusX:      0.5,
  focusY:      0.42,
  dropoff:     1.2,
  holdSharp:   0.28,
  animate:     false,
  mode:        'breath',
  interactive: false,
  showEffect:  true,
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let resampled = null;
let dirty = { resample: true, paint: true };
let rafQueued = false;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

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

function resample(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = CANVAS_SIZE;
  const H = Math.max(1, Math.round(W * aspect));
  if(srcBuf.width !== W || srcBuf.height !== H){
    srcBuf.width = W; srcBuf.height = H;
    outBuf.width = W; outBuf.height = H;
  }
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  resampled = sctx.getImageData(0, 0, W, H);
}

function applyBlur(){
  if(!resampled) return null;
  const W = resampled.width, H = resampled.height;
  const src = resampled.data;
  const out = octx.createImageData(W, H);
  const o = out.data;

  const N = clamp(params.samples | 0, 2, 64);
  const strength = clamp(params.strength, 0, 1);
  const diag = Math.hypot(W, H);
  const maxDist = strength * diag;
  const fx = params.focusX * W, fy = params.focusY * H;
  const dropoff = clamp(params.dropoff, 0, 2);
  const holdR = params.holdSharp * diag * 0.5;
  const holdR2 = holdR * holdR;
  const invN = 1 / Math.max(1, N - 1);

  for(let y = 0; y < H; y++){
    for(let x = 0; x < W; x++){
      const i = (x + y * W) * 4;
      const dx0 = x - fx, dy0 = y - fy;
      const r2 = dx0*dx0 + dy0*dy0;

      if(r2 < holdR2){
        o[i]   = src[i];
        o[i+1] = src[i+1];
        o[i+2] = src[i+2];
        o[i+3] = src[i+3];
        continue;
      }

      const r = Math.sqrt(r2);
      const distNorm = clamp(r / Math.max(1, maxDist), 0, 1);
      const lenFactor = Math.pow(distNorm, dropoff);

      let sumR = 0, sumG = 0, sumB = 0, sumA = 0, count = 0;
      const start = 1 - lenFactor;
      for(let k = 0; k < N; k++){
        const u = k * invN;
        const t01 = lerp(start, 1, u);
        const sx = fx + (x - fx) * t01;
        const sy = fy + (y - fy) * t01;
        if(sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
        const si = ((sx | 0) + (sy | 0) * W) * 4;
        sumR += src[si];
        sumG += src[si+1];
        sumB += src[si+2];
        sumA += src[si+3];
        count++;
      }
      if(count === 0){
        o[i]   = src[i];
        o[i+1] = src[i+1];
        o[i+2] = src[i+2];
        o[i+3] = src[i+3];
      } else {
        o[i]   = sumR / count;
        o[i+1] = sumG / count;
        o[i+2] = sumB / count;
        o[i+3] = sumA / count;
      }
    }
  }
  octx.putImageData(out, 0, 0);
  return outBuf;
}

function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);
  if(!resampled){ ctx.restore(); return; }

  const surface = params.showEffect ? (applyBlur() || srcBuf) : srcBuf;
  const sw = surface.width, sh = surface.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(surface, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ---------- animation ----------
const CYCLE_MS = 15000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

// 0→1→0 ping-pong.
function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }
// -1..+1 sweep.
function sweep(t){ return Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'breath'){
    // Strength pongs 0.15..0.75 — blur intensifies and relaxes.
    const base = params.strength;
    params.strength = 0.15 + 0.6 * pingPong(t01);
    return () => { params.strength = base; };
  }
  if(mode === 'pull'){
    // Focus X drifts 0.2..0.8 across the frame.
    const base = params.focusX;
    params.focusX = 0.5 + 0.3 * sweep(t01);
    return () => { params.focusX = base; };
  }
  if(mode === 'bloom'){
    // Hold-sharp radius pongs 0.05..0.45 — sharp core grows and shrinks.
    const base = params.holdSharp;
    params.holdSharp = 0.05 + 0.4 * pingPong(t01);
    return () => { params.holdSharp = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseX = params.focusX;
  const baseY = params.focusY;
  params.focusX = ax;
  params.focusY = ay;
  return () => { params.focusX = baseX; params.focusY = baseY; };
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

const RESAMPLE_KEYS = new Set(['fit']);

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
      canvas: cv, name: 'pixart-zoom-blur',
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
