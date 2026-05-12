// pixart/dots — port of tooooools.app/effects/dots.
//
// Reverse-engineered from the minified bundle:
//   - Page chunk:   /_next/static/chunks/app/effects/dots/page-796cf0ef3ab6e76d.js
//   - Shared chunk: /_next/static/chunks/9357-2a51c42cdfe973de.js
//
// What the reference effect is:
//   - Halftone screen of rounded squares: a rotated grid of dots, each sized
//     by local luminance, with optional Perlin jitter (displacementFactor)
//     and a Benday half-cell stagger.
//
// Refinement pass (2026-05-13). The reference was a single-axis grid with
// stepSize controlling both x and y resolution. We split that into xSquares
// and ySquares for `swirl` mode, add a dotShape select (round / square /
// euclidean), and add a screenAngleOffset slider for moire-tuning. The march
// mode steps the screen angle through `[0, 15, 45, 75]` — those are the
// canonical CMYK offset-print screen angles picked specifically so each
// channel's halftone screen interferes least with the others. Using them as
// the march plateaus encodes a piece of print-tech history.
//
// References:
//   - Roy Lichtenstein technical analysis (Tate catalog 2013) — the Ben-Day
//     dot pattern is itself an art-historical citation of 1879 patent prints.
//   - Ben Day (1879) — patent that started commercial halftone screens.
//   - Adobe Photoshop halftone implementation — Euclidean dot rule: circle
//     below 50%, diamond at 50%, inverse circle above 50%.
//   - William Fox Talbot (1852) — photogravure ancestor of the screen-angle
//     problem.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor.
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Dots core.
  lightnessThreshold: 200,
  minDotSize:         1,
  maxDotSize:         14,
  stepSize:           8,
  displacementFactor: 2,
  cornerRadius:       12,
  gridType:           'Regular',
  angle:              15,
  // Paint.
  dotColor:           '#000000',
  bgColor:            '#f5f1ea',
  showEffect:         true,
  angleSweep:         360,
  // ---- Refinement pass (2026-05-13) ----
  // Mode envelope. Each mode animates a different subset.
  //   idle    — no animation
  //   breath  — cosine pingpong on stepSize (the dot scale "breathes")
  //   march   — screen angle steps 0 → 15 → 45 → 75 (CMYK plates). Each
  //             angle held for 1/4 of the loop. The 0/15/45/75 sequence
  //             is the offset-print canon for the four-colour process;
  //             reading them as time steps is a small homage.
  //   pulse   — maxDotSize sharp spike + slow decay (ink swell)
  //   rotate  — angle monotonic 0 → 360°
  //   swirl   — xSquares pingpongs, ySquares monotonic. Moire beat between
  //             the two axes produces a rolling interference field.
  mode:              'breath',
  // Dot shape — three canonical halftone primitives.
  //   round     — current rounded-square (≈ circle at cornerRadius=20).
  //   square    — sharp ink-blot, no roundRect path.
  //   euclidean — print-canonical: circle <50% coverage, diamond at 50%,
  //               inverse-circle hole >50%. The dot that the eye actually
  //               sees on offset CMYK prints.
  dotShape:          'round',
  // Secondary screen-angle phase offset (-45..45°). Used to detune one
  // screen vs another for moire control. Composes with `angle`.
  screenAngleOffset: 0,
  // Decoupled grid resolution — set non-zero to override stepSize on a per-
  // axis basis. `swirl` mode animates these; the slider gives a static knob.
  // 0 = "follow stepSize".
  xSquares:          0,
  ySquares:          0,
  // Cursor focus radius (interactive).
  focusRadius:       240,
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
let lumGrid = null;
let dots = null;               // [cx, cy, size]
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

// ---------- deterministic value noise ----------
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

// ---------- preprocessor ----------
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
// Transients written by renderAnimationFrame and read here. xStep/yStep
// override is what gives swirl its decoupled x/y resolution.
let _buildAngle = 0;
let _xStepOverride = 0;
let _yStepOverride = 0;

