// pixart/distort — port of tooooools.app/effects/distort.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/distort/page-bca54f0605d0ed09.js,
//  shared preprocessor in /_next/static/chunks/9357-2a51c42cdfe973de.js).
//
// Distort is NOT a geometric primitive (no twist/pinch/spherize/wave). It is
// an image-driven UV warp: a "distortion map" image whose RED channel is
// sampled per output pixel to push the source sample by (dx, dy):
//
//   s = mapRed[x, y]                         // 0..255
//   if s > threshold:
//     dx = map(s, 0,255, -xStrength, +xStrength)
//     dy = map(s, 0,255, -yStrength, +yStrength)
//     out[x,y] = source[clamp(x+dx,…), clamp(y+dy,…)]
//   else:
//     out[x,y] = source[x,y]
//
// The shared Blur→Grain→Gamma→Levels preprocessor runs on either the source
// or the distortion map (preprocessTarget switch), then the warp draws.
//
// Defaults extracted from the bundle:
//   canvasSize 600 / threshold 0 / xStrength -75 / yStrength 0
//   preprocessTarget "distortion" / blur 0 / grain 0 / gamma 1 / bp 0 / wp 255
//   displacement map = bundled /displacement.png (600×600).
//
// pixart additions (faithful to platform contract):
//   * source supports video via PIXSource (reference is image-only)
//   * 15s seamless loop animates Y strength (sin) + small X wobble (cos)
//     — both close byte-equal at t=0 and t=1, grain RNG seeded by t_loop.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Working buffers, all sized to canvasSize × (canvasSize · sourceAspect).
const baseBuf = document.createElement('canvas');             // source resampled
const bctx    = baseBuf.getContext('2d', { willReadFrequently: true });
const mapBuf  = document.createElement('canvas');             // distortion map cover-cropped
const mctx    = mapBuf.getContext('2d', { willReadFrequently: true });
const outBuf  = document.createElement('canvas');             // warp result
const octx    = outBuf.getContext('2d');

// User-supplied distortion-map image (defaults to assets/displacement.png).
const mapImg = new Image();
mapImg.crossOrigin = 'anonymous';
let mapReady = false;

const params = {
  // Reference parameters (byte-for-byte from bundle defaults).
  canvasSize:              600,
  displacementThreshold:   0,
  xDisplacementStrength:  -75,
  yDisplacementStrength:   0,
  preprocessTarget:       'distortion',
  blurAmount:              0,
  grainAmount:             0,
  gamma:                   1,
  blackPoint:              0,
  whitePoint:              255,
  showEffect:              true,
  // pixart standard rows
  animate:                 false,
  interactive:             false,
  fit:                    'cover',
  bg:                     '#0a0a0a',
};
let xStrengthBase = params.xDisplacementStrength;

if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let baseImageData = null;     // ImageData of baseBuf (post-preprocess if "base")
let mapImageData  = null;     // ImageData of mapBuf  (post-preprocess if "distortion")
let dirty = { resample: true, pre: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

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
  if(level === 'resample') dirty.resample = true;
  if(level === 'resample' || level === 'pre') dirty.pre = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.resample) resample();
    if(dirty.pre)      preprocess();
    paint();
    dirty.resample = dirty.pre = dirty.paint = false;
  });
}

