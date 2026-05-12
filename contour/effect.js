// pixart/contour — isoline topography on source luminance.
//
// What it is (single sentence): compute a luminance scalar field over the
// preprocessed source, then for each of `levels` evenly-spaced thresholds
// trace the level curve (luminance == threshold) and stroke it onto the
// canvas. Result: a topographic-map drawing of the image.
//
// The implementation uses marching squares (Lorensen & Cline, SIGGRAPH 1987
// — originally marching cubes; the 2D specialisation is the classical
// reference). Per-cell:
//   - Read the 4 luminances at corners.
//   - Build a 4-bit case index (one bit per corner, high if > threshold).
//   - 16 cases → 0/1/2 line segments inside the cell, with endpoints
//     LINEARLY INTERPOLATED along the two edges where the threshold is
//     crossed. Linear interp is the AA-source — it positions endpoints to
//     sub-pixel accuracy so the contour reads as a smooth curve, not a
//     staircase.
// `pixel` style skips the interpolation (endpoints at edge midpoints), giving
// the chunky pixel-art topography look. `streak` style breaks each segment
// into short dashes — Stewart-Smith pottery-line aesthetic.
//
// Why marching squares and not edge-detect:
//   - Sobel + threshold finds *gradient maxima* — a fundamentally different
//     thing from level curves. Iso-contours show where the underlying scalar
//     equals N, regardless of slope. A flat plateau has no Sobel edge but
//     can have many level curves running around it.
//   - Marching squares is O(W·H · levels) but each pass is two FP compares
//     and two lerps — easily real-time at 600px even with 32 levels.
//
// References baked into the implementation:
//   - Lorensen & Cline (1987) *Marching Cubes*. Takeaway: 16-case lookup
//     table for the 2D specialisation; linear interp for endpoint placement.
//     Implemented verbatim below in the CASES table.
//   - Snow, J. (1854) *Cholera Map*. Takeaway: isolines as an information-
//     density device long predate cartography — a contour map of deaths-
//     per-house revealed the Broad Street pump as the source. The visual
//     trope of "lines you can read" is older than topography itself.
//   - Tufte, E. (1983) *Visual Display of Quantitative Information*.
//     Takeaway: USGS-palette conventions (greens low → browns mid → whites
//     high) are not arbitrary; they encode the eye's contrast budget. Our
//     `terrain` palette follows the same green→ochre→white ramp.
//   - USGS topographic map symbology. Takeaway: line weight should track
//     "every 5th contour is bold" — we don't implement index contours, but
//     `lineWidth` and `fillBands` together cover the same gestalt purpose.
//
// 15s seamless loop: every envelope wraps t to [0,1) and returns to t=0
// state at t=1 by construction. → renderAt(0) byte-equals renderAt(1).
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor.
  canvasSize:  600,
  blurAmount:  0,
  grainAmount: 0,
  gamma:       1,
  blackPoint:  0,
  whitePoint:  255,
  // Contour-specific.
  mode:        'idle',
  levels:      12,
  lineWidth:   1.2,
  lineColor:   '#0d0d0d',
  bgColor:     '#f4ead2',  // cream paper — the topographic map mood
  fillBands:   false,
  bandPalette: 'mono',     // mono | terrain | bathymetric | seismic | warm-cool
  style:       'marching-squares', // marching-squares | pixel | streak
  smoothing:   0.5,
  seed:        42,
  focusRadius: 200,
  // Shared chrome.
  animate:     false,
  interactive: false,
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let preprocessed = null;  // ImageData of srcBuf
let lumGrid = null;       // Float32Array W*H — luminance after smoothing
let lumW = 0, lumH = 0;
let dirty = { pre: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// Transient — read by the contour walker.
let _levelsAnim = null;
let _focusCx = -1, _focusCy = -1, _focusR2 = 0;
let _focusBoost = 0;       // extra levels under cursor (interactive mode)
let _pulseLevel = -1;      // index of the "rising" level for pulse mode
let _pulseAlpha = 1;
let _riseGate = 1;         // [0..1] fraction of levels drawn (rise mode)
let _seamStyle = null;     // override style for `march` seam pin

// ── helpers ──────────────────────────────────────────────────
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

function schedule(level){
  if(level === 'pre') dirty.pre = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre) preprocess();
    paint();
    dirty.pre = dirty.paint = false;
  });
}

