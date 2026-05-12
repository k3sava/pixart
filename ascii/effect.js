// pixart/ascii — converts the current source (image or video frame) into a
// monospace ASCII grid rendered on canvas. Reverse-engineered from
// tooooools.app/effects/ascii (Daniil Sukhovskoy):
//
//   - Columns × Rows is the explicit grid (NOT a cell-pixel size). The source
//     is downsampled to columns × rows; each sampled luminance picks a char
//     from the ramp (' .:-=+*#%@' by default — index 0 = blank/darkest output,
//     index N-1 = densest/brightest). White on black means: brighter sample
//     → denser char.
//   - Image preprocessing (applied to a working buffer before sampling):
//       Blur 0..10        : box blur radius in source pixels
//       Grain 0..1        : additive noise amplitude (deterministic per frame)
//       Gamma 0.1..2      : power curve on luminance (gamma < 1 brightens)
//       Black/White Point : input level remap; pixels < black → 0,
//                           pixels > white → 255, linear stretch in between
//   - Comments wraps the output in /* ... */ — a tooooools.app conceit; it's
//     a copy-paste-into-code wink. We honour it because it costs nothing.
//   - Show Borders draws a +--+/|..| frame around the ASCII block.
//
// pixart-specific divergences from tooooools.app:
//   - Tooooools renders ASCII as selectable HTML text and exports via "copy
//     to clipboard". pixart's contract is canvas-only with PNG + MP4 export,
//     so we rasterise the chars with ctx.fillText into a monospace grid sized
//     to fit the stage. The character cell becomes (W/cols) × (H/rows) on the
//     output canvas — i.e. rows/cols are sampling dimensions; on-screen cell
//     size is derived to fill.
//   - Foreground / Background colours and Font weight are pixart additions.
//     Tooooools is locked to its terminal-green look; we want range.
//   - Animation: when ON, columns pingpongs (rest=24, peak=96), gamma sweeps
//     (rest=1.4 to peak=0.7 → fade-in feel), grain breathes (0 → 0.15). All
//     three close at the loop endpoints. 15-second cycle, seamless.
//   - Interactive: cursor X drives columns (16..160), cursor Y drives gamma
//     (0.4..2.0). Y top = brightest, Y bottom = darkest.
'use strict';

const CYCLE_MS = 15000;

// Pingpong t01 — 0 at edges, 1 at the midpoint, smooth and seamless.
function pingpongT01(t){ return (1 - Math.cos(t * Math.PI * 2)) / 2; }
function lerp(a, b, t){ return a + (b - a) * t; }
function clamp(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }

// Animation envelopes. Columns is the headline parameter — sweeping cell
// count is the most legible motion an ASCII converter can do (the image
// "resolves" from coarse → fine → coarse). Gamma adds a tonal breathe and
// grain adds texture without breaking the loop.
const ANIM = {
  columns: { rest: 24, peak: 110 },
  gamma:   { rest: 1.5, peak: 0.7 },
  grain:   { rest: 0.0, peak: 0.18 },
};

// Mode envelopes. Each mode picks a different *shape* of t over the 15s loop
// — that envelope shape, not the parameter set, is what makes the motion read
// as a distinct gesture (breath, march, rotate, pulse). The aa-project / cmatrix
// history matters here: classic ASCII renderers were always either rain-stepped
// (cmatrix), resolution-stepped (aalib), or contrast-pulsed (Shiffman). We
// honour those three lineages with `march`, `rotate`, `pulse`; `breath` is
// the pingpong default; `idle` is no motion.
const MODES = ['idle','breath','march','rotate','pulse'];
const MARCH_STEPS = 4; // 4 steps reads as deliberate vs noisy; matches aalib resolution drops

// Per-mode envelope: returns t01 ∈ [0,1] for the headline animated lever.
// `t` is the raw 0..1 loop position. Each mode must satisfy env(0) === env(1)
// at the byte level so renderAt(0) === renderAt(1) for export.
function modeEnvelope(mode, t){
  switch(mode){
    case 'idle':   return 0;
    case 'march':  return Math.floor(t * MARCH_STEPS) / MARCH_STEPS;
    case 'rotate': return t; // monotonic; the looped lever is itself periodic (gamma wraps via pingpong inside)
    case 'pulse':  return t < 0.2 ? t / 0.2 : Math.pow(1 - (t - 0.2) / 0.8, 2.5);
    case 'breath':
    default:       return pingpongT01(t);
  }
}

