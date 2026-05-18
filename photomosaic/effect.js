// pixart/photomosaic — self-referential photomosaic.
//
// Recreates the source image as a grid of small tiles. Each tile shows a
// zoomed, hue-shifted crop of the source image tinted to match the average
// colour of the source region it covers. The result reads as the classic
// photomosaic art style — an image built of tiny copies of itself.
//
// Pipeline: preprocess() → buildOutput() → paint()
//   preprocess — scales source to canvasSize × canvasSize ImageData.
//   buildOutput — computes per-tile average colour + selects random crop
//                 coordinates for each tile. Packed into a typed array.
//   paint — draws gap + jitter + blend layers onto the output canvas.
//
// Modes (cosine envelope across cycleMs=20000):
//   assemble — tiles fly in from random off-screen positions and snap to place.
//              Progress drives an eased t ∈ [0,1] per tile staggered by index.
//   shimmer  — per-tile brightness/saturation oscillates with spatial phase offset.
//              Paint-time only (no rebuild needed).
//   dissolve — tileSize oscillates between 8 and 60 (fine → coarse → fine).
//              Requires rebuild each frame.
//
// Interactive: cursor X → tileSize (8..80), cursor Y → blend (0..100).
//
// WAEffect contract: { cycleMs, renderAt(t_loop), pauseRender(), resumeRender() }
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Off-screen source buffer — resized to canvasSize.
const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

// Off-screen tile-drawing buffer — used to render one tile at a time with
// canvas filter (hue-rotate + brightness) before blitting to main canvas.
const tileBuf = document.createElement('canvas');
const tctx    = tileBuf.getContext('2d');

