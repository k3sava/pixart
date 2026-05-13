// pixart/dithering — port of tooooools.app/effects/dithering.
//
// Image dither pipeline: image → grid downsample → quantise via a chosen
// pattern → upsample to pixel blocks. Three patterns: Floyd-Steinberg, 4×4
// Bayer, Random. Two colour modes: mono (threshold) and palette (RGB nearest).
//
// Step 2 (pattern-set): animation + interactive cursor on top of step 1.
// Pattern mirrors bevel/ascii — applyMode(t01)/applyInteractive() restore
// callbacks so GUI sliders show user-intent values, not modulated ones.
//
// Defaults swept against portrait.jpg in browser:
//   pixelSize=4          — face contours read clearly; ≥10 dissolves features.
//   lightnessThreshold=160 — F-S balance, hair + face both legible.
//   whitePoint=255       — full range; tone mode shifts dynamically.
//   patternType='F-S'    — Floyd-Steinberg keeps portrait recognizable best.
//
// Animation modes (cycleMs=15000):
//   grow — pixelSize ping-pongs 2 ↔ 10. Cells inflate/deflate; portrait
//          alternately resolves and pixelates.
//   tone — whitePoint drifts 130 ↔ 255. Dither density shifts across mid-tones.
//
// Interactive: cursor X drives pixelSize (1..12 — left=fine, right=chunky);
// cursor Y drives lightnessThreshold (40..220 — top=dark, bottom=bright).
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  canvasSize:        600,
  blur:              0,
  grain:             0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  patternType:       'F-S',   // 'F-S' | 'Bayer' | 'Random'
  pixelSize:         4,
  lightnessThreshold: 160,
  colorMode:         false,
  animate:           false,
  mode:              'grow',
  interactive:       false,
  showEffect:        true,
  fit:               'cover',
  bg:                '#0a0a0a',
};
const COLOR_COUNT = 24;
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let rects = null;
let rectCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

function schedule(level){
  if(level === 'pre') dirty.pre = true;
  if(level === 'pre' || level === 'build') dirty.build = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre)   preprocess();
    if(dirty.build) buildRects();
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
}

// ---------- palette generation ----------
function genPalette(n){
  const out = [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }];
  const r = Math.ceil(Math.pow(Math.max(2, n) - 2, 1 / 3));
  if(r < 2 || out.length >= n) return out;
  const step = 255 / (r - 1);
  for(let l = 0; l < r && out.length < n; l++){
    for(let m = 0; m < r && out.length < n; m++){
      for(let a = 0; a < r && out.length < n; a++){
        if((l === 0 && m === 0 && a === 0) ||
           (l === r - 1 && m === r - 1 && a === r - 1)) continue;
        out.push({ r: Math.round(l * step), g: Math.round(m * step), b: Math.round(a * step) });
      }
    }
  }
  return out;
}

function nearestColor(r, g, b, palette){
  let best = palette[0], bd = Infinity;
  for(let i = 0; i < palette.length; i++){
    const p = palette[i];
    const dr = (r - p.r) * 0.299;
    const dg = (g - p.g) * 0.587;
    const db = (b - p.b) * 0.114;
    const d  = dr * dr + dg * dg + db * db;
    if(d < bd){ bd = d; best = p; }
  }
  return best;
}

function twoNearest(r, g, b, palette){
  const dist = new Array(palette.length);
  for(let i = 0; i < palette.length; i++){
    const p = palette[i];
    const dr = (r - p.r) * 0.299;
    const dg = (g - p.g) * 0.587;
    const db = (b - p.b) * 0.114;
    dist[i] = { c: p, d: dr * dr + dg * dg + db * db };
  }
  dist.sort((a, b) => a.d - b.d);
  return [dist[0].c, dist[1].c];
}