// Default char ramp. tooooools.app default is ' .:-=+*#%@' (10 chars). The
// leading space is critical — it's the "darkest output" cell on a black
// background, i.e. no ink. Reversing the ramp swaps that polarity.
const DEFAULT_RAMP = ' .:-=+*#%@';

// Deterministic noise RNG (mulberry32) — same trick as wordart/dither so the
// 15s loop closes pixel-perfect: seed at t=0 equals seed at t=1.
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

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');

const params = {
  // Grid + ramp
  columns: 96,                       // headline default — strikes legibility/density balance for landing
  rows: 0,                           // 0 = auto from aspect (computed each paint)
  ramp: DEFAULT_RAMP,
  invertRamp: false,
  // Preprocessing
  blur: 0,
  grain: 0,
  gamma: 1,
  blackPoint: 0,
  whitePoint: 255,
  // Output appearance
  fg: '#A8FF60',                     // phosphor green — striking landing frame
  fgMatch: false,                    // colour-per-char from source RGB?
  bold: false,
  // Format
  comments: false,
  borders: false,
  // Refinement: per-cell typography offsets. `tracking` shifts letters along
  // the column axis (±2 cell-widths of slack); good for "loose"/"tight" hands
  // without altering grid resolution. `jitter` injects deterministic sub-pixel
  // wobble per cell — mulberry32(seedFromT(t)) ensures byte-equal loop close,
  // matching the grain seam contract.
  tracking: 0,
  jitter: 0,
  // Refinement: mode + spatial interactive (soft focus column amplifier).
  mode: 'breath',
  // Shared
  fit: 'cover',
  bg: '#0a0a0a',
  // Lifecycle
  animate: false,
  interactive: false,
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0;

// Scratch buffer where preprocessing happens before sampling. Sized to the
// target grid (cols × rows) — we let drawImage do the heavy resampling so the
// per-pixel preprocessing loop is small.
const sampleCv = document.createElement('canvas');
const sampleCtx = sampleCv.getContext('2d', { willReadFrequently: true });

function fitCanvas(){
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width !== w) cv.width = w;
  if(cv.height !== h) cv.height = h;
}

// Compute grid dimensions. rows=0 means "auto from canvas aspect ratio and
// the monospace character cell aspect (~0.55 for most monospace fonts)".
function gridDims(){
  const cols = Math.max(8, Math.round(params.columns));
  // Char cell aspect ratio: width/height ≈ 0.55 for typical monospace. So a
  // square pixel area produces 1/0.55 ≈ 1.82 rows per column. We choose rows
  // so the on-screen cell stays roughly square.
  const aspect = cv.width / Math.max(1, cv.height);
  const autoRows = Math.max(8, Math.round(cols / aspect / 1.82));
  const rows = params.rows > 0 ? Math.max(8, Math.round(params.rows)) : autoRows;
  return { cols, rows };
}

// Cheap separable box blur in-place on an ImageData. radius is in cells of
// the downsampled buffer (so radius=1 already smudges noticeably at small
// grids). For small radii on small buffers this is fine; no fancy SIMD.
function boxBlur(imgData, radius){
  if(radius <= 0) return;
  const { data, width: w, height: h } = imgData;
  const tmp = new Uint8ClampedArray(data.length);
  const r = Math.min(radius, 10);
  // Horizontal pass
  for(let y = 0; y < h; y++){
    for(let x = 0; x < w; x++){
      let sr=0, sg=0, sb=0, n=0;
      for(let k = -r; k <= r; k++){
        const xx = clamp(x + k, 0, w - 1);
        const i = (y * w + xx) * 4;
        sr += data[i]; sg += data[i+1]; sb += data[i+2]; n++;
      }
      const o = (y * w + x) * 4;
      tmp[o] = sr/n; tmp[o+1] = sg/n; tmp[o+2] = sb/n; tmp[o+3] = data[o+3];
    }
  }
  // Vertical pass
  for(let y = 0; y < h; y++){
    for(let x = 0; x < w; x++){
      let sr=0, sg=0, sb=0, n=0;
      for(let k = -r; k <= r; k++){
        const yy = clamp(y + k, 0, h - 1);
        const i = (yy * w + x) * 4;
        sr += tmp[i]; sg += tmp[i+1]; sb += tmp[i+2]; n++;
      }
      const o = (y * w + x) * 4;
      data[o] = sr/n; data[o+1] = sg/n; data[o+2] = sb/n;
    }
  }
}

