// pixart/cellular — port of tooooools.app/effects/cellular-automata.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/cellular-automata/page-b74913d968c06cb2.js,
//  shared preprocessor + page defaults in /_next/static/chunks/9357-*.js).
//
// What the reference effect is:
//   1. The preprocessed source is rasterised into a coarse grid of `cellSize`
//      pixel blocks. A cell is seeded ALIVE (1) iff ANY pixel inside the block
//      has luminance ((R+G+B)/3) <= `threshold`. Otherwise DEAD (0). The
//      reference scans the block in raster order and short-circuits on the
//      first hit (`if(...) return !0`).
//   2. The grid is stepped through `steps` CA generations using one of four
//      rulesets selected by `neighborhoodType`:
//        - "Classic"  — Moore-3×3 totalistic Bx/Sy (Conway is Survive 2–3,
//                       Birth 3–3; the bundle ships Survive 1..8, Birth 3..3,
//                       a Conway variant that lets isolated live cells
//                       persist for richer image-shaped texture).
//        - "LTL"      — Larger-Than-Life: same idea on an 11×11 (radius-5)
//                       Moore neighbourhood (range 0..120).
//                       Bundle defaults: B 15..91, S 47..102.
//        - "MNCAB"    — Multiple Neighbourhoods CA "Both": average ring at
//                       radius 1 AND radius 2 against [t1..t2]; alive if
//                       either ring falls in the band.
//        - "MNCC"     — Multiple Neighbourhoods CA Chained: average rings at
//                       radii 1,2,3,4; each ring whose mean lies in
//                       [Nk_low..Nk_high] FLIPS the cell. Up to 4 flips.
//   3. Boundaries wrap toroidally (`(i + L) % L` in the bundle).
//   4. Paint: white background, black 1px-overlapped rect per alive cell
//      (`rect(x, y, cw+1, ch+1)` — the +1 hides cell-grid seams).
//
// Bundle defaults (pageStates["/effects/cellular-automata"]):
//   showEffect: true, threshold: 128, cellSize: 2, steps: 1,
//   neighborhoodType: "Classic",
//   surviveLowerBound: 1, surviveUpperBound: 8,
//   birthLowerBound:   3, birthUpperBound:   3,
//   ltlSurviveLower:  47, ltlSurviveUpper:  102,
//   ltlBirthLower:    15, ltlBirthUpper:    91,
//   mncaThreshold1:  0.35, mncaThreshold2:  0.70,
//   mnccThreshold1Lower: 0.262, mnccThreshold1Upper: 0.903,
//   mnccThreshold2Lower: 0.342, mnccThreshold2Upper: 0.378,
//   mnccThreshold3Lower: 0.342, mnccThreshold3Upper: 0.382,
//   mnccThreshold4Lower: 0.889, mnccThreshold4Upper: 0.978,
//   + preprocessor inheritance (canvasSize 600, blur 0, grain 0, gamma 1,
//   blackPoint 0, whitePoint 255).
//
// Loop-closure: the CA is a pure function of (preprocessed source, params).
// It's NOT a continuously-evolving simulation across frames — each frame
// reseeds from the source and runs N generations. For the 15s breathing
// loop we animate `steps` on a cosine pingpong (base → base+sweep → base)
// so the endpoints meet identically. renderAt(0) === renderAt(1) byte-equal.
//
// Determinism: no RNG in the CA itself; only the preprocessor's grain stage
// uses RNG, and that's mulberry32(seedFromT(tLoop)) — same scheme as edge.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (shared with Displace / Edge / Ascii).
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // CA — bundle-shipped defaults (cellSize/steps lifted slightly so the
  // first paint reads as "obviously a CA pass" on a 1280×720 canvas).
  threshold:         128,
  cellSize:          3,    // bundle ships 2
  steps:             2,    // bundle ships 1
  neighborhoodType:  'Classic',
  surviveLowerBound: 1,
  surviveUpperBound: 8,
  birthLowerBound:   3,
  birthUpperBound:   3,
  ltlSurviveLower:   47,
  ltlSurviveUpper:   102,
  ltlBirthLower:     15,
  ltlBirthUpper:     91,
  mncaThreshold1:    0.35,
  mncaThreshold2:    0.70,
  mnccThreshold1Lower: 0.262, mnccThreshold1Upper: 0.903,
  mnccThreshold2Lower: 0.342, mnccThreshold2Upper: 0.378,
  mnccThreshold3Lower: 0.342, mnccThreshold3Upper: 0.382,
  mnccThreshold4Lower: 0.889, mnccThreshold4Upper: 0.978,
  // Paint
  aliveColor:        '#000000',
  deadColor:         '#ffffff',
  showEffect:        true,
  // Loop-animation amplitude (extra generations swept on top of `steps`).
  stepsSweep:        8,
  // Shared chrome
  animate:           false,
  interactive:       false,
  fit:               'cover',
  bg:                '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let preprocessed = null;
