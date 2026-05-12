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
  // ---- Refinement pass (2026-05-13) ----
  // mode picks the animation envelope. Each mode is a distinct envelope
  // (cosine / sawtooth / step) over a different parameter subset. `idle`
  // = the static-frame contract. `breath` preserves the original behaviour.
  mode:              'breath',
  // kernel family — different operators give different edge crispness profiles.
  //   sobel   = original (smooth magnitudes, the bundle's choice).
  //   scharr  = better rotational symmetry (Scharr 2000); crisper diagonals.
  //   prewitt = box-filter cousin, blockier feel — useful for poster looks.
  kernelFamily:      'sobel',
  // afterimage halo — paints the COMPLEMENTARY colour at low opacity just
  // outside each dot. Exploits opponent-process retinal after-images
  // (Hering, 1878). Reads as a soft glow on still frames; in motion it
  // creates an illusory contour the eye traces between adjacent dots.
  haloStrength:      0.25,
  // Cursor focus radius (interactive mode). Inside the circle, local
  // threshold drops by half the sweep depth, so detail blooms under the
  // pointer. Peripheral motion is more visible than central motion
  // (Carrasco 2011), so a soft falloff reads as natural "looking at".
  focusRadius:       240,
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
// Kernel weight tables. Each entry is [w00,w10,w20,w01,w21,w02,w12,w22] in row-major
// order excluding the centre (Gx/Gy never use it). Scharr (2000) is the
// rotationally-symmetric optimum; Prewitt is the unweighted box-cousin.
const KERNELS = {
  sobel:   { gx:[-1, 0, 1, -2,  2, -1, 0, 1], gy:[-1, -2, -1,  0,  0,  1, 2, 1] },
  scharr:  { gx:[-3, 0, 3,-10, 10, -3, 0, 3], gy:[-3,-10, -3,  0,  0,  3,10, 3] },
  prewitt: { gx:[-1, 0, 1, -1,  1, -1, 0, 1], gy:[-1, -1, -1,  0,  0,  1, 1, 1] },
};

// Optional per-cell threshold override for cursor-focus (interactive mode).
// We compute it once per build, in source-space coords, so the inner loop
// stays branchless.
let _focusCx = -1, _focusCy = -1, _focusR2 = 0, _focusDelta = 0;