const params = {
  canvasSize:  600,
  tileSize:    24,
  gap:         1,
  blend:       65,
  overlap:     20,
  jitter:      3,
  animate:     false,
  mode:        'shimmer',
  interactive: false,
  showEffect:  true,
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;   // ImageData at canvasSize × canvasSize
let tileData = null;       // Float32Array — per-tile packed data
let tileCount = 0;
let _builtForSize = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// --- PRNG (mulberry32) ---
function mulberry32(seed){
  return function(){
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }
function easeOut3(t){ return 1 - (1 - t) * (1 - t) * (1 - t); }
function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function schedule(level){
  if(level === 'pre')   dirty.pre = true;
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

// ─── Stage 1: preprocess ──────────────────────────────────────────────────────
function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = params.canvasSize;
  const H = Math.max(1, Math.round(W * aspect));
  if(srcBuf.width !== W || srcBuf.height !== H){ srcBuf.width = W; srcBuf.height = H; }
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  preprocessed = sctx.getImageData(0, 0, W, H);
}

// ─── Stage 2: buildOutput ─────────────────────────────────────────────────────
// Per-tile layout (19 floats each):
//   [0]  cx        — tile centre x (source coords)
//   [1]  cy        — tile centre y
//   [2]  x0,y0     — tile top-left (source)
//   [4]  tW,tH     — tile dimensions (may be partial at edges)
//   [6]  avgR,avgG,avgB  — average colour of source region
//   [9]  cropX,cropY    — random crop start inside source (for tile thumbnail)
//   [11] cropW,cropH    — crop dimensions (= tileSize × tileSize clamped)
//   [13] jitX,jitY      — stable per-tile jitter offset
//   [15] assembleOX,OY  — random off-screen start offset for assemble mode
//   [17] shimPhase       — per-tile shimmer phase [0..2π]
//   [18] shimAmp         — per-tile shimmer amplitude [0.1..0.35]
function buildOutput(){
  if(!preprocessed){ tileCount = 0; return; }
  const W  = preprocessed.width, H = preprocessed.height;
  const px = preprocessed.data;
  const cs = Math.max(4, params.tileSize | 0);
  const cols = Math.ceil(W / cs);
  const rows = Math.ceil(H / cs);
  const cap  = cols * rows;

  const STRIDE = 19;
  if(!tileData || tileData.length < cap * STRIDE) tileData = new Float32Array(cap * STRIDE);

  // Seed from tileSize so crops stay stable across blend/gap tweaks.
  const rng = mulberry32(cs * 6364136223846793 | 0);
  // Secondary rng for per-tile shimmer phase.
  const rng2 = mulberry32((cs ^ 0xdeadbeef) | 0);

  let n = 0;
  for(let j = 0; j < rows; j++){
    for(let i = 0; i < cols; i++){
      const x0 = i * cs, y0 = j * cs;
      const x1 = Math.min(W, x0 + cs), y1 = Math.min(H, y0 + cs);
      const tW  = x1 - x0, tH  = y1 - y0;
      const cx  = (x0 + x1) / 2, cy = (y0 + y1) / 2;

      // Average colour (sampled on a stride grid).
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      const step = Math.max(1, (cs / 6) | 0);
      for(let y = y0; y < y1; y += step){
        for(let x = x0; x < x1; x += step){
          const o = (x + y * W) * 4;
          rSum += px[o]; gSum += px[o+1]; bSum += px[o+2];
          count++;
        }
      }
      const avgR = count ? rSum / count : 0;
      const avgG = count ? gSum / count : 0;
      const avgB = count ? bSum / count : 0;

      // Random crop from source (same size as tile, clamped to source bounds).
      const cropW = Math.min(cs, W);
      const cropH = Math.min(cs, H);
      const cropX = Math.floor(rng() * (W - cropW + 1));
      const cropY = Math.floor(rng() * (H - cropH + 1));

      // Stable per-tile jitter (off-pixel, sub-tile).
      // Stored as fraction of tileSize; applied at paint time.
      const jitFracX = rng() - 0.5;   // [-0.5 .. 0.5]
      const jitFracY = rng() - 0.5;

      // Assemble: each tile flies in from a random off-canvas direction.
      const angle = rng() * Math.PI * 2;
      const dist  = 600 + rng() * 400;
      const asmOX = Math.cos(angle) * dist;
      const asmOY = Math.sin(angle) * dist;

      // Shimmer phase + amplitude.
      const shimPhase = rng2() * Math.PI * 2;
      const shimAmp   = 0.1 + rng2() * 0.25;

      const o = n * STRIDE;
      tileData[o+0]  = cx;
      tileData[o+1]  = cy;
      tileData[o+2]  = x0;
      tileData[o+3]  = y0;
      tileData[o+4]  = tW;
      tileData[o+5]  = tH;
      tileData[o+6]  = avgR;
      tileData[o+7]  = avgG;
      tileData[o+8]  = avgB;
      tileData[o+9]  = cropX;
      tileData[o+10] = cropY;
      tileData[o+11] = cropW;
      tileData[o+12] = cropH;
      tileData[o+13] = jitFracX;
      tileData[o+14] = jitFracY;
      tileData[o+15] = asmOX;
      tileData[o+16] = asmOY;
      tileData[o+17] = shimPhase;
      tileData[o+18] = shimAmp;
      n++;
    }
  }
  tileCount = n;
  _builtForSize = cs;
}

// ─── Stage 3: paint ───────────────────────────────────────────────────────────
// Animation state written by applyMode() before paint().
let _assembleT  = 1;    // 1 = fully assembled; 0 = all tiles off-screen
let _shimmerT   = 0;    // 0 = no shimmer; drives sin wave across tiles
let _tileOverride = 0;  // 0 = use params.tileSize; > 0 = override (dissolve mode)

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
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  if(tileCount === 0){ ctx.restore(); return; }

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  const fitScale = dw / sw;
  const ox = (W - dw) / 2;
  const oy = (H - dh) / 2;

  const gap     = Math.max(0, params.gap)  * fitScale;
  const blend01 = clamp(params.blend, 0, 100) / 100;
  const jitPx   = params.jitter * fitScale;
  const overlap  = clamp(params.overlap, 0, 100) / 100;

  const STRIDE = 19;

  // Pre-size tile buffer to the largest tile we'll draw.
  // We compute the effective tileSize used this frame.
  const cs = _tileOverride > 0 ? _tileOverride : (params.tileSize | 0);

  for(let k = 0; k < tileCount; k++){
    const o = k * STRIDE;
    const cx    = tileData[o+0];
    const cy    = tileData[o+1];
    const x0    = tileData[o+2];
    const y0    = tileData[o+3];
    const tW    = tileData[o+4];
    const tH    = tileData[o+5];
    let   avgR  = tileData[o+6];
    let   avgG  = tileData[o+7];
    let   avgB  = tileData[o+8];
    const cropX = tileData[o+9];
    const cropY = tileData[o+10];
    const cropW = tileData[o+11];
    const cropH = tileData[o+12];
    const jitFX = tileData[o+13];
    const jitFY = tileData[o+14];
    const asmOX = tileData[o+15];
    const asmOY = tileData[o+16];
    const sPh   = tileData[o+17];
    const sAmp  = tileData[o+18];

    // Shimmer: modulate brightness.
    let brightBoost = 1;
    if(_shimmerT !== 0){
      brightBoost = 1 + Math.sin(cx * 0.02 + cy * 0.02 + sPh + _shimmerT) * sAmp;
      avgR = clamp(avgR * brightBoost, 0, 255);
      avgG = clamp(avgG * brightBoost, 0, 255);
      avgB = clamp(avgB * brightBoost, 0, 255);
    }

    // Screen-space tile top-left (with jitter + gap).
    const drawW = Math.max(1, tW  * fitScale - gap);
    const drawH = Math.max(1, tH  * fitScale - gap);
    let   dx    = ox + x0 * fitScale + gap / 2 + jitFX * jitPx;
    let   dy    = oy + y0 * fitScale + gap / 2 + jitFY * jitPx;

    // Assemble: offset by animated amount.
    if(_assembleT < 1){
      // Stagger per tile using its index fraction.
      const tFrac = k / Math.max(tileCount - 1, 1);
      const t = clamp((_assembleT - tFrac * 0.5) / 0.5, 0, 1);
      const e = easeOut3(t);
      dx += asmOX * fitScale * (1 - e);
      dy += asmOY * fitScale * (1 - e);
    }

    if(drawW < 1 || drawH < 1) continue;

    // --- Draw the tile ---
    // The tile is a composition of:
    //   A) a flat rectangle of the average colour (the "what it represents")
    //   B) a hue/brightness-adjusted crop of the source (the "tile content")
    // blend01 = 0 → pure flat colour; blend01 = 1 → pure tile-content image.

    // Layer A: flat fill (always drawn as base).
    ctx.fillStyle = `rgb(${avgR|0},${avgG|0},${avgB|0})`;
    ctx.fillRect(dx, dy, drawW, drawH);

    // Layer B: source crop, colour-shifted to match average.
    if(blend01 > 0.01){
      // Compute hue rotation and brightness factor to shift the crop toward avgRGB.
      // We'll use canvas filter: hue-rotate(Xdeg) brightness(Y).
      // This is an approximation — it doesn't do per-channel matching, but it looks great.

      // Determine target hue from avgRGB (simple RGB→hue).
      const [tH_deg] = rgbToHueDeg(avgR, avgG, avgB);
      // Crop's representative hue (from the top-left of the crop region).
      const [cH_deg] = sampleHue(cropX, cropY, cropW, cropH);
      const hueDelta = ((tH_deg - cH_deg) + 360) % 360;

      // Brightness: ratio of average luminance of target vs rough crop average.
      const tLum  = (avgR * 0.299 + avgG * 0.587 + avgB * 0.114) / 255;
      const cLum  = sampleLum(cropX, cropY, cropW, cropH);
      const bFactor = cLum > 0.01 ? clamp(tLum / cLum, 0.2, 4.0) : 1;

      // Render crop into tile buffer.
      const bW = Math.ceil(drawW), bH = Math.ceil(drawH);
      if(tileBuf.width !== bW || tileBuf.height !== bH){
        tileBuf.width = bW; tileBuf.height = bH;
      }
      tctx.clearRect(0, 0, bW, bH);
      tctx.filter = `hue-rotate(${hueDelta|0}deg) brightness(${bFactor.toFixed(3)})`;
      tctx.drawImage(srcBuf,
        cropX, cropY, cropW, cropH,   // source rect (from the resized srcBuf)
        0,     0,     bW,    bH        // dest rect (fills entire tileBuf)
      );
      tctx.filter = 'none';

      // Overlap: softly extend the tile by overlap fraction into its gap.
      const ovX = overlap * gap * 0.5;
      const ovY = overlap * gap * 0.5;

      ctx.globalAlpha = blend01;
      ctx.drawImage(tileBuf, dx - ovX, dy - ovY, bW + ovX * 2, bH + ovY * 2);
      ctx.globalAlpha = 1;
    }
  }

  ctx.restore();
}

// --- Colour helpers (operate on preprocessed data) ---

function rgbToHueDeg(r, g, b){
  const r1 = r / 255, g1 = g / 255, b1 = b / 255;
  const max = Math.max(r1, g1, b1), min = Math.min(r1, g1, b1);
  const d = max - min;
  if(d < 0.001) return [0];
  let h;
  if(max === r1)      h = ((g1 - b1) / d) % 6;
  else if(max === g1) h = (b1 - r1) / d + 2;
  else                h = (r1 - g1) / d + 4;
  h = ((h * 60) + 360) % 360;
  return [h];
}

function sampleHue(cropX, cropY, cropW, cropH){
  if(!preprocessed) return [0];
  const px = preprocessed.data;
  const W  = preprocessed.width;
  // Sample centre of crop.
  const sx = Math.min(cropX + (cropW >> 1), preprocessed.width  - 1);
  const sy = Math.min(cropY + (cropH >> 1), preprocessed.height - 1);
  const o  = (sx + sy * W) * 4;
  return rgbToHueDeg(px[o], px[o+1], px[o+2]);
}

function sampleLum(cropX, cropY, cropW, cropH){
  if(!preprocessed) return 0.5;
  const px = preprocessed.data;
  const W  = preprocessed.width;
  const H  = preprocessed.height;
  let sum = 0, count = 0;
  const step = Math.max(1, (cropW / 4) | 0);
  for(let y = cropY; y < cropY + cropH && y < H; y += step){
    for(let x = cropX; x < cropX + cropW && x < W; x += step){
      const o = (x + y * W) * 4;
      sum += px[o] * 0.299 + px[o+1] * 0.587 + px[o+2] * 0.114;
      count++;
    }
  }
  return count ? sum / count / 255 : 0.5;
}

// ─── Animation ────────────────────────────────────────────────────────────────
const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'assemble'){
    _assembleT = pingPong(t01);   // 0 → 1 → 0
    _shimmerT  = 0;
    _tileOverride = 0;
    return () => { _assembleT = 1; };
  }
  if(mode === 'shimmer'){
    _shimmerT = t01 * Math.PI * 2;
    _assembleT = 1;
    _tileOverride = 0;
    return () => { _shimmerT = 0; };
  }
  if(mode === 'dissolve'){
    const pp = pingPong(t01);
    _tileOverride = Math.max(4, Math.round(8 + pp * 52));
    _assembleT = 1; _shimmerT = 0;
    return () => { _tileOverride = 0; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseTile  = params.tileSize;
  const baseBlend = params.blend;
  params.tileSize = Math.max(4, Math.round(8 + ax * 72));
  params.blend    = Math.round(ay * 100);
  return () => { params.tileSize = baseTile; params.blend = baseBlend; };
}

function renderAt(t01){
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  const cs = _tileOverride > 0 ? _tileOverride : (params.tileSize | 0);
  if(cs !== _builtForSize) buildOutput();
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

// ─── WAEffect contract ────────────────────────────────────────────────────────
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){ if(params.animate) startAnimation(); else paint(); return cv; },
};

// ─── Dirty-flag key sets ──────────────────────────────────────────────────────
const PRE_KEYS   = new Set(['canvasSize','fit','bg']);
const BUILD_KEYS = new Set(['tileSize']);

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
  if(window.PIXSource){ window.PIXSource.onChange(() => schedule('pre')); }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-photomosaic',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec:    document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
  if(params.animate) startAnimation();
}
document.addEventListener('DOMContentLoaded', init);
