// pixart/distort — port of tooooools.app/effects/distort.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/distort/page-bca54f0605d0ed09.js,
//  shared preprocessor in /_next/static/chunks/9357-2a51c42cdfe973de.js).
//
// Distort is an image-driven UV warp: a "distortion map" image whose RED
// channel is sampled per output pixel to push the source sample by (dx, dy):
//
//   s = mapRed[x, y]                         // 0..255
//   if s > threshold:
//     dx = map(s, 0,255, -xStrength, +xStrength)
//     dy = map(s, 0,255, -yStrength, +yStrength)
//     out[x,y] = source[clamp(x+dx,…), clamp(y+dy,…)]
//   else:
//     out[x,y] = source[x,y]
//
// See distort-research.md for parameter provenance.
//
// ---- Refinement pass (2026-05-13) ----
//
// `mode` selects one of six envelopes (idle / breath / rotate / pulse /
// march / harmonic). Each animates a different subset of the strength
// params; everything else holds at its slider value. Two new params:
//
//   harmonic     — third-harmonic mix amount [0..1] for `harmonic` mode.
//                  xStrength = A·sin(2π·t) + harmonic · A · sin(2π·t·3),
//                  which is Whitney's "two-harmonic = organic" trick.
//                  Helmholtz (1863) shows the ear hears the same shape
//                  as "fuller"; the eye reads the same x-warp as more
//                  alive than a pure sine.
//   phaseOffset  — [-π..π] phase shift applied to the map-sampling
//                  coordinates. The same distortion map produces wholly
//                  different output as the phase changes, because the
//                  per-pixel map sample is shifted along the warp
//                  vector before the look-up.
//
// Cursor focus: in interactive mode, the cursor is the *eye of the
// storm*. Inside `focusRadius` (source-space px) the per-pixel
// xStrength/yStrength are attenuated by `(d²/R²)` — zero at the centre,
// full at the boundary. The viewer reads the cursor as a still focal
// point in a moving field (Bret Victor, "Drawing Dynamic Visualizations").
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Working buffers, all sized to canvasSize × (canvasSize · sourceAspect).
const baseBuf = document.createElement('canvas');             // source resampled
const bctx    = baseBuf.getContext('2d', { willReadFrequently: true });
const mapBuf  = document.createElement('canvas');             // distortion map cover-cropped
const mctx    = mapBuf.getContext('2d', { willReadFrequently: true });
const outBuf  = document.createElement('canvas');             // warp result
const octx    = outBuf.getContext('2d');

// User-supplied distortion-map image (defaults to assets/displacement.png).
const mapImg = new Image();
mapImg.crossOrigin = 'anonymous';
let mapReady = false;

const params = {
  // Reference parameters (byte-for-byte from bundle defaults).
  canvasSize:              600,
  displacementThreshold:   0,
  xDisplacementStrength:  -75,
  yDisplacementStrength:   0,
  preprocessTarget:       'distortion',
  blurAmount:              0,
  grainAmount:             0,
  gamma:                   1,
  blackPoint:              0,
  whitePoint:              255,
  showEffect:              true,
  // ---- Refinement pass (2026-05-13) ----
  mode:                   'breath',
  // Third-harmonic mix amount for `harmonic` mode. Whitney/Helmholtz: a
  // pure sine reads mechanical; sine + 3·sine reads organic.
  harmonic:                0.35,
  // Phase shift applied to map-sample coordinates. Same map, different
  // warp pattern. Range matches the natural cycle of a 2π warp basis.
  phaseOffset:             0,
  // Cursor focus radius (source-space px). Inside the circle, warp
  // strength is attenuated by (d²/R²) — the cursor becomes a calm eye.
  focusRadius:             160,
  // pixart standard rows
  animate:                 false,
  interactive:             false,
  fit:                    'cover',
  bg:                     '#0a0a0a',
};

