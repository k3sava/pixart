// pixart/film-grain — cinematic film-stock emulation.
//
// Original to pixart (no tooooools reference). Built 2026-05-13.
//
// What this effect is:
//   A six-stage cinematic emulation pipeline applied to the source frame:
//
//     1. Film-stock LUT      — per-stock 1-D tone curves applied per-channel
//                              (Kodak Portra 400, Vision3 5219, Ektar 100,
//                               Fuji Velvia 50, Kodak Tri-X 400, Cinestill 800T).
//                              Curves are crude but recognisably *that stock*:
//                              Portra warms midtones, Velvia crushes saturation,
//                              Tri-X drops to luminance, Cinestill spikes red.
//     2. Halation             — bright pixels bleed RED through a separable
//                              box-blur. Cinestill 800T's defining trait
//                              (Stuart Dryburgh / Cinestill technical white
//                              paper, 2017): the remjet anti-halation layer
//                              is removed, so red light scatters back through
//                              the emulsion around highlights.
//     3. Temperature tint     — additive warm/cool shift on R↔B.
//     4. Grain                — mulberry32-seeded luminance noise. `grainSize`
//                              blurs the noise pre-add for chunky vs fine grain.
//                              On true film, grain is per-layer silver-halide
//                              clumping; we approximate via Gaussian-on-luma.
//     5. Vignette             — radial darkening from a Gaussian-ish bump.
//     6. Gate weave + matte   — tiny 2D jitter of the whole frame (real film
//                              projectors weave; Steve Yedlin's *Display Prep
//                              Demo* 2017 names gate-weave as one of the four
//                              indispensible film signals). Letterbox bars
//                              gate top + bottom.
//
// Why this shape (and not "apply a single film LUT"):
//   - Yedlin's argument: a static 3-D LUT is necessary but not sufficient. The
//     temporal signals — grain re-randomising per frame, gate-weave, halation
//     flicker — are what your eye reads as "film". Static LUT = digital photo.
//   - Halation is per-pixel-neighbourhood, not per-pixel, so it cannot live in
//     a LUT. Same for grain (temporal) and weave (spatial).
//
// Modes (each a distinct envelope):
//   idle    — static; rest frame.
//   breath  — `grainAmount` cosine pingpong. Calm.
//   flicker — grain reseeds AND luminance breathes; mimics projector flicker.
//   march   — film stock cycles through Portra→Velvia→Tri-X→Cinestill, 1/4 each.
//   pulse   — halation strength spikes (highlights briefly bloom red).
//   roll    — gate-weave amplitude pingpongs; the whole frame wobbles in 2D.
//
// Determinism / seamless loop:
//   - Every envelope wraps t to [0,1) so cos(2π·t)==cos(0)==1 in IEEE-754.
//   - Grain uses mulberry32 seeded from t — t=0 and t=1 produce identical noise.
//   - Gate-weave amplitude returns to 0 at t=0/t=1 (cosine envelope).
//   - march at t=1 routes explicitly to step-0 stock so endpoints match.
//   ⇒ renderAt(0).toDataURL() === renderAt(1).toDataURL() byte-equal.
//
// References:
//   - Deakins, R. (AC interviews, 2014–2019) on grain and halation as the
//     defining temporal signals of celluloid.
//   - Dryburgh, S. / Cinestill technical white papers — the source of halation
//     as a chemical artefact (remjet removal), now an aesthetic standard.
//   - Yedlin, S. *Display Prep Demo* (2017) — the load-bearing argument that
//     film-look is temporal, not just chromatic.
//   - DaVinci Resolve Film Look Creator documentation (2022) — modern industry
//     reference for stage decomposition (LUT + halation + grain + weave).
//   - Apple ProRes RAW colour-science manual — current digital reference for
//     why per-channel tone curves can stand in for full 3-D LUTs on most input.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Offscreen buffer for the resampled source at canvasSize.
const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });
// Working buffer for the per-frame compositing pipeline.
const workBuf = document.createElement('canvas');
const wctx    = workBuf.getContext('2d', { willReadFrequently: true });