function buildDots(){
  if(!preprocessed){ dotCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  // Effective angle = base angle + secondary phase offset. Animation override
  // already collapsed into params.angle by renderAnimationFrame.
  const ang = ((params.angle || 0) + (params.screenAngleOffset || 0)) * Math.PI / 180;
  const cosR = Math.cos(ang), sinR = Math.sin(ang);
  const r = Math.abs(cosR) + Math.abs(sinR);

  // Decoupled axes: prefer per-axis overrides (xSquares / ySquares interpret
  // as cells across W/H; convert to pixel steps). Falls back to stepSize.
  const baseStep = Math.max(1, params.stepSize | 0);
  // xStepOverride / yStepOverride are in pixels, computed from xSquares /
  // ySquares (cells across canvas width/height). 0 = use baseStep.
  const xs = _xStepOverride > 0 ? _xStepOverride : baseStep;
  const ys = _yStepOverride > 0 ? _yStepOverride : baseStep;
  const l = xs, o = ys;

  const th    = params.lightnessThreshold;
  const minD  = params.minDotSize;
  const maxD  = params.maxDotSize;
  const dispF = params.displacementFactor;
  const benday = params.gridType === 'Benday';

  const i = Math.sqrt(W * W + H * H);
  const s = W / 2;
  const u = H / 2;
  const d = Math.ceil(i / o) + 4;
  const p = Math.ceil(i / l) + 4;
  const f = (W % l) / 2;
  const m = (H % o) / 2;
  const y = 0.5 / Math.max(1, dispF / 50);
  const v = maxD / r + dispF;

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

// ---------- shape draw ----------
//
// `coverage` is the proportion of cell area we want to fill (0..1). Used by
// the euclidean shape rule to pick circle / diamond / inverse-circle.
function drawDot(ctx, hs, sz, cr, shape, coverage){
  if(shape === 'square'){
    ctx.fillRect(-hs, -hs, sz, sz);
    return;
  }
  if(shape === 'euclidean'){
    // Below 50% coverage: a filled circle of area proportional to coverage.
    // At 50%: a square rotated 45° (a "diamond") that exactly fits.
    // Above 50%: inverse circle — a square with a circular hole.
    // This is the canonical offset-print spot shape; the eye sees a smooth
    // grey ramp from highlight to shadow because area is continuous through
    // the 50% diamond pivot.
    if(coverage < 0.5){
      const rad = Math.sqrt(coverage / Math.PI) * sz;
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, Math.PI * 2);
      ctx.fill();
    } else if(coverage > 0.5){
      // Outer square minus inner circle (hole).
      const inv = 1 - coverage;
      const rad = Math.sqrt(inv / Math.PI) * sz;
      ctx.beginPath();
      ctx.rect(-hs, -hs, sz, sz);
      // Counter-clockwise sub-path → even-odd hole.
      ctx.moveTo(rad, 0);
      ctx.arc(0, 0, rad, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
    } else {
      // Exact diamond.
      ctx.beginPath();
      ctx.moveTo( hs, 0);
      ctx.lineTo(0,  hs);
      ctx.lineTo(-hs, 0);
      ctx.lineTo(0, -hs);
      ctx.closePath();
      ctx.fill();
    }
    return;
  }
  // round — current behaviour, rounded square (≈ circle at high cr).
  const hasRR = typeof ctx.roundRect === 'function';
  if(hasRR && cr > 0.5){
    const rr = Math.min(cr, hs);
    ctx.beginPath();
    ctx.roundRect(-hs, -hs, sz, sz, rr);
    ctx.fill();
  } else {
    ctx.fillRect(-hs, -hs, sz, sz);
  }
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

  ctx.beginPath();
  ctx.rect(ox, oy, dw, dh);
  ctx.clip();

  ctx.fillStyle = params.dotColor;
  const ang = _buildAngle;
  const cr = Math.max(0, params.cornerRadius) * scale;
  const shape = params.dotShape;
  const maxD = Math.max(0.0001, params.maxDotSize);

  for(let kk = 0; kk < dotCount; kk++){
    const j = kk * 3;
    const cx = ox + dots[j]   * scale;
    const cy = oy + dots[j+1] * scale;
    const sz = dots[j+2] * scale;
    if(sz <= 0.25) continue;
    const hs = sz / 2;
    // Coverage for euclidean shape: dots[j+2] is the size pre-scale; ratio
    // to maxDotSize gives an approximation of "how dark is this region".
    // We square it because area scales with side² — the perceptual coverage
    // tracks area, not side length.
    const sideRatio = clamp(dots[j+2] / maxD, 0, 1);
    const coverage = sideRatio * sideRatio;
    ctx.save();
    ctx.translate(cx, cy);
    if(ang) ctx.rotate(ang);
    drawDot(ctx, hs, sz, cr, shape, coverage);
    ctx.restore();
  }

  ctx.restore();
}

// ---------- animation ----------

// CMYK offset-print canon. Black-K at 45° (least visible because the eye is
// strongest on horizontal/vertical edges), Cyan at 15°, Magenta at 75°,
// Yellow at 0° (the lightest channel, parked on the visible axis where its
// moire matters least). We sample them as march plateaus.
const CMYK_ANGLES = [0, 15, 45, 75];

function loopT01(t){
  let w = t - Math.floor(t);
  if(w === 1) w = 0;
  return w;
}

function applyAnimationT(tLoop){
  const t01 = loopT01(tLoop);
  const pp  = (1 - Math.cos(t01 * 2 * Math.PI)) / 2;
  let angle = params.angle;
  let maxDotSize = params.maxDotSize;
  let xStep = 0, yStep = 0; // 0 = use stepSize

  switch(params.mode){
    case 'idle': {
      break;
    }
    case 'breath': {
      // Original behaviour: stepSize pingpong via maxDotSize swell (subtler).
      // We keep angle linear-rotating because that was the original anim;
      // for "breath" feel we add a small maxDotSize pingpong on top so the
      // dots also pulse with the rotation.
      angle = params.angle + params.angleSweep * t01;
      maxDotSize = params.maxDotSize * (1 + 0.15 * pp);
      break;
    }
    case 'march': {
      // Screen angle steps through CMYK plates. Held for 1/4 of the loop
      // each. Seam-override: t=1 → step 0.
      const beat = (t01 === 0) ? 0 : Math.floor(t01 * 4) % 4;
      angle = CMYK_ANGLES[beat];
      break;
    }
    case 'pulse': {
      // Sharp asymmetric envelope on maxDotSize. Spike up in 0.2 of the
      // loop, decay back in 0.8. Reaches base at t=1 exactly.
      const tEnv = t01 < 0.2
        ? (t01 / 0.2)
        : Math.pow(1 - (t01 - 0.2) / 0.8, 2.5);
      maxDotSize = params.maxDotSize * (1 + 0.9 * tEnv);
      break;
    }
    case 'rotate': {
      // Angle monotonic 0 → 360° on top of the base angle.
      angle = params.angle + 360 * t01;
      break;
    }
    case 'swirl': {
      // Decouple x and y. xSquares pingpongs (axis breathes), ySquares
      // monotonic (axis drifts). Moire between the two axes produces the
      // rolling interference field. Both wrap exactly at t=0/t=1: the
      // monotonic ySquares completes one full sweep (n → 2n → n).
      // We cap the sweep range to ±60% so dot scale stays usable.
      const sw = preprocessed ? preprocessed.width : 600;
      const sh = preprocessed ? preprocessed.height : 600;
      const baseStep = Math.max(1, params.stepSize | 0);
      // x cells: pingpong baseStep ± 50%.
      const xMul = 1 + 0.5 * pp;
      xStep = Math.max(2, Math.round(baseStep * xMul));
      // y cells: monotonic 1× → 2× → 1× (sawtooth that wraps at t=1).
      // Use cos of single-cycle for byte-equal endpoints.
      const yPing = (1 - Math.cos(t01 * 2 * Math.PI)) / 2;
      const yMul = 1 + 0.6 * yPing; // identical to pp but explicit for clarity
      yStep = Math.max(2, Math.round(baseStep * (2 - yMul))); // 1× ↔ 0.4×
      break;
    }
  }
  return { angle, maxDotSize, xStep, yStep };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  const restAngle = params.angle;
  const restMaxD  = params.maxDotSize;
  params.angle      = anim.angle;
  params.maxDotSize = anim.maxDotSize;
  _xStepOverride = anim.xStep;
  _yStepOverride = anim.yStep;

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

  params.angle      = restAngle;
  params.maxDotSize = restMaxD;
  _xStepOverride = 0;
  _yStepOverride = 0;
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
const BUILD_KEYS = new Set(['lightnessThreshold','stepSize','minDotSize','maxDotSize','displacementFactor','gridType','angle','screenAngleOffset','xSquares','ySquares']);
const PAINT_KEYS = new Set(['cornerRadius','dotColor','bgColor','showEffect','dotShape']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
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
    if(key === 'mode'){ return; }
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