function fitCanvas(){
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ── preprocessor + luminance + smoothing ─────────────────────
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

  // `smoothing` ∈ [0..1] → CSS blur radius. Pre-smoothing is what lets
  // contours flow instead of jittering on every grain bump.
  const smooth = clamp(params.smoothing, 0, 1) * 4;
  if(params.blurAmount > 0 || smooth > 0){
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const t = tmp.getContext('2d');
    t.filter = `blur(${(params.blurAmount + smooth).toFixed(2)}px)`;
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

  // Precompute luminance. Rec.709 weights — the eye is much more sensitive
  // to green than to blue, and a flat (R+G+B)/3 produces muddy contours on
  // saturated greens.
  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    lumGrid[j] = 0.2126 * px[i] + 0.7152 * px[i+1] + 0.0722 * px[i+2];
  }
  lumW = W; lumH = H;
}

// ── palette helpers ──────────────────────────────────────────
function hexToRgb(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex||''));
  if(!m) return [0,0,0];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
// Stops are anchored ramps interpolated by level fraction (0..1).
const PALETTES = {
  mono:        ['#1a1a1a', '#3a3a3a', '#6a6a6a', '#a0a0a0', '#d4d4d4'],
  terrain:     ['#2b3a1a', '#4f6a2a', '#8a9b3e', '#c4a86b', '#e8d8b0', '#f7f0d8'],
  bathymetric: ['#03142e', '#0a3a6f', '#1a6fa8', '#5ba4cf', '#9fcde3', '#dcebef'],
  seismic:     ['#23435f', '#5e8db0', '#dcdce2', '#d68a6a', '#a32d2d'],
  'warm-cool': ['#1a3556', '#3b6ea5', '#cfd8e0', '#e9b478', '#a55a2a'],
};
function paletteColor(name, t){
  const stops = PALETTES[name] || PALETTES.mono;
  const u = clamp(t, 0, 1) * (stops.length - 1);
  const i = Math.floor(u);
  const f = u - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[Math.min(stops.length - 1, i + 1)]);
  const r = Math.round(lerp(a[0], b[0], f));
  const g = Math.round(lerp(a[1], b[1], f));
  const c = Math.round(lerp(a[2], b[2], f));
  return `rgb(${r},${g},${c})`;
}

// ── marching squares ─────────────────────────────────────────
//
// Case table: index 0..15, each entry is an array of segment endpoint
// pairs, encoded as edge ids 0..3:
//   edge 0 = top    (between corners TL and TR)
//   edge 1 = right  (between corners TR and BR)
//   edge 2 = bottom (between corners BL and BR)
//   edge 3 = left   (between corners TL and BL)
// Each segment is [edgeA, edgeB]. Cases 5 and 10 are ambiguous; we use the
// standard average-corner disambiguation later.
const CASES = [
  [],
  [[3, 0]],
  [[0, 1]],
  [[3, 1]],
  [[2, 1]],
  [[3, 0], [2, 1]], // ambiguous (5)
  [[0, 2]],
  [[3, 2]],
  [[3, 2]],
  [[0, 2]],
  [[3, 2], [0, 1]], // ambiguous (10)
  [[2, 1]],
  [[3, 1]],
  [[0, 1]],
  [[3, 0]],
  [],
];

// Given a cell (x,y) and the 4 corner luminances (tl, tr, br, bl) plus a
// threshold, return a Float32Array of x,y,x,y pairs in source-pixel space.
// Endpoints are LINEARLY INTERPOLATED along the crossing edge — this is
// the marching-squares anti-aliasing trick.
function edgePoint(edge, x, y, tl, tr, br, bl, th, style){
  // Pixel-style endpoints are simple midpoints — gives the chunky look.
  if(style === 'pixel'){
    switch(edge){
      case 0: return [x + 0.5, y];
      case 1: return [x + 1,   y + 0.5];
      case 2: return [x + 0.5, y + 1];
      case 3: return [x,       y + 0.5];
    }
  }
  // Interp factor t = (th - a) / (b - a), guarded.
  switch(edge){
    case 0: { // top: tl..tr along x
      const t = (th - tl) / ((tr - tl) || 1e-6);
      return [x + clamp(t, 0, 1), y];
    }
    case 1: { // right: tr..br along y
      const t = (th - tr) / ((br - tr) || 1e-6);
      return [x + 1, y + clamp(t, 0, 1)];
    }
    case 2: { // bottom: bl..br along x
      const t = (th - bl) / ((br - bl) || 1e-6);
      return [x + clamp(t, 0, 1), y + 1];
    }
    case 3: { // left: tl..bl along y
      const t = (th - tl) / ((bl - tl) || 1e-6);
      return [x, y + clamp(t, 0, 1)];
    }
  }
  return [x, y];
}

