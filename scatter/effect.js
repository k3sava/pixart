// pixart/scatter — Pass 4 (2026-05-13). Static-only.
//
// Poisson-disk-style stippler with Lloyd-style relaxation:
//   1. Preprocessor (Blur → Grain → Gamma → Levels) mutates the source.
//   2. For each pixel, sample probability p = ((255 − lum)/255) * pointDensityFactor.
//      If random() < p, emit a dot with size = map(lum, maxPointSize → minPointSize).
//   3. Spatial-hash + force-model relaxation for `relaxIterations` passes.
//   4. Sort by size DESC. Render each dot as the user-uploaded dot-texture image
//      scaled to the dot's diameter; if no upload, draw a solid black disc.
//
// `showEffect: false` bypasses the cloud and shows the preprocessed image.
'use strict';

const CYCLE_MS = 0;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  canvasSize:         600,
  blurAmount:         0,
  grainAmount:        0,
  gamma:              1,
  blackPoint:         0,
  whitePoint:         255,
  pointDensityFactor: 0.05,
  minPointSize:       3,
  maxPointSize:       18,
  relaxIterations:    6,
  relaxStrength:      0.5,
  showEffect:         true,
  fit:                'cover',
  bg:                 '#0a0a0a',
  dotTexture:         '',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
// Dot pool packed as Float32: [x, y, size, r, g, b] × N
let dotsBuf = null;
let dotCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// User-uploaded dot texture image. Null until a file is picked; fallback is a
// solid black disc rendered at draw time.
let dotImage = null;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function mapRange(v, a, b, c, d){ return c + (d - c) * ((v - a) / (b - a)); }

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
    if(dirty.build) buildDots();
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
}

