// pixart/zoom-blur — radial blur with 4 blur types and 6 animation modes.
//
// Algorithm: for each output pixel, accumulate N samples along a radial path
// from a focal point and average their colors. Four blur geometries:
//   zoom         — radial rays from focus through pixel
//   rotational   — arc sweep around the pixel at constant radius
//   spiral       — combined radial + arc sweep (Archimedean spiral path)
//   motion-line  — linear translation in a fixed direction
//
// Six animation modes: idle · breath · pulse · spin · march · chase
// Interactive: cursor XY → focal point.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor.
  canvasSize:   480,
  blur:           0,
  grain:          0,
  gamma:          1,
  blackPoint:     0,
  whitePoint:   255,
  // Blur core.
  blurType:    'zoom',        // 'zoom'|'rotational'|'spiral'|'motion-line'
  strength:       0.4,        // 0..1, fraction of half-diagonal
  samples:       16,          // 6..40, Monte Carlo samples
  focusX:         0.5,        // 0..1, normalised
  focusY:         0.5,
  dropoff:        1,          // 0..2, strength growth exponent
  holdSharp:      0.2,        // 0..1, inner radius (×diagR) with no blur
  direction:      0,          // 0..360, for motion-line
  spiralTwist:   90,          // 0..360, total twist for spiral
  seed:           1,
  // Paint.
  showEffect:  true,
  // Animation + interactive.
  animate:     false,
  mode:        'breath',      // 'idle'|'breath'|'pulse'|'spin'|'march'|'chase'
  interactive: false,
  // Shared chrome.
  fit:         'cover',
  bg:          '#0a0a0a',
};
if (window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let blurBuf       = null;   // ImageData output of buildBlur()
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ---------- mulberry32 PRNG ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- bilinear sampler ----------
function sampleBilinear(px, W, H, x, y) {
  x = Math.max(0, Math.min(W - 1.001, x));
  y = Math.max(0, Math.min(H - 1.001, y));
  const x0 = x | 0, y0 = y | 0, x1 = x0 + 1, y1 = y0 + 1;
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4;
  const i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy,       w11 = fx * fy;
  const r = px[i00] * w00 + px[i10] * w10 + px[i01] * w01 + px[i11] * w11;
  const g = px[i00+1]*w00 + px[i10+1]*w10 + px[i01+1]*w01 + px[i11+1]*w11;
  const b = px[i00+2]*w00 + px[i10+2]*w10 + px[i01+2]*w01 + px[i11+2]*w11;
  const a = px[i00+3]*w00 + px[i10+3]*w10 + px[i01+3]*w01 + px[i11+3]*w11;
  return [r, g, b, a];
}

function schedule(level) {
  if (level === 'pre')   dirty.pre   = true;
  if (level === 'pre'  || level === 'build') dirty.build = true;
  dirty.paint = true;
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if (dirty.pre)   preprocess();
    if (dirty.build) buildBlur();
    paint();
    dirty.pre = dirty.build = dirty.paint = false;
  });
}

function fitCanvas() {
  const w = cv.clientWidth  || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if (cv.width  !== w) cv.width  = w;
  if (cv.height !== h) cv.height = h;
}

