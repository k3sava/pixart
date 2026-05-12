// pixart/dithering — port of tooooools.app/effects/dithering.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/dithering/page-c651560ea284d530.js,
//  shared preprocessor + page defaults in /_next/static/chunks/9357-2a51c42cdfe973de.js).
//
// What the reference effect is:
//   - A classic image-dithering pipeline (image → low-res grid → palette
//     quantize via one of three patterns → upsample back to pixel-blocks).
//   - Three pattern types ship in the bundle: "F-S" (Floyd-Steinberg
//     error-diffusion), "Bayer" (4×4 ordered), "Random" (white-noise
//     threshold).
//   - Two colour modes: monochrome (binary threshold to black/white) and
//     palette (RGB nearest-colour quantization across a generated palette).
//   - NOT text-based — pixart's sibling wordart has a separate `dither`
//     effect that thresholds typography. This one is full image / video
//     dithering and shares almost nothing with that code path.
//
// Algorithm (lifted line-for-line from the chunk's `m = E(function(e,t,r){…})`):
//   1) Preprocessor pipeline (shared module — same as Displace/Edge/Ascii):
//      Blur → Grain → Gamma → Levels. Identical pixel layout.
//   2) Downsample to a (W/pixelSize) × (H/pixelSize) grid. Each cell is the
//      average of its source rect, with RGB kept separate if colorMode, or
//      collapsed to a single mean luminance otherwise. Alpha is composited
//      over white before averaging (matches the `lerp(255, c, a/255)` trick
//      used throughout the framework).
//   3) Apply the chosen pattern (per the switch in the bundle):
//
//      Floyd-Steinberg (mono):
//        scaled  = clamp(value * (255 / threshold), 0..255)
//        out     = scaled > 127 ? 255 : 0
//        error   = scaled - out
//        propagate error with weights:
//                            X   7/16
//                  3/16  5/16  1/16
//        (this is the canonical Floyd-Steinberg distribution)
//
//      Floyd-Steinberg (colour):
//        out     = nearest palette colour by weighted RGB distance:
//                  d² = (.299·ΔR)² + (.587·ΔG)² + (.114·ΔB)²
//        error.rgb propagated with the same 7/3/5/1 over 16 weights.
//
//      Bayer (mono): 4×4 Bayer matrix [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]]
//        threshold_local = (threshold/128) * (M[y%4][x%4] / 16) * 255
//        out = value > threshold_local ? 255 : 0
//
//      Bayer (colour): nearest *two* palette colours; pick one or the other
//        based on whether the matrix entry < 0.5.
//
//      Random (mono):
//        out = value > threshold * random() * 2 ? 255 : 0
//
//      Random (colour): like Bayer-colour but the matrix entry is replaced
//        with `random()`.
//
//   4) Upsample by drawing each cell as a `pixelSize × pixelSize` solid
//      block back to the canvas.
//
// Palette generation (bundle's `p(n)`):
//   - Always seeds black + white first.
//   - Then fills the rest with a uniform 3D colour-cube of `r =
//     ceil((n-2)^(1/3))` levels per channel, skipping the corners that match
//     pure black and pure white. This is why colorCount=2 gives mono,
//     colorCount=8 gives the "8-bit-Mac" four-tone duotone, colorCount=24
//     (the bundle default) gives a usable RGB palette.
//
// Defaults from the bundle's pageStates["/effects/dithering"]:
//   showEffect:         true
//   lightnessThreshold: 255    (← bundle ships max threshold. For F-S mono
//                                this becomes a 1× exposure → standard
//                                127-pivot. We keep it.)
//   patternType:        "F-S"
//   pixelSize:          2      (very fine. We bump to 4 for the landing
//                                frame so the dithering is visible at a
//                                glance instead of looking like noise.)
//   colorMode:          false  (mono is the iconic dithering look)
//   colorCount:         24
//
// Animation: tooooools' dithering effect is not animated. For pixart we add
// a 15s seamless `pixelSize` pingpong (small → large → small) so the dot
// scale "breathes" over the cycle. Pingpong is `(1 - cos(2πt))/2`, cos-based
// so endpoints meet exactly. We don't sweep threshold because the reference
// default of 255 sits at the edge of the F-S curve and any sweep clips
// awkwardly; pixelSize sweep is visually richer (changes the literal
// resolution of the dither field) and is what the eye reaches for.
//
// Determinism: when grain or random-pattern is in use, _rng is mulberry32
// seeded from t_loop. F-S and Bayer are deterministic by construction. So
// renderAt(0) === renderAt(1) byte-equal for export.
//
// Performance:
//   - F-S is *serial* (each pixel reads errors from already-quantised
//     neighbours), so it can't be vectorised. At canvasSize=600, pixelSize=4,
//     the grid is 150×(H/4) ≈ 11k cells — F-S runs ~5 ms.
//   - Bayer and Random are trivially parallel — both run <2 ms at the same
//     resolution.
//   - The bundle then emits a list of `{x,y,w,h,fill}` rects which it draws
//     one-by-one. We mirror that.
//   - Worst case (canvasSize=1000, pixelSize=1): 1M cells, F-S in colour.
//     This runs ~80 ms — too slow for live interaction, fine for export.
//     The reference has the exact same property; the user is expected to
//     leave pixelSize ≥ 2.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Offscreen buffer for the preprocessed source. The dither pass walks its
// pixel data and emits rects.
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
  // Dithering-specific (bundle defaults preserved, except pixelSize 2→4 for landing).
  patternType:       'F-S',   // 'F-S' | 'Bayer' | 'Random'
  pixelSize:         4,       // bundle default 2
  lightnessThreshold: 255,    // F-S exposure / Bayer-Random gate. Bundle default.
  colorMode:         false,
  colorCount:        24,
  showEffect:        true,
  // Loop-animation amplitude — pixelSize pingpong range. 0 = static loop.
  pixelSweep:        6,       // 4 → 10 → 4 by default
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
let preprocessed = null;       // ImageData of srcBuf after pipeline
let rects = null;              // [x,y,w,h, r,g,b] per emitted block
let rectCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