// ---------- downsample to grid ----------
function downsample(px, W, H, gw, gh, color){
  const cw = W / gw, ch = H / gh;
  const out = new Array(gw * gh);
  for(let y = 0; y < gh; y++){
    const y0 = Math.floor(y * ch);
    const y1 = Math.min(H, Math.floor((y + 1) * ch));
    for(let x = 0; x < gw; x++){
      const x0 = Math.floor(x * cw);
      const x1 = Math.min(W, Math.floor((x + 1) * cw));
      let sr = 0, sg = 0, sb = 0, n = 0;
      for(let yy = y0; yy < y1; yy++){
        for(let xx = x0; xx < x1; xx++){
          const i = (yy * W + xx) * 4;
          const a = px[i+3] / 255;
          sr += px[i]   * a + 255 * (1 - a);
          sg += px[i+1] * a + 255 * (1 - a);
          sb += px[i+2] * a + 255 * (1 - a);
          n++;
        }
      }
      if(n === 0){
        out[y * gw + x] = color ? { r: 255, g: 255, b: 255 } : 255;
      } else if(color){
        out[y * gw + x] = {
          r: clamp(Math.round(sr / n), 0, 255),
          g: clamp(Math.round(sg / n), 0, 255),
          b: clamp(Math.round(sb / n), 0, 255),
        };
      } else {
        out[y * gw + x] = clamp((sr + sg + sb) / (3 * n), 0, 255);
      }
    }
  }
  return out;
}

// ---------- Bayer 4×4 ----------
const BAYER4 = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5],
];

// ---------- patterns ----------
function fsMono(grid, gw, gh, threshold){
  const scale = 255 / Math.max(1, threshold);
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const v = Math.min(255, Math.max(0, grid[i] * scale));
      const q = v > 127 ? 255 : 0;
      grid[i] = q;
      const err = v - q;
      if(x + 1 < gw)               grid[i + 1]      += 7 * err / 16 / scale;
      if(x - 1 >= 0 && y + 1 < gh) grid[i + gw - 1] += 3 * err / 16 / scale;
      if(y + 1 < gh)               grid[i + gw]     += 5 * err / 16 / scale;
      if(x + 1 < gw && y + 1 < gh) grid[i + gw + 1] += 1 * err / 16 / scale;
    }
  }
}

function fsColor(grid, gw, gh, palette){
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const c = grid[i];
      const q = nearestColor(c.r, c.g, c.b, palette);
      grid[i] = q;
      const er = c.r - q.r, eg = c.g - q.g, eb = c.b - q.b;
      const spread = (xx, yy, w) => {
        if(xx < 0 || xx >= gw || yy < 0 || yy >= gh) return;
        const t = grid[yy * gw + xx];
        if(typeof t !== 'object') return;
        t.r = clamp(t.r + er * w, 0, 255);
        t.g = clamp(t.g + eg * w, 0, 255);
        t.b = clamp(t.b + eb * w, 0, 255);
      };
      spread(x + 1, y,     7 / 16);
      if(y + 1 < gh){
        spread(x - 1, y + 1, 3 / 16);
        spread(x,     y + 1, 5 / 16);
        spread(x + 1, y + 1, 1 / 16);
      }
    }
  }
}

function bayerMono(grid, gw, gh, threshold){
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const m = BAYER4[y & 3][x & 3];
      const local = (threshold / 128) * (m / 16) * 255;
      grid[i] = grid[i] > local ? 255 : 0;
    }
  }
}

function bayerColor(grid, gw, gh, palette){
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const c = grid[i];
      const pair = twoNearest(c.r, c.g, c.b, palette);
      const m = BAYER4[y & 3][x & 3] / 16;
      grid[i] = m < 0.5 ? pair[0] : pair[1];
    }
  }
}

function randMono(grid, gw, gh, threshold){
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const local = threshold * Math.random() * 2;
      grid[i] = grid[i] > local ? 255 : 0;
    }
  }
}

function randColor(grid, gw, gh, palette){
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const c = grid[i];
      const pair = twoNearest(c.r, c.g, c.b, palette);
      grid[i] = Math.random() < 0.5 ? pair[0] : pair[1];
    }
  }
}

