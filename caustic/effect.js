// pixart/caustic — underwater caustic light patterns.
//
// Simulates the shimmering network of bright lines and pools of light that
// appear on the seafloor when sunlight refracts through moving water.
//
// Algorithm — Voronoi distance field caustic (classic GPU caustic trick):
//   1. Scatter N seed points across the canvas (N = scale param, 20–80).
//   2. For each pixel, find the distance to the nearest and second-nearest
//      seed point. The narrow band between them produces bright caustic veins.
//   3. Caustic brightness = 1 - smoothstep(0, edge_px, d1)
//      where d1 = distance to nearest seed. The gradient creates the halo.
//   4. Composite: finalPixel = sourcePixel × (1 + caustic × intensity)
//      with optional tint colour and blend factor.
//
// Three animation modes (cycleMs = 20000):
//   wave  — seeds follow Lissajous-style sine paths around their rest pos.
//           Classic underwater shimmer; seeds orbit in 2D ellipses.
//   drift — each seed does a slow Perlin-ish random walk. More organic.
//   pulse — scale and intensity breathe via cosine envelope. Caustic inhales.
//
// Static (animate=false): seeds fixed from mulberry32 PRNG; caustic baked
// in buildOutput() and cached as ImageData.
//
// Interactive: cursor X → scale (seed count 20–80), cursor Y → intensity.
//
// WAEffect contract: { cycleMs, renderAt(t01), pauseRender(), resumeRender() }
//
// Performance note: caustic is O(W × H × N). At W=H=600 and N=50 that is
// 18M distance-checks per frame; stay under N=80. The inner loop is a tight
// float pass — fast enough for 60 fps on modern hardware.

'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const CANVAS_SIZE = 600;

