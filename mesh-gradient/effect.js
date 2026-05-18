// pixart/mesh-gradient — bilinear mesh gradient.
//
// Divides the source image into a W×H grid of control points. Each control
// point is assigned the average colour of its source region. Output pixels
// are coloured by bilinear interpolation across the four surrounding control
// points, producing a smooth, fluid gradient that preserves the image's
// overall palette — Figma's mesh gradient, essentially.
//
// Params:
//   resolution   (2–16)    — grid density per axis.
//   smoothing    (0–100)   — extra bicubic passes over the mesh.
//   wobble       (0–100)   — random jitter of control-point positions.
//   saturation   (0–200)   — HSL saturation boost / reduce.
//   blend        (0–100)   — mix with source image.
//   animate      bool
//   mode         drift | morph | pulse
//
// Interactive: X → resolution (2–16), Y → wobble (0–100).
//
// Animation modes (cycleMs=20000):
//   drift — control-point colours slowly rotate through adjacent palette.
//   morph — control-point positions gently shift (mesh deformation).
//   pulse — saturation + resolution oscillate (fine ↔ coarse breathing).

'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  canvasSize:  600,
  resolution:  6,
  smoothing:   20,
  wobble:      18,
  saturation:  120,
  blend:       0,
  animate:     false,
  mode:        'drift',
  interactive: false,
  showEffect:  true,
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let meshColors   = null;   // Float32Array [R,G,B] per control point (base, un-animated)
let outImg       = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// ── helpers ──────────────────────────────────────────────────
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }
function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

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
  if(level === 'pre')  dirty.pre   = true;
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

// ── HSL helpers ───────────────────────────────────────────────
function rgbToHsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if(max !== min){
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch(max){
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
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
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (p, q, t) => {
    if(t < 0) t += 1;
    if(t > 1) t -= 1;
    if(t < 1/6) return p + (q - p) * 6 * t;
    if(t < 1/2) return q;
    if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h)       * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}

function adjustSaturation(r, g, b, sat01){
  // sat01: 0=greyscale, 1=original, 2=double-saturated.
  if(sat01 === 1) return [r, g, b];
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToRgb(h, clamp(s * sat01, 0, 1), l);
}

// ── preprocess ────────────────────────────────────────────────
function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = (window.PIXSource?.height || srcCv.height) / (window.PIXSource?.width || srcCv.width);
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
  preprocessed = sctx.getImageData(0, 0, W, H);
  meshColors = null;
}

// ── sample average colour of a rectangular region ─────────────
function sampleRegion(srcData, srcW, srcH, x0, y0, x1, y1){
  let r = 0, g = 0, b = 0, n = 0;
  const px0 = clamp(Math.round(x0), 0, srcW - 1);
  const py0 = clamp(Math.round(y0), 0, srcH - 1);
  const px1 = clamp(Math.round(x1), 0, srcW);
  const py1 = clamp(Math.round(y1), 0, srcH);
  const data = srcData;
  for(let y = py0; y < py1; y++){
    for(let x = px0; x < px1; x++){
      const j = (y * srcW + x) * 4;
      r += data[j]; g += data[j+1]; b += data[j+2];
      n++;
    }
  }
  if(n === 0) return [128, 128, 128];
  return [r / n, g / n, b / n];
}

// ── build mesh colour grid ────────────────────────────────────
// Returns a Float32Array of [R,G,B] * (cols * rows), row-major.
function buildMeshColors(res, wobbleAmt, seed, offsetXY){
  if(!preprocessed) return null;
  const W = preprocessed.width, H = preprocessed.height;
  const cols = res, rows = res;
  const rng = mulberry32(seed);
  const mc = new Float32Array(cols * rows * 3);

  // Wobble offset: each control point shifts ± (wobble * cellSize * 0.5)
  const cellW = W / cols;
  const cellH = H / rows;
  const maxDX = cellW * wobbleAmt * 0.4;
  const maxDY = cellH * wobbleAmt * 0.4;

  for(let row = 0; row < rows; row++){
    for(let col = 0; col < cols; col++){
      // Base centre of this cell in source space.
      let cx = (col + 0.5) * cellW;
      let cy = (row + 0.5) * cellH;

      // Wobble shifts the centre (but sampling stays a full-region average).
      const dx = (rng() * 2 - 1) * maxDX;
      const dy = (rng() * 2 - 1) * maxDY;

      // Additional morph animation offset.
      const ox = offsetXY ? offsetXY[col * rows + row * cols] || 0 : 0;
      const oy = offsetXY ? offsetXY[col * rows + row * cols + 1] || 0 : 0;

      cx = clamp(cx + dx + ox, 0, W);
      cy = clamp(cy + dy + oy, 0, H);

      // Region to average: quarter-cell around shifted centre.
      const hw = cellW * 0.4, hh = cellH * 0.4;
      const [r, g, bv] = sampleRegion(
        preprocessed.data, W, H,
        cx - hw, cy - hh, cx + hw, cy + hh
      );
      const idx = (row * cols + col) * 3;
      mc[idx]   = r;
      mc[idx+1] = g;
      mc[idx+2] = bv;
    }
  }
  return mc;
}

