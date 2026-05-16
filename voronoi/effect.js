// pixart/voronoi — Worley-style cellular tessellation coloured by source.
//
// Place N seed points (poisson / luminance-peaks / edge-density / uniform-grid),
// optionally relax with Lloyd's algorithm, then for every output pixel find the
// nearest seed (under the chosen metric) and paint with the colour sampled at
// that seed. Optional cell-wall borders via the (F2 − F1) Quilez trick.
//
// References:
//   - Worley, S. (1996) *A Cellular Texture Basis Function*. F1/F2 fields.
//   - Quilez, I. *Voronoi distances* — borders from (F2 − F1).
//   - Lloyd, S. P. (1957/1982) — k-means / centroidal Voronoi tessellation.
//   - Mitchell (1991) best-candidate sampling for cheap poisson-ish points.
//
// Perf: spatial-hash the seeds into a coarse grid, iterate output pixels,
// only check seeds inside nearby grid cells. Inner loop touches ≪ N seeds.
//
// Step 2 (pattern-set): animation + interactive cursor layered on top.
//
// Defaults were chosen by sweeping each control alone across its full slider
// range against `portrait.jpg` in Playwright (see docs/step2-screenshots/ and
// docs/step2-research.md). Sweet spot:
//
//   seedCount=200            — portrait reads at any value ≥120; 200 = best
//                              "cellular mosaic" feel without losing the face.
//   seedSource=luminance-peaks — concentrates seeds on bright facial features
//                              (eyes, forehead, highlights), making the
//                              subject recognizable in the partition.
//   metric=euclidean         — round cells; manhattan/chebyshev produce
//                              square tiles which read less like cells.
//   relax=2                  — 2 Lloyd iterations evens out seed density
//                              while preserving the luminance-driven bias.
//   borderWidth=0.5          — thin dark mortar between cells; ≥1.5 starts
//                              dominating the image, 0 looks like a posterised
//                              flat sample.
//   paletteShift=0           — true colours by default; hue mode sweeps live.
//   colorMode=sample         — fastest + most recognizable; average smooths
//                              cells nicely but adds an O(N) pass per build.
//
// Animation modes (each = a gentle envelope across cycleMs=15000):
//
//   hue    — paletteShift sweeps 0 → 360 across one loop. PAINT-ONLY: the
//            tessellation (cellIdx + seed positions) is cached after the
//            first build, and only the seed-colour rotation + ImageData
//            rewrite runs per frame. Cheap (~5-10ms/frame).
//   breath — seedCount cosine pingpongs between 90 and 320. Cells multiply
//            and coalesce — feels alive. Requires a full rebuild per frame,
//            so this is the heaviest mode (~20-40ms/frame at canvasSize=600).
//   relax  — relax cosine pingpongs 0 → 5 → 0. Cells start scattered (raw
//            poisson) and settle into an even centroidal tessellation, then
//            spread back. Full rebuild per frame.
//
// Interactive metaphor: cursor IS the cell-field controller.
//   cursor X → seedCount (60..400)  — left = sparse / right = dense
//   cursor Y → relax     (0..6)     — top = scattered / bottom = settled
//
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (internal, not exposed in GUI).
  canvasSize:  600,
  blurAmount:  0,
  grainAmount: 0,
  gamma:       1,
  blackPoint:  0,
  whitePoint:  255,
  // Voronoi-specific.
  seedCount:    200,
  seedSource:   'luminance-peaks',
  metric:       'euclidean',
  relax:        2,
  borderWidth:  0.5,
  borderColor:  '#0a0a0a',
  colorMode:    'sample',
  paletteShift: 0,
  // Pattern-set.
  animate:      false,
  mode:         'hue',
  interactive:  false,
  // Shared chrome.
  showEffect:  true,
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;     // source ImageData @ source-space resolution
let outImg       = null;     // tessellated output @ same resolution
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// Cached tessellation for paint-only modes (e.g. hue).
// Holds the geometry of the last build so we can re-skin without re-tessellating.
let cache = null;  // {W, H, cellIdx, sxs, sys, seedSrcR, seedSrcG, seedSrcB, borderMask}

// ─── helpers ──────────────────────────────────────────────────
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

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

// ─── preprocessor ──────────────────────────────────────────────
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
  preprocessed = sctx.getImageData(0, 0, W, H);
  cache = null;  // source changed → invalidate cache
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
function generateSeeds(N, W, H, rng){
  const src = preprocessed?.data;
  const sourceMode = params.seedSource;
  const seeds = [];

  if(sourceMode === 'uniform-grid' || !src){
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
    while(seeds.length < N) seeds.push([rng() * W, rng() * H]);
    return seeds;
  }
  for(let i = 0; i < N; i++) seeds.push([rng() * W, rng() * H]);
  return seeds;
}

