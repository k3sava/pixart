// pixart/dithering — port of tooooools.app/effects/dithering.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/dithering/page-c651560ea284d530.js,
//  shared preprocessor + page defaults in /_next/static/chunks/9357-2a51c42cdfe973de.js).
//
// What the reference effect is:
//   - Image dither pipeline: image → grid downsample → quantise via a chosen
//     pattern → upsample to pixel blocks.
//   - Bundle ships three patterns: Floyd-Steinberg, 4×4 Bayer, Random.
//   - Two colour modes: mono (threshold) and palette (RGB nearest).
//
// Refinement pass (2026-05-13): mode-keyed envelope, an Atkinson algorithm
// added for swap, a serpentine toggle for Floyd-Steinberg, and a luminance
// bias slider. Atkinson (Bill Atkinson, MacPaint 1984) diffuses only 6/8 of
// the error which is why MacPaint screenshots have that signature burnt-in
// highlight. Yliluoma's serpentine pass (2011) flips the F-S scan direction
// each row, breaking the diagonal grain that pure left-to-right F-S leaves
// behind. Bayer is from the 1973 IEEE paper; Random is the noise-floor
// baseline both papers measure against.
//
// All animation envelopes wrap t to [0,1) and explicitly route t=1 to t=0
// state so the loop is byte-equal even for step modes (march, swap).
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
  // Dithering-specific (bundle defaults preserved, except pixelSize 2→4 for landing).
  patternType:       'F-S',   // 'F-S' | 'Bayer' | 'Random' | 'Atkinson'
  pixelSize:         4,
  lightnessThreshold: 255,
  colorMode:         false,
  colorCount:        24,
  showEffect:        true,
  pixelSweep:        6,       // breath amplitude
  // ---- Refinement pass (2026-05-13) ----
  // Mode-keyed envelope. Each mode animates a different param subset.
  //   idle    — no animation
  //   breath  — cosine pingpong on pixelSize (original)
  //   march   — Bayer matrix size steps 2→4→8→16→2 (held for 1/4 of loop
  //             each). Visible quantisation-grain doubling: the dither cells
  //             coarsen, then snap back. The size doubling is the same one
  //             Bayer's 1973 paper steps through to show the asymptotic
  //             convergence of the ordered matrix.
  //   pulse   — lightnessThreshold sharp spike + slow decay (Mach-band glow)
  //   rotate  — Bayer matrix angle sweeps 0→360°; matrix is sampled at
  //             rotated coords cos/sin. Diagonal-grain cinema.
  //   swap    — algorithm rotation through F-S → Bayer → Random → Atkinson
  //             held for 1/4 of loop each. A living typography of dither.
  mode:              'breath',
  // Yliluoma's serpentine F-S: alternate scan direction each row. Halves the
  // diagonal artefacts of pure left-to-right diffusion. Toggle so the
  // artefacts become a stylistic choice instead of a default.
  serpentine:        true,
  // Additive luminance pre-shift (-32..32). Applied before quantisation; used
  // to nudge the midtone pivot without dragging the threshold slider.
  bias:              0,
  // Cursor focus radius (interactive mode). Inside this radius the local
  // pixelSize halves so detail blooms under the cursor — same attentional-
  // spotlight pattern as edge/.
  focusRadius:       240,
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
let rects = null;
let rectCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

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
// `biasAdd` is the global luminance pre-shift (the `bias` slider). Applied
// after averaging so it cannot push under or over the [0,255] clip in pieces.
function downsample(px, W, H, gw, gh, color, biasAdd){
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
          sr += px[i]   * a + 255 * (1 - a);
          sg += px[i+1] * a + 255 * (1 - a);
          sb += px[i+2] * a + 255 * (1 - a);
          n++;
        }
      }
      if(n === 0){
        out[y * gw + x] = color ? { r: 255, g: 255, b: 255 } : 255;
      } else if(color){
        out[y * gw + x] = {
          r: clamp(Math.round(sr / n + biasAdd), 0, 255),
          g: clamp(Math.round(sg / n + biasAdd), 0, 255),
          b: clamp(Math.round(sb / n + biasAdd), 0, 255),
        };
      } else {
        out[y * gw + x] = clamp((sr + sg + sb) / (3 * n) + biasAdd, 0, 255);
      }
    }
  }
  return out;
}

