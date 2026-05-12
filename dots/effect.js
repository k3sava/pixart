// pixart/dots — port of tooooools.app/effects/dots.
//
// Reverse-engineered from the minified bundle:
//   - Page chunk:   /_next/static/chunks/app/effects/dots/page-796cf0ef3ab6e76d.js
//   - Shared chunk: /_next/static/chunks/9357-2a51c42cdfe973de.js  (pageStates["/effects/dots"])
// Beautified with js-beautify; algorithm transcribed verbatim below.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE REFERENCE EFFECT IS
// ─────────────────────────────────────────────────────────────────────────────
// Dots is the **round-dot sibling of Stippling**.
//
//   Stippling (/effects/stipping): rotated grid of *bars* (vertical
//     rectangles) whose WIDTH is mapped from local luminance, height fixed
//     to cell height. Grid resolution is `xSquares × ySquares`.
//
//   Dots (/effects/dots):     rotated grid of *square dots* whose
//     BOTH SIDES (w = h = "dotSize") are mapped from local luminance, then
//     stroked with `cornerRadius` to become rounded squares — at the
//     UI-max cornerRadius=20 with dotSize≤40 the rounded square reads as a
//     circle. Grid resolution is `stepSize` pixels per cell. The dots can
//     additionally be jittered by a Perlin-noise displacement field
//     (`displacementFactor`), unlike Stippling.
//
// Algorithmic distinction in one line:
//   Stippling = halftone BARS (xSquares×ySquares mesh, varying width).
//   Dots      = halftone SQUARES (stepSize-pixel grid, varying size +
//               Perlin jitter, rounded-corner → ≈ circles).
//
// Both share: alpha-composited luminance lerp(255, ch, alpha)/3, rotation
// widening `n = |cos|+|sin|`, threshold gate (lum < threshold → larger dot),
// Benday-offset half-cell stagger, and the same preprocessor stack
// (canvasSize, blur, grain, gamma, blackPoint, whitePoint).
//
// ─────────────────────────────────────────────────────────────────────────────
// BUNDLE EXCERPT (page-dots.js lines 154-208, beautified, identifiers restored)
// ─────────────────────────────────────────────────────────────────────────────
//
//   let n = e.radians(a.angle || 0),
//       r = Math.abs(Math.cos(n)) + Math.abs(Math.sin(n));         // rot widening
//   let l = a.stepSize, o = a.stepSize;
//   let i = sqrt(W*W + H*H);                                       // diagonal
//   let s = W/2, u = H/2;                                          // canvas centre
//   let d = ceil(i/o) + 4, p = ceil(i/l) + 4;                      // cell-count
//   let f = (W % l) / 2, m = (H % o) / 2;                          // remainder-centre
//   let y = 0.5 / Math.max(1, a.displacementFactor / 50);          // noise freq
//
//   for (let i = -d; i < d; i++) {
//     let d = "Benday" === a.gridType ? l/2 * (i % 2) : 0;          // stagger
//     for (let h = -p; h < p; h++) {
//       let p = h*l + d + f - s,                                    // pre-rot dx
//           S = i*o + m - u,                                        // pre-rot dy
//           w = s + p*cos(n) - S*sin(n),                            // canvas x
//           C = u + p*sin(n) + S*cos(n),                            // canvas y
//           v = a.maxDotSize / r + a.displacementFactor;            // cull margin
//       if (w < -v || w > W+v || C < -v || C > H+v) continue;
//       let x = w, M = C;
//       if (a.displacementFactor > 0) {
//         let t = noise(w*y, C*y),
//             n = noise(w*y + 100, C*y + 100),
//             r = (t - .5) * displacementFactor * 2,
//             l = (n - .5) * displacementFactor * 2;
//         x = w + r; M = C + l;
//       }
//       let lum = sampleAlphaLum(clamp(floor(x), 0, W-1),
//                                clamp(floor(M), 0, H-1));
//       let k = (lum < threshold
//                 ? map(lum, 0, threshold, maxDotSize, minDotSize)
//                 : minDotSize) / r;
//       if (k === 0) continue;
//       push(); translate(x, M); rotate(n);
//       fill(0); noStroke();
//       rect(-k/2, -k/2, k, k, cornerRadius);
//       pop();
//     }
//   }
//
// Defaults from pageStates["/effects/dots"]:
//   showEffect: true, lightnessThreshold: 128, minDotSize: 1,
//   maxDotSize: 10, stepSize: 8, displacementFactor: 2,
//   cornerRadius: 4, gridType: "Regular", angle: 0.
// + preprocessor inheritance (canvasSize 600, blur 0, grain 0, gamma 1,
//   blackPoint 0, whitePoint 255).
//
// ─────────────────────────────────────────────────────────────────────────────
// LANDING-FRAME DEFAULTS (pixart-specific lifts; bundle parity available)
// ─────────────────────────────────────────────────────────────────────────────
//   lightnessThreshold lifted 128 → 200  (full-coverage dots on first paint)
//   maxDotSize         lifted 10  → 14   (chunkier ink-blot reading)
//   cornerRadius       lifted 4   → 12   (rounded squares read as circles)
//   angle              lifted 0   → 15   (deliberately rotated reads "designed")
//   displacementFactor kept at bundle 2  (subtle organic jitter)
//   stepSize           kept at bundle 8  (≈ 4500 cells at 600² → fast)
//
// ─────────────────────────────────────────────────────────────────────────────
// ANIMATION (15s seamless loop, byte-equal)
// ─────────────────────────────────────────────────────────────────────────────
// We rotate `angle` linearly through 0 → 360°. Because angle is reduced
// modulo 360 inside Math.cos/sin and `rotate()`, t=0 and t=1 are mathematically
// identical. To dodge IEEE-754 ε we also collapse t=1 → t=0 explicitly.
// The Perlin displacement field is sampled in *unrotated canvas space*, so
// it does not drift across frames; jitter offsets are deterministic from
// position alone (`noise(x*y, y*y)`), making the byte-equal endpoint trivial.
//
// Determinism: when grain is non-zero, the grain RNG is mulberry32 seeded
// from t_loop. The value-noise field is a fixed lookup (mulberry32-seeded
// from a constant) so noise(x,y) returns the same value across frames.
// Therefore renderAt(0) === renderAt(1) byte-equal for export.
//
// ─────────────────────────────────────────────────────────────────────────────
// PERFORMANCE
// ─────────────────────────────────────────────────────────────────────────────
// At 600×600 source, stepSize=8 → ~75×75 = 5625 cells per frame. Rotation
// overshoot multiplies cell count by ~(diag/W)² ≈ 2x → ~11k cells. Each cell
// is a viewport-cull check + (when uncullled) one Float32 lookup, one
// roundRect path. Measured <30ms / frame on 1280×720.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (shared with Displace / Stippling / Edge / etc).
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Dots — bundle defaults with landing-frame lifts.
  lightnessThreshold: 200,   // bundle 128
  minDotSize:         1,
  maxDotSize:         14,    // bundle 10
  stepSize:           8,
  displacementFactor: 2,
  cornerRadius:       12,    // bundle 4
  gridType:           'Regular',  // 'Regular' | 'Benday'
  angle:              15,    // bundle 0
  // Paint.
  dotColor:           '#000000',
  bgColor:            '#f5f1ea',  // paper-cream so dots read like ink
  showEffect:         true,
  // Loop-animation amplitude (full rotation: 360°).
  angleSweep:         360,
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
let lumGrid = null;            // Float32Array alpha-composited luminance
let dots = null;               // Float32Array [cx, cy, size] per visible dot
let dotCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

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

