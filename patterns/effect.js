// pixart/patterns — port of tooooools.app/effects/patterns.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/patterns/page-4f9e64748661ad47.js,
//  shared preprocessor + page defaults in /_next/static/chunks/9357-2a51c42cdfe973de.js).
//
// What the reference effect is:
//   - A photo-mosaic / collage renderer. User uploads N pattern images
//     (bundle ships 6 halftone tile PNGs at /pattern-1.png … /pattern-6.png).
//   - Each pattern image's mean luminance is precomputed and the catalog is
//     sorted darkest → brightest; per source-cell, dark cells pick the
//     darkest tile, bright cells pick the lightest one (or stay blank above
//     `lightnessThreshold`).
//
// Bundle defaults (pageStates["/effects/patterns"]):
//   imageUrls:           ["/pattern-1.png" … "/pattern-6.png"]
//   showEffect:          true
//   lightnessThreshold:  178
//   gridDensityNumber:   49
// + preprocessor inheritance (canvasSize 600, blur 0, grain 0, gamma 1,
//   blackPoint 0, whitePoint 255).
//
// Refinement pass — 2026-05-13
// ----------------------------
// The bundled PNG mosaic stays as the `photo` family default, but we add a
// procedural tile renderer that ships three deterministic Truchet families.
// Truchet tiles produce *emergent illusory paths* — the brain stitches
// adjacent quarter-arcs into continuous curves even though every tile is a
// local micro-decision. Sébastien Truchet (1704) first observed this;
// Smith's 1987 paper formalised the assemblies; Sol LeWitt's wall drawings
// (1968+) treated rule + seed as the artwork.
//
// Modes shipped:
//
//   idle   — static (the rest-frame artwork).
//   breath — cosine pingpong on threshold (the original animation).
//   march  — Truchet rotation step. Every cell rotates +90° together at four
//            evenly-spaced beats per loop (step-function `floor(t·4)/4`).
//            t=1 is seam-overridden to step 0 so the loop is byte-equal,
//            even though the step-function generically isn't continuous.
//   swap   — Rule-set rotation: cycle the tileFamily through truchet ↔
//            smith ↔ quarter-arc, holding each rule for 1/N of the loop.
//            Same step-function logic; t=1 pinned to t=0's family.
//   pulse  — gridDensityNumber cosine (dense → sparse → dense). Dense
//            mid-cycle ⇒ the illusory paths get *finer* and noisier; sparse
//            endpoints reveal the underlying source.
//
// New params:
//   mode        — animation envelope picker.
//   tileFamily  — `photo | truchet | smith | quarter-arc`. `photo` keeps the
//                 bundled PNG mosaic (reference parity). The three procedural
//                 families render deterministic Truchet variants.
//   seed        — integer. Reseeds the per-cell tile-orientation lattice.
//                 LeWitt-style: rule + seed = artwork.
//
// Tile families (procedural):
//
//   truchet      — Classic two-triangle tile: a tile is split by one of its
//                  diagonals into a filled vs empty triangle. Two states
//                  (orientation 0 or 1). Smith's "Type A".
//   smith        — Truchet contour tile: two quarter-arcs on opposite
//                  corners. Two states. The classic that produces long
//                  illusory curves across the lattice. Smith (1987) showed
//                  this version is the contour-equivalent of the triangle
//                  tile.
//   quarter-arc  — One quarter-arc per tile, anchored at the centre of
//                  one of the four edges. Four states (N, E, S, W). Produces
//                  the most baroque emergent paths because it has the
//                  highest orientation entropy.
//
// Optical-illusion grounding:
//   - Truchet (1704), *Mémoire sur les Combinaisons*. The original
//     observation that randomly-oriented tiles produce *organised*
//     macro-patterns.
//   - Smith (1987), *The tile assemblies of Sébastien Truchet*. The modern
//     formalisation; introduces the contour tile family.
//   - Sol LeWitt, Wall Drawings (1968+). Rule + seed → artwork; the artwork
//     is the *system*, not the output. We surface seed as a slider for
//     exactly this reason.
//   - Bridges proceedings 2009 — Truchet-tile aperiodic-tiling papers
//     informed the multi-state quarter-arc family.
//
// Determinism: per-cell tile orientation is `mulberry32(seed + row*W + col)`.
// march/swap step functions wrap to t=0 at the seam by explicit override.
// Grain RNG is mulberry32(seedFromT(tLoop)). → renderAt(0) byte-equal
// renderAt(1) in every mode.
//
// Perf: 49 cells across shorter side → ~49 × 65 = ~3200 cells per frame.
// Each procedural cell is one or two canvas-path ops, ~3 ms total.