// ---------- Bayer matrices ----------
//
// 2×2, 4×4, 8×8, 16×16 matrices. Generated by the canonical recursion:
//   M_{2n}(x,y) = 4·M_n(x mod n, y mod n) + B_2(x ÷ n, y ÷ n)
// where B_2 = [[0,2],[3,1]]. We carry the *normalised threshold* form
// (M[y][x] / N² → [0,1)) so the same comparison works at any size.
const BAYER2  = [[0,2],[3,1]];
function buildBayer(n){
  if(n === 2) return BAYER2;
  const half = buildBayer(n / 2);
  const out = [];
  for(let y = 0; y < n; y++){
    out[y] = [];
    for(let x = 0; x < n; x++){
      const q = (y < n/2 ? 0 : (x < n/2 ? 3 : 1)); // top-left=0, top-right=2, bot-left=3, bot-right=1
      const bx = x < n/2 ? 0 : 1, by = y < n/2 ? 0 : 1;
      out[y][x] = 4 * half[y % (n/2)][x % (n/2)] + BAYER2[by][bx];
    }
  }
  return out;
}
const BAYER_CACHE = { 2: buildBayer(2), 4: buildBayer(4), 8: buildBayer(8), 16: buildBayer(16) };

// Bayer with rotated sampling. For `rotate` mode we sample M at
// (round(x·cos − y·sin) mod n, round(x·sin + y·cos) mod n) — the matrix
// itself doesn't rotate, the lookup coords do, which is what gives the
// diagonal stripe sweep instead of a content rotation.
function bayerLookup(M, x, y, n, cos, sin){
  if(cos === 1 && sin === 0) return M[y % n][x % n];
  const rx = Math.round( x * cos - y * sin);
  const ry = Math.round( x * sin + y * cos);
  return M[((ry % n) + n) % n][((rx % n) + n) % n];
}

// ---------- patterns ----------

function fsMono(grid, gw, gh, threshold, serpentine){
  const scale = 255 / Math.max(1, threshold);
  for(let y = 0; y < gh; y++){
    // Serpentine: even rows L→R, odd rows R→L. Direction sign flips error
    // weights horizontally; vertical weights are unchanged.
    const reverse = serpentine && (y & 1) === 1;
    const xStart = reverse ? gw - 1 : 0;
    const xEnd   = reverse ? -1     : gw;
    const xStep  = reverse ? -1     : 1;
    const sgn    = reverse ? -1     : 1;
    for(let x = xStart; x !== xEnd; x += xStep){
      const i = x + y * gw;
      const v = Math.min(255, Math.max(0, grid[i] * scale));
      const q = v > 127 ? 255 : 0;
      grid[i] = q;
      const err = v - q;
      if(x + sgn >= 0 && x + sgn < gw)               grid[i + sgn]       += 7 * err / 16 / scale;
      if(x - sgn >= 0 && x - sgn < gw && y + 1 < gh) grid[i + gw - sgn]  += 3 * err / 16 / scale;
      if(y + 1 < gh)                                  grid[i + gw]        += 5 * err / 16 / scale;
      if(x + sgn >= 0 && x + sgn < gw && y + 1 < gh) grid[i + gw + sgn]  += 1 * err / 16 / scale;
    }
  }
}