// ── bilinear interpolation across the mesh ────────────────────
// For pixel (px, py) in [0,W)×[0,H), find surrounding 4 control points
// and blend. With smoothing we do multiple bicubic-style weighted passes.
function buildOutput(){
  if(!preprocessed){ outImg = null; return; }
  const srcW = preprocessed.width, srcH = preprocessed.height;

  const res     = Math.max(2, Math.min(16, params.resolution | 0));
  const wobble  = clamp(params.wobble / 100, 0, 1);
  const sat01   = clamp(params.saturation / 100, 0, 2);
  const blend01 = clamp(params.blend / 100, 0, 1);

  // Build the base mesh.
  const seed = (res * 1337) ^ 0xDEADBEEF;
  const mc = buildMeshColors(res, wobble, seed, null);
  meshColors = mc;

  if(!mc){
    outImg = null; return;
  }

  // Write output.
  if(!outImg || outImg.width !== srcW || outImg.height !== srcH){
    outImg = new ImageData(srcW, srcH);
  }
  renderMeshToImage(mc, res, srcW, srcH, sat01, blend01, params.smoothing);
}

// ── render mesh → ImageData ────────────────────────────────────
function renderMeshToImage(mc, res, W, H, sat01, blend01, smoothing){
  const dst  = outImg.data;
  const src  = preprocessed.data;
  const cols = res, rows = res;

  // Cell size in output space (output == source here, both at canvasSize).
  const cellW = W / (cols - 1);
  const cellH = H / (rows - 1);

  // Extra smoothing: scale the effective cell size so interpolation is wider.
  const smooth = clamp(smoothing / 100, 0, 1);

  for(let py = 0; py < H; py++){
    for(let px = 0; px < W; px++){
      // Map pixel to mesh coordinates [0, cols-1] × [0, rows-1].
      let u = px / cellW;
      let v = py / cellH;

      // Clamp to mesh bounds.
      u = clamp(u, 0, cols - 1 - 1e-9);
      v = clamp(v, 0, rows - 1 - 1e-9);

      const ci = u | 0;  // left column index
      const ri = v | 0;  // top row index
      const tx = u - ci; // fractional
      const ty = v - ri;

      // Smoothing: apply a smoothstep to the fractions for softer blends.
      const fx = smooth > 0 ? lerp(tx, tx * tx * (3 - 2 * tx), smooth) : tx;
      const fy = smooth > 0 ? lerp(ty, ty * ty * (3 - 2 * ty), smooth) : ty;

      // Four surrounding control-point indices.
      const c0 = ri       * cols + ci;       // top-left
      const c1 = ri       * cols + (ci + 1); // top-right
      const c2 = (ri + 1) * cols + ci;       // bottom-left
      const c3 = (ri + 1) * cols + (ci + 1); // bottom-right

      // Bilinear interpolation.
      const i0 = c0 * 3, i1 = c1 * 3, i2 = c2 * 3, i3 = c3 * 3;

      let r = lerp(lerp(mc[i0],   mc[i1],   fx), lerp(mc[i2],   mc[i3],   fx), fy);
      let g = lerp(lerp(mc[i0+1], mc[i1+1], fx), lerp(mc[i2+1], mc[i3+1], fx), fy);
      let b = lerp(lerp(mc[i0+2], mc[i1+2], fx), lerp(mc[i2+2], mc[i3+2], fx), fy);

      // Saturation.
      if(sat01 !== 1){
        const [ar, ag, ab] = adjustSaturation(r, g, b, sat01);
        r = ar; g = ag; b = ab;
      }

      // Blend with source.
      if(blend01 > 0){
        const j = (py * W + px) * 4;
        r = lerp(r, src[j],   blend01);
        g = lerp(g, src[j+1], blend01);
        b = lerp(b, src[j+2], blend01);
      }

      const j = (py * W + px) * 4;
      dst[j]   = clamp(r, 0, 255);
      dst[j+1] = clamp(g, 0, 255);
      dst[j+2] = clamp(b, 0, 255);
      dst[j+3] = 255;
    }
  }
}