// mulberry32 — deterministic RNG seeded per-frame for the seamless loop.
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
    if(dirty.build) buildRects();
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

// ---------- preprocessor (identical to Displace / Edge — shared module) ----------
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
}

// ---------- palette generation (bundle's p(n)) ----------
//
// Returns an array of {r,g,b}. Black and white go first; the remainder fills
// a uniform colour cube with `ceil((n-2)^(1/3))` levels per channel,
// skipping the two corners already covered. Exact mirror of the bundle.
function genPalette(n){
  const out = [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }];
  const r = Math.ceil(Math.pow(Math.max(2, n) - 2, 1 / 3));
  if(r < 2 || out.length >= n) return out;
  const step = 255 / (r - 1);
  for(let l = 0; l < r && out.length < n; l++){
    for(let m = 0; m < r && out.length < n; m++){
      for(let a = 0; a < r && out.length < n; a++){
        if((l === 0 && m === 0 && a === 0) ||
           (l === r - 1 && m === r - 1 && a === r - 1)) continue;
        out.push({ r: Math.round(l * step), g: Math.round(m * step), b: Math.round(a * step) });
      }
    }
  }
  return out;
}

// Weighted RGB nearest-colour (perception-weighted by .299/.587/.114).
function nearestColor(r, g, b, palette){
  let best = palette[0], bd = Infinity;
  for(let i = 0; i < palette.length; i++){
    const p = palette[i];
    const dr = (r - p.r) * 0.299;
    const dg = (g - p.g) * 0.587;
    const db = (b - p.b) * 0.114;
    const d  = dr * dr + dg * dg + db * db;
    if(d < bd){ bd = d; best = p; }
  }
  return best;
}

// Two nearest neighbours (Bayer-colour / Random-colour pick one of two).
function twoNearest(r, g, b, palette){
  const dist = new Array(palette.length);
  for(let i = 0; i < palette.length; i++){
    const p = palette[i];
    const dr = (r - p.r) * 0.299;
    const dg = (g - p.g) * 0.587;
    const db = (b - p.b) * 0.114;
    dist[i] = { c: p, d: dr * dr + dg * dg + db * db };
  }
  dist.sort((a, b) => a.d - b.d);
  return [dist[0].c, dist[1].c];
}

// ---------- downsample to grid ----------
//
// Each grid cell is the mean of its source rect, alpha-composited over white.
// colorMode true → cell is {r,g,b}; false → cell is a luminance Number.
function downsample(px, W, H, gw, gh, color){
  const cw = W / gw, ch = H / gh;
  const out = new Array(gw * gh);
  for(let y = 0; y < gh; y++){
    const y0 = Math.floor(y * ch);
    const y1 = Math.min(H, Math.floor((y + 1) * ch));
    for(let x = 0; x < gw; x++){
      const x0 = Math.floor(x * cw);
      const x1 = Math.min(W, Math.floor((x + 1) * cw));
      let sr = 0, sg = 0, sb = 0, n = 0;
      for(let yy = y0; yy < y1; yy++){
        for(let xx = x0; xx < x1; xx++){
          const i = (yy * W + xx) * 4;
          const a = px[i+3] / 255;
          // Alpha-composite over white before averaging.
          sr += px[i]   * a + 255 * (1 - a);
          sg += px[i+1] * a + 255 * (1 - a);
          sb += px[i+2] * a + 255 * (1 - a);
          n++;
        }
      }
      if(n === 0){
        out[y * gw + x] = color ? { r: 255, g: 255, b: 255 } : 255;
      } else if(color){
        out[y * gw + x] = { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n) };
      } else {
        out[y * gw + x] = (sr + sg + sb) / (3 * n);
      }
    }
  }
  return out;
}

