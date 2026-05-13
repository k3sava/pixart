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
'use strict';

const CYCLE_MS = 0;

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
  seedSource:   'poisson',     // poisson | luminance-peaks | edge-density | uniform-grid
  metric:       'euclidean',   // euclidean | manhattan | chebyshev | secondary
  relax:        1,             // Lloyd iterations
  borderWidth:  0.5,
  borderColor:  '#0a0a0a',
  colorMode:    'sample',      // sample | average | gradient
  paletteShift: 0,
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
    // Best-candidate sampling (Mitchell 1991), K=10.
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
// Return squared/raw distance (monotonic — fine for argmin). Border + secondary
// paths sqrt() euclidean explicitly.
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
// Bin seeds by coarse grid. For each pixel, scan only nearby bins (expanding
// radius until we have any candidate, then one more ring to guarantee F1/F2).
function buildHash(seeds, W, H){
  const N = seeds.length;
  // target ~1 seed/cell on average
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
  if(!preprocessed){ outImg = null; return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(!outImg || outImg.width !== W || outImg.height !== H){
    outImg = new ImageData(W, H);
  }
  const src = preprocessed.data;
  const dst = outImg.data;

  const N = Math.max(2, (params.seedCount | 0));
  // Deterministic RNG seeded from N + seedSource hash so cells are stable.
  const sourceCode = ({poisson:1,'luminance-peaks':2,'edge-density':3,'uniform-grid':4})[params.seedSource] || 0;
  const rng = mulberry32(((N * 131) ^ (sourceCode * 17) ^ 0xC0FFEE) >>> 0);

  // 1. seeds
  let seeds = generateSeeds(N, W, H, rng);
  // 2. lloyd relaxation
  const iter = Math.max(0, params.relax | 0);
  if(iter > 0) seeds = lloydRelax(seeds, iter, W, H);

  // 3. metric
  const effMetric = params.metric;
  const mFn = chooseMetric(effMetric);
  const useSecondary = (effMetric === 'secondary');
  const borderPx = params.borderWidth;
  const borderRgb = hexToRgb(params.borderColor);
  const wantBorder = borderPx > 0;
  const hue = params.paletteShift;

  // 4. pre-sample seed colours
  const Ns = seeds.length;
  const seedR = new Uint8ClampedArray(Ns);
  const seedG = new Uint8ClampedArray(Ns);
  const seedB = new Uint8ClampedArray(Ns);
  for(let k = 0; k < Ns; k++){
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

  // 5. flat seed position arrays
  const sxs = new Float32Array(Ns);
  const sys = new Float32Array(Ns);
  for(let k = 0; k < Ns; k++){ sxs[k] = seeds[k][0]; sys[k] = seeds[k][1]; }

  // 6. spatial hash
  const hash = buildHash(seeds, W, H);
  const { cell, gw, gh, offsets, bins } = hash;

  const useGradient = (params.colorMode === 'gradient');
  const useAverage  = (params.colorMode === 'average');
  const cellIdx = new Int32Array(W * H);

  // 7. tessellate
  for(let y = 0; y < H; y++){
    const gyP = clamp(y / cell | 0, 0, gh - 1);
    for(let x = 0; x < W; x++){
      const gxP = clamp(x / cell | 0, 0, gw - 1);

      let best = -1, second = -1;
      let bd = Infinity, sd = Infinity;

      // Expanding-ring search. Start at radius 0 (own cell), expand until we
      // have F1 (and one more ring to lock F1/F2 correctness, since a closer
      // seed could live in the next ring).
      let radius = 0;
      const maxR = Math.max(gw, gh);
      let foundRing = -1;
      while(radius <= maxR){
        const x0 = Math.max(0, gxP - radius), x1 = Math.min(gw - 1, gxP + radius);
        const y0 = Math.max(0, gyP - radius), y1 = Math.min(gh - 1, gyP + radius);
        for(let cy = y0; cy <= y1; cy++){
          for(let cxc = x0; cxc <= x1; cxc++){
            // Only scan the ring border (skip interior already scanned).
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
        // After first ring with a hit, do one more expansion to guarantee F1/F2.
        if(foundRing !== -1 && radius >= foundRing + 1) break;
        radius++;
      }
      if(best === -1){ best = 0; bd = 0; }
      if(second === -1) second = best;

      const j = (y * W + x) * 4;
      cellIdx[y * W + x] = best;

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
  const tmp = document.createElement('canvas');
  tmp.width = imgW; tmp.height = imgH;
  tmp.getContext('2d').putImageData(outImg, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, ox, oy, dw, dh);
  ctx.restore();
}

// ─── WAEffect contract (no animation) ─────────────────────────
window.WAEffect = {
  cycleMs: 0,
  renderAt: () => paint(),
  pauseRender: () => {},
  resumeRender: () => paint(),
};

const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['seedCount','seedSource','metric','relax','borderWidth','borderColor','colorMode','paletteShift']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
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
}

document.addEventListener('DOMContentLoaded', init);
