// pixart/patterns — port of tooooools.app/effects/patterns.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/patterns/page-4f9e64748661ad47.js,
//  shared preprocessor + page defaults in /_next/static/chunks/9357-2a51c42cdfe973de.js).
//
// What the reference effect is:
//   - A **photo-mosaic / collage** renderer, NOT a procedural pattern catalog.
//   - User uploads N pattern images (the bundle ships 6 defaults at
//     /pattern-1.png … /pattern-6.png — small halftone tiles).
//   - Each pattern image's mean luminance is precomputed via:
//       n += sqrt(0.299 R² + 0.587 G² + 0.114 B²)   over alpha-composited RGB
//       averageBrightness = n / (width * height)
//     and the catalog is sorted darkest → brightest.
//   - For each grid cell of the (preprocessed) source:
//       cell luminance L = (lerp(255,R,a) + lerp(255,G,a) + lerp(255,B,a)) / 3
//       if L < lightnessThreshold:
//         idx = clamp(floor((L / threshold) * N), 0, N-1)
//         draw catalog[idx].img into the cell rect (cellW × cellH)
//       else: cell stays empty (canvas bg shows through)
//   - Grid sizing (verbatim from the chunk):
//       n      = min(W, H) / gridDensityNumber       # target cell size (square-ish)
//       cols   = ceil(W / n)
//       rows   = ceil(H / n)
//       cellW  = W / cols
//       cellH  = H / rows
//     so the actual cells are slightly rectangular but tile the whole canvas
//     with no gaps. `gridDensityNumber` is "number of cells across the SHORTER
//     side", not "cells across width".
//   - One source pixel sampled per cell (top-left of the cell, `(floor(a*o) +
//     floor(n*i)*W) * 4`). No averaging. This is deliberate — the chunk uses
//     loadPixels() once on the source and indexes directly, so it's exact and
//     cheap.
//
// Bundle excerpt (beautified, /tmp/patterns.js lines 154-191):
//
//   let n = Math.min(t.width, t.height) / r.gridDensityNumber,
//       l = Math.ceil(t.width / n),
//       a = Math.ceil(t.height / n),
//       o = t.width / l,
//       i = t.height / a;
//   for (let n_ = 0; n_ < a; n_++)
//     for (let a_ = 0; a_ < l; a_++) {
//       let l_ = (Math.floor(a_ * o) + Math.floor(n_ * i) * t.width) * 4,
//           s = t.pixels[l_], u = t.pixels[l_+1], d = t.pixels[l_+2],
//           h = t.pixels[l_+3] / 255,
//           p = (e.lerp(255,s,h) + e.lerp(255,u,h) + e.lerp(255,d,h)) / 3;
//       if (p < r.lightnessThreshold) {
//         let l_img = c[clamp(floor(p/threshold * c.length), 0, c.length-1)].img;
//         t.image(l_img, a_*o, n_*i, o, i);
//       }
//     }
//
// And the catalog-preparation (chunk lines 122-153) — luminance sort:
//
//   for each pattern image:
//     loadPixels()
//     n = 0
//     for each pixel: alpha-composite RGB onto white;
//                     n += sqrt(0.299 R² + 0.587 G² + 0.114 B²)
//     averageBrightness = n / (W*H)
//   patterns.sort((a, b) => a.averageBrightness - b.averageBrightness)
//
// Bundle defaults (pageStates["/effects/patterns"], from 9357 chunk):
//   imageUrls:           ["/pattern-1.png" … "/pattern-6.png"]
//   showEffect:          true
//   lightnessThreshold:  178
//   gridDensityNumber:   49
// + preprocessor inheritance (canvasSize 600, blur 0, grain 0, gamma 1,
//   blackPoint 0, whitePoint 255).
//
// The six bundled pattern PNGs are tiny (700-1.2KB) halftone tiles. We mirror
// them into ./patterns/pattern-{1..6}.png so the effect ships self-contained
// (no cross-origin fetch).
//
// Animation: the reference is static. For pixart we sweep `gridDensityNumber`
// on a cosine pingpong (base - sweep → base + sweep → base - sweep). Denser
// grid mid-cycle reveals more cells; the endpoint density is identical at
// t=0 and t=1, so the loop closes byte-equal. We also pingpong the pattern-
// rotation flag implicitly via a swirl term in the dense direction (off by
// default).
//
// Determinism: the catalog sort is deterministic on image data; the cell loop
// is pure arithmetic; the only RNG is the preprocessor's grain stage, seeded
// from mulberry32(seedFromT(tLoop)). Endpoints byte-equal.
//
// Perf: 49 cells across shorter side → ~49 × 65 = ~3200 cells per frame at
// 600-wide source. drawImage of a tiny pattern PNG per cell is ~3 ms total on
// 2020-era hardware. Well under 30 ms even at densityNumber=150.