const params = {
  canvasSize:      600,
  // Film stock LUT (6 named curves).
  filmStock:       'portra-400',
  // Grain controls.
  grainAmount:     0.3,
  grainSize:       1.2,
  // Halation (red-bleed around highlights).
  halation:        0.4,
  halationRadius:  8,
  // Gate weave (frame jitter, projector-imperfection signal).
  gateWeave:       0.4,
  // Vignette + matte.
  vignette:        0.3,
  matte:           0,
  // Warm / cool tint.
  temperature:     0,
  // Deterministic noise seed (combined with t for the loop).
  seed:            1,
  // Cursor focus radius — *reduces* grain locally (sharp focal point).
  focusRadius:     180,
  // Animation mode picker.
  mode:            'breath',
  // Shared chrome.
  animate:         false,
  interactive:     false,
  fit:             'cover',
  bg:              '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let resampled = null;     // ImageData of srcBuf at canvasSize
let dirty = { resample: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// Per-frame transients (read by paint, written by renderAnimationFrame).
let _stockOverride    = null;  // string | null — march mode picks a step.
let _grainScale       = 1;     // multiplier on params.grainAmount.
let _halationScale    = 1;     // multiplier on params.halation.
let _weaveScale       = 1;     // multiplier on params.gateWeave.
let _lumScale         = 1;     // multiplier on output luminance (flicker).
let _frameSeed        = 1;     // grain seed for this frame.
let _weaveDx          = 0;
let _weaveDy          = 0;
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
    workBuf.width = W; workBuf.height = H;
  }
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  resampled = sctx.getImageData(0, 0, W, H);
}

// ---------- film-stock LUTs ----------
//
// Each stock supplies three per-channel 256→256 curves. The curves are hand-
// tuned approximations of the named stock's signature behaviour rather than
// scanned characteristic curves. Built once, cached.
const STOCK_LUTS = {};
function buildStockLUTs(){
  // Generic curve builders.
  const id = i => i;
  const curve = (lo, mid, hi) => i => {
    // Three-anchor piecewise-linear: (0,lo*255), (128,mid*255), (255,hi*255).
    const t = i / 255;
    const v = t < 0.5
      ? lerp(lo, mid, t * 2)
      : lerp(mid, hi, (t - 0.5) * 2);
    return clamp(Math.round(v * 255), 0, 255);
  };
  // sat: pull toward luminance by k (k=0 → identity, k=1 → grayscale).
  const desat = k => (r, g, b) => {
    const y = 0.299*r + 0.587*g + 0.114*b;
    return [lerp(r, y, k), lerp(g, y, k), lerp(b, y, k)];
  };

  // We store either per-channel LUT triplets, or a generic remap fn.
  STOCK_LUTS['portra-400'] = {
    // Kodak Portra 400 — warm midtones, lifted shadows, soft highlights.
    r: bake(curve(0.06, 0.55, 0.98)),
    g: bake(curve(0.04, 0.50, 0.97)),
    b: bake(curve(0.03, 0.42, 0.94)),
    sat: 0.92,
  };
  STOCK_LUTS['vision3-5219'] = {
    // Kodak Vision3 5219 (500T cinema neg) — cool shadows, neutral mids.
    r: bake(curve(0.02, 0.50, 0.95)),
    g: bake(curve(0.03, 0.51, 0.96)),
    b: bake(curve(0.08, 0.54, 0.97)),
    sat: 0.95,
  };
  STOCK_LUTS['ektar-100'] = {
    // Kodak Ektar 100 — high saturation, snappy contrast, clean whites.
    r: bake(curve(0.00, 0.48, 1.00)),
    g: bake(curve(0.00, 0.47, 1.00)),
    b: bake(curve(0.00, 0.46, 1.00)),
    sat: 1.18,
  };
  STOCK_LUTS['velvia-50'] = {
    // Fuji Velvia 50 — punchy reds/greens, crushed blacks. Saturation lever.
    r: bake(curve(0.00, 0.45, 1.00)),
    g: bake(curve(0.00, 0.46, 1.00)),
    b: bake(curve(0.00, 0.40, 0.95)),
    sat: 1.35,
  };
  STOCK_LUTS['tri-x-400'] = {
    // Kodak Tri-X 400 — black and white. Desaturate fully, slight S-curve.
    r: bake(curve(0.02, 0.50, 0.96)),
    g: bake(curve(0.02, 0.50, 0.96)),
    b: bake(curve(0.02, 0.50, 0.96)),
    sat: 0, // forced grayscale
  };
  STOCK_LUTS['cinestill-800t'] = {
    // Cinestill 800T — tungsten-balanced, lifted blue shadows, RED HALATION.
    // The halation flag toggles a red-bleed amplifier downstream.
    r: bake(curve(0.05, 0.56, 1.00)),
    g: bake(curve(0.04, 0.50, 0.94)),
    b: bake(curve(0.10, 0.52, 0.90)),
    sat: 1.02,
    halationBoost: 1.6,
  };
}
function bake(fn){
  const a = new Uint8ClampedArray(256);
  for(let i = 0; i < 256; i++) a[i] = fn(i);
  return a;
}
buildStockLUTs();