let lumGrid = null;         // Float32Array of preprocessed luminance
let grid = null;            // Uint8Array of cell state (alive=1, dead=0)
let gridB = null;           // Back buffer for double-buffered stepping
let gridW = 0, gridH = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

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
    if(dirty.build) buildGrid();
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

  // Bundle uses unweighted (R+G+B)/3 (NOT the alpha-composited luminance
  // Displace/Edge use). Keep parity here for visual fidelity.
  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    lumGrid[j] = (px[i] + px[i+1] + px[i+2]) / 3;
  }
}

// ---------- seed cell grid from preprocessed luminance ----------
// Mirrors bundle's `seedGrid`: for each cell (cy, cx), scan its
// `cellSize × cellSize` source block; if ANY pixel has lum <= threshold,
// the cell is alive. Dark-leaning — image's dark regions seed life.
function seedGrid(){
  if(!preprocessed){ gridW = gridH = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const cs = Math.max(1, params.cellSize | 0);
  gridW = Math.ceil(W / cs);
  gridH = Math.ceil(H / cs);
  const N = gridW * gridH;
  if(!grid || grid.length !== N){
    grid  = new Uint8Array(N);
    gridB = new Uint8Array(N);
  }
  const th = params.threshold;
  for(let cy = 0; cy < gridH; cy++){
    const y0 = cy * cs;
    const y1 = Math.min(H, y0 + cs);
    for(let cx = 0; cx < gridW; cx++){
      const x0 = cx * cs;
      const x1 = Math.min(W, x0 + cs);
      let alive = 0;
      outer:
      for(let y = y0; y < y1; y++){
        const row = y * W;
        for(let x = x0; x < x1; x++){
          if(lumGrid[row + x] <= th){ alive = 1; break outer; }
        }
      }
      grid[cy * gridW + cx] = alive;
    }
  }
}

// Classic Moore-3×3 totalistic (8 neighbours, toroidal).
function classicStep(src, dst){
  const w = gridW, h = gridH;
  const sL = params.surviveLowerBound, sU = params.surviveUpperBound;
  const bL = params.birthLowerBound,   bU = params.birthUpperBound;
  for(let y = 0; y < h; y++){
    const yU = (y - 1 + h) % h, yD = (y + 1) % h;
    const rU = yU * w, rC = y * w, rD = yD * w;
    for(let x = 0; x < w; x++){
      const xL = (x - 1 + w) % w, xR = (x + 1) % w;
      const n =
        src[rU + xL] + src[rU + x] + src[rU + xR] +
        src[rC + xL]                + src[rC + xR] +
        src[rD + xL] + src[rD + x] + src[rD + xR];
      const alive = src[rC + x];
      dst[rC + x] = alive
        ? (n >= sL && n <= sU ? 1 : 0)
        : (n >= bL && n <= bU ? 1 : 0);
    }
  }
}

// LTL — 11×11 Moore (radius 5). Naive O(w·h·121); fine for our grids.
function ltlStep(src, dst){
  const w = gridW, h = gridH;
  const sL = params.ltlSurviveLower, sU = params.ltlSurviveUpper;
  const bL = params.ltlBirthLower,   bU = params.ltlBirthUpper;
  const R = 5;
  for(let y = 0; y < h; y++){
    for(let x = 0; x < w; x++){
      let n = 0;
      for(let dy = -R; dy <= R; dy++){
        const yy = (y + dy + h) % h;
        const row = yy * w;
        for(let dx = -R; dx <= R; dx++){
          if(dx === 0 && dy === 0) continue;
          const xx = (x + dx + w) % w;
          n += src[row + xx];
        }
      }
      const alive = src[y * w + x];
      dst[y * w + x] = alive
        ? (n >= sL && n <= sU ? 1 : 0)
        : (n >= bL && n <= bU ? 1 : 0);
    }
  }
}

// Ring mean at radius r — bundle's helper `h()`: mean over the (2r+1)² block
// minus centre. Denominator = (2r+1)² − 1.
function ringMean(src, x, y, r){
  const w = gridW, h = gridH;
  let sum = 0, cnt = 0;
  for(let dy = -r; dy <= r; dy++){
    const yy = (y + dy + h) % h;
    const row = yy * w;
    for(let dx = -r; dx <= r; dx++){
      if(dx === 0 && dy === 0) continue;
      const xx = (x + dx + w) % w;
      sum += src[row + xx];
      cnt++;
    }
  }
  return cnt ? sum / cnt : 0;
}

// MNCAB — alive iff radius-1 mean OR radius-2 mean lies in [t1..t2].
function mncabStep(src, dst){
  const w = gridW, h = gridH;
  const t1 = params.mncaThreshold1, t2 = params.mncaThreshold2;
  for(let y = 0; y < h; y++){
    for(let x = 0; x < w; x++){
      const m1 = ringMean(src, x, y, 1);
      const m2 = ringMean(src, x, y, 2);
      const ok1 = (m1 >= t1 && m1 <= t2);
      const ok2 = (m2 >= t1 && m2 <= t2);
      dst[y * w + x] = (ok1 || ok2) ? 1 : 0;
    }
  }
}

// MNCC — chained parity flips from rings 1..4.
function mnccStep(src, dst){
  const w = gridW, h = gridH;
  const lows  = [params.mnccThreshold1Lower, params.mnccThreshold2Lower, params.mnccThreshold3Lower, params.mnccThreshold4Lower];
  const highs = [params.mnccThreshold1Upper, params.mnccThreshold2Upper, params.mnccThreshold3Upper, params.mnccThreshold4Upper];
  for(let y = 0; y < h; y++){
    for(let x = 0; x < w; x++){
      const m = [
        ringMean(src, x, y, 1),
        ringMean(src, x, y, 2),
        ringMean(src, x, y, 3),
        ringMean(src, x, y, 4),
      ];
      let s = src[y * w + x];
      for(let k = 0; k < 4; k++){
        if(m[k] >= lows[k] && m[k] <= highs[k]) s = 1 - s;
      }
      dst[y * w + x] = s;
    }
  }
}

function stepOnce(){
  switch(params.neighborhoodType){
    case 'LTL':   ltlStep(grid, gridB); break;
    case 'MNCAB': mncabStep(grid, gridB); break;
    case 'MNCC':  mnccStep(grid, gridB); break;
    case 'Classic':
    default:      classicStep(grid, gridB); break;
  }
  const tmp = grid; grid = gridB; gridB = tmp;
}

function buildGrid(){
  seedGrid();
  const steps = Math.max(0, params.steps | 0);
  for(let i = 0; i < steps; i++) stepOnce();
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

  if(!grid || gridW === 0){ ctx.restore(); return; }

  // Fit grid into canvas with `contain` so cells stay square.
  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const cw = dw / gridW;
  const ch = dh / gridH;

  // Dead background tile (bundle: white).
  ctx.fillStyle = params.deadColor;
  ctx.fillRect(ox, oy, dw, dh);

  // Alive cells (bundle: black, rect(x, y, cw+1, ch+1) — +1 hides seams).
  ctx.fillStyle = params.aliveColor;
  const cwR = Math.ceil(cw) + 1;
  const chR = Math.ceil(ch) + 1;
  for(let cy = 0; cy < gridH; cy++){
    const py = oy + Math.floor(cy * ch);
    const row = cy * gridW;
    for(let cx = 0; cx < gridW; cx++){
      if(grid[row + cx] === 1){
        const px = ox + Math.floor(cx * cw);
        ctx.fillRect(px, py, cwR, chR);
      }
    }
  }

  ctx.restore();
}

// ---------- animation ----------
//
// 15s seamless loop: `steps` pingpongs base → base+sweep → base across the
// cycle. Endpoints meet because (1 − cos(2π t))/2 = 0 at both t=0 and t=1
// (and we explicitly collapse t=1 to t=0 to dodge IEEE-754 epsilon).
function pingpongT01(t){
  let w = t - Math.floor(t);
  if(w === 1) w = 0;
  return (1 - Math.cos(w * 2 * Math.PI)) / 2;
}

function applyAnimationT(tLoop){
  const t01 = pingpongT01(tLoop);
  return { steps: Math.round(params.steps + params.stepsSweep * t01) };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  const restSteps = params.steps;
  params.steps = anim.steps;

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
  buildGrid();
  paint();

  params.steps = restSteps;
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
const BUILD_KEYS = new Set([
  'threshold','cellSize','steps','neighborhoodType',
  'surviveLowerBound','surviveUpperBound','birthLowerBound','birthUpperBound',
  'ltlSurviveLower','ltlSurviveUpper','ltlBirthLower','ltlBirthUpper',
  'mncaThreshold1','mncaThreshold2',
  'mnccThreshold1Lower','mnccThreshold1Upper',
  'mnccThreshold2Lower','mnccThreshold2Upper',
  'mnccThreshold3Lower','mnccThreshold3Upper',
  'mnccThreshold4Lower','mnccThreshold4Upper',
]);
const PAINT_KEYS = new Set(['aliveColor','deadColor','showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    // X → threshold (0..255), Y → steps (0..20). Two most expressive knobs.
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    const nt = Math.round(ax * 255);
    const ns = Math.round((1 - ay) * 20);
    let touched = false;
    if(nt !== params.threshold){
      params.threshold = nt; touched = true;
      gui?.rows.get('threshold')?._write(nt);
    }
    if(ns !== params.steps){
      params.steps = ns; touched = true;
      gui?.rows.get('steps')?._write(ns);
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
      canvas: cv, name: 'pixart-cellular',
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