// Apply the levels stack: black/white-point stretch, gamma, grain. All ops
// run on the small grid buffer so this is cheap even at 200 cols.
function preprocess(imgData, frameSeed){
  const { data } = imgData;
  const bp = params.blackPoint, wp = params.whitePoint;
  const span = Math.max(1, wp - bp);
  const gamma = clamp(params.gamma, 0.05, 5);
  const invG = 1 / gamma;
  const grain = clamp(params.grain, 0, 1);
  const rng = grain > 0 ? mulberry32(frameSeed) : null;
  for(let i = 0; i < data.length; i += 4){
    for(let c = 0; c < 3; c++){
      let v = data[i + c];
      // Levels — clip below black, clip above white, stretch in between.
      v = ((v - bp) / span) * 255;
      v = clamp(v, 0, 255);
      // Gamma — pow on normalised 0..1.
      v = Math.pow(v / 255, invG) * 255;
      // Grain — symmetric ±127*grain noise.
      if(rng){
        v += (rng() - 0.5) * 255 * grain;
      }
      data[i + c] = clamp(v, 0, 255);
    }
  }
}

function hexToRgb(hex){
  const s = String(hex || '#000').replace('#','');
  const v = s.length === 3 ? s.split('').map(c => c+c).join('') : s;
  return [parseInt(v.slice(0,2),16)||0, parseInt(v.slice(2,4),16)||0, parseInt(v.slice(4,6),16)||0];
}

// Pick a char for luminance (0..255). The ramp is light → dark by convention,
// so brighter input → later char (denser). Reverse swaps that mapping.
function rampChar(lum, ramp){
  const r = ramp.length > 0 ? ramp : DEFAULT_RAMP;
  // Map [0,255] → [0, r.length - 1]. Clamp protects against NaN.
  let idx = Math.floor(clamp(lum, 0, 255) / 256 * r.length);
  if(idx >= r.length) idx = r.length - 1;
  if(params.invertRamp) idx = r.length - 1 - idx;
  return r.charAt(idx);
}