function fsColor(grid, gw, gh, palette, serpentine){
  for(let y = 0; y < gh; y++){
    const reverse = serpentine && (y & 1) === 1;
    const xStart = reverse ? gw - 1 : 0;
    const xEnd   = reverse ? -1     : gw;
    const xStep  = reverse ? -1     : 1;
    const sgn    = reverse ? -1     : 1;
    for(let x = xStart; x !== xEnd; x += xStep){
      const i = x + y * gw;
      const c = grid[i];
      const q = nearestColor(c.r, c.g, c.b, palette);
      grid[i] = q;
      const er = c.r - q.r, eg = c.g - q.g, eb = c.b - q.b;
      const spread = (xx, yy, w) => {
        if(xx < 0 || xx >= gw || yy < 0 || yy >= gh) return;
        const t = grid[yy * gw + xx];
        if(typeof t !== 'object') return; // already quantised neighbour (different row scan)
        t.r = clamp(t.r + er * w, 0, 255);
        t.g = clamp(t.g + eg * w, 0, 255);
        t.b = clamp(t.b + eb * w, 0, 255);
      };
      spread(x + sgn, y,     7 / 16);
      if(y + 1 < gh){
        spread(x - sgn, y + 1, 3 / 16);
        spread(x,       y + 1, 5 / 16);
        spread(x + sgn, y + 1, 1 / 16);
      }
    }
  }
}

// Atkinson (Bill Atkinson, MacPaint 1984). Diffuses 6/8 = 75% of the error;
// the missing 25% is the burnt-in-highlights signature of MacPaint output.
// Weights are all 1/8, distributed as:
//
//            X   1/8 1/8
//      1/8 1/8 1/8
//             1/8
//
// Atkinson dithering is NOT serpentine in the original implementation —
// MacPaint scans strictly left-to-right — so we honour that and ignore the
// serpentine flag here.
function atkinsonMono(grid, gw, gh, threshold){
  const scale = 255 / Math.max(1, threshold);
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const v = Math.min(255, Math.max(0, grid[i] * scale));
      const q = v > 127 ? 255 : 0;
      grid[i] = q;
      const err8 = (v - q) / 8 / scale;
      if(x + 1 < gw)                grid[i + 1]      += err8;
      if(x + 2 < gw)                grid[i + 2]      += err8;
      if(y + 1 < gh && x - 1 >= 0)  grid[i + gw - 1] += err8;
      if(y + 1 < gh)                grid[i + gw]     += err8;
      if(y + 1 < gh && x + 1 < gw)  grid[i + gw + 1] += err8;
      if(y + 2 < gh)                grid[i + 2*gw]   += err8;
    }
  }
}

function atkinsonColor(grid, gw, gh, palette){
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const c = grid[i];
      const q = nearestColor(c.r, c.g, c.b, palette);
      grid[i] = q;
      const er = (c.r - q.r) / 8, eg = (c.g - q.g) / 8, eb = (c.b - q.b) / 8;
      const at = (xx, yy) => {
        if(xx < 0 || xx >= gw || yy < 0 || yy >= gh) return;
        const t = grid[yy * gw + xx];
        if(typeof t !== 'object') return;
        t.r = clamp(t.r + er, 0, 255);
        t.g = clamp(t.g + eg, 0, 255);
        t.b = clamp(t.b + eb, 0, 255);
      };
      at(x+1, y); at(x+2, y);
      at(x-1, y+1); at(x, y+1); at(x+1, y+1);
      at(x, y+2);
    }
  }
}

function bayerMono(grid, gw, gh, threshold, matrixSize, cos, sin){
  const M = BAYER_CACHE[matrixSize] || BAYER_CACHE[4];
  const N2 = matrixSize * matrixSize;
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      // Local threshold: (threshold/128) · (M/N²) · 255. Same shape as the
      // bundle's 4×4 formula, generalised across N.
      const m = bayerLookup(M, x, y, matrixSize, cos, sin);
      const local = (threshold / 128) * (m / N2) * 255;
      grid[i] = grid[i] > local ? 255 : 0;
    }
  }
}