const params = {
  intensity:   60,    // 0–100  — strength of caustic overlay
  scale:       40,    // 5–80   — number of seed points
  edge:        55,    // 0–100  — sharpness: 0=hard bright lines, 100=soft pools
  speed:       45,    // 0–100  — animation speed
  color:       '#a8d8f0', // hex — caustic tint colour
  blend:       20,    // 0–100  — how much caustic replaces vs overlays source
  animate:     false,
  mode:        'wave',
  interactive: false,
  showEffect:  true,
  fit:         'cover',
  bg:          '#050d15',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let outImg       = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// Seed state — N × 2 arrays
let seedsX  = null;  // rest positions, [0..1]
let seedsY  = null;
let driftX  = null;  // drift velocity (drift mode)
let driftY  = null;
let driftPX = null;  // drift position offset
let driftPY = null;
let _builtScale = -1;

// ---- utilities -------------------------------------------------------

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }
function smoothstep(lo, hi, x){
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

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

function hexToRgb(hex){
  const n = parseInt(hex.replace('#',''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---- seed management -------------------------------------------------

function initSeeds(n){
  const rng = mulberry32(0xCA571C); // stable seed for deterministic layout
  seedsX = new Float32Array(n);
  seedsY = new Float32Array(n);
  driftX = new Float32Array(n);
  driftY = new Float32Array(n);
  driftPX = new Float32Array(n);
  driftPY = new Float32Array(n);
  for(let i = 0; i < n; i++){
    seedsX[i] = rng();
    seedsY[i] = rng();
    // small random drift velocity in [-1, 1] normalised
    driftX[i] = (rng() - 0.5) * 2;
    driftY[i] = (rng() - 0.5) * 2;
    driftPX[i] = 0;
    driftPY[i] = 0;
  }
  _builtScale = n;
}

// ---- caustic computation --------------------------------------------

/**
 * computeCaustic — write caustic brightness into Float32Array `out` (length W*H).
 * seeds are in normalised [0,1] coordinates, scaled to W×H internally.
 * edgePx is the smoothstep falloff distance in pixels.
 */
function computeCaustic(out, W, H, sx, sy, n, edgePx){
  const invW = 1 / W, invH = 1 / H;
  // Pre-scale seeds to pixel coords
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  for(let k = 0; k < n; k++){
    px[k] = sx[k] * W;
    py[k] = sy[k] * H;
  }
  for(let y = 0, i = 0; y < H; y++){
    const fy = y + 0.5;
    for(let x = 0; x < W; x++, i++){
      const fx = x + 0.5;
      let d1 = Infinity;
      for(let k = 0; k < n; k++){
        const dx = fx - px[k];
        const dy = fy - py[k];
        const d = Math.sqrt(dx * dx + dy * dy);
        if(d < d1) d1 = d;
      }
      // bright near each seed, falling off with smoothstep
      out[i] = 1.0 - smoothstep(0, edgePx, d1);
    }
  }
}

/**
 * applyToImage — composite caustic brightness over preprocessed pixel data.
 * intensity01: 0..1 scale of effect strength.
 * blend01: 0..1 — 0=multiply overlay, 1=replace with caustic.
 * tintR/G/B: colour to tint caustic light.
 */
function applyToImage(dst, src, caustic, W, H, intensity01, blend01, tintR, tintG, tintB){
  for(let i = 0, j = 0; i < W * H; i++, j += 4){
    const c  = caustic[i];          // 0..1
    const sr = src[j], sg = src[j+1], sb = src[j+2];

    // Caustic brightness with tint
    const cr = tintR * c;
    const cg = tintG * c;
    const cb = tintB * c;

    // Screen-like overlay: source brightened by caustic
    const or_ = sr * (1 + c * intensity01) + cr * intensity01 * blend01 * 255;
    const og  = sg * (1 + c * intensity01) + cg * intensity01 * blend01 * 255;
    const ob  = sb * (1 + c * intensity01) + cb * intensity01 * blend01 * 255;

    dst[j]   = clamp(or_, 0, 255);
    dst[j+1] = clamp(og,  0, 255);
    dst[j+2] = clamp(ob,  0, 255);
    dst[j+3] = 255;
  }
}

// ---- pipeline --------------------------------------------------------

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

function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = (window.PIXSource?.height || srcCv.height) / (window.PIXSource?.width || srcCv.width);
  const W = CANVAS_SIZE;
  const H = Math.max(1, Math.round(W * aspect));
  if(srcBuf.width !== W || srcBuf.height !== H){
    srcBuf.width = W; srcBuf.height = H;
  }
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  preprocessed = sctx.getImageData(0, 0, W, H);
}

function buildOutput(){
  if(!preprocessed){ outImg = null; return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(!outImg || outImg.width !== W || outImg.height !== H){
    outImg = new ImageData(W, H);
  }

  const n = clamp(Math.round(params.scale), 5, 80);
  if(_builtScale !== n) initSeeds(n);

  const edgePx    = lerp(2, Math.max(W, H) * 0.25, params.edge / 100);
  const intensity = params.intensity / 100;
  const blend     = params.blend / 100;
  const [tR, tG, tB] = hexToRgb(params.color);
  const tintR = tR / 255, tintG = tG / 255, tintB = tB / 255;

  const caustic = new Float32Array(W * H);
  computeCaustic(caustic, W, H, seedsX, seedsY, n, edgePx);
  applyToImage(outImg.data, preprocessed.data, caustic, W, H, intensity, blend, tintR, tintG, tintB);
}

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

// ---- animation -------------------------------------------------------

const CYCLE_MS = 20000;
let animationId        = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

/**
 * advanceSeeds — move seeds according to mode for time t01 ∈ [0, 1).
 * Returns arrays [sxOut, syOut] — either seedsX/Y or a temporary copy.
 */
function advanceSeeds(t01, mode){
  const n    = seedsX.length;
  const sp   = params.speed / 100;          // 0..1
  const sxOut = new Float32Array(n);
  const syOut = new Float32Array(n);

  if(mode === 'wave'){
    // Each seed orbits its rest position on a Lissajous ellipse.
    // Radius scales with speed; frequency offset per-seed for variety.
    const amp = 0.06 + sp * 0.14;
    const twoPi = Math.PI * 2;
    for(let i = 0; i < n; i++){
      // Unique phase offsets prevent all seeds moving in lockstep.
      const phaseX = (i * 0.618) % 1;  // golden ratio spread
      const phaseY = (i * 0.382) % 1;
      const freqX  = 1 + (i % 3) * 0.5;  // 1, 1.5, or 2 cycles/loop
      const freqY  = 1 + ((i + 1) % 3) * 0.5;
      sxOut[i] = clamp(seedsX[i] + amp * Math.sin(twoPi * (t01 * freqX + phaseX)), 0.01, 0.99);
      syOut[i] = clamp(seedsY[i] + amp * Math.cos(twoPi * (t01 * freqY + phaseY)), 0.01, 0.99);
    }
  } else if(mode === 'drift'){
    // Slow random walk. Velocity is accumulated in driftPX/Y, clamped to
    // ±0.15 from rest position. Flip direction at boundary.
    const step = sp * 0.0008;
    for(let i = 0; i < n; i++){
      driftPX[i] += driftX[i] * step;
      driftPY[i] += driftY[i] * step;
      if(Math.abs(driftPX[i]) > 0.18){ driftX[i] *= -1; driftPX[i] *= 0.98; }
      if(Math.abs(driftPY[i]) > 0.18){ driftY[i] *= -1; driftPY[i] *= 0.98; }
      sxOut[i] = clamp(seedsX[i] + driftPX[i], 0.01, 0.99);
      syOut[i] = clamp(seedsY[i] + driftPY[i], 0.01, 0.99);
    }
  } else {
    // pulse — seeds stay fixed; intensity/scale breathe
    sxOut.set(seedsX);
    syOut.set(seedsY);
  }
  return [sxOut, syOut];
}

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'pulse'){
    const baseInt   = params.intensity;
    const baseScale = params.scale;
    const pp = pingPong(t01);
    params.intensity = baseInt   * (0.35 + 0.65 * pp);
    params.scale     = Math.max(5, Math.round(baseScale * (0.5 + 0.5 * pp)));
    return () => { params.intensity = baseInt; params.scale = baseScale; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseScale = params.scale;
  const baseInt   = params.intensity;
  params.scale     = Math.round(5 + ax * 75);
  params.intensity = ay * 100;
  return () => { params.scale = baseScale; params.intensity = baseInt; };
}

function renderAt(t01){
  if(!preprocessed) return;
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();

  const W = preprocessed.width, H = preprocessed.height;
  if(!outImg || outImg.width !== W || outImg.height !== H){
    outImg = new ImageData(W, H);
  }

  const n = clamp(Math.round(params.scale), 5, 80);
  if(_builtScale !== n) initSeeds(n);

  const [sxOut, syOut] = params.animate
    ? advanceSeeds(t01, params.mode)
    : [seedsX, seedsY];

  const edgePx    = lerp(2, Math.max(W, H) * 0.25, params.edge / 100);
  const intensity = params.intensity / 100;
  const blend     = params.blend / 100;
  const [tR, tG, tB] = hexToRgb(params.color);
  const tintR = tR / 255, tintG = tG / 255, tintB = tB / 255;

  const caustic = new Float32Array(W * H);
  computeCaustic(caustic, W, H, sxOut, syOut, n, edgePx);
  applyToImage(outImg.data, preprocessed.data, caustic, W, H, intensity, blend, tintR, tintG, tintB);
  paint();

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
  if(params.interactive && !params.animate) renderAt(0);
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

// ---- param routing ---------------------------------------------------

const PRE_KEYS   = new Set(['fit', 'bg']);
const BUILD_KEYS = new Set(['intensity', 'scale', 'edge', 'color', 'blend']);

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
  cv.addEventListener('mouseleave', () => {
    hasMouse = false;
    if(!params.animate) schedule('paint');
  });

  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }

  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-caustic',
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