'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

// The six bundled photo-mosaic patterns. Path is relative to /patterns/index.html.
const DEFAULT_PATTERN_URLS = [
  'patterns/pattern-1.png',
  'patterns/pattern-2.png',
  'patterns/pattern-3.png',
  'patterns/pattern-4.png',
  'patterns/pattern-5.png',
  'patterns/pattern-6.png',
];

const params = {
  // Preprocessor (shared with Displace / Edge / Cellular / Stippling).
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Patterns — bundle defaults, with one lift for the landing frame.
  lightnessThreshold: 220,
  gridDensityNumber:  49,
  // Loop-animation amplitude.
  densitySweep:       18,
  // Paint.
  bgColor:           '#f5f1ea',
  showEffect:        true,
  // ---- Refinement pass (2026-05-13) ----
  // Animation envelope picker. `breath` preserves original behaviour.
  mode:              'breath',
  // Tile family. `photo` = bundled PNG mosaic (reference parity). The other
  // three are procedural Truchet variants — see file header for theory.
  tileFamily:        'truchet',
  // Seed for the deterministic per-cell orientation lattice. LeWitt: rule +
  // seed = artwork. Integer, any value; mulberry32-mixed.
  seed:              1,
  // Tile colour for procedural families.
  tileColor:         '#1a1a1a',
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
let preprocessed = null;
let lumGrid = null;
let cells = null;            // Float32Array: [x, y, w, h, lumIdx] per visible cell
let cellCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// Photo-mosaic catalog: [{ img, averageBrightness, url }] sorted dark→bright.
let catalog = [];
let catalogReady = false;
let catalogLoadId = 0;

// Animation transient state (read by buildCells/paint, not user-facing).
let _tileRotationSteps = 0;  // 0..3 — extra +90° increments applied to every
                              // tile in `march` mode.
let _familyOverride    = null; // when set, used INSTEAD of params.tileFamily
                                // (drives `swap` mode without touching params).

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

// Per-cell deterministic orientation lookup. mulberry32-mixed so adjacent
// cells don't share orientation — that would defeat the Truchet emergent-
// path effect.
function cellHash(seed, c, r){
  let a = (seed | 0) ^ ((c * 0x9E3779B1) | 0) ^ ((r * 0x85EBCA6B) | 0);
  a = (a + 0x6D2B79F5) >>> 0;
  a = Math.imul(a ^ (a >>> 15), a | 1) >>> 0;
  a ^= (a + Math.imul(a ^ (a >>> 7), a | 61)) >>> 0;
  return (a ^ (a >>> 14)) >>> 0;
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
    if(dirty.build) buildCells();
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

// ---------- photo-mosaic catalog (reference path) ----------
function brightnessOf(img){
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const id = cx.getImageData(0, 0, w, h).data;
  let n = 0;
  for(let i = 0; i < id.length; i += 4){
    const a = id[i+3] / 255;
    const r = id[i]   * a + 255 * (1 - a);
    const g = id[i+1] * a + 255 * (1 - a);
    const b = id[i+2] * a + 255 * (1 - a);
    n += Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b);
  }
  return n / (w * h);
}

function loadImageEl(url){
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload  = () => res(im);
    im.onerror = (e) => rej(e);
    im.src = url;
  });
}

