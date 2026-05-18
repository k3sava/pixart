// pixart/prismatic — rainbow prism effect via per-pixel hue rotation.
//
// Algorithm:
//   1. Preprocessor produces a W×H RGBA buffer (standard).
//   2. For each pixel compute a hue-shift amount based on:
//        luminance — bright pixels shift warm (toward red), dark shift cool (toward violet)
//        position  — pixels shift along the `angle` direction (left=red, right=violet)
//        noise     — Perlin noise field drives shift (liquid, organic)
//   3. Apply hue rotation + optional saturation boost via fast inline HSL math.
//   4. Optionally displace the source sample by a small vector along the hue axis
//      (spatial chromatic spread — like a real prism's light fan).
//   5. Blend result with source at configurable strength.
//
// Three animation modes:
//   sweep   — hue offset base continuously rotates (rainbow slides through image)
//   breathe — spread oscillates 0 ↔ max (image pulses between normal and prismatic)
//   flow    — noise-mode phase drifts over time (liquid rainbow movement)
//
// Interactive: X → spread, Y → angle
//
// WAEffect contract: { cycleMs:20000, renderAt(t), pauseRender(), resumeRender() }
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (shared).
  canvasSize:   600,
  blurAmount:   0,
  grainAmount:  0,
  gamma:        1,
  blackPoint:   0,
  whitePoint:   255,
  // Prismatic-specific.
  spread:       60,    // 0–100: total hue range spanned
  mode:         'luminance', // luminance | position | noise
  angle:        0,     // 0–360: direction of position-based spread
  satBoost:     40,    // 0–100: saturation boost (%)
  blend:        80,    // 0–100: mix prismatic vs original
  displacement: 8,     // 0–50: pixel offset along hue direction
  // Animation.
  animate:      false,
  animMode:     'sweep', // sweep | breathe | flow
  interactive:  false,
  showEffect:   true,
  fit:          'cover',
  bg:           '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let outImg       = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// Animation-time transient overrides (not written back to params).
let _sweepOffset  = 0;  // additive hue offset in degrees (sweep mode)
let _breatheScale = 1;  // multiplier on spread (breathe mode)
let _noisePhase   = 0;  // additive offset to noise coords (flow mode)

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

function schedule(level){
  if(level === 'pre')   dirty.pre   = true;
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

// ---------- preprocessor ----------
function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = (window.PIXSource?.height || srcCv.height) / (window.PIXSource?.width || srcCv.width);
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

  preprocessed = sctx.getImageData(0, 0, W, H);
}

// ---------- fast inline HSL ↔ RGB ----------
// Returns [h(0-360), s(0-1), l(0-1)]
function rgbToHsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const l   = (max + min) * 0.5;
  if(max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if(max === r)      h = (g - b) / d + (g < b ? 6 : 0);
  else if(max === g) h = (b - r) / d + 2;
  else               h = (r - g) / d + 4;
  return [h * 60, s, l];
}