// ── paint ──────────────────────────────────────────────────────
let paintScratch = null;
function paint(){
  window.WAGUI?.flashValues(params);
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!preprocessed){ ctx.restore(); return; }

  const imgW = preprocessed.width, imgH = preprocessed.height;
  const aspect = imgW / imgH;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;

  if(!params.showEffect){
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcBuf, ox, oy, dw, dh);
    ctx.restore();
    return;
  }

  if(!outImg){ ctx.restore(); return; }
  if(!paintScratch || paintScratch.width !== imgW || paintScratch.height !== imgH){
    paintScratch = document.createElement('canvas');
    paintScratch.width = imgW; paintScratch.height = imgH;
  }
  paintScratch.getContext('2d').putImageData(outImg, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(paintScratch, ox, oy, dw, dh);
  ctx.restore();
}

// ── animation ─────────────────────────────────────────────────
const CYCLE_MS = 20000;
let animationId         = null;
let animationStartTime  = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

// applyMode returns a restore function.
// For each mode we temporarily mutate params, render, then restore.
function applyMode(t01){
  const mode = params.mode;

  if(mode === 'drift'){
    // Drift: hue-rotate the mesh colours by up to 60° back and forth.
    const base = params._driftHue;
    params._driftHue = pingPong(t01) * 60;
    return () => { params._driftHue = base; };
  }
  if(mode === 'morph'){
    // Morph: resolution stays fixed, but we use a time-varying seed for wobble
    // so the mesh positions slowly shift.
    const base = params._morphSeed;
    params._morphSeed = t01;
    return () => { params._morphSeed = base; };
  }
  if(mode === 'pulse'){
    // Pulse: resolution oscillates 2 ↔ 12, saturation oscillates 80 ↔ 160.
    const baseRes = params.resolution;
    const baseSat = params.saturation;
    params.resolution  = Math.round(2 + 10 * pingPong(t01));
    params.saturation  = 80 + 80 * pingPong(t01);
    return () => { params.resolution = baseRes; params.saturation = baseSat; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseRes    = params.resolution;
  const baseWobble = params.wobble;
  params.resolution = Math.round(2 + ax * 14);   // 2..16
  params.wobble     = Math.round(ay * 100);       // 0..100
  return () => { params.resolution = baseRes; params.wobble = baseWobble; };
}

// Drift mode recolours the mesh by hue-rotating the cached meshColors.
function renderDrift(hueShift){
  if(!meshColors || !outImg || !preprocessed) return false;
  const srcW = preprocessed.width, srcH = preprocessed.height;
  const res  = Math.max(2, Math.min(16, params.resolution | 0));
  const sat01   = clamp(params.saturation / 100, 0, 2);
  const blend01 = clamp(params.blend / 100, 0, 1);
  const n   = meshColors.length / 3;
  const mc2 = new Float32Array(meshColors.length);
  for(let k = 0; k < n; k++){
    const i = k * 3;
    const [h, s, l] = rgbToHsl(meshColors[i], meshColors[i+1], meshColors[i+2]);
    const [nr, ng, nb] = hslToRgb(h + hueShift, s, l);
    mc2[i] = nr; mc2[i+1] = ng; mc2[i+2] = nb;
  }
  renderMeshToImage(mc2, res, srcW, srcH, sat01, blend01, params.smoothing);
  return true;
}

function renderAt(t01){
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();

  if(params.animate && params.mode === 'drift' && meshColors && typeof params._driftHue === 'number'){
    // Paint-cheap: only recolour existing mesh.
    renderDrift(params._driftHue);
    paint();
  } else {
    buildOutput();
    paint();
  }

  restoreInt();
  restoreMode();
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

window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else { paint(); }
    return cv;
  },
};

// ── GUI wiring ────────────────────────────────────────────────
const PRE_KEYS   = new Set(['canvasSize','fit','bg']);
const BUILD_KEYS = new Set(['resolution','wobble','smoothing','saturation','blend']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('paint'); }
      return;
    }
    if(key === 'mode' || key === 'interactive'){
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
      canvas: cv, name: 'pixart-mesh-gradient',
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
