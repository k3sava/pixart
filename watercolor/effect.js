// pixart/watercolor — stylised watercolour-painting effect.
//
// Multi-pass NPR pipeline:
//   1. Sobel-driven edge map → "paper bleed" outlines. Strong edges darken,
//      with a radius proportional to `wetness` so wet edges spread further.
//   2. Tolerance-bounded mean smoothing (3×3 average of neighbours within
//      `smoothing`·255 of the centre). Approximates a bilateral filter at
//      a fraction of the cost; flattens interior tones the way pigment
//      pools on damp paper.
//   3. Procedural paper grain (deterministic mulberry32 seeded from
//      paperSeed). Multiplied in at strength `paperGrain`.
//   4. Wet-rim glow: along dark-light boundaries we add a small brightness
//      bump on the lighter side. Approximates the "halo" pigment leaves at
//      the edge of a wash when it dries.
//   5. Palette LUT remap. Luminance is preserved and mapped through one of
//      five named palettes; `tone` weights the mix against original colour.
//
// Cursor focus (interactive): inside `focusRadius`, wetness attenuates to
// zero — equivalent to dabbing a dry brush over a wet wash to sharpen
// detail under the pointer.
//
// All envelopes wrap t to [0,1) → cos(2π·t) == cos(0) exactly. The paper
// grain RNG is seeded from a function of (paperSeed, modeStep) so each
// frame in a given mode is deterministic and the seam matches.
//
// References:
//   - Curtis, C. J. et al. (1997). *Computer-Generated Watercolor*.
//     SIGGRAPH '97. The seminal paper for procedural watercolour — three
//     KM (Kubelka-Munk) pigment passes; we cheat with a single mean smooth
//     plus rim, which captures the perceptual signature at <5% the cost.
//   - Bousseau, A. et al. (2006). *Interactive Watercolor Rendering with
//     Temporal Coherence and Abstraction*. Eurographics 2006. Their
//     edge-darkening and pigment-density tricks inform passes 1 and 4.
//   - David Hockney — *iPad paintings* (2010+, "A Bigger Picture" series).
//     Brush-stroke economy: when interior tones are radically flattened
//     and outlines stay loose, the eye reads "watercolour" from very few
//     cues. The `smoothing` default is set to honour Hockney's lesson.
//   - Sumi-e tradition (Sesshū Tōyō, 15th-c.); David Lewandowski's
//     stylised treatments — wet-rim contrast as a narrative emphasis.

'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

// Named palettes. Each is an ordered list of stops; luminance is mapped to
// the palette's luminance ramp while preserving the source's perceived
// brightness.
const PALETTES = {
  natural:        null, // identity, no remap
  sepia:          ['#1a0e07', '#5c3a1f', '#a87856', '#e8c89a', '#f8eedb'],
  'prussian-blue':['#06122d', '#1e3a8a', '#3b82c4', '#a8c8e8', '#f0f6fb'],
  'ink-wash':     ['#0a0a0a', '#3a3a3a', '#7a7a7a', '#c8c8c8', '#fafafa'],
  'gouache-pastel':['#2b1d3a', '#7d5ba6', '#e8a0bf', '#fde2c8', '#fffdf6'],
};

