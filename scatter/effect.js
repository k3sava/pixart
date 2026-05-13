// pixart/scatter — Step 2 (2026-05-13).
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
//
// ---------------------------------------------------------------------------
// Step 2: animation + interactive cursor layered on top, matching bevel's
// pattern (applyMode / applyInteractive / renderAt / WAEffect.cycleMs).
//
// Defaults were chosen by sweeping in Playwright against portrait.jpg. Sweet
// spot for "portrait recognisable in Poisson dot field":
//
//   pointDensityFactor = 0.05  — denser collapses face into noise; sparser
//                                drops eye/lip definition.
//   maxPointSize       = 18    — large enough that the darkest dots read as
//                                features, not specks.
//   minPointSize       = 3     — tiny pebbles in the bright skin areas.
//   relaxIterations    = 6     — three is jaggy, ten is over-organised.
//   relaxStrength      = 0.5   — gives a "natural pebble" packing.
//   whitePoint         = 255   — full range; tone mode shifts it.
//
// Animation modes (each = a gentle cosine across cycleMs = 15000):
//
//   breath — maxPointSize cosine-pingpongs (0.55× ↔ 1.35× of the base size).
//            Dots inflate and deflate; the portrait "breathes". Implemented
//            as a paint-time `sizeScale` so we don't rebuild the field every
//            frame (24-frame mean < 30ms).
//   tone   — whitePoint drifts above/below the base (centred at 200, ±55).
//            Implemented as a paint-time `lumCutoff` that hides dots whose
//            sampled luminance exceeds the cutoff — visually the same as
//            sliding whitePoint down, but without rebuilding. The brightest
//            pebbles fade out, then fade back in.
//
// Interactive (cursor IS the field):
//   X → maxPointSize 4..24   (paint-time sizeScale; no rebuild on move)
//   Y → pointDensityFactor 0.01..0.15  (rebuilds on each move; user-paced
//                                       so the per-move ~40ms is fine).
'use strict';

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
  animate:            false,
  mode:               'breath',
  interactive:        false,
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

// Paint-time modulation. Animation modes and the interactive X-axis write
// these so we can re-render without rebuilding the dot field.
const paintOpts = { sizeScale: 1, lumCutoff: 256 };

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
  const sizeScale = paintOpts.sizeScale;
  const lumCutoff = paintOpts.lumCutoff;

  for(let k = 0; k < dotCount; k++){
    const o = order[k] * 6;
    // tone mode: hide brightest dots whose source luminance exceeds the cutoff.
    if(lumCutoff < 256){
      const lum = (dotsBuf[o+3] + dotsBuf[o+4] + dotsBuf[o+5]) / 3;
      if(lum > lumCutoff) continue;
    }
    const sx = offX + dotsBuf[o]   * fitScale;
    const sy = offY + dotsBuf[o+1] * fitScale;
    const ds = Math.max(0.5, dotsBuf[o+2] * fitScale * 0.5 * sizeScale);
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

// ---------- animation ----------
//
// Bevel pattern: pure renderAt(t01) that applies the active mode's envelope,
// renders, and rolls back any param mutation so the GUI display stays stable.
// Scatter modulates paintOpts (paint-time only) so each frame is a paint, not
// a rebuild — keeps the 24-frame mean < 30ms even at full default density.
const CYCLE_MS = 15000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;
// Interactive-Y debounce: avoid rebuilding more than once per rAF tick.
let interactiveRebuildPending = false;
// Track whether interactive most-recently mutated pointDensityFactor so we can
// restore the user's value when interactive turns off / mouse leaves.
let interactiveDensityBase = null;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'breath'){
    // 0.55 ↔ 1.35 of base maxPointSize, gentle pingpong.
    paintOpts.sizeScale = 0.55 + 0.8 * pingPong(t01);
    return () => { paintOpts.sizeScale = 1; };
  }
  if(mode === 'tone'){
    // whitePoint analogue: lumCutoff drifts 100 ↔ 255. At 100 only the dots
    // sampled from the darkest regions survive (the figure recedes to its
    // shadow skeleton); at 255 every dot renders. Centred at 178, amp 78.
    paintOpts.lumCutoff = 178 + 78 * Math.cos(t01 * Math.PI * 2);
    return () => { paintOpts.lumCutoff = 256; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  // X → maxPointSize 4..24, expressed as a paint-time scale relative to base.
  const targetMax = 4 + ax * 20;
  paintOpts.sizeScale = targetMax / Math.max(1, params.maxPointSize);
  // Y → pointDensityFactor 0.01..0.15. This requires a rebuild — only fire
  // one per rAF tick to avoid stacking work behind a fast move.
  const targetDensity = 0.01 + ay * 0.14;
  if(interactiveDensityBase === null) interactiveDensityBase = params.pointDensityFactor;
  if(Math.abs(targetDensity - params.pointDensityFactor) > 0.002){
    params.pointDensityFactor = targetDensity;
    if(!interactiveRebuildPending){
      interactiveRebuildPending = true;
      requestAnimationFrame(() => {
        interactiveRebuildPending = false;
        buildDots();
        // animation loop will paint on its next tick; static interactive paints below.
        if(!params.animate) paint();
      });
    }
  }
  return () => { paintOpts.sizeScale = 1; };
}

function renderAt(t01){
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  paint();
  restoreInt();
  restoreMode();
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

function handleMouseLeave(){
  hasMouse = false;
  // Restore the user's density value (interactive may have stomped it).
  if(interactiveDensityBase !== null){
    params.pointDensityFactor = interactiveDensityBase;
    interactiveDensityBase = null;
    if(!params.animate){
      buildDots();
      paint();
    }
  } else if(!params.animate){
    paint();
  }
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else paint();
    return cv;
  },
};

const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['pointDensityFactor','minPointSize','maxPointSize','relaxIterations','relaxStrength']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); paintOpts.sizeScale = 1; paintOpts.lumCutoff = 256; schedule('paint'); }
      return;
    }
    if(key === 'mode'){
      if(!params.animate) schedule('paint');
      return;
    }
    if(key === 'interactive'){
      if(!params.interactive){
        paintOpts.sizeScale = 1;
        if(interactiveDensityBase !== null){
          params.pointDensityFactor = interactiveDensityBase;
          interactiveDensityBase = null;
          schedule('build');
        } else if(!params.animate){
          schedule('paint');
        }
      } else if(!params.animate){
        schedule('paint');
      }
      return;
    }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(key === 'dotTexture'){
      const row = document.querySelector('.wg-row[data-key="dotTexture"]');
      const input = row?.querySelector('input[type=file]');
      const f = input?.files && input.files[0];
      loadDotTexture(f || null);
      return;
    }
    if(params.animate) return; // animation loop owns the canvas
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', handleMouseLeave);
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
  if(params.animate) startAnimation();
}

document.addEventListener('DOMContentLoaded', init);
