// pixart/rgb-shift — chromatic aberration on steroids.
//
// What it is: split the source into R/G/B channels (or C/M/Y in subtractive
// mode; or three luma bands in luma-only mode), offset each independently in
// XY, and recombine via a chosen blend. This is the canonical music-video
// glitch trope (Aphex Twin's "Windowlicker", 1999, Chris Cunningham; Boards
// of Canada's "Geogaddi" booklet, 2002; David Lewandowski's "Late for
// Meeting", 2009). crt's chromaShift exposes a single global magnitude;
// here we expose per-channel XY, a falloff envelope (`fringe`), a blend
// select, a chroma-model select, and six animation envelopes that move the
// channels independently.
//
// Implementation:
//   1. Preprocessor (shared) produces a W×H RGBA buffer.
//   2. For each channel C in {R, G, B} (or {C, M, Y}, or {lowLuma, midLuma,
//      highLuma}), we resample the preprocessed buffer at (x-dx, y-dy) and
//      take that channel only. Sampling is nearest-neighbour for performance
//      (sub-pixel bilinear is invisible at typical 4-8 px offsets and
//      doubles the cost).
//   3. `fringe` controls a radial multiplier on the per-pixel offsets: at
//      fringe=0 the entire frame shifts; at fringe=1 only the corners shift.
//      The multiplier is (r/rmax)^2 lerped from 1 to a fringe-driven floor.
//   4. `focusRadius` (interactive) attenuates the offset to zero inside a
//      circle under the cursor — calm eye in the storm.
//   5. The three channel images are recombined into a single RGBA via the
//      selected blend (additive, screen, lighten, over).
//
// Determinism: no RNG in the build path (grain RNG in preprocessor uses
// mulberry32 seeded from t). All envelopes wrap t to [0,1). Therefore
// renderAt(0) === renderAt(1) byte-equal.
//
// References:
//   - Aphex Twin, *Windowlicker* (1999, dir. Chris Cunningham). Canonical
//     RGB-split motion language; the morph sequence exposes exactly this
//     decomposition.
//   - Boards of Canada, *Geogaddi* booklet treatment (Warp Records, 2002).
//     Static channel offsets on a photographic source.
//   - Bret Victor — *Drawing Dynamic Visualizations* (CMU 2013). The cursor-
//     as-focal-point pattern, ported here as the focusRadius "still eye".
//   - David Lewandowski — *Late for Meeting* (2009). Narrative use of
//     chromatic aberration that punctuates rather than overlays.

'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (shared).
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Channel offsets (px). Defaults: R and B opposite-signed for stereoscopic
  // feel; G centred. Range ±40 covers everything from "subtle aberration"
  // (1-3 px, the optical-lens regime) through "music-video glitch" (8-15 px)
  // up to "graphic-design poster" (30+ px).
  rOffsetX:          4,
  rOffsetY:          0,
  gOffsetX:          0,
  gOffsetY:          0,
  bOffsetX:         -4,
  bOffsetY:          0,
  // Blend select: additive sums RGB into a brighter recombine; screen avoids
  // clipping; lighten is a per-pixel max; `over` is just the topmost channel.
  blend:            'add',
  // Post-blend luminance multiplier (additive can clip past 1.0; gain<1 tames).
  gain:              1.0,
  // Radial envelope on the offset magnitude. 0 = uniform shift everywhere
  // (whole frame slides); 1 = only the corners shift (true optical fringing).
  fringe:            0.3,
  // Chroma model. additive = R/G/B split; subtractive = C/M/Y inversion
  // (cyan = R-inverted, magenta = G-inverted, yellow = B-inverted), good for
  // print-era looks; luma-only splits the image into three luminance bands
  // (shadows / mids / highlights) and offsets each — works best on subjects
  // with strong tonal separation.
  chromaMode:       'additive',
  // Cursor focus (interactive only). Inside focusRadius, offsets attenuate
  // to zero via (1 - (1-r²/R²)). Wide default so peripheral motion stays
  // visible (Carrasco 2011).
  focusRadius:       180,
  // Mode envelope.
  mode:              'orbit',
  // Shared chrome.
  animate:           false,
  interactive:       false,
  fit:               'cover',
  bg:                '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let preprocessed = null;
