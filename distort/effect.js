// pixart/distort — image-driven UV warp (displacement map's red channel pushes
// per-pixel UV by ±strength). Reverse-engineered from
// tooooools.app/effects/distort. Algorithm:
//
//   s = mapRed[x, y]                         // 0..255
//   if s > threshold:
//     t  = s/127.5 - 1                       // -1..+1
//     u  = x + t * xDisplacementStrength
//     v  = y + t * yDisplacementStrength
//     out[x,y] = source[clamp(u), clamp(v)]
//   else:
//     out[x,y] = source[x,y]
//
// Step 2 (pattern-set): animation + interactive cursor layered on top of the
// static port. Pattern mirrors bevel/effect.js — same applyMode(t01) /
// applyInteractive() with restore callbacks so GUI sliders keep showing
// user intent, not modulated values.
//
// Defaults were chosen by sweeping each candidate control alone against
// portrait.jpg (see docs/step2-screenshots/ and docs/step2-research.md).
// Sweet spot for "bundled glassy map warps the portrait AND portrait stays
// recognizable":
//
//   xDisplacementStrength=-75 — reference default; portrait reads as a
//                                molten-glass slide of the face, still legible.
//   yDisplacementStrength=  0 — reference default; tone mode and interactive
//                                Y both modulate around this baseline.
//   displacementThreshold=  0 — reference default; every map pixel writes a
//                                warped sample. breath mode raises this to
//                                gate the warp by map brightness.
//   whitePoint=             255 — full range; tone mode pulls this down to
//                                  130 (map levels-compress → less warp,
//                                  portrait crystallises back to clarity).
//
// Animation modes (each = one control's cosine envelope, cycleMs=15000):
//
//   swell — xDisplacementStrength pingpongs -150 ↔ 0. The warp surges in
//           and out around the reference baseline; portrait melts and
//           re-forms once per loop.
//   tone  — whitePoint drifts 130 ↔ 255 on the preprocessed distortion map.
//           Low wp clips the map's mid-greys to white → warp falls off →
//           portrait crystallises; high wp restores full warp.
//   breath— displacementThreshold pingpongs 0 ↔ 160. The warp gates by map
//           brightness — at threshold=160 only the brightest streaks warp,
//           rest of the portrait shows through cleanly.
//
// Interactive: cursor X drives xDisplacementStrength (-100..100, left edge
// pulls hard left, right edge pulls hard right); cursor Y drives
// yDisplacementStrength (-100..100, top pulls up, bottom pulls down). One
// metaphor: cursor is the warp's pull direction.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const baseBuf = document.createElement('canvas');             // source resampled
const bctx    = baseBuf.getContext('2d', { willReadFrequently: true });
const mapBuf  = document.createElement('canvas');             // distortion map cover-cropped
const mctx    = mapBuf.getContext('2d', { willReadFrequently: true });
const outBuf  = document.createElement('canvas');             // warp result
const octx    = outBuf.getContext('2d');

const mapImg = new Image();
mapImg.crossOrigin = 'anonymous';
let mapReady = false;

const params = {
  // Reference defaults, byte-for-byte from the bundle, verified against the
  // live panel 2026-05-13.
  canvasSize:              600,
  blurAmount:              0,
  grainAmount:             0,
  gamma:                   1,
  blackPoint:              0,
  whitePoint:              255,
  showEffect:              true,
  preprocessTarget:       'distortion',
  displacementThreshold:   0,
  xDisplacementStrength:  -75,
  yDisplacementStrength:   0,
  // Step 2 animation/interaction (no new effect params, only UI toggles).
  animate:                 false,
  mode:                    'swell',
  interactive:             false,
};

if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let baseImageData = null;
let mapImageData  = null;
let dirty = { resample: true, pre: true, paint: true };
let rafQueued = false;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

function schedule(level){
  if(level === 'resample') dirty.resample = true;
  if(level === 'resample' || level === 'pre') dirty.pre = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.resample) resample();
    if(dirty.pre)      preprocess();
    paint();
    dirty.resample = dirty.pre = dirty.paint = false;
  });
}

