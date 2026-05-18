// pixart/superpixel — SLIC-inspired superpixel segmentation.
//
// Segments the image into irregular, content-aware patches and fills each
// with its average colour. Creates a mosaic/stained-glass look with organic
// shapes that follow image structure — distinctly different from the regular
// triangle grid of the mosaic effect.
//
// Algorithm (CPU-friendly approximation of SLIC):
//   1. Seed a grid of cluster centres, jittered randomly.
//   2. Each pixel claims the nearest seed by weighted Euclidean distance
//      in a combined spatial+LAB colour space. Compactness weight controls
//      how much shape (square) vs content (organic) matters.
//   3. Re-centre each seed at the mean position+colour of its members.
//   4. Repeat steps 2–3 for `iterations` passes.
//   5. Fill every pixel with its cluster's average colour.
//   6. Optionally draw a dark border between adjacent clusters (edge detection
//      on the label map → paint dark pixels at boundaries).
//
// Why this reads differently from mosaic:
//   - Mosaic uses a fixed triangle grid; shapes are always triangles.
//   - Superpixel patches can be any irregular polygon. With compactness=0
//     they follow colour boundaries (eyes, lips, hair all get distinct
//     clusters); with compactness=100 they shrink toward squares.
//
// Animation modes (cosine envelope, cycleMs=20000):
//   dissolve — patchSize oscillates 20 ↔ 120 (clusters form and dissolve).
//   shift    — compactness sweeps 0 ↔ 100 (organic ↔ square and back).
//   pulse    — edgeWidth breathes 0 ↔ 4 (seams appear and vanish).
//
// Interactive: X → patchSize (20..200), Y → compactness (0..100).
//
// WAEffect contract: { cycleMs: 20000, renderAt(t), pauseRender(), resumeRender() }
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (shared).
  canvasSize:   600,
  blur:         0,
  grain:        0,
  gamma:        1,
  blackPoint:   0,
  whitePoint:   255,
  // Superpixel-specific.
  patchSize:    40,        // controls seed spacing; fewer seeds = larger patches
  compactness:  30,        // 0=organic/content-aware, 100=square/uniform
  iterations:   3,         // SLIC re-centring passes
  edgeWidth:    1,         // 0=none, 1-5=dark boundary between patches
  edgeColor:    '#000000', // border colour
  showEffect:   true,
  // Animation / interactive.
  animate:      false,
  mode:         'dissolve',
  interactive:  false,
  // Shared chrome.
  fit:          'cover',
  bg:           '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;   // ImageData (canvasSize wide)
let outImg       = null;   // ImageData same size
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

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

