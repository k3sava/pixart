// pixart/moire — classic moiré interference pattern.
//
// Two halftone screens (line grids, dot grids, or radial rings) rendered at
// slightly different angles and/or frequencies. Their interference creates
// the characteristic shimmering ripple bands.  The interference mask is then
// composited onto the source image using a luminance-aware overlay that
// brightens highlights and deepens shadows where bands intersect.
//
// Params
//   frequency   5–80   lines (or dots / rings) per unit
//   angleDelta  0.1–15 angular difference between the two screens (°)
//   angle       0–180  base rotation for screen 1 (°)
//   contrast    0–100  strength of the moiré overlay (%)
//   mode        'lines' | 'dots' | 'radial'
//   invert      bool   invert the interference pattern
//
// Animation modes
//   rotate — angleDelta slowly sweeps 0 → max, creating evolving patterns
//   drift  — both screens translate at slightly different speeds
//   pulse  — frequency oscillates between lo and hi (bands breathe)
//
// Interactive: X → frequency (5..80), Y → angleDelta (0..15)
//
// WAEffect contract: { cycleMs, renderAt(t_loop), pauseRender(), resumeRender() }
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

// Off-screen buffers for the two screens and the composite interference map.
const screen1Buf = document.createElement('canvas');
const s1ctx      = screen1Buf.getContext('2d');
const screen2Buf = document.createElement('canvas');
const s2ctx      = screen2Buf.getContext('2d');

const CANVAS_SIZE = 600;