// ─── metrics ────────────────────────────────────────────────
function chooseMetric(name){
  switch(name){
    case 'manhattan':  return (dx, dy) => Math.abs(dx) + Math.abs(dy);
    case 'chebyshev':  return (dx, dy) => Math.max(Math.abs(dx), Math.abs(dy));
    case 'euclidean':
    case 'secondary':
    default:           return (dx, dy) => dx*dx + dy*dy;
  }
}

// ─── Lloyd relaxation ────────────────────────────────────────
function lloydRelax(seeds, iter, W, H){
  if(iter <= 0) return seeds;
  const N = seeds.length;
  const m = chooseMetric(params.metric === 'secondary' ? 'euclidean' : params.metric);
  for(let it = 0; it < iter; it++){
    const sx = new Float64Array(N);
    const sy = new Float64Array(N);
    const ct = new Uint32Array(N);
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

// ─── spatial hash ───────────────────────────────────────────
function buildHash(seeds, W, H){
  const N = seeds.length;
  const cell = Math.max(4, Math.round(Math.sqrt((W * H) / Math.max(1, N))));
  const gw = Math.max(1, Math.ceil(W / cell));
  const gh = Math.max(1, Math.ceil(H / cell));
  const counts = new Uint32Array(gw * gh);
  const gx = new Int16Array(N);
  const gy = new Int16Array(N);
  for(let i = 0; i < N; i++){
    const cx = clamp(seeds[i][0] / cell | 0, 0, gw - 1);
    const cy = clamp(seeds[i][1] / cell | 0, 0, gh - 1);
    gx[i] = cx; gy[i] = cy;
    counts[cy * gw + cx]++;
  }
  const offsets = new Uint32Array(gw * gh + 1);
  for(let i = 0; i < gw * gh; i++) offsets[i + 1] = offsets[i] + counts[i];
  const bins = new Uint32Array(N);
  const cursor = new Uint32Array(gw * gh);
  for(let i = 0; i < N; i++){
    const ci = gy[i] * gw + gx[i];
    bins[offsets[ci] + cursor[ci]++] = i;
  }
  return { cell, gw, gh, offsets, bins };
}

// ─── output build ────────────────────────────────────────────
function buildOutput(){
  if(!preprocessed){ outImg = null; cache = null; return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(!outImg || outImg.width !== W || outImg.height !== H){
    outImg = new ImageData(W, H);
  }
  const src = preprocessed.data;
  const dst = outImg.data;

  const N = Math.max(2, (params.seedCount | 0));
  const sourceCode = ({poisson:1,'luminance-peaks':2,'edge-density':3,'uniform-grid':4})[params.seedSource] || 0;
  const rng = mulberry32(((N * 131) ^ (sourceCode * 17) ^ 0xC0FFEE) >>> 0);

  let seeds = generateSeeds(N, W, H, rng);
  const iter = Math.max(0, params.relax | 0);
  if(iter > 0) seeds = lloydRelax(seeds, iter, W, H);

  const effMetric = params.metric;
  const mFn = chooseMetric(effMetric);
  const useSecondary = (effMetric === 'secondary');
  const borderPx = params.borderWidth;
  const borderRgb = hexToRgb(params.borderColor);
  const wantBorder = borderPx > 0;
  const hue = params.paletteShift;

  const Ns = seeds.length;
  // Source-sampled seed RGB (un-hue-rotated) — kept so paint-only hue can
  // re-rotate per frame.
  const seedSrcR = new Uint8ClampedArray(Ns);
  const seedSrcG = new Uint8ClampedArray(Ns);
  const seedSrcB = new Uint8ClampedArray(Ns);
  const seedR = new Uint8ClampedArray(Ns);
  const seedG = new Uint8ClampedArray(Ns);
  const seedB = new Uint8ClampedArray(Ns);
  for(let k = 0; k < Ns; k++){
    const sx = clamp(seeds[k][0] | 0, 0, W - 1);
    const sy = clamp(seeds[k][1] | 0, 0, H - 1);
    const j = (sy * W + sx) * 4;
    const r0 = src[j], g0 = src[j+1], b0 = src[j+2];
    seedSrcR[k] = r0; seedSrcG[k] = g0; seedSrcB[k] = b0;
    let r = r0, g = g0, b = b0;
    if(hue !== 0){
      const c = rotateHueRgb(r, g, b, hue);
      r = c[0]; g = c[1]; b = c[2];
    }
    seedR[k] = r; seedG[k] = g; seedB[k] = b;
  }

  const sxs = new Float32Array(Ns);
  const sys = new Float32Array(Ns);
  for(let k = 0; k < Ns; k++){ sxs[k] = seeds[k][0]; sys[k] = seeds[k][1]; }

  const hash = buildHash(seeds, W, H);
  const { cell, gw, gh, offsets, bins } = hash;

  const useGradient = (params.colorMode === 'gradient');
  const useAverage  = (params.colorMode === 'average');
  const cellIdx = new Int32Array(W * H);
  const borderMask = new Uint8Array(W * H);

  for(let y = 0; y < H; y++){
    const gyP = clamp(y / cell | 0, 0, gh - 1);
    for(let x = 0; x < W; x++){
      const gxP = clamp(x / cell | 0, 0, gw - 1);

      let best = -1, second = -1;
      let bd = Infinity, sd = Infinity;

      let radius = 0;
      const maxR = Math.max(gw, gh);
      let foundRing = -1;
      while(radius <= maxR){
        const x0 = Math.max(0, gxP - radius), x1 = Math.min(gw - 1, gxP + radius);
        const y0 = Math.max(0, gyP - radius), y1 = Math.min(gh - 1, gyP + radius);
        for(let cy = y0; cy <= y1; cy++){
          for(let cxc = x0; cxc <= x1; cxc++){
            if(radius > 0 && cxc > x0 && cxc < x1 && cy > y0 && cy < y1) continue;
            const ci = cy * gw + cxc;
            const start = offsets[ci], end = offsets[ci + 1];
            for(let p = start; p < end; p++){
              const k = bins[p];
              const d = mFn(sxs[k] - x, sys[k] - y);
              if(d < bd){ sd = bd; second = best; bd = d; best = k; }
              else if(d < sd){ sd = d; second = k; }
            }
          }
        }
        if(best !== -1 && foundRing === -1) foundRing = radius;
        if(foundRing !== -1 && radius >= foundRing + 1) break;
        radius++;
      }
      if(best === -1){ best = 0; bd = 0; }
      if(second === -1) second = best;

      const j = (y * W + x) * 4;
      const pi = y * W + x;
      cellIdx[pi] = best;

      let r, g, b;
      if(useSecondary){
        const rApprox = Math.sqrt((W * H) / Ns);
        const v = clamp((Math.sqrt(sd) - Math.sqrt(bd)) / rApprox, 0, 1);
        r = lerp(borderRgb[0], seedR[best], v);
        g = lerp(borderRgb[1], seedG[best], v);
        b = lerp(borderRgb[2], seedB[best], v);
      } else {
        r = seedR[best]; g = seedG[best]; b = seedB[best];
        if(useGradient){
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

      let isBorder = false;
      if(wantBorder){
        let delta;
        if(params.metric === 'euclidean' || params.metric === 'secondary'){
          delta = Math.sqrt(sd) - Math.sqrt(bd);
        } else {
          delta = sd - bd;
        }
        if(delta < borderPx){
          r = borderRgb[0]; g = borderRgb[1]; b = borderRgb[2];
          isBorder = true;
        }
      }
      borderMask[pi] = isBorder ? 1 : 0;
      dst[j]   = r;
      dst[j+1] = g;
      dst[j+2] = b;
      dst[j+3] = 255;
    }
  }

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
      if(borderMask[i]) continue;
      const c = cellIdx[i];
      dst[j] = avR[c]; dst[j+1] = avG[c]; dst[j+2] = avB[c];
    }
    // Cache: store the averaged (un-hue-rotated) per-cell colour so hue mode
    // can re-rotate cheaply.
    const baseR = new Uint8ClampedArray(Ns);
    const baseG = new Uint8ClampedArray(Ns);
    const baseB = new Uint8ClampedArray(Ns);
    const sumR2 = new Float64Array(Ns);
    const sumG2 = new Float64Array(Ns);
    const sumB2 = new Float64Array(Ns);
    const cnt2  = new Uint32Array(Ns);
    for(let i = 0, j = 0; i < cellIdx.length; i++, j += 4){
      const c = cellIdx[i];
      sumR2[c] += src[j]; sumG2[c] += src[j+1]; sumB2[c] += src[j+2];
      cnt2[c]++;
    }
    for(let k = 0; k < Ns; k++){
      if(cnt2[k] > 0){ baseR[k] = sumR2[k]/cnt2[k]; baseG[k] = sumG2[k]/cnt2[k]; baseB[k] = sumB2[k]/cnt2[k]; }
      else { baseR[k] = seedSrcR[k]; baseG[k] = seedSrcG[k]; baseB[k] = seedSrcB[k]; }
    }
    cache = { W, H, cellIdx, baseR, baseG, baseB, borderMask, borderRgb, mode: 'average' };
  } else {
    cache = { W, H, cellIdx, baseR: seedSrcR, baseG: seedSrcG, baseB: seedSrcB, borderMask, borderRgb, mode: 'sample' };
  }
}

// ─── paint-only recolour (hue mode) ──────────────────────────
// Reuses cached tessellation; only seed colours rotate + dst is rewritten.
// O(Ns + W*H) — no nearest-seed search.
function recolorFromCache(hueDeg){
  if(!cache || !outImg) return false;
  const { W, H, cellIdx, baseR, baseG, baseB, borderMask, borderRgb } = cache;
  if(outImg.width !== W || outImg.height !== H) return false;
  const Ns = baseR.length;
  const rotR = new Uint8ClampedArray(Ns);
  const rotG = new Uint8ClampedArray(Ns);
  const rotB = new Uint8ClampedArray(Ns);
  const tone = (typeof params._toneLevel === 'number') ? params._toneLevel : 1;
  if(hueDeg === 0){
    if(tone === 1){
      rotR.set(baseR); rotG.set(baseG); rotB.set(baseB);
    } else {
      for(let k = 0; k < Ns; k++){
        rotR[k] = baseR[k] * tone;
        rotG[k] = baseG[k] * tone;
        rotB[k] = baseB[k] * tone;
      }
    }
  } else {
    for(let k = 0; k < Ns; k++){
      const c = rotateHueRgb(baseR[k], baseG[k], baseB[k], hueDeg);
      rotR[k] = c[0] * tone; rotG[k] = c[1] * tone; rotB[k] = c[2] * tone;
    }
  }
  const dst = outImg.data;
  const br = borderRgb[0], bg = borderRgb[1], bb = borderRgb[2];
  for(let i = 0, j = 0; i < cellIdx.length; i++, j += 4){
    if(borderMask[i]){
      dst[j] = br; dst[j+1] = bg; dst[j+2] = bb;
    } else {
      const c = cellIdx[i];
      dst[j] = rotR[c]; dst[j+1] = rotG[c]; dst[j+2] = rotB[c];
    }
    dst[j+3] = 255;
  }
  return true;
}

// ─── paint ─────────────────────────────────────────────────────
let paintScratch = null;
function paint(){
  window.WAGUI?.flashValues(params);
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!preprocessed){ ctx.restore(); return; }

  const imgW = preprocessed.width, imgH = preprocessed.height;
  const aspect = imgW / imgH;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;

  if(!params.showEffect){
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcBuf, ox, oy, dw, dh);
    ctx.restore();
    return;
  }

  if(!outImg){ ctx.restore(); return; }
  if(!paintScratch || paintScratch.width !== imgW || paintScratch.height !== imgH){
    paintScratch = document.createElement('canvas');
    paintScratch.width = imgW; paintScratch.height = imgH;
  }
  paintScratch.getContext('2d').putImageData(outImg, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(paintScratch, ox, oy, dw, dh);
  ctx.restore();
}

// ─── animation ─────────────────────────────────────────────
const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

// applyMode returns {restore, paintOnly}:
//   restore   — rolls params back so the GUI doesn't visibly jitter.
//   paintOnly — true if this mode only modulates a colour-side param,
//               in which case we skip buildOutput and recolour from cache.
function applyMode(t01){
  const mode = params.mode;
  if(mode === 'hue'){
    const base = params.paletteShift;
    params.paletteShift = (t01 * 360) % 360;
    return { restore: () => { params.paletteShift = base; }, paintOnly: true };
  }
  if(mode === 'tone'){
    // Cells pulse from full colour → dark → full colour. Paint-only:
    // we don't touch the tessellation, we just scale every cell's RGB
    // toward black under a cosine envelope (1.0 → 0.35 → 1.0).
    // toneLevel is read by recolorFromCache when set on params.
    const base = params._toneLevel;
    params._toneLevel = 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(t01 * Math.PI * 2));
    return { restore: () => { params._toneLevel = base; }, paintOnly: true };
  }
  return { restore: () => {}, paintOnly: false };
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return { restore: () => {}, paintOnly: false };
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseSeed = params.seedCount;
  const baseRelax = params.relax;
  // X: seedCount 60..400. Y: relax 0..6.
  params.seedCount = Math.round(60 + ax * 340);
  params.relax = Math.round(ay * 6);
  return {
    restore: () => { params.seedCount = baseSeed; params.relax = baseRelax; },
    paintOnly: false,
  };
}

function renderAt(t01){
  const modeApp = params.animate ? applyMode(t01) : { restore: () => {}, paintOnly: false };
  const intApp  = applyInteractive();
  // Interactive overrides paintOnly (it changes geometry).
  const paintOnly = modeApp.paintOnly && !(params.interactive && hasMouse);
  if(paintOnly && cache){
    recolorFromCache(params.paletteShift);
  } else {
    buildOutput();
  }
  paint();
  intApp.restore();
  modeApp.restore();
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
const BUILD_KEYS = new Set(['seedCount','seedSource','metric','relax','borderWidth','borderColor','colorMode','paletteShift']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('paint'); }
      return;
    }
    if(key === 'mode' || key === 'interactive'){
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
      canvas: cv, name: 'pixart-voronoi',
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
