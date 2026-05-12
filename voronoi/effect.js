// pixart/voronoi — Worley-style cellular tessellation coloured by source.
//
// What it is (single sentence): place N seed points across the source, then
// for every output pixel find the nearest seed (under a chosen distance
// metric) and paint that pixel with the colour sampled at the seed's
// position. The result is a tessellated stained-glass partition of the image.
//
// Why this shape:
//   - The classic Worley (1996) "cellular texture basis function" — a Voronoi
//     diagram where each pixel takes the colour of its nearest generator.
//   - Lloyd-relaxation (1957) is the canonical way to push seeds toward more
//     uniform cell areas. We expose it as a slider; even 1–2 iterations make
//     the cells visibly more regular.
//   - Metric choice (euclidean / manhattan / chebyshev / secondary) literally
//     bends the cell walls — euclidean gives organic polygons, manhattan
//     gives axis-aligned diamonds, chebyshev gives squares, "secondary" (the
//     distance to the *second*-nearest seed) gives the classic dark-ridge
//     cellular look Worley introduced for procedural textures.
//
// References baked into the implementation:
//   - Worley, S. (1996) *A Cellular Texture Basis Function*, SIGGRAPH 1996.
//     The original. Takeaway: F1 (nearest-seed distance) and F2 (second-
//     nearest) are the two scalar fields that all interesting cellular
//     textures come from; we expose `metric: secondary` as F2.
//   - Quilez, I. *Voronoi distances* + *Cellular textures*
//     (iquilezles.org/articles/voronoilines). Takeaway: borders between
//     cells are most cheaply drawn by thresholding (F2 - F1) rather than
//     by walking neighbours — same trick we use for `borderWidth`.
//   - Lloyd, S. P. (1957/1982) *Least squares quantization in PCM*. Bell
//     Labs internal note → IEEE Trans. on Info. Theory. Takeaway: iterating
//     "move each seed to the centroid of its cell" provably converges on a
//     centroidal Voronoi tessellation; 1–2 iterations is the artistic sweet
//     spot before cells become uniform-grid-boring.
//   - Hobbs, T. — Voronoi sketches (tylerxhobbs.com). Takeaway: seeding from
//     image features (luminance peaks / edge density) is what turns a
//     mathematical diagram into a portrait, hence our `seedSource` modes.
//
// Performance note: a naive per-pixel nearest-seed search is O(W·H·N). At
// 1280×720 with N=240 that's 220M comparisons/frame — borderline. We pixel-
// iterate at a downsampled grid (source-space, 600 wide by default — same as
// the rest of pixart's preprocessor target), build a Uint8 cell-id map, then
// upscale via nearest-neighbour drawImage. This caps the inner loop at
// roughly 600·H·N comparisons (≈ 12M for typical aspect), comfortably under
// the 30ms target. The tradeoff: borders are aliased at extreme upscales —
// documented and acceptable for a stained-glass aesthetic.
//
// 15s seamless loop: every envelope wraps t to [0,1) so cos(2π·t) is exact;
// step modes (`march` metric rotation) pin t=1 to step 0; `drift` uses a
// Perlin offset that wraps at the period; `pulse` count goes 0.5x→2x→0.5x
// on a cosine pingpong (byte-equal endpoints). → renderAt(0) ≡ renderAt(1).
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (shared).
  canvasSize:  600,
  blurAmount:  0,
  grainAmount: 0,
  gamma:       1,
  blackPoint:  0,
  whitePoint:  255,
  // Voronoi-specific.
  mode:         'breath',
  seedCount:    240,
  seedSource:   'poisson',     // poisson | luminance-peaks | edge-density | uniform-grid
  metric:       'euclidean',   // euclidean | manhattan | chebyshev | secondary
  relax:        1,             // Lloyd iterations
  borderWidth:  0.5,
  borderColor:  '#0a0a0a',
  colorMode:    'sample',      // sample | average | gradient
  paletteShift: 0,             // degrees, hue rotation applied to cell colours
  seed:         42,
  focusRadius:  220,
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
let preprocessed = null;     // source ImageData @ source-space resolution
let outImg       = null;     // tessellated output @ same resolution
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// ── transient animation state ───────────────────────────────────
let _relaxMul   = 1;          // multiplier on relax iterations (breath)
let _driftPhase = 0;          // [0,1) noise-offset phase (drift)
let _seedScale  = 1;          // multiplier on seedCount (pulse)
let _metricOverride = '';     // non-empty in `march` mode
let _bloomT     = 0;          // [0,1] neighbour mix weight (bloom)
let _focusCx = -1, _focusCy = -1, _focusR2 = 0, _focusBoost = 1;

