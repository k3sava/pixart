// pixart/stippling — port of tooooools.app/effects/stipping.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/stipping/page-ae6102acc68fcb3e.js,
//  shared preprocessor + page defaults in /_next/static/chunks/9357-2a51c42cdfe973de.js).
//
// Note on naming: the reference URL is /effects/stipping (their typo), and
// the in-bundle effect title is "Stippling". We ship as `stippling/` (correct
// spelling) and document the algorithm faithfully.
//
// What the reference effect is:
//   - Halftone-grid stipple: a rotated grid of vertical rectangles whose
//     widths are driven by the source luminance under each cell.
//   - For each grid cell:
//       1. Compute the cell centre's location in canvas space after rotation.
//       2. Sample the preprocessed source at that point.
//       3. Compute alpha-composited luminance:
//          lum = (lerp(255, R, a) + lerp(255, G, a) + lerp(255, B, a)) / 3
//          (same channel weighting Displace/Edge use — the framework's
//           canonical luminance, distinct from cellular's (R+G+B)/3).
//       4. If lum < lightnessThreshold, the rect width is mapped from
//          [0..threshold] onto [maxSquareWidth..minSquareWidth] (darker = wider).
//          Otherwise width = minSquareWidth.
//       5. Width is divided by n = |cos r| + |sin r| (to compensate for the
//          rotation widening of the grid bounding box).
//       6. The rect is painted rotated by r, height = full cell height `l`.
//
// Bundle excerpt (beautified, page-stipping.js lines 142-204):
//
//   let r = e.radians(a.angle || 0),
//       n = Math.abs(Math.cos(r)) + Math.abs(Math.sin(r)),
//       l = t.height / a.ySquares / n,
//       o = t.width  / a.xSquares / n;
//   // ...
//   let u  = t.width  / 2,           // canvas centre x
//       s  = t.height / 2,           // canvas centre y
//       u_ = Math.sqrt(W*W + H*H),   // diagonal
//       d  = u_/2 + Math.max(o, l);  // sweep half-extent
//   let p = (l - 0.1) * 0.99,        // y-step
//       c = (o - 0.1) * 0.99;        // x-step
//   for (let f = -d; f < u_ + d; f += p) {                 // pre-rot y
//     let y = "Benday" === a.gridType
//             ? (o - 0.1) / 2 * (Math.floor(f / p) % 2)
//             : 0;                                          // row offset
//     for (let o_ = -d; o_ < u_ + d; o_ += c) {            // pre-rot x
//       let u__ = o_ + y,
//           d__ = f,
//           p__ = u + u__ * cos(r) - d__ * sin(r),         // canvas x
//           c__ = s + u__ * sin(r) + d__ * cos(r);         // canvas y
//       sample at (p__, c__) → r,g,b,a
//       let S = a/255,
//           w = (lerp(255,r,S) + lerp(255,g,S) + lerp(255,b,S)) / 3,
//           x = w < threshold
//               ? e.map(w, 0, threshold, maxSquareWidth, minSquareWidth)
//               : minSquareWidth,
//           C = (x > 1 ? x + 0.05 : x) / n,
//           v = C / 2, M = l / 2;
//       // (clipping test against bounding box, see code)
//       translate(p__, c__); rotate(r); rect(-C/2, -l/2, C, l)
//
// Bundle defaults (pageStates["/effects/stipping"], from 9357 chunk):
//   showEffect:         true
//   lightnessThreshold: 128
//   ySquares:           90
//   xSquares:           90
//   minSquareWidth:     1
//   maxSquareWidth:     4
//   gridType:           "Regular"   ("Regular" | "Benday")
//   angle:              0           (degrees, −45..45 in the UI)
// + preprocessor inheritance (canvasSize 600, blur 0, grain 0, gamma 1,
//   blackPoint 0, whitePoint 255).
//
// Algorithm classification (vs. canonical stippling):
//   This is NOT Weighted Voronoi Stippling (Secord 2002, Lloyd's relaxation
//   on luminance-weighted density), and NOT Bridson Poisson-disk sampling.
//   It's a **rotated halftone grid** — closer to traditional newspaper
//   halftone screens (Ben Day dots) than to Linde/Buzo/Gray-style point
//   distributions. The reference deliberately ships the simpler grid
//   variant; "stippling" here is used loosely.
//   We honour the bundle exactly. A true WVS port would be a separate effect.
//
// Defaults shipped (landing-frame readability on the pixart placeholder):
//   - lightnessThreshold lifted to 200 so light areas still produce visible
//     dots (the bundle's 128 produces an inverted/sparse landing on dark
//     subjects; 200 gives a recognisable, full-coverage stipple).
//   - maxSquareWidth raised to 5 (bundle: 4) — slightly fatter darks.
//   - angle defaults to 15° so the landing frame reads as "deliberately
//     rotated" without obscuring the subject.
// All other params at bundle defaults.
//
// Animation: tooooools' stipping is not animated. For pixart we sweep
// `angle` on a cosine pingpong (base − sweep → base + sweep → base − sweep)
// across the 15s loop. The grid rotation makes for a satisfying breathing
// reveal; the endpoint angle is identical at t=0 and t=1, so the loop closes
// byte-equal.
//
// Determinism: no RNG in the stipple itself; only the preprocessor's grain
// stage uses RNG, and that's mulberry32(seedFromT(tLoop)).
//
// Perf: at 1280×720, sampling cost dominates. We precompute the lumGrid
// (Float32Array, one pass over the source) and the cell loop is pure
// arithmetic + one Float32 lookup per cell. Default 90×90 grid → ~8100
// cells, but the bounding-box overshoot from rotation expands that by ~1/n,
// so worst-case ~12k cells per frame. Painting uses rotate/rect per cell;
// well under 30ms at default settings.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (shared with Displace / Edge / Cellular).
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Stippling — bundle defaults, with two lifts for striking landing frame.
  lightnessThreshold: 200,   // bundle ships 128
  ySquares:           90,
  xSquares:           90,
  minSquareWidth:     1,
  maxSquareWidth:     5,     // bundle ships 4
  gridType:           'Regular',  // 'Regular' | 'Benday'
  angle:              15,    // bundle ships 0
  // Paint.
  dotColor:           '#000000',
  bgColor:            '#f5f1ea',  // paper-cream so dots read like ink
  showEffect:         true,
  // Loop-animation amplitude (degrees swept around `angle`).
  angleSweep:         20,
  // Shared chrome.
  animate:            false,
  interactive:        false,
  fit:                'cover',
  bg:                 '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let preprocessed = null;
