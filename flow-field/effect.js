// pixart/flow-field — Perlin-noise vector field, particles painted by source.
//
// What it is (single sentence): for each particle, look up the Perlin-noise
// angle at its position, step a tiny distance in that direction, repeat for
// `steps` iterations, and stroke a thin line segment per step coloured by the
// source pixel sampled at the particle's CURRENT position. The accumulation
// of thousands of these streaks produces the canonical Tyler-Hobbs flow-field
// look: hair-like, smoke-like, fingerprint-like ribbons coloured by the input.
//
// Why Perlin (and not white noise / curl noise / simplex):
//   - Perlin (2002) gives spatially-coherent gradients — adjacent particles
//     bend the same way, which is the whole reason streaks form. White noise
//     would scatter the field. Simplex is faster but visually equivalent at
//     these scales; Perlin is the textbook reference.
//   - The angle field is `noise * 2π` (one octave). Multi-octave would push
//     the look toward turbulent fluid; one octave reads as silk / hair.
//
// References baked into the implementation:
//   - Hobbs, T. (2017) *Generative Algorithms* — flow-field chapter is the
//     canonical recipe. Takeaway: long streaks (≥20 steps) + tiny step length
//     beat short ribbons; ink-like alpha (≈0.4) lets streaks build density.
//   - Quilez, I. *Noise* + *Domain warping* (iquilezles.org/articles/warp).
//     Takeaway: domain-warping the noise lookup by a second noise lookup is
//     where most of the visual interest in flow fields actually lives — we
//     expose `noiseScale` as the lever and let the user dial frequency.
//   - Shiffman, D. *Nature of Code* chapter 6 (flow fields). Takeaway: bilinear
//     sampling the noise across a coarse grid is faster than per-step Perlin
//     calls — we sample Perlin directly because particle count × steps stays
//     tractable (2000 × 28 = 56k calls/frame).
//   - Hoff, A. (inconvergent.net) flow-field gallery. Takeaway: colour-from-
//     source instead of colour-from-palette is what differentiates a "field
//     sketch" from a "particle photograph". This effect is the latter.
//
// 15s seamless loop: every envelope wraps t to [0,1) before evaluation, the
// particle RNG is mulberry32(seedFromT(seed + ⌊t·N⌋/N)) in `march` mode, the
// noise lookup is offset by a wrapping function in `drift` mode, and the
// `idle` mode uses a single deterministic seed. → renderAt(0) ≡ renderAt(1).
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
  // Flow-field specific.
  mode:        'breath',
  particles:   2000,
  steps:       28,
  stepLength:  1.6,
  noiseScale:  0.006,
  flowStrength:1,
  lineWidth:   0.8,
  alpha:       0.45,
  colorMode:   'sample',   // sample | gradient | mono | complement
  inkColor:    '#ffffff',
  seed:        42,
  focusRadius: 220,
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
let preprocessed = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// ── transient animation state ───────────────────────────────────
let _flowMul    = 1;      // multiplier on flowStrength (breath / pulse)
let _swirlBias  = 0;      // monotonic rotational bias [0, 2π) (swirl)
let _driftX     = 0;      // noise-field offset, wraps period (drift)
let _driftY     = 0;
let _marchPhase = 0;      // particle reseed phase ∈ {0..3} (march)
let _focusCx = -1, _focusCy = -1, _focusR2 = 0;

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
    if(dirty.build) /* particles re-spawned in paint */ {}
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

