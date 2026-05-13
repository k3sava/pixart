// pixart/edge — Sobel edge sketch.
//
// Sobel 3×3 on alpha-composited luminance, evaluated on a sparse grid
// (stepSize). When |G| > lightnessThreshold the cell emits a black rounded
// square whose size maps mag → [minDotSize..maxDotSize].
//
// Step 2 (pattern-set): animation + interactive cursor layered on the static
// Sobel sketch — matches the bevel pattern (applyMode / applyInteractive /
// renderAt(t01) / WAEffect.cycleMs=15000).
//
// Defaults were chosen by sweeping each control alone against `portrait.jpg`
// in Playwright (see docs/step2-research.md / docs/step2-screenshots/).
//
//   lightnessThreshold=80 — bundle default; portrait reads as a dot field,
//                           background suppressed. >150 strips the figure.
//   maxDotSize=12         — bundle default; the dot field has enough mass
//                           to read at canvasSize=600. <6 thins to ghost.
//   stepSize=5            — bundle default; grid density. >10 turns the
//                           subject into a stipple sparse enough to lose.
//   whitePoint=255        — pre-tone-mode baseline. `tone` drifts it.
//
// Animation modes (each = a gentle cosine envelope across cycleMs=15000):
//
//   breath  — maxDotSize pingpongs 4 ↔ 20. Dots inhale to chunky overlap at
//             t=0.5 and exhale to a thin field at t=0,1. Single most legible
//             gesture: the field itself breathes.
//   tone    — whitePoint drifts 130 ↔ 255 (cosine). Pre-Sobel contrast
//             pulses, so the dot field thickens (low wp clips midtones to
//             white → fewer gradients above threshold) and thins.
//   reveal  — lightnessThreshold pingpongs 30 ↔ 180. At low threshold the
//             whole portrait emerges in dots; at high threshold only the
//             strongest edges survive — rhythmic reveal/conceal.
//
// Interactive: cursor X → lightnessThreshold (30..200), cursor Y → maxDotSize
// (4..30). One metaphor: cursor is the etcher's pressure — right & down =
// more aggressive selection + bigger marks.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  canvasSize:        600,
  blur:              0,
  grain:             0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  lightnessThreshold: 80,
  minDotSize:        0,
  maxDotSize:        12,
  cornerRadius:      8,
  stepSize:          5,
  animate:           false,
  mode:              'breath',
  interactive:       false,
  showEffect:        true,
  fit:               'cover',
  bg:                '#ffffff',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let lumGrid = null;
let rects = null;
let rectCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

const EDGE_FILL = '#000000';

// Sobel kernels (row-major, centre omitted: never used by Gx/Gy).
const SOBEL_GX = [-1, 0, 1, -2,  2, -1, 0, 1];
const SOBEL_GY = [-1,-2,-1,  0,  0,  1, 2, 1];

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

function schedule(level){
  if(level === 'pre') dirty.pre = true;
  if(level === 'pre' || level === 'build') dirty.build = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre)   preprocess();
    if(dirty.build) buildRects();
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

