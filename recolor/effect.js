// pixart/recolor — gradient-map recolour (static render, no animation).
//
// Reverse-engineered from tooooools.app/effects/recolor minified bundle.
//
// What the effect does — a gradient-map recolour:
//   1. Pick a scalar attribute of each pixel (brightness / hue / saturation).
//      brightness = (r+g+b)/765 · alpha + (1-alpha)   ← composite over white
//   2. Perturb with Perlin noise: attr += (noise(x*S, y*S)^γ − 0.5) · 2 · I
//   3. Posterise into N buckets:
//        N ≤ 1  → 0
//        N = 2  → 0 if <0.5 else 1
//        N > 2  → floor(attr·N) / (N−1)
//   4. Wrap K times: attr = (attr · K) % 1
//   5. Look up in a 3-stop piecewise-linear gradient (positions in [0,1]).
//
// Reference defaults: posterizeSteps:255, noiseIntensity:0, noiseScale:0.3,
//   noiseGamma:1, gradientRepetitions:1, colorAttribute:"brightness",
//   gradientStops:[{0,#00278a},{50,#fe76ec},{100,#fefffa}], showEffect:true.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (shared with every other effect).
  canvasSize:        600,
  blur:              0,
  grain:             0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Recolor-specific.
  showEffect:         true,
  posterizeSteps:     8,
  noiseIntensity:     0.18,
  noiseScale:         0.02,
  noiseGamma:         1,
  gradientRepetitions:1,
  colorAttribute:    'brightness', // brightness | hue | saturation
  stop1Pos:           0,
  stop1Color:        '#00278a',
  stop2Pos:           50,
  stop2Color:        '#fe76ec',
  stop3Pos:           100,
  stop3Color:        '#fefffa',
  // Shared chrome.
  fit:               'cover',
  bg:                '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let outImg       = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

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

// ---------- preprocessor ----------
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
  const rnd = Math.random;
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

// ---------- Perlin 2D (deterministic, fixed seed) ----------
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

// ---------- gradient LUT (3 stops, baked) ----------
const LUT_SIZE = 1024;
const LUT_R = new Uint8ClampedArray(LUT_SIZE);
const LUT_G = new Uint8ClampedArray(LUT_SIZE);
const LUT_B = new Uint8ClampedArray(LUT_SIZE);

function resolveStops(){
  const raw = [
    { pos: clamp(params.stop1Pos, 0, 100) / 100, col: hexToRgb(params.stop1Color) },
    { pos: clamp(params.stop2Pos, 0, 100) / 100, col: hexToRgb(params.stop2Color) },
    { pos: clamp(params.stop3Pos, 0, 100) / 100, col: hexToRgb(params.stop3Color) },
  ];
  raw.sort((a, b) => a.pos - b.pos);
  return raw;
}

function sampleStops(stops, u){
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

function buildGradientLUT(){
  const stops = resolveStops();
  for(let i = 0; i < LUT_SIZE; i++){
    const u = i / (LUT_SIZE - 1);
    const c = sampleStops(stops, u);
    LUT_R[i] = c[0];
    LUT_G[i] = c[1];
    LUT_B[i] = c[2];
  }
}

// ---------- build (gradient-map recolour, per-pixel via LUT) ----------
function buildOutput(){
  if(!preprocessed){ outImg = null; return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(!outImg || outImg.width !== W || outImg.height !== H){
    outImg = new ImageData(W, H);
  }
  const src = preprocessed.data;
  const dst = outImg.data;

  const N      = Math.max(1, params.posterizeSteps | 0);
  const K      = Math.max(1, params.gradientRepetitions | 0);
  const I      = params.noiseIntensity;
  const S      = params.noiseScale;
  const NG     = params.noiseGamma;
  const attr   = params.colorAttribute;
  const doNoise = I > 0;
  const denomN = Math.max(1, N - 1);

  let posterFn;
  if(N <= 1)       posterFn = () => 0;
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

// ---------- WAEffect contract (static; no animation) ----------
window.WAEffect = {
  cycleMs: 0,
  renderAt: () => paint(),
  pauseRender: () => {},
  resumeRender: () => paint(),
};

// Pipeline buckets.
const PRE_KEYS      = new Set(['canvasSize','blur','grain','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS    = new Set(['posterizeSteps','noiseIntensity','noiseScale','noiseGamma','gradientRepetitions','colorAttribute']);
const GRADIENT_KEYS = new Set(['stop1Pos','stop1Color','stop2Pos','stop2Color','stop3Pos','stop3Color']);
const PAINT_KEYS    = new Set(['showEffect']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  buildGradientLUT();
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(GRADIENT_KEYS.has(key)){ buildGradientLUT(); schedule('build'); return; }
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else if(PAINT_KEYS.has(key)) schedule('paint');
    else                         schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-recolor',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