function fitCanvas(){
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ---------- resample ----------
function resample(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = params.canvasSize;
  const H = Math.max(1, Math.round(W * aspect));
  if(baseBuf.width !== W || baseBuf.height !== H){
    baseBuf.width = W; baseBuf.height = H;
    outBuf.width  = W; outBuf.height  = H;
    mapBuf.width  = W; mapBuf.height  = H;
  }
  bctx.clearRect(0, 0, W, H);
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(srcCv, 0, 0, W, H);

  mctx.clearRect(0, 0, W, H);
  if(mapReady){
    const mw = mapImg.naturalWidth, mh = mapImg.naturalHeight;
    if(mw && mh){
      const s = Math.max(W / mw, H / mh);
      const dw = mw * s, dh = mh * s;
      const dx = (W - dw) / 2, dy = (H - dh) / 2;
      mctx.imageSmoothingEnabled = true;
      mctx.imageSmoothingQuality = 'high';
      mctx.drawImage(mapImg, dx, dy, dw, dh);
    }
  } else {
    mctx.fillStyle = '#808080';
    mctx.fillRect(0, 0, W, H);
  }
}

// ---------- preprocessor (Blur → Grain → Gamma → Levels) ----------
function preprocessSurface(srcCtx, srcCv){
  const W = srcCv.width, H = srcCv.height;
  if(params.blurAmount > 0){
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const t = tmp.getContext('2d');
    t.filter = `blur(${params.blurAmount}px)`;
    t.drawImage(srcCv, 0, 0);
    srcCtx.clearRect(0, 0, W, H);
    srcCtx.drawImage(tmp, 0, 0);
  }
  const id = srcCtx.getImageData(0, 0, W, H);
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
  srcCtx.putImageData(id, 0, 0);
  return id;
}

function preprocess(){
  if(!baseBuf.width) return;
  // Always re-draw the un-preprocessed surfaces first so the preprocessor
  // operates on the source map/base, not a cumulatively-mutated one.
  resample();
  if(params.preprocessTarget === 'base'){
    baseImageData = preprocessSurface(bctx, baseBuf);
    mapImageData  = mctx.getImageData(0, 0, mapBuf.width, mapBuf.height);
  } else {
    mapImageData  = preprocessSurface(mctx, mapBuf);
    baseImageData = bctx.getImageData(0, 0, baseBuf.width, baseBuf.height);
  }
}

// ---------- warp ----------
function warp(){
  if(!baseImageData || !mapImageData) return null;
  const W = baseImageData.width, H = baseImageData.height;
  const src = baseImageData.data;
  const m   = mapImageData.data;
  const out = octx.createImageData(W, H);
  const o   = out.data;
  const th  = params.displacementThreshold;
  const xs  = params.xDisplacementStrength;
  const ys  = params.yDisplacementStrength;
  const invHalf = 1 / 127.5;
  for(let y = 0; y < H; y++){
    const yOff = y * W;
    for(let x = 0; x < W; x++){
      const i = (x + yOff) * 4;
      const s = m[i]; // RED channel of the map
      let p;
      if(s > th){
        const t = s * invHalf - 1; // map 0..255 → -1..+1
        let u = x + t * xs;
        let v = y + t * ys;
        if(u < 0) u = 0; else if(u > W - 1) u = W - 1;
        if(v < 0) v = 0; else if(v > H - 1) v = H - 1;
        p = ((u | 0) + (v | 0) * W) * 4;
      } else {
        p = i;
      }
      o[i]   = src[p];
      o[i+1] = src[p+1];
      o[i+2] = src[p+2];
      o[i+3] = src[p+3];
    }
  }
  octx.putImageData(out, 0, 0);
  return outBuf;
}

// ---------- paint ----------
function paint(){
  window.WAGUI?.flashValues(params);
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);
  if(!baseImageData){ ctx.restore(); return; }

  let surface;
  if(params.showEffect){
    surface = warp() || baseBuf;
  } else {
    surface = params.preprocessTarget === 'base' ? baseBuf : mapBuf;
  }

  const aspect = surface.width / surface.height;
  let dw, dh;
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(surface, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ---------- animation ----------
const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

// Cosine pingpong: 0 → 1 → 0 across t in [0,1).
function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'swell'){
    // xDisplacementStrength pingpongs from base (-75) to twice-base (-150)
    // and back. Cosine envelope around the user's set baseline so the warp
    // surges symmetrically; at t=0 we sit at base (recognisable frame).
    const base = params.xDisplacementStrength;
    params.xDisplacementStrength = base + base * pingPong(t01);
    return () => { params.xDisplacementStrength = base; };
  }
  if(mode === 'tone'){
    // whitePoint cosine 130 ↔ 255. Centre 192, amplitude 63.
    const base = params.whitePoint;
    params.whitePoint = 192 + 63 * Math.cos(t01 * Math.PI * 2);
    return () => { params.whitePoint = base; };
  }
  if(mode === 'breath'){
    // displacementThreshold pingpongs 0 ↔ 160. At 160 only bright streaks
    // warp; portrait shows through almost cleanly.
    const base = params.displacementThreshold;
    params.displacementThreshold = 160 * pingPong(t01);
    return () => { params.displacementThreshold = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseX = params.xDisplacementStrength;
  const baseY = params.yDisplacementStrength;
  // X: -100 (left edge) → +100 (right edge)
  // Y: -100 (top) → +100 (bottom)
  params.xDisplacementStrength = -100 + ax * 200;
  params.yDisplacementStrength = -100 + ay * 200;
  return () => {
    params.xDisplacementStrength = baseX;
    params.yDisplacementStrength = baseY;
  };
}

// Track whether last frame baked tone-modulated whitePoint into the
// preprocessed map buffer; if so, next non-tone frame must re-preprocess.
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
  return cv;
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
  renderAt(t){ return renderAt(t || 0); },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else schedule('paint');
    return cv;
  },
};

const RESAMPLE_KEYS = new Set(['canvasSize']);
const PRE_KEYS      = new Set([
  'blurAmount','grainAmount','gamma','blackPoint','whitePoint','preprocessTarget'
]);
// 'displacementThreshold', 'xDisplacementStrength', 'yDisplacementStrength',
// 'showEffect' → paint-only.

function wireDistortionMapInput(){
  const row = document.querySelector('.wg-row[data-key="distortionMap"]');
  if(!row) return;
  const input = row.querySelector('input[type=file]');
  const label = row.querySelector('.wg-file-label');
  input?.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if(!f) return;
    const url = URL.createObjectURL(f);
    mapImg.onload = () => { mapReady = true; schedule('resample'); };
    mapImg.src = url;
    if(label) label.textContent = f.name.length > 18 ? f.name.slice(0, 15) + '…' : f.name;
  });
}

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
    if(params.animate) return; // animation loop owns the canvas
    if(RESAMPLE_KEYS.has(key))  schedule('resample');
    else if(PRE_KEYS.has(key))  schedule('pre');
    else                        schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('resample'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-distort',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();

  wireDistortionMapInput();

  mapImg.onload = () => { mapReady = true; schedule('resample'); };
  mapImg.onerror = () => { console.warn('distort: bundled displacement map failed to load'); schedule('resample'); };
  mapImg.src = 'assets/displacement.png';

  schedule('resample');
  if(params.animate) startAnimation();
}

document.addEventListener('DOMContentLoaded', init);
