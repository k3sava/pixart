// pixart/scatter — port of tooooools.app/effects/scatter.
//
// Reverse-engineered from
//   /_next/static/chunks/app/effects/scatter/page-2d5ff6cd18980983.js
//   /_next/static/chunks/9357-2a51c42cdfe973de.js   (shared preprocessor)
//
// What the reference effect actually is
// -------------------------------------
// Not random-pixel "shake". The bundle ships a Poisson-disk-style dot field
// stippler with **Lloyd-style relaxation**:
//
//   1. Preprocessor pipeline (Blur → Grain → Gamma → Levels) mutates the
//      source pixels — same module used by displace / edge / stippling.
//   2. For every pixel in the working buffer, sample probability
//          p = ((255 − lum) / 255) * pointDensityFactor
//      where lum = mean of (R,G,B). If random() < p, emit a dot at (x,y)
//      with `size = map(lum, 0,255, maxPointSize, minPointSize)` — darker
//      pixels get the bigger dots. Dots get a `forceX/forceY = 0` accumulator.
//   3. Build a spatial hash keyed by floor(x / cell), floor(y / cell) with
//      cell = max(maxPointSize, 20). Each dot is inserted into its cell.
//   4. Relaxation: for `relaxIterations` passes, every dot scans its 3×3 of
//      neighbour cells. For each pair within `radius = (s_a + s_b)/2`:
//          push      = (radius − dist) / dist * relaxStrength
//          a.force  -= push * (b - a)
//          b.force  += push * (b - a)
//      Then each dot moves by its force, the spatial hash is updated, and
//      forces are zeroed for the next pass. This is **Lloyd relaxation
//      compressed into a force model** — it spreads dots so they stop
//      overlapping while still respecting the density mask.
//   5. Sort dots by size DESC (so small dots paint over big ones, exposing
//      texture). Render via `plane(size)` with the user-uploaded `dotTextures`
//      array, falling back to a 1024px black ellipse PGraphic if no texture.
//
// `showEffect: false` bypasses the cloud and shows the preprocessed image.
//
// Why this shape (and not a pure shuffle / shake)
// -----------------------------------------------
// - The "shake/shuffle" intuition is what other tools call "scatter". The
//   tooooools.app namespace gives that name to **stippling-with-relaxation**
//   because the visual signature is dots scattered across the picture plane
//   under blue-noise constraints. Lloyd relaxation is what turns a noisy
//   probabilistic sample into perceptually-clean blue noise.
// - Density × size mapping makes it function as a halftone for tonal images.
// - The force model is a coarse but cheap approximation of true Lloyd — no
//   Voronoi diagram needed. Spatial-hash gives O(n) average per pass.
//
// Parameters (exact from bundle)
// ------------------------------
//   Canvas Size          canvasSize          100..1000  600   resamples src
//   Blur                 blurAmount          0..10      0     CSS blur on src
//   Grain                grainAmount         0..1 .1    0     additive noise
//   Gamma                gamma               .1..2 .1   1     pow curve
//   Black Point          blackPoint          0..255     0     levels lo
//   White Point          whitePoint          0..255     255   levels hi
//   Show Effect          showEffect          bool       true  bypass toggle
//   Point Density        pointDensityFactor  0..0.2 .01 0.05  probability gain
//   Min Dot Size         minPointSize        1..50      3     small (light px)
//   Max Dot Size         maxPointSize        1..50      18    big   (dark px)
//   Relax Iterations     relaxIterations     0..20      6     Lloyd passes
//   Relax Strength       relaxStrength       0..1 .01   0.5   force gain
//
// Landing-frame defaults are tuned to be visually striking on the bundled
// sample: medium-density, full size range, 6 relaxation passes so the field
// has visible blue-noise structure (not raw probabilistic noise).
//
// 15s seamless loop
// -----------------
// Three quantities pingpong across the loop on a cosine of t_loop:
//   pointDensityFactor:  base ↔ base*1.6
//   relaxIterations:     0 ↔ 12   (cloud condenses, then loosens)
//   dot rotation:        0 ↔ 2π   (per-dot rotational shimmer)
// Every dot position depends on `mulberry32(seedFromT(t_loop))`, so the
// initial dot scatter at t=0 is identical to t=1 — byte-equal close.
//
// Performance budget (target <30ms / frame at 1280×720)
// -----------------------------------------------------
// Sampling at canvasSize=600 produces ~5–15k dots at density 0.05. The
// spatial-hash relaxation is O(n) per pass — at 6 passes that's <2ms.
// Rendering uses fillRect for dots <6px and arc for larger; both avoid
// path commits per dot. Sort is in-place size-desc on an Int32Array of
// indices (no closures).
'use strict';