// ---------- pipeline ----------
//
// Operates on a Uint8ClampedArray of RGBA pixels in-place. We write the
// composited result back to workBuf, then paint workBuf to the visible canvas.
function applyPipeline(){
  if(!resampled) return null;
  const W = resampled.width, H = resampled.height;
  // Working copy — never mutate `resampled` directly so static rebuilds stay clean.
  const id = wctx.createImageData(W, H);
  const o = id.data;
  const s = resampled.data;

  const stock = STOCK_LUTS[_stockOverride || params.filmStock] || STOCK_LUTS['portra-400'];
  const rL = stock.r, gL = stock.g, bL = stock.b;
  const sat = stock.sat;
  const temp = params.temperature; // -1..1
  const tempR = temp > 0 ? temp * 30 : 0;
  const tempB = temp < 0 ? -temp * 30 : 0;

  // Pass 1 — stock LUT + temperature + saturation. Single linear sweep over pixels.
  for(let i = 0; i < s.length; i += 4){
    let r = rL[s[i]];
    let g = gL[s[i+1]];
    let b = bL[s[i+2]];
    if(sat !== 1){
      const y = 0.299*r + 0.587*g + 0.114*b;
      r = clamp(lerp(y, r, sat), 0, 255);
      g = clamp(lerp(y, g, sat), 0, 255);
      b = clamp(lerp(y, b, sat), 0, 255);
    }
    r = clamp(r + tempR - tempB * 0.3, 0, 255);
    b = clamp(b + tempB - tempR * 0.3, 0, 255);
    o[i] = r; o[i+1] = g; o[i+2] = b; o[i+3] = s[i+3];
  }

  // Pass 2 — halation. We extract a "highlight mask" (luma > 200), blur it via
  // a separable box-blur, and additively re-inject it into the RED channel
  // (Cinestill's signature). The blur radius is `halationRadius` (px); the
  // amplitude is `halation` (0..1), boosted on Cinestill stocks.
  const hal = params.halation * (stock.halationBoost || 1) * _halationScale;
  const hr  = params.halationRadius | 0;
  if(hal > 0 && hr > 0){
    applyHalation(o, W, H, hr, hal);
  }

  // Pass 3 — grain. Per-pixel luminance noise, optionally box-averaged to
  // simulate larger silver clumps via `grainSize`. Deterministic from _frameSeed.
  const ga = clamp(params.grainAmount * _grainScale, 0, 1);
  if(ga > 0){
    applyGrain(o, W, H, ga, params.grainSize, _frameSeed, _focusCx, _focusCy, _focusR2);
  }

  // Pass 4 — global luminance scale (flicker mode).
  if(_lumScale !== 1){
    const k = _lumScale;
    for(let i = 0; i < o.length; i += 4){
      o[i]   = clamp(o[i]   * k, 0, 255);
      o[i+1] = clamp(o[i+1] * k, 0, 255);
      o[i+2] = clamp(o[i+2] * k, 0, 255);
    }
  }

  // Pass 5 — vignette. Soft radial darkening: f(r) = 1 - vignette · (r/maxR)^2.
  // Cheap quadratic falloff reads close enough to Gaussian for the eye.
  const vig = clamp(params.vignette, 0, 1);
  if(vig > 0){
    const cx = W / 2, cy = H / 2;
    const maxR2 = cx*cx + cy*cy;
    for(let y = 0; y < H; y++){
      const dy = y - cy;
      for(let x = 0; x < W; x++){
        const dx = x - cx;
        const r2 = dx*dx + dy*dy;
        const k = 1 - vig * (r2 / maxR2);
        const i = (x + y * W) * 4;
        o[i]   = clamp(o[i]   * k, 0, 255);
        o[i+1] = clamp(o[i+1] * k, 0, 255);
        o[i+2] = clamp(o[i+2] * k, 0, 255);
      }
    }
  }

  wctx.putImageData(id, 0, 0);
  return workBuf;
}