function bayerColor(grid, gw, gh, palette, matrixSize, cos, sin){
  const M = BAYER_CACHE[matrixSize] || BAYER_CACHE[4];
  const N2 = matrixSize * matrixSize;
  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const i = x + y * gw;
      const c = grid[i];
      const pair = twoNearest(c.r, c.g, c.b, palette);
      const m = bayerLookup(M, x, y, matrixSize, cos, sin) / N2;
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

// ---------- build rects ----------
//
// Per-mode transients (set by renderAnimationFrame, consumed here). Keeping
// them as module globals matches the edge/ canonical pattern: the inner loop
// stays cache-warm and there's no per-frame allocation.
let _bayerSize = 4;       // march / rotate / breath all read this
let _bayerCos  = 1;       // rotate sampling
let _bayerSin  = 0;
let _patternOverride = null;  // swap mode injects a different algorithm name

function buildRects(){
  if(!preprocessed){ rectCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const ps = Math.max(1, params.pixelSize | 0);
  const gw = Math.ceil(W / ps);
  const gh = Math.ceil(H / ps);
  if(gw === 0 || gh === 0){ rectCount = 0; return; }

  const grid = downsample(preprocessed.data, W, H, gw, gh, params.colorMode, params.bias || 0);
  const rng = (params.patternType === 'Random' || _patternOverride === 'Random') ? _rng : Math.random;
  const algo = _patternOverride || params.patternType;

  switch(algo){
    case 'F-S':
      if(params.colorMode) fsColor(grid, gw, gh, genPalette(params.colorCount), params.serpentine);
      else                 fsMono(grid, gw, gh, params.lightnessThreshold, params.serpentine);
      break;
    case 'Bayer':
      if(params.colorMode) bayerColor(grid, gw, gh, genPalette(params.colorCount), _bayerSize, _bayerCos, _bayerSin);
      else                 bayerMono(grid, gw, gh, params.lightnessThreshold, _bayerSize, _bayerCos, _bayerSin);
      break;
    case 'Random':
      if(params.colorMode) randColor(grid, gw, gh, genPalette(params.colorCount), rng);
      else                 randMono(grid, gw, gh, params.lightnessThreshold, rng);
      break;
    case 'Atkinson':
      if(params.colorMode) atkinsonColor(grid, gw, gh, genPalette(params.colorCount));
      else                 atkinsonMono(grid, gw, gh, params.lightnessThreshold);
      break;
  }

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

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

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
// Mode envelopes. All wrap t to [0,1) so cos(2π·t)==cos(0)==1 at the seam.
// march / swap / rotate are step modes; we explicitly route t=1 → t=0 state.

const MARCH_BAYER_SIZES = [2, 4, 8, 16];   // doublings + wrap to 2
const SWAP_ALGOS = ['F-S', 'Bayer', 'Random', 'Atkinson'];

function envelopeT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  return w;
}

function applyAnimationT(tLoop){
  const t01 = envelopeT(tLoop);
  const pp  = (1 - Math.cos(t01 * 2 * Math.PI)) / 2; // pingpong, peaks at 0.5
  // Defaults: rest state for every transient.
  let pixelSize        = params.pixelSize;
  let lightnessThresh  = params.lightnessThreshold;
  let bayerSize        = 4;                        // canonical 4×4
  let bayerCos         = 1, bayerSin = 0;
  let patternOverride  = null;

  switch(params.mode){
    case 'idle': {
      break;
    }
    case 'breath': {
      // Original: pixelSize cosine pingpong.
      pixelSize = clamp(Math.round(params.pixelSize + params.pixelSweep * pp), 1, 40);
      break;
    }
    case 'march': {
      // Step the Bayer matrix size through 2 → 4 → 8 → 16, held for 1/4 of
      // the loop each. The quantisation grain visibly doubles. We pin the
      // pattern to Bayer for the duration so the matrix-size change is the
      // only knob the eye sees.
      const beat = (t01 === 0) ? 0 : Math.floor(t01 * 4) % 4;
      bayerSize = MARCH_BAYER_SIZES[beat];
      patternOverride = 'Bayer';
      break;
    }
    case 'pulse': {
      // Sharp asymmetric envelope: 0.2 of the loop is the spike up, 0.8 is
      // the slow decay back. lightnessThreshold pivots between base and 0.
      // The base value at t=0 and t=1 must match; the decay term `(1-(t-0.2)/0.8)^2.5`
      // reaches 0 at t=1 → identical to t=0 state.
      const tEnv = t01 < 0.2
        ? (t01 / 0.2)
        : Math.pow(1 - (t01 - 0.2) / 0.8, 2.5);
      // Spike DROPS threshold (more detail), decays back to base. Asymmetric
      // shape is the Mach-band-friendly look.
      const sweep = Math.min(200, params.lightnessThreshold);
      lightnessThresh = clamp(params.lightnessThreshold - sweep * 0.7 * tEnv, 1, 255);
      break;
    }
    case 'rotate': {
      // Bayer matrix angle 0→360° monotonically. The matrix doesn't rotate;
      // the *lookup coords* do (cos/sin sample). Diagonal grain sweeps once
      // per loop. At t=0 and t=1 the cos/sin both round to (1, 0).
      const angle = t01 * 2 * Math.PI;
      bayerCos = Math.cos(angle);
      bayerSin = Math.sin(angle);
      if(t01 === 0){ bayerCos = 1; bayerSin = 0; }
      patternOverride = 'Bayer';
      break;
    }
    case 'swap': {
      // Rotate algorithms through F-S → Bayer → Random → Atkinson, held for
      // 1/4 of the loop each. A living typography of dither.
      const beat = (t01 === 0) ? 0 : Math.floor(t01 * SWAP_ALGOS.length) % SWAP_ALGOS.length;
      patternOverride = SWAP_ALGOS[beat];
      break;
    }
  }
  return { pixelSize, lightnessThresh, bayerSize, bayerCos, bayerSin, patternOverride };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  const restPS = params.pixelSize;
  const restTH = params.lightnessThreshold;
  params.pixelSize          = anim.pixelSize;
  params.lightnessThreshold = anim.lightnessThresh;
  _bayerSize = anim.bayerSize;
  _bayerCos  = anim.bayerCos;
  _bayerSin  = anim.bayerSin;
  _patternOverride = anim.patternOverride;

  const needsSeeded = params.grainAmount > 0
                    || params.patternType === 'Random'
                    || _patternOverride === 'Random';
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

  params.pixelSize          = restPS;
  params.lightnessThreshold = restTH;
  _bayerSize = 4; _bayerCos = 1; _bayerSin = 0; _patternOverride = null;
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
const BUILD_KEYS = new Set(['pixelSize','lightnessThreshold','patternType','colorMode','colorCount','pixelSweep','serpentine','bias']);
const PAINT_KEYS = new Set(['showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  // Focus radius: under the cursor, the dither pixelSize halves (finer grain
  // → more detail). Same attentional-spotlight pattern as edge/.
  if(params.interactive && !params.animate){
    if(!preprocessed){ return; }
    // Map viewport-space cursor to source-space.
    const sw = preprocessed.width, sh = preprocessed.height;
    const aspect = sw / sh;
    const W = cv.width, H = cv.height;
    let dw, dh;
    if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
    else              { dw = W * 0.96; dh = dw / aspect; }
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    const sx = (mouseX * (W / r.width)  - ox) / dw * sw;
    const sy = (mouseY * (H / r.height) - oy) / dh * sh;
    // Drive threshold by X (like before) so the slider stays meaningful, but
    // shrink pixelSize when the cursor is inside the focus circle. Sets
    // pixelSize via direct write so build() sees the new value.
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    const nt = Math.max(1, Math.round(ax * 255));
    const basePS = Math.max(1, Math.round((1 - ay) * 20));
    // Focus: pixelSize halves inside the circle (more detail).
    // The slider value is the base; we never write a "focused" value back to
    // the GUI — it's a transient per-build override.
    let touched = false;
    if(nt !== params.lightnessThreshold){
      params.lightnessThreshold = nt; touched = true;
      gui?.rows.get('lightnessThreshold')?._write(nt);
    }
    if(basePS !== params.pixelSize){
      params.pixelSize = basePS; touched = true;
      gui?.rows.get('pixelSize')?._write(basePS);
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
    if(key === 'mode'){ /* anim envelope; no static rebuild needed */ return; }
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