function fitCanvas(){
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ---------- resample ----------
//
// Pull source through PIXSource at canvasSize × (canvasSize · srcAspect).
// Cover-fit + centre-crop the distortion map to match.
function resample(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = params.canvasSize;
  const H = Math.max(1, Math.round(W * aspect));
  if(baseBuf.width !== W || baseBuf.height !== H){
    baseBuf.width = W; baseBuf.height = H;
    outBuf.width  = W; outBuf.height  = H;
    mapBuf.width  = W; mapBuf.height  = H;
  }
  bctx.clearRect(0, 0, W, H);
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(srcCv, 0, 0, W, H);

  // Cover-fit the distortion map and centre-crop. Mirrors the reference's
  // get → resize → get(cx,cy,W,H) sequence.
  mctx.clearRect(0, 0, W, H);
  if(mapReady){
    const mw = mapImg.naturalWidth, mh = mapImg.naturalHeight;
    if(mw && mh){
      const s = Math.max(W / mw, H / mh);
      const dw = mw * s, dh = mh * s;
      const dx = (W - dw) / 2, dy = (H - dh) / 2;
      mctx.imageSmoothingEnabled = true;
      mctx.imageSmoothingQuality = 'high';
      mctx.drawImage(mapImg, dx, dy, dw, dh);
    }
  } else {
    // Fallback: flat grey map (= no warp once threshold>=128).
    mctx.fillStyle = '#808080';
    mctx.fillRect(0, 0, W, H);
  }
}

// ---------- preprocessor (mirrors tooooools' /utils/preprocessor) ----------
//
// Order is load-bearing: Blur → Grain → Gamma → Levels. We run it on a
// COPY of whichever surface is the preprocess target so the un-preprocessed
// half stays raw (the reference keeps the two surfaces in separate slots).
function preprocessSurface(srcCtx, srcCv){
  const W = srcCv.width, H = srcCv.height;
  if(params.blurAmount > 0){
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const t = tmp.getContext('2d');
    t.filter = `blur(${params.blurAmount}px)`;
    t.drawImage(srcCv, 0, 0);
    srcCtx.clearRect(0, 0, W, H);
    srcCtx.drawImage(tmp, 0, 0);
  }
  const id = srcCtx.getImageData(0, 0, W, H);
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
  srcCtx.putImageData(id, 0, 0);
  return id;
}

function preprocess(){
  if(!baseBuf.width) return;
  // Re-rasterise both surfaces so the un-preprocessed half is clean.
  resample();
  if(params.preprocessTarget === 'base'){
    baseImageData = preprocessSurface(bctx, baseBuf);
    mapImageData  = mctx.getImageData(0, 0, mapBuf.width, mapBuf.height);
  } else {
    mapImageData  = preprocessSurface(mctx, mapBuf);
    baseImageData = bctx.getImageData(0, 0, baseBuf.width, baseBuf.height);
  }
}

// ---------- warp ----------
//
// Faithful translation of function `h` in the reference. Red-channel sample
// of the distortion map, signed map to (±xStrength, ±yStrength), nearest-
// neighbour pull from the source. No bilinear — the reference doesn't.
function warp(){
  if(!baseImageData || !mapImageData) return null;
  const W = baseImageData.width, H = baseImageData.height;
  const src = baseImageData.data;
  const m   = mapImageData.data;
  const out = octx.createImageData(W, H);
  const o   = out.data;
  const th  = params.displacementThreshold;
  const xs  = params.xDisplacementStrength;
  const ys  = params.yDisplacementStrength;
  // map(s, 0,255, -strength, +strength) === (s/127.5 - 1) * strength
  const invHalf = 1 / 127.5;
  for(let y = 0; y < H; y++){
    const yOff = y * W;
    for(let x = 0; x < W; x++){
      const i = (x + yOff) * 4;
      const s = m[i]; // RED byte of the map at (x,y)
      let p;
      if(s > th){
        const t = s * invHalf - 1;
        let u = x + t * xs;
        let v = y + t * ys;
        if(u < 0) u = 0; else if(u > W - 1) u = W - 1;
        if(v < 0) v = 0; else if(v > H - 1) v = H - 1;
        p = ((u | 0) + (v | 0) * W) * 4;
      } else {
        p = i;
      }
      o[i]   = src[p];
      o[i+1] = src[p+1];
      o[i+2] = src[p+2];
      o[i+3] = src[p+3];
    }
  }
  octx.putImageData(out, 0, 0);
  return outBuf;
}

// ---------- paint ----------
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);
  if(!baseImageData){ ctx.restore(); return; }

  let surface;
  if(params.showEffect){
    surface = warp() || baseBuf;
  } else {
    // showEffect=false: display whichever side was last preprocessed
    surface = params.preprocessTarget === 'base' ? baseBuf : mapBuf;
  }

  const aspect = surface.width / surface.height;
  let dw, dh;
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(surface, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ---------- animation ----------
//
// 15s seamless loop. The Y strength sin-sweeps 0→+max→0→−max→0; the X
// strength wobbles around the user's baseline with a centred cosine.
// Both are pure functions of t_loop so the loop closes byte-equal.
function applyAnimationT(tLoop){
  const tWrap = ((tLoop % 1) + 1) % 1;
  const yMax  = 80;
  const xWob  = 25;
  params.yDisplacementStrength = Math.round(yMax * Math.sin(tWrap * 2 * Math.PI));
  params.xDisplacementStrength = Math.round(
    xStrengthBase + xWob * (Math.cos(tWrap * 2 * Math.PI) - 1) / 2
  );
  if(gui){
    gui.rows.get('xDisplacementStrength')?._write(params.xDisplacementStrength);
    gui.rows.get('yDisplacementStrength')?._write(params.yDisplacementStrength);
  }
}

function renderAnimationFrame(tLoop){
  applyAnimationT(tLoop);
  const needPre = params.grainAmount > 0;
  if(needPre){
    _rng = mulberry32(seedFromT(tLoop));
  }
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
  }
  preprocess();
  if(needPre) _rng = Math.random;
  paint();
}