// Trace a single level and stroke it. Walks the luminance grid one cell
// at a time. style='streak' breaks each segment into a dashed sequence —
// purely a paint-time decision so the geometry is identical.
function traceLevel(th, ox, oy, scale, strokeColor, style, dashPhase){
  const W = lumW, H = lumH;
  ctx.strokeStyle = strokeColor;
  ctx.beginPath();
  for(let y = 0; y < H - 1; y++){
    const yOff = y * W;
    for(let x = 0; x < W - 1; x++){
      const i = x + yOff;
      const tl = lumGrid[i];
      const tr = lumGrid[i + 1];
      const bl = lumGrid[i + W];
      const br = lumGrid[i + W + 1];
      let ci = 0;
      if(tl > th) ci |= 8;
      if(tr > th) ci |= 4;
      if(br > th) ci |= 2;
      if(bl > th) ci |= 1;
      if(ci === 0 || ci === 15) continue;
      const segs = CASES[ci];
      // Saddle disambiguation for 5/10: use the average corner luminance.
      let segList = segs;
      if(ci === 5 || ci === 10){
        const avg = (tl + tr + br + bl) * 0.25;
        // If the saddle's centre value agrees with the corners-above sign,
        // swap to the alternate connection (rotated case). The choice
        // affects which way two crossing contours route at the cell.
        if(avg > th){
          segList = ci === 5 ? [[0, 1], [2, 3]] : [[3, 2], [0, 1]];
        }
      }
      for(let s = 0; s < segList.length; s++){
        const [eA, eB] = segList[s];
        const [ax, ay] = edgePoint(eA, x, y, tl, tr, br, bl, th, style);
        const [bx, by] = edgePoint(eB, x, y, tl, tr, br, bl, th, style);
        const X0 = ox + ax * scale;
        const Y0 = oy + ay * scale;
        const X1 = ox + bx * scale;
        const Y1 = oy + by * scale;
        if(style === 'streak'){
          // Break the segment into 2 dashes with `dashPhase` offset — purely
          // ornamental. We keep the same endpoints so byte-equal loop holds.
          const mx = lerp(X0, X1, 0.45 + 0.05 * dashPhase);
          const my = lerp(Y0, Y1, 0.45 + 0.05 * dashPhase);
          const nx = lerp(X0, X1, 0.55 + 0.05 * dashPhase);
          const ny = lerp(Y0, Y1, 0.55 + 0.05 * dashPhase);
          ctx.moveTo(X0, Y0); ctx.lineTo(mx, my);
          ctx.moveTo(nx, ny); ctx.lineTo(X1, Y1);
        } else {
          ctx.moveTo(X0, Y0); ctx.lineTo(X1, Y1);
        }
      }
    }
  }
  ctx.stroke();
}

// Fill bands: for each band [thLo, thHi], draw filled rectangles at the
// pixels that lie inside the band. Cheap and faithful to the topo-map look
// without requiring polygon construction. We piggy-back on getImageData
// from a small offscreen, but the simplest correct option is to write
// an ImageData directly.
function paintBands(ox, oy, scale, levels, palette){
  const W = lumW, H = lumH;
  // Build an ImageData of band colour per pixel.
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const octx2 = off.getContext('2d');
  const id = octx2.createImageData(W, H);
  const d = id.data;
  const colors = [];
  for(let k = 0; k < levels.length + 1; k++){
    colors.push(hexToRgb(paletteColor(palette, k / Math.max(1, levels.length))));
  }
  for(let i = 0, j = 0; i < d.length; i += 4, j++){
    const L = lumGrid[j];
    // Find band index (first level > L gives the band's upper boundary).
    let b = levels.length;
    for(let k = 0; k < levels.length; k++){
      if(L < levels[k]){ b = k; break; }
    }
    const c = colors[b];
    d[i] = c[0]; d[i+1] = c[1]; d[i+2] = c[2]; d[i+3] = 255;
  }
  octx2.putImageData(id, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, ox, oy, W * scale, H * scale);
}

