// pixart/stack — card-deal animator.
// Ported from tooooools.app/animate/stack.
// N rounded-rectangle cards clipped from the source image are dealt onto
// a central pile over the loop duration. Each card has a deterministic
// random rotation and position offset driven by FNV-1a hashing.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf  = document.createElement('canvas');
const sctx    = srcBuf.getContext('2d', { willReadFrequently: true });
const cardBuf = document.createElement('canvas');  // pre-baked card texture
const ccx     = cardBuf.getContext('2d');

const params = {
  // Preprocessor.
  canvasSize:    600,
  blur:          0,
  grain:         0,
  gamma:         1,
  blackPoint:    0,
  whitePoint:    255,
  // Stack core.
  numCards:      8,
  cardSize:      260,
  cardRadius:    18,
  rotationRange: 14,
  rotationSeed:  1,
  cardShiftX:    18,
  cardShiftY:    24,
  stackCycles:   2,
  stackCurve:    'faster',
  tintCards:     false,
  // Animation.
  animate:       true,
  mode:          'breath',
  interactive:   false,
  // Mode-specific.
  frameCount:    12,
  shearAxis:     45,
  // Shared chrome.
  showEffect:    true,
  fit:           'cover',
  bg:            '#0a0a0a',
};
if (window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let currentT01 = 0;

const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

// ---------- utils ----------
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ---------- FNV-1a hash (byte-equal to reference) ----------
function fnv01(str) {
  let t = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    t = Math.imul(t ^ str.charCodeAt(i), 0x01000193);
  }
  return (t >>> 0) / 0xffffffff;
}

// ---------- ease curves ----------
function applyCurve(t, preset) {
  t = clamp(t, 0, 1);
  if (preset === 'faster') return t * t * (3 - 2 * t);  // smoothstep (ease-in-out, reads as faster than linear)
  if (preset === 'slower') return t * t;                 // ease-in (slow start)
  return t;                                              // linear
}

// ---------- visible count at time t ----------
function visibleCountAt(t01, N, cycles, curve) {
  if (t01 >= 1) t01 = 0;
  const totalCards = N * cycles;
  const cyclePhase = cycles > 1 ? t01 / ((cycles - 1) / cycles) : t01;
  const d = clamp(cyclePhase, 0, 1);
  const eased = applyCurve(d, curve);
  return Math.min(totalCards, Math.floor(eased * (totalCards + 1)));
}

// ---------- per-card properties (deterministic via FNV-1a) ----------
function cardProps(cardIdx, drawIdx, seed, rotRange, shiftX, shiftY) {
  const rot = fnv01(`card-${cardIdx}:${seed}`) * 2 * rotRange - rotRange;  // degrees
  const dx  = (fnv01(`draw-${drawIdx}:${seed}:x`) * 2 - 1) * shiftX;
  const dy  = (fnv01(`draw-${drawIdx}:${seed}:y`) * 2 - 1) * shiftY;
  return { rot: rot * Math.PI / 180, dx, dy };
}

// ---------- pingpong helper ----------
function pingPong(t) { return (1 - Math.cos(t * Math.PI * 2)) / 2; }

// ---------- fitCanvas ----------
function fitCanvas() {
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
}

// ---------- schedule dirty-flag system ----------
function schedule(level) {
  if (level === 'pre') dirty.pre = true;
  if (level === 'pre' || level === 'build') dirty.build = true;
  dirty.paint = true;
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if (dirty.pre)   preprocess();
    if (dirty.build) bakeCardBuf();
    paint();
    dirty.pre = dirty.build = dirty.paint = false;
  });
}