// ─── helpers ──────────────────────────────────────────────────
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
    if(dirty.build) buildOutput();
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

// ─── preprocessor (canonical) ─────────────────────────────────
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
}

// ─── Perlin 2D (canonical, reused from recolor / flow-field) ─────
const PERM = (function(){
  const p = new Uint8Array(512);
  const src = new Uint8Array(256);
  for(let i = 0; i < 256; i++) src[i] = i;
  const rng = mulberry32(1337);
  for(let i = 255; i > 0; i--){
    const j = Math.floor(rng() * (i + 1));
    const t = src[i]; src[i] = src[j]; src[j] = t;
  }
  for(let i = 0; i < 512; i++) p[i] = src[i & 255];
  return p;
})();
function fade(t){ return t*t*t*(t*(t*6 - 15) + 10); }
function grad2(hash, x, y){
  switch(hash & 3){
    case 0: return  x + y;
    case 1: return -x + y;
    case 2: return  x - y;
    case 3: return -x - y;
  }
  return 0;
}
function perlin2(x, y){
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);
  const aa = PERM[PERM[xi] + yi];
  const ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi];
  const bb = PERM[PERM[xi + 1] + yi + 1];
  const x1 = lerp(grad2(aa, xf,     yf    ), grad2(ba, xf - 1, yf    ), u);
  const x2 = lerp(grad2(ab, xf,     yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v) * 0.5 + 0.5;
}

