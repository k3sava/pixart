// pixart/watercolor — stylised watercolour-painting effect.
//
// Multi-pass NPR pipeline:
//   1. Tolerance-bounded mean smoothing (3×3 average of neighbours within
//      `smoothing`·255 of the centre). Approximates a bilateral filter;
//      flattens interior tones the way pigment pools on damp paper.
//   2. Sobel-driven edge map → "paper bleed" outlines. Strong edges darken;
//      `wetness` lowers the edge floor so wetter washes bleed further.
//   3. Wet-rim glow: along dark-light boundaries a small brightness bump
//      lands on the lighter side. Approximates the "halo" pigment leaves
//      at the edge of a wash when it dries.
//   4. Procedural paper grain (deterministic mulberry32). Multiplied in at
//      strength `paperGrain`.
//   5. Palette LUT remap. Luminance is preserved and mapped through one of
//      five named palettes; `tone` weights the mix against original colour.
//
// References:
//   - Curtis et al. (1997). *Computer-Generated Watercolor*. SIGGRAPH '97.
//   - Bousseau et al. (2006). *Interactive Watercolor Rendering*.

'use strict';

const PAPER_SEED = 1;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const PALETTES = {
  natural:        null,
  sepia:          ['#1a0e07', '#5c3a1f', '#a87856', '#e8c89a', '#f8eedb'],
  'prussian-blue':['#06122d', '#1e3a8a', '#3b82c4', '#a8c8e8', '#f0f6fb'],
  'ink-wash':     ['#0a0a0a', '#3a3a3a', '#7a7a7a', '#c8c8c8', '#fafafa'],
  'gouache-pastel':['#2b1d3a', '#7d5ba6', '#e8a0bf', '#fde2c8', '#fffdf6'],
};

const params = {
  wetness:           0.4,
  edgeStrength:      0.5,
  smoothing:         0.6,
  paperGrain:        0.35,
  palette:          'natural',
  tone:              0.4,
  wetRim:            0.2,
  showEffect:        true,
  fit:               'cover',
  bg:                '#f7f1e3',
};
if(window.PIXState) window.PIXState.hydrate(params);

const CANVAS_SIZE = 600;

let gui;
let preprocessed = null;
let outImg = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

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

function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = CANVAS_SIZE;
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
  preprocessed = sctx.getImageData(0, 0, W, H);
}

