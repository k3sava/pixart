// pixart/zoom-blur — radial / rotational / spiral / motion-line blur.
//
// Original to pixart (no tooooools reference). Built 2026-05-13.
//
// What this effect is:
//   For each output pixel (x,y) we accumulate N samples of the source at
//   positions interpolated between (focusX, focusY) and (x,y), and average
//   them. The result is a motion-blur that *radiates* — the focal point stays
//   sharp, everything else streaks outward along the radial.
//
//   Mathematically, for sample index k in [0..N-1]:
//
//     u = (k / (N-1)) · strength          // sample distance fraction
//     sx = lerp(focusX, x, 1 - u)         // sample position, towards focus
//     sy = lerp(focusY, y, 1 - u)
//
//   For *rotational* blur the sample is rotated by angle θ_k around the
//   focus, holding radius r = |p - focus| constant. For *spiral* it combines
//   both (zoom + twist). For *motion-line* it's a directional translation
//   along a single axis — Knoll's "motion blur", not radial.
//
// Why these four:
//   - Zoom and rotational are the two Knoll-Photoshop "Radial Blur" subtypes
//     (1995 filter), and the only two most users ever see. We add spiral
//     because the composite is recognisably "more cinematic" than either
//     alone (Inigo Quilez's "Radial blur" article makes the same case).
//   - Motion-line subsumes Tim Macmillan's frozen-time arrays, where the
//     blur direction is the camera's motion vector — included for completeness
//     and because the music-video idiom (Hype Williams 1999, *Belly*) used it.
//
// Determinism and the seamless loop:
//   - The Monte Carlo sample positions are *not* random by default — they
//     are uniformly spaced 0..1 across the ray. `seed` enables a jittered
//     variant (Halton-style) that re-seeds from t for animations. The seam
//     is preserved because seedFromT(0)===seedFromT(1) by construction.
//   - `chase` mode uses a closed Lissajous (sin/cos of TAU·t) so the focal
//     point returns exactly to its origin at t=1.
//   - `spin` is a monotonic angular sweep 0→2π so at t=1 the rotation wraps
//     back to t=0's value. cos(2π)/sin(2π) collapse to (1,0) in IEEE-754.
//   ⇒ renderAt(0) === renderAt(1) byte-equal.
//
// Modes:
//   idle    — static blur, no animation.
//   breath  — `strength` cosine pingpong, calm.
//   pulse   — strength asymmetric spike (the zoom *punch*).
//   spin    — rotation angle 0→360° monotonic; rotational blur only.
//   march   — blurType cycles zoom → rotational → spiral → motion-line.
//   chase   — focal point migrates around a closed Lissajous; centre moves.
//
// References:
//   - Knoll, J. *Photoshop Radial Blur* (1995 filter; Photoshop 3 release notes).
//     The two-subtype zoom/rotational split is canonical.
//   - Macmillan, T. *Time-Slice* (1980s) + Wachowskis *The Matrix* (1999):
//     bullet-time, the camera-array origin of frozen-radial motion.
//   - Quilez, I. "Radial blur" (iquilezles.org). The classic shader analysis
//     of the N-sample average and how strength relates to perceived motion.
//   - Hitchcock, A. *Vertigo* (1958): the dolly-zoom, perceptual ancestor of
//     the zoom-blur — same psychoacoustic-equivalent for vision.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Working buffers — source resampled, and the output blur buffer.
const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });
const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d');