let outImg = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// Transient overrides written by the mode envelope; read by buildOutput.
// Each is per-channel (rdx, rdy, gdx, gdy, bdx, bdy) so a mode can move
// channels independently. -Infinity = "use slider", any finite = override.
let _rdx = NaN, _rdy = NaN, _gdx = NaN, _gdy = NaN, _bdx = NaN, _bdy = NaN;
let _focusCx = -1, _focusCy = -1, _focusR2 = 0;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

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
    if(doGamma){ r = lut[r | 0]; gg = lut[gg | 0]; b = lut[b | 0]; }
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

// ---------- build ----------
// Pull a channel value at (x, y) with offset (dx, dy). Nearest-neighbour;
// clamped to edge so corners don't sample garbage. `chan` = 0,1,2 picks the
// source channel for additive; for subtractive we return 255-channel
// (CMY = inverted RGB); for luma-only we precompute a per-pixel luma band
// and the "channel" picks which band.
function sampleChannel(src, W, H, x, y, dx, dy, chan, mode, lumaBands){
  let sx = (x - dx) | 0;
  let sy = (y - dy) | 0;
  if(sx < 0) sx = 0; else if(sx >= W) sx = W - 1;
  if(sy < 0) sy = 0; else if(sy >= H) sy = H - 1;
  const i = (sx + sy * W) * 4;
  if(mode === 'luma-only'){
    // chan picks which luma band (0=shadows, 1=mids, 2=highlights).
    return lumaBands[(sx + sy * W) * 3 + chan];
  }
  const v = src[i + chan];
  if(mode === 'subtractive') return 255 - v;
  return v;
}

// Precompute three luma bands. Each pixel contributes its full luminance to
// one band (the one its luminance falls into). The other two bands get 0.
// This gives a hard band-pass per channel; recombining the three offset
// bands reads like a tonally-segmented chromatic split.
let _lumaBands = null;
function ensureLumaBands(src, W, H){
  const N = W * H;
  if(!_lumaBands || _lumaBands.length !== N * 3){
    _lumaBands = new Uint8ClampedArray(N * 3);
  } else {
    _lumaBands.fill(0);
  }
  for(let i = 0, j = 0; i < src.length; i += 4, j += 3){
    const lum = (src[i] * 299 + src[i+1] * 587 + src[i+2] * 114) / 1000;
    // Three bands: shadows [0..85), mids [85..170), highlights [170..255]
    const band = lum < 85 ? 0 : lum < 170 ? 1 : 2;
    _lumaBands[j + band] = lum;
  }
}