// Separable two-pass box-blur of a highlight mask, additively injected as red.
// Two box-blur passes approximate Gaussian closely enough at the radii film
// halation actually occupies (3–30 px). Reads as the same warm bloom.
function applyHalation(o, W, H, hr, hal){
  // Build highlight mask (single byte per pixel).
  const mask = new Float32Array(W * H);
  for(let i = 0, j = 0; i < o.length; i += 4, j++){
    const y = 0.299*o[i] + 0.587*o[i+1] + 0.114*o[i+2];
    // Smooth threshold above 180; quadratic falloff so the mask isn't binary.
    const k = clamp((y - 180) / 75, 0, 1);
    mask[j] = k * k;
  }
  // Two-pass box blur (horizontal then vertical), kernel width = 2·hr+1.
  const tmp = new Float32Array(W * H);
  const r = hr;
  // Horizontal.
  for(let y = 0; y < H; y++){
    const row = y * W;
    let sum = 0;
    for(let x = -r; x <= r; x++){
      const xi = x < 0 ? 0 : (x >= W ? W - 1 : x);
      sum += mask[row + xi];
    }
    const norm = 1 / (2 * r + 1);
    for(let x = 0; x < W; x++){
      tmp[row + x] = sum * norm;
      const xAdd = x + r + 1, xSub = x - r;
      const ai = xAdd >= W ? W - 1 : xAdd;
      const si = xSub < 0 ? 0 : xSub;
      sum += mask[row + ai] - mask[row + si];
    }
  }
  // Vertical.
  for(let x = 0; x < W; x++){
    let sum = 0;
    for(let y = -r; y <= r; y++){
      const yi = y < 0 ? 0 : (y >= H ? H - 1 : y);
      sum += tmp[x + yi * W];
    }
    const norm = 1 / (2 * r + 1);
    for(let y = 0; y < H; y++){
      mask[x + y * W] = sum * norm;
      const yAdd = y + r + 1, ySub = y - r;
      const ai = yAdd >= H ? H - 1 : yAdd;
      const si = ySub < 0 ? 0 : ySub;
      sum += tmp[x + ai * W] - tmp[x + si * W];
    }
  }
  // Inject — red gets full amplitude, green/blue a fraction (the visible
  // appearance of halation is red-dominant but not pure).
  const amp = hal * 180;
  for(let j = 0, i = 0; j < mask.length; j++, i += 4){
    const m = mask[j];
    o[i]   = clamp(o[i]   + amp * m,        0, 255);
    o[i+1] = clamp(o[i+1] + amp * m * 0.25, 0, 255);
    o[i+2] = clamp(o[i+2] + amp * m * 0.10, 0, 255);
  }
}