const params = {
  // Preprocessor
  canvasSize:  CANVAS_SIZE,
  fit:         'cover',
  bg:          '#0a0a0a',
  // Effect core
  frequency:   28,
  angleDelta:  3.5,
  angle:       15,
  contrast:    70,
  mode:        'lines',
  invert:      false,
  // Animation + interactive
  animate:     false,
  animMode:    'rotate',
  interactive: false,
  // Output
  showEffect:  true,
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;         // ImageData at canvasSize × canvasSize
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// Drift state: accumulated offsets for the two screens.
let drift1 = { x: 0, y: 0 };
let drift2 = { x: 0, y: 0 };

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

function schedule(level){
  if(level === 'pre')   dirty.pre   = true;
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

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 — preprocess
// ─────────────────────────────────────────────────────────────────────────────
function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;

  const aspect = srcCv.height / srcCv.width;
  const W = params.canvasSize;
  const H = Math.max(1, Math.round(W * aspect));

  if(srcBuf.width !== W || srcBuf.height !== H){
    srcBuf.width  = W; srcBuf.height = H;
    screen1Buf.width = W; screen1Buf.height = H;
    screen2Buf.width = W; screen2Buf.height = H;
  }

  sctx.save();
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  sctx.restore();

  preprocessed = sctx.getImageData(0, 0, W, H);
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen-drawing helpers
// ─────────────────────────────────────────────────────────────────────────────

// Draw a single-colour halftone screen (lines, dots, or radial) onto the given
// context.  The screen is sized to W×H.  offsetX/Y are fractional phase shifts
// in screen-space (used by the drift animation).
function drawScreen(c2d, W, H, angleDeg, freq, mode, offsetX, offsetY){
  c2d.clearRect(0, 0, W, H);

  const ang    = angleDeg * Math.PI / 180;
  const period = Math.max(1, W / Math.max(1, freq));  // px between lines / dots

  c2d.save();
  c2d.fillStyle = '#ffffff';

  if(mode === 'lines'){
    // Parallel lines drawn in rotated space.
    // We translate to canvas centre, rotate, then stripe across the diagonal.
    const diag = Math.sqrt(W * W + H * H);
    const n    = Math.ceil(diag / period) + 4;
    const ox   = (offsetX % period);
    const oy   = (offsetY % period);

    c2d.translate(W / 2, H / 2);
    c2d.rotate(ang);
    c2d.translate(ox, oy);

    const lineW = Math.max(0.5, period * 0.42);
    c2d.lineWidth = lineW;
    c2d.strokeStyle = '#ffffff';

    for(let i = -n; i <= n; i++){
      const x = i * period;
      c2d.beginPath();
      c2d.moveTo(x, -diag);
      c2d.lineTo(x, +diag);
      c2d.stroke();
    }

  } else if(mode === 'dots'){
    // Dot grid: each cell contains one circle whose radius = period * 0.38.
    const diag  = Math.sqrt(W * W + H * H);
    const n     = Math.ceil(diag / period) + 4;
    const rad   = period * 0.38;
    const ox    = (offsetX % period);
    const oy    = (offsetY % period);
    const cosR  = Math.cos(ang), sinR = Math.sin(ang);
    const cx0   = W / 2 + ox * cosR - oy * sinR;
    const cy0   = H / 2 + ox * sinR + oy * cosR;

    for(let i = -n; i <= n; i++){
      for(let j = -n; j <= n; j++){
        const gx = j * period, gy = i * period;
        const wx = cx0 + gx * cosR - gy * sinR;
        const wy = cy0 + gx * sinR + gy * cosR;
        if(wx < -period || wx > W + period || wy < -period || wy > H + period) continue;
        c2d.beginPath();
        c2d.arc(wx, wy, rad, 0, Math.PI * 2);
        c2d.fill();
      }
    }

  } else {
    // Radial: concentric rings centred on canvas centre + drift offset.
    const cx   = W / 2 + offsetX;
    const cy   = H / 2 + offsetY;
    const maxR = Math.sqrt(W * W + H * H);
    const rw   = Math.max(0.5, period * 0.42);
    c2d.strokeStyle = '#ffffff';
    c2d.lineWidth   = rw;
    for(let r = period / 2; r < maxR; r += period){
      c2d.beginPath();
      c2d.arc(cx, cy, r, 0, Math.PI * 2);
      c2d.stroke();
    }
  }

  c2d.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 — buildOutput
// Renders both screens into their off-screen buffers.  Paint will composite
// them (we don't do pixel-level maths here — the canvas compositor handles it).
// ─────────────────────────────────────────────────────────────────────────────
function buildOutput(){
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;

  const freq    = clamp(params.frequency,   5, 80);
  const delta   = clamp(params.angleDelta,  0.1, 15);
  const ang1    = params.angle;
  const ang2    = ang1 + delta;
  const mode    = params.mode;

  drawScreen(s1ctx, W, H, ang1, freq, mode, drift1.x, drift1.y);
  drawScreen(s2ctx, W, H, ang2, freq, mode, drift2.x, drift2.y);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — paint
// Composite the interference onto the source image.
// ─────────────────────────────────────────────────────────────────────────────
function paint(){
  window.WAGUI?.flashValues(params);

  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!preprocessed){ ctx.restore(); return; }

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;

  // Clip to image bounds.
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, dw, dh);
  ctx.clip();

  // 1. Source image.
  ctx.drawImage(srcBuf, ox, oy, dw, dh);

  if(params.showEffect){
    const alpha = clamp(params.contrast, 0, 100) / 100;
    const blendMode = params.invert ? 'multiply' : 'screen';

    // 2. Screen 1 — white pattern drawn on transparent black.
    //    "screen" brightens where the pattern is white.
    //    "multiply" darkens where it is white (we feed inverted pattern).
    ctx.globalAlpha = alpha * 0.6;
    ctx.globalCompositeOperation = blendMode;
    ctx.drawImage(screen1Buf, ox, oy, dw, dh);

    // 3. Screen 2 — the slight angle/frequency difference produces the
    //    interference fringe when composited on top of screen 1.
    ctx.globalAlpha = alpha * 0.6;
    ctx.globalCompositeOperation = blendMode;
    ctx.drawImage(screen2Buf, ox, oy, dw, dh);

    // 4. Overlay pass: draw both screens again with 'difference' to
    //    accentuate the interference bands.
    ctx.globalAlpha = alpha * 0.35;
    ctx.globalCompositeOperation = 'difference';
    ctx.drawImage(screen1Buf, ox, oy, dw, dh);
    ctx.globalAlpha = alpha * 0.35;
    ctx.globalCompositeOperation = 'difference';
    ctx.drawImage(screen2Buf, ox, oy, dw, dh);
  }

  ctx.restore(); // unclip
  ctx.restore(); // reset transform
}

// ─────────────────────────────────────────────────────────────────────────────
// Animation + interactive
// ─────────────────────────────────────────────────────────────────────────────
//
// Three animation modes, each cosine-enveloped across CYCLE_MS:
//
//   rotate — angleDelta sweeps 0.5 → max (15) and back.  Continuously
//             evolving moiré fringes.  Paint-only — buildOutput per frame.
//   drift  — screens translate at different speeds (±phase offset), making the
//             bands appear to flow.  buildOutput per frame.
//   pulse  — frequency oscillates 8 ↔ 60, making bands breathe.
//             buildOutput per frame.
//
// Interactive: cursor X → frequency (5..80), cursor Y → angleDelta (0..15).

const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.animMode;

  if(mode === 'rotate'){
    const base = params.angleDelta;
    params.angleDelta = 0.5 + 14.5 * pingPong(t01);
    return () => { params.angleDelta = base; };
  }

  if(mode === 'drift'){
    // Both screens drift; screen2 moves slightly faster to phase-shift.
    const base = params.frequency;
    const period = Math.max(1, params.canvasSize / Math.max(1, params.frequency));
    const t = t01 * Math.PI * 2;
    drift1 = { x:  period * 1.5 * Math.cos(t * 0.7), y:  period * 0.9 * Math.sin(t * 0.5) };
    drift2 = { x: -period * 1.2 * Math.cos(t * 0.8), y: -period * 0.7 * Math.sin(t * 0.6) };
    return () => { drift1 = { x: 0, y: 0 }; drift2 = { x: 0, y: 0 }; };
  }

  if(mode === 'pulse'){
    const base = params.frequency;
    params.frequency = 8 + 52 * pingPong(t01);
    return () => { params.frequency = base; };
  }

  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseFreq  = params.frequency;
  const baseDelta = params.angleDelta;
  params.frequency   = 5  + ax * 75;   // 5..80
  params.angleDelta  = ay * 15;         // 0..15
  return () => { params.frequency = baseFreq; params.angleDelta = baseDelta; };
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

// ─────────────────────────────────────────────────────────────────────────────
// WAEffect contract
// ─────────────────────────────────────────────────────────────────────────────
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else { buildOutput(); paint(); }
    return cv;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Param → pipeline level mapping
// ─────────────────────────────────────────────────────────────────────────────
const PRE_KEYS   = new Set(['canvasSize','fit','bg']);
const BUILD_KEYS = new Set(['frequency','angleDelta','angle','mode']);
const PAINT_KEYS = new Set(['contrast','invert','showEffect']);

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('build'); }
      return;
    }
    if(key === 'animMode'){
      if(!params.animate) schedule('build');
      return;
    }
    if(key === 'interactive'){
      if(!params.animate) schedule('build');
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
  cv.addEventListener('mouseleave', () => {
    hasMouse = false;
    if(!params.animate) schedule('build');
  });

  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }

  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-moire',
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

document.addEventListener('DOMContentLoaded', init);