// ---------- dot field build + Lloyd relaxation ----------
function buildDots(){
  if(!preprocessed){ dotCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const px = preprocessed.data;
  const density = params.pointDensityFactor;
  const mn = params.minPointSize, mx = params.maxPointSize;
  const iters = params.relaxIterations | 0;
  const strength = params.relaxStrength;

  const rnd = mulberry32(123);
  const cap = Math.min(W * H, 200000);
  if(!dotsBuf || dotsBuf.length < cap * 6) dotsBuf = new Float32Array(cap * 6);
  const force = new Float32Array(cap * 2);

  let n = 0;
  for(let y = 0; y < H; y++){
    for(let x = 0; x < W; x++){
      const i = (x + y * W) * 4;
      const r = px[i], g = px[i+1], b = px[i+2];
      const lum = (r + g + b) / 3;
      const p = ((255 - lum) / 255) * density;
      if(rnd() < p && n < cap){
        const o = n * 6;
        dotsBuf[o]   = x;
        dotsBuf[o+1] = y;
        dotsBuf[o+2] = mapRange(lum, 0, 255, mx, mn);
        dotsBuf[o+3] = r;
        dotsBuf[o+4] = g;
        dotsBuf[o+5] = b;
        n++;
      }
    }
  }
  dotCount = n;

  if(n > 0 && iters > 0 && strength > 0){
    const cell = Math.max(mx, 20);
    const bucket = new Map();
    const keyOf = (x, y) => (((x + 1) | 0) * 100000) + (((y + 1) | 0));
    function insert(idx){
      const o = idx * 6;
      const cx = (dotsBuf[o]   / cell) | 0;
      const cy = (dotsBuf[o+1] / cell) | 0;
      const k = keyOf(cx, cy);
      let arr = bucket.get(k);
      if(!arr){ arr = []; bucket.set(k, arr); }
      arr.push(idx);
    }
    for(let i = 0; i < n; i++) insert(i);

    for(let it = 0; it < iters; it++){
      for(let i = 0; i < n; i++){
        const oa = i * 6;
        const ax = dotsBuf[oa], ay = dotsBuf[oa+1], as = dotsBuf[oa+2];
        const cx = (ax / cell) | 0;
        const cy = (ay / cell) | 0;
        for(let dx = -1; dx <= 1; dx++){
          for(let dy = -1; dy <= 1; dy++){
            const arr = bucket.get(keyOf(cx + dx, cy + dy));
            if(!arr) continue;
            for(let m = 0; m < arr.length; m++){
              const j = arr[m];
              if(j === i) continue;
              const ob = j * 6;
              const dxv = dotsBuf[ob]   - ax;
              const dyv = dotsBuf[ob+1] - ay;
              const dist = Math.sqrt(dxv*dxv + dyv*dyv);
              const radius = (as + dotsBuf[ob+2]) / 2;
              if(dist > 0 && dist < radius){
                const push = ((radius - dist) / dist) * strength;
                force[i*2]   -= push * dxv;
                force[i*2+1] -= push * dyv;
                force[j*2]   += push * dxv;
                force[j*2+1] += push * dyv;
              }
            }
          }
        }
      }
      for(let i = 0; i < n; i++){
        const fx = force[i*2], fy = force[i*2+1];
        if(fx === 0 && fy === 0) continue;
        const oa = i * 6;
        const oldCx = (dotsBuf[oa]   / cell) | 0;
        const oldCy = (dotsBuf[oa+1] / cell) | 0;
        dotsBuf[oa]   += fx;
        dotsBuf[oa+1] += fy;
        const newCx = (dotsBuf[oa]   / cell) | 0;
        const newCy = (dotsBuf[oa+1] / cell) | 0;
        if(newCx !== oldCx || newCy !== oldCy){
          const oldArr = bucket.get(keyOf(oldCx, oldCy));
          if(oldArr){
            const idx = oldArr.indexOf(i);
            if(idx >= 0) oldArr.splice(idx, 1);
          }
          insert(i);
        }
        force[i*2] = 0; force[i*2+1] = 0;
      }
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

  if(dotCount === 0){ ctx.restore(); return; }

  const cs = preprocessed.width;
  const ch = preprocessed.height;
  const fitScale = Math.min(W / cs, H / ch);
  const offX = (W - cs * fitScale) / 2;
  const offY = (H - ch * fitScale) / 2;

  // Sort indices by size DESC so smaller dots paint over larger (exposes texture).
  const order = new Array(dotCount);
  for(let i = 0; i < dotCount; i++) order[i] = i;
  order.sort((a, b) => dotsBuf[b*6+2] - dotsBuf[a*6+2]);

  const tex = (dotImage && dotImage.complete && dotImage.naturalWidth > 0) ? dotImage : null;

  for(let k = 0; k < dotCount; k++){
    const o = order[k] * 6;
    const sx = offX + dotsBuf[o]   * fitScale;
    const sy = offY + dotsBuf[o+1] * fitScale;
    const ds = Math.max(0.5, dotsBuf[o+2] * fitScale * 0.5);
    const d2 = ds * 2;
    if(tex){
      // Draw uploaded texture scaled to the dot diameter, centred on the dot.
      ctx.drawImage(tex, sx - ds, sy - ds, d2, d2);
    } else {
      ctx.fillStyle = '#000';
      if(ds < 3){
        ctx.fillRect(sx - ds, sy - ds, d2, d2);
      } else {
        ctx.beginPath();
        ctx.arc(sx, sy, ds, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.restore();
}

// ---------- dot-texture file handler ----------
function loadDotTexture(file){
  if(!file){ dotImage = null; schedule('paint'); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    dotImage = img;
    URL.revokeObjectURL(url);
    schedule('paint');
  };
  img.onerror = () => { URL.revokeObjectURL(url); };
  img.src = url;
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: 0,
  renderAt: () => paint(),
  pauseRender: () => {},
  resumeRender: () => paint(),
};

const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['pointDensityFactor','minPointSize','maxPointSize','relaxIterations','relaxStrength']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(key === 'dotTexture'){
      // GUI emits filename; resolve to the actual File from the row's input.
      const row = document.querySelector('.wg-row[data-key="dotTexture"]');
      const input = row?.querySelector('input[type=file]');
      const f = input?.files && input.files[0];
      loadDotTexture(f || null);
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
      canvas: cv, name: 'pixart-scatter',
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