// ---------- preprocess (standard pattern) ----------
function preprocess() {
  const srcCv = window.PIXSource?.getCanvas();
  if (!srcCv) return;
  const aspect = (window.PIXSource?.height || srcCv.height) / (window.PIXSource?.width || srcCv.width);
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

  const id = sctx.getImageData(0, 0, W, H);
  const px = id.data;
  const g  = params.grain;
  const gm = params.gamma;
  const bp = params.blackPoint;
  const wp = params.whitePoint;
  const span = Math.max(1, wp - bp);
  const scale = 255 / span;
  const doGrain  = g !== 0;
  const doGamma  = gm !== 1;
  const doLevels = bp !== 0 || wp !== 255;
  let lut = null;
  if (doGamma) {
    lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, gm));
  }
  for (let i = 0; i < px.length; i += 4) {
    let r = px[i], gg = px[i + 1], b = px[i + 2];
    if (doGrain) {
      const n = (0.5 - Math.random()) * g * 255;
      r  = clamp(r  + n, 0, 255);
      gg = clamp(gg + n, 0, 255);
      b  = clamp(b  + n, 0, 255);
    }
    if (doGamma) { r = lut[r | 0]; gg = lut[gg | 0]; b = lut[b | 0]; }
    if (doLevels) {
      r  = clamp((r  - bp) * scale, 0, 255);
      gg = clamp((gg - bp) * scale, 0, 255);
      b  = clamp((b  - bp) * scale, 0, 255);
    }
    px[i] = r; px[i + 1] = gg; px[i + 2] = b;
  }
  sctx.putImageData(id, 0, 0);
  preprocessed = id;

  // Also rebuild card buffer when source changes.
  bakeCardBuf();
}

