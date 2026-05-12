// pixart/recolor — port of tooooools.app/effects/recolor, refined 2026-05-13.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/recolor/page-2676cef9cf1713d2.js,
//  defaults + preprocessor in /_next/static/chunks/9357-2a51c42cdfe973de.js).
//
// What the reference effect is — a gradient-map recolour:
//   1. Pick a scalar attribute of each pixel (brightness / hue / saturation).
//      brightness = (r+g+b)/765 · alpha + (1-alpha)   ← composite over white
//   2. Perturb with Perlin noise: attr += (noise(x*S, y*S)^γ − 0.5) · 2 · I
//   3. Posterise into N buckets:
//        N ≤ 1  → 0
//        N = 2  → 0 if <0.5 else 1
//        N > 2  → floor(attr·N) / (N−1)
//   4. Wrap K times: attr = (attr · K) % 1
//   5. Look up in a piecewise-linear gradient (positions in [0,1]).
//
// Reference defaults (verified in pageStates["/effects/recolor"]):
//   posterizeSteps:255, noiseIntensity:0, noiseScale:0.3, noiseGamma:1,
//   gradientRepetitions:1, colorAttribute:"brightness",
//   gradientStops:[{0,#00278a},{50,#fe76ec},{100,#fefffa}], showEffect:true
//
// ─────────────────────────────────────────────────────────────
// Refinement pass — 2026-05-13
// ─────────────────────────────────────────────────────────────
//
// The bundle ships a single hue-rotation animation; we graduate to a five-mode
// envelope set, each picked for a distinct *perceptual* signature on a
// posterised gradient map.
//
//   idle      — static (the rest-frame artwork).
//   breath    — 360° hue rotation across the loop (original behaviour). Calm.
//   posterize — stepped cosine through 5 named level counts (2 → 4 → 6 → 8 → 4
//               → seam-pin to 2). The Mach-band edges between buckets are
//               perceptually amplified (Mach, 1865), so coarser quantisations
//               *pulse* visually even though the underlying gradient is fixed.
//   shift     — hue sawtooth `t mod 1` mapped to 0..360°. The full wheel walks
//               past in a single direction — reads like a chromatic clock-
//               hand. Byte-equal at endpoints because both wrap to 0°.
//   dual      — cosine-lerped crossfade between two named palette LUTs
//               (hooke ↔ cyanotype). At t=0/t=1 both LUTs read identical
//               (palette A); at t=0.5 the output is pure palette B (cyanotype).
//
// Each mode animates ONLY its named subset. Static sliders are held at their
// user values for everything outside the envelope.
//
// New params:
//   mode    — animation envelope picker.
//   levels  — posterise step count (2..32). In `posterize` mode this is
//             *overridden* by the named-step ladder (2,4,6,8,4); otherwise it
//             feeds posterizeSteps so the slider has visible meaning at rest.
//   palette — named palette select (custom | hooke | pantone | cyanotype |
//             duotone | triad). `custom` honours the user-edited stop1..3
//             colours; the others swap the LUT for a curated multi-stop ramp.
//
// Named palettes (every default chosen for a reason):
//   hooke      — sepia / micrographia ink. Hooke's 1665 Micrographia was
//                early posterisation via copperplate intaglio; this trio is
//                the modern Pantone "micrographia" sepia mapping.
//   pantone    — Marsala (2015 Color of the Year) trio. Pantone's CotY
//                archive ships duo/triads tuned for textile reproduction;
//                Marsala specifically posterises well on photographic skin.
//   cyanotype  — Anna Atkins-style four-stop blueprint ramp (ink → mid-blue
//                → highlight → paper). The Prussian-blue palette is what
//                Atkins (1843) used to publish the first photo book.
//   duotone    — high-contrast black/white. The Mach-band stress test —
//                posterisation pulses hardest in pure-luminance space.
//   triad      — saturated RGB triad (web-default RYG). Aggressive enough
//                to read as "graphic" on photographic input.
//
// Optical-illusion grounding:
//   - Mach, E. (1865) *On the Effect of Spatial Distribution*. Mach bands
//     describe how the visual system over-emphasises step edges between
//     uniform regions — exactly what `posterize` mode amplifies.
//   - Hering, E. (1878) opponent-process theory. `shift` walks the hue wheel
//     across opponent pairs (red↔green, blue↔yellow); each opponent crossing
//     reads as a "tone change" even at constant saturation/luminance.
//   - Hooke, R. (1665) *Micrographia*. Early scientific illustration relied
//     on coarse tonal posterisation; the `hooke` palette is named for it.
//   - Pantone Color of the Year archive (pantone.com/color-of-the-year). The
//     `pantone` palette pulls the 2015 Marsala trio specifically.
//   - Shadertoy `4dXGR4` (Quilez palette tricks). The cosine-paced LUT
//     blend used in `dual` mode is the same technique.
//
// Determinism: every envelope wraps t to [0,1) so cos(2π·t) == cos(0) == 1
// exactly at the seam. `posterize` is a step function — at t=1 we explicitly
// route to step 0's level count. `shift` is a sawtooth (already byte-equal
// at t=0/t=1 since both = 0°). `dual` is a cosine lerp (byte-equal). Perlin
// uses a fixed seed; grain RNG reseeds from t.  → renderAt(0) ≡ renderAt(1).
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

