// pixart/rgb-shift — chromatic aberration via per-channel offsets.
//
// Algorithm:
//   1. Preprocessor (shared) produces a W×H RGBA buffer.
//   2. Extract three single-channel frames (R-only, G-only, B-only).
//   3. Composite each at its per-channel (x,y) offset using the chosen blend.
//   4. `fringe` re-projects each channel via a radial alpha mask: at fringe=0
//      offsets apply uniformly; at fringe=1 they vanish at the centre and
//      reach full magnitude at the corners.
//   5. `gain` post-multiplies the composite via globalAlpha on each pass.
//
// Step 2 (pattern-set): animation + interactive cursor layered on top.
//
// Defaults: subtle chromatic aberration that keeps the portrait recognizable.
// Verified by sweeping rOffsetX / bOffsetX / fringe / gain against
// portrait.jpg (see docs/step2-screenshots/ + docs/step2-research.md):
//
//   rOffsetX=6, bOffsetX=-6   — symmetric ±6px split: faint red/blue fringe
//                                without channel-tear; face fully legible.
//   gOffsetX=0, all Y offsets=0 — green stays the anchor; horizontal only.
//   fringe=0.3                — centre nearly clean, corners get the colour
//                                halo; the "lens" feel without losing the face.
//   gain=1.0                  — additive recomposition lands at source brightness.
//   blend='add'               — channels sum back to faithful colour at zero shift.
//
// Animation modes (each = a cosine envelope across cycleMs=15000):
//
//   breath — rOffsetX and bOffsetX pingpong symmetrically around 0
//            (R: 0 → +14 → 0 → -14 → 0, B mirrored). Channels separate
//            and re-fuse like a breathing chromatic lens.
//   orbit  — R/G/B offsets rotate around a common circle of radius 10,
//            120° apart. Channels chase each other around the subject.
//   bloom  — fringe cosine pingpongs 0 ↔ 1. Chromatic halo grows from
//            centre and recedes; subject re-clarifies each cycle.
//
// Interactive: cursor X drives rOffsetX (-15..+15), cursor Y drives bOffsetX
// (-15..+15). Cursor pulls the channels apart in both axes — one metaphor:
// the cursor is the prism.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d');

// Per-channel single-channel canvases reused across paints.
const chanR = document.createElement('canvas');
const chanG = document.createElement('canvas');
const chanB = document.createElement('canvas');
const chanRCtx = chanR.getContext('2d');
const chanGCtx = chanG.getContext('2d');
const chanBCtx = chanB.getContext('2d');

const params = {
  // Preprocessor (shared).
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Per-channel offsets in px. Subtle horizontal stereoscopic split at default.
  rOffsetX:          6,
  rOffsetY:          0,
  gOffsetX:          0,
  gOffsetY:          0,
  bOffsetX:         -6,
  bOffsetY:          0,
  blend:            'add',
  gain:              1.0,
  fringe:            0.3,
  animate:           false,
  mode:             'breath',
  interactive:       false,
  showEffect:        true,
  fit:               'cover',
  bg:                '#0a0a0a',
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
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ---------- preprocessor (shared) ----------
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

  if(params.blurAmount > 0){
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const t = tmp.getContext('2d');
    t.filter = `blur(${params.blurAmount}px)`;
    t.drawImage(srcBuf, 0, 0);
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(tmp, 0, 0);
  }

  const id = sctx.getImageData(0, 0, W, H);
  preprocessed = id;
}