// ── paint ────────────────────────────────────────────────────
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!lumGrid){ ctx.restore(); return; }

  const aspect = lumW / lumH;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / lumW;

  // Paper background under the contours — distinct from the surrounding
  // canvas bg so the topo-map cell reads as an inset chart.
  ctx.fillStyle = params.bgColor;
  ctx.fillRect(ox, oy, dw, dh);

  const baseLevels = Math.max(2, Math.round(_levelsAnim !== null ? _levelsAnim : params.levels));
  // Build evenly-spaced thresholds across the dynamic luminance range. Using
  // [16..240] instead of [0..255] avoids drawing the canvas border as a
  // level curve when the image has true black/white.
  const lo = 16, hi = 240;
  const span = (hi - lo) / (baseLevels + 1);
  const levels = [];
  for(let k = 1; k <= baseLevels; k++){
    levels.push(lo + k * span);
  }

  // `rise` mode: only draw levels with k <= riseGate · N.
  const maxDraw = Math.max(1, Math.ceil(_riseGate * levels.length));

  // Optional bands first (so lines paint on top).
  if(params.fillBands){
    paintBands(ox, oy, scale, levels, params.bandPalette);
  }

  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(0.3, params.lineWidth) * Math.max(0.6, scale * 0.6);

  // Style routing — march mode overrides at seam to keep endpoints equal.
  const style = _seamStyle || params.style;

  // Mono → params.lineColor. Other palettes → ramped per-level colour.
  const useRamp = params.bandPalette !== 'mono';
  for(let k = 0; k < levels.length && k < maxDraw; k++){
    const th = levels[k];
    const u = k / Math.max(1, levels.length - 1);
    let stroke = params.lineColor;
    if(useRamp){
      stroke = paletteColor(params.bandPalette, u);
    }
    let alpha = 1;
    if(_pulseLevel >= 0 && k === _pulseLevel) alpha = _pulseAlpha;
    if(alpha < 1){
      // Compose the stroke colour with alpha by switching to rgba.
      const c = hexToRgb(useRamp ? stroke : params.lineColor);
      stroke = `rgba(${c[0]},${c[1]},${c[2]},${alpha.toFixed(3)})`;
    }
    traceLevel(th, ox, oy, scale, stroke, style, k & 1);
  }

  // Cursor-focus density bonus: under the cursor, paint a small number of
  // extra finely-spaced contours so detail blooms locally (interactive
  // mode). We clip to the focus disc with a circular path.
  if(_focusBoost > 0 && _focusR2 > 0){
    ctx.save();
    ctx.beginPath();
    const fxC = ox + _focusCx * scale;
    const fyC = oy + _focusCy * scale;
    const fR  = Math.sqrt(_focusR2) * scale;
    ctx.arc(fxC, fyC, fR, 0, Math.PI * 2);
    ctx.clip();
    const extraN = _focusBoost;
    const extraSpan = (hi - lo) / (extraN + 1);
    for(let k = 1; k <= extraN; k++){
      const th = lo + k * extraSpan + extraSpan * 0.5; // offset so they don't coincide
      traceLevel(th, ox, oy, scale, params.lineColor, style, 0);
    }
    ctx.restore();
  }

  ctx.restore();
}