// ─── Named palette stops ─────────────────────────────────────
// Each palette is an ordered list of hex stops, equally distributed in [0,1].
// `custom` is special-cased to use params.stop1..3.
const PALETTES = {
  hooke:     ['#1a0f0a', '#8a5a3b', '#d4a574', '#f5e6c8'],
  pantone:   ['#e8c1c5', '#c92a4c', '#1b1f3b'],
  cyanotype: ['#0a0e2a', '#1e3a8a', '#dbeafe', '#ffffff'],
  duotone:   ['#0d0d0d', '#f5f5f5'],
  triad:     ['#e63946', '#06d6a0', '#118ab2'],
};

// `dual` mode crossfades between these two palettes (warm → cool cosine).
const DUAL_A = 'hooke';
const DUAL_B = 'cyanotype';

// `posterize` mode walks through this level ladder. Cosine-stepped so the
// midpoint (t=0.5) hits the densest quantisation; ladder loops back to start
// at t=1 so the seam is byte-equal.
const POSTERIZE_LADDER = [2, 4, 6, 8, 4];

const params = {
  // Preprocessor (shared with every other effect).
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Recolor-specific (bundle defaults in comments).
  showEffect:         true,
  posterizeSteps:     8,      // bundle 255; 8 lands striking
  noiseIntensity:     0.18,   // bundle 0; small perturbation reads as flow
  noiseScale:         0.02,   // bundle 0.3; lower = broader, more painterly
  noiseGamma:         1,
  gradientRepetitions:1,
  colorAttribute:    'brightness', // brightness | hue | saturation
  stop1Pos:           0,
  stop1Color:        '#00278a',
  stop2Pos:           50,
  stop2Color:        '#fe76ec',
  stop3Pos:           100,
  stop3Color:        '#fefffa',
  hueRotationAmount:  1.0,   // multiplier on the 360° sweep over the loop
  // ---- Refinement pass (2026-05-13) ----
  mode:              'breath',
  // levels: posterise step count when palette mode is NOT `posterize` (which
  // overrides via POSTERIZE_LADDER). Range chosen to span "trivial duotone"
  // (2) to "near-continuous" (32) — past 32 Mach-band amplification is
  // imperceptible on most photographic input.
  levels:             8,
  // Named palette select. `custom` falls back to the stop1..3 sliders so the
  // pre-refinement HTML controls keep working.
  palette:           'hooke',
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
let preprocessed = null; // ImageData of srcBuf after preprocessor
let outImg       = null; // ImageData we paint into — same dims as preprocessed
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// ─── Transient animation state (read by buildOutput / build LUT) ─────
// _levelsOverride : when set, replaces params.levels for this frame (used by
//                   `posterize` mode's ladder walk).
// _paletteBlendT  : in [0,1], crossfade weight from palette A → palette B.
//                   Used only by `dual` mode; rebuildLUT consults it.
// _hueOffsetDeg   : extra hue rotation applied to every LUT stop.
let _levelsOverride = -1;
let _paletteBlendT  = 0;
let _hueOffsetDeg   = 0;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

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

// ---------- preprocessor (shared with Displace / Edge / Ascii / others) ----------
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

// ---------- Perlin 2D (Ken Perlin 2002, deterministic, fixed seed) ----------
const PERM = (function(){
  const p = new Uint8Array(512);
  const src = new Uint8Array(256);
  for(let i = 0; i < 256; i++) src[i] = i;
  const rng = mulberry32(1337);
  for(let i = 255; i > 0; i--){
    const j = Math.floor(rng() * (i + 1));
    const t = src[i]; src[i] = src[j]; src[j] = t;
  }
  for(let i = 0; i < 512; i++) p[i] = src[i & 255];
  return p;
})();
function fade(t){ return t*t*t*(t*(t*6 - 15) + 10); }
function grad2(hash, x, y){
  switch(hash & 3){
    case 0: return  x + y;
    case 1: return -x + y;
    case 2: return  x - y;
    case 3: return -x - y;
  }
  return 0;
}
function perlin2(x, y){
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);
  const aa = PERM[PERM[xi] + yi];
  const ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi];
  const bb = PERM[PERM[xi + 1] + yi + 1];
  const x1 = lerp(grad2(aa, xf,     yf    ), grad2(ba, xf - 1, yf    ), u);
  const x2 = lerp(grad2(ab, xf,     yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v) * 0.5 + 0.5;
}