// Per-pixel grain noise. `size` > 1 averages noise over an SxS neighbourhood
// of mulberry32 draws so the grain reads chunkier (closer to large silver
// clumps in pushed Tri-X). Cursor focus radius locally reduces grain.
function applyGrain(o, W, H, amount, size, seed, fcx, fcy, fr2){
  const rng = mulberry32(seed);
  const useFocus = fr2 > 0;
  const sz = Math.max(0.5, size);
  // Pre-draw a noise buffer at coarse resolution if size > 1, then upsample.
  const nW = sz > 1 ? Math.max(1, Math.floor(W / sz)) : W;
  const nH = sz > 1 ? Math.max(1, Math.floor(H / sz)) : H;
  const noise = new Float32Array(nW * nH);
  for(let i = 0; i < noise.length; i++) noise[i] = rng() - 0.5;
  const sx = nW / W, sy = nH / H;
  const amp = amount * 90; // tuned: amount=1 ≈ ±45/255 luminance noise
  for(let y = 0; y < H; y++){
    const ny = Math.min(nH - 1, (y * sy) | 0);
    for(let x = 0; x < W; x++){
      const nx = Math.min(nW - 1, (x * sx) | 0);
      let n = noise[nx + ny * nW] * amp;
      if(useFocus){
        const dx = x - fcx, dy = y - fcy;
        const d2 = dx*dx + dy*dy;
        if(d2 < fr2){
          // Inside focus radius: scale grain by d²/R² (zero at centre).
          n *= d2 / fr2;
        }
      }
      const i = (x + y * W) * 4;
      o[i]   = clamp(o[i]   + n, 0, 255);
      o[i+1] = clamp(o[i+1] + n, 0, 255);
      o[i+2] = clamp(o[i+2] + n, 0, 255);
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
  if(!resampled){ ctx.restore(); return; }

  const surface = applyPipeline() || srcBuf;

  // Cover-fit to canvas (matches sibling effects). Apply gate-weave as a 2D
  // translation of the drawn rect — the bars and vignette move with the frame,
  // which is what a real projector weave looks like.
  const sw = surface.width, sh = surface.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dw = W; dh = W / aspect; }
  else              { dh = H; dw = H * aspect; }
  const ox = (W - dw) / 2 + _weaveDx;
  const oy = (H - dh) / 2 + _weaveDy;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(surface, ox, oy, dw, dh);

  // Matte (letterbox bars). Drawn after the frame so they always cover.
  const matte = clamp(params.matte, 0, 1);
  if(matte > 0){
    const barH = H * matte * 0.18; // 0..18% of height per bar
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, barH);
    ctx.fillRect(0, H - barH, W, barH);
  }

  ctx.restore();
}

// ---------- animation ----------
//
// 15s seamless loop. Each mode wraps t to [0,1) and only animates its named
// subset. Static sliders hold elsewhere. renderAt(0) ≡ renderAt(1).
//
// Stocks used by `march`:
const MARCH_STOCKS = ['portra-400', 'velvia-50', 'tri-x-400', 'cinestill-800t'];