// ---------- preprocessor ----------
function preprocess() {
  const srcCv = window.PIXSource?.getCanvas();
  if (!srcCv) return;
  const aspect = (window.PIXSource?.height || srcCv.height) /
                 (window.PIXSource?.width  || srcCv.width);
  const W = params.canvasSize;
  const H = Math.max(1, Math.round(W * aspect));
  if (srcBuf.width !== W || srcBuf.height !== H) {
    srcBuf.width = W; srcBuf.height = H;
  }
  sctx.save();
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  sctx.restore();

  if (params.blur > 0) {
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const t = tmp.getContext('2d');
    t.filter = `blur(${params.blur}px)`;
    t.drawImage(srcBuf, 0, 0);
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(tmp, 0, 0);
  }

  const id  = sctx.getImageData(0, 0, W, H);
  const px  = id.data;
  const g   = params.grain;
  const gm  = params.gamma;
  const bp  = params.blackPoint;
  const wp  = params.whitePoint;
  const span  = Math.max(1, wp - bp);
  const scale = 255 / span;
  const rnd   = Math.random;
  const doGrain  = g  !== 0;
  const doGamma  = gm !== 1;
  const doLevels = bp !== 0 || wp !== 255;
  let lut = null;
  if (doGamma) {
    lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, gm));
  }
  for (let i = 0; i < px.length; i += 4) {
    let r = px[i], gg = px[i+1], b = px[i+2];
    if (doGrain) {
      const n = (0.5 - rnd()) * g * 255;
      r  = clamp(r  + n, 0, 255);
      gg = clamp(gg + n, 0, 255);
      b  = clamp(b  + n, 0, 255);
    }
    if (doGamma)  { r = lut[r|0]; gg = lut[gg|0]; b = lut[b|0]; }
    if (doLevels) {
      r  = clamp((r  - bp) * scale, 0, 255);
      gg = clamp((gg - bp) * scale, 0, 255);
      b  = clamp((b  - bp) * scale, 0, 255);
    }
    px[i] = r; px[i+1] = gg; px[i+2] = b;
  }
  sctx.putImageData(id, 0, 0);
  preprocessed = id;
}