function animationLoop(){
  if(!params.animate) return;
  const elapsed = performance.now() - animationStartTime;
  renderAnimationFrame((elapsed % CYCLE_MS) / CYCLE_MS);
  animationId = requestAnimationFrame(animationLoop);
}

function toggleAnimation(){
  if(params.animate){
    xStrengthBase = params.xDisplacementStrength;
    animationStartTime = performance.now();
    animationLoop();
  } else if(animationId){
    cancelAnimationFrame(animationId); animationId = null;
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

const RESAMPLE_KEYS = new Set(['canvasSize','fit']);
const PRE_KEYS      = new Set([
  'blurAmount','grainAmount','gamma','blackPoint','whitePoint','preprocessTarget'
]);
// 'displacementThreshold', 'xDisplacementStrength', 'yDisplacementStrength',
// 'showEffect', 'bg' → paint-only.

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    const nx = Math.round((ax * 2 - 1) * 100);
    const ny = Math.round((ay * 2 - 1) * 100);
    let touched = false;
    if(nx !== params.xDisplacementStrength){
      params.xDisplacementStrength = nx; touched = true;
      gui?.rows.get('xDisplacementStrength')?._write(nx);
    }
    if(ny !== params.yDisplacementStrength){
      params.yDisplacementStrength = ny; touched = true;
      gui?.rows.get('yDisplacementStrength')?._write(ny);
    }
    if(touched) schedule('paint');
  }
}

function wireDistortionMapInput(){
  const row = document.querySelector('.wg-row[data-key="distortionMap"]');
  if(!row) return;
  const input = row.querySelector('input[type=file]');
  const label = row.querySelector('.wg-file-label');
  input?.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if(!f) return;
    const url = URL.createObjectURL(f);
    mapImg.onload = () => { mapReady = true; schedule('resample'); };
    mapImg.src = url;
    if(label) label.textContent = f.name.length > 18 ? f.name.slice(0, 15) + '…' : f.name;
  });
}

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){ toggleAnimation(); return; }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('resample'); else schedule('paint');
      return;
    }
    if(params.animate) return;
    if(RESAMPLE_KEYS.has(key))  schedule('resample');
    else if(PRE_KEYS.has(key))  schedule('pre');
    else                        schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => {
      if(!params.animate) schedule('resample');
    });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-distort',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  cv.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();

  wireDistortionMapInput();

  // Bundled distortion map mirrors the reference's /displacement.png boot.
  mapImg.onload = () => { mapReady = true; schedule('resample'); };
  mapImg.onerror = () => { console.warn('distort: bundled displacement map failed to load'); schedule('resample'); };
  mapImg.src = 'assets/displacement.png';

  schedule('resample');
}

document.addEventListener('DOMContentLoaded', init);
