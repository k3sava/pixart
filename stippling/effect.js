// pixart/stippling — port of tooooools.app/effects/stipping.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/stipping/page-ae6102acc68fcb3e.js,
//  shared preprocessor + page defaults in /_next/static/chunks/9357-2a51c42cdfe973de.js).
//
// Algorithm: rotated halftone grid. For each cell, sample luminance under
// the cell centre and emit a vertical rectangle whose width maps darkness →
// width. NOT Weighted Voronoi Stippling (Secord 2002) — that lives in its
// own future effect. See docs/stippling-research.md for the full bundle
// excerpt and divergences.
//
// Refinement pass (2026-05-13)
// ---------------------------
// `mode` selects the animation envelope. Each mode animates ONLY the named
// param subset; the rest hold at slider value. All modes are seamless
// (byte-equal at t=0 vs t=1) — step modes pin to step-0 at t=1.
//
//   idle    — static. Rest frame is the artwork.
//   breath  — angle cosine pingpong (-sweep → +sweep → -sweep). Original.
//   spin    — angle monotonic 0→2π. Full rotation, endpoints meet at t=1.
//   moire   — two superimposed grids: xSquares pingpongs (cosine),
//             ySquares monotonic (sin → sin again). Beat between the rotated
//             grids produces a rolling interference field — same mechanism
//             Vasarely used in *Vega-Nor* (1969). Second grid is rotated by
//             `angleSweep` so the inter-grid moiré reads as continuous motion.
//   stutter — angle steps through the Ben Day CMYK angles [0°, 15°, 45°, 75°],
//             holding each for a quarter cycle. These are the actual angles
//             used in 4-colour offset printing because they minimise
//             inter-channel moiré (cf. Krawczyk halftone-screen research,
//             Bridges 2009). Stutter encodes the print-tech history.
//   march   — xSquares stepped through 4 plateau values, held a quarter each.
//             The grid coarsens then refines in plateaus, like a printer
//             dialling-in the screen ruling. Seam-pinned to step 0 at t=1.
//
// Cursor focus-radius (interactive): inside the circle, maxSquareWidth
// locally lifts — darks under the pointer bloom. Peripheral motion is more
// visible than central motion (Carrasco 2011), so a soft falloff reads as
// natural "looking at" without rebuilding the whole grid.
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
  // ---- Refinement pass (2026-05-13) ----
  mode:               'breath',
  // angleSweep doubles as:
  //   breath/spin/stutter/march/idle → primary angle amplitude (degrees).
  //   moire                          → secondary-grid angle OFFSET. The
  //                                    inter-grid rotation difference is
  //                                    what produces the moiré beat.
  angleSweep:         20,
  // densityHarmony ∈ [-1..1]. Biases min/max bar width in opposite directions
  // before each frame. Positive = bars thinner on bright AND thicker on dark
  // (high-contrast halftone). Negative = compressed grain (flat tonality).
  // Controls the macro contrast of the halftone grain.
  densityHarmony:     0,
  // Focus radius (interactive): cursor circle in which maxSquareWidth blooms.
  focusRadius:        220,
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

// Transient per-frame overrides written by applyAnimationT, consumed by
// buildDots. Kept as module globals so the inner loop stays branchless
// against `params.mode` checks.
let _angleDeg     = null;   // primary angle override (degrees)
let _angleSecDeg  = null;   // secondary grid angle for moire (degrees); null = no 2nd pass
let _xSqOverride  = null;
let _ySqOverride  = null;
let _xSqSecondary = null;   // moire: y-axis grid's xSquares (different envelope)
let _ySqSecondary = null;
let _minOverride  = null;
let _maxOverride  = null;
let _focusCx = -1, _focusCy = -1, _focusR2 = 0, _focusMaxBoost = 0;

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