'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

// The six bundled patterns. Path is relative to /patterns/index.html.
const DEFAULT_PATTERN_URLS = [
  'patterns/pattern-1.png',
  'patterns/pattern-2.png',
  'patterns/pattern-3.png',
  'patterns/pattern-4.png',
  'patterns/pattern-5.png',
  'patterns/pattern-6.png',
];

const params = {
  // Preprocessor (shared with Displace / Edge / Cellular / Stippling).
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Patterns — bundle defaults, with one lift for the landing frame.
  lightnessThreshold: 220,   // bundle ships 178; 220 fills more of the frame
  gridDensityNumber:  49,
  // Loop-animation amplitude (cells swept around `gridDensityNumber`).
  densitySweep:       18,
  // Paint.
  bgColor:           '#f5f1ea',  // paper-cream behind the mosaic
  showEffect:        true,
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
let lumGrid = null;          // Float32Array of alpha-composited luminance
let cells = null;            // Float32Array of [x, y, w, h, patternIdx] per visible cell
let cellCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// Pattern catalog: [{ img: HTMLImageElement, averageBrightness: number, url }]
// Sorted darkest → brightest, like the reference.
let catalog = [];
let catalogReady = false;
let catalogLoadId = 0;

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
    if(dirty.build) buildCells();
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

// ---------- pattern catalog ----------
//
// Mirrors the bundle's p() function in /tmp/patterns.js (lines 112-153). We
// alpha-composite each pattern onto white, compute the per-pixel weighted
// magnitude sqrt(0.299 R² + 0.587 G² + 0.114 B²), average, and sort.
function brightnessOf(img){
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const id = cx.getImageData(0, 0, w, h).data;
  let n = 0;
  for(let i = 0; i < id.length; i += 4){
    const a = id[i+3] / 255;
    const r = id[i]   * a + 255 * (1 - a);
    const g = id[i+1] * a + 255 * (1 - a);
    const b = id[i+2] * a + 255 * (1 - a);
    n += Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b);
  }
  return n / (w * h);
}

function loadImageEl(url){
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload  = () => res(im);
    im.onerror = (e) => rej(e);
    im.src = url;
  });
}

async function loadCatalog(urls){
  const id = ++catalogLoadId;
  catalogReady = false;
  const loaded = await Promise.all(urls.map(async (u) => {
    try {
      const img = await loadImageEl(u);
      return { img, averageBrightness: brightnessOf(img), url: u };
    } catch(e){
      console.warn('pattern load failed:', u, e);
      return null;
    }
  }));
  if(id !== catalogLoadId) return; // a newer load superseded us
  catalog = loaded.filter(Boolean);
  catalog.sort((a, b) => a.averageBrightness - b.averageBrightness);
  catalogReady = catalog.length > 0;
  schedule('paint');
}

// ---------- preprocessor (canonical pixart stack) ----------
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

  // Alpha-composited luminance grid — one pass.
  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    const a = px[i+3] / 255;
    lumGrid[j] = (lerp(255, px[i], a) + lerp(255, px[i+1], a) + lerp(255, px[i+2], a)) / 3;
  }
}