// ---------- deterministic value noise (replacement for p5.noise) ----------
//
// p5.noise is Perlin. We use a 256×256 value-noise grid with smoothstep
// interpolation; visually equivalent at the small displacement amplitudes
// dots ships (`displacementFactor` ≤ 20). Seeded from a constant so each
// frame's noise samples are identical → byte-equal loop.
const NOISE_GRID = 256;
const NOISE_MASK = NOISE_GRID - 1;
const noiseField = (() => {
  const rng = mulberry32(0xDEADBEEF);
  const a = new Float32Array(NOISE_GRID * NOISE_GRID);
  for(let i = 0; i < a.length; i++) a[i] = rng();
  return a;
})();
function smoothstep(t){ return t * t * (3 - 2 * t); }
function noise2D(x, y){
  // p5.noise input is in *integer pixel space* via x*y where y is the
  // frequency factor. The bundle uses noise(w*y, C*y) and noise(w*y+100, C*y+100).
  // Reduce to a normalised lattice for the value-noise lookup.
  const X = Math.floor(x), Y = Math.floor(y);
  const fx = x - X, fy = y - Y;
  const ix0 = X & NOISE_MASK, iy0 = Y & NOISE_MASK;
  const ix1 = (X + 1) & NOISE_MASK, iy1 = (Y + 1) & NOISE_MASK;
  const v00 = noiseField[ix0 + iy0 * NOISE_GRID];
  const v10 = noiseField[ix1 + iy0 * NOISE_GRID];
  const v01 = noiseField[ix0 + iy1 * NOISE_GRID];
  const v11 = noiseField[ix1 + iy1 * NOISE_GRID];
  const sx = smoothstep(fx), sy = smoothstep(fy);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
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
    if(doGamma){ r = lut[r|0]; gg = lut[gg|0]; b = lut[b|0]; }
    if(doLevels){
      r  = clamp((r  - bp) * scale, 0, 255);
      gg = clamp((gg - bp) * scale, 0, 255);
      b  = clamp((b  - bp) * scale, 0, 255);
    }
    px[i] = r; px[i+1] = gg; px[i+2] = b;
  }
  sctx.putImageData(id, 0, 0);
  preprocessed = id;

  // Precompute alpha-composited luminance (matches bundle's pixel fetch).
  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    const a = px[i+3] / 255;
    lumGrid[j] = (lerp(255, px[i], a) + lerp(255, px[i+1], a) + lerp(255, px[i+2], a)) / 3;
  }
}