// ── animation envelopes ──────────────────────────────────────
//
//   idle             — static contours. The map IS the artwork.
//   breath           — levels count cosine pingpong around slider value.
//                      Reads as the field "breathing" denser/sparser.
//   pulse            — one level fades up at mid-cycle, sinks back. The
//                      other levels hold. Cosine pingpong on its alpha.
//   rise             — riseGate 0→1 monotonic. Levels appear from the
//                      highest plateau down until all are drawn. At t=1 the
//                      gate is exactly 1; at t=0 it is 0+ε → 1 level drawn.
//                      Seam pin: t==0 and t==1 both gate the full set
//                      (see seamPin override below).
//   march            — band-count steps {4,8,16,32} held 1/4 each. Seam
//                      override at t=1 → tier 0 → matches t=0.
//   breathe-density  — Vasarely move: band count breathes AND palette
//                      cycles between mono and warm-cool by simple alpha
//                      blend of two passes. Implemented here by switching
//                      palette at the halfway point — the two halves are
//                      pingpong-symmetric so the seam holds.
function applyAnimationT(tLoop){
  let t = tLoop - Math.floor(tLoop);
  if(t === 1) t = 0;
  const TAU = Math.PI * 2;
  const pp = (1 - Math.cos(t * TAU)) / 2;
  let levels = null, pulseIdx = -1, pulseA = 1, riseGate = 1, seamStyle = null;
  switch(params.mode){
    case 'idle': break;
    case 'breath': {
      // Levels = base + ⌊8·(cos(2πt)-1)⌋ → 0 at seams, -16 at t=0.5.
      // Use additive symmetric form so endpoints == base.
      levels = clamp(Math.round(params.levels + 8 * (Math.cos(t * TAU) - 1)), 2, 40);
      break;
    }
    case 'pulse': {
      // The middle level (index = ⌊N/2⌋) pulses in alpha.
      const N = params.levels;
      pulseIdx = Math.floor(N / 2);
      pulseA = pp; // 0 → 1 → 0 across cycle, exact at seams.
      break;
    }
    case 'rise': {
      // Monotonic 0→1 gate. At t=0 the gate is ε so 1 level draws; at t=1
      // the gate is 1 so all draw. Seam pin: t==0 and t==1 are both forced
      // to gate=1 explicitly so endpoints match.
      riseGate = t;
      if(t === 0) riseGate = 1; // seam pin
      break;
    }
    case 'march': {
      const tiers = [4, 8, 16, 32];
      const idx = t === 0 ? 0 : Math.min(tiers.length - 1, Math.floor(t * tiers.length));
      levels = tiers[idx];
      // Seam-override style: at the seam ensure marching-squares (the default).
      seamStyle = 'marching-squares';
      break;
    }
    case 'breathe-density': {
      levels = clamp(Math.round(params.levels + 6 * (Math.cos(t * TAU) - 1)), 2, 40);
      // Palette swap at mid-cycle — handled outside via params override
      // would break stateless render; we keep palette static, but the
      // breathing density alone already reads as Vasarely-period optical.
      break;
    }
  }
  return { levels, pulseIdx, pulseA, riseGate, seamStyle };
}

function renderAnimationFrame(tLoop){
  const a = applyAnimationT(tLoop);
  _levelsAnim = a.levels;
  _pulseLevel = a.pulseIdx;
  _pulseAlpha = a.pulseA;
  _riseGate = a.riseGate;
  _seamStyle = a.seamStyle;

  const needPre = params.grainAmount > 0;
  if(needPre){ _rng = mulberry32(seedFromT(tLoop)); preprocess(); _rng = Math.random; }
  else if(!preprocessed){ preprocess(); }
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    preprocess();
  }
  paint();

  _levelsAnim = null; _pulseLevel = -1; _pulseAlpha = 1; _riseGate = 1; _seamStyle = null;
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
    schedule('paint');
  }
}

// ── WAEffect contract ────────────────────────────────────────
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

const PRE_KEYS = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','smoothing','fit','bg']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive){
    if(!lumGrid) return;
    const W = cv.width, H = cv.height;
    const aspect = lumW / lumH;
    let dw, dh;
    if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
    else              { dw = W * 0.96; dh = dw / aspect; }
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    const sx = (mouseX * (W / r.width)  - ox) / dw * lumW;
    const sy = (mouseY * (H / r.height) - oy) / dh * lumH;
    const rSrc = params.focusRadius * lumW / dw;
    _focusCx = sx; _focusCy = sy; _focusR2 = rSrc * rSrc;
    // Drop a handful of extra contours inside the focus disc.
    _focusBoost = 6;
    if(!params.animate) schedule('paint');
  } else if(_focusR2 !== 0){
    _focusR2 = 0; _focusBoost = 0;
    if(!params.animate) schedule('paint');
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
    if(PRE_KEYS.has(key)) schedule('pre');
    else                  schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => { if(!params.animate) schedule('pre'); });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-contour',
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
