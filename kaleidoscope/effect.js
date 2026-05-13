// pixart/kaleidoscope — N-fold rotational + mirror symmetry on a UV warp.
//
// For each output pixel (x, y):
//   1. Compute polar (r, θ) about the canvas centre.
//   2. Fold θ into the wedge [0, 2π/N] via modulo.
//   3. If `mirror`, reflect alternate slices so the seam is continuous
//      (Brewster two-mirror primitive: the slice index parity flips the wedge).
//   4. Add `angleOffset` to rotate the whole pattern.
//   5. Sample source at sample-origin + (r·cos θ', r·sin θ'); wrap toroidally.
//
// References: Brewster (1816), Quilez polar-symmetry article, Shadertoy MdSfDz.
//
// Step 2 (pattern-set): animation + interactive cursor layered on top, matching
// the bevel pattern (applyMode, applyInteractive, renderAt, WAEffect.cycleMs).
//
// Tested defaults (portrait recognizable through the 8-fold fold; swept in
// browser against portrait.jpg):
//
//   segments=8       — 8 petals reads as a classic kaleidoscope while
//                      preserving enough wedge area for portrait features.
//   angleOffset=0    — neutral; the petal seams sit on the cardinal axes.
//   zoom=1.2         — gently magnifies past the seam ring; <0.8 reveals
//                      the unfolded source, >2 dissolves into texture.
//   sampleX=0,Y=0    — centre. Portrait centred in source = symmetric petals.
//   mirror=true      — continuous seams; without it the wedge edge tears.
//
// Animation modes (each = cycleMs=15000):
//
//   rotate — angleOffset monotonic 0 → 2π over the loop. Whole pattern
//            spins like a real kaleidoscope tube being turned.
//   breath — zoom cosine pingpongs 0.7 ↔ 2.0 around the default. Pattern
//            inhales and exhales through the seam ring.
//   petals — segments steps through [4, 6, 8, 12] one fold-count per quarter
//            of the loop. Discrete pop, beautiful re-tile each step.
//
// Interactive: cursor X → angleOffset (-π..π), cursor Y → zoom (0.5..2.5).
// Metaphor: the cursor turns and pushes the kaleidoscope tube.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });
const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d');

const params = {
  // Preprocessor (shared with edge / distort / flow-field).
  canvasSize:  600,
  blurAmount:  0,
  grainAmount: 0,
  gamma:       1,
  blackPoint:  0,
  whitePoint:  255,
  // Kaleidoscope-specific.
  segments:    8,
  angleOffset: 0,
  mirror:      true,
  sampleX:     0,
  sampleY:     0,
  zoom:        1.2,
  // Animation + interactive (pattern-set layer).
  animate:     false,
  mode:        'rotate',
  interactive: false,
  // Show the effect, or fall through to raw source.
  showEffect:  true,
  // Shared chrome.
  fit:         'cover',
  bg:          '#0a0a0a',
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

// ── preprocessor ─────────────────────────────────────────────
function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = params.canvasSize;
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
  const px = id.data;
  const g  = params.grainAmount;
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
}

// ── warp: the kaleidoscope itself ────────────────────────────
function warp(){
  if(!preprocessed) return null;
  const W = preprocessed.width, H = preprocessed.height;
  const src = preprocessed.data;
  const out = octx.createImageData(W, H);
  const o = out.data;

  const N = Math.max(2, Math.round(params.segments));
  const wedge = (Math.PI * 2) / N;
  const angOff = params.angleOffset;
  const zoom = params.zoom;
  const sxN = params.sampleX;
  const syN = params.sampleY;
  const mirror = params.mirror;

  const cx = W * 0.5, cy = H * 0.5;
  const ox = cx + sxN * cx;
  const oy = cy + syN * cy;
  const invZ = 1 / Math.max(0.01, zoom);
  const TAU = Math.PI * 2;

  for(let y = 0; y < H; y++){
    const dy0 = (y - cy);
    for(let x = 0; x < W; x++){
      const dx0 = (x - cx);
      const r = Math.hypot(dx0, dy0) * invZ;
      let th = Math.atan2(dy0, dx0);

      // Fold θ into [0, wedge). Mirror alternate slices for continuous seams.
      let a = ((th % TAU) + TAU) % TAU;
      const slice = Math.floor(a / wedge);
      a -= slice * wedge;
      if(mirror && (slice & 1)) a = wedge - a;
      th = a + angOff;

      const sx = ox + r * Math.cos(th);
      const sy = oy + r * Math.sin(th);

      const ix = ((sx | 0) % W + W) % W;
      const iy = ((sy | 0) % H + H) % H;
      const si = (ix + iy * W) * 4;
      const oi = (x + y * W) * 4;

      o[oi]   = src[si];
      o[oi+1] = src[si+1];
      o[oi+2] = src[si+2];
      o[oi+3] = 255;
    }
  }
  octx.putImageData(out, 0, 0);
  return outBuf;
}

// ── paint ────────────────────────────────────────────────────
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!preprocessed){ ctx.restore(); return; }

  const surface = params.showEffect ? (warp() || srcBuf) : srcBuf;
  const aspect = surface.width / surface.height;
  let dw, dh;
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(surface, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ── animation + interactive (matches bevel pattern) ──────────
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

const PETAL_STEPS = [4, 6, 8, 12];

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'rotate'){
    const base = params.angleOffset;
    params.angleOffset = t01 * Math.PI * 2;
    return () => { params.angleOffset = base; };
  }
  if(mode === 'breath'){
    // Zoom 0.7 ↔ 2.0 cosine. Centre 1.35, amplitude 0.65. Both ends keep
    // the portrait recognisable while giving real depth motion.
    const base = params.zoom;
    params.zoom = 1.35 + 0.65 * Math.cos(t01 * Math.PI * 2);
    return () => { params.zoom = base; };
  }
  if(mode === 'petals'){
    // Step segments through [4,6,8,12] — one per quarter loop.
    const base = params.segments;
    const idx = Math.min(PETAL_STEPS.length - 1, Math.floor(t01 * PETAL_STEPS.length));
    params.segments = PETAL_STEPS[idx];
    return () => { params.segments = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseAngle = params.angleOffset;
  const baseZoom  = params.zoom;
  // X → angleOffset (-π..π); Y → zoom (0.5..2.5, deeper at bottom).
  params.angleOffset = (ax * 2 - 1) * Math.PI;
  params.zoom = 0.5 + ay * 2.0;
  return () => { params.angleOffset = baseAngle; params.zoom = baseZoom; };
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

// ── WAEffect contract ────────────────────────────────────────
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

const PRE_KEYS = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);

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
      canvas: cv, name: 'pixart-kaleidoscope',
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
