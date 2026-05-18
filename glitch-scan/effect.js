// pixart/glitch-scan — horizontal scan-line displacement.
//
// Algorithm:
//   1. Preprocessor (shared) produces a W×H RGBA buffer at canvasSize.
//   2. buildOutput():
//      - Per-row displacement map seeded by (seed + frameCounter). Each row
//        gets a base offset multiplied by a per-row random factor.
//      - scanLines parameter thins the active rows: rows below the density
//        threshold pass through unshifted; rows above it are displaced.
//      - Row-level channel split: R channel is pushed left, B right by
//        colorSplit pixels. The G channel stays centred.
//      - Block tears: `tears` rectangular regions of heavy extra offset
//        layered on top of the base scan displacement.
//   3. paint():
//      - Draw the displaced image with CSS `filter: contrast()` boosted by
//        intensity for the CRT-corrupt aesthetic.
//      - On each animation frame the displacement map is regenerated with a
//        time-evolved seed so the glitch "moves".
//
// Animation modes:
//   burst  — quiet most of the time; intensity spikes suddenly, holds briefly,
//             then decays back. Mimics a VHS tape dropout event.
//   drift  — slow continuous sinusoidal drift. Calm, meditative glitch.
//   storm  — rapid chaotic high-amplitude displacement every frame. Pure chaos.
//
// Interactive:
//   X → intensity (0–100)
//   Y → colorSplit (0–100)
//
// WAEffect contract: { cycleMs: 15000, renderAt(t), pauseRender(), resumeRender() }
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Working buffer: source image scaled to canvasSize.
const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

// Output buffer: displaced pixel-art result.
const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d', { willReadFrequently: true });

// Three single-channel strip buffers for R/G/B channel splitting.
const chanR = document.createElement('canvas');
const chanG = document.createElement('canvas');
const chanB = document.createElement('canvas');
const chanRCtx = chanR.getContext('2d');
const chanGCtx = chanG.getContext('2d');
const chanBCtx = chanB.getContext('2d');

const params = {
  canvasSize:  600,
  intensity:   42,     // 0–100 overall displacement magnitude
  scanLines:   55,     // 0–100 density of displaced rows
  tears:       3,      // 0–10 number of block tear regions
  colorSplit:  28,     // 0–100 R/B channel separation in px
  speed:       1.4,    // 0.5–4 animation speed multiplier
  seed:        137,    // 0–999 base noise seed
  bg:          '#000000',
  mode:        'burst',
  animate:     false,
  interactive: false,
  showEffect:  true,
  fit:         'cover',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// Animation state.
const CYCLE_MS = 15000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

// Paint-time overrides written by applyMode / applyInteractive.
// These are applied transiently each frame and rolled back afterwards.
const paintOpts = {
  intensityScale: 1,   // multiplier on params.intensity
  colorSplitScale: 1,  // multiplier on params.colorSplit
};

// Rolling frame-time offset so the displacement map evolves per frame.
let frameTime = 0;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function mapRange(v, a, b, c, d){ return c + (d - c) * ((v - a) / (b - a)); }

// Mulberry32: fast seedable PRNG producing floats in [0, 1).
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
  const w = cv.clientWidth  || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ---------- preprocessor ----------
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
}