function buildRects(){
  if(!preprocessed){ rectCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const step = Math.max(1, params.stepSize | 0);
  const th   = params.lightnessThreshold;
  const minD = params.minDotSize;
  const maxD = params.maxDotSize;
  const denom = Math.max(0.0001, 255 - th);
  const K = KERNELS[params.kernelFamily] || KERNELS.sobel;
  const useFocus = _focusR2 > 0;

  // Worst case: one rect per grid cell. 3 floats per rect.
  const cap = Math.ceil(W / step) * Math.ceil(H / step);
  if(!rects || rects.length < cap * 3) rects = new Float32Array(cap * 3);
  let n = 0;
  // Sobel kernels are baked into the inner loop (unrolled 3×3).
  // _stepPhasePx shifts the grid origin for `march` mode (sawtooth wave).
  const ph = _stepPhasePx % step;
  for(let y = -ph; y < H; y += step){
    if(y < 0) continue;
    for(let x = -ph; x < W; x += step){
      if(x < 0) continue;
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
      const gx = K.gx[0]*v00 + K.gx[1]*v10 + K.gx[2]*v20
              +  K.gx[3]*v01 +              K.gx[4]*v21
              +  K.gx[5]*v02 + K.gx[6]*v12 + K.gx[7]*v22;
      const gy = K.gy[0]*v00 + K.gy[1]*v10 + K.gy[2]*v20
              +  K.gy[3]*v01 +              K.gy[4]*v21
              +  K.gy[5]*v02 + K.gy[6]*v12 + K.gy[7]*v22;
      // Dazzle: zero out one axis. V1 orientation-selective cells fire only
      // on the live axis, so the field appears to flicker between vertical-
      // and horizontal-only edges without a luminance change.
      let gxe = gx, gye = gy;
      if(_axisMask === 1) gye = 0;
      else if(_axisMask === 2) gxe = 0;
      const mag = Math.sqrt(gxe * gxe + gye * gye);
      // Per-cell threshold: drops near cursor in interactive mode. Inside
      // the focus circle, local threshold = th - focusDelta. Falloff is
      // a quadratic-ish bump (1 - r²/R²) clipped at 0, which approximates
      // a Gaussian cheaply and reads as a soft attentional spotlight.
      let localTh = th;
      if(useFocus){
        const dx = x - _focusCx, dy = y - _focusCy;
        const d2 = dx*dx + dy*dy;
        if(d2 < _focusR2){
          const k = 1 - d2 / _focusR2;
          localTh = th - _focusDelta * k;
        }
      }
      if(mag > localTh){
        const ldenom = Math.max(0.0001, 255 - localTh);
        let s = minD + (maxD - minD) * ((mag - localTh) / ldenom);
        if(s < minD) s = minD;
        if(s > maxD) s = maxD;
        if(s !== 0){
          const o = n * 3;
          rects[o]   = x;
          rects[o+1] = y;
          rects[o+2] = s * _dotBoost; // pulse mode swells dots cosine-paced
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

  // roundRect is in every modern canvas now; fall back to plain rect if not.
  const hasRR = typeof ctx.roundRect === 'function';
  const cr = Math.max(0, params.cornerRadius) * scale;

  // Optional after-image halo. Hering's opponent-process theory: the retina
  // produces a complement after stimulus. Painting the complementary hue
  // under each dot at low alpha approximates the perceived halo and pushes
  // illusory contours between sparse dots — Kanizsa-style filling-in.
  const halo = clamp(params.haloStrength, 0, 1);
  if(halo > 0){
    const comp = complementColor(params.edgeColor);
    ctx.globalAlpha = halo * 0.45;
    ctx.fillStyle = comp;
    for(let k = 0; k < rectCount; k++){
      const o = k * 3;
      const x = ox + rects[o] * scale;
      const y = oy + rects[o+1] * scale;
      const s = rects[o+2] * scale;
      const pad = Math.max(2, s * 0.6);
      ctx.fillRect(x - pad, y - pad, s + pad * 2, s + pad * 2);
    }
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = params.edgeColor;
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

// Opponent-complement for a hex colour. RGB inversion is the cheap
// approximation; for true Hering opponency you'd round-trip through Lab,
// but the eye fills in plenty on its own at low alpha.
function complementColor(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if(!m) return '#000000';
  const v = parseInt(m[1], 16);
  const r = 255 - ((v >> 16) & 255);
  const g = 255 - ((v >>  8) & 255);
  const b = 255 - ( v        & 255);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
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

// Envelopes — every one returns to its t=0 value at t=1 to preserve byte-
// equal export. Wrap t to [0,1) first so cos(2π·t)==cos(0)==1 in IEEE-754.
//
// breath  — cosine sweep on threshold (original). Calm, foveal.
// rotate  — kernel orientation steps quarter-turn each beat. Peripheral motion
//           cue without changing geometry; reads as "the light moved".
// pulse   — dot-size cosine, threshold static. Mach-band glow with halo.
// march   — sawtooth on step phase: cells appear/disappear in a wave. The
//           illusory-motion classic (marching-ants without literal ants).
// dazzle  — gates Gx-only vs Gy-only on a step function. WWI-dazzle stripe
//           rules: orientation-selective V1 cells fire on whichever axis is
//           live, producing perceptual flicker without luminance change.
// idle    — no-op. Rest frame is the artwork.
function envelopeT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  return w; // [0,1)
}

function applyAnimationT(tLoop){
  const t01 = envelopeT(tLoop);
  const pp  = (1 - Math.cos(t01 * 2 * Math.PI)) / 2; // pingpong, peaks at 0.5
  const base = params.lightnessThreshold;
  const sweep = params.thresholdSweep;
  let threshold = base;
  let kernelFamily = params.kernelFamily;
  let dotBoost = 1;
  let gxOnly = false, gyOnly = false;
  let stepPhase = 0;
  switch(params.mode){
    case 'rotate': {
      // Rotate the kernel a quarter-turn per beat by aliasing through the
      // three families (sobel/scharr/prewitt). Crispness pulses, but each
      // step is the SAME at t=0 and t=1 (step 0 == step 4).
      const beat = Math.floor(t01 * 4) % 4;
      kernelFamily = ['sobel', 'scharr', 'sobel', 'prewitt'][beat];
      threshold = clamp(base - sweep * 0.3 * pp, 0, 255);
      break;
    }
    case 'pulse': {
      // Dot-size pulses; threshold lower mid-cycle so the field swells then
      // contracts. With halo on, the swell carries a complement glow.
      dotBoost = 1 + 0.6 * pp;
      threshold = clamp(base - sweep * 0.5 * pp, 0, 255);
      break;
    }
    case 'march': {
      // Phase the grid: shift the start of the sparse Sobel scan by
      // (stepSize · sawtooth). Cells alternate visible/invisible in a wave.
      // Sawtooth wraps cleanly at t=1.
      stepPhase = t01; // 0→1 sweep, wraps
      threshold = clamp(base - sweep * 0.4 * pp, 0, 255);
      break;
    }
    case 'dazzle': {
      // Step gate on Gx-only / Gy-only. Two states meeting at t=0 and t=1
      // are the same — a step function on (t01 < 0.5) is byte-equal if we
      // route t==0 to the "both" state at exactly the loop seam. We do that
      // implicitly: gx/gy applied at t01==0 is identical to the unmodified
      // pingpong default, so the seam matches.
      const phase = (t01 + 0.0001) % 1; // tiny offset so seam = full mode
      gxOnly = phase >= 0.0 && phase < 0.5;
      gyOnly = phase >= 0.5 && phase < 1.0;
      // Override at exact seam to "full" so t=0 and t=1 match.
      if(t01 === 0){ gxOnly = false; gyOnly = false; }
      threshold = base;
      break;
    }
    case 'idle': {
      threshold = base; // no animation
      break;
    }
    case 'breath':
    default: {
      threshold = clamp(base - sweep * pp, 0, 255);
      break;
    }
  }
  return { threshold, kernelFamily, dotBoost, gxOnly, gyOnly, stepPhase };
}

// Transient axis-mask for dazzle mode. Read by buildRects via globals.
let _axisMask = 0; // 0=both, 1=gxOnly, 2=gyOnly
let _stepPhasePx = 0; // marching-grid offset in source-space pixels
let _dotBoost = 1;

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  const rest = params.lightnessThreshold;
  const restKernel = params.kernelFamily;
  params.lightnessThreshold = anim.threshold;
  params.kernelFamily = anim.kernelFamily;
  _axisMask = anim.gxOnly ? 1 : anim.gyOnly ? 2 : 0;
  _stepPhasePx = Math.floor(anim.stepPhase * Math.max(1, params.stepSize | 0));
  _dotBoost = anim.dotBoost;

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
  params.kernelFamily = restKernel;
  _axisMask = 0; _stepPhasePx = 0; _dotBoost = 1;
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
const BUILD_KEYS = new Set(['lightnessThreshold','minDotSize','maxDotSize','stepSize','kernelFamily']);
const PAINT_KEYS = new Set(['cornerRadius','edgeColor','showEffect','haloStrength']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive){
    // Cursor as a soft focus circle. Inside `focusRadius` the local
    // threshold drops; outside the field stays at slider value. We map
    // viewport-space cursor to source-space (Sobel grid) so the focus
    // stays accurate across canvas sizes.
    if(!preprocessed){ return; }
    const sw = preprocessed.width, sh = preprocessed.height;
    const aspect = sw / sh;
    const W = cv.width, H = cv.height;
    let dw, dh;
    if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
    else              { dw = W * 0.96; dh = dw / aspect; }
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    const sx = (mouseX * (W / r.width)  - ox) / dw * sw;
    const sy = (mouseY * (H / r.height) - oy) / dh * sh;
    // Radius scales from screen px → source px by the same ratio.
    const rSrc = params.focusRadius * sw / dw;
    _focusCx = sx; _focusCy = sy; _focusR2 = rSrc * rSrc;
    _focusDelta = params.thresholdSweep * 0.7;
    schedule('build');
  } else if(_focusR2 !== 0){
    _focusR2 = 0; _focusDelta = 0;
    schedule('build');
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
    if(key === 'mode'){ /* anim envelope changes; no static rebuild needed */ return; }
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