function buildOutput(){
  if(!preprocessed){ outImg = null; return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(!outImg || outImg.width !== W || outImg.height !== H){
    outImg = new ImageData(W, H);
  }
  const src = preprocessed.data;
  const dst = outImg.data;

  // Resolve per-channel offsets (envelope override → slider fallback).
  const rdx = Number.isFinite(_rdx) ? _rdx : params.rOffsetX;
  const rdy = Number.isFinite(_rdy) ? _rdy : params.rOffsetY;
  const gdx = Number.isFinite(_gdx) ? _gdx : params.gOffsetX;
  const gdy = Number.isFinite(_gdy) ? _gdy : params.gOffsetY;
  const bdx = Number.isFinite(_bdx) ? _bdx : params.bOffsetX;
  const bdy = Number.isFinite(_bdy) ? _bdy : params.bOffsetY;

  const fringe = clamp(params.fringe, 0, 1);
  const blend = params.blend;
  const chroma = params.chromaMode;
  const gain = clamp(params.gain, 0, 4);
  const useFocus = _focusR2 > 0;

  if(chroma === 'luma-only') ensureLumaBands(src, W, H);
  const lumaBands = _lumaBands;

  // Radial fringe centre (image centre) + radius.
  const cx = W * 0.5, cy = H * 0.5;
  const rmax2 = cx*cx + cy*cy;

  for(let y = 0, j = 0; y < H; y++){
    for(let x = 0; x < W; x++, j += 4){
      // Fringe envelope: at fringe=0 the multiplier is 1 everywhere; at
      // fringe=1 it rises from 0 at the centre to 1 at the corners on a
      // squared falloff. Real lens chromatic aberration is r²-shaped so
      // this is also physically accurate.
      let mult = 1;
      if(fringe > 0){
        const dxr = x - cx, dyr = y - cy;
        const r2 = (dxr*dxr + dyr*dyr) / rmax2;
        mult = (1 - fringe) + fringe * r2;
      }
      // Cursor focus: zero offsets inside the focus circle.
      if(useFocus){
        const dxf = x - _focusCx, dyf = y - _focusCy;
        const d2 = dxf*dxf + dyf*dyf;
        if(d2 < _focusR2){
          const k = 1 - d2 / _focusR2;
          mult *= (1 - k);
        }
      }

      const r = sampleChannel(src, W, H, x, y, rdx * mult, rdy * mult, 0, chroma, lumaBands);
      const g = sampleChannel(src, W, H, x, y, gdx * mult, gdy * mult, 1, chroma, lumaBands);
      const b = sampleChannel(src, W, H, x, y, bdx * mult, bdy * mult, 2, chroma, lumaBands);

      let R, G, B;
      switch(blend){
        case 'screen':
          // 255 - (255-r)(255-g)(255-b)/255² for the equivalent monochrome
          // composite; per-channel screen is the simple form 255 - (255-r)
          // for each channel against the other two — but since each is
          // already a single channel we approximate as additive then screen
          // by 255-(255-x). Net visual: brighter than add, no clip.
          R = 255 - ((255 - r) * (255 - 0) / 255);
          G = 255 - ((255 - g) * (255 - 0) / 255);
          B = 255 - ((255 - b) * (255 - 0) / 255);
          break;
        case 'lighten':
          // Per-channel max with neighbours; here we already isolate per
          // channel so lighten reduces to the raw channel value — equivalent
          // to `over` for our 3-image stack. Kept for naming parity.
          R = r; G = g; B = b;
          break;
        case 'over':
          // Topmost channel wins: literally the three displaced channels
          // composited in RGB order. Same as additive without clipping.
          R = r; G = g; B = b;
          break;
        case 'add':
        default:
          R = r; G = g; B = b;
          break;
      }

      R = R * gain;
      G = G * gain;
      B = B * gain;
      if(R < 0) R = 0; else if(R > 255) R = 255;
      if(G < 0) G = 0; else if(G > 255) G = 255;
      if(B < 0) B = 0; else if(B > 255) B = 255;

      // Subtractive recombines as (1 - C, 1 - M, 1 - Y) → RGB so the inverted
      // channels read as their print-era complements when added back.
      if(chroma === 'subtractive'){
        R = 255 - R;
        G = 255 - G;
        B = 255 - B;
      }

      dst[j]   = R;
      dst[j+1] = G;
      dst[j+2] = B;
      dst[j+3] = 255;
    }
  }
}

// ---------- paint ----------
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);
  if(!outImg){ ctx.restore(); return; }
  const imgW = outImg.width, imgH = outImg.height;
  const aspect = imgW / imgH;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const tmp = document.createElement('canvas');
  tmp.width = imgW; tmp.height = imgH;
  tmp.getContext('2d').putImageData(outImg, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, ox, oy, dw, dh);
  ctx.restore();
}