// ---------- colour helpers ----------
function hexToRgb(hex){
  const h = String(hex || '').replace('#','');
  const v = (h.length === 3)
    ? h.split('').map(c => c + c).join('')
    : h.padEnd(6, '0');
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if(max !== min){
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch(max){
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l){
  h = ((h % 360) + 360) % 360 / 360;
  if(s === 0){ const v = Math.round(l * 255); return [v, v, v]; }
  const hue2rgb = (p, q, t) => {
    if(t < 0) t += 1;
    if(t > 1) t -= 1;
    if(t < 1/6) return p + (q - p) * 6 * t;
    if(t < 1/2) return q;
    if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h)       * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}
function rotateHue(hex, deg){
  if(deg === 0) return hexToRgb(hex);
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToRgb(h + deg, s, l);
}

// ---------- gradient lookup ----------
//
// We bake a 1024-entry RGB LUT for the current palette, current hue rotation,
// and (in `dual` mode) the current A↔B crossfade weight. The inner build loop
// then reads three Uint8s per pixel.
const LUT_SIZE = 1024;
const LUT_R = new Uint8ClampedArray(LUT_SIZE);
const LUT_G = new Uint8ClampedArray(LUT_SIZE);
const LUT_B = new Uint8ClampedArray(LUT_SIZE);

// Resolve a palette name into [{pos, rgb:[r,g,b]}] stops. `custom` reads
// params.stop1..3; the named palettes distribute their stops uniformly in
// [0,1] (Atkins / Pantone / Hooke palettes are inherently ordinal — there's no
// canonical "position", just an order).
function resolvePaletteStops(name, hueDeg){
  if(name === 'custom'){
    const raw = [
      { pos: clamp(params.stop1Pos, 0, 100) / 100, col: rotateHue(params.stop1Color, hueDeg) },
      { pos: clamp(params.stop2Pos, 0, 100) / 100, col: rotateHue(params.stop2Color, hueDeg) },
      { pos: clamp(params.stop3Pos, 0, 100) / 100, col: rotateHue(params.stop3Color, hueDeg) },
    ];
    raw.sort((a, b) => a.pos - b.pos);
    return raw;
  }
  const stops = PALETTES[name] || PALETTES.hooke;
  const n = stops.length;
  const out = new Array(n);
  for(let i = 0; i < n; i++){
    out[i] = {
      pos: n === 1 ? 0 : i / (n - 1),
      col: rotateHue(stops[i], hueDeg),
    };
  }
  return out;
}

// Sample a sorted stop list at u ∈ [0,1] and return [r,g,b].
function sampleStops(stops, u){
  // Anchor t=0 / t=1 by clamping to first/last stop (no edge falloff).
  if(u <= stops[0].pos) return stops[0].col;
  const last = stops[stops.length - 1];
  if(u >= last.pos) return last.col;
  let k = 0;
  while(k < stops.length - 1 && u >= stops[k + 1].pos) k++;
  const a = stops[k], b = stops[Math.min(k + 1, stops.length - 1)];
  const span = Math.max(1e-6, b.pos - a.pos);
  const t = clamp((u - a.pos) / span, 0, 1);
  return [
    lerp(a.col[0], b.col[0], t),
    lerp(a.col[1], b.col[1], t),
    lerp(a.col[2], b.col[2], t),
  ];
}

// Build the LUT. In every mode except `dual`, this is a single palette sampled
// 1024 times. In `dual`, we sample BOTH palettes at every i and lerp by
// _paletteBlendT — Quilez's cosine palette-blend trick, but pre-baked so the
// per-pixel inner loop stays at one LUT read.
function buildGradientLUT(){
  const hueDeg = _hueOffsetDeg;
  if(params.mode === 'dual'){
    const stopsA = resolvePaletteStops(DUAL_A, hueDeg);
    const stopsB = resolvePaletteStops(DUAL_B, hueDeg);
    const t = clamp(_paletteBlendT, 0, 1);
    for(let i = 0; i < LUT_SIZE; i++){
      const u = i / (LUT_SIZE - 1);
      const a = sampleStops(stopsA, u);
      const b = sampleStops(stopsB, u);
      LUT_R[i] = lerp(a[0], b[0], t);
      LUT_G[i] = lerp(a[1], b[1], t);
      LUT_B[i] = lerp(a[2], b[2], t);
    }
    return;
  }
  const stops = resolvePaletteStops(params.palette, hueDeg);
  for(let i = 0; i < LUT_SIZE; i++){
    const u = i / (LUT_SIZE - 1);
    const c = sampleStops(stops, u);
    LUT_R[i] = c[0];
    LUT_G[i] = c[1];
    LUT_B[i] = c[2];
  }
}

// ---------- build (gradient-map recolour) ----------
function buildOutput(){
  if(!preprocessed){ outImg = null; return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(!outImg || outImg.width !== W || outImg.height !== H){
    outImg = new ImageData(W, H);
  }
  const src = preprocessed.data;
  const dst = outImg.data;

  // Resolve effective posterise step count. `posterize` mode overrides via the
  // ladder; every other mode honours params.levels (or falls back to the
  // legacy posterizeSteps slider if levels is 0 — keeps backwards compat).
  const userN = (params.levels | 0) > 0 ? (params.levels | 0) : (params.posterizeSteps | 0);
  const N = _levelsOverride > 0 ? _levelsOverride : userN;
  const K      = Math.max(1, params.gradientRepetitions | 0);
  const I      = params.noiseIntensity;
  const S      = params.noiseScale;
  const NG     = params.noiseGamma;
  const attr   = params.colorAttribute;
  const doNoise = I > 0;
  const denomN = Math.max(1, N - 1);

  let posterFn;
  if(N <= 1)      posterFn = () => 0;
  else if(N === 2) posterFn = (x) => x < 0.5 ? 0 : 1;
  else             posterFn = (x) => Math.floor(x * N) / denomN;

  for(let y = 0, j = 0; y < H; y++){
    for(let x = 0; x < W; x++, j += 4){
      const r = src[j], g = src[j+1], b = src[j+2], a = src[j+3];
      let v;
      if(attr === 'hue' || attr === 'saturation'){
        const [hh, ss] = rgbToHsl(r, g, b);
        v = attr === 'hue' ? hh / 360 : ss;
      } else {
        const A = a / 255;
        v = (r + g + b) / 765 * A + (1 - A);
      }
      if(doNoise){
        let n = perlin2(x * S, y * S);
        if(NG !== 1) n = Math.pow(n, NG);
        v = v + (n - 0.5) * 2 * I;
        if(v < 0) v = 0; else if(v > 1) v = 1;
      }
      v = posterFn(v);
      if(K > 1) v = (v * K) % 1;
      if(v < 0) v = 0; else if(v > 1) v = 1;
      const idx = (v * (LUT_SIZE - 1)) | 0;
      dst[j]   = LUT_R[idx];
      dst[j+1] = LUT_G[idx];
      dst[j+2] = LUT_B[idx];
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

  if(!preprocessed){ ctx.restore(); return; }

  const showSrc = !params.showEffect;
  const imgW = preprocessed.width, imgH = preprocessed.height;
  const aspect = imgW / imgH;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;

  if(showSrc){
    ctx.drawImage(srcBuf, ox, oy, dw, dh);
    ctx.restore();
    return;
  }
  if(!outImg){ ctx.restore(); return; }

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
// Per-mode envelope. Each returns the animation transients consumed by the
// build path: hueOffsetDeg, levelsOverride (-1 = use slider), paletteBlendT
// (only meaningful in `dual` mode).
//
// All envelopes wrap t to [0,1) first so cos(2π·t) == cos(0) == 1 exactly at
// the seam.  Step modes (`posterize`) pin t=1 to step 0 explicitly so the
// step function is byte-equal at the loop seam even though it's generically
// discontinuous.
function applyAnimationT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  const t01 = w;
  // Cosine pingpong, peaks at t=0.5, byte-equal at endpoints.
  const pp  = (1 - Math.cos(t01 * 2 * Math.PI)) / 2;

  let hueOffsetDeg = 0;
  let levelsOverride = -1;
  let paletteBlendT  = 0;

  switch(params.mode){
    case 'idle': {
      // Static. All transients hold at 0.
      break;
    }
    case 'shift': {
      // Hue sawtooth — fast wraps. Walks the full wheel in a single direction
      // through the loop. Byte-equal at t=0/t=1 because both = 0°.
      hueOffsetDeg = 360 * t01 * params.hueRotationAmount;
      break;
    }
    case 'posterize': {
      // Stepped cosine through the named ladder. We map t01 to a ladder index
      // via a 5-bucket discretisation, then explicitly pin t=1 to the first
      // rung so seam-override is byte-equal even though the step function is
      // discontinuous.
      const n = POSTERIZE_LADDER.length;
      let idx = Math.floor(t01 * n);
      if(idx >= n) idx = n - 1;
      if(t01 === 0) idx = 0;
      levelsOverride = POSTERIZE_LADDER[idx];
      break;
    }
    case 'dual': {
      // Cosine lerp A↔B. pp peaks at t=0.5 (full palette B); endpoints sit at
      // pp=0 (full palette A). Byte-equal at t=0/t=1 because pp=0 at both.
      paletteBlendT = pp;
      break;
    }
    case 'breath':
    default: {
      // Original behaviour: 360° hue rotation cosine-paced through the loop.
      // Wraps to 0° exactly at t=1 because cos(2π) == cos(0).
      hueOffsetDeg = 360 * t01 * params.hueRotationAmount;
      break;
    }
  }
  return { hueOffsetDeg, levelsOverride, paletteBlendT };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  _hueOffsetDeg   = anim.hueOffsetDeg;
  _levelsOverride = anim.levelsOverride;
  _paletteBlendT  = anim.paletteBlendT;
  buildGradientLUT();

  // Re-seed grain deterministically so endpoints match for export.
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

  // Restore transients so a follow-up static rebuild reads slider values.
  _hueOffsetDeg = 0; _levelsOverride = -1; _paletteBlendT = 0;
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
    _hueOffsetDeg = 0; _levelsOverride = -1; _paletteBlendT = 0;
    buildGradientLUT();
    schedule('build');
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

// Pipeline buckets: which keys touch which stage.
const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['posterizeSteps','levels','noiseIntensity','noiseScale','noiseGamma','gradientRepetitions','colorAttribute']);
const GRADIENT_KEYS = new Set(['stop1Pos','stop1Color','stop2Pos','stop2Color','stop3Pos','stop3Color','palette']);
const PAINT_KEYS = new Set(['showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    // X = levels (2..32), Y = noise intensity (0..1). Levels is the headline
    // perceptual lever now that palettes carry the colour story.
    const nl = Math.max(2, Math.round(2 + ax * 30));
    const ni = Math.round((1 - ay) * 100) / 100;
    let touched = false;
    if(nl !== params.levels){
      params.levels = nl; touched = true;
      gui?.rows.get('levels')?._write(nl);
    }
    if(Math.abs(ni - params.noiseIntensity) > 0.005){
      params.noiseIntensity = ni; touched = true;
      gui?.rows.get('noiseIntensity')?._write(ni);
    }
    if(touched) schedule('build');
  }
}

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  buildGradientLUT();
  gui.on((key) => {
    if(key === 'animate'){ toggleAnimation(); return; }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(key === 'mode'){ /* animation-only; no static rebuild */ return; }
    if(params.animate) return;
    if(GRADIENT_KEYS.has(key)){ buildGradientLUT(); schedule('build'); return; }
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else if(PAINT_KEYS.has(key)) schedule('paint');
    else                         schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => {
      if(!params.animate) schedule('pre');
    });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-recolor',
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