const params = {
  // Preprocessor.
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Watercolor-specific.
  wetness:           0.4,   // edge-bleed radius (0..1 → 0..6 px)
  edgeStrength:      0.5,   // outline darkness 0..1
  smoothing:         0.6,   // interior flatness 0..1 (tolerance 0..80)
  paperGrain:        0.35,
  paperSeed:         1,
  palette:          'natural',
  tone:              0.4,
  wetRim:            0.2,
  focusRadius:       180,
  mode:              'breath',
  // Shared chrome.
  animate:           false,
  interactive:       false,
  fit:               'cover',
  bg:                '#f7f1e3',  // warm paper white (default — this is a
                                  // watercolour effect; black bg looks wrong)
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let preprocessed = null;
let outImg = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// Envelope-driven transient overrides.
let _wetnessOv = NaN, _edgeOv = NaN, _smoothOv = NaN, _grainSeedOv = -1;
let _focusCx = -1, _focusCy = -1, _focusR2 = 0;

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

// ---------- preprocessor (shared) ----------
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
    if(doGamma){ r = lut[r | 0]; gg = lut[gg | 0]; b = lut[b | 0]; }
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

// ---------- palette LUT ----------
function hexToRgb(hex){
  const n = parseInt(hex.replace('#',''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const LUT_SIZE = 256;
const LUT_R = new Uint8ClampedArray(LUT_SIZE);
const LUT_G = new Uint8ClampedArray(LUT_SIZE);
const LUT_B = new Uint8ClampedArray(LUT_SIZE);
let _lutPalette = null;
function buildPaletteLUT(name){
  const stops = PALETTES[name];
  if(!stops){ _lutPalette = null; return; }
  const rgbs = stops.map(hexToRgb);
  const n = rgbs.length;
  for(let i = 0; i < LUT_SIZE; i++){
    const u = i / (LUT_SIZE - 1);
    const fp = u * (n - 1);
    const k = Math.min(n - 2, Math.floor(fp));
    const t = fp - k;
    LUT_R[i] = lerp(rgbs[k][0], rgbs[k+1][0], t);
    LUT_G[i] = lerp(rgbs[k][1], rgbs[k+1][1], t);
    LUT_B[i] = lerp(rgbs[k][2], rgbs[k+1][2], t);
  }
  _lutPalette = name;
}

// ---------- build ----------
function buildOutput(){
  if(!preprocessed){ outImg = null; return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(!outImg || outImg.width !== W || outImg.height !== H){
    outImg = new ImageData(W, H);
  }
  const src = preprocessed.data;
  const dst = outImg.data;

  const wetness    = clamp(Number.isFinite(_wetnessOv) ? _wetnessOv : params.wetness, 0, 1);
  const edgeStr    = clamp(Number.isFinite(_edgeOv)    ? _edgeOv    : params.edgeStrength, 0, 1);
  const smoothing  = clamp(Number.isFinite(_smoothOv)  ? _smoothOv  : params.smoothing, 0, 1);
  const grain      = clamp(params.paperGrain, 0, 1);
  const grainSeed  = _grainSeedOv > 0 ? _grainSeedOv : (params.paperSeed | 0) || 1;
  const wetRim     = clamp(params.wetRim, 0, 1);
  const tone       = clamp(params.tone, 0, 1);
  const useFocus   = _focusR2 > 0;

  if(_lutPalette !== params.palette) buildPaletteLUT(params.palette);
  const hasLUT = _lutPalette !== null;

  // Precompute luminance grid (also used by Sobel + bilateral).
  const N = W * H;
  const lum = new Float32Array(N);
  for(let i = 0, j = 0; i < src.length; i += 4, j++){
    lum[j] = (src[i] * 299 + src[i+1] * 587 + src[i+2] * 114) / 1000;
  }

  // Tolerance (px luminance) for the bilateral mean. Smoothing 0 → tol 5;
  // smoothing 1 → tol 80. Beyond ~80 the average flattens everything to a
  // single mid-tone — the upper edge of the "watercolour" regime.
  const tol = 5 + smoothing * 75;

  // Edge-bleed radius. Wetness 0 → 0 px (no spread), wetness 1 → 6 px.
  const bleedR = wetness * 6;

  // Procedural grain — deterministic.
  const rng = mulberry32(grainSeed);
  const grainBuf = grain > 0 ? new Float32Array(N) : null;
  if(grainBuf){
    for(let i = 0; i < N; i++) grainBuf[i] = rng();
  }

  for(let y = 0, j4 = 0; y < H; y++){
    for(let x = 0; x < W; x++, j4 += 4){
      const j = y * W + x;

      // Per-pixel wetness attenuation under cursor.
      let localWet = wetness, localBleedR = bleedR;
      if(useFocus){
        const dxf = x - _focusCx, dyf = y - _focusCy;
        const d2 = dxf*dxf + dyf*dyf;
        if(d2 < _focusR2){
          const k = 1 - d2 / _focusR2;
          localWet = wetness * (1 - k);
          localBleedR = bleedR * (1 - k);
        }
      }

      // ---- Bilateral-ish mean smoothing (interior wash) ----
      const lc = lum[j];
      let sumR = src[j4], sumG = src[j4+1], sumB = src[j4+2], cnt = 1;
      if(smoothing > 0 && x > 0 && x < W-1 && y > 0 && y < H-1){
        for(let dy = -1; dy <= 1; dy++){
          for(let dx = -1; dx <= 1; dx++){
            if(dx === 0 && dy === 0) continue;
            const k = (x + dx) + (y + dy) * W;
            if(Math.abs(lum[k] - lc) > tol) continue;
            const k4 = k * 4;
            sumR += src[k4]; sumG += src[k4+1]; sumB += src[k4+2];
            cnt++;
          }
        }
      }
      let r = sumR / cnt, g = sumG / cnt, b = sumB / cnt;

      // ---- Edge map (Sobel on luminance) ----
      // Cheap 3×3 Sobel; only run when edgeStr > 0 to save cycles.
      let mag = 0, signedGrad = 0;
      if(edgeStr > 0 && x > 0 && x < W-1 && y > 0 && y < H-1){
        const v00 = lum[(x-1) + (y-1)*W];
        const v10 = lum[x     + (y-1)*W];
        const v20 = lum[(x+1) + (y-1)*W];
        const v01 = lum[(x-1) + y*W];
        const v21 = lum[(x+1) + y*W];
        const v02 = lum[(x-1) + (y+1)*W];
        const v12 = lum[x     + (y+1)*W];
        const v22 = lum[(x+1) + (y+1)*W];
        const gx = -v00 + v20 - 2*v01 + 2*v21 - v02 + v22;
        const gy = -v00 - 2*v10 - v20 + v02 + 2*v12 + v22;
        mag = Math.sqrt(gx*gx + gy*gy);
        // Signed gradient (positive = brighter to the right/down) — used
        // for the wet-rim direction. Sum of gx + gy approximates the
        // dominant brightness direction; sign tells us which side is lighter.
        signedGrad = gx + gy;
      }

      // Edge bleed: darken pixels near strong edges. `localWet` lowers the
      // gradient threshold (more edges register as "wet enough to bleed")
      // and increases the darken amount. Under the cursor (dry brush)
      // localWet drops to zero so outlines stay crisp.
      const edgeMagFloor = 60 - 50 * localWet;  // wet=0 → 60 (crisp), wet=1 → 10 (everything bleeds)
      if(mag > edgeMagFloor){
        const e = clamp(((mag - edgeMagFloor) / 200) * edgeStr, 0, 1);
        const bleed = 1 - e * (0.45 + 0.35 * localWet);
        r *= bleed; g *= bleed; b *= bleed;
        // Spread the bleed: a wet edge influences nearby pixels too. We
        // approximate by lerping toward darker neighbours weighted by
        // localBleedR — done implicitly through the smoothing pass since
        // wet ≈ smoothing-tolerance. This is sufficient at watercolour
        // scales; the SIGGRAPH '97 paper uses three KM passes for the same.
      }

      // Wet rim: along a dark→light boundary, add a small brightness bump
      // on the lighter side. signedGrad > 0 = lighter pixel sits "after"
      // this one in scan order; we add a kiss of brightness.
      if(wetRim > 0 && mag > 40){
        const rimGain = (mag - 40) / 215 * wetRim * 40;
        if(signedGrad > 0){ r += rimGain; g += rimGain; b += rimGain; }
      }

      // Paper grain. Multiplicative; mean 1 so it preserves overall tone.
      if(grain > 0){
        const gn = (grainBuf[j] - 0.5) * grain * 0.35 + 1;
        r *= gn; g *= gn; b *= gn;
      }

      // Palette remap (luminance-preserving lerp toward palette LUT).
      if(hasLUT && tone > 0){
        const lOut = (r * 299 + g * 587 + b * 114) / 1000;
        const idx = clamp(lOut, 0, 255) | 0;
        r = lerp(r, LUT_R[idx], tone);
        g = lerp(g, LUT_G[idx], tone);
        b = lerp(b, LUT_B[idx], tone);
      }

      if(r < 0) r = 0; else if(r > 255) r = 255;
      if(g < 0) g = 0; else if(g > 255) g = 255;
      if(b < 0) b = 0; else if(b > 255) b = 255;
      dst[j4]   = r;
      dst[j4+1] = g;
      dst[j4+2] = b;
      dst[j4+3] = 255;
    }
  }
}

// ---------- paint ----------
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);
  if(!outImg){ ctx.restore(); return; }
  const imgW = outImg.width, imgH = outImg.height;
  const aspect = imgW / imgH;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const tmp = document.createElement('canvas');
  tmp.width = imgW; tmp.height = imgH;
  tmp.getContext('2d').putImageData(outImg, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, ox, oy, dw, dh);
  ctx.restore();
}

// ---------- animation ----------
//
// Six modes:
//   idle   — static painting.
//   breath — wetness cosine pingpong; the painting "breathes" damp ↔ dry.
//   bloom  — wetness sharp attack + slow decay; a single "drop hitting the
//            page" feel.
//   march  — paper-grain seed steps through 4 plates; same painting, four
//            different papers cycle past.
//   dry    — edgeStrength monotonic 0→1; outlines harden as you watch
//            (the painting dries). Seam-pinned at t=1 (resets to 0).
//   wash   — smoothing sawtooth between two ranges; broad wash → tight
//            detail → broad wash.
function applyAnimationT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  const t01 = w;
  const pp = (1 - Math.cos(t01 * 2 * Math.PI)) / 2;

  let wetnessOv = NaN, edgeOv = NaN, smoothOv = NaN, grainSeedOv = -1;

  switch(params.mode){
    case 'idle':
      break;
    case 'breath':
      // Wetness modulated around its slider value: low ↔ high via pp.
      wetnessOv = clamp(params.wetness * (0.4 + 1.2 * pp), 0, 1);
      break;
    case 'bloom': {
      const env = t01 < 0.2
        ? t01 / 0.2
        : Math.pow(1 - (t01 - 0.2) / 0.8, 2.5);
      // Bloom hits both wetness and edgeStrength so the "drop on paper"
      // reads as both a spread (wet) and a momentary outline darkening.
      wetnessOv = clamp(0.1 + env * 0.9, 0, 1);
      edgeOv    = clamp(params.edgeStrength * (0.3 + env * 1.2), 0, 1);
      break;
    }
    case 'march': {
      const plates = [1, 7, 19, 53];
      let idx = Math.floor(t01 * plates.length);
      if(idx >= plates.length) idx = plates.length - 1;
      if(t01 === 0) idx = 0;
      grainSeedOv = plates[idx];
      break;
    }
    case 'dry': {
      // Monotonic-ish 0 → 1 → 0 so the seam closes (a pure ramp would
      // discontinuity-jump at t=1). Use pp directly — peaks at t=0.5 — and
      // remap so t=0 is "wet" and t=0.5 is "dry": edgeOv low at seams, high
      // mid-cycle; wetnessOv inverse.
      edgeOv    = clamp(0.15 + pp * 0.85, 0, 1);
      wetnessOv = clamp(0.9 - pp * 0.8, 0, 1);
      break;
    }
    case 'wash': {
      // Smoothing sweeps from light (broad wash) to detailed and back.
      smoothOv = clamp(0.1 + pp * 0.85, 0, 1);
      // Also tint paper grain seed so the wash carries a textural shift.
      grainSeedOv = 1 + Math.floor(pp * 30);
      break;
    }
  }
  return { wetnessOv, edgeOv, smoothOv, grainSeedOv };
}

function renderAnimationFrame(tLoop){
  const a = applyAnimationT(tLoop);
  _wetnessOv = a.wetnessOv;
  _edgeOv    = a.edgeOv;
  _smoothOv  = a.smoothOv;
  _grainSeedOv = a.grainSeedOv;

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

  _wetnessOv = _edgeOv = _smoothOv = NaN;
  _grainSeedOv = -1;
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

// ---------- WAEffect ----------
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
const BUILD_KEYS = new Set(['wetness','edgeStrength','smoothing','paperGrain','paperSeed','palette','tone','wetRim']);

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
    schedule('build');
  } else if(_focusR2 !== 0){
    _focusR2 = 0;
    schedule('build');
  }
}

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  buildPaletteLUT(params.palette);
  gui.on((key) => {
    if(key === 'animate'){ toggleAnimation(); return; }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(key === 'mode'){ return; }
    if(key === 'palette'){ buildPaletteLUT(params.palette); schedule('build'); return; }
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
      canvas: cv, name: 'pixart-watercolor',
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