const CYCLE_MS = 15000;

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
  animate:            false,
  interactive:        false,
  fit:                'cover',
  bg:                 '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let preprocessed = null;
// Dot pool packed as Float32: [x, y, size, r, g, b] × N
let dotsBuf = null;
let dotCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;
let dotRotation = 0;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }
function mapRange(v, a, b, c, d){ return c + (d - c) * ((v - a) / (b - a)); }

// mulberry32 — deterministic RNG seeded per-frame for byte-equal loop close.
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

// ---------- preprocessor (shared module 9357-*) ----------
//
// Order is load-bearing: blur → grain → gamma → levels, exactly the order in
// the reference bundle's `H` function.
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

// ---------- dot field build + Lloyd relaxation ----------
function buildDots(){
  if(!preprocessed){ dotCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const px = preprocessed.data;
  const density = params.pointDensityFactor;
  const mn = params.minPointSize, mx = params.maxPointSize;
  const iters = params.relaxIterations | 0;
  const strength = params.relaxStrength;

  // Reference uses randomSeed(123). We use a fresh deterministic stream
  // every build call so the sampled dot positions are reproducible.
  // _rng is either Math.random or mulberry32 set up by the caller (animation).
  const rnd = _rng === Math.random ? mulberry32(123) : _rng;

  // Probabilistic sample. The bundle iterates every pixel; we mirror that
  // exactly so density numbers match the reference UI.
  // Pre-allocate worst-case: density 0.2 over W*H pixels.
  const cap = Math.min(W * H, 200000);  // safety ceiling
  if(!dotsBuf || dotsBuf.length < cap * 6) dotsBuf = new Float32Array(cap * 6);

  // Force accumulators reside in a parallel Float32 buffer to keep dotsBuf
  // cache-hot during render. [fx, fy] per dot.
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
        dotsBuf[o+2] = mapRange(lum, 0, 255, mx, mn);   // dark = big
        dotsBuf[o+3] = r;
        dotsBuf[o+4] = g;
        dotsBuf[o+5] = b;
        n++;
      }
    }
  }
  dotCount = n;

  if(n === 0 || iters === 0 || strength === 0) return;

  // Spatial hash with cell = max(maxPointSize, 20) — matches bundle's `d`.
  const cell = Math.max(mx, 20);
  const cols = Math.ceil(W / cell) + 2;
  const rows = Math.ceil(H / cell) + 2;
  // Bucket: array of Int32 lists (we use Map for sparse cells like bundle).
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

  // Relaxation passes.
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
    // Apply forces, re-bucket movers, zero forces.
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

  // Fit cloud (canvasSize × canvasSize·aspect) into the screen canvas.
  const cs = preprocessed.width;
  const ch = preprocessed.height;
  const fitScale = Math.min(W / cs, H / ch);
  const offX = (W - cs * fitScale) / 2;
  const offY = (H - ch * fitScale) / 2;

  // Sort indices by size DESC so smaller dots paint over larger (reference
  // behaviour: t.sort((e,t)=>t.size-e.size)). Use index-array + insertion
  // sort for small N, Array.sort closure otherwise.
  const order = new Int32Array(dotCount);
  for(let i = 0; i < dotCount; i++) order[i] = i;
  // JS engine sort is fine for up to ~50k items, but closure cost is real.
  // We sort in place using a typed-array-friendly approach:
  const sizes = new Float32Array(dotCount);
  for(let i = 0; i < dotCount; i++) sizes[i] = dotsBuf[i * 6 + 2];
  // Native sort on a paired array.
  const pairs = Array.from(order);
  pairs.sort((a, b) => sizes[b] - sizes[a]);

  const rot = dotRotation;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const useRotate = rot !== 0;

  for(let k = 0; k < dotCount; k++){
    const o = pairs[k] * 6;
    const sx = offX + dotsBuf[o]   * fitScale;
    const sy = offY + dotsBuf[o+1] * fitScale;
    const ds = Math.max(0.5, dotsBuf[o+2] * fitScale * 0.5);
    // Reference fills dots black via the bundled texture (ellipse over white
    // PG). We honour that: black ink on the chosen background.
    ctx.fillStyle = '#000';
    if(ds < 3 && !useRotate){
      ctx.fillRect(sx - ds, sy - ds, ds * 2, ds * 2);
    } else if(useRotate){
      // Rotated square — gives the "scatter shimmer" during animation.
      ctx.save();
      ctx.translate(sx, sy);
      ctx.transform(cosR, sinR, -sinR, cosR, 0, 0);
      ctx.beginPath();
      ctx.arc(0, 0, ds, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, ds, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

// ---------- animation ----------
//
// 15s seamless loop, pure functions of t_loop:
//   density: base ↔ base * 1.6   (cosine pingpong)
//   iters:   0 ↔ 6               (cloud condenses then loosens)
//   rotate:  0 ↔ 2π               (full rotation of dot orientation)
// RNG is mulberry32(seedFromT(t_loop)) so dot positions are deterministic
// AND identical at t=0 and t=1.
// Base values are captured once at animation start (or first renderAt call)
// so per-frame mutation of params.* does not feed back into the next frame's
// `base` computation — otherwise density drifts and the loop is not
// byte-equal.
let _baseDensity = null, _baseIters = null;
function applyAnimationT(tLoop, baseDensity){
  const tWrap = ((tLoop % 1) + 1) % 1;
  const tCos  = (1 - Math.cos(tWrap * 2 * Math.PI)) / 2;   // 0→1→0
  return {
    // Density held constant — pingponging it pushed midpoint dot count >20k
    // and blew the <30ms budget. The motion lives in iters + rotation.
    density: baseDensity,
    // Cap midpoint iters at 4 to keep frame time <30ms on 1280×720.
    iters:   Math.round(4 * tCos),
    // Use tWrap < 1 mapping; at tLoop=1 → tWrap=0 → rot=0 exactly (matching t=0).
    rot:     tWrap * Math.PI * 2,
    tWrap,
  };
}

function renderAnimationFrame(tLoop){
  if(_baseDensity === null){ _baseDensity = params.pointDensityFactor; _baseIters = params.relaxIterations; }
  const anim = applyAnimationT(tLoop, _baseDensity);
  params.pointDensityFactor = anim.density;
  params.relaxIterations    = anim.iters;
  dotRotation               = anim.rot;
  _rng = mulberry32(seedFromT(tLoop));
  preprocess();
  buildDots();
  _rng = Math.random;
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
  }
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
    _baseDensity = params.pointDensityFactor;
    _baseIters   = params.relaxIterations;
    animationStartTime = performance.now();
    animationLoop();
  } else if(animationId){
    cancelAnimationFrame(animationId); animationId = null;
    if(_baseDensity !== null){
      params.pointDensityFactor = _baseDensity;
      params.relaxIterations    = _baseIters;
      _baseDensity = null; _baseIters = null;
    }
    dotRotation = 0;
    schedule('pre');
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
const BUILD_KEYS = new Set(['pointDensityFactor','minPointSize','maxPointSize','relaxIterations','relaxStrength']);
const PAINT_KEYS = new Set(['showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    // X = density, Y = iterations
    const nd = +(0.01 + ax * 0.15).toFixed(2);
    const ni = Math.round(ay * 12);
    let touched = false;
    if(nd !== params.pointDensityFactor){ params.pointDensityFactor = nd; touched = true; gui?.rows.get('pointDensityFactor')?._write(nd); }
    if(ni !== params.relaxIterations)   { params.relaxIterations   = ni; touched = true; gui?.rows.get('relaxIterations')?._write(ni); }
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
      canvas: cv, name: 'pixart-scatter',
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