// ---------- build dots ----------
//
// One grid pass. For `moire` mode we call this twice with different
// (angle, xSquares, ySquares) and append both into the same dots buffer —
// the beat between the two grids is what produces the visible interference.
function buildPass(angleDeg, xSq, ySq, startIdx){
  const W = preprocessed.width, H = preprocessed.height;
  const r = (angleDeg || 0) * Math.PI / 180;
  const cosR = Math.cos(r), sinR = Math.sin(r);
  const n = Math.abs(cosR) + Math.abs(sinR);

  xSq = Math.max(1, xSq | 0);
  ySq = Math.max(1, ySq | 0);
  const l = H / ySq / n;
  const o = W / xSq / n;
  const th    = params.lightnessThreshold;
  // densityHarmony: positive → widen the min↔max span (high-contrast grain).
  // Negative → compress it (flatter, atmospheric grain). Independent of
  // animation mode; it's a perceptual-contrast dial, not an envelope.
  const dh = clamp(params.densityHarmony, -1, 1);
  const baseMin = _minOverride != null ? _minOverride : params.minSquareWidth;
  const baseMax = _maxOverride != null ? _maxOverride : params.maxSquareWidth;
  const minW = clamp(baseMin - dh * baseMin, 0, 50);
  const maxW = clamp(baseMax + dh * baseMax, 0, 50);
  const benday = params.gridType === 'Benday';

  const i = W / 2;
  const s = H / 2;
  const u = Math.sqrt(W * W + H * H);
  const d = u / 2 + Math.max(o, l);
  const p = (l - 0.1) * 0.99;
  const c = (o - 0.1) * 0.99;

  // Buffer-capacity check. Caller (buildDots) sizes for one pass; for moire
  // we pre-size for two.
  const rowsApprox = Math.ceil((u + 2 * d) / Math.max(0.001, p)) + 2;
  const colsApprox = Math.ceil((u + 2 * d) / Math.max(0.001, c)) + 2;
  const cap = (dots.length / 5) | 0;
  const useFocus = _focusR2 > 0;

  let nDots = startIdx;
  for(let f = -d; f < u + d; f += p){
    const yOffset = benday ? ((o - 0.1) / 2) * ((Math.floor(f / p) % 2 + 2) % 2) : 0;
    for(let oo = -d; oo < u + d; oo += c){
      const uu = oo + yOffset;
      const dd = f;
      const pCanvas = i + uu * cosR - dd * sinR;
      const cCanvas = s + uu * sinR + dd * cosR;

      const lum = sampleLum(pCanvas, cCanvas);

      // Per-cell maxW boost inside focus circle: darks near the cursor bloom.
      let localMax = maxW;
      if(useFocus){
        const dx = pCanvas - _focusCx, dy = cCanvas - _focusCy;
        const d2 = dx*dx + dy*dy;
        if(d2 < _focusR2){
          const k = 1 - d2 / _focusR2;        // quadratic falloff ≈ Gaussian
          localMax = maxW + _focusMaxBoost * k;
        }
      }

      let x = (lum < th)
        ? mapRange(lum, 0, th, localMax, minW)
        : minW;
      const C = (x > 1 ? x + 0.05 : x) / n;

      if(C === 0 || l === 0) continue;

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
  return nDots;
}

function buildDots(){
  if(!preprocessed){ dotCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;

  const angleA = _angleDeg != null ? _angleDeg : params.angle;
  const xSqA   = _xSqOverride != null ? _xSqOverride : params.xSquares;
  const ySqA   = _ySqOverride != null ? _ySqOverride : params.ySquares;

  // Conservative capacity: for moire we may need 2× the single-pass count.
  // Use the smaller grid count (largest cells × smallest cells produce the
  // densest emit), so size for worst-case among both passes × 2.
  const minXSq = Math.max(1, Math.min(xSqA, _xSqSecondary ?? xSqA));
  const minYSq = Math.max(1, Math.min(ySqA, _ySqSecondary ?? ySqA));
  const r0 = (angleA || 0) * Math.PI / 180;
  const n0 = Math.abs(Math.cos(r0)) + Math.abs(Math.sin(r0));
  const lApprox = H / minYSq / n0;
  const oApprox = W / minXSq / n0;
  const u = Math.sqrt(W * W + H * H);
  const dApprox = u / 2 + Math.max(oApprox, lApprox);
  const rowsApprox = Math.ceil((u + 2 * dApprox) / Math.max(0.001, (lApprox - 0.1) * 0.99)) + 2;
  const colsApprox = Math.ceil((u + 2 * dApprox) / Math.max(0.001, (oApprox - 0.1) * 0.99)) + 2;
  const passes = _angleSecDeg != null ? 2 : 1;
  const cap = rowsApprox * colsApprox * passes;
  if(!dots || dots.length < cap * 5) dots = new Float32Array(cap * 5);

  let n = buildPass(angleA, xSqA, ySqA, 0);
  if(_angleSecDeg != null){
    const xSqB = _xSqSecondary != null ? _xSqSecondary : xSqA;
    const ySqB = _ySqSecondary != null ? _ySqSecondary : ySqA;
    n = buildPass(_angleSecDeg, xSqB, ySqB, n);
  }
  dotCount = n;
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

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  ctx.fillStyle = params.bgColor;
  ctx.fillRect(ox, oy, dw, dh);

  ctx.fillStyle = params.dotColor;
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
// All envelopes wrap to a [0,1) phase so cos(2π·t) == cos(0) in IEEE-754 at
// the seam. Step modes (`stutter`, `march`) explicitly pin t=1 to step-0 so
// renderAt(0) === renderAt(1) byte-equal.
function envelopeT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  return w;
}

// Ben Day CMYK screen angles. Real 4-colour offset uses these specific
// angles (15° apart) because the inter-screen moiré is minimised when the
// angular separation is large — Krawczyk/Bridges halftone literature.
const BENDAY_ANGLES = [0, 15, 45, 75];

function applyAnimationT(tLoop){
  const t01 = envelopeT(tLoop);
  const pp  = (1 - Math.cos(t01 * 2 * Math.PI)) / 2; // pingpong, peaks at 0.5

  // Default: every override null (= use slider values).
  let angle = null, angleSec = null;
  let xSqA = null, ySqA = null;
  let xSqB = null, ySqB = null;

  switch(params.mode){
    case 'idle':
      break;

    case 'spin':
      // Monotonic full rotation. cos/sin both return to t=0 values at t=1
      // (modulo IEEE-754 — envelopeT already collapses t=1 to t=0).
      angle = params.angle + 360 * t01;
      break;

    case 'moire': {
      // Two grids beat against each other. Grid A holds the user angle;
      // Grid B is offset by `angleSweep` so the inter-grid difference reads
      // as a rolling Moiré field (Vasarely *Vega-Nor* mechanism).
      // xSquares pingpongs (cosine) on A; ySquares does a 2π sin sweep on B.
      // Both wrap byte-equal: pp is identical at t=0/t=1, sin(2π·0)==sin(2π·1)==0.
      const xAmp = Math.max(2, Math.round(params.xSquares * 0.25));
      const yAmp = Math.max(2, Math.round(params.ySquares * 0.25));
      xSqA = Math.max(1, Math.round(params.xSquares + xAmp * (pp - 0.5) * 2));
      ySqB = Math.max(1, Math.round(params.ySquares + yAmp * Math.sin(t01 * 2 * Math.PI)));
      angle = params.angle;
      angleSec = params.angle + params.angleSweep;
      // Secondary grid uses the user's xSquares baseline (B's beat lives on Y).
      xSqB = params.xSquares;
      ySqA = params.ySquares;
      break;
    }

    case 'stutter': {
      // Step through Ben Day angles [0°, 15°, 45°, 75°], 1/4 cycle each.
      // Seam-pin: t01 === 0 → step 0 exactly (so renderAt(1) === renderAt(0)).
      const step = Math.floor(t01 * 4) % 4;
      angle = params.angle + BENDAY_ANGLES[step];
      break;
    }

    case 'march': {
      // xSquares plateaus through 4 stepped values (coarse → fine → coarse).
      // The grid ruling visibly snaps, like a press operator dialling-in
      // the screen. Seam-pinned: step at t01==0 is the same as step at t01==1.
      const base = Math.max(8, params.xSquares);
      const plateaus = [base, Math.round(base * 0.7), Math.round(base * 1.4), Math.round(base * 0.85)];
      const step = Math.floor(t01 * 4) % 4;
      xSqA = Math.max(1, plateaus[step]);
      break;
    }

    case 'breath':
    default:
      // Original behaviour: cosine pingpong on angle.
      // angle(t) = base + sweep · (2·pp - 1). Endpoints meet exactly.
      angle = params.angle + params.angleSweep * (2 * pp - 1);
      break;
  }

  return { angle, angleSec, xSqA, ySqA, xSqB, ySqB };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  _angleDeg     = anim.angle;
  _angleSecDeg  = anim.angleSec;
  _xSqOverride  = anim.xSqA;
  _ySqOverride  = anim.ySqA;
  _xSqSecondary = anim.xSqB;
  _ySqSecondary = anim.ySqB;

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

  _angleDeg = _angleSecDeg = null;
  _xSqOverride = _ySqOverride = _xSqSecondary = _ySqSecondary = null;
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
const BUILD_KEYS = new Set(['lightnessThreshold','xSquares','ySquares','minSquareWidth','maxSquareWidth','gridType','angle','densityHarmony']);
const PAINT_KEYS = new Set(['dotColor','bgColor','showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive){
    if(!preprocessed){ return; }
    // Map cursor → source-space so the focus stays accurate across resizes.
    const sw = preprocessed.width, sh = preprocessed.height;
    const aspect = sw / sh;
    const W = cv.width, H = cv.height;
    let dw, dh;
    if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
    else              { dw = W * 0.96; dh = dw / aspect; }
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    const sx = (mouseX * (W / r.width)  - ox) / dw * sw;
    const sy = (mouseY * (H / r.height) - oy) / dh * sh;
    const rSrc = params.focusRadius * sw / dw;
    _focusCx = sx; _focusCy = sy; _focusR2 = rSrc * rSrc;
    // Bloom strength: lift maxSquareWidth by 1.5× under the pointer at peak.
    _focusMaxBoost = params.maxSquareWidth * 1.5;
    schedule('build');
  } else if(_focusR2 !== 0){
    _focusR2 = 0; _focusMaxBoost = 0;
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
    if(key === 'mode'){ /* envelope-only; static frame is unaffected */ return; }
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