// ---------- displacement map + channel-split builder ----------
//
// We work in pixel space (W×H) and emit three per-channel ImageData buffers
// that are composited in paint().
//
// Row displacement logic:
//   - For each row y, the PRNG produces a per-row factor f in [0,1).
//   - If f > (scanLines/100) the row is active (displaced).
//   - Active rows receive offset = sign(f-.5)*2 * (f-.5)*2 * maxDisplace.
//     The squared falloff concentrates large displacements in a minority of rows,
//     which reads as sharp scan-line tears rather than a uniform smear.
//   - colorSplit px of R is pushed left and B pushed right.
//   - Block tears: the `tears` rectangular blocks each span a random contiguous
//     band of rows and get an additional heavy offset layered on top.
//
function buildOutput(){
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;
  const src = preprocessed.data;

  // Ensure all canvases are sized.
  if(outBuf.width !== W || outBuf.height !== H){
    outBuf.width = W; outBuf.height = H;
    chanR.width = W; chanR.height = H;
    chanG.width = W; chanG.height = H;
    chanB.width = W; chanB.height = H;
  }

  const intensity   = clamp(params.intensity * paintOpts.intensityScale, 0, 100);
  const scanDensity = clamp(params.scanLines,  0, 100) / 100;   // fraction of rows active
  const splitPx     = clamp(params.colorSplit * paintOpts.colorSplitScale, 0, 100);
  const tearCount   = clamp(params.tears | 0, 0, 10);

  // Max horizontal displacement in pixels. At intensity=100 we allow ±40% of width.
  const maxDisplace = (intensity / 100) * W * 0.40;

  // Seed evolves with frameTime and the user seed.
  const frameSeed = (params.seed * 1000 + (frameTime * 1000) | 0) >>> 0;
  const rng = mulberry32(frameSeed);

  // --- Build block tear regions first. ---
  // Each tear: { y0, y1, extraOffset }
  const tearRng = mulberry32(frameSeed ^ 0xDEADBEEF);
  const tearZones = [];
  for(let t = 0; t < tearCount; t++){
    const height = Math.max(2, (tearRng() * H * 0.12) | 0);  // up to 12% of height
    const y0 = (tearRng() * (H - height)) | 0;
    const y1 = y0 + height;
    // Extra tear offset: heavy, can be entire width.
    const dir = tearRng() > 0.5 ? 1 : -1;
    const mag = (0.3 + tearRng() * 0.7) * W * 0.45;
    tearZones.push({ y0, y1, extra: dir * mag });
  }

  // --- Build per-row displacement map. ---
  const rowOffset = new Float32Array(H);      // net horizontal shift per row
  for(let y = 0; y < H; y++){
    const f = rng();
    // Only displace rows above the density threshold.
    if(f > (1 - scanDensity)){
      // Signed displacement: remap f from [1-scanDensity, 1] → [-1, +1].
      const norm = (f - (1 - scanDensity)) / scanDensity; // 0..1
      const signed = (norm - 0.5) * 2;                    // -1..+1
      rowOffset[y] = signed * signed * Math.sign(signed) * maxDisplace;
    }
  }
  // Layer tear zone offsets on top.
  for(const zone of tearZones){
    for(let y = zone.y0; y < zone.y1; y++){
      rowOffset[y] += zone.extra;
    }
  }

  // --- Extract R/G/B channel pixel rows, each shifted independently. ---
  const rData = new Uint8ClampedArray(W * H * 4);
  const gData = new Uint8ClampedArray(W * H * 4);
  const bData = new Uint8ClampedArray(W * H * 4);

  for(let y = 0; y < H; y++){
    const base = rowOffset[y];
    const rShift = Math.round(base - splitPx);
    const gShift = Math.round(base);
    const bShift = Math.round(base + splitPx);

    for(let x = 0; x < W; x++){
      const dst = (y * W + x) * 4;

      // R channel: sample from x-rShift
      const rxSrc = x - rShift;
      if(rxSrc >= 0 && rxSrc < W){
        const si = (y * W + rxSrc) * 4;
        rData[dst]   = src[si];   // R
        rData[dst+1] = 0;
        rData[dst+2] = 0;
        rData[dst+3] = 255;
      }
      // G channel: sample from x-gShift
      const gxSrc = x - gShift;
      if(gxSrc >= 0 && gxSrc < W){
        const si = (y * W + gxSrc) * 4;
        gData[dst]   = 0;
        gData[dst+1] = src[si+1]; // G
        gData[dst+2] = 0;
        gData[dst+3] = 255;
      }
      // B channel: sample from x-bShift
      const bxSrc = x - bShift;
      if(bxSrc >= 0 && bxSrc < W){
        const si = (y * W + bxSrc) * 4;
        bData[dst]   = 0;
        bData[dst+1] = 0;
        bData[dst+2] = src[si+2]; // B
        bData[dst+3] = 255;
      }
    }
  }

  chanRCtx.putImageData(new ImageData(rData, W, H), 0, 0);
  chanGCtx.putImageData(new ImageData(gData, W, H), 0, 0);
  chanBCtx.putImageData(new ImageData(bData, W, H), 0, 0);

  // Composite R+G+B with 'lighter' (additive) blend to reconstruct colour.
  octx.save();
  octx.globalCompositeOperation = 'source-over';
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, W, H);
  octx.globalCompositeOperation = 'lighter';
  octx.drawImage(chanR, 0, 0);
  octx.drawImage(chanG, 0, 0);
  octx.drawImage(chanB, 0, 0);
  octx.restore();
}

// ---------- paint ----------
function paint(){
  window.WAGUI?.flashValues(params);
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
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  const imgW = outBuf.width, imgH = outBuf.height;
  const aspect = imgW / imgH;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;

  // Contrast boost: at intensity=0 contrast is normal; at 100 it's 200%.
  // This punches the corruption look — blown-out edges, crushed shadows.
  const intensity = clamp(params.intensity * paintOpts.intensityScale, 0, 100);
  const contrastPct = Math.round(100 + intensity * 1.2);

  ctx.save();
  ctx.filter = `contrast(${contrastPct}%)`;
  ctx.imageSmoothingEnabled = false;  // sharp pixels, no anti-alias blur
  ctx.drawImage(outBuf, ox, oy, dw, dh);
  ctx.restore();

  ctx.restore();
}