// ---------- bake card buffer (clip srcBuf into rounded rect) ----------
function bakeCardBuf() {
  if (!preprocessed) return;
  const srcAspect = preprocessed.width / preprocessed.height;
  const cardW = Math.max(1, Math.round(params.cardSize));
  const cardH = Math.max(1, Math.round(cardW / srcAspect));
  cardBuf.width  = cardW;
  cardBuf.height = cardH;
  ccx.clearRect(0, 0, cardW, cardH);
  const r = clamp(params.cardRadius, 0, Math.min(cardW, cardH) / 2);
  ccx.save();
  ccx.beginPath();
  if (typeof ccx.roundRect === 'function' && r > 0) {
    ccx.roundRect(0, 0, cardW, cardH, r);
  } else {
    ccx.rect(0, 0, cardW, cardH);
  }
  ccx.clip();
  ccx.drawImage(srcBuf, 0, 0, cardW, cardH);
  ccx.restore();
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

  // Show source image if effect is off.
  if (!params.showEffect) {
    const aspect = preprocessed.width / preprocessed.height;
    let dw, dh;
    if (W / H > aspect) { dh = H; dw = H * aspect; }
    else                { dw = W; dh = W / aspect; }
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  if (!cardBuf.width || !cardBuf.height) { ctx.restore(); return; }

  const t01 = currentT01;
  const N      = Math.max(1, params.numCards | 0);
  const cycles = Math.max(1, params.stackCycles | 0);
  const mode   = params.mode;

  // Compute visible count per mode.
  let visible;
  if (mode === 'idle') {
    visible = N * cycles;
  } else if (mode === 'cascade') {
    const steps = Math.max(1, params.frameCount | 0);
    const raw = Math.floor(t01 * steps) + 1;
    visible = Math.min(N * cycles, raw);
  } else {
    // breath / splay / breath-3d all use standard visible ramp.
    visible = visibleCountAt(t01, N, cycles, params.stackCurve);
  }

  // Stage scale: pile takes ~70% of shorter canvas dimension.
  const shortSide = Math.min(W, H);
  const scale = (shortSide * 0.7) / params.canvasSize;

  const cx = W / 2, cy = H / 2;

  // Splay amplitude.
  const splayAmp = (mode === 'splay') ? pingPong(t01) : 1;

  // Breath-3d shear.
  const shearAmp   = (mode === 'breath-3d') ? pingPong(t01) * 0.3 : 0;
  const shearAxisR = params.shearAxis * Math.PI / 180;
  const shx = Math.cos(shearAxisR) * shearAmp;
  const shy = Math.sin(shearAxisR) * shearAmp;

  const cw = cardBuf.width * scale;
  const ch = cardBuf.height * scale;

  // Per-card: need a scale factor for the shift in source-px → canvas-px.
  const shiftScale = scale;

  for (let i = 0; i < visible; i++) {
    const drawIdx = i % N;
    const { rot, dx, dy } = cardProps(
      i, drawIdx,
      params.rotationSeed,
      params.rotationRange * splayAmp,
      params.cardShiftX,
      params.cardShiftY
    );

    ctx.save();
    ctx.translate(cx + dx * shiftScale, cy + dy * shiftScale);
    ctx.rotate(rot);
    if (mode === 'breath-3d') {
      ctx.transform(1, shy, shx, 1, 0, 0);
    }

    // Optional per-card hue tint (golden-angle rotation, subtle).
    if (params.tintCards) {
      const hue = (i * 137.508) % 360;
      ctx.drawImage(cardBuf, -cw / 2, -ch / 2, cw, ch);
      ctx.globalAlpha = 0.18;
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `hsl(${hue},70%,50%)`;
      ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.drawImage(cardBuf, -cw / 2, -ch / 2, cw, ch);
    }

    ctx.restore();
  }

  ctx.restore();
}

// ---------- renderAt (WAEffect entry point) ----------
function renderAt(t01) {
  currentT01 = t01;
  if (dirty.pre)   preprocess();
  if (dirty.build) bakeCardBuf();
  dirty.pre = dirty.build = dirty.paint = false;
  paint();
  return cv;
}

// ---------- animation loop ----------
function animationLoop() {
  if (!params.animate) { animationId = null; return; }
  const elapsed = performance.now() - animationStartTime;
  currentT01 = (elapsed % CYCLE_MS) / CYCLE_MS;
  paint();
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

// ---------- interactive ----------
function applyInteractive() {
  if (!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / (r.width  || 1), 0, 1);
  const ay = clamp(mouseY / (r.height || 1), 0, 1);
  const baseRotRange = params.rotationRange;
  const baseShiftX   = params.cardShiftX;
  const baseShiftY   = params.cardShiftY;
  params.rotationRange = ax * 45;
  params.cardShiftX    = ay * 50;
  params.cardShiftY    = ay * 50;
  return () => {
    params.rotationRange = baseRotRange;
    params.cardShiftX    = baseShiftX;
    params.cardShiftY    = baseShiftY;
  };
}

function handleMouseMove(e) {
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  hasMouse = true;
  if (params.interactive && !params.animate) {
    const restore = applyInteractive();
    paint();
    restore();
  }
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t) {
    const restore = params.animate ? (() => {}) : applyInteractive();
    renderAt(t || 0);
    restore();
    return cv;
  },
  pauseRender() { stopAnimation(); },
  resumeRender() {
    if (params.animate) startAnimation();
    else { paint(); }
    return cv;
  },
};

// ---------- dirty-flag key sets ----------
const PRE_KEYS   = new Set(['canvasSize', 'blur', 'grain', 'gamma', 'blackPoint', 'whitePoint', 'fit', 'bg']);
const BUILD_KEYS = new Set(['numCards', 'cardSize', 'cardRadius', 'rotationSeed']);
const PAINT_KEYS = new Set(['rotationRange', 'cardShiftX', 'cardShiftY', 'stackCycles', 'stackCurve', 'tintCards', 'showEffect', 'mode', 'frameCount', 'shearAxis']);

// ---------- init ----------
function init() {
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if (key === 'animate') {
      if (params.animate) startAnimation();
      else { stopAnimation(); schedule('paint'); }
      return;
    }
    if (key === 'mode' || key === 'interactive') {
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
      canvas: cv, name: 'pixart-stack',
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