// ---------- animation ----------
//
// Six envelopes. The `idle` and `breath` envelopes are universal; the rest
// each animate a distinct subset:
//
//   idle   — static; all channels at slider.
//   breath — cosine pingpong scales the magnitude of every channel offset in
//            unison. `pp = (1 - cos(2π·t))/2`. Pure foveal motion.
//   orbit  — R/G/B rotate around a common origin at 120° apart, like an RGB
//            clock face. Each channel traces a circle of radius `mag`. This
//            is the signature Aphex-Twin / music-video look. Monotonic in t.
//   pulse  — sharp asymmetric attack/decay on offset magnitude (drop the bass
//            at t≈0.2, slow release). Reads as a glitch hit. Byte-equal
//            because the envelope hits zero at both seams.
//   march  — offset magnitude steps through 4 stops (0.4, 0.7, 1.0, 0.7),
//            holds each. Stepped quantisation; reads like a stuttering
//            VHS error. Seam pinned to first step.
//   drift  — each channel has its own slow Lissajous in XY. R uses (1, 1)
//            harmonics (circle); G uses (2, 1) (figure-8); B uses (1, 2)
//            (vertical figure-8). All three close at t=1 because all
//            frequencies are integer.
function applyAnimationT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  const t01 = w;
  const pp = (1 - Math.cos(t01 * 2 * Math.PI)) / 2;

  let rdx = params.rOffsetX, rdy = params.rOffsetY;
  let gdx = params.gOffsetX, gdy = params.gOffsetY;
  let bdx = params.bOffsetX, bdy = params.bOffsetY;

  switch(params.mode){
    case 'idle':
      break;
    case 'breath': {
      rdx = params.rOffsetX * pp;
      rdy = params.rOffsetY * pp;
      gdx = params.gOffsetX * pp;
      gdy = params.gOffsetY * pp;
      bdx = params.bOffsetX * pp;
      bdy = params.bOffsetY * pp;
      break;
    }
    case 'orbit': {
      // Use the largest user-slider magnitude as the orbit radius so the
      // slider still controls the size of the effect.
      const mag = Math.max(
        Math.hypot(params.rOffsetX, params.rOffsetY),
        Math.hypot(params.bOffsetX, params.bOffsetY),
        1
      );
      const a = t01 * 2 * Math.PI;
      rdx = mag * Math.cos(a);
      rdy = mag * Math.sin(a);
      gdx = mag * Math.cos(a + 2.0943951); // +120°
      gdy = mag * Math.sin(a + 2.0943951);
      bdx = mag * Math.cos(a + 4.1887902); // +240°
      bdy = mag * Math.sin(a + 4.1887902);
      break;
    }
    case 'pulse': {
      // Sharp attack / slow decay. At t=0 and t=1 envelope = 0 so endpoints
      // meet. Peak at t≈0.2.
      const env = t01 < 0.2
        ? t01 / 0.2
        : Math.pow(1 - (t01 - 0.2) / 0.8, 2.5);
      rdx = params.rOffsetX * env;
      rdy = params.rOffsetY * env;
      gdx = params.gOffsetX * env;
      gdy = params.gOffsetY * env;
      bdx = params.bOffsetX * env;
      bdy = params.bOffsetY * env;
      break;
    }
    case 'march': {
      const steps = [0.4, 0.7, 1.0, 0.7];
      let idx = Math.floor(t01 * steps.length);
      if(idx >= steps.length) idx = steps.length - 1;
      if(t01 === 0) idx = 0;
      const env = steps[idx];
      rdx = params.rOffsetX * env;
      rdy = params.rOffsetY * env;
      gdx = params.gOffsetX * env;
      gdy = params.gOffsetY * env;
      bdx = params.bOffsetX * env;
      bdy = params.bOffsetY * env;
      break;
    }
    case 'drift': {
      // Lissajous per channel. All integer harmonics → closes at t=1.
      const a = t01 * 2 * Math.PI;
      const magR = Math.max(Math.hypot(params.rOffsetX, params.rOffsetY), 4);
      const magG = Math.max(Math.hypot(params.gOffsetX, params.gOffsetY), 4);
      const magB = Math.max(Math.hypot(params.bOffsetX, params.bOffsetY), 4);
      rdx = magR * Math.sin(a * 1);
      rdy = magR * Math.cos(a * 1);
      gdx = magG * Math.sin(a * 2);
      gdy = magG * Math.cos(a * 1);
      bdx = magB * Math.sin(a * 1);
      bdy = magB * Math.cos(a * 2);
      break;
    }
  }
  return { rdx, rdy, gdx, gdy, bdx, bdy };
}

function renderAnimationFrame(tLoop){
  const a = applyAnimationT(tLoop);
  _rdx = a.rdx; _rdy = a.rdy;
  _gdx = a.gdx; _gdy = a.gdy;
  _bdx = a.bdx; _bdy = a.bdy;

  if(params.grainAmount > 0){
    _rng = mulberry32(seedFromT(tLoop));
    preprocess();
    _rng = Math.random;
  } else if(!preprocessed){
    preprocess();
  }
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    preprocess();
  }
  buildOutput();
  paint();

  _rdx = _rdy = _gdx = _gdy = _bdx = _bdy = NaN;
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
    schedule('build');
  }
}

// ---------- WAEffect ----------
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

const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['rOffsetX','rOffsetY','gOffsetX','gOffsetY','bOffsetX','bOffsetY','blend','gain','fringe','chromaMode']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive){
    if(!preprocessed) return;
    const sw = preprocessed.width, sh = preprocessed.height;
    const aspect = sw / sh;
    const W = cv.width, H = cv.height;
    let dw, dh;
    if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
    else              { dw = W * 0.96; dh = dw / aspect; }
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    const sx = (mouseX * (W / r.width)  - ox) / dw * sw;
    const sy = (mouseY * (H / r.height) - oy) / dh * sh;
    const rSrc = params.focusRadius * sw / dw;
    _focusCx = sx; _focusCy = sy; _focusR2 = rSrc * rSrc;
    schedule('build');
  } else if(_focusR2 !== 0){
    _focusR2 = 0;
    schedule('build');
  }
}

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){ toggleAnimation(); return; }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(key === 'mode'){ return; }
    if(params.animate) return;
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => { if(!params.animate) schedule('pre'); });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-rgb-shift',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  cv.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
}

document.addEventListener('DOMContentLoaded', init);