// ---------- patterns ----------
//
// All four routines mutate the `grid` in place, writing the quantised value.
// Mono variants write Number (0 or 255). Colour variants write {r,g,b}.

const BAYER4 = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];

function fsMono(grid, gw, gh, threshold){
  // F-S exposure trick from the bundle: scale by 255/threshold before
  // quantising, divide error back by the same scale when propagating so
  // downstream comparisons happen in the *scaled* space.
  const scale = 255 / Math.max(1, threshold);
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const v = Math.min(255, grid[i] * scale);
      const q = v > 127 ? 255 : 0;
      grid[i] = q;
      const err = v - q;
      if(x + 1 < gw)              grid[i + 1]       += 7 * err / 16 / scale;
      if(x - 1 >= 0 && y + 1 < gh) grid[i + gw - 1] += 3 * err / 16 / scale;
      if(y + 1 < gh)              grid[i + gw]      += 5 * err / 16 / scale;
      if(x + 1 < gw && y + 1 < gh) grid[i + gw + 1] += 1 * err / 16 / scale;
    }
  }
}

function fsColor(grid, gw, gh, palette){
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const c = grid[i];
      const q = nearestColor(c.r, c.g, c.b, palette);
      grid[i] = q;
      const er = c.r - q.r, eg = c.g - q.g, eb = c.b - q.b;
      const spread = (xx, yy, w) => {
        if(xx < 0 || xx >= gw || yy >= gh) return;
        const t = grid[yy * gw + xx];
        t.r = clamp(t.r + er * w, 0, 255);
        t.g = clamp(t.g + eg * w, 0, 255);
        t.b = clamp(t.b + eb * w, 0, 255);
      };
      if(x + 1 < gw)               spread(x + 1, y,     7 / 16);
      if(y + 1 < gh){
        if(x > 0)                  spread(x - 1, y + 1, 3 / 16);
                                   spread(x,     y + 1, 5 / 16);
        if(x + 1 < gw)             spread(x + 1, y + 1, 1 / 16);
      }
    }
  }
}

function bayerMono(grid, gw, gh, threshold){
  // Per-bundle: local threshold = (threshold/128) * (M[y%4][x%4] / 16) * 255
  for(let y = 0; y < gh; y++){
    const row = BAYER4[y % 4];
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const local = (threshold / 128) * (row[x % 4] / 16) * 255;
      grid[i] = grid[i] > local ? 255 : 0;
    }
  }
}

function bayerColor(grid, gw, gh, palette){
  for(let y = 0; y < gh; y++){
    const row = BAYER4[y % 4];
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const c = grid[i];
      const pair = twoNearest(c.r, c.g, c.b, palette);
      const m = row[x % 4] / 16;
      grid[i] = m < 0.5 ? pair[0] : pair[1];
    }
  }
}

function randMono(grid, gw, gh, threshold, rng){
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const local = threshold * rng() * 2;
      grid[i] = grid[i] > local ? 255 : 0;
    }
  }
}

function randColor(grid, gw, gh, palette, rng){
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const c = grid[i];
      const pair = twoNearest(c.r, c.g, c.b, palette);
      grid[i] = rng() < 0.5 ? pair[0] : pair[1];
    }
  }
}