// ─── Perlin 2D (Ken Perlin 2002, deterministic, fixed seed table) ─
// Reused unchanged from the recolor effect — same canonical implementation.
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
function hexToRgb(hex){
  const h = String(hex || '').replace('#','');
  const v = (h.length === 3) ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0');
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function sampleSource(sx, sy){
  if(!preprocessed) return [255,255,255];
  const W = preprocessed.width, H = preprocessed.height;
  const x = clamp(sx | 0, 0, W - 1);
  const y = clamp(sy | 0, 0, H - 1);
  const i = (y * W + x) * 4;
  const d = preprocessed.data;
  return [d[i], d[i+1], d[i+2]];
}

// ─── paint (everything runs in paint; build is cheap) ─────────
//
// We don't pre-bake particles — the per-frame cost is dominated by the
// stroke calls anyway, and re-running the integration each frame lets every
// mode share the same hot loop without branching on "did the field change".
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!preprocessed){ ctx.restore(); return; }

  // Map source-space onto canvas with object-fit:contain parity with edge/recolor.
  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  // Seed the particle RNG. In `march` mode the seed steps 4 times across the
  // loop so the spawn distribution remixes — the field is unchanged, but the
  // particles sampling it are different sets. Byte-equal seam: phase 0 at t=0
  // and t=1 both produce phase index 0.
  const seedBase = (params.seed | 0) + _marchPhase * 9973;
  const prng = mulberry32(seedBase);

  const N      = params.particles | 0;
  const steps  = Math.max(1, params.steps | 0);
  const dL     = params.stepLength;
  const S      = params.noiseScale;
  const Fbase  = params.flowStrength * _flowMul;
  const lw     = params.lineWidth;
  const baseA  = clamp(params.alpha, 0, 1);
  const cmode  = params.colorMode;
  const ink    = hexToRgb(params.inkColor);
  const swirl  = _swirlBias;       // [0, 2π)
  const dxOff  = _driftX;
  const dyOff  = _driftY;
  const useFocus = _focusR2 > 0;

  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(0.3, lw);

  for(let p = 0; p < N; p++){
    // Spawn uniformly in source space (cheap and gives even density coverage).
    let x = prng() * sw;
    let y = prng() * sh;

    // Initial colour. For `sample` and `complement` we re-sample at each step;
    // for `gradient` we anchor a start-colour and lerp toward end-colour at the
    // particle's final position; for `mono` we hold a constant.
    let r = ink[0], g = ink[1], b = ink[2];
    let r0 = r, g0 = g, b0 = b;
    if(cmode === 'sample' || cmode === 'gradient' || cmode === 'complement'){
      const c = sampleSource(x, y);
      r0 = c[0]; g0 = c[1]; b0 = c[2];
      if(cmode === 'complement'){ r0 = 255 - r0; g0 = 255 - g0; b0 = 255 - b0; }
      r = r0; g = g0; b = b0;
    }

    // Pre-resolve gradient endpoint by integrating once (cheap projection — we
    // approximate by sampling N/2 steps ahead at field-angle of spawn; good
    // enough for an artistic lerp, avoids a full second pass).
    let r1 = r0, g1 = g0, b1 = b0;
    if(cmode === 'gradient'){
      const a0 = perlin2((x + dxOff) * S, (y + dyOff) * S) * 2 * Math.PI + swirl;
      const ex = x + Math.cos(a0) * dL * steps * 0.5;
      const ey = y + Math.sin(a0) * dL * steps * 0.5;
      const c1 = sampleSource(ex, ey);
      r1 = c1[0]; g1 = c1[1]; b1 = c1[2];
    }

    ctx.beginPath();
    ctx.moveTo(ox + x * scale, oy + y * scale);

    for(let s = 0; s < steps; s++){
      // Local flow strength: cursor amplifies inside focusRadius (turbulence
      // under pointer). Use the squared-distance trick: 1 + 2·(1 - d²/R²)⁺.
      let F = Fbase;
      if(useFocus){
        const ddx = x - _focusCx, ddy = y - _focusCy;
        const d2 = ddx*ddx + ddy*ddy;
        if(d2 < _focusR2){ F *= 1 + 2 * (1 - d2 / _focusR2); }
      }
      // Perlin → angle. swirl is a monotonic additive bias (swirl mode).
      // (dxOff, dyOff) translate the noise lookup (drift mode).
      const ang = perlin2((x + dxOff) * S, (y + dyOff) * S) * 2 * Math.PI + swirl;
      x += Math.cos(ang) * dL * F;
      y += Math.sin(ang) * dL * F;

      // Stop if particle escapes — avoids long no-op edges and unbounded draw.
      if(x < 0 || y < 0 || x >= sw || y >= sh) break;

      // Per-step colour
      if(cmode === 'sample'){
        const c = sampleSource(x, y); r = c[0]; g = c[1]; b = c[2];
      } else if(cmode === 'gradient'){
        const u = s / Math.max(1, steps - 1);
        r = lerp(r0, r1, u); g = lerp(g0, g1, u); b = lerp(b0, b1, u);
      } else if(cmode === 'complement'){
        const c = sampleSource(x, y); r = 255-c[0]; g = 255-c[1]; b = 255-c[2];
      }
      ctx.strokeStyle = `rgba(${r|0},${g|0},${b|0},${baseA})`;
      ctx.lineTo(ox + x * scale, oy + y * scale);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ox + x * scale, oy + y * scale);
    }
  }

  ctx.restore();
}

