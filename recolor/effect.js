// pixart/recolor — port of tooooools.app/effects/recolor.
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
// Animation: tooooools' recolor is static. For the 15s seamless loop we
// rotate the hue of every gradient stop by 360°·t. Because 360° wraps to 0°,
// endpoints meet byte-equal. `hueRotationAmount` scales the sweep.
//
// Determinism for byte-equal export: Perlin uses a fixed seed; grain RNG
// reseeds from t; hue rotation is exact arithmetic. renderAt(0) ≡ renderAt(1).
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Offscreen buffer for the preprocessed source — same shared pattern as every
// other pixart effect.
const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

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
  // Animation-specific (not in bundle).
  hueRotationAmount:  1.0,   // multiplier on the 360° sweep over the loop
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
//
// The reference uses p5.noise() — value-noise with up to 4 octaves. We ship a
// classic 2D Perlin. The *texture* matches visually (smooth, low-frequency),
// and a fixed seed keeps every render byte-stable across reloads.
const PERM = (function(){
  const p = new Uint8Array(512);
  const src = new Uint8Array(256);
  for(let i = 0; i < 256; i++) src[i] = i;
  // Deterministic shuffle with a fixed mulberry32 stream.
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
  // Perlin returns roughly [-1, 1]; remap to [0, 1] like p5.noise().
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
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToRgb(h + deg, s, l);
}

// ---------- gradient lookup ----------
//
// We bake a 1024-entry RGB LUT for the current gradient (and current hue
// rotation) at the start of every build. The inner loop reads three array
// entries per pixel — the cheapest possible port of the lerpColor + stop
// search the reference runs per pixel.
const LUT_SIZE = 1024;
const LUT_R = new Uint8ClampedArray(LUT_SIZE);
const LUT_G = new Uint8ClampedArray(LUT_SIZE);
const LUT_B = new Uint8ClampedArray(LUT_SIZE);

function buildGradientLUT(hueOffsetDeg){
  // Three fixed stops. Positions in [0,1] (UI is 0..100).
  const raw = [
    { pos: clamp(params.stop1Pos, 0, 100) / 100, col: rotateHue(params.stop1Color, hueOffsetDeg) },
    { pos: clamp(params.stop2Pos, 0, 100) / 100, col: rotateHue(params.stop2Color, hueOffsetDeg) },
    { pos: clamp(params.stop3Pos, 0, 100) / 100, col: rotateHue(params.stop3Color, hueOffsetDeg) },
  ];
  // The reference treats stops as authored — out-of-order positions would
  // produce a weird ramp. We sort defensively.
  raw.sort((a, b) => a.pos - b.pos);
  // Anchor t=0 and t=1 by duplicating the endpoints (avoids edge falloff).
  const stops = [
    { pos: 0,        col: raw[0].col },
    ...raw,
    { pos: 1,        col: raw[raw.length - 1].col },
  ];
  for(let i = 0; i < LUT_SIZE; i++){
    const t = i / (LUT_SIZE - 1);
    // Find segment.
    let k = 0;
    while(k < stops.length - 1 && t >= stops[k + 1].pos) k++;
    const a = stops[k], b = stops[Math.min(k + 1, stops.length - 1)];
    const span = Math.max(1e-6, b.pos - a.pos);
    const u = clamp((t - a.pos) / span, 0, 1);
    LUT_R[i] = lerp(a.col[0], b.col[0], u);
    LUT_G[i] = lerp(a.col[1], b.col[1], u);
    LUT_B[i] = lerp(a.col[2], b.col[2], u);
  }
}

// ---------- build (gradient-map recolour) ----------
//
// The hot loop. Mirrors the reference exactly:
//   attr ← attribute(r,g,b,a)
//   attr ← clamp(attr + (noise^γ − 0.5) · 2 · I, 0, 1)
//   attr ← posterise(attr, N)
//   attr ← attr · K mod 1   (if K > 1)
//   out  ← gradientLUT[attr · 1023]
function buildOutput(){
  if(!preprocessed){ outImg = null; return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(!outImg || outImg.width !== W || outImg.height !== H){
    outImg = new ImageData(W, H);
  }
  const src = preprocessed.data;
  const dst = outImg.data;

  const N      = params.posterizeSteps | 0;
  const K      = Math.max(1, params.gradientRepetitions | 0);
  const I      = params.noiseIntensity;
  const S      = params.noiseScale;
  const NG     = params.noiseGamma;
  const attr   = params.colorAttribute;
  const doNoise = I > 0;
  const denomN = Math.max(1, N - 1);

  // Posterise helpers — inlined branches mirror the reference's edge cases.
  // N ≤ 1 → 0 ; N = 2 → 0 / 1 cut at 0.5 ; N > 2 → floor(x·N)/(N−1).
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
        // brightness — alpha-composited average over white, normalised.
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
      dst[j+3] = 255; // reference: alpha is always 255 on output.
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

  // showEffect=false → preprocessor preview, no recolour.
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

  // Blit the recoloured ImageData via a temp canvas (putImageData ignores
  // transforms / scale; drawImage does not).
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
// Hue-rotate every gradient stop by 360°·t · hueRotationAmount across the
// 15 s loop. 360°·1 wraps to 0° so endpoints match exactly.
function renderAnimationFrame(tLoop){
  // Wrap t to [0,1) so t=1 collapses to t=0 — exact byte-equal endpoints.
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  const hueDeg = 360 * w * params.hueRotationAmount;
  buildGradientLUT(hueDeg);

  // Re-seed grain deterministically so endpoints match for export.
  if(params.grainAmount > 0){
    _rng = mulberry32(seedFromT(w));
    preprocess();
    _rng = Math.random;
  } else if(!preprocessed){
    preprocess();
  }
  // Video sources: pull the current frame.
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    preprocess();
  }
  buildOutput();
  paint();
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
    // Reset to a static gradient (no hue rotation).
    buildGradientLUT(0);
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
const BUILD_KEYS = new Set(['posterizeSteps','noiseIntensity','noiseScale','noiseGamma','gradientRepetitions','colorAttribute']);
const GRADIENT_KEYS = new Set(['stop1Pos','stop1Color','stop2Pos','stop2Color','stop3Pos','stop3Color']);
const PAINT_KEYS = new Set(['showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    // Mouse X = posterize steps (2..32), Mouse Y = noise intensity (0..1).
    // These are the two knobs that most change the visual.
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    const np = Math.max(2, Math.round(2 + ax * 30));
    const ni = Math.round((1 - ay) * 100) / 100;
    let touched = false;
    if(np !== params.posterizeSteps){
      params.posterizeSteps = np; touched = true;
      gui?.rows.get('posterizeSteps')?._write(np);
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
  // Build the initial gradient LUT before the first paint.
  buildGradientLUT(0);
  gui.on((key) => {
    if(key === 'animate'){ toggleAnimation(); return; }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(params.animate) return; // anim loop owns the frame
    if(GRADIENT_KEYS.has(key)){ buildGradientLUT(0); schedule('build'); return; }
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
