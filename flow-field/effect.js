// pixart/flow-field — Perlin-noise vector field, particles painted by source.
//
// For each particle: look up Perlin-noise angle at its position, step a tiny
// distance in that direction, repeat for `steps` iterations, stroke a thin
// line segment per step coloured by the source pixel sampled at the particle's
// CURRENT position. Thousands of these streaks → Tyler-Hobbs flow-field look:
// hair-like ribbons coloured by the input.
//
// References: Hobbs 2017 (Generative Algorithms), Shiffman Nature of Code ch.6,
// Quilez (iquilezles.org/articles/warp), Hoff (inconvergent.net).
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

// Step 2 defaults — swept in browser against portrait.jpg. Sweet spot for
// "streak field reads AS streaks AND portrait stays recognizable":
//
//   particles=4000   — dense field that still lets face emerge.
//   steps=12         — short streaks track the image; long streaks smear it.
//   stepLength=1.2   — face-feature scale; bigger and the eyes/mouth dissolve.
//   noiseScale=0.006 — large-scale field, hair flows in coherent groups.
//   flowStrength=1   — neutral; the modes pingpong around this.
//   alpha=0.6        — strong ink, but not enough to mud the face.
//
// Animation modes (cosine envelope across cycleMs=15000):
//
//   flow  — flowStrength pingpongs 0 ↔ 2. Streaks retract into points and
//           elongate into long hair-ribbons. Default; most "alive".
//   drift — noiseScale slowly drifts 0.003 ↔ 0.012 (cosine). The flow field
//           topology morphs — coarse swirls breathe in and out of finer ones.
//
// Interactive: cursor X → flowStrength (0..2), cursor Y → stepLength (0.5..5).
// One metaphor: the cursor IS the wind. Right = strong gusts, down = long stride.
const params = {
  particles:    4000,
  steps:        12,
  stepLength:   1.2,
  noiseScale:   0.006,
  flowStrength: 1,
  lineWidth:    0.8,
  alpha:        0.6,
  colorMode:    'sample',   // sample | gradient | mono | complement
  inkColor:     '#ffffff',
  animate:      false,
  mode:         'flow',     // flow | drift
  interactive:  false,
  fit:          'cover',
  bg:           '#0a0a0a',
  showEffect:   true,
};
if(window.PIXState) window.PIXState.hydrate(params);

const CANVAS_SIZE = 600;
const PARTICLE_SEED = 42; // deterministic placement

let gui;
let preprocessed = null;
let dirty = { pre: true, paint: true };
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
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre) preprocess();
    paint();
    dirty.pre = dirty.paint = false;
  });
}

function fitCanvas(){
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ─── preprocessor ─────────────────────────────────────────────
function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = CANVAS_SIZE;
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

// ─── Perlin 2D (Ken Perlin 2002, deterministic) ────────────────
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

// ─── paint ───────────────────────────────────────────────────
function paint(){
  window.WAGUI?.flashValues(params);
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!preprocessed){ ctx.restore(); return; }

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  // showEffect=false: just paint the source.
  if(!params.showEffect){
    ctx.drawImage(srcBuf, ox, oy, dw, dh);
    ctx.restore();
    return;
  }

  const prng = mulberry32(PARTICLE_SEED);

  const N      = params.particles | 0;
  const steps  = Math.max(1, params.steps | 0);
  const dL     = params.stepLength;
  const S      = params.noiseScale;
  const F      = params.flowStrength;
  const lw     = params.lineWidth;
  const baseA  = clamp(params.alpha, 0, 1);
  const cmode  = params.colorMode;
  const ink    = hexToRgb(params.inkColor);

  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(0.3, lw);

  for(let p = 0; p < N; p++){
    let x = prng() * sw;
    let y = prng() * sh;

    let r = ink[0], g = ink[1], b = ink[2];
    let r0 = r, g0 = g, b0 = b;
    if(cmode === 'sample' || cmode === 'gradient' || cmode === 'complement'){
      const c = sampleSource(x, y);
      r0 = c[0]; g0 = c[1]; b0 = c[2];
      if(cmode === 'complement'){ r0 = 255 - r0; g0 = 255 - g0; b0 = 255 - b0; }
      r = r0; g = g0; b = b0;
    }

    let r1 = r0, g1 = g0, b1 = b0;
    if(cmode === 'gradient'){
      const a0 = perlin2(x * S, y * S) * 2 * Math.PI;
      const ex = x + Math.cos(a0) * dL * steps * 0.5;
      const ey = y + Math.sin(a0) * dL * steps * 0.5;
      const c1 = sampleSource(ex, ey);
      r1 = c1[0]; g1 = c1[1]; b1 = c1[2];
    }

    ctx.beginPath();
    ctx.moveTo(ox + x * scale, oy + y * scale);

    for(let s = 0; s < steps; s++){
      const ang = perlin2(x * S, y * S) * 2 * Math.PI;
      x += Math.cos(ang) * dL * F;
      y += Math.sin(ang) * dL * F;
      if(x < 0 || y < 0 || x >= sw || y >= sh) break;

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

// ─── animation + interactive ──────────────────────────────────
// Mirrors the bevel pattern: applyMode/applyInteractive mutate params,
// renderAt rebuilds, restorers wipe so GUI keeps showing user values.
const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'flow'){
    // flowStrength pingpongs 0 ↔ 2. Streaks elongate and retract.
    const base = params.flowStrength;
    params.flowStrength = 2 * pingPong(t01);
    return () => { params.flowStrength = base; };
  }
  if(mode === 'drift'){
    // noiseScale drifts 0.003 ↔ 0.012, full cosine. Field topology morphs.
    const base = params.noiseScale;
    params.noiseScale = 0.0075 + 0.0045 * Math.cos(t01 * Math.PI * 2);
    return () => { params.noiseScale = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseFlow = params.flowStrength;
  const baseStep = params.stepLength;
  params.flowStrength = ax * 2;
  params.stepLength   = 0.5 + ay * 4.5;
  return () => { params.flowStrength = baseFlow; params.stepLength = baseStep; };
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

// ─── WAEffect contract ────────────────────────────────────────
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

const PRE_KEYS = new Set(['fit','bg']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('paint'); }
      return;
    }
    if(key === 'mode' || key === 'interactive'){
      if(!params.animate) schedule('paint');
      return;
    }
    if(params.animate) return;
    if(PRE_KEYS.has(key)) schedule('pre');
    else                  schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-flow-field',
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