// ---------- buildBlur ----------
function buildBlur() {
  if (!preprocessed) { blurBuf = null; return; }

  const W   = preprocessed.width;
  const H   = preprocessed.height;
  const src = preprocessed.data;    // Uint8ClampedArray from preprocess()

  // Allocate output ImageData once or if size changed.
  if (!blurBuf || blurBuf.width !== W || blurBuf.height !== H) {
    blurBuf = new ImageData(W, H);
  }
  const dst = blurBuf.data;

  const N   = params.samples | 0;
  const typ = params.blurType;

  // Focal point in pixel coordinates.
  const fx  = params.focusX * W;
  const fy  = params.focusY * H;

  // Half-diagonal and derived radii.
  const diagR  = 0.5 * Math.sqrt(W * W + H * H);
  const maxDisp = params.strength * diagR;
  const holdR  = params.holdSharp * diagR;
  const dropE  = params.dropoff;

  // For motion-line: precompute unit direction vector.
  const dirRad = params.direction * Math.PI / 180;
  const dirDX  = Math.cos(dirRad);
  const dirDY  = Math.sin(dirRad);

  const spiralAngle = params.spiralTwist * Math.PI / 180;

  // Pre-roll N jitter values deterministically.
  const seed = (params.mode === 'idle') ? 1 : (params.seed | 0) || 1;
  const rng  = mulberry32(seed ^ 0xABCD1234);
  const jitter = new Float32Array(N);
  for (let k = 0; k < N; k++) jitter[k] = rng() - 0.5;  // -0.5 .. 0.5

  for (let oy = 0; oy < H; oy++) {
    for (let ox = 0; ox < W; ox++) {
      const idx = (oy * W + ox) * 4;

      const dx = ox - fx;
      const dy = oy - fy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Strength envelope based on distance from focal point.
      let strengthFactor;
      if (dist <= holdR || maxDisp <= 0 || N <= 1) {
        // Sharp zone — copy pixel directly.
        dst[idx]   = src[idx];
        dst[idx+1] = src[idx+1];
        dst[idx+2] = src[idx+2];
        dst[idx+3] = src[idx+3];
        continue;
      }
      const tNorm = Math.pow(
        clamp((dist - holdR) / (diagR - holdR), 0, 1),
        dropE
      );
      strengthFactor = tNorm * maxDisp;

      // Accumulate N samples.
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;

      if (typ === 'zoom') {
        // Sample along the radial ray between focus and pixel.
        for (let k = 0; k < N; k++) {
          const frac = (k + 0.5 + jitter[k]) / N;  // 0..1
          const t    = frac * strengthFactor / Math.max(1, dist);
          const sx   = ox - dx * t;
          const sy   = oy - dy * t;
          const [r, g, b, a] = sampleBilinear(src, W, H, sx, sy);
          rSum += r; gSum += g; bSum += b; aSum += a;
        }

      } else if (typ === 'rotational') {
        // Sweep an arc of ±angleSpan/2 at radius dist around the pixel's angle.
        const baseAngle   = Math.atan2(dy, dx);
        const angleSpan   = strengthFactor / Math.max(1, dist);
        for (let k = 0; k < N; k++) {
          const frac  = (k + 0.5 + jitter[k]) / N;     // 0..1
          const theta = baseAngle + (frac - 0.5) * angleSpan;
          const sx    = fx + dist * Math.cos(theta);
          const sy    = fy + dist * Math.sin(theta);
          const [r, g, b, a] = sampleBilinear(src, W, H, sx, sy);
          rSum += r; gSum += g; bSum += b; aSum += a;
        }

      } else if (typ === 'spiral') {
        // Spiral path: radius sweeps ±strengthFactor/2, angle sweeps by spiralTwist.
        const baseAngle = Math.atan2(dy, dx);
        for (let k = 0; k < N; k++) {
          const frac   = (k + 0.5 + jitter[k]) / N;    // 0..1
          const dr     = (frac - 0.5) * strengthFactor;
          const r_k    = Math.max(0, dist + dr);
          const dTheta = spiralAngle * (frac - 0.5) * strengthFactor / Math.max(1, diagR);
          const theta  = baseAngle + dTheta;
          const sx     = fx + r_k * Math.cos(theta);
          const sy     = fy + r_k * Math.sin(theta);
          const [r, g, b, a] = sampleBilinear(src, W, H, sx, sy);
          rSum += r; gSum += g; bSum += b; aSum += a;
        }

      } else {
        // motion-line: translate along direction vector.
        for (let k = 0; k < N; k++) {
          const frac = (k + 0.5 + jitter[k]) / N;      // 0..1
          const t    = (frac - 0.5) * strengthFactor;
          const sx   = ox + dirDX * t;
          const sy   = oy + dirDY * t;
          const [r, g, b, a] = sampleBilinear(src, W, H, sx, sy);
          rSum += r; gSum += g; bSum += b; aSum += a;
        }
      }

      const inv = 1 / N;
      dst[idx]   = rSum * inv;
      dst[idx+1] = gSum * inv;
      dst[idx+2] = bSum * inv;
      dst[idx+3] = aSum * inv;
    }
  }
}