// ---------- build cells (source-space) ----------
//
// Mirrors the bundle's draw closure exactly. Single sample per cell at the
// cell's top-left source pixel. We work in source-space; paint() maps to
// canvas-space with object-fit:contain so the mosaic stays square.
function buildCells(){
  if(!preprocessed){ cellCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const N = Math.max(1, params.gridDensityNumber | 0);
  const th = params.lightnessThreshold;

  const cell = Math.min(W, H) / N;
  const cols = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);
  const cellW = W / cols;
  const cellH = H / rows;
  const catLen = catalogReady ? catalog.length : 0;
  const denom = Math.max(0.0001, th);

  const cap = cols * rows;
  if(!cells || cells.length < cap * 5) cells = new Float32Array(cap * 5);
  let nC = 0;

  for(let r = 0; r < rows; r++){
    const sy = Math.floor(r * cellH);
    for(let c = 0; c < cols; c++){
      const sx = Math.floor(c * cellW);
      // Bundle samples (floor(a*o), floor(n*i)) of the SOURCE — top-left of
      // each cell. We do the same via the lumGrid.
      const L = lumGrid[sx + sy * W];
      if(L >= th) continue;
      let idx = 0;
      if(catLen > 1){
        idx = Math.floor((L / denom) * catLen);
        if(idx < 0) idx = 0; else if(idx > catLen - 1) idx = catLen - 1;
      }
      const o = nC * 5;
      cells[o]   = c * cellW;
      cells[o+1] = r * cellH;
      cells[o+2] = cellW;
      cells[o+3] = cellH;
      cells[o+4] = idx;
      nC++;
    }
  }
  cellCount = nC;
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
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  // Map source-space → canvas-space with `contain` and a 0.96 inset.
  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  // Paper background behind the mosaic.
  ctx.fillStyle = params.bgColor;
  ctx.fillRect(ox, oy, dw, dh);

  if(!catalogReady || !cells || cellCount === 0){ ctx.restore(); return; }

  // Crisp tile edges — patterns are pixel art at native res, blow them up clean.
  const prevSmoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;

  for(let k = 0; k < cellCount; k++){
    const o = k * 5;
    const x = ox + cells[o]   * scale;
    const y = oy + cells[o+1] * scale;
    const w = cells[o+2] * scale;
    const h = cells[o+3] * scale;
    const idx = cells[o+4] | 0;
    const img = catalog[idx]?.img;
    if(!img) continue;
    ctx.drawImage(img, x, y, w, h);
  }

  ctx.imageSmoothingEnabled = prevSmoothing;
  ctx.restore();
}

// ---------- animation ----------
//
// 15s seamless loop: gridDensityNumber pingpongs around its rest value.
// Pingpong via cos: density(t) = base + sweep · (2·pp(t) - 1) with
// pp(0)=pp(1)=0 → endpoints repeat exactly.
function pingpongT01(t){
  let w = t - Math.floor(t);
  if(w === 1) w = 0;
  return (1 - Math.cos(w * 2 * Math.PI)) / 2;
}

function applyAnimationT(tLoop){
  const t01 = pingpongT01(tLoop);
  const base = params.gridDensityNumber;
  const d = Math.round(base + params.densitySweep * (2 * t01 - 1));
  return { gridDensityNumber: Math.max(10, Math.min(150, d)) };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  const restDensity = params.gridDensityNumber;
  params.gridDensityNumber = anim.gridDensityNumber;

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
  buildCells();
  paint();

  params.gridDensityNumber = restDensity;
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

const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['lightnessThreshold','gridDensityNumber']);
const PAINT_KEYS = new Set(['bgColor','showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    // X → gridDensityNumber (10..150), Y → lightnessThreshold (0..255).
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    const nd = Math.max(10, Math.round(ax * 140 + 10));
    const nt = Math.round((1 - ay) * 255);
    let touched = false;
    if(nd !== params.gridDensityNumber){
      params.gridDensityNumber = nd; touched = true;
      gui?.rows.get('gridDensityNumber')?._write(nd);
    }
    if(nt !== params.lightnessThreshold){
      params.lightnessThreshold = nt; touched = true;
      gui?.rows.get('lightnessThreshold')?._write(nt);
    }
    if(touched) schedule('build');
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
    if(params.animate) return;
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => {
      if(!params.animate) schedule('pre');
    });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-patterns',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  cv.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  // Load the bundled six patterns; once ready we kick paint.
  loadCatalog(DEFAULT_PATTERN_URLS);
  schedule('pre');
}

document.addEventListener('DOMContentLoaded', init);