// ---------- build ----------
function buildOutput(){
  if(!preprocessed){ return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(outBuf.width !== W || outBuf.height !== H){
    outBuf.width = W; outBuf.height = H;
    chanR.width = W; chanR.height = H;
    chanG.width = W; chanG.height = H;
    chanB.width = W; chanB.height = H;
  }
  const src = preprocessed.data;

  const rImg = new ImageData(W, H);
  const gImg = new ImageData(W, H);
  const bImg = new ImageData(W, H);
  const rd = rImg.data, gd = gImg.data, bd = bImg.data;

  const fringe = clamp(params.fringe, 0, 1);
  const cx = W * 0.5, cy = H * 0.5;
  const rmax2 = cx*cx + cy*cy;

  for(let y = 0, j = 0; y < H; y++){
    for(let x = 0; x < W; x++, j += 4){
      let a = 255;
      if(fringe > 0){
        const dxr = x - cx, dyr = y - cy;
        const r2 = (dxr*dxr + dyr*dyr) / rmax2;
        a = ((1 - fringe) + fringe * r2) * 255;
        if(a < 0) a = 0; else if(a > 255) a = 255;
      }
      rd[j]   = src[j];   rd[j+1] = 0; rd[j+2] = 0; rd[j+3] = a;
      gd[j]   = 0; gd[j+1] = src[j+1]; gd[j+2] = 0; gd[j+3] = a;
      bd[j]   = 0; bd[j+1] = 0; bd[j+2] = src[j+2]; bd[j+3] = a;
    }
  }

  chanRCtx.putImageData(rImg, 0, 0);
  chanGCtx.putImageData(gImg, 0, 0);
  chanBCtx.putImageData(bImg, 0, 0);

  let comp = 'lighter';
  switch(params.blend){
    case 'screen':  comp = 'screen';      break;
    case 'lighten': comp = 'lighten';     break;
    case 'over':    comp = 'source-over'; break;
    case 'add':
    default:        comp = 'lighter';     break;
  }

  const gain = clamp(params.gain, 0, 4);

  octx.save();
  octx.globalCompositeOperation = 'source-over';
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, W, H);

  octx.globalAlpha = gain;
  octx.globalCompositeOperation = comp;
  octx.drawImage(chanR, params.rOffsetX, params.rOffsetY);
  octx.drawImage(chanG, params.gOffsetX, params.gOffsetY);
  octx.drawImage(chanB, params.bOffsetX, params.bOffsetY);
  octx.restore();
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
    if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
    else              { dw = W * 0.96; dh = dw / aspect; }
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  const imgW = outBuf.width, imgH = outBuf.height;
  const aspect = imgW / imgH;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(outBuf, ox, oy, dw, dh);
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
    // R/B pingpong symmetrically around 0. Amplitude 14 px.
    const baseRx = params.rOffsetX;
    const baseBx = params.bOffsetX;
    const s = Math.sin(t01 * Math.PI * 2) * 14;
    params.rOffsetX = s;
    params.bOffsetX = -s;
    return () => { params.rOffsetX = baseRx; params.bOffsetX = baseBx; };
  }
  if(mode === 'orbit'){
    // R/G/B offsets rotate around a circle of radius 10, 120° apart.
    const baseRx = params.rOffsetX, baseRy = params.rOffsetY;
    const baseGx = params.gOffsetX, baseGy = params.gOffsetY;
    const baseBx = params.bOffsetX, baseBy = params.bOffsetY;
    const r = 10;
    const a = t01 * Math.PI * 2;
    params.rOffsetX = r * Math.cos(a);
    params.rOffsetY = r * Math.sin(a);
    params.gOffsetX = r * Math.cos(a + Math.PI * 2/3);
    params.gOffsetY = r * Math.sin(a + Math.PI * 2/3);
    params.bOffsetX = r * Math.cos(a + Math.PI * 4/3);
    params.bOffsetY = r * Math.sin(a + Math.PI * 4/3);
    return () => {
      params.rOffsetX = baseRx; params.rOffsetY = baseRy;
      params.gOffsetX = baseGx; params.gOffsetY = baseGy;
      params.bOffsetX = baseBx; params.bOffsetY = baseBy;
    };
  }
  if(mode === 'bloom'){
    // fringe cosine pingpongs 0 ↔ 1.
    const baseF = params.fringe;
    params.fringe = pingPong(t01);
    return () => { params.fringe = baseF; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseRx = params.rOffsetX;
  const baseBx = params.bOffsetX;
  // X: -15..+15 → rOffsetX, Y: -15..+15 → bOffsetX.
  params.rOffsetX = (ax * 2 - 1) * 15;
  params.bOffsetX = (ay * 2 - 1) * 15;
  return () => { params.rOffsetX = baseRx; params.bOffsetX = baseBx; };
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

// ---------- WAEffect ----------
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

const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['rOffsetX','rOffsetY','gOffsetX','gOffsetY','bOffsetX','bOffsetY','blend','gain','fringe']);
const PAINT_KEYS = new Set(['showEffect']);

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
      canvas: cv, name: 'pixart-rgb-shift',
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
