// pixart/cellular — port of tooooools.app/effects/cellular-automata.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/cellular-automata/page-b74913d968c06cb2.js,
//  shared preprocessor + page defaults in /_next/static/chunks/9357-*.js).
//
// What the reference effect is:
//   1. The preprocessed source is rasterised into a coarse grid of `cellSize`
//      pixel blocks. A cell is seeded ALIVE (1) iff ANY pixel inside the block
//      has luminance ((R+G+B)/3) <= `threshold`. Otherwise DEAD (0).
//   2. The grid is stepped through `steps` CA generations using one of four
//      rulesets selected by `neighborhoodType`. We ship Classic by default
//      (Conway-variant: Birth 3, Survive 1..8).
//   3. Paint: white background, black 1px-overlapped rect per alive cell.
//
// Step 2 (pattern-set): animation + interactive cursor layered on top, matching
// the bevel pattern (applyMode / applyInteractive / renderAt / WAEffect.cycleMs).
//
// Defaults — swept against portrait.jpg in the browser:
//   threshold=128 cellSize=3 steps=2 whitePoint=255
// At those values the portrait reads clearly through the CA pattern, and the
// CA texture (granular black-and-white cell mosaic) is unmistakable. Lower
// `steps` shows the raw threshold poster; higher `steps` dissolves the face.
//
// Animation modes (each = 15 s loop; envelopes oscillate around USER values
// so moving sliders while animate is on keeps working):
//
//   evolve  — steps slowly ramps 0 → base+sweep → 0. CA naturally evolves
//             across generations. Endpoints meet (cosine envelope).
//   tone    — whitePoint drifts 255 ↔ 130 (cosine). Shifts what the seeder
//             reads as alive: brighter highlights flip on and off.
//   bloom   — threshold pingpongs 90 ↔ 165 around base=128. Cells emerge
//             from the dark regions and recede.
//
// Interactive: cursor X → threshold (50..200), cursor Y → cellSize (2..10).
// Metaphor: the cursor IS the seed lens — left/right changes what counts as
// alive, up/down changes the cell grain.
'use strict';

const CYCLE_MS = 20000;

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
  // CA core
  threshold:         128,
  cellSize:          3,
  steps:             2,
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
  // Step 2 controls
  animate:           false,
  mode:              'evolve',
  interactive:       false,
  // Paint
  showEffect:        true,
  // Shared chrome
  fit:               'cover',
  bg:                '#0a0a0a',
};
const ALIVE_COLOR = '#000000';
const DEAD_COLOR  = '#ffffff';
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let lumGrid = null;
let grid = null;
let gridB = null;
let gridW = 0, gridH = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

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
      const n = (0.5 - Math.random()) * g * 255;
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
    lumGrid[j] = (px[i] + px[i+1] + px[i+2]) / 3;
  }
}

// ---------- seed grid ----------
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
    const y0c = cy * cs;
    const y1c = Math.min(H, y0c + cs);
    for(let cx = 0; cx < gridW; cx++){
      const x0c = cx * cs;
      const x1c = Math.min(W, x0c + cs);
      let alive = 0;
      outer:
      for(let y = y0c; y < y1c; y++){
        const row = y * W;
        for(let x = x0c; x < x1c; x++){
          if(lumGrid[row + x] <= th){ alive = 1; break outer; }
        }
      }
      grid[cy * gridW + cx] = alive;
    }
  }
}

// ---------- CA rules ----------
function classicStep(src, dst){
  const w = gridW, h = gridH;
  const sL = params.surviveLowerBound, sU = params.surviveUpperBound;
  const bL = params.birthLowerBound,   bU = params.birthUpperBound;
  for(let y = 0; y < h; y++){
    const yU = (y - 1 + h) % h, yD = (y + 1) % h;
    const rU = yU * w, rC = y * w, rD = yD * w;
    for(let x = 0; x < w; x++){
      const xL = (x - 1 + w) % w, xR = (x + 1) % w;
      const n = src[rU+xL]+src[rU+x]+src[rU+xR]
              + src[rC+xL]+           src[rC+xR]
              + src[rD+xL]+src[rD+x]+src[rD+xR];
      const alive = src[rC + x];
      dst[rC + x] = alive
        ? (n >= sL && n <= sU ? 1 : 0)
        : (n >= bL && n <= bU ? 1 : 0);
    }
  }
}

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