// ─── colour helpers ──────────────────────────────────────────
function rgbToHsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if(max !== min){
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch(max){
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l){
  h = ((h % 360) + 360) % 360 / 360;
  if(s === 0){ const v = Math.round(l * 255); return [v, v, v]; }
  const hue2rgb = (p, q, t) => {
    if(t < 0) t += 1;
    if(t > 1) t -= 1;
    if(t < 1/6) return p + (q - p) * 6 * t;
    if(t < 1/2) return q;
    if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h)       * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}
function rotateHueRgb(r, g, b, deg){
  if(deg === 0) return [r, g, b];
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToRgb(h + deg, s, l);
}
function hexToRgb(hex){
  const h = String(hex || '').replace('#','');
  const v = (h.length === 3) ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0');
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ─── seed generation ─────────────────────────────────────────
//
// Returns an array of [x, y] in source-space. Number is roughly N (luminance-
// peaks may yield slightly fewer when the source lacks peaks).
function generateSeeds(N, W, H, rng){
  const src = preprocessed?.data;
  const sourceMode = params.seedSource;
  const seeds = [];

  if(sourceMode === 'uniform-grid' || !src){
    // Perfect lattice. Cols × rows ≈ N with aspect-aware spacing.
    const cols = Math.max(1, Math.round(Math.sqrt(N * W / H)));
    const rows = Math.max(1, Math.round(N / cols));
    for(let j = 0; j < rows; j++){
      for(let i = 0; i < cols; i++){
        seeds.push([(i + 0.5) * W / cols, (j + 0.5) * H / rows]);
      }
    }
    return seeds;
  }
  if(sourceMode === 'poisson'){
    // Cheap "poisson-ish" via best-candidate sampling (Mitchell 1991): for each
    // seed, generate K candidates and keep the one farthest from existing
    // seeds. K=10 gives a visibly more even distribution than uniform random
    // without the full Bridson algorithm complexity.
    const K = 10;
    seeds.push([rng() * W, rng() * H]);
    for(let i = 1; i < N; i++){
      let bestX = 0, bestY = 0, bestD = -1;
      for(let k = 0; k < K; k++){
        const x = rng() * W, y = rng() * H;
        let minD = Infinity;
        for(let s = 0; s < seeds.length; s++){
          const dx = seeds[s][0] - x, dy = seeds[s][1] - y;
          const d2 = dx*dx + dy*dy;
          if(d2 < minD) minD = d2;
        }
        if(minD > bestD){ bestD = minD; bestX = x; bestY = y; }
      }
      seeds.push([bestX, bestY]);
    }
    return seeds;
  }
  if(sourceMode === 'luminance-peaks' || sourceMode === 'edge-density'){
    // Rejection-sample: probability proportional to luminance (or |Sobel|).
    // Cheap and gives the expected feature-aware seeding without explicit
    // peak detection.
    const wantEdge = (sourceMode === 'edge-density');
    const weight = new Float32Array(W * H);
    let wmax = 0;
    if(!wantEdge){
      for(let y = 0, j = 0; y < H; y++){
        for(let x = 0; x < W; x++, j++){
          const k = j * 4;
          const lum = (src[k] + src[k+1] + src[k+2]) / 3;
          weight[j] = lum;
          if(lum > wmax) wmax = lum;
        }
      }
    } else {
      // Roberts-cross magnitude — single-pass, fast, good enough as an edge proxy.
      for(let y = 0; y < H - 1; y++){
        for(let x = 0; x < W - 1; x++){
          const j  = y * W + x;
          const k  = j * 4;
          const kr = (j + 1) * 4;
          const kd = (j + W) * 4;
          const l00 = (src[k]   + src[k+1]   + src[k+2]) / 3;
          const l10 = (src[kr]  + src[kr+1]  + src[kr+2]) / 3;
          const l01 = (src[kd]  + src[kd+1]  + src[kd+2]) / 3;
          const m = Math.abs(l10 - l00) + Math.abs(l01 - l00);
          weight[j] = m;
          if(m > wmax) wmax = m;
        }
      }
    }
    if(wmax === 0) wmax = 1;
    let attempts = 0;
    const maxAttempts = N * 200;
    while(seeds.length < N && attempts < maxAttempts){
      const x = (rng() * W) | 0;
      const y = (rng() * H) | 0;
      const j = y * W + x;
      const p = weight[j] / wmax;
      if(rng() < p){ seeds.push([x + 0.5, y + 0.5]); }
      attempts++;
    }
    // If feature-poor source starved us, top-up with uniform samples.
    while(seeds.length < N) seeds.push([rng() * W, rng() * H]);
    return seeds;
  }
  // Fallback: uniform random.
  for(let i = 0; i < N; i++) seeds.push([rng() * W, rng() * H]);
  return seeds;
}

// ─── Lloyd relaxation ────────────────────────────────────────
//
// Walk every pixel, accumulate centroid for each seed's cell, replace seed
// with the centroid, repeat `iter` times. This is the textbook k-means /
// CVT construction.
function lloydRelax(seeds, iter, W, H){
  if(iter <= 0) return seeds;
  const N = seeds.length;
  const m  = chooseMetric(params.metric === 'secondary' ? 'euclidean' : params.metric);
  for(let it = 0; it < iter; it++){
    const sx = new Float64Array(N);
    const sy = new Float64Array(N);
    const ct = new Uint32Array(N);
    // Sample on a stride for speed; with stride=4 the centroid error is
    // imperceptible on the relaxation outcome.
    const stride = 3;
    for(let y = 0; y < H; y += stride){
      for(let x = 0; x < W; x += stride){
        let best = 0, bd = Infinity;
        for(let k = 0; k < N; k++){
          const d = m(seeds[k][0] - x, seeds[k][1] - y);
          if(d < bd){ bd = d; best = k; }
        }
        sx[best] += x; sy[best] += y; ct[best]++;
      }
    }
    for(let k = 0; k < N; k++){
      if(ct[k] > 0){
        seeds[k][0] = sx[k] / ct[k];
        seeds[k][1] = sy[k] / ct[k];
      }
    }
  }
  return seeds;
}

function chooseMetric(name){
  switch(name){
    case 'manhattan':  return (dx, dy) => Math.abs(dx) + Math.abs(dy);
    case 'chebyshev':  return (dx, dy) => Math.max(Math.abs(dx), Math.abs(dy));
    case 'euclidean':
    case 'secondary':
    default:           return (dx, dy) => dx*dx + dy*dy;     // squared, monotonic
  }
}

// ─── output build ────────────────────────────────────────────
//
// Per source-space pixel: find nearest seed (and second-nearest if metric =
// `secondary` or borderWidth > 0). Write the seed's sampled colour into
// outImg. For `colorMode: average` we run a second pass that averages the
// pixels assigned to each cell (heavier — flagged in the dossier).
function buildOutput(){
  if(!preprocessed){ outImg = null; return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(!outImg || outImg.width !== W || outImg.height !== H){
    outImg = new ImageData(W, H);
  }
  const src = preprocessed.data;
  const dst = outImg.data;

  // Resolve effective seed count. Pulse mode modulates via _seedScale, focus
  // boost is applied later when looking up neighbours (not here — global).
  const Nbase = Math.max(2, (params.seedCount | 0));
  const N = Math.max(2, Math.round(Nbase * _seedScale));
  const rng = mulberry32((params.seed | 0));

  // 1. seeds
  let seeds = generateSeeds(N, W, H, rng);
  // 2. drift offset (drift mode): translate each seed by a wrapping noise term.
  if(_driftPhase !== 0){
    const tau = _driftPhase * 2 * Math.PI;
    const ampl = Math.min(W, H) * 0.06;
    for(let i = 0; i < seeds.length; i++){
      const a = perlin2(seeds[i][0] * 0.01, seeds[i][1] * 0.01) * 2 * Math.PI;
      // x = base + ampl·sin(a+tau) wraps exactly at tau += 2π (drift cycles).
      seeds[i][0] = seeds[i][0] + ampl * (Math.sin(a + tau) - Math.sin(a));
      seeds[i][1] = seeds[i][1] + ampl * (Math.cos(a + tau) - Math.cos(a));
    }
  }
  // 3. lloyd relaxation
  const iter = Math.max(0, Math.round((params.relax | 0) * _relaxMul));
  if(iter > 0) seeds = lloydRelax(seeds, iter, W, H);

  // 4. focus boost (interactive): inject extra local seeds inside focus circle.
  if(_focusR2 > 0 && _focusBoost > 1){
    const extra = Math.round(N * 0.5 * (_focusBoost - 1));
    const r = Math.sqrt(_focusR2);
    const fr = mulberry32(((params.seed | 0) + 7777) >>> 0);
    for(let k = 0; k < extra; k++){
      // Uniform-in-disc sampling: r·sqrt(u).
      const ang = fr() * 2 * Math.PI;
      const rad = Math.sqrt(fr()) * r;
      seeds.push([_focusCx + Math.cos(ang) * rad, _focusCy + Math.sin(ang) * rad]);
    }
  }

  // 5. choose metric (march mode override)
  const effMetric = _metricOverride || params.metric;
  const mFn = chooseMetric(effMetric);
  const useSecondary = (effMetric === 'secondary');
  const borderPx = params.borderWidth;
  const borderRgb = hexToRgb(params.borderColor);
  const wantBorder = borderPx > 0;
  const hue = params.paletteShift;

  // 6. pre-sample each seed's source colour (sample / gradient modes).
  // We always pre-sample because the per-pixel inner loop must be tight.
  const seedR = new Uint8ClampedArray(seeds.length);
  const seedG = new Uint8ClampedArray(seeds.length);
  const seedB = new Uint8ClampedArray(seeds.length);
  for(let k = 0; k < seeds.length; k++){
    const sx = clamp(seeds[k][0] | 0, 0, W - 1);
    const sy = clamp(seeds[k][1] | 0, 0, H - 1);
    const j = (sy * W + sx) * 4;
    let r = src[j], g = src[j+1], b = src[j+2];
    if(hue !== 0){
      const c = rotateHueRgb(r, g, b, hue);
      r = c[0]; g = c[1]; b = c[2];
    }
    seedR[k] = r; seedG[k] = g; seedB[k] = b;
  }

  // 6b. bloom mode: mix each seed colour with the average of its 4 nearest
  // neighbour seeds, weighted by _bloomT (cosine envelope). Reads as cells
  // "exhaling" colour into each other.
  if(_bloomT > 0){
    // Build per-seed list of 4 nearest neighbour seed indices (single pass).
    const Ns = seeds.length;
    const nb = new Int32Array(Ns * 4);
    for(let k = 0; k < Ns; k++){
      let d0 = Infinity, d1 = Infinity, d2 = Infinity, d3 = Infinity;
      let i0 = -1, i1 = -1, i2 = -1, i3 = -1;
      for(let j = 0; j < Ns; j++){
        if(j === k) continue;
        const dx = seeds[j][0] - seeds[k][0];
        const dy = seeds[j][1] - seeds[k][1];
        const d = dx*dx + dy*dy;
        if(d < d0){ d3=d2; i3=i2; d2=d1; i2=i1; d1=d0; i1=i0; d0=d; i0=j; }
        else if(d < d1){ d3=d2; i3=i2; d2=d1; i2=i1; d1=d; i1=j; }
        else if(d < d2){ d3=d2; i3=i2; d2=d; i2=j; }
        else if(d < d3){ d3=d; i3=j; }
      }
      nb[k*4] = i0; nb[k*4+1] = i1; nb[k*4+2] = i2; nb[k*4+3] = i3;
    }
    const newR = new Uint8ClampedArray(Ns);
    const newG = new Uint8ClampedArray(Ns);
    const newB = new Uint8ClampedArray(Ns);
    for(let k = 0; k < Ns; k++){
      let ar = 0, ag = 0, ab = 0, cnt = 0;
      for(let q = 0; q < 4; q++){
        const id = nb[k*4 + q];
        if(id < 0) continue;
        ar += seedR[id]; ag += seedG[id]; ab += seedB[id]; cnt++;
      }
      if(cnt > 0){ ar /= cnt; ag /= cnt; ab /= cnt; }
      newR[k] = lerp(seedR[k], ar, _bloomT);
      newG[k] = lerp(seedG[k], ag, _bloomT);
      newB[k] = lerp(seedB[k], ab, _bloomT);
    }
    for(let k = 0; k < Ns; k++){ seedR[k]=newR[k]; seedG[k]=newG[k]; seedB[k]=newB[k]; }
  }

  // 7. tessellate. For every pixel, find nearest seed; for borders / secondary
  // metric also find second-nearest. Inner loop is tight; metric is a closure
  // call (V8 inlines after warmup).
  const Ns = seeds.length;
  // Pull seed positions into flat arrays — array-of-arrays access is slower.
  const sxs = new Float32Array(Ns);
  const sys = new Float32Array(Ns);
  for(let k = 0; k < Ns; k++){ sxs[k] = seeds[k][0]; sys[k] = seeds[k][1]; }

  // colorMode: gradient — distance to seed modulates colour (lerp toward
  // borderColor as distance grows). Reads as stained-glass curvature.
  const useGradient = (params.colorMode === 'gradient');
  // Average mode: accumulate cell colours from src, then re-paint.
  const useAverage = (params.colorMode === 'average');

  // Per-pixel assignment buffer (cell index). Reused for average / gradient.
  const cellIdx = new Int32Array(W * H);

  for(let y = 0; y < H; y++){
    for(let x = 0; x < W; x++){
      let best = 0, second = 0;
      let bd = Infinity, sd = Infinity;
      for(let k = 0; k < Ns; k++){
        const d = mFn(sxs[k] - x, sys[k] - y);
        if(d < bd){ sd = bd; second = best; bd = d; best = k; }
        else if(d < sd){ sd = d; second = k; }
      }
      const j = (y * W + x) * 4;
      cellIdx[y * W + x] = best;

      let r, g, b;
      if(useSecondary){
        // F2 - F1 (Worley 1996). Normalise by an approximate cell radius so
        // the gradient is reasonable across seed densities. We approximate
        // radius as sqrt(W·H / N) (mean cell area's radius).
        const rApprox = Math.sqrt((W * H) / Ns);
        const v = clamp((Math.sqrt(sd) - Math.sqrt(bd)) / rApprox, 0, 1);
        r = lerp(borderRgb[0], seedR[best], v);
        g = lerp(borderRgb[1], seedG[best], v);
        b = lerp(borderRgb[2], seedB[best], v);
      } else {
        r = seedR[best]; g = seedG[best]; b = seedB[best];
        if(useGradient){
          // Distance-to-seed normalised by approx cell radius → 0 at centre,
          // 1 at edge. Lerp colour toward borderColor for stained-glass curvature.
          const rApprox = Math.sqrt((W * H) / Ns);
          const dist = (params.metric === 'euclidean')
            ? Math.sqrt(bd) / rApprox
            : Math.min(1, bd / rApprox);
          const u = clamp(dist, 0, 1) * 0.5;
          r = lerp(r, borderRgb[0], u);
          g = lerp(g, borderRgb[1], u);
          b = lerp(b, borderRgb[2], u);
        }
      }

      // Border: threshold on (F2 - F1) → narrow ridge between adjacent cells.
      // For squared euclidean we apply sqrt; otherwise raw difference is fine.
      if(wantBorder){
        let delta;
        if(params.metric === 'euclidean' || params.metric === 'secondary'){
          delta = Math.sqrt(sd) - Math.sqrt(bd);
        } else {
          delta = sd - bd;
        }
        if(delta < borderPx){
          r = borderRgb[0]; g = borderRgb[1]; b = borderRgb[2];
        }
      }
      dst[j]   = r;
      dst[j+1] = g;
      dst[j+2] = b;
      dst[j+3] = 255;
    }
  }

  // colorMode: average — second pass over the source to average colours per
  // cell, then re-emit. Documented in the dossier as the heavier mode.
  if(useAverage){
    const sumR = new Float64Array(Ns);
    const sumG = new Float64Array(Ns);
    const sumB = new Float64Array(Ns);
    const cnt  = new Uint32Array(Ns);
    for(let i = 0, j = 0; i < cellIdx.length; i++, j += 4){
      const c = cellIdx[i];
      sumR[c] += src[j]; sumG[c] += src[j+1]; sumB[c] += src[j+2];
      cnt[c]++;
    }
    const avR = new Uint8ClampedArray(Ns);
    const avG = new Uint8ClampedArray(Ns);
    const avB = new Uint8ClampedArray(Ns);
    for(let k = 0; k < Ns; k++){
      if(cnt[k] > 0){
        let r = sumR[k] / cnt[k], g = sumG[k] / cnt[k], b = sumB[k] / cnt[k];
        if(hue !== 0){ const c = rotateHueRgb(r, g, b, hue); r=c[0]; g=c[1]; b=c[2]; }
        avR[k] = r; avG[k] = g; avB[k] = b;
      } else { avR[k] = seedR[k]; avG[k] = seedG[k]; avB[k] = seedB[k]; }
    }
    for(let i = 0, j = 0; i < cellIdx.length; i++, j += 4){
      // Preserve borders we already drew (their pixels are tagged with
      // borderRgb; the cheap-and-correct way is to re-test the border ridge).
      if(wantBorder && dst[j] === borderRgb[0] && dst[j+1] === borderRgb[1] && dst[j+2] === borderRgb[2]) continue;
      const c = cellIdx[i];
      dst[j] = avR[c]; dst[j+1] = avG[c]; dst[j+2] = avB[c];
    }
  }
}

// ─── paint ─────────────────────────────────────────────────────
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!preprocessed || !outImg){ ctx.restore(); return; }

  const imgW = preprocessed.width, imgH = preprocessed.height;
  const aspect = imgW / imgH;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;

  const tmp = document.createElement('canvas');
  tmp.width = imgW; tmp.height = imgH;
  tmp.getContext('2d').putImageData(outImg, 0, 0);
  // Bilinear upscale would smear cell walls — we want the crisp stained-glass
  // look, so nearest-neighbour upscale via imageSmoothingEnabled=false.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, ox, oy, dw, dh);
  ctx.restore();
}

// ─── animation ────────────────────────────────────────────────
function applyAnimationT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  const t01 = w;
  const pp = (1 - Math.cos(t01 * 2 * Math.PI)) / 2;

  let relaxMul = 1, driftPhase = 0, seedScale = 1, metricOverride = '', bloomT = 0;
  switch(params.mode){
    case 'idle': break;
    case 'breath': {
      // Relax strength pingpong — cells become more uniform mid-cycle, then
      // relax back. Visually: "tightening then loosening" of the partition.
      relaxMul = 1 + pp * 2;
      break;
    }
    case 'drift': {
      // Seed positions migrate. Monotonic walk: 2π wraps to 0.
      driftPhase = t01;
      break;
    }
    case 'pulse': {
      // Seed density spike. 0.5x → 2x → 0.5x via pingpong.
      seedScale = 0.5 + 1.5 * pp;
      break;
    }
    case 'march': {
      // Rotate through 4 metrics. Step function; seam pin at t=0/t=1.
      const ladder = ['euclidean', 'manhattan', 'chebyshev', 'secondary'];
      let idx = Math.floor(t01 * 4);
      if(idx >= 4) idx = 3;
      if(t01 === 0) idx = 0;
      metricOverride = ladder[idx];
      break;
    }
    case 'bloom': {
      // Neighbour mix weight pingpong. Cells exhale colour into each other.
      bloomT = pp;
      break;
    }
  }
  return { relaxMul, driftPhase, seedScale, metricOverride, bloomT };
}