function hexToRgb(hex){
  const n = parseInt(hex.replace('#',''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const LUT_SIZE = 256;
const LUT_R = new Uint8ClampedArray(LUT_SIZE);
const LUT_G = new Uint8ClampedArray(LUT_SIZE);
const LUT_B = new Uint8ClampedArray(LUT_SIZE);
let _lutPalette = null;
function buildPaletteLUT(name){
  const stops = PALETTES[name];
  if(!stops){ _lutPalette = null; return; }
  const rgbs = stops.map(hexToRgb);
  const n = rgbs.length;
  for(let i = 0; i < LUT_SIZE; i++){
    const u = i / (LUT_SIZE - 1);
    const fp = u * (n - 1);
    const k = Math.min(n - 2, Math.floor(fp));
    const t = fp - k;
    LUT_R[i] = lerp(rgbs[k][0], rgbs[k+1][0], t);
    LUT_G[i] = lerp(rgbs[k][1], rgbs[k+1][1], t);
    LUT_B[i] = lerp(rgbs[k][2], rgbs[k+1][2], t);
  }
  _lutPalette = name;
}

function buildOutput(){
  if(!preprocessed){ outImg = null; return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(!outImg || outImg.width !== W || outImg.height !== H){
    outImg = new ImageData(W, H);
  }
  const src = preprocessed.data;
  const dst = outImg.data;

  const wetness    = clamp(params.wetness, 0, 1);
  const edgeStr    = clamp(params.edgeStrength, 0, 1);
  const smoothing  = clamp(params.smoothing, 0, 1);
  const grain      = clamp(params.paperGrain, 0, 1);
  const wetRim     = clamp(params.wetRim, 0, 1);
  const tone       = clamp(params.tone, 0, 1);

  if(_lutPalette !== params.palette) buildPaletteLUT(params.palette);
  const hasLUT = _lutPalette !== null;

  const N = W * H;
  const lum = new Float32Array(N);
  for(let i = 0, j = 0; i < src.length; i += 4, j++){
    lum[j] = (src[i] * 299 + src[i+1] * 587 + src[i+2] * 114) / 1000;
  }

  const tol = 5 + smoothing * 75;

  const rng = mulberry32(PAPER_SEED);
  const grainBuf = grain > 0 ? new Float32Array(N) : null;
  if(grainBuf){
    for(let i = 0; i < N; i++) grainBuf[i] = rng();
  }

  for(let y = 0, j4 = 0; y < H; y++){
    for(let x = 0; x < W; x++, j4 += 4){
      const j = y * W + x;

      const lc = lum[j];
      let sumR = src[j4], sumG = src[j4+1], sumB = src[j4+2], cnt = 1;
      if(smoothing > 0 && x > 0 && x < W-1 && y > 0 && y < H-1){
        for(let dy = -1; dy <= 1; dy++){
          for(let dx = -1; dx <= 1; dx++){
            if(dx === 0 && dy === 0) continue;
            const k = (x + dx) + (y + dy) * W;
            if(Math.abs(lum[k] - lc) > tol) continue;
            const k4 = k * 4;
            sumR += src[k4]; sumG += src[k4+1]; sumB += src[k4+2];
            cnt++;
          }
        }
      }
      let r = sumR / cnt, g = sumG / cnt, b = sumB / cnt;

      let mag = 0, signedGrad = 0;
      if(edgeStr > 0 && x > 0 && x < W-1 && y > 0 && y < H-1){
        const v00 = lum[(x-1) + (y-1)*W];
        const v10 = lum[x     + (y-1)*W];
        const v20 = lum[(x+1) + (y-1)*W];
        const v01 = lum[(x-1) + y*W];
        const v21 = lum[(x+1) + y*W];
        const v02 = lum[(x-1) + (y+1)*W];
        const v12 = lum[x     + (y+1)*W];
        const v22 = lum[(x+1) + (y+1)*W];
        const gx = -v00 + v20 - 2*v01 + 2*v21 - v02 + v22;
        const gy = -v00 - 2*v10 - v20 + v02 + 2*v12 + v22;
        mag = Math.sqrt(gx*gx + gy*gy);
        signedGrad = gx + gy;
      }

      const edgeMagFloor = 60 - 50 * wetness;
      if(mag > edgeMagFloor){
        const e = clamp(((mag - edgeMagFloor) / 200) * edgeStr, 0, 1);
        const bleed = 1 - e * (0.45 + 0.35 * wetness);
        r *= bleed; g *= bleed; b *= bleed;
      }

      if(wetRim > 0 && mag > 40){
        const rimGain = (mag - 40) / 215 * wetRim * 40;
        if(signedGrad > 0){ r += rimGain; g += rimGain; b += rimGain; }
      }

      if(grain > 0){
        const gn = (grainBuf[j] - 0.5) * grain * 0.35 + 1;
        r *= gn; g *= gn; b *= gn;
      }

      if(hasLUT && tone > 0){
        const lOut = (r * 299 + g * 587 + b * 114) / 1000;
        const idx = clamp(lOut, 0, 255) | 0;
        r = lerp(r, LUT_R[idx], tone);
        g = lerp(g, LUT_G[idx], tone);
        b = lerp(b, LUT_B[idx], tone);
      }

      if(r < 0) r = 0; else if(r > 255) r = 255;
      if(g < 0) g = 0; else if(g > 255) g = 255;
      if(b < 0) b = 0; else if(b > 255) b = 255;
      dst[j4]   = r;
      dst[j4+1] = g;
      dst[j4+2] = b;
      dst[j4+3] = 255;
    }
  }
}

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
    if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
    else              { dw = W * 0.96; dh = dw / aspect; }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

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

window.WAEffect = {
  cycleMs: 0,
  renderAt: () => paint(),
  pauseRender: () => {},
  resumeRender: () => paint(),
};

const PRE_KEYS   = new Set(['fit','bg']);
const BUILD_KEYS = new Set(['wetness','edgeStrength','smoothing','paperGrain','palette','tone','wetRim']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  buildPaletteLUT(params.palette);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(key === 'palette'){ buildPaletteLUT(params.palette); schedule('build'); return; }
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-watercolor',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
}

document.addEventListener('DOMContentLoaded', init);