if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let baseImageData = null;     // ImageData of baseBuf (post-preprocess if "base")
let mapImageData  = null;     // ImageData of mapBuf  (post-preprocess if "distortion")
let dirty = { resample: true, pre: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// Transient module globals — written by renderAnimationFrame and the cursor
// handler, read by warp(). All return to defaults at end-of-frame so the
// static-render path stays branchless.
let _xStrengthAnim = null;     // override xStrength for this frame
let _yStrengthAnim = null;     // override yStrength for this frame
let _phaseAnim     = null;     // override phaseOffset for this frame
let _cursorFx = -1, _cursorFy = -1, _cursorFR2 = 0; // focus circle (source-space)

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

// mulberry32 — deterministic RNG seeded per-frame for the seamless loop.
let _rng = Math.random;
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFromT(t01){
  const w = ((t01 % 1) + 1) % 1;
  return Math.floor(w * 100003) + 1;
}

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
//
// Pull source through PIXSource at canvasSize × (canvasSize · srcAspect).
// Cover-fit + centre-crop the distortion map to match.
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

// ---------- preprocessor (mirrors tooooools' /utils/preprocessor) ----------
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
  const rnd = _rng;
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
      const n = (0.5 - rnd()) * g * 255;
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
//
// Faithful translation of the reference's per-pixel red-channel sample +
// signed map to (±xStrength, ±yStrength) + nearest-neighbour pull. Then
// refinements:
//   * phaseOffset shifts the map-sample lookup coordinates along the warp
//     vector itself, so the same map produces a different pattern.
//   * cursor focus attenuates strength by (d²/R²) inside the focusRadius
//     circle — zero at centre, full at boundary.
function warp(){
  if(!baseImageData || !mapImageData) return null;
  const W = baseImageData.width, H = baseImageData.height;
  const src = baseImageData.data;
  const m   = mapImageData.data;
  const out = octx.createImageData(W, H);
  const o   = out.data;
  const th  = params.displacementThreshold;
  const xs  = _xStrengthAnim !== null ? _xStrengthAnim : params.xDisplacementStrength;
  const ys  = _yStrengthAnim !== null ? _yStrengthAnim : params.yDisplacementStrength;
  const phase = _phaseAnim !== null ? _phaseAnim : params.phaseOffset;
  const invHalf = 1 / 127.5;
  const useFocus = _cursorFR2 > 0;
  // Phase shift is applied as a pixel-space offset along the warp axis.
  // Translating it into a sample-coordinate offset preserves seamlessness:
  // (phase / 2π) full cycles ⇒ shift by phase·W/(2π) pixels.
  const phasePxX = (phase / (Math.PI * 2)) * W;
  const phasePxY = (phase / (Math.PI * 2)) * H;
  for(let y = 0; y < H; y++){
    const yOff = y * W;
    for(let x = 0; x < W; x++){
      const i = (x + yOff) * 4;
      // Phase-shifted map sample. Wrap (toroidal) so the field stays continuous.
      let mx = x + phasePxX; mx = ((mx % W) + W) % W;
      let my = y + phasePxY; my = ((my % H) + H) % H;
      const mi = ((mx | 0) + (my | 0) * W) * 4;
      const s = m[mi]; // RED byte of the map at the shifted sample
      let p;
      if(s > th){
        const t = s * invHalf - 1;
        // Cursor focus: zero strength at centre, full at boundary.
        let attn = 1;
        if(useFocus){
          const dx0 = x - _cursorFx, dy0 = y - _cursorFy;
          const d2 = dx0*dx0 + dy0*dy0;
          if(d2 < _cursorFR2) attn = d2 / _cursorFR2; // 0 at centre, →1 at edge
        }
        let u = x + t * xs * attn;
        let v = y + t * ys * attn;
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
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
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
//
// 15s seamless loop. Each mode wraps t to [0,1) so cos(2π·t)==cos(0)==1
// in IEEE-754 and renderAt(0) byte-equals renderAt(1). Only the named
// subset of params animates; everything else holds at slider value.
//
//   idle      : everything holds. The rest frame IS the artwork.
//   breath    : cosine pingpong on xStrength + yStrength — calm, foveal.
//   rotate    : xStrength = xBase·cos(2π·t), yStrength = xBase·sin(2π·t).
//                Strength vector traces a full circle — the warp "rotates".
//   pulse     : yStrength spikes sharply, decays slowly. One per cycle.
//   march     : xStrength steps through 4 named magnitudes. Seam-override
//                at t=1 → tier 0 so endpoints match.
//   harmonic  : xStrength = A·sin(2π·t) + harmonic·A·sin(2π·t·3).
//                Whitney's two-harmonic = "organic" finding. Both terms
//                are 2π-periodic in t so the loop closes by construction.
function applyAnimationT(tLoop){
  let t = tLoop - Math.floor(tLoop);
  if(t === 1) t = 0;
  const xBase = params.xDisplacementStrength;
  const yBase = params.yDisplacementStrength;
  let xAnim = null, yAnim = null, phaseAnim = null;
  const TAU = Math.PI * 2;
  switch(params.mode){
    case 'rotate': {
      // Strength vector orbits at the slider's magnitude. Magnitude held
      // constant; angle sweeps 0→2π monotonically.
      const mag = Math.abs(xBase) || 75;
      xAnim = Math.round(mag * Math.cos(t * TAU));
      yAnim = Math.round(mag * Math.sin(t * TAU));
      break;
    }
    case 'pulse': {
      // Sharp asymmetric spike on yStrength; xStrength holds.
      const env = t < 0.2 ? t / 0.2 : Math.pow(1 - (t - 0.2) / 0.8, 2.5);
      const yMax = 80;
      yAnim = Math.round(yMax * env);
      break;
    }
    case 'march': {
      // 4 stepped magnitudes for xStrength. Seam-override at t=1 → tier 0.
      const tiers = [-75, -30, 30, 75];
      const idx = t === 0 ? 0 : Math.min(tiers.length - 1, Math.floor(t * tiers.length));
      xAnim = tiers[idx];
      break;
    }
    case 'harmonic': {
      // Two-harmonic sine. Whitney/Helmholtz: the third harmonic is the
      // smallest addition that already reads "organic" rather than pure.
      const A = Math.abs(xBase) || 75;
      const h = clamp(params.harmonic, 0, 1);
      xAnim = Math.round(A * (Math.sin(t * TAU) + h * Math.sin(t * TAU * 3)));
      // Sweep phaseOffset alongside the harmonic so the same map produces
      // a different pattern at each beat. Wraps exactly at t=0/t=1.
      phaseAnim = (1 - Math.cos(t * TAU)) / 2 * Math.PI - Math.PI / 2;
      break;
    }
    case 'idle': {
      break;
    }
    case 'breath':
    default: {
      // Original behaviour: yStrength sin sweep, xStrength small cosine
      // wobble around the user's baseline. Both close byte-equal at t=0/1.
      const yMax = 80, xWob = 25;
      yAnim = Math.round(yMax * Math.sin(t * TAU));
      xAnim = Math.round(xBase + xWob * (Math.cos(t * TAU) - 1) / 2);
      break;
    }
  }
  return { xAnim, yAnim, phaseAnim };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  _xStrengthAnim = anim.xAnim;
  _yStrengthAnim = anim.yAnim;
  _phaseAnim     = anim.phaseAnim;

  const needPre = params.grainAmount > 0;
  if(needPre){
    _rng = mulberry32(seedFromT(tLoop));
  }
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
  }
  preprocess();
  if(needPre) _rng = Math.random;
  paint();

  _xStrengthAnim = null; _yStrengthAnim = null; _phaseAnim = null;
}

function animationLoop(){
  if(!params.animate) return;
  const elapsed = performance.now() - animationStartTime;
  renderAnimationFrame((elapsed % CYCLE_MS) / CYCLE_MS);
  animationId = requestAnimationFrame(animationLoop);
}

function toggleAnimation(){
  if(params.animate){
    animationStartTime = performance.now();
    animationLoop();
  } else if(animationId){
    cancelAnimationFrame(animationId); animationId = null;
    schedule('paint');
  }
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(tLoop){ renderAnimationFrame(tLoop); },
  pauseRender(){ if(animationId){ cancelAnimationFrame(animationId); animationId = null; } },
  resumeRender(){
    if(params.animate && !animationId){
      animationStartTime = performance.now();
      animationLoop();
    } else if(!params.animate){
      schedule('pre');
    }
  },
};

const RESAMPLE_KEYS = new Set(['canvasSize','fit']);
const PRE_KEYS      = new Set([
  'blurAmount','grainAmount','gamma','blackPoint','whitePoint','preprocessTarget'
]);
// 'displacementThreshold', 'xDisplacementStrength', 'yDisplacementStrength',
// 'harmonic', 'phaseOffset', 'focusRadius', 'showEffect', 'bg' → paint-only.

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive){
    if(!baseImageData) return;
    // Map cursor to source-space coords. baseBuf is drawn fit-to-canvas
    // (contain), so reverse that mapping.
    const W = cv.width, H = cv.height;
    const sw = baseImageData.width, sh = baseImageData.height;
    const aspect = sw / sh;
    let dw, dh;
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    const sx = (mouseX * (W / r.width)  - ox) / dw * sw;
    const sy = (mouseY * (H / r.height) - oy) / dh * sh;
    const rSrc = params.focusRadius * sw / dw;
    _cursorFx = sx; _cursorFy = sy; _cursorFR2 = rSrc * rSrc;
    if(!params.animate) schedule('paint');
  } else if(_cursorFR2 !== 0){
    _cursorFR2 = 0;
    if(!params.animate) schedule('paint');
  }
}

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
    if(key === 'animate'){ toggleAnimation(); return; }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('resample'); else schedule('paint');
      return;
    }
    if(key === 'mode'){ /* anim envelope changes; no static rebuild needed */ return; }
    if(params.animate) return;
    if(RESAMPLE_KEYS.has(key))  schedule('resample');
    else if(PRE_KEYS.has(key))  schedule('pre');
    else                        schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => {
      if(!params.animate) schedule('resample');
    });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-distort',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  cv.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();

  wireDistortionMapInput();

  // Bundled distortion map mirrors the reference's /displacement.png boot.
  mapImg.onload = () => { mapReady = true; schedule('resample'); };
  mapImg.onerror = () => { console.warn('distort: bundled displacement map failed to load'); schedule('resample'); };
  mapImg.src = 'assets/displacement.png';

  schedule('resample');
}

document.addEventListener('DOMContentLoaded', init);