function paint(frameSeed){
  if(!window.PIXSource) return;
  const w = cv.width, h = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, w, h);

  const src = window.PIXSource.getCanvas();
  const { cols, rows } = gridDims();

  // 1. Downsample source into sampleCv at exactly cols × rows. drawImage
  //    does the resample (browser-optimised). fit honoured via aspect compare.
  if(sampleCv.width !== cols || sampleCv.height !== rows){
    sampleCv.width = cols; sampleCv.height = rows;
  }
  sampleCtx.imageSmoothingEnabled = true;
  sampleCtx.imageSmoothingQuality = 'high';
  sampleCtx.fillStyle = params.bg;
  sampleCtx.fillRect(0, 0, cols, rows);
  const sw = src.width, sh = src.height;
  const fit = params.fit;
  const sr = sw / sh, dr = cols / rows;
  let dw, dh;
  if(fit === 'contain' ? sr > dr : sr < dr){
    dw = cols; dh = cols / sr;
  } else {
    dh = rows; dw = rows * sr;
  }
  const dx = (cols - dw) / 2, dy = (rows - dh) / 2;
  try { sampleCtx.drawImage(src, dx, dy, dw, dh); } catch(e){ /* video not ready */ }

  // 2. Preprocess (blur → levels/gamma/grain). Blur first matches tooooools
  //    behaviour: it's a softener applied before levels, not after.
  const img = sampleCtx.getImageData(0, 0, cols, rows);
  if(params.blur > 0) boxBlur(img, Math.round(params.blur));
  preprocess(img, frameSeed || 1);
  const data = img.data;

  // 3. Render ASCII. Cell size on the OUTPUT canvas — derived to fit the
  //    full stage. We respect the comments/borders padding by shrinking the
  //    grid area before computing the cell size.
  const padX = (params.borders || params.comments) ? 24 : 0;
  const padY = (params.borders || params.comments) ? 32 : 0;
  const areaW = w - padX * 2;
  const areaH = h - padY * 2;
  const cellW = areaW / cols;
  const cellH = areaH / rows;
  // Font sized to fit the cell. We use the smaller of cellW/0.6 and cellH
  // because monospace fonts at fontSize px are ~0.6×fontSize wide.
  const fontSize = Math.max(4, Math.min(cellH * 1.05, cellW / 0.6 * 1.05));
  const weight = params.bold ? 'bold' : '500';
  ctx.font = `${weight} ${fontSize}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = params.fg;
  ctx.imageSmoothingEnabled = false;

  const ramp = params.ramp && params.ramp.length ? params.ramp : DEFAULT_RAMP;
  const matchColour = params.fgMatch;

  // Soft-focus lens. When interactive is on, the cursor position (in canvas
  // px) maps to a cell-space centre; cells inside a Gaussian footprint get
  // a brightness boost which shifts them later in the ramp (denser glyph).
  // sigma chosen to be ~18% of the smaller grid dimension — small enough to
  // feel like a lens, large enough to read on landing.
  const focusOn = params.interactive && !params.animate;
  const focusCx = focusOn ? clamp(mouseX / w, 0, 1) * cols : 0;
  const focusCy = focusOn ? clamp(mouseY / h, 0, 1) * rows : 0;
  const focusSigma = Math.max(4, Math.min(cols, rows) * 0.18);
  const focusInvTwoSig2 = 1 / (2 * focusSigma * focusSigma);
  const focusGain = 90; // peak luminance added at cursor centre; reads as ~1 ramp-step bump on a 10-char ramp

  // Tracking: ±2 cell-widths of letter-spacing-style offset. Positive expands,
  // negative contracts. Applied as a linear nudge per column index so the
  // whole grid breathes outward from the centre — preserves visual centre of
  // mass while making the type feel airy or condensed.
  const trk = clamp(params.tracking, -2, 2) * cellW * 0.5;
  // Jitter: deterministic sub-pixel offset per cell. Seamless via mulberry32
  // seeded from frameSeed (already locked to t01 by seedFromT). Magnitude is
  // capped at ~30% of a cell so glyphs never collide with neighbours.
  const jit = clamp(params.jitter, 0, 1);
  const jitRng = jit > 0 ? mulberry32(frameSeed || 1) : null;
  const jitterAmpX = jit * cellW * 0.3;
  const jitterAmpY = jit * cellH * 0.3;

  for(let y = 0; y < rows; y++){
    for(let x = 0; x < cols; x++){
      const i = (y * cols + x) * 4;
      const r8 = data[i], g8 = data[i+1], b8 = data[i+2];
      // Rec. 709 luma — matches what humans perceive as "brightness".
      let lum = 0.2126 * r8 + 0.7152 * g8 + 0.0722 * b8;
      if(focusOn){
        const dxf = x - focusCx, dyf = y - focusCy;
        const w_g = Math.exp(-(dxf*dxf + dyf*dyf) * focusInvTwoSig2);
        lum = clamp(lum + focusGain * w_g, 0, 255);
      }
      const ch = rampChar(lum, ramp);
      // Tracking and jitter must consume RNG even on void cells so the
      // sequence is independent of source content — otherwise an animated
      // bright/dark cycle would change the jitter pattern, breaking the loop.
      let jx = 0, jy = 0;
      if(jitRng){ jx = (jitRng() - 0.5) * 2 * jitterAmpX; jy = (jitRng() - 0.5) * 2 * jitterAmpY; }
      if(ch === ' ') continue; // skip the void — pure background cells
      if(matchColour){
        ctx.fillStyle = `rgb(${r8|0},${g8|0},${b8|0})`;
      }
      // Tracking pushes cells outward from the horizontal centre proportional
      // to their distance from it. Cheap, symmetric, never overflows pad.
      const trkOff = trk * ((x + 0.5) / cols - 0.5) * 2;
      const px = padX + (x + 0.5) * cellW + trkOff + jx;
      const py = padY + (y + 0.5) * cellH + jy;
      ctx.fillText(ch, px, py);
    }
  }

  // 4. Border / comments chrome. Both drawn in fg colour, monospace, lined
  //    up to the grid edges. Cheap visual flourish; pure homage.
  if(matchColour) ctx.fillStyle = params.fg;
  if(params.borders){
    const tlx = padX - cellW * 0.5, tly = padY - cellH * 0.5;
    const brx = padX + areaW + cellW * 0.5, bry = padY + areaH + cellH * 0.5;
    ctx.strokeStyle = params.fg;
    ctx.lineWidth = Math.max(1, fontSize * 0.06);
    ctx.strokeRect(tlx, tly, brx - tlx, bry - tly);
  }
  if(params.comments){
    const fs = Math.max(10, fontSize * 0.9);
    ctx.font = `500 ${fs}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = params.fg;
    ctx.fillText('/*', 6, 4);
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('*/', w - 6, h - 4);
  }

  ctx.restore();
}