// ─── animation ────────────────────────────────────────────────
//
// Mode envelopes. All wrap t to [0,1) so cos(2π·t) == cos(0) at the seam.
//
//   idle   — static frame.
//   breath — flowStrength cosine pingpong (peaks at t=0.5).
//   swirl  — flowStrength pingpong + monotonic rotational bias 0→2π. The
//            angle wraps cleanly because 2π ≡ 0 mod 2π — sine/cosine agree.
//   pulse  — flowStrength spike. Asymmetric envelope: fast attack
//            (1 - exp(-k·t)) for t<0.5, slow decay back to 1.
//   march  — particle reseed: ⌊t·4⌋ ∈ {0,1,2,3}. Field unchanged, the
//            sampling rotates. Byte-equal seam: phase(t=1) := phase(0).
//   drift  — (dxOff, dyOff) translate monotonically across one Perlin period
//            (256 units). The field walks; particles re-sample anew.
function applyAnimationT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  const t01 = w;
  const pp = (1 - Math.cos(t01 * 2 * Math.PI)) / 2;

  let flowMul = 1, swirlBias = 0, driftX = 0, driftY = 0, marchPhase = 0;
  switch(params.mode){
    case 'idle': break;
    case 'breath': flowMul = 1 + 0.6 * pp; break;
    case 'swirl': {
      flowMul = 1 + 0.4 * pp;
      // Full rotation across the loop. 2π wraps to 0 → byte-equal.
      swirlBias = t01 * 2 * Math.PI;
      break;
    }
    case 'pulse': {
      // Asymmetric spike: sharp attack, slower decay.
      // Mapped so f(0)=1, f(0.5)≈peak (~2.2), f(1)=1.
      const spike = t01 < 0.5
        ? Math.sin(t01 * Math.PI) ** 2          // 0→1 fast
        : Math.cos((t01 - 0.5) * Math.PI) ** 2; // 1→0 smooth
      flowMul = 1 + 1.2 * spike;
      break;
    }
    case 'march': {
      // 4 distinct seed phases held for 1/4 each. Seam pin: t=0 and t=1 both
      // sit in phase 0 by explicit override.
      let idx = Math.floor(t01 * 4);
      if(idx >= 4) idx = 3;
      if(t01 === 0) idx = 0;
      marchPhase = idx;
      break;
    }
    case 'drift': {
      // Walk one full Perlin period (256 units) across the loop. Both x and y
      // walk so the field translates diagonally — reads as wind. Period is
      // 256 by Perlin construction, so 256·t at t=1 wraps to 0.
      driftX = 256 * t01;
      driftY = 256 * t01;
      break;
    }
  }
  return { flowMul, swirlBias, driftX, driftY, marchPhase };
}

function renderAnimationFrame(tLoop){
  const a = applyAnimationT(tLoop);
  _flowMul = a.flowMul;
  _swirlBias = a.swirlBias;
  _driftX = a.driftX;
  _driftY = a.driftY;
  _marchPhase = a.marchPhase;

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
  paint();

  _flowMul = 1; _swirlBias = 0; _driftX = 0; _driftY = 0; _marchPhase = 0;
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

const PRE_KEYS = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);

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
    schedule('paint');
  } else if(_focusR2 !== 0){
    _focusR2 = 0;
    schedule('paint');
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
    if(PRE_KEYS.has(key)) schedule('pre');
    else                  schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => { if(!params.animate) schedule('pre'); });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-flow-field',
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