// Returns [r, g, b] integers 0-255
function hslToRgb(h, s, l){
  h = ((h % 360) + 360) % 360 / 360;
  if(s === 0){
    const v = (l * 255 + 0.5) | 0;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = (t) => {
    let tt = t < 0 ? t + 1 : (t > 1 ? t - 1 : t);
    if(tt < 0.1667) return p + (q - p) * 6 * tt;
    if(tt < 0.5)    return q;
    if(tt < 0.6667) return p + (q - p) * (0.6667 - tt) * 6;
    return p;
  };
  return [
    (hk(h + 0.3333) * 255 + 0.5) | 0,
    (hk(h)          * 255 + 0.5) | 0,
    (hk(h - 0.3333) * 255 + 0.5) | 0,
  ];
}

// ---------- Perlin noise (deterministic, fixed seed) ----------
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
const PERM = (function(){
  const p = new Uint8Array(512);
  const src = new Uint8Array(256);
  for(let i = 0; i < 256; i++) src[i] = i;
  const rng = mulberry32(42);
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
  const aa = PERM[PERM[xi    ] + yi    ];
  const ab = PERM[PERM[xi    ] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi    ];
  const bb = PERM[PERM[xi + 1] + yi + 1];
  const x1 = lerp(grad2(aa, xf,     yf    ), grad2(ba, xf - 1, yf    ), u);
  const x2 = lerp(grad2(ab, xf,     yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v) * 0.5 + 0.5; // normalised 0..1
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

  // Normalised params for this frame (may be temporarily overridden by anim).
  const spread      = clamp(params.spread,      0,  100) / 100 * 360; // degrees
  const effectSpread = spread * _breatheScale;
  const angleRad    = (params.angle / 180) * Math.PI;
  const cosA        = Math.cos(angleRad);
  const sinA        = Math.sin(angleRad);
  const satBoost    = clamp(params.satBoost,    0,  100) / 100;
  const blendFactor = clamp(params.blend,       0,  100) / 100;
  const disp        = clamp(params.displacement, 0,  50);
  const mode        = params.mode;
  const noiseScale  = 0.012;

  // Precompute direction components for displacement.
  // Displacement shifts sample coordinates along the hue-rotation direction
  // (perpendicular to the prism orientation).
  const dispX = cosA;
  const dispY = sinA;

  for(let y = 0, j = 0; y < H; y++){
    const yn = y / (H - 1); // 0..1
    for(let x = 0; x < W; x++, j += 4){
      const xn = x / (W - 1); // 0..1

      // ----- compute t: normalised position in the hue ramp [0..1] -----
      let t;
      if(mode === 'luminance'){
        const r0 = src[j], g0 = src[j+1], b0 = src[j+2];
        t = (r0 * 0.2126 + g0 * 0.7152 + b0 * 0.0722) / 255;
      } else if(mode === 'position'){
        // Project (x,y) onto the spread direction. cosA/sinA already computed.
        t = (xn * cosA + yn * sinA) * 0.5 + 0.5;
        t = clamp(t, 0, 1);
      } else { // noise
        t = perlin2(xn * W * noiseScale + _noisePhase, yn * H * noiseScale + _noisePhase * 0.7);
      }

      // ----- hue shift amount in degrees -----
      const hueShift = (t - 0.5) * effectSpread + _sweepOffset;

      // ----- sample source pixel (with optional displacement) -----
      let sr, sg, sb, sa;
      if(disp > 0){
        // Shift sample coords by disp pixels along spread direction.
        const shift = (t - 0.5) * disp;
        const sx = clamp(x + (dispX * shift + 0.5) | 0, 0, W - 1);
        const sy = clamp(y + (dispY * shift + 0.5) | 0, 0, H - 1);
        const si = (sy * W + sx) * 4;
        sr = src[si]; sg = src[si+1]; sb = src[si+2]; sa = src[si+3];
      } else {
        sr = src[j]; sg = src[j+1]; sb = src[j+2]; sa = src[j+3];
      }

      if(sa === 0){ dst[j] = 0; dst[j+1] = 0; dst[j+2] = 0; dst[j+3] = 0; continue; }

      // ----- apply hue rotation + sat boost -----
      let [h, s, l] = rgbToHsl(sr, sg, sb);
      h = h + hueShift;
      s = clamp(s + (1 - s) * satBoost, 0, 1);
      const [pr, pg, pb] = hslToRgb(h, s, l);

      // ----- blend with original -----
      if(blendFactor >= 1){
        dst[j]   = clamp(pr, 0, 255);
        dst[j+1] = clamp(pg, 0, 255);
        dst[j+2] = clamp(pb, 0, 255);
        dst[j+3] = sa;
      } else {
        // Read original at (j) for blend (not displaced).
        const or_ = src[j], og = src[j+1], ob = src[j+2];
        dst[j]   = (lerp(or_, pr, blendFactor) + 0.5) | 0;
        dst[j+1] = (lerp(og,  pg, blendFactor) + 0.5) | 0;
        dst[j+2] = (lerp(ob,  pb, blendFactor) + 0.5) | 0;
        dst[j+3] = sa;
      }
    }
  }
}

// ---------- paint ----------
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

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if(!params.showEffect){
    ctx.drawImage(srcBuf, ox, oy, dw, dh);
    ctx.restore();
    return;
  }

  if(!outImg){ ctx.restore(); return; }

  const tmp = document.createElement('canvas');
  tmp.width = imgW; tmp.height = imgH;
  tmp.getContext('2d').putImageData(outImg, 0, 0);
  ctx.drawImage(tmp, ox, oy, dw, dh);
  ctx.restore();
}

// ---------- animation ----------
const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.animMode;
  if(mode === 'sweep'){
    // Hue offset base rotates continuously 0→360 per cycle.
    _sweepOffset = t01 * 360;
    return () => { _sweepOffset = 0; };
  }
  if(mode === 'breathe'){
    // Spread oscillates 0 ↔ max. Image periodically goes normal then prismatic.
    _breatheScale = pingPong(t01);
    return () => { _breatheScale = 1; };
  }
  if(mode === 'flow'){
    // Noise phase drifts — liquid rainbow movement. Works best in noise mode.
    _noisePhase = t01 * 8;
    return () => { _noisePhase = 0; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseSpread = params.spread;
  const baseAngle  = params.angle;
  // X → spread (0..100), Y → angle (0..360).
  params.spread = ax * 100;
  params.angle  = ay * 360;
  return () => { params.spread = baseSpread; params.angle = baseAngle; };
}

function renderAt(t01){
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  buildOutput();
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
  if(params.interactive && !params.animate) renderAt(0);
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

// Pipeline buckets.
const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['spread','mode','angle','satBoost','blend','displacement']);
const PAINT_KEYS = new Set(['showEffect']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('build'); }
      return;
    }
    if(key === 'animMode' || key === 'interactive'){
      if(!params.animate) schedule('build');
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
    else if(PAINT_KEYS.has(key)) schedule('paint');
    else                         schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-prismatic',
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