// Per-mode parameter subset. The brief is explicit: each mode only animates
// the levers listed for it. Everything else holds at the user's slider value.
//   breath  : columns + gamma + grain (the legacy ANIM)
//   march   : columns alone (stepped, holds — reads as deliberate resolution drops)
//   rotate  : gamma alone, monotonic (a tonal sweep; columns hold steady)
//   pulse   : grain alone, sharp asymmetric (texture spike that decays)
//   idle    : nothing animates
function renderAt(t_loop){
  const mode = MODES.includes(params.mode) ? params.mode : 'breath';
  const env  = modeEnvelope(mode, ((t_loop % 1) + 1) % 1);

  // Snapshot the user's static-slider values so non-animated modes don't
  // drift them. We mutate during the paint and restore for non-march levers.
  const userCols  = params.columns;
  const userGamma = params.gamma;
  const userGrain = params.grain;

  if(mode === 'breath'){
    params.columns = Math.round(lerp(ANIM.columns.rest, ANIM.columns.peak, env));
    params.gamma   = lerp(ANIM.gamma.rest,   ANIM.gamma.peak,   env);
    params.grain   = lerp(ANIM.grain.rest,   ANIM.grain.peak,   env);
  } else if(mode === 'march'){
    // Stepped columns: holds at each rung. Range tightened so each rung is
    // visually distinct (24 → 48 → 72 → 96 → 110 at MARCH_STEPS=4).
    params.columns = Math.round(lerp(ANIM.columns.rest, ANIM.columns.peak, env));
  } else if(mode === 'rotate'){
    // Monotonic gamma sweep 1.5 → 0.7 → 1.5 via pingpong INSIDE the monotonic
    // envelope. We want the closed-loop property; raw t alone would jump.
    // So map env (0→1) through a cosine so endpoints match.
    const g = (1 - Math.cos(env * Math.PI * 2)) / 2;
    params.gamma = lerp(ANIM.gamma.rest, ANIM.gamma.peak, g);
  } else if(mode === 'pulse'){
    params.grain = lerp(ANIM.grain.rest, ANIM.grain.peak, env);
  }
  // idle: no mutation.

  paint(seedFromT(t_loop));

  // Reflect into GUI for the levers this mode actually drives. Don't touch
  // sliders the mode doesn't own — that would mislead the user.
  if(gui){
    if(mode === 'breath' || mode === 'march') gui.rows.get('columns')?._write(params.columns);
    if(mode === 'breath' || mode === 'rotate') gui.rows.get('gamma')?._write(Number(params.gamma.toFixed(2)));
    if(mode === 'breath' || mode === 'pulse')  gui.rows.get('grain')?._write(Number(params.grain.toFixed(2)));
  }

  // Restore user state for levers this mode didn't own — so toggling modes
  // doesn't silently overwrite the user's sliders.
  if(mode !== 'breath' && mode !== 'march')  params.columns = userCols;
  if(mode !== 'breath' && mode !== 'rotate') params.gamma   = userGamma;
  if(mode !== 'breath' && mode !== 'pulse')  params.grain   = userGrain;
}

function animationLoop(){
  if(!params.animate) return;
  if(window.PIXSource?.isVideo()) window.PIXSource.advanceFrame();
  const elapsed = performance.now() - animationStartTime;
  renderAt((elapsed % CYCLE_MS) / CYCLE_MS);
  animationId = requestAnimationFrame(animationLoop);
}

function toggleAnimation(){
  if(params.animate){
    animationStartTime = performance.now();
    animationLoop();
  } else if(animationId){
    cancelAnimationFrame(animationId);
    animationId = null;
    paint(1);
  }
}

window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt,
  pauseRender(){ if(animationId){ cancelAnimationFrame(animationId); animationId = null; } },
  resumeRender(){
    if(params.animate && !animationId){
      animationStartTime = performance.now();
      animationLoop();
    } else if(!params.animate){
      paint(1);
    }
  },
};

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    // Soft focus: the cursor becomes a local amplifier. We don't change the
    // *global* column count (that would re-flow the entire grid as the mouse
    // moves — visually jarring). Instead, paint() consults `focusX/focusY` +
    // `focusActive` and locally boosts per-cell ink density via a Gaussian
    // falloff. The lens reveals "more detail near the cursor" without re-
    // sampling. Cheap, smooth, and the cursor stays the obvious agent.
    paint(1);
  }
}

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){ toggleAnimation(); return; }
    if(key === 'fit' || key === 'bg') window.PIXSource?.setParam(key, params[key]);
    if(window.PIXState && window.PIXState.isShared(key)) window.PIXState.set(key, params[key]);
    if(!params.animate) paint(1);
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => { if(!params.animate) paint(1); });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-ascii',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  cv.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', () => { fitCanvas(); paint(1); });
  fitCanvas();
  paint(1);
}

document.addEventListener('DOMContentLoaded', init);
