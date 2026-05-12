// pixart/edge — port of tooooools.app/effects/edge.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/edge/page-102387afdbc0f841.js,
//  shared preprocessor + page defaults in /_next/static/chunks/9357-*.js).
//
// What the reference effect is:
//   - Sobel 3×3 edge detection (Gx and Gy kernels visible in the chunk).
//   - Operates on alpha-composited luminance: lum = (lerp(255,R,a) +
//     lerp(255,G,a) + lerp(255,B,a)) / 3 — same channel weighting the
//     Displace effect uses (the framework's canonical luminance).
//   - Magnitude = sqrt(Gx² + Gy²). If magnitude > lightnessThreshold, the
//     pixel "passes" and is rendered as a black square of size mapped from
//     [threshold..255] onto [minDotSize..maxDotSize], with cornerRadius.
//   - Walks the canvas on a stepSize grid (NOT every pixel) — Sobel is
//     evaluated only at grid centres, so the output is a stippled edge
//     field, not a continuous edge map.
//   - Output: black filled rounded squares on the canvas background.
//
// Sobel kernels from the chunk (lines 128–137 of the beautified page):
//   Gx = [[-1,0,1],[-2,0,2],[-1,0,1]]
//   Gy = [[-1,-2,-1],[0,0,0],[1,2,1]]
//
// Why this shape (and not Canny / Roberts / Prewitt):
//   - Sobel gives smoother magnitudes than Roberts (1×1 cross) so the dot-size
//     mapping varies meaningfully across the edge.
//   - It is a single pass with no NMS / hysteresis (which is what makes it
//     viable to evaluate only on a sparse grid).
//   - Prewitt would be equivalent visually but is not what the bundle ships.
//
// Defaults from the bundle's pageStates["/effects/edge"]:
//   lightnessThreshold: 255   (← reference ships "no edges" by default;
//                              we lower to 80 so first paint is striking)
//   minDotSize: 0
//   maxDotSize: 12
//   stepSize:   5
//   cornerRadius: 8
//   showEffect: true
// Preprocessor defaults inherited (canvasSize 600, blur 0, grain 0,
// gamma 1, blackPoint 0, whitePoint 255).
//
// Animation: tooooools' edge effect is not animated — there is no time
// dimension in the source. For pixart we sweep `lightnessThreshold` on a
// cosine pingpong (high → low → high) across the 15s loop. The high
// threshold endpoint reveals only the strongest edges (a sparse skeleton),
// the low endpoint floods the canvas with detail. This produces a
// "breathing reveal" that is genuinely cinematic and seamless: at t=0
// and t=1 the threshold is identical, so the loop closes byte-equal.
//
// Determinism: when grain is non-zero, the grain RNG is mulberry32 seeded
// from t_loop. Sobel itself is deterministic. Therefore
// renderAt(0) === renderAt(1) byte-equal for export.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Offscreen buffer for the preprocessed source. We sample its pixels each
// build, then draw screen-space rectangles.
const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (shared with Displace / Ascii / others).
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Edge-specific.
  lightnessThreshold: 80,   // bundle default 255 (= no edges); 80 = striking
  minDotSize:        0,
  maxDotSize:        12,
  cornerRadius:      8,
  stepSize:          5,
  edgeColor:         '#ffffff', // bundle uses fill(0) on a white-ish bg;
                                 // for our default dark bg we paint white edges.
  showEffect:        true,
  // Loop-animation amplitude (threshold sweep range around base).
  thresholdSweep:    120,
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
let preprocessed = null; // ImageData of srcBuf after pipeline
let lumGrid = null;      // Float32Array of W*H alpha-composited luminance
let rects = null;        // Float32Array: [x, y, size] per detected edge
let rectCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }
function mapRange(v, a, b, c, d){ return c + (d - c) * ((v - a) / (b - a)); }

// mulberry32 — deterministic RNG seeded per-frame for the seamless loop.
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

// ---------- preprocessor (identical to Displace; shared module) ----------
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

  // Precompute alpha-composited luminance for every pixel in one pass.
  // Sobel reads 9 luminances per grid cell, so caching pays off immediately
  // even before considering animation re-builds.
  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    const a = px[i+3] / 255;
    lumGrid[j] = (lerp(255, px[i], a) + lerp(255, px[i+1], a) + lerp(255, px[i+2], a)) / 3;
  }
}

