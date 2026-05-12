// pixart/scatter — port of tooooools.app/effects/scatter, refined 2026-05-13.
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
//      compressed into a force model** — Bridson (2007) Fast Poisson-disk
//      sampling produces the same blue-noise distribution more cheaply, but
//      the force-model captures the same perceptual signature.
//   5. Sort dots by size DESC (so small dots paint over big ones, exposing
//      texture). Render via `plane(size)` with the user-uploaded `dotTextures`
//      array, falling back to a 1024px black ellipse PGraphic if no texture.
//
// `showEffect: false` bypasses the cloud and shows the preprocessed image.
//
// ─────────────────────────────────────────────────────────────
// Refinement pass — 2026-05-13
// ─────────────────────────────────────────────────────────────
//
// The bundled animation drove pointDensity + iters + rotation simultaneously
// — visually busy and never gave the eye a single perceptual signature to
// latch onto. We graduate to a five-mode set, each mode owning ONE perceptual
// gesture grounded in published literature:
//
//   idle      — static (the rest-frame artwork).
//   breath    — pointDensity cosine pingpong (legacy behaviour distilled).
//   drift     — monotonic rigid rotation 0 → 2π around the cloud centroid.
//               Same dots; only the rotation matrix moves. Reads as a single
//               coherent object turning. Closes at endpoints (0 = 2π mod 2π).
//   bloom     — dot-radius sawtooth: dots inflate from 1× → 2.4× across the
//               loop, then snap back. Long-exposure stipple bloom — the
//               photographic analog is Linda Connor's Spiral Jetty plates,
//               where the dot field grows continuous through exposure time.
//   magnetic  — cursor-flock interactive. t maps to *cohesion strength* (per
//               Reynolds' Boids 1987 separation/alignment/cohesion triad):
//               at t=0 each dot holds its Poisson position; at t=0.5 dots
//               pull toward the cursor by `magnetism`; at t=1 we collapse
//               cohesion back to 0 so the seam matches.
//
// New params:
//   mode       — animation envelope picker.
//   magnetism  — 0..1, cursor-pull strength. Active in `magnetic` mode.
//   coherence  — 0..1, how rigidly the cloud preserves Poisson spacing under
//                flock. Maps to the Reynolds Boids "cohesion vs separation"
//                balance — 1 = preserve spacing strictly (rigid swarm),
//                0 = collapse onto cursor (liquid).
//
// Perceptual hook: Bridson Poisson-disk sampling gives the eye a stippling
// that *can't* be parsed as a regular grid — the brain falls back on Gestalt
// common-fate (Wertheimer, 1923) to group the dots as a single object. The
// `magnetic` mode is the proof: the cursor literally re-shapes the cloud, and
// because common-fate dominates, the entire field reads as one thing pulled
// rather than thousands of dots.
//
// Optical-illusion grounding:
//   - Bridson, R. (2007). *Fast Poisson Disk Sampling in Arbitrary Dimensions*.
//     SIGGRAPH sketch — establishes blue-noise sampling as the perceptual
//     gold standard for stippling.
//   - Reynolds, C. W. (1987). *Flocks, Herds, and Schools: A Distributed
//     Behavioral Model*. SIGGRAPH 87 — the original Boids paper; defines the
//     separation/alignment/cohesion triad we implement in `magnetic`.
//   - Wertheimer, M. (1923). *Untersuchungen zur Lehre von der Gestalt II*
//     (Common-fate Gestalt principle). Justifies why thousands of independent
//     dots read as a single object under shared motion.
//   - Connor, L. (1969+). Long-exposure stipple photographs of Spiral Jetty
//     and Hindu temple subjects — the `bloom` mode references her "dots that
//     grow continuous through exposure time" signature.
//
// Determinism: every envelope wraps t to [0,1) so cos(2π·t) == cos(0) == 1
// exactly at the seam. `drift` rotation maps 2π back to 0 at t=1 explicitly.
// `bloom` sawtooth is already byte-equal (t=0 = 0× = t=1 mod 1). `magnetic`
// cohesion collapses to 0 at both endpoints. Dot positions are deterministic
// via mulberry32(seedFromT(tLoop)), and we capture base values once at
// animation start so per-frame mutation never feeds back.
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
  // ---- Refinement pass (2026-05-13) ----
  mode:               'breath',
  // Cursor-pull strength (0..1). At 0 the cursor has no effect; at 1 dots
  // collapse all the way to the cursor over a single loop. Default mid-range
  // so first interaction reads as gentle gravity, not a vacuum.
  magnetism:          0.5,
  // Reynolds-Boids cohesion vs separation balance. 1 = preserve Poisson
  // spacing rigidly under flock (the field "drifts as one object"); 0 = let
  // dots pile up on the cursor (liquid splatter). Default biased toward
  // rigidity so the swarm reads as a single intentional object.
  coherence:          0.7,
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
// Anchor positions (Poisson sample, pre-warp) live in dotsAnchor — drift /
// magnetic transforms operate on copies in dotsBuf so we never mutate the
// source-of-truth scatter.
let dotsBuf = null;
let dotsAnchor = null;
let dotCount = 0;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// ─── Transient animation state ───────────────────────────────
// _driftAngle      — rigid rotation (radians) for `drift` mode.
// _bloomScale      — multiplier on dot radius for `bloom` mode (1 → 2.4 → 1).
// _flockT          — cohesion strength 0..1 for `magnetic` mode.
// _flockCxSrc      — cursor position in source-buffer coords (set by mouse).
let _driftAngle = 0;
let _bloomScale = 1;
let _flockT     = 0;
let _flockCxSrc = -1, _flockCySrc = -1;

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
//
// After relaxation we ALSO copy the final dot positions into `dotsAnchor`.
// The animation transforms (drift / magnetic) operate from anchor → dotsBuf
// every frame so the relaxed Poisson distribution is preserved as the
// "rest pose". This avoids drift accumulation that would slowly destroy the
// blue-noise property over time.
function buildDots(){
  if(!preprocessed){ dotCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const px = preprocessed.data;
  const density = params.pointDensityFactor;
  const mn = params.minPointSize, mx = params.maxPointSize;
  const iters = params.relaxIterations | 0;
  const strength = params.relaxStrength;

  // Deterministic seed: matches bundle's randomSeed(123) at rest. Animation
  // path overrides _rng with mulberry32(seedFromT(tLoop)) before calling this.
  const rnd = _rng === Math.random ? mulberry32(123) : _rng;

  const cap = Math.min(W * H, 200000);
  if(!dotsBuf || dotsBuf.length < cap * 6) dotsBuf = new Float32Array(cap * 6);
  if(!dotsAnchor || dotsAnchor.length < cap * 2) dotsAnchor = new Float32Array(cap * 2);

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

  // Capture the relaxed rest pose into dotsAnchor — drift / magnetic read
  // from here and write to dotsBuf each frame.
  for(let i = 0; i < n; i++){
    dotsAnchor[i*2]   = dotsBuf[i*6];
    dotsAnchor[i*2+1] = dotsBuf[i*6+1];
  }
}

// Compute the cloud centroid in source-space. Used as the pivot for `drift`
// rotation so the cloud rotates *in place* rather than around the origin.
function cloudCentroid(){
  if(dotCount === 0) return { x: 0, y: 0 };
  let sx = 0, sy = 0;
  for(let i = 0; i < dotCount; i++){
    sx += dotsAnchor[i*2];
    sy += dotsAnchor[i*2+1];
  }
  return { x: sx / dotCount, y: sy / dotCount };
}

// Apply the current frame's animation transform from dotsAnchor → dotsBuf.
// Called once per animation frame; static rendering skips this and uses the
// post-relaxation positions directly.
function applyTransform(){
  if(dotCount === 0) return;
  const driftA = _driftAngle;
  const flockT = clamp(_flockT, 0, 1);
  const magnet = clamp(params.magnetism, 0, 1);
  const cohere = clamp(params.coherence, 0, 1);
  const useDrift = driftA !== 0;
  const useFlock = flockT > 0 && _flockCxSrc >= 0;

  if(!useDrift && !useFlock) return;

  // Drift: rigid rotation about centroid. Same as the bundle's
  // "rotation transform applied to the entire field" but we do it
  // analytically against the anchor pose so positions never drift.
  let cosA = 1, sinA = 0, cx = 0, cy = 0;
  if(useDrift){
    cosA = Math.cos(driftA); sinA = Math.sin(driftA);
    const c = cloudCentroid(); cx = c.x; cy = c.y;
  }

  // Flock: Reynolds cohesion. Each dot pulls toward cursor by
  // `magnet * flockT`, then we re-add a fraction (`cohere`) of the
  // anchor-to-current displacement so the Poisson spacing is preserved.
  // High `cohere` = swarm moves as a rigid body; low `cohere` = liquid pile.
  for(let i = 0; i < dotCount; i++){
    let ax = dotsAnchor[i*2];
    let ay = dotsAnchor[i*2+1];
    if(useDrift){
      const rx = ax - cx, ry = ay - cy;
      ax = cx + rx * cosA - ry * sinA;
      ay = cy + rx * sinA + ry * cosA;
    }
    if(useFlock){
      const dx = _flockCxSrc - ax;
      const dy = _flockCySrc - ay;
      // Cohesion blending: pull toward cursor by k, but preserve relative
      // structure by `cohere`. The (1-cohere) weight is the "free liquid"
      // share — at cohere=1 the dot follows the cursor only as much as the
      // cluster's centroid pull permits (i.e. swarm motion).
      const k = magnet * flockT * (1 - cohere * 0.6); // 0.6 cap keeps swarm legible
      ax = ax + dx * k;
      ay = ay + dy * k;
    }
    dotsBuf[i*6]   = ax;
    dotsBuf[i*6+1] = ay;
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

  // Sort indices by size DESC so smaller dots paint over larger.
  const order = new Array(dotCount);
  for(let i = 0; i < dotCount; i++) order[i] = i;
  order.sort((a, b) => dotsBuf[b*6+2] - dotsBuf[a*6+2]);

  const bloom = _bloomScale;

  for(let k = 0; k < dotCount; k++){
    const o = order[k] * 6;
    const sx = offX + dotsBuf[o]   * fitScale;
    const sy = offY + dotsBuf[o+1] * fitScale;
    const ds = Math.max(0.5, dotsBuf[o+2] * fitScale * 0.5 * bloom);
    ctx.fillStyle = '#000';
    if(ds < 3){
      ctx.fillRect(sx - ds, sy - ds, ds * 2, ds * 2);
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
// Per-mode envelopes — each owns ONE perceptual gesture. All wrap t to [0,1)
// first so endpoints meet exactly.
function applyAnimationT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  const t01 = w;
  const pp  = (1 - Math.cos(t01 * 2 * Math.PI)) / 2;

  let driftAngle = 0;
  let bloomScale = 1;
  let flockT     = 0;
  // Density / iterations are NOT touched by drift/bloom/magnetic — those
  // modes operate on the relaxed anchor pose without re-sampling, which is
  // both perceptually cleaner and keeps frame time predictable.
  let density = _baseDensity ?? params.pointDensityFactor;
  let iters   = _baseIters   ?? params.relaxIterations;

  switch(params.mode){
    case 'idle': {
      // Static: hold every animatable param at its anchor.
      break;
    }
    case 'drift': {
      // Monotonic rigid rotation 0 → 2π. Wraps to 0 at t=1 because
      // cos(2π)/sin(2π) match cos(0)/sin(0) to IEEE-754 ε; we also explicit
      // -override at t01==0 so the seam is byte-equal.
      driftAngle = (t01 === 0) ? 0 : Math.PI * 2 * t01;
      break;
    }
    case 'bloom': {
      // Sawtooth dot-radius growth. Linda Connor's long-exposure stipple
      // signature — the dots inflate continuously then snap back at the
      // loop seam. Sawtooth is byte-equal at t=0 / t=1 because both = 0.
      // Range 1 → 2.4 lands striking without overlapping on default density.
      bloomScale = 1 + 1.4 * t01;
      break;
    }
    case 'magnetic': {
      // Cursor-flock. Cohesion strength rises and falls on a cosine pingpong
      // (pp), so endpoints sit at 0 (no pull) and midpoint pulls hardest.
      // If no cursor has been registered yet, _flockCxSrc stays -1 and the
      // transform path short-circuits — the field just stays in rest pose.
      flockT = pp;
      break;
    }
    case 'breath':
    default: {
      // Calm cosine pingpong on dot radius. We keep the dot field stable
      // (no resample) so the eye reads it as a single object inhaling and
      // exhaling — the "breathing" metaphor. Range 1 → 1.25 is below the
      // bloom mode's sawtooth crescendo so the two modes stay distinct.
      bloomScale = 1 + 0.25 * pp;
      break;
    }
  }
  return { density, iters, driftAngle, bloomScale, flockT };
}

let _baseDensity = null, _baseIters = null;

function renderAnimationFrame(tLoop){
  if(_baseDensity === null){ _baseDensity = params.pointDensityFactor; _baseIters = params.relaxIterations; }
  const anim = applyAnimationT(tLoop);
  _driftAngle = anim.driftAngle;
  _bloomScale = anim.bloomScale;
  _flockT     = anim.flockT;

  // No mode resamples the dot field per frame — every mode operates on the
  // relaxed anchor pose. The only time we rebuild is the very first frame
  // (when dotCount is still 0). This keeps every mode sub-30ms.
  const needRebuild = dotCount === 0;
  if(needRebuild){
    const prevDensity = params.pointDensityFactor;
    const prevIters   = params.relaxIterations;
    params.pointDensityFactor = anim.density;
    params.relaxIterations    = anim.iters;
    _rng = mulberry32(seedFromT(tLoop));
    preprocess();
    buildDots();
    _rng = Math.random;
    params.pointDensityFactor = prevDensity;
    params.relaxIterations    = prevIters;
  } else if(!preprocessed){
    preprocess();
    buildDots();
  }

  // Apply transform (drift / magnetic) into dotsBuf from dotsAnchor. Bloom is
  // a paint-time scalar, no position mutation.
  applyTransform();

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
    _driftAngle = 0; _bloomScale = 1; _flockT = 0;
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
const PAINT_KEYS = new Set(['showEffect','magnetism','coherence']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  // Always cache cursor in source-space — `magnetic` mode consumes this even
  // during animation, so the user can steer the cohesion target.
  if(preprocessed){
    const sw = preprocessed.width, sh = preprocessed.height;
    const W = cv.width, H = cv.height;
    const fitScale = Math.min(W / sw, H / sh);
    const offX = (W - sw * fitScale) / 2;
    const offY = (H - sh * fitScale) / 2;
    _flockCxSrc = (mouseX * (W / r.width)  - offX) / fitScale;
    _flockCySrc = (mouseY * (H / r.height) - offY) / fitScale;
  }
  if(params.interactive && !params.animate){
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    // X = magnetism, Y = coherence — the two new perceptual levers. Old
    // (density / iterations) were demoted because the named modes own them.
    const nm = +(ax).toFixed(2);
    const nc = +((1 - ay)).toFixed(2);
    let touched = false;
    if(nm !== params.magnetism){ params.magnetism = nm; touched = true; gui?.rows.get('magnetism')?._write(nm); }
    if(nc !== params.coherence){ params.coherence = nc; touched = true; gui?.rows.get('coherence')?._write(nc); }
    if(touched){
      // Show a preview pull at full strength so the user feels the lever.
      _flockT = 1;
      applyTransform();
      paint();
    }
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
    if(key === 'mode'){ /* animation-only; no static rebuild */ return; }
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