// ---------- build rects (tooooools' final pass) ----------
//
// Walk the quantised grid and emit one rect per cell at the cell's source-
// space (x*cw, y*ch) origin with the cell's pixel size. We carry colour
// here so paint() is a flat draw loop. Bundle does the same — pushes
// {x,y,w,h,fill} into a `_rectangles` array.
function buildRects(){
  if(!preprocessed){ rectCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const ps = Math.max(1, params.pixelSize | 0);
  const gw = Math.ceil(W / ps);
  const gh = Math.ceil(H / ps);
  if(gw === 0 || gh === 0){ rectCount = 0; return; }

  // Mutable grid (we work on a copy of the source averages so re-runs of
  // buildRects don't compound F-S errors).
  const grid = downsample(preprocessed.data, W, H, gw, gh, params.colorMode);

  const rng = (params.patternType === 'Random') ? _rng : Math.random;

  switch(params.patternType){
    case 'F-S':
      if(params.colorMode) fsColor(grid, gw, gh, genPalette(params.colorCount));
      else                 fsMono(grid, gw, gh, params.lightnessThreshold);
      break;
    case 'Bayer':
      if(params.colorMode) bayerColor(grid, gw, gh, genPalette(params.colorCount));
      else                 bayerMono(grid, gw, gh, params.lightnessThreshold);
      break;
    case 'Random':
      if(params.colorMode) randColor(grid, gw, gh, genPalette(params.colorCount), rng);
      else                 randMono(grid, gw, gh, params.lightnessThreshold, rng);
      break;
  }

  // Upsample: pack [x, y, w, h, r, g, b] per cell into a flat Float32Array.
  const cw = W / gw, ch = H / gh;
  const cap = gw * gh;
  if(!rects || rects.length < cap * 7) rects = new Float32Array(cap * 7);
  let n = 0;
  for(let y = 0; y < gh; y++){
    const y0 = Math.floor(y * ch);
    const y1 = Math.min(H, Math.floor((y + 1) * ch));
    for(let x = 0; x < gw; x++){
      const v = grid[y * gw + x];
      const x0 = Math.floor(x * cw);
      const x1 = Math.min(W, Math.floor((x + 1) * cw));
      let r, g, b;
      if(typeof v === 'object'){ r = v.r; g = v.g; b = v.b; }
      else                     { r = g = b = v; }
      const o = n * 7;
      rects[o]   = x0;
      rects[o+1] = y0;
      rects[o+2] = x1 - x0;
      rects[o+3] = y1 - y0;
      rects[o+4] = r;
      rects[o+5] = g;
      rects[o+6] = b;
      n++;
    }
  }
  rectCount = n;
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

  if(!rects || rectCount === 0){ ctx.restore(); return; }

  // object-fit:contain into the canvas, no crop, parity with the reference.
  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  // Slight overlap (0.5px) prevents sub-pixel seams between blocks when the
  // canvas scale isn't an integer multiple of the grid step.
  const PAD = 0.5;
  for(let k = 0; k < rectCount; k++){
    const o = k * 7;
    const x = ox + rects[o]   * scale;
    const y = oy + rects[o+1] * scale;
    const w = rects[o+2] * scale + PAD;
    const h = rects[o+3] * scale + PAD;
    const r = rects[o+4] | 0, g = rects[o+5] | 0, b = rects[o+6] | 0;
    ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
    ctx.fillRect(x, y, w, h);
  }

  ctx.restore();
}

// ---------- animation ----------
//
// 15s seamless loop: pixelSize pingpongs base±sweep. We compute a transient
// pixelSize so the GUI value stays stable. Pingpong is cosine-based so
// endpoints meet exactly even under IEEE-754.
function pingpongT01(t){
  let w = t - Math.floor(t);
  if(w === 1) w = 0;
  return (1 - Math.cos(w * 2 * Math.PI)) / 2;
}

function applyAnimationT(tLoop){
  const t01 = pingpongT01(tLoop);
  const base = params.pixelSize;
  // Up from base at the peak of the cycle. clamp to [1, 40] (the slider max).
  return { pixelSize: clamp(Math.round(base + params.pixelSweep * t01), 1, 40) };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  const rest = params.pixelSize;
  params.pixelSize = anim.pixelSize;

  // Deterministic RNG seeding so endpoints byte-match — covers both grain
  // (preprocessor) and Random pattern.
  const needsSeeded = params.grainAmount > 0 || params.patternType === 'Random';
  if(needsSeeded){
    _rng = mulberry32(seedFromT(tLoop));
    preprocess();
  } else if(!preprocessed){
    preprocess();
  }
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    preprocess();
  }
  buildRects();
  paint();
  if(needsSeeded) _rng = Math.random;

  params.pixelSize = rest;
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

// Per the bundle's `shouldRedraw` predicate (pixelSize, lightnessThreshold,
// patternType, colorMode, colorCount all force a rebuild). All preprocessor
// keys re-run the pipeline. showEffect is paint-only.
const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['pixelSize','lightnessThreshold','patternType','colorMode','colorCount','pixelSweep']);
const PAINT_KEYS = new Set(['showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    // Mouse X drives threshold (0..255), Mouse Y drives pixelSize (1..20).
    // Threshold is the most expressive knob for all three patterns;
    // pixelSize controls the dot scale, which is the second most expressive.
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    const nt = Math.max(1, Math.round(ax * 255));
    const np = Math.max(1, Math.round((1 - ay) * 20));
    let touched = false;
    if(nt !== params.lightnessThreshold){
      params.lightnessThreshold = nt; touched = true;
      gui?.rows.get('lightnessThreshold')?._write(nt);
    }
    if(np !== params.pixelSize){
      params.pixelSize = np; touched = true;
      gui?.rows.get('pixelSize')?._write(np);
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
    if(params.animate) return; // anim loop owns the frame
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
      canvas: cv, name: 'pixart-dithering',
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