function sampleLum(x, y){
  const W = preprocessed.width, H = preprocessed.height;
  let xi = Math.floor(x); if(xi < 0) xi = 0; else if(xi > W - 1) xi = W - 1;
  let yi = Math.floor(y); if(yi < 0) yi = 0; else if(yi > H - 1) yi = H - 1;
  return lumGrid[xi + yi * W];
}

// ---------- build dots (bundle transcription, source-space) ----------
function buildDots(){
  if(!preprocessed){ dotCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const ang = (params.angle || 0) * Math.PI / 180;
  const cosR = Math.cos(ang), sinR = Math.sin(ang);
  const r = Math.abs(cosR) + Math.abs(sinR);

  const step = Math.max(1, params.stepSize | 0);
  const l = step, o = step;
  const th    = params.lightnessThreshold;
  const minD  = params.minDotSize;
  const maxD  = params.maxDotSize;
  const dispF = params.displacementFactor;
  const benday = params.gridType === 'Benday';

  const i = Math.sqrt(W * W + H * H);    // diagonal
  const s = W / 2;
  const u = H / 2;
  const d = Math.ceil(i / o) + 4;
  const p = Math.ceil(i / l) + 4;
  const f = (W % l) / 2;
  const m = (H % o) / 2;
  const y = 0.5 / Math.max(1, dispF / 50);
  const v = maxD / r + dispF;            // cull margin

  // Worst-case dot count: (2d) × (2p).
  const cap = (2 * d) * (2 * p);
  if(!dots || dots.length < cap * 3) dots = new Float32Array(cap * 3);
  let n = 0;

  for(let ii = -d; ii < d; ii++){
    const bend = benday ? (l / 2) * (((ii % 2) + 2) % 2) : 0;
    for(let h = -p; h < p; h++){
      const px = h * l + bend + f - s;
      const py = ii * o + m - u;
      const wx = s + px * cosR - py * sinR;
      const wy = u + px * sinR + py * cosR;
      if(wx < -v || wx > W + v || wy < -v || wy > H + v) continue;

      let dx = wx, dy = wy;
      if(dispF > 0){
        const t1 = noise2D(wx * y, wy * y);
        const t2 = noise2D(wx * y + 100, wy * y + 100);
        dx = wx + (t1 - 0.5) * dispF * 2;
        dy = wy + (t2 - 0.5) * dispF * 2;
      }
      const lum = sampleLum(dx, dy);
      let k = (lum < th)
        ? (maxD + (minD - maxD) * (lum / Math.max(0.0001, th))) / r
        : minD / r;
      if(k <= 0) continue;

      const j = n * 3;
      dots[j]   = dx;
      dots[j+1] = dy;
      dots[j+2] = k;
      n++;
      if(n >= cap) break;
    }
    if(n >= cap) break;
  }
  dotCount = n;
  _buildAngle = ang;
}
let _buildAngle = 0;

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

  // Map source-space → canvas-space (contain).
  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  // Paper background under the dot field.
  ctx.fillStyle = params.bgColor;
  ctx.fillRect(ox, oy, dw, dh);

  ctx.beginPath();
  ctx.rect(ox, oy, dw, dh);
  ctx.clip();

  ctx.fillStyle = params.dotColor;
  const ang = _buildAngle;
  const hasRR = typeof ctx.roundRect === 'function';
  const cr = Math.max(0, params.cornerRadius) * scale;

  // Each dot is square (w = h = k) rotated by the grid angle.
  for(let kk = 0; kk < dotCount; kk++){
    const j = kk * 3;
    const cx = ox + dots[j]   * scale;
    const cy = oy + dots[j+1] * scale;
    const sz = dots[j+2] * scale;
    if(sz <= 0.25) continue;  // sub-pixel skip
    ctx.save();
    ctx.translate(cx, cy);
    if(ang) ctx.rotate(ang);
    const hs = sz / 2;
    if(hasRR && cr > 0.5){
      const rr = Math.min(cr, hs);
      ctx.beginPath();
      ctx.roundRect(-hs, -hs, sz, sz, rr);
      ctx.fill();
    } else {
      ctx.fillRect(-hs, -hs, sz, sz);
    }
    ctx.restore();
  }

  ctx.restore();
}

// ---------- animation ----------
//
// 15s loop: `angle` sweeps base → base + 360° linearly. Endpoints meet because
// rotation is modulo-360. Collapse t=1→t=0 to dodge IEEE-754 ε.
function loopT01(t){
  let w = t - Math.floor(t);
  if(w === 1) w = 0;
  return w;
}

function applyAnimationT(tLoop){
  const t01 = loopT01(tLoop);
  return { angle: params.angle + params.angleSweep * t01 };
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
const BUILD_KEYS = new Set(['lightnessThreshold','stepSize','minDotSize','maxDotSize','displacementFactor','gridType','angle']);
const PAINT_KEYS = new Set(['cornerRadius','dotColor','bgColor','showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    // X → threshold (0..255), Y → maxDotSize (1..40). Two most expressive knobs.
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
      canvas: cv, name: 'pixart-dots',
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