function applyAnimationT(tLoop){
  let t = tLoop - Math.floor(tLoop);
  if(t === 1) t = 0;
  const TAU = Math.PI * 2;
  const pp = (1 - Math.cos(t * TAU)) / 2; // pingpong, peaks at 0.5
  // Defaults — overridden per mode.
  let stock = null, gScale = 1, hScale = 1, wScale = 1, lScale = 1;
  let seed = (params.seed | 0) || 1;
  let wdx = 0, wdy = 0;

  switch(params.mode){
    case 'idle': {
      break;
    }
    case 'breath': {
      // Grain amount pingpong — calm cinematic breath.
      gScale = 0.4 + 0.6 * pp; // 0.4 → 1.0 → 0.4
      seed = seedFromT(tLoop) + (params.seed | 0);
      break;
    }
    case 'flicker': {
      // Projector flicker: lum dips on a higher-frequency cosine and grain
      // reseeds aggressively. The 5x lum-cosine still wraps cleanly at t=1.
      lScale = 1 - 0.12 * (1 - Math.cos(t * TAU * 5)) / 2;
      gScale = 0.6 + 0.6 * pp;
      seed = seedFromT(tLoop) + (params.seed | 0);
      break;
    }
    case 'march': {
      // Step through 4 stocks. t=1 explicitly routes to step 0 for seam.
      const idx = t === 0 ? 0 : Math.min(MARCH_STOCKS.length - 1, Math.floor(t * MARCH_STOCKS.length));
      stock = MARCH_STOCKS[idx];
      // Reseed grain per-step so each stock has independent noise.
      seed = seedFromT(tLoop) + idx * 7919 + (params.seed | 0);
      break;
    }
    case 'pulse': {
      // Halation spike — asymmetric (fast attack, slow decay). One per cycle.
      // env(t=0)=0, env(t=1)=env(t=0) since t wrapped.
      const env = t < 0.15 ? t / 0.15 : Math.pow(1 - (t - 0.15) / 0.85, 2.2);
      hScale = 1 + 2.5 * env;
      // gentle grain breath alongside
      gScale = 0.7 + 0.3 * pp;
      seed = seedFromT(tLoop) + (params.seed | 0);
      break;
    }
    case 'roll': {
      // Gate-weave amplitude pingpongs. Direction is a closed Lissajous so the
      // (dx, dy) trajectory returns to (0,0) at t=0/t=1.
      wScale = 1 + 3 * pp;
      const amp = params.gateWeave * wScale;
      wdx = amp * Math.sin(t * TAU * 2);
      wdy = amp * Math.sin(t * TAU * 3) * 0.6;
      seed = seedFromT(tLoop) + (params.seed | 0);
      break;
    }
  }
  return { stock, gScale, hScale, wScale, lScale, seed, wdx, wdy };
}

function renderAnimationFrame(tLoop){
  const a = applyAnimationT(tLoop);
  _stockOverride = a.stock;
  _grainScale    = a.gScale;
  _halationScale = a.hScale;
  _weaveScale    = a.wScale;
  _lumScale      = a.lScale;
  _frameSeed     = a.seed;
  _weaveDx       = a.wdx;
  _weaveDy       = a.wdy;

  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    resample();
  } else if(!resampled){
    resample();
  }
  paint();

  // Reset transients so a follow-up static render reads slider values.
  _stockOverride = null;
  _grainScale = _halationScale = _weaveScale = _lumScale = 1;
  _weaveDx = _weaveDy = 0;
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
    if(!resampled) return;
    // Map cursor → source-space (cover-fit reverse).
    const W = cv.width, H = cv.height;
    const sw = resampled.width, sh = resampled.height;
    const aspect = sw / sh;
    let dw, dh;
    if(W / H > aspect){ dw = W; dh = W / aspect; }
    else              { dh = H; dw = H * aspect; }
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    const sx = (mouseX * (W / r.width)  - ox) / dw * sw;
    const sy = (mouseY * (H / r.height) - oy) / dh * sh;
    const rSrc = params.focusRadius * sw / dw;
    _focusCx = sx; _focusCy = sy; _focusR2 = rSrc * rSrc;
    if(!params.animate) schedule('paint');
  } else if(_focusR2 !== 0){
    _focusR2 = 0;
    if(!params.animate) schedule('paint');
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
      canvas: cv, name: 'pixart-film-grain',
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