let lumGrid = null;          // Float32Array of alpha-composited luminance
let dots = null;             // Float32Array of [cx, cy, w, h, angle] per visible cell
let dotCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }
function mapRange(v, a, b, c, d){ return c + (d - c) * ((v - a) / (b - a)); }

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
    if(dirty.build) buildDots();
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

  // Precompute alpha-composited luminance (matches the bundle's per-cell
  // computation: lerp(255, ch, alpha)/3, NOT (R+G+B)/3).
  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    const a = px[i+3] / 255;
    lumGrid[j] = (lerp(255, px[i], a) + lerp(255, px[i+1], a) + lerp(255, px[i+2], a)) / 3;
  }
}

// Sample the precomputed luminance grid with clamp-to-edge addressing.
// Matches the bundle's pixel-fetch helper: clamp floor(x), clamp floor(y).
function sampleLum(x, y){
  const W = preprocessed.width, H = preprocessed.height;
  let xi = Math.floor(x); if(xi < 0) xi = 0; else if(xi > W - 1) xi = W - 1;
  let yi = Math.floor(y); if(yi < 0) yi = 0; else if(yi > H - 1) yi = H - 1;
  return lumGrid[xi + yi * W];
}

// ---------- build dots ----------
//
// Mirrors the bundle's `p` (the drawing closure in page-stipping.js).
// We work in *source-space* (preprocessed.width × preprocessed.height) and
// emit dots in that frame; the paint stage maps to canvas-space at draw time.
function buildDots(){
  if(!preprocessed){ dotCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const r = (params.angle || 0) * Math.PI / 180;
  const cosR = Math.cos(r), sinR = Math.sin(r);
  const n = Math.abs(cosR) + Math.abs(sinR);

  const xSq = Math.max(1, params.xSquares | 0);
  const ySq = Math.max(1, params.ySquares | 0);
  const l = H / ySq / n;        // cell height (pre-rotation, in source-space)
  const o = W / xSq / n;        // cell width  (pre-rotation, in source-space)
  const th    = params.lightnessThreshold;
  const minW  = params.minSquareWidth;
  const maxW  = params.maxSquareWidth;
  const benday = params.gridType === 'Benday';

  const i = W / 2;              // canvas centre x (bundle: u)
  const s = H / 2;              // canvas centre y (bundle: s)
  const u = Math.sqrt(W * W + H * H);     // diagonal
  const d = u / 2 + Math.max(o, l);       // sweep half-extent
  const p = (l - 0.1) * 0.99;             // y-step (pre-rot)
  const c = (o - 0.1) * 0.99;             // x-step (pre-rot)

  // Worst-case cell count: ((u+2d)/p) × ((u+2d)/c). Sized for the rotation
  // overshoot (bbox expanded by ~1/n). 5 floats per dot (cx, cy, w, h, angle).
  const rowsApprox = Math.ceil((u + 2 * d) / Math.max(0.001, p)) + 2;
  const colsApprox = Math.ceil((u + 2 * d) / Math.max(0.001, c)) + 2;
  const cap = rowsApprox * colsApprox;
  if(!dots || dots.length < cap * 5) dots = new Float32Array(cap * 5);
  let nDots = 0;

  // y row: f from -d to u+d step p. Pre-rotation cell-y coordinate, centred
  // around the canvas centre.
  for(let f = -d; f < u + d; f += p){
    const yOffset = benday ? ((o - 0.1) / 2) * ((Math.floor(f / p) % 2 + 2) % 2) : 0;
    for(let oo = -d; oo < u + d; oo += c){
      const uu = oo + yOffset;        // pre-rot dx from centre
      const dd = f;                   // pre-rot dy from centre
      const pCanvas = i + uu * cosR - dd * sinR;
      const cCanvas = s + uu * sinR + dd * cosR;

      const lum = sampleLum(pCanvas, cCanvas);
      // Map: darker than threshold → wider rect (max at lum=0); lighter → minW.
      let x = (lum < th)
        ? mapRange(lum, 0, th, maxW, minW)
        : minW;
      // Bundle quirk: rects with width > 1 get +0.05 to prevent sub-pixel gaps.
      const C = (x > 1 ? x + 0.05 : x) / n;

      if(C === 0 || l === 0) continue;

      // Bundle's bounding-box culling test (rotated bbox vs canvas rect).
      const v = C / 2, M = l / 2;
      const E = Math.abs(v * cosR) + Math.abs(M * sinR);
      const P = Math.abs(v * sinR) + Math.abs(M * cosR);
      if(!(pCanvas + E >= -v && pCanvas - E <= W + v &&
           cCanvas + P >= -M && cCanvas - P <= H + M)) continue;

      const j = nDots * 5;
      dots[j]   = pCanvas;
      dots[j+1] = cCanvas;
      dots[j+2] = C;
      dots[j+3] = l;
      dots[j+4] = r;
      nDots++;
      if(nDots >= cap) break;
    }
    if(nDots >= cap) break;
  }
  dotCount = nDots;
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

  if(!dots || dotCount === 0){ ctx.restore(); return; }

  // Map source-space → canvas-space with `contain` (square cells preserved).
  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  // Paper background under the stipple field — gives the dots a frame.
  ctx.fillStyle = params.bgColor;
  ctx.fillRect(ox, oy, dw, dh);

  ctx.fillStyle = params.dotColor;
  // Clip to the field so rotation overshoot doesn't bleed.
  ctx.beginPath();
  ctx.rect(ox, oy, dw, dh);
  ctx.clip();

  for(let k = 0; k < dotCount; k++){
    const j = k * 5;
    const cx = ox + dots[j]   * scale;
    const cy = oy + dots[j+1] * scale;
    const w  = dots[j+2] * scale;
    const h  = dots[j+3] * scale;
    const a  = dots[j+4];
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }

  ctx.restore();
}

// ---------- animation ----------
//
// 15s seamless loop: `angle` pingpongs (base - sweep) → (base + sweep) →
// (base - sweep) on a cosine pingpong. Endpoints meet because
// cos(2π·1) ≡ cos(0); we also collapse t=1 to t=0 to dodge IEEE-754 epsilon.
function pingpongT01(t){
  let w = t - Math.floor(t);
  if(w === 1) w = 0;
  return (1 - Math.cos(w * 2 * Math.PI)) / 2;
}

function applyAnimationT(tLoop){
  const t01 = pingpongT01(tLoop);
  const base = params.angle;
  // t01 in [0,1]: 0 → -sweep, 0.5 → +sweep, 1 → -sweep.
  // Use cosine direct: angle = base + sweep * (2*t01 - 1) so endpoints repeat.
  return { angle: base + params.angleSweep * (2 * t01 - 1) };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  const restAngle = params.angle;
  params.angle = anim.angle;

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
  buildDots();
  paint();

  params.angle = restAngle;
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
const BUILD_KEYS = new Set(['lightnessThreshold','xSquares','ySquares','minSquareWidth','maxSquareWidth','gridType','angle']);
const PAINT_KEYS = new Set(['dotColor','bgColor','showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    // X → angle (-45..45), Y → maxSquareWidth (1..15). Two most expressive knobs.
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    const na = Math.round(ax * 90 - 45);
    const nw = Math.max(1, Math.round((1 - ay) * 15));
    let touched = false;
    if(na !== params.angle){
      params.angle = na; touched = true;
      gui?.rows.get('angle')?._write(na);
    }
    if(nw !== params.maxSquareWidth){
      params.maxSquareWidth = nw; touched = true;
      gui?.rows.get('maxSquareWidth')?._write(nw);
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
      canvas: cv, name: 'pixart-stippling',
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