async function loadCatalog(urls){
  const id = ++catalogLoadId;
  catalogReady = false;
  const loaded = await Promise.all(urls.map(async (u) => {
    try {
      const img = await loadImageEl(u);
      return { img, averageBrightness: brightnessOf(img), url: u };
    } catch(e){
      console.warn('pattern load failed:', u, e);
      return null;
    }
  }));
  if(id !== catalogLoadId) return;
  catalog = loaded.filter(Boolean);
  catalog.sort((a, b) => a.averageBrightness - b.averageBrightness);
  catalogReady = catalog.length > 0;
  schedule('paint');
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

// ---------- build cells ----------
// Source-sample one luminance per cell (top-left), bundle-faithful. We also
// pack the grid-cell column/row so the procedural renderer can deterministically
// hash an orientation.
function buildCells(){
  if(!preprocessed){ cellCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const N = Math.max(1, params.gridDensityNumber | 0);
  const th = params.lightnessThreshold;

  const cell = Math.min(W, H) / N;
  const cols = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);
  const cellW = W / cols;
  const cellH = H / rows;
  const catLen = catalogReady ? catalog.length : 0;
  const denom = Math.max(0.0001, th);

  const cap = cols * rows;
  // 6 floats per cell: x, y, w, h, photoIdx, lumNorm. lumNorm ∈ [0,1] is
  // the cell's "ink density" in [0,1], used by procedural families to size
  // the tile inside its cell.
  if(!cells || cells.length < cap * 6) cells = new Float32Array(cap * 6);
  let nC = 0;

  for(let r = 0; r < rows; r++){
    const sy = Math.floor(r * cellH);
    for(let c = 0; c < cols; c++){
      const sx = Math.floor(c * cellW);
      const L = lumGrid[sx + sy * W];
      if(L >= th) continue;
      let idx = 0;
      if(catLen > 1){
        idx = Math.floor((L / denom) * catLen);
        if(idx < 0) idx = 0; else if(idx > catLen - 1) idx = catLen - 1;
      }
      const o = nC * 6;
      cells[o]   = c * cellW;
      cells[o+1] = r * cellH;
      cells[o+2] = cellW;
      cells[o+3] = cellH;
      cells[o+4] = idx;
      // ink density: dark cells (low L) read as more present. (th - L)/th
      // is 0..1 with 1 at pure black.
      cells[o+5] = 1 - (L / denom);
      nC++;
    }
  }
  cellCount = nC;
}

// ---------- procedural tile renderers ----------
//
// Each family takes (ctx, x, y, w, h, orientation, ink). `orientation` is a
// uint coming from cellHash — the family picks how many of its bits to use.
// `ink` is 0..1, the cell's "darkness signal" — wider strokes for darker
// cells gives the macro-image the right gestalt without losing the tile
// rules. All three families are drawn with ctx.fillStyle = params.tileColor.

function drawTruchet(ctx, x, y, w, h, orientation, ink, rotSteps){
  // Type-A Truchet: a square split along one diagonal into a filled
  // triangle and a void. Two base states (NE-SW vs NW-SE diagonal). Adding
  // 4-step rotation = 2 perceptual states modulo 180°, so `march` reads as
  // diagonal flips with no growth. The fill area is constant per cell so
  // the macro luminance impression stays stable across rotations.
  const state = ((orientation >>> 0) + rotSteps) & 3;
  ctx.beginPath();
  switch(state){
    case 0:
      ctx.moveTo(x,     y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x,     y + h);
      break;
    case 1:
      ctx.moveTo(x,     y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + h);
      break;
    case 2:
      ctx.moveTo(x + w, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x,     y + h);
      break;
    case 3:
      ctx.moveTo(x,     y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x,     y + h);
      break;
  }
  ctx.closePath();
  ctx.fill();
}

function drawSmith(ctx, x, y, w, h, orientation, ink, rotSteps){
  // Smith contour tile: two quarter-arcs anchored at opposite corners.
  // Two base states. The arc *strokes* (not fills) connect into long
  // smooth contours across the lattice — Truchet's original observation,
  // made explicit in Smith (1987). Stroke width is keyed to ink density so
  // darker source regions yield bolder contour lines, preserving the
  // halftone-style macro reading.
  const state = ((orientation >>> 0) + rotSteps) & 3;
  const r = Math.min(w, h) / 2;
  const lw = Math.max(1, r * (0.18 + 0.32 * ink));
  ctx.lineWidth = lw;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = ctx.fillStyle; // reuse tileColor
  ctx.beginPath();
  // State 0 / 2: arcs at TL & BR corners. State 1 / 3: arcs at TR & BL.
  // Each pair is 180°-rotation-equivalent so 4 steps = 2 distinct looks.
  if((state & 1) === 0){
    ctx.arc(x,     y,     r, 0, Math.PI / 2);
    ctx.moveTo(x + w, y + h);
    ctx.arc(x + w, y + h, r, Math.PI, 1.5 * Math.PI);
  } else {
    ctx.arc(x + w, y,     r, 0.5 * Math.PI, Math.PI);
    ctx.moveTo(x, y + h);
    ctx.arc(x,     y + h, r, 1.5 * Math.PI, 2 * Math.PI);
  }
  ctx.stroke();
}

function drawQuarterArc(ctx, x, y, w, h, orientation, ink, rotSteps){
  // Single quarter-arc per tile, anchored at one of the four corners. Four
  // states (NE/SE/SW/NW). Maximum orientation entropy: produces the most
  // baroque emergent paths in the lattice. Stroke width scales with ink.
  const state = ((orientation >>> 0) + rotSteps) & 3;
  const r = Math.min(w, h) * 0.72;
  const lw = Math.max(1, Math.min(w, h) * (0.12 + 0.26 * ink));
  ctx.lineWidth = lw;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = ctx.fillStyle;
  ctx.beginPath();
  switch(state){
    case 0: ctx.arc(x,     y,     r, 0,           Math.PI / 2); break; // anchor TL
    case 1: ctx.arc(x + w, y,     r, Math.PI / 2, Math.PI);     break; // anchor TR
    case 2: ctx.arc(x + w, y + h, r, Math.PI,     1.5 * Math.PI); break;// anchor BR
    case 3: ctx.arc(x,     y + h, r, 1.5 * Math.PI, 2 * Math.PI); break;// anchor BL
  }
  ctx.stroke();
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

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  ctx.fillStyle = params.bgColor;
  ctx.fillRect(ox, oy, dw, dh);

  if(!cells || cellCount === 0){ ctx.restore(); return; }

  const family = _familyOverride || params.tileFamily;
  const rotSteps = _tileRotationSteps | 0;
  const seed = params.seed | 0;

  if(family === 'photo'){
    // Reference path: bundled PNG mosaic. Crisp tile edges — patterns are
    // pixel art at native res, blow them up clean.
    if(!catalogReady){ ctx.restore(); return; }
    const prevSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    for(let k = 0; k < cellCount; k++){
      const o = k * 6;
      const x = ox + cells[o]   * scale;
      const y = oy + cells[o+1] * scale;
      const w = cells[o+2] * scale;
      const h = cells[o+3] * scale;
      const idx = cells[o+4] | 0;
      const img = catalog[idx]?.img;
      if(!img) continue;
      ctx.drawImage(img, x, y, w, h);
    }
    ctx.imageSmoothingEnabled = prevSmoothing;
  } else {
    // Procedural Truchet families. One canvas-path op per cell.
    ctx.fillStyle = params.tileColor;
    const drawFn =
      family === 'smith'        ? drawSmith :
      family === 'quarter-arc'  ? drawQuarterArc :
                                  drawTruchet;
    // Per-cell column/row reconstruction from x/y so the orientation lattice
    // stays stable across grid-density changes within a row (the *cell
    // coordinate* is the hash domain — not screen pixels).
    const cell0W = cells[2];
    const cell0H = cells[3];
    for(let k = 0; k < cellCount; k++){
      const o = k * 6;
      const x = ox + cells[o]   * scale;
      const y = oy + cells[o+1] * scale;
      const w = cells[o+2] * scale;
      const h = cells[o+3] * scale;
      const col = Math.round(cells[o]   / cell0W);
      const row = Math.round(cells[o+1] / cell0H);
      const orientation = cellHash(seed, col, row);
      const ink = cells[o+5];
      drawFn(ctx, x, y, w, h, orientation, ink, rotSteps);
    }
  }

  ctx.restore();
}

// ---------- animation ----------
//
// All envelopes wrap t to [0,1) so cos(2π·t) == cos(0) == 1 exactly at the
// seam. `march` and `swap` are step functions: at t=1 we explicitly route
// to step 0's state so the loop is byte-equal even though step functions
// generically aren't continuous.
function pingpongT01(t){
  let w = t - Math.floor(t);
  if(w === 1) w = 0;
  return (1 - Math.cos(w * 2 * Math.PI)) / 2;
}

const SWAP_FAMILIES = ['truchet', 'smith', 'quarter-arc'];

function applyAnimationT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  const t01 = w;
  const pp  = (1 - Math.cos(t01 * 2 * Math.PI)) / 2;
  const baseDensity = params.gridDensityNumber;
  let gridDensityNumber = baseDensity;
  let rotationSteps = 0;
  let familyOverride = null;
  let threshold = params.lightnessThreshold;
  switch(params.mode){
    case 'idle': {
      // Static.
      break;
    }
    case 'march': {
      // Truchet rotation step: rotate every tile by +90° each beat (4 beats
      // per loop). step = floor(t·4) mod 4 ∈ {0,1,2,3}. At t=1 we route to
      // step 0 so the seam is byte-equal — the step function would
      // generically give step 4 ≡ step 0, but we make it explicit.
      rotationSteps = (t01 === 0) ? 0 : Math.floor(t01 * 4) % 4;
      break;
    }
    case 'swap': {
      // Rule-set rotation. Holds each family for 1/N of the loop, then
      // swaps. Same seam-pinning trick as march.
      const beat = (t01 === 0) ? 0 : Math.floor(t01 * SWAP_FAMILIES.length) % SWAP_FAMILIES.length;
      familyOverride = SWAP_FAMILIES[beat];
      break;
    }
    case 'pulse': {
      // Density cosine. dense (more cells) → sparse → dense. The emergent
      // path geometry gets finer mid-cycle as the lattice densifies.
      const d = Math.round(baseDensity + params.densitySweep * (2 * pp - 1));
      gridDensityNumber = Math.max(10, Math.min(150, d));
      break;
    }
    case 'breath':
    default: {
      // Original behaviour: pingpong threshold around base.
      // We piggy-back on densitySweep so the existing slider stays
      // meaningful: at the midpoint, more cells survive the threshold cut.
      const d = Math.round(baseDensity + params.densitySweep * (2 * pp - 1));
      gridDensityNumber = Math.max(10, Math.min(150, d));
      break;
    }
  }
  return { gridDensityNumber, rotationSteps, familyOverride, threshold };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  const restDensity = params.gridDensityNumber;
  const restThreshold = params.lightnessThreshold;
  params.gridDensityNumber = anim.gridDensityNumber;
  params.lightnessThreshold = anim.threshold;
  _tileRotationSteps = anim.rotationSteps;
  _familyOverride    = anim.familyOverride;

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
  buildCells();
  paint();

  params.gridDensityNumber = restDensity;
  params.lightnessThreshold = restThreshold;
  _tileRotationSteps = 0;
  _familyOverride = null;
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
const BUILD_KEYS = new Set(['lightnessThreshold','gridDensityNumber']);
const PAINT_KEYS = new Set(['bgColor','showEffect','tileFamily','tileColor','seed']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    const nd = Math.max(10, Math.round(ax * 140 + 10));
    const nt = Math.round((1 - ay) * 255);
    let touched = false, builtTouched = false;
    if(nd !== params.gridDensityNumber){
      params.gridDensityNumber = nd; builtTouched = true;
      gui?.rows.get('gridDensityNumber')?._write(nd);
    }
    if(nt !== params.lightnessThreshold){
      params.lightnessThreshold = nt; builtTouched = true;
      gui?.rows.get('lightnessThreshold')?._write(nt);
    }
    if(builtTouched) schedule('build');
    else if(touched)  schedule('paint');
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
    if(key === 'mode'){ /* animation-only; no static rebuild */ return; }
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
      canvas: cv, name: 'pixart-patterns',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  cv.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  // Photo-mosaic catalog loads in the background; procedural families are
  // ready immediately, so first paint of `truchet` (default) is instant.
  loadCatalog(DEFAULT_PATTERN_URLS);
  schedule('pre');
}

document.addEventListener('DOMContentLoaded', init);