// ---------- sRGB → CIELab (fast approximation) ----------
// Used for perceptual colour distance in the superpixel assignment step.
function rgbToLab(r, g, b){
  // Linearise (gamma ≈ 2.2, fast path).
  let rl = r / 255, gl = g / 255, bl = b / 255;
  rl = rl > 0.04045 ? Math.pow((rl + 0.055) / 1.055, 2.4) : rl / 12.92;
  gl = gl > 0.04045 ? Math.pow((gl + 0.055) / 1.055, 2.4) : gl / 12.92;
  bl = bl > 0.04045 ? Math.pow((bl + 0.055) / 1.055, 2.4) : bl / 12.92;
  // Linear RGB → XYZ (D65).
  const X = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const Y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
  const Z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041;
  // XYZ → Lab.
  const fx = f(X / 0.95047);
  const fy = f(Y / 1.00000);
  const fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function f(t){ return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }

// ---------- hex → [r,g,b] ----------
function hexToRgb(hex){
  const h = String(hex || '').replace('#', '').padEnd(6, '0');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------- superpixel segmentation ----------
//
// Returns a typed array: labels[y * W + x] = cluster index (0..K-1).
// Also returns clusterR/G/B arrays (average colour per cluster).
let _labels    = null;
let _clusterR  = null;
let _clusterG  = null;
let _clusterB  = null;

function buildSuperpixels(src, W, H, patchSize, compactness, iterations){
  const px = src.data;

  // 1. Generate seed grid with jitter.
  const step = Math.max(4, patchSize | 0);
  const rng  = mulberry32(0xDEAD1337);

  // Rough grid dimensions.
  const cols = Math.max(1, Math.ceil(W / step));
  const rows = Math.max(1, Math.ceil(H / step));
  const K    = cols * rows;

  // Cluster centre arrays: spatial (cx,cy) + colour (cl,ca,cb in Lab).
  const cx  = new Float32Array(K);
  const cy  = new Float32Array(K);
  const cl  = new Float32Array(K);
  const ca  = new Float32Array(K);
  const cb  = new Float32Array(K);

  let k = 0;
  for(let row = 0; row < rows; row++){
    for(let col = 0; col < cols; col++){
      // Jitter seeds within ±30% of step to break the grid regularity.
      const jx = (rng() - 0.5) * step * 0.6;
      const jy = (rng() - 0.5) * step * 0.6;
      const x  = clamp((col + 0.5) * step + jx, 0, W - 1) | 0;
      const y  = clamp((row + 0.5) * step + jy, 0, H - 1) | 0;
      const idx = (y * W + x) * 4;
      const [L, A, B] = rgbToLab(px[idx], px[idx+1], px[idx+2]);
      cx[k] = x; cy[k] = y; cl[k] = L; ca[k] = A; cb[k] = B;
      k++;
    }
  }

  // Compactness weight. SLIC formula: m / S where S=step, m controls balance.
  // We map the user's 0–100 param to a range that gives visually good results.
  // compactness=0 → purely colour-driven (organic).
  // compactness=100 → strongly spatial (square).
  const m = (compactness / 100) * 40 + 0.1; // 0.1..40.1

  // Label map (which cluster owns each pixel).
  if(!_labels || _labels.length !== W * H) _labels = new Int32Array(W * H);
  const labels = _labels;
  labels.fill(-1);

  // Distance map (best distance per pixel).
  const dist = new Float32Array(W * H).fill(Infinity);

  // Pre-compute Lab image for fast distance calculations.
  const labL = new Float32Array(W * H);
  const labA = new Float32Array(W * H);
  const labB = new Float32Array(W * H);
  for(let i = 0, j = 0; i < W * H; i++, j += 4){
    const [L, A, B] = rgbToLab(px[j], px[j+1], px[j+2]);
    labL[i] = L; labA[i] = A; labB[i] = B;
  }

  // SLIC iterations.
  for(let iter = 0; iter < iterations; iter++){
    dist.fill(Infinity);

    // Assignment step: each cluster searches its local 2S×2S neighbourhood.
    const S2 = step * 2;
    for(let ki = 0; ki < K; ki++){
      const ccx = cx[ki] | 0;
      const ccy = cy[ki] | 0;
      const ccl = cl[ki];
      const cca = ca[ki];
      const ccb = cb[ki];
      const x0 = Math.max(0, ccx - S2);
      const x1 = Math.min(W - 1, ccx + S2);
      const y0 = Math.max(0, ccy - S2);
      const y1 = Math.min(H - 1, ccy + S2);
      for(let py = y0; py <= y1; py++){
        const row = py * W;
        for(let px2 = x0; px2 <= x1; px2++){
          const pidx = row + px2;
          const dLab  = (labL[pidx] - ccl) ** 2 + (labA[pidx] - cca) ** 2 + (labB[pidx] - ccb) ** 2;
          const dXY   = ((px2 - ccx) / step) ** 2 + ((py - ccy) / step) ** 2;
          const d     = dLab + m * m * dXY;
          if(d < dist[pidx]){
            dist[pidx] = d;
            labels[pidx] = ki;
          }
        }
      }
    }

    // Update step: recompute cluster centres as mean of their members.
    const sumX  = new Float64Array(K);
    const sumY  = new Float64Array(K);
    const sumL  = new Float64Array(K);
    const sumA  = new Float64Array(K);
    const sumB2 = new Float64Array(K);
    const cnt   = new Int32Array(K);

    for(let py = 0, i = 0; py < H; py++){
      for(let px2 = 0; px2 < W; px2++, i++){
        const ki = labels[i];
        if(ki < 0) continue;
        sumX[ki]  += px2;
        sumY[ki]  += py;
        sumL[ki]  += labL[i];
        sumA[ki]  += labA[i];
        sumB2[ki] += labB[i];
        cnt[ki]++;
      }
    }
    for(let ki = 0; ki < K; ki++){
      if(cnt[ki] > 0){
        const n = cnt[ki];
        cx[ki] = sumX[ki] / n;
        cy[ki] = sumY[ki] / n;
        cl[ki] = sumL[ki] / n;
        ca[ki] = sumA[ki] / n;
        cb[ki] = sumB2[ki] / n;
      }
    }
  }

  // Compute average RGB colour per cluster (direct from source, not Lab).
  if(!_clusterR || _clusterR.length !== K) _clusterR = new Float32Array(K);
  if(!_clusterG || _clusterG.length !== K) _clusterG = new Float32Array(K);
  if(!_clusterB || _clusterB.length !== K) _clusterB = new Float32Array(K);
  const cntRGB = new Int32Array(K);

  _clusterR.fill(0); _clusterG.fill(0); _clusterB.fill(0);

  for(let i = 0, j = 0; i < W * H; i++, j += 4){
    const ki = labels[i];
    if(ki < 0) continue;
    _clusterR[ki] += px[j];
    _clusterG[ki] += px[j+1];
    _clusterB[ki] += px[j+2];
    cntRGB[ki]++;
  }
  for(let ki = 0; ki < K; ki++){
    if(cntRGB[ki] > 0){
      const n = cntRGB[ki];
      _clusterR[ki] /= n;
      _clusterG[ki] /= n;
      _clusterB[ki] /= n;
    }
  }

  return { labels, clusterR: _clusterR, clusterG: _clusterG, clusterB: _clusterB };
}

// ---------- build ----------
function buildOutput(){
  if(!preprocessed){ outImg = null; return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(!outImg || outImg.width !== W || outImg.height !== H){
    outImg = new ImageData(W, H);
  }

  const patchSize   = clamp(params.patchSize   | 0, 2, 400);
  const compactness = clamp(params.compactness,      0, 100);
  const iterations  = clamp(params.iterations  | 0, 1, 10);
  const edgeWidth   = clamp(params.edgeWidth   | 0, 0, 10);

  const { labels, clusterR, clusterG, clusterB } =
    buildSuperpixels(preprocessed, W, H, patchSize, compactness, iterations);

  const dst = outImg.data;

  // Fill each pixel with its cluster's average colour.
  for(let i = 0, j = 0; i < W * H; i++, j += 4){
    const ki = labels[i];
    dst[j]   = ki >= 0 ? clusterR[ki] | 0 : 0;
    dst[j+1] = ki >= 0 ? clusterG[ki] | 0 : 0;
    dst[j+2] = ki >= 0 ? clusterB[ki] | 0 : 0;
    dst[j+3] = 255;
  }

  // Optionally draw dark edges between adjacent clusters.
  if(edgeWidth > 0){
    const [er, eg, eb] = hexToRgb(params.edgeColor);
    // Simple 8-neighbour boundary detection on the label map.
    // A pixel is "on an edge" if any of its 8 neighbours has a different label.
    for(let py = 0, i = 0; py < H; py++){
      for(let px2 = 0; px2 < W; px2++, i++){
        const ki = labels[i];
        let edge = false;
        outer:
        for(let dy = -1; dy <= 1; dy++){
          for(let dx = -1; dx <= 1; dx++){
            if(!dx && !dy) continue;
            const nx = px2 + dx, ny = py + dy;
            if(nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            if(labels[ny * W + nx] !== ki){ edge = true; break outer; }
          }
        }
        if(edge){
          const j = i * 4;
          dst[j]   = er;
          dst[j+1] = eg;
          dst[j+2] = eb;
          dst[j+3] = 255;
        }
      }
    }
    // For edgeWidth > 1, dilate the edge mask inward by painting more pixels.
    // We do a second pass for each extra width unit.
    for(let w = 1; w < edgeWidth; w++){
      // Take a snapshot of the current edge pixels so we dilate correctly.
      const edgePx = new Uint8Array(W * H);
      for(let i = 0, j = 0; i < W * H; i++, j += 4){
        if(dst[j] === er && dst[j+1] === eg && dst[j+2] === eb) edgePx[i] = 1;
      }
      for(let py = 0, i = 0; py < H; py++){
        for(let px2 = 0; px2 < W; px2++, i++){
          if(edgePx[i]) continue;
          let near = false;
          outer2:
          for(let dy = -1; dy <= 1; dy++){
            for(let dx = -1; dx <= 1; dx++){
              if(!dx && !dy) continue;
              const nx = px2 + dx, ny = py + dy;
              if(nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              if(edgePx[ny * W + nx]){ near = true; break outer2; }
            }
          }
          if(near){
            const j = i * 4;
            dst[j]   = er;
            dst[j+1] = eg;
            dst[j+2] = eb;
            dst[j+3] = 255;
          }
        }
      }
    }
  }
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
  ctx.imageSmoothingEnabled = false; // superpixels look crisper without smoothing
  ctx.drawImage(tmp, ox, oy, dw, dh);
  ctx.restore();
}

// ---------- animation ----------
const CYCLE_MS = 20000;
let animationId        = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'dissolve'){
    // patchSize oscillates 20 ↔ 120; large patches form and dissolve.
    const base = params.patchSize;
    params.patchSize = 20 + 100 * pingPong(t01);
    return () => { params.patchSize = base; };
  }
  if(mode === 'shift'){
    // compactness sweeps 0 ↔ 100; organic shapes morph toward squares.
    const base = params.compactness;
    params.compactness = 100 * pingPong(t01);
    return () => { params.compactness = base; };
  }
  if(mode === 'pulse'){
    // edgeWidth breathes 0 ↔ 4; seams appear and vanish.
    const base = params.edgeWidth;
    params.edgeWidth = Math.round(4 * pingPong(t01));
    return () => { params.edgeWidth = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const basePatch  = params.patchSize;
  const baseCompact = params.compactness;
  // X: patchSize 20..200. Y: compactness 0..100.
  params.patchSize    = 20 + ax * 180;
  params.compactness  = ay * 100;
  return () => {
    params.patchSize    = basePatch;
    params.compactness  = baseCompact;
  };
}

function renderAt(t01){
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  buildOutput();
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
    else { paint(); }
    return cv;
  },
};

// Pipeline key sets.
const PRE_KEYS   = new Set(['canvasSize','blur','grain','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['patchSize','compactness','iterations','edgeWidth','edgeColor']);
const PAINT_KEYS = new Set(['showEffect']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('pre'); }
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
    if(params.animate) return; // animation loop owns canvas
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else if(PAINT_KEYS.has(key)) schedule('paint');
    else                         schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-superpixel',
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

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