// ---------- animation modes ----------
//
// Each mode returns a restore() closure so we can mutate paintOpts transiently
// inside renderAt() and roll back after paint() — the GUI sliders always show
// the user's static values.

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;

  if(mode === 'burst'){
    // Quiet baseline with random sharp spikes.
    // We model it as: every 2.5s (relative to cycle) a spike fires.
    // t01 in [0,1) over cycleMs. We cut the cycle into ~6 burst slots.
    const slots = 6;
    const slot  = (t01 * slots) % 1;          // 0..1 within the slot
    const phase = Math.floor(t01 * slots);
    // Per-slot RNG so each slot is independently spiked or quiet.
    const slotRng = mulberry32((params.seed * 37 + phase) >>> 0);
    const doSpike = slotRng() > 0.5;           // ~50% of slots spike
    let iScale = 0.08;                         // quiet baseline
    if(doSpike){
      // Spike: ramp up in first 15%, hold 15–60%, decay 60–100%.
      if(slot < 0.15)       iScale = slot / 0.15;
      else if(slot < 0.60)  iScale = 1.0;
      else                  iScale = 1.0 - (slot - 0.60) / 0.40;
    }
    const csScale = doSpike ? (0.2 + iScale * 0.8) : 0.15;
    const baseIS = paintOpts.intensityScale;
    const baseCS = paintOpts.colorSplitScale;
    paintOpts.intensityScale  = iScale;
    paintOpts.colorSplitScale = csScale;
    return () => {
      paintOpts.intensityScale  = baseIS;
      paintOpts.colorSplitScale = baseCS;
    };
  }

  if(mode === 'drift'){
    // Slow sinusoidal drift — intensity and colorSplit oscillate softly.
    const iScale = 0.15 + 0.55 * pingPong(t01);   // 0.15 ↔ 0.70
    const csScale = 0.1 + 0.6 * pingPong(t01 + 0.25); // phase-shifted
    const baseIS = paintOpts.intensityScale;
    const baseCS = paintOpts.colorSplitScale;
    paintOpts.intensityScale  = iScale;
    paintOpts.colorSplitScale = csScale;
    return () => {
      paintOpts.intensityScale  = baseIS;
      paintOpts.colorSplitScale = baseCS;
    };
  }

  if(mode === 'storm'){
    // Rapid chaotic: full displacement at all times, frame seed changes fast.
    // intensityScale close to 1 always; colorSplit also full.
    const noise = 0.7 + 0.3 * Math.sin(t01 * Math.PI * 23.7);
    const baseIS = paintOpts.intensityScale;
    const baseCS = paintOpts.colorSplitScale;
    paintOpts.intensityScale  = noise;
    paintOpts.colorSplitScale = 0.5 + 0.5 * Math.cos(t01 * Math.PI * 17.3);
    return () => {
      paintOpts.intensityScale  = baseIS;
      paintOpts.colorSplitScale = baseCS;
    };
  }

  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r  = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseI  = params.intensity;
  const baseCS = params.colorSplit;
  // X → intensity full range; Y → colorSplit full range.
  params.intensity   = ax * 100;
  params.colorSplit  = ay * 100;
  return () => {
    params.intensity   = baseI;
    params.colorSplit  = baseCS;
  };
}

// ---------- renderAt ----------
function renderAt(t01){
  // Evolve the per-frame time offset so the displacement map advances.
  // speed multiplier controls how fast the glitch moves.
  frameTime = t01 * params.speed;

  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  buildOutput();
  paint();
  restoreInt();
  restoreMode();
}

// ---------- animation loop ----------
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

// ---------- input events ----------
function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  hasMouse = true;
  if(params.interactive && !params.animate) renderAt(frameTime / params.speed);
}

function handleMouseLeave(){
  hasMouse = false;
  if(!params.animate) schedule('build');
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else { buildOutput(); paint(); }
    return cv;
  },
};

// ---------- param routing ----------
const PRE_KEYS   = new Set(['canvasSize','fit','bg']);
const BUILD_KEYS = new Set(['intensity','scanLines','tears','colorSplit','seed']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else {
        stopAnimation();
        paintOpts.intensityScale  = 1;
        paintOpts.colorSplitScale = 1;
        schedule('build');
      }
      return;
    }
    if(key === 'mode'){
      if(!params.animate) schedule('build');
      return;
    }
    if(key === 'interactive'){
      if(!params.animate) schedule('build');
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
  cv.addEventListener('mouseleave', handleMouseLeave);

  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }

  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-glitch-scan',
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