// ---------- Sobel on a sparse grid (tooooools' edge sketch) ----------
//
// Exactly mirrors the chunk:
//   for y in 0..H step stepSize:
//     for x in 0..W step stepSize:
//       (xc, yc) = clamp to [1..W-2], [1..H-2]
//       Gx, Gy   = sum over 3x3 of lum * kernel
//       mag      = sqrt(Gx² + Gy²)
//       if mag > threshold:
//         size = clamp(map(mag, threshold..255, minDot..maxDot), minDot, maxDot)
//         if size != 0: emit rect at (x, y) of (size, size, cornerRadius)
//
// Note: emitted rect position is the *grid cell origin*, not the centre
// (matches t.rect(a, n, l, l, …) in the bundle). When we paint we'll honour
// that by drawing top-left aligned squares.
function buildRects(){
  if(!preprocessed){ rectCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const step = Math.max(1, params.stepSize | 0);
  const th   = params.lightnessThreshold;
  const minD = params.minDotSize;
  const maxD = params.maxDotSize;
  const denom = Math.max(0.0001, 255 - th);

  // Worst case: one rect per grid cell. 3 floats per rect.
  const cap = Math.ceil(W / step) * Math.ceil(H / step);
  if(!rects || rects.length < cap * 3) rects = new Float32Array(cap * 3);
  let n = 0;
  // Sobel kernels are baked into the inner loop (unrolled 3×3).
  for(let y = 0; y < H; y += step){
    for(let x = 0; x < W; x += step){
      // Clamp the kernel centre to interior so the 3×3 window stays inside
      // the buffer. The reference does the same with p5's constrain().
      const cx = x < 1 ? 1 : (x > W - 2 ? W - 2 : x);
      const cy = y < 1 ? 1 : (y > H - 2 ? H - 2 : y);
      const i00 = (cx - 1) + (cy - 1) * W;
      const i10 = cx       + (cy - 1) * W;
      const i20 = (cx + 1) + (cy - 1) * W;
      const i01 = (cx - 1) + cy       * W;
      const i21 = (cx + 1) + cy       * W;
      const i02 = (cx - 1) + (cy + 1) * W;
      const i12 = cx       + (cy + 1) * W;
      const i22 = (cx + 1) + (cy + 1) * W;
      const v00 = lumGrid[i00], v10 = lumGrid[i10], v20 = lumGrid[i20];
      const v01 = lumGrid[i01],                     v21 = lumGrid[i21];
      const v02 = lumGrid[i02], v12 = lumGrid[i12], v22 = lumGrid[i22];
      // Gx weights: -1 0 1 / -2 0 2 / -1 0 1
      const gx = (-v00 + v20) + (-2 * v01 + 2 * v21) + (-v02 + v22);
      // Gy weights: -1 -2 -1 / 0 0 0 / 1 2 1
      const gy = (-v00 - 2 * v10 - v20) + (v02 + 2 * v12 + v22);
      const mag = Math.sqrt(gx * gx + gy * gy);
      if(mag > th){
        let s = minD + (maxD - minD) * ((mag - th) / denom);
        if(s < minD) s = minD;
        if(s > maxD) s = maxD;
        if(s !== 0){
          const o = n * 3;
          rects[o]   = x;
          rects[o+1] = y;
          rects[o+2] = s;
          n++;
        }
      }
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

  // showEffect=false → preprocessor preview (matches reference bypass).
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

  // Map source-space rects into canvas space with object-fit:contain so the
  // edge field never crops and we keep parity with the reference's canvas.
  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  ctx.fillStyle = params.edgeColor;

  // roundRect is in every modern canvas now; fall back to plain rect if not.
  const hasRR = typeof ctx.roundRect === 'function';
  const cr = Math.max(0, params.cornerRadius) * scale;

  for(let k = 0; k < rectCount; k++){
    const o = k * 3;
    const x = ox + rects[o] * scale;
    const y = oy + rects[o+1] * scale;
    const s = rects[o+2] * scale;
    if(hasRR && cr > 0.5){
      ctx.beginPath();
      ctx.roundRect(x, y, s, s, Math.min(cr, s / 2));
      ctx.fill();
    } else {
      ctx.fillRect(x, y, s, s);
    }
  }

  ctx.restore();
}

// ---------- animation ----------
//
// 15s seamless loop: lightnessThreshold sweeps base+sweep → base-sweep → base+sweep
// on a cosine pingpong (so endpoints meet exactly). Pingpong via
// (1 - cos(2π·t))/2 puts the peak (low threshold = max detail) at t=0.5.
function pingpongT01(t){
  // Wrap to [0,1) so t=1 collapses to t=0 — guarantees exact byte-equal
  // endpoints (cos(2π) is not exactly cos(0) in IEEE-754, and that ε can
  // push borderline Sobel magnitudes across the threshold).
  let w = t - Math.floor(t);
  if(w === 1) w = 0;
  return (1 - Math.cos(w * 2 * Math.PI)) / 2;
}

function applyAnimationT(tLoop){
  const t01 = pingpongT01(tLoop);
  const base = params.lightnessThreshold; // user-set rest value
  // Animation reveals more detail mid-cycle. We DON'T mutate params here so
  // the GUI value stays stable; we compute a transient threshold instead.
  return { threshold: clamp(base - params.thresholdSweep * t01, 0, 255) };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  // Stash the rest value, swap in the animated threshold, restore after.
  const rest = params.lightnessThreshold;
  params.lightnessThreshold = anim.threshold;

  // Re-seed grain deterministically so endpoints match for export.
  if(params.grainAmount > 0){
    _rng = mulberry32(seedFromT(tLoop));
    preprocess();
    _rng = Math.random;
  } else if(!preprocessed){
    preprocess();
  }
  // Video sources: pull the current frame.
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    preprocess();
  }
  buildRects();
  paint();

  params.lightnessThreshold = rest;
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

// Which keys touch which pipeline stage. Threshold/dot-size keys only need
// a rebuild (Sobel run); edgeColor / showEffect / cornerRadius are paint-only.
const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['lightnessThreshold','minDotSize','maxDotSize','stepSize']);
const PAINT_KEYS = new Set(['cornerRadius','edgeColor','showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    // Mouse X drives threshold (0..255), Mouse Y drives maxDotSize (1..40).
    // These are the two most expressive edge controls; everything else stays
    // at its slider value.
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    const nt = Math.round(ax * 255);
    const nd = Math.max(1, Math.round((1 - ay) * 40));
    let touched = false;
    if(nt !== params.lightnessThreshold){
      params.lightnessThreshold = nt; touched = true;
      gui?.rows.get('lightnessThreshold')?._write(nt);
    }
    if(nd !== params.maxDotSize){
      params.maxDotSize = nd; touched = true;
      gui?.rows.get('maxDotSize')?._write(nd);
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
    if(params.animate) return; // anim loop owns the frame
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
      canvas: cv, name: 'pixart-edge',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  cv.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
}

document.addEventListener('DOMContentLoaded', init);