// ---------- paint ----------
function paint() {
  window.WAGUI?.flashValues(params);
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if (!preprocessed) { ctx.restore(); return; }

  const aspect = preprocessed.width / preprocessed.height;
  let dw, dh;
  if (W / H > aspect) { dh = H * 0.96; dw = dh * aspect; }
  else                { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2;
  const oy = (H - dh) / 2;

  if (!params.showEffect || !blurBuf) {
    ctx.drawImage(srcBuf, ox, oy, dw, dh);
    ctx.restore();
    return;
  }

  // Put blurBuf ImageData onto an offscreen canvas, then scale to viewport.
  const offscreen = document.createElement('canvas');
  offscreen.width  = blurBuf.width;
  offscreen.height = blurBuf.height;
  offscreen.getContext('2d').putImageData(blurBuf, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(offscreen, ox, oy, dw, dh);

  ctx.restore();
}

// ---------- animation + interactive ----------
const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

const BLUR_TYPES = ['zoom', 'rotational', 'spiral', 'motion-line'];

function applyMode(t01) {
  const mode = params.mode;

  if (mode === 'idle') {
    // No animation; always use seed=1 for deterministic jitter.
    return () => {};
  }

  if (mode === 'breath') {
    const base = params.strength;
    params.strength = 0.1 + 0.5 * 0.5 * (1 - Math.cos(2 * Math.PI * t01));
    return () => { params.strength = base; };
  }

  if (mode === 'pulse') {
    const base = params.strength;
    if (t01 < 0.12) {
      params.strength = (t01 / 0.12) * 0.6;
    } else {
      params.strength = 0.6 * Math.pow(1 - (t01 - 0.12) / 0.88, 2.5);
    }
    return () => { params.strength = base; };
  }

  if (mode === 'spin') {
    const baseType = params.blurType;
    const baseDir  = params.direction;
    params.blurType  = 'rotational';
    params.direction = (t01 * 360) % 360;
    return () => { params.blurType = baseType; params.direction = baseDir; };
  }

  if (mode === 'march') {
    const baseType = params.blurType;
    const step = Math.floor(t01 * 4) % 4;
    params.blurType = BLUR_TYPES[step];
    return () => { params.blurType = baseType; };
  }

  if (mode === 'chase') {
    const baseFX = params.focusX;
    const baseFY = params.focusY;
    params.focusX = 0.5 + 0.4 * Math.cos(2 * Math.PI * t01);
    params.focusY = 0.5 + 0.3 * Math.sin(4 * Math.PI * t01);
    return () => { params.focusX = baseFX; params.focusY = baseFY; };
  }

  return () => {};
}

function applyInteractive() {
  if (!params.interactive || !hasMouse) return () => {};
  const r   = cv.getBoundingClientRect();
  const baseFX = params.focusX;
  const baseFY = params.focusY;
  params.focusX = clamp(mouseX / r.width,  0, 1);
  params.focusY = clamp(mouseY / r.height, 0, 1);
  return () => { params.focusX = baseFX; params.focusY = baseFY; };
}

function renderAt(t01) {
  // Update the jitter seed per-frame so animated modes aren't static.
  if (params.mode !== 'idle') {
    params.seed = Math.floor(t01 * 65536) ^ 0x1337;
  }
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  buildBlur();
  paint();
  restoreInt();
  restoreMode();
}

function animationLoop() {
  if (!params.animate) { animationId = null; return; }
  const elapsed = performance.now() - animationStartTime;
  renderAt((elapsed % CYCLE_MS) / CYCLE_MS);
  animationId = requestAnimationFrame(animationLoop);
}

function startAnimation() {
  if (animationId) return;
  animationStartTime = performance.now();
  animationLoop();
}
function stopAnimation() {
  if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
}

function handleMouseMove(e) {
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  hasMouse = true;
  if (params.interactive && !params.animate) {
    renderAt(0);
  }
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t) { renderAt(t || 0); return cv; },
  pauseRender() { stopAnimation(); },
  resumeRender() {
    if (params.animate) startAnimation();
    else { paint(); }
    return cv;
  },
};

const PRE_KEYS   = new Set(['canvasSize','blur','grain','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['blurType','strength','samples','focusX','focusY','dropoff',
                             'holdSharp','direction','spiralTwist','seed','showEffect']);

function init() {
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if (key === 'animate') {
      if (params.animate) startAnimation();
      else { stopAnimation(); schedule('paint'); }
      return;
    }
    if (key === 'mode') {
      if (!params.animate) schedule('paint');
      return;
    }
    if (key === 'interactive') {
      if (!params.animate) schedule('paint');
      return;
    }
    if (key === 'fit' || key === 'bg') {
      window.PIXSource?.setParam(key, params[key]);
      if (key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if (params.animate) return;
    if (PRE_KEYS.has(key))        schedule('pre');
    else if (BUILD_KEYS.has(key)) schedule('build');
    else                          schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => {
    hasMouse = false;
    if (!params.animate) schedule('paint');
  });
  if (window.PIXSource) {
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if (window.WAExport) {
    window.WAExport.wire({
      canvas: cv, name: 'pixart-zoom-blur',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
  if (params.animate) startAnimation();
}

document.addEventListener('DOMContentLoaded', init);