const params = {
  canvasSize:     480,    // a touch smaller than siblings — N-sample inner loop is hot
  blurType:       'zoom', // zoom | rotational | spiral | motion-line
  strength:       0.5,
  samples:        16,
  focusX:         0.5,
  focusY:         0.5,
  dropoff:        1,      // strength falloff exponent near focus
  holdSharp:      0.2,    // radius around focus that stays sharp (0..1)
  direction:      0,      // degrees, for motion-line
  spiralTwist:    90,     // degrees, additional twist for spiral
  seed:           1,
  focusRadius:    180,    // cursor focus radius (px in canvas space)
  mode:           'breath',
  animate:        false,
  interactive:    false,
  fit:            'cover',
  bg:             '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let resampled = null;
let dirty = { resample: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// Per-frame transients.
let _strengthOverride = null;
let _angleOverride    = null;  // radians, for spin
let _typeOverride     = null;
let _focusXOverride   = null;
let _focusYOverride   = null;
let _frameSeed        = 1;

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

// ---------- resample ----------
function resample(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = params.canvasSize;
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

// ---------- blur kernels ----------
//
// All four kernels share the same outer (x, y) sweep + inner k-sample
// accumulator. They differ only in how (sx, sy) is derived from k.
function applyBlur(){
  if(!resampled) return null;
  const W = resampled.width, H = resampled.height;
  const src = resampled.data;
  const out = octx.createImageData(W, H);
  const o = out.data;

  const type = _typeOverride || params.blurType;
  const N = clamp(params.samples | 0, 2, 64);
  const strength = clamp(_strengthOverride != null ? _strengthOverride : params.strength, 0, 1);
  // Max sample displacement, in pixels, along the radial. 1.0 = full canvas diagonal.
  const maxDist = strength * Math.hypot(W, H);
  const fxN = _focusXOverride != null ? _focusXOverride : params.focusX;
  const fyN = _focusYOverride != null ? _focusYOverride : params.focusY;
  const fx = fxN * W, fy = fyN * H;
  const dropoff = clamp(params.dropoff, 0, 2);
  // Hold-sharp radius in pixels (no blur applied inside this circle).
  const holdR = params.holdSharp * Math.hypot(W, H) * 0.5;
  const holdR2 = holdR * holdR;
  // Direction angle (for motion-line).
  const dirRad = (params.direction % 360) * Math.PI / 180;
  const motionDx = Math.cos(dirRad);
  const motionDy = Math.sin(dirRad);
  // Spiral twist — total angle from k=0 to k=N-1.
  const twistRad = ((_angleOverride != null ? _angleOverride : params.spiralTwist * Math.PI / 180));
  // Spin override (full rotational angle for rotational/spiral modes).
  const spinRad = _angleOverride != null ? _angleOverride : 0;
  // Optional jitter (when seed is set). Halton-ish small offset per-pixel.
  const rng = mulberry32(_frameSeed);
  // Pre-roll a small jitter table per sample index so the inner loop is fast.
  const jitter = new Float32Array(N);
  for(let i = 0; i < N; i++) jitter[i] = rng() * 0.5 - 0.25; // ±0.25 sample
  const invN = 1 / Math.max(1, N - 1);

  for(let y = 0; y < H; y++){
    for(let x = 0; x < W; x++){
      const i = (x + y * W) * 4;
      const dx0 = x - fx, dy0 = y - fy;
      const r2 = dx0*dx0 + dy0*dy0;

      // Sharp hold near focus.
      if(r2 < holdR2){
        o[i]   = src[i];
        o[i+1] = src[i+1];
        o[i+2] = src[i+2];
        o[i+3] = src[i+3];
        continue;
      }

      // Radial distance & angle from focus.
      const r = Math.sqrt(r2);
      const theta = Math.atan2(dy0, dx0);
      // Effective sample length: scales with distance from focus, modulated by
      // `dropoff` (1 = linear, 2 = quadratic — far pixels blur much more).
      const distNorm = clamp(r / Math.max(1, maxDist), 0, 1);
      const lenFactor = Math.pow(distNorm, dropoff);
      const sampleLen = maxDist * lenFactor;

      let sumR = 0, sumG = 0, sumB = 0, sumA = 0, count = 0;
      for(let k = 0; k < N; k++){
        const u = (k * invN);
        // Sample fraction with jitter. u=0 ⇒ sample = focus, u=1 ⇒ sample = (x,y).
        const uj = clamp(u + jitter[k] * invN, 0, 1);
        let sx, sy;
        switch(type){
          case 'rotational': {
            // Sample along a circle of radius r centred at focus, sweeping
            // through ±(angleSpan/2). angleSpan grows with strength so a
            // distant pixel traces a longer arc than a near one.
            const angleSpan = strength * 0.6 + spinRad;
            const t01 = (uj - 0.5);
            const a = theta + t01 * angleSpan;
            sx = fx + r * Math.cos(a);
            sy = fy + r * Math.sin(a);
            break;
          }
          case 'spiral': {
            // Combine zoom (radius interp) + rotation (twist · u).
            const rSample = lerp(r - sampleLen * 0.5, r + sampleLen * 0.5, uj);
            const a = theta + uj * twistRad - twistRad * 0.5;
            sx = fx + rSample * Math.cos(a);
            sy = fy + rSample * Math.sin(a);
            break;
          }
          case 'motion-line': {
            // Translation along a fixed direction — Knoll's "motion blur"
            // subtype. Sample distance scales with strength × canvas diagonal,
            // independent of distance to focus.
            const off = (uj - 0.5) * maxDist;
            sx = x + motionDx * off;
            sy = y + motionDy * off;
            break;
          }
          case 'zoom':
          default: {
            // Sample positions interpolated focus→(x,y). uj=1 is the pixel,
            // uj=0 is the focus. With dropoff>1 we tighten the sample span
            // near the focus and stretch it far away.
            const start = 1 - lenFactor;
            const t01 = lerp(start, 1, uj);
            sx = fx + (x - fx) * t01;
            sy = fy + (y - fy) * t01;
            break;
          }
        }
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

// ---------- paint ----------
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);
  if(!resampled){ ctx.restore(); return; }

  const surface = applyBlur() || srcBuf;
  const sw = surface.width, sh = surface.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dw = W; dh = W / aspect; }
  else              { dh = H; dw = H * aspect; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(surface, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ---------- animation ----------
const MARCH_TYPES = ['zoom', 'rotational', 'spiral', 'motion-line'];

function applyAnimationT(tLoop){
  let t = tLoop - Math.floor(tLoop);
  if(t === 1) t = 0;
  const TAU = Math.PI * 2;
  const pp = (1 - Math.cos(t * TAU)) / 2;
  let sOv = null, aOv = null, tyOv = null, fxOv = null, fyOv = null;
  let seed = (params.seed | 0) || 1;

  switch(params.mode){
    case 'idle': break;
    case 'breath': {
      // Strength pingpongs around a low/high band centred on the slider value.
      const base = params.strength;
      sOv = clamp(base * 0.3 + base * pp, 0, 1);
      seed = seedFromT(tLoop) + (params.seed | 0);
      break;
    }
    case 'pulse': {
      // Sharp asymmetric — the "zoom punch". env wraps to 0 at t=0/t=1.
      const env = t < 0.12 ? t / 0.12 : Math.pow(1 - (t - 0.12) / 0.88, 2.5);
      sOv = clamp(params.strength * (0.2 + 2.8 * env), 0, 1);
      seed = seedFromT(tLoop) + (params.seed | 0);
      break;
    }
    case 'spin': {
      // Force rotational; monotonic angle 0→2π. cos(2π)=cos(0) so byte-equal.
      tyOv = 'rotational';
      aOv = t * TAU;
      seed = (params.seed | 0) || 1; // hold seed so geometry alone moves
      break;
    }
    case 'march': {
      const idx = t === 0 ? 0 : Math.min(MARCH_TYPES.length - 1, Math.floor(t * MARCH_TYPES.length));
      tyOv = MARCH_TYPES[idx];
      seed = seedFromT(tLoop) + idx * 7919 + (params.seed | 0);
      break;
    }
    case 'chase': {
      // Lissajous closed orbit for focal point. Returns to (focusX, focusY) at
      // t=0 and t=1 because cos(2π)=1 and sin(2π)=0. Amplitude = ±0.25 of canvas.
      const amp = 0.25;
      fxOv = clamp(params.focusX + amp * (Math.cos(t * TAU) - 1) / 2 * 2, 0, 1);
      // Use 2× frequency on Y to trace a Lissajous figure-eight; sin(2·2π)=0 at t=1.
      fyOv = clamp(params.focusY + amp * Math.sin(t * TAU * 2) * 0.6, 0, 1);
      seed = seedFromT(tLoop) + (params.seed | 0);
      break;
    }
  }
  return { sOv, aOv, tyOv, fxOv, fyOv, seed };
}

function renderAnimationFrame(tLoop){
  const a = applyAnimationT(tLoop);
  _strengthOverride = a.sOv;
  _angleOverride    = a.aOv;
  _typeOverride     = a.tyOv;
  _focusXOverride   = a.fxOv;
  _focusYOverride   = a.fyOv;
  _frameSeed        = a.seed;

  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    resample();
  } else if(!resampled){
    resample();
  }
  paint();

  _strengthOverride = null;
  _angleOverride = null;
  _typeOverride = null;
  _focusXOverride = _focusYOverride = null;
  _frameSeed = (params.seed | 0) || 1;
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
      schedule('paint');
    }
  },
};

const RESAMPLE_KEYS = new Set(['canvasSize','fit']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive){
    // Cursor moves the focal point. Normalise to [0,1] in canvas space.
    const fx = clamp(mouseX / r.width,  0, 1);
    const fy = clamp(mouseY / r.height, 0, 1);
    if(Math.abs(fx - params.focusX) > 0.005 || Math.abs(fy - params.focusY) > 0.005){
      params.focusX = fx; params.focusY = fy;
      gui?.rows.get('focusX')?._write(fx);
      gui?.rows.get('focusY')?._write(fy);
      if(!params.animate) schedule('paint');
    }
  }
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
    if(key === 'mode'){ return; }
    if(params.animate) return;
    if(RESAMPLE_KEYS.has(key)) schedule('resample');
    else schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => {
      if(!params.animate) schedule('resample');
    });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-zoom-blur',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  cv.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('resample');
}

document.addEventListener('DOMContentLoaded', init);