function mnccStep(src, dst){
  const w = gridW, h = gridH;
  const lows  = [params.mnccThreshold1Lower, params.mnccThreshold2Lower, params.mnccThreshold3Lower, params.mnccThreshold4Lower];
  const highs = [params.mnccThreshold1Upper, params.mnccThreshold2Upper, params.mnccThreshold3Upper, params.mnccThreshold4Upper];
  for(let y = 0; y < h; y++){
    for(let x = 0; x < w; x++){
      const m = [ringMean(src,x,y,1), ringMean(src,x,y,2), ringMean(src,x,y,3), ringMean(src,x,y,4)];
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
  window.WAGUI?.flashValues(params);
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

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const cw = dw / gridW;
  const ch = dh / gridH;

  ctx.fillStyle = DEAD_COLOR;
  ctx.fillRect(ox, oy, dw, dh);

  ctx.fillStyle = ALIVE_COLOR;
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

// ---------- animation + interactive ----------
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'evolve'){
    // steps cosine 0 → base+4 → 0. Floor to int so the CA actually re-runs
    // generations. Endpoints (t=0,1) both produce steps=base (well, =0 here
    // since pingPong(0)=pingPong(1)=0), so the loop closes byte-equal.
    const base = params.steps;
    const peak = 6; // base+4 from the swept-safe band 0..5 plus a touch
    params.steps = Math.round(pingPong(t01) * peak);
    return () => { params.steps = base; };
  }
  if(mode === 'tone'){
    // whitePoint 130..255. Mid (t=0,1) = 255 (default), peak (t=0.5) = 130.
    const base = params.whitePoint;
    params.whitePoint = 255 - 125 * pingPong(t01);
    return () => { params.whitePoint = base; };
  }
  if(mode === 'bloom'){
    // threshold 90 ↔ 165 around base=128. Cosine pingpong → endpoints meet.
    const base = params.threshold;
    params.threshold = 128 + 37 * Math.cos(t01 * Math.PI * 2);
    return () => { params.threshold = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseTh = params.threshold;
  const baseCs = params.cellSize;
  params.threshold = 50 + ax * 150;        // 50..200
  params.cellSize  = Math.round(2 + ay * 8); // 2..10
  return () => { params.threshold = baseTh; params.cellSize = baseCs; };
}

// Track if last frame baked tone-modulated whitePoint into preprocessed buffer.
let preprocessedIsToneModulated = false;
function renderAt(t01){
  // tone modulates whitePoint (a preprocessor key) → re-run preprocess.
  // Interactive cellSize also affects seedGrid sizing (handled in build).
  const isTone = params.animate && params.mode === 'tone';
  const needsPre = isTone || preprocessedIsToneModulated;
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  if(needsPre) preprocess();
  buildGrid();
  paint();
  restoreInt();
  restoreMode();
  preprocessedIsToneModulated = isTone;
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

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else { paint(); }
    return cv;
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
const PAINT_KEYS = new Set(['showEffect']);

// Each ruleset family owns its own bounds sliders. Hiding the inactive ones
// keeps the panel scoped to controls that actually affect output.
function familyOf(key){
  if(/^ltl/i.test(key)) return 'LTL';
  if(/^mnca/i.test(key)) return 'MNCAB';
  if(/^mncc/i.test(key)) return 'MNCC';
  if(['surviveLowerBound','surviveUpperBound','birthLowerBound','birthUpperBound'].includes(key)){
    return 'Classic';
  }
  return null;
}
function applyFamilyVisibility(){
  const active = params.neighborhoodType || 'Classic';
  document.querySelectorAll('.wg-row[data-key]').forEach(row => {
    const fam = familyOf(row.dataset.key);
    if(fam === null) return;
    row.style.display = (fam === active) ? '' : 'none';
  });
}

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  applyFamilyVisibility();
  gui.on((key) => {
    if(key === 'neighborhoodType'){ applyFamilyVisibility(); /* fall through to repaint */ }
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('paint'); }
      return;
    }
    if(key === 'mode'){
      if(!params.animate) schedule('paint');
      return;
    }
    if(key === 'interactive'){
      if(!params.animate) schedule('paint');
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
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-cellular',
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