// ---------- build rects ----------
function buildRects(){
  if(!preprocessed){ rectCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const ps = Math.max(1, params.pixelSize | 0);
  const gw = Math.ceil(W / ps);
  const gh = Math.ceil(H / ps);
  if(gw === 0 || gh === 0){ rectCount = 0; return; }

  const grid = downsample(preprocessed.data, W, H, gw, gh, params.colorMode);

  switch(params.patternType){
    case 'F-S':
      if(params.colorMode) fsColor(grid, gw, gh, genPalette(COLOR_COUNT));
      else                 fsMono(grid, gw, gh, params.lightnessThreshold);
      break;
    case 'Bayer':
      if(params.colorMode) bayerColor(grid, gw, gh, genPalette(COLOR_COUNT));
      else                 bayerMono(grid, gw, gh, params.lightnessThreshold);
      break;
    case 'Random':
      if(params.colorMode) randColor(grid, gw, gh, genPalette(COLOR_COUNT));
      else                 randMono(grid, gw, gh, params.lightnessThreshold);
      break;
  }

  const cw = W / gw, ch = H / gh;
  const cap = gw * gh;
  if(!rects || rects.length < cap * 7) rects = new Float32Array(cap * 7);
  let n = 0;
  for(let y = 0; y < gh; y++){
    const y0 = Math.floor(y * ch);
    const y1 = Math.min(H, Math.floor((y + 1) * ch));
    for(let x = 0; x < gw; x++){
      const v = grid[y * gw + x];
      const x0 = Math.floor(x * cw);
      const x1 = Math.min(W, Math.floor((x + 1) * cw));
      let r, g, b;
      if(typeof v === 'object'){ r = v.r; g = v.g; b = v.b; }
      else                     { r = g = b = v; }
      const o = n * 7;
      rects[o]   = x0;
      rects[o+1] = y0;
      rects[o+2] = x1 - x0;
      rects[o+3] = y1 - y0;
      rects[o+4] = r;
      rects[o+5] = g;
      rects[o+6] = b;
      n++;
    }
  }
  rectCount = n;
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

  if(!rects || rectCount === 0){ ctx.restore(); return; }

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  const PAD = 0.5;
  for(let k = 0; k < rectCount; k++){
    const o = k * 7;
    const x = ox + rects[o]   * scale;
    const y = oy + rects[o+1] * scale;
    const w = rects[o+2] * scale + PAD;
    const h = rects[o+3] * scale + PAD;
    const r = rects[o+4] | 0, g = rects[o+5] | 0, b = rects[o+6] | 0;
    ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
    ctx.fillRect(x, y, w, h);
  }

  ctx.restore();
}

// ---------- animation ----------
const CYCLE_MS = 15000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'grow'){
    const base = params.pixelSize;
    params.pixelSize = 2 + 8 * pingPong(t01);
    return () => { params.pixelSize = base; };
  }
  if(mode === 'tone'){
    const base = params.whitePoint;
    params.whitePoint = 192 + 63 * Math.cos(t01 * Math.PI * 2);
    return () => { params.whitePoint = base; };
  }
  if(mode === 'threshold'){
    const base = params.lightnessThreshold;
    params.lightnessThreshold = 80 + 140 * pingPong(t01);
    return () => { params.lightnessThreshold = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseP = params.pixelSize;
  const baseT = params.lightnessThreshold;
  params.pixelSize = 1 + ax * 11;        // 1..12
  params.lightnessThreshold = 40 + ay * 180; // 40..220
  return () => { params.pixelSize = baseP; params.lightnessThreshold = baseT; };
}

// Track if last frame baked a modulated whitePoint into preprocessed buffer
// so non-tone frames can re-preprocess to wipe leftover modulation.
let preprocessedIsToneModulated = false;
function renderAt(t01){
  const isTone = params.animate && params.mode === 'tone';
  const needsPre = isTone || preprocessedIsToneModulated;
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  if(needsPre) preprocess();
  buildRects();
  paint();
  restoreInt();
  restoreMode();
  preprocessedIsToneModulated = isTone;
}

function animationLoop(){
  if(!params.animate){ animationId = null; return; }
  const elapsed = performance.now() - animationStartTime;
  renderAt((elapsed % CYCLE_MS) / CYCLE_MS);
  animationId = requestAnimationFrame(animationLoop);
}

function startAnimation(){
  if(animationId) return;
  animationStartTime = performance.now();
  animationLoop();
}
function stopAnimation(){
  if(animationId){ cancelAnimationFrame(animationId); animationId = null; }
}

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  hasMouse = true;
  if(params.interactive && !params.animate){
    renderAt(0);
  }
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else paint();
    return cv;
  },
};

const PRE_KEYS   = new Set(['canvasSize','blur','grain','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['pixelSize','lightnessThreshold','patternType','colorMode']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('pre'); }
      return;
    }
    if(key === 'mode'){
      if(!params.animate) schedule('paint');
      return;
    }
    if(key === 'interactive'){
      if(!params.animate) schedule('paint');
      return;
    }
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
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-dithering',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
  if(params.animate) startAnimation();
}

document.addEventListener('DOMContentLoaded', init);
