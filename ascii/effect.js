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

  for(let y = 0; y < rows; y++){
    for(let x = 0; x < cols; x++){
      const i = (y * cols + x) * 4;
      const r8 = data[i], g8 = data[i+1], b8 = data[i+2];
      // Rec. 709 luma — matches what humans perceive as "brightness".
      const lum = 0.2126 * r8 + 0.7152 * g8 + 0.0722 * b8;
      const ch = rampChar(lum, ramp);
      if(ch === ' ') continue; // skip the void — pure background cells
      if(matchColour){
        ctx.fillStyle = `rgb(${r8|0},${g8|0},${b8|0})`;
      }
      const px = padX + (x + 0.5) * cellW;
      const py = padY + (y + 0.5) * cellH;
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

function renderAt(t_loop){
  // Apply animation envelopes and paint with a deterministic grain seed so
  // export frames are reproducible and the loop closes at t=0 === t=1.
  const t01 = pingpongT01(t_loop);
  // Snapshot params we'll mutate so the UI doesn't permanently shift.
  const savedCols = params.columns;
  const savedGamma = params.gamma;
  const savedGrain = params.grain;
  params.columns = Math.round(lerp(ANIM.columns.rest, ANIM.columns.peak, t01));
  params.gamma   = lerp(ANIM.gamma.rest, ANIM.gamma.peak, t01);
  params.grain   = lerp(ANIM.grain.rest, ANIM.grain.peak, t01);
  paint(seedFromT(t_loop));
  // Reflect into GUI sliders so the user sees the animation drive them.
  if(gui){
    gui.rows.get('columns')?._write(params.columns);
    gui.rows.get('gamma')?._write(Number(params.gamma.toFixed(2)));
    gui.rows.get('grain')?._write(Number(params.grain.toFixed(2)));
  }
  // Restore originals so toggling animate off returns user state — wait,
  // actually we WANT the animated values to update the visible sliders. The
  // user can re-set them after stopping. Keep mutation.
  void savedCols; void savedGamma; void savedGrain;
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
    // X drives columns (16..160), Y drives gamma (0.4..2.0). Both are the
    // levers with the most visible payoff per pixel of mouse travel.
    const ax = clamp(mouseX / r.width, 0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    const nc = Math.round(16 + ax * (160 - 16));
    const ng = Number((0.4 + ay * (2.0 - 0.4)).toFixed(2));
    let touched = false;
    if(nc !== params.columns){ params.columns = nc; touched = true; gui?.rows.get('columns')?._write(nc); }
    if(ng !== params.gamma){ params.gamma = ng; touched = true; gui?.rows.get('gamma')?._write(ng); }
    if(touched) paint(1);
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
