// pixart/patterns — port of tooooools.app/effects/patterns.
//
// Algorithm (tooooools-faithful):
//   - User uploads a single tile image (default: bundled pattern-1.png).
//   - Render an N×N grid (gridDensityNumber on the shorter side).
//   - For each cell, sample source luminance at the cell origin.
//     If luminance < lightnessThreshold, draw the tile scaled to the cell.
//     Else leave the cell as bgColor.

'use strict';

const CYCLE_MS = 0;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const DEFAULT_TILE_URL = './patterns/pattern-1.png';

const params = {
  // Preprocessor (shared with other pixart effects).
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Patterns — tooooools bundle defaults.
  lightnessThreshold: 178,
  gridDensityNumber:  49,
  // Paint.
  bgColor:           '#ffffff',
  showEffect:        true,
  // Tracked for the file row label (display only; actual tile lives in tileImage).
  patternImage:      'pattern-1.png',
  // Shared chrome.
  fit:               'cover',
  bg:                '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let lumGrid = null;
let cells = null;            // Float32Array: [x, y, w, h] per visible cell
let cellCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// The single tile image to stamp into dark cells.
let tileImage = new Image();
let tileReady = false;
tileImage.onload = () => { tileReady = true; schedule('paint'); };
tileImage.onerror = () => { tileReady = false; };
tileImage.src = DEFAULT_TILE_URL;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

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
  sctx.putImageData(id, 0, 0);
  preprocessed = id;

  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    const a = px[i+3] / 255;
    lumGrid[j] = (lerp(255, px[i], a) + lerp(255, px[i+1], a) + lerp(255, px[i+2], a)) / 3;
  }
}

// ---------- build cells ----------
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

  const cap = cols * rows;
  if(!cells || cells.length < cap * 4) cells = new Float32Array(cap * 4);
  let nC = 0;

  for(let r = 0; r < rows; r++){
    const sy = Math.floor(r * cellH);
    for(let c = 0; c < cols; c++){
      const sx = Math.floor(c * cellW);
      const L = lumGrid[sx + sy * W];
      if(L >= th) continue;
      const o = nC * 4;
      cells[o]   = c * cellW;
      cells[o+1] = r * cellH;
      cells[o+2] = cellW;
      cells[o+3] = cellH;
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

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  ctx.fillStyle = params.bgColor;
  ctx.fillRect(ox, oy, dw, dh);

  if(!cells || cellCount === 0 || !tileReady){ ctx.restore(); return; }

  const prevSmoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  for(let k = 0; k < cellCount; k++){
    const o = k * 4;
    const x = ox + cells[o]   * scale;
    const y = oy + cells[o+1] * scale;
    const w = cells[o+2] * scale;
    const h = cells[o+3] * scale;
    ctx.drawImage(tileImage, x, y, w, h);
  }
  ctx.imageSmoothingEnabled = prevSmoothing;

  ctx.restore();
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: 0,
  renderAt: () => paint(),
  pauseRender: () => {},
  resumeRender: () => paint(),
};

const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['lightnessThreshold','gridDensityNumber']);
const PAINT_KEYS = new Set(['bgColor','showEffect']);

function wirePatternUpload(){
  const row = document.querySelector('.wg-row[data-key="patternImage"]');
  if(!row) return;
  const input = row.querySelector('input[type=file]');
  if(!input) return;
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if(!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const url = ev.target.result;
      const next = new Image();
      next.onload = () => {
        tileImage = next;
        tileReady = true;
        schedule('paint');
      };
      next.onerror = () => { /* ignore */ };
      next.src = url;
    };
    reader.readAsDataURL(f);
  });
}

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(key === 'patternImage') return; // handled by the file input listener directly
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-patterns',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  wirePatternUpload();
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
}

document.addEventListener('DOMContentLoaded', init);