function buildRects(){
  if(!preprocessed){ rectCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const step = Math.max(1, params.stepSize | 0);
  const th   = params.lightnessThreshold;
  const minD = params.minDotSize;
  const maxD = params.maxDotSize;
  const denom = Math.max(0.0001, 255 - th);

  const cap = Math.ceil(W / step) * Math.ceil(H / step);
  if(!rects || rects.length < cap * 3) rects = new Float32Array(cap * 3);
  let n = 0;
  for(let y = 0; y < H; y += step){
    for(let x = 0; x < W; x += step){
      const cx = x < 1 ? 1 : (x > W - 2 ? W - 2 : x);
      const cy = y < 1 ? 1 : (y > H - 2 ? H - 2 : y);
      const i00 = (cx - 1) + (cy - 1) * W;
      const i10 = cx       + (cy - 1) * W;
      const i20 = (cx + 1) + (cy - 1) * W;
      const i01 = (cx - 1) + cy       * W;
      const i21 = (cx + 1) + cy       * W;
      const i02 = (cx - 1) + (cy + 1) * W;
      const i12 = cx       + (cy + 1) * W;
      const i22 = (cx + 1) + (cy + 1) * W;
      const v00 = lumGrid[i00], v10 = lumGrid[i10], v20 = lumGrid[i20];
      const v01 = lumGrid[i01],                     v21 = lumGrid[i21];
      const v02 = lumGrid[i02], v12 = lumGrid[i12], v22 = lumGrid[i22];
      const gx = SOBEL_GX[0]*v00 + SOBEL_GX[1]*v10 + SOBEL_GX[2]*v20
              +  SOBEL_GX[3]*v01 +                   SOBEL_GX[4]*v21
              +  SOBEL_GX[5]*v02 + SOBEL_GX[6]*v12 + SOBEL_GX[7]*v22;
      const gy = SOBEL_GY[0]*v00 + SOBEL_GY[1]*v10 + SOBEL_GY[2]*v20
              +  SOBEL_GY[3]*v01 +                   SOBEL_GY[4]*v21
              +  SOBEL_GY[5]*v02 + SOBEL_GY[6]*v12 + SOBEL_GY[7]*v22;
      const mag = Math.sqrt(gx * gx + gy * gy);
      if(mag > th){
        let s = minD + (maxD - minD) * ((mag - th) / denom);
        if(s < minD) s = minD;
        if(s > maxD) s = maxD;
        if(s !== 0){
          const o = n * 3;
          rects[o]   = x;
          rects[o+1] = y;
          rects[o+2] = s;
          n++;
        }
      }
    }
  }
  rectCount = n;
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

  if(!rects || rectCount === 0){ ctx.restore(); return; }

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  const hasRR = typeof ctx.roundRect === 'function';
  const cr = Math.max(0, params.cornerRadius) * scale;

  ctx.fillStyle = EDGE_FILL;
  for(let k = 0; k < rectCount; k++){
    const o = k * 3;
    const x = ox + rects[o] * scale;
    const y = oy + rects[o+1] * scale;
    const s = rects[o+2] * scale;
    if(hasRR && cr > 0.5){
      ctx.beginPath();
      ctx.roundRect(x, y, s, s, Math.min(cr, s / 2));
      ctx.fill();
    } else {
      ctx.fillRect(x, y, s, s);
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
    // maxDotSize 4 ↔ 20 — dots inhale at t=0.5, exhale at t=0,1.
    const base = params.maxDotSize;
    params.maxDotSize = 4 + 16 * pingPong(t01);
    return () => { params.maxDotSize = base; };
  }
  if(mode === 'tone'){
    // whitePoint 130 ↔ 255 cosine (preprocessor key).
    const base = params.whitePoint;
    params.whitePoint = 192 + 63 * Math.cos(t01 * Math.PI * 2);
    return () => { params.whitePoint = base; };
  }
  if(mode === 'reveal'){
    // lightnessThreshold 30 ↔ 180 pingpong — edges emerge & recede.
    const base = params.lightnessThreshold;
    params.lightnessThreshold = 30 + 150 * pingPong(t01);
    return () => { params.lightnessThreshold = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseTh  = params.lightnessThreshold;
  const baseMax = params.maxDotSize;
  params.lightnessThreshold = 30 + ax * 170;   // 30..200
  params.maxDotSize         = 4  + ay * 26;    // 4..30
  return () => {
    params.lightnessThreshold = baseTh;
    params.maxDotSize         = baseMax;
  };
}

// tone-mode modulates whitePoint (preprocessor key) — must re-run preprocess.
// breath / reveal / interactive touch buildRects keys only.
let preprocessedIsToneModulated = false;
function renderAt(t01){
  const isTone = params.animate && params.mode === 'tone';
  const needsPre = isTone || preprocessedIsToneModulated;
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  if(needsPre) preprocess();
  buildRects();
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
const BUILD_KEYS = new Set(['lightnessThreshold','minDotSize','maxDotSize','stepSize']);
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
      canvas: cv, name: 'pixart-edge',
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