function renderAnimationFrame(tLoop){
  const a = applyAnimationT(tLoop);
  _relaxMul = a.relaxMul;
  _driftPhase = a.driftPhase;
  _seedScale = a.seedScale;
  _metricOverride = a.metricOverride;
  _bloomT = a.bloomT;

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
  buildOutput();
  paint();

  _relaxMul = 1; _driftPhase = 0; _seedScale = 1; _metricOverride = ''; _bloomT = 0;
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

// ─── WAEffect contract ────────────────────────────────────────
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
const BUILD_KEYS = new Set(['seedCount','seedSource','metric','relax','borderWidth','borderColor','colorMode','paletteShift','seed']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive){
    if(!preprocessed) return;
    const sw = preprocessed.width, sh = preprocessed.height;
    const aspect = sw / sh;
    const W = cv.width, H = cv.height;
    let dw, dh;
    if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
    else              { dw = W * 0.96; dh = dw / aspect; }
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    const sx = (mouseX * (W / r.width)  - ox) / dw * sw;
    const sy = (mouseY * (H / r.height) - oy) / dh * sh;
    const rSrc = params.focusRadius * sw / dw;
    _focusCx = sx; _focusCy = sy; _focusR2 = rSrc * rSrc;
    _focusBoost = 2.5;   // up to 1.5x extra seeds inside the disc
    schedule('build');
  } else if(_focusR2 !== 0){
    _focusR2 = 0; _focusBoost = 1;
    schedule('build');
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
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => { if(!params.animate) schedule('pre'); });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-voronoi',
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
