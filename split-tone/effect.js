// pixart/split-tone — shadow/highlight hue color grading.
//
// Classic photographic split-tone: dark pixels shift toward a "shadow hue",
// bright pixels shift toward a "highlight hue", with smooth S-curve blending
// in the midtones. The result is a sophisticated film color grade.
//
// Algorithm:
//   1. Compute per-pixel luminance (0..1).
//   2. Derive a smoothstep blend weight from lum relative to the split point
//      (split point is controlled by `balance`).
//   3. Tint color = lerp(shadowRGB, highlightRGB, smoothWeight).
//   4. Output = lerp(original, tint, strength).
//
// Animation modes (cycleMs = 20000):
//   hue-cycle    — shadow and highlight hues both rotate at different speeds.
//   balance-shift — balance oscillates -80..+80 (split point sweeps image).
//   intensity    — strength oscillates 0.2..1.0.
//
// Interactive:
//   Mouse X → shadowHue (0..360)
//   Mouse Y → highlightHue (0..360, inverted — top = warm)
//
// Credit: inspired by split-tone color grading in film photography and Lightroom.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (shared with every other effect).
  canvasSize:   600,
  blur:         0,
  grain:        0,
  gamma:        1,
  blackPoint:   0,
  whitePoint:   255,
  // Split-tone specific.
  shadowHue:    210,    // blue shadows (default)
  shadowSat:    60,
  highlightHue: 30,     // warm amber highlights (default)
  highlightSat: 40,
  balance:      0,      // -100 = shadows dominate, 0 = even, +100 = highlights dominate
  strength:     0.7,
  showEffect:   true,
  // Animation / interactive.
  animate:      false,
  mode:         'hue-cycle',
  interactive:  false,
  // Shared chrome.
  fit:          'cover',
  bg:           '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let outImg       = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

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

  if(params.blur > 0){
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const t = tmp.getContext('2d');
    t.filter = `blur(${params.blur}px)`;
    t.drawImage(srcBuf, 0, 0);
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(tmp, 0, 0);
  }

  const id = sctx.getImageData(0, 0, W, H);
  const px = id.data;
  const g  = params.grain;
  const gm = params.gamma;
  const bp = params.blackPoint;
  const wp = params.whitePoint;
  const span = Math.max(1, wp - bp);
  const scale = 255 / span;
  const rnd = Math.random;
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

// ---------- colour helpers ----------
function hslToRgb(h, s, l){
  // h in degrees (0..360), s and l in 0..1
  // Returns [r, g, b] in 0..255.
  h = ((h % 360) + 360) % 360 / 360;
  if(s === 0){
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = (t) => {
    let tt = t;
    if(tt < 0) tt += 1; if(tt > 1) tt -= 1;
    if(tt < 1/6) return p + (q - p) * 6 * tt;
    if(tt < 1/2) return q;
    if(tt < 2/3) return p + (q - p) * (2/3 - tt) * 6;
    return p;
  };
  return [
    Math.round(hk(h + 1/3) * 255),
    Math.round(hk(h)       * 255),
    Math.round(hk(h - 1/3) * 255),
  ];
}

// ---------- build (split-tone per-pixel) ----------
function buildOutput(){
  if(!preprocessed){ outImg = null; return; }
  const { data, width: W, height: H } = preprocessed;
  if(!outImg || outImg.width !== W || outImg.height !== H){
    outImg = new ImageData(W, H);
  }

  // Convert hues to RGB target colors at 50% lightness (pure saturated color).
  const shadowRGB    = hslToRgb(params.shadowHue,    params.shadowSat    / 100, 0.5);
  const highlightRGB = hslToRgb(params.highlightHue, params.highlightSat / 100, 0.5);

  const dst = outImg.data;
  const bal = params.balance / 100;  // -1..+1
  const str = params.strength;

  // Split point: balance=0 → midpoint at lum=0.5
  //              balance=-1 → 0.0 (shadows take everything)
  //              balance=+1 → 1.0 (highlights take everything)
  const splitPt = clamp(0.5 + bal * 0.5, 0.001, 0.999);

  const sR = shadowRGB[0],    sG = shadowRGB[1],    sB = shadowRGB[2];
  const hR = highlightRGB[0], hG = highlightRGB[1], hB = highlightRGB[2];

  for(let i = 0; i < data.length; i += 4){
    const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];

    // Perceived luminance (0..1).
    const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;

    // Smoothstep blend weight: 0 = full shadow tint, 1 = full highlight tint.
    // The transition zone is 0.5 wide, centred on splitPt.
    const raw = (lum - splitPt) / 0.5 + 0.5;
    const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    const smooth = t * t * (3 - 2 * t);  // smoothstep

    // Blend tint color between shadow and highlight.
    const tR = sR + (hR - sR) * smooth;
    const tG = sG + (hG - sG) * smooth;
    const tB = sB + (hB - sB) * smooth;

    // Mix original toward tint by strength.
    dst[i]   = (r + (tR - r) * str + 0.5) | 0;
    dst[i+1] = (g + (tG - g) * str + 0.5) | 0;
    dst[i+2] = (b + (tB - b) * str + 0.5) | 0;
    dst[i+3] = a;
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

  const showSrc = !params.showEffect;
  const imgW = preprocessed.width, imgH = preprocessed.height;
  const aspect = imgW / imgH;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;

  if(showSrc){
    ctx.drawImage(srcBuf, ox, oy, dw, dh);
    ctx.restore();
    return;
  }
  if(!outImg){ ctx.restore(); return; }

  const tmp = document.createElement('canvas');
  tmp.width = imgW; tmp.height = imgH;
  tmp.getContext('2d').putImageData(outImg, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
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
  const mode = params.mode;
  if(mode === 'hue-cycle'){
    // Shadow and highlight hues rotate at different rates — seamless cosine.
    // Shadow: slower (0.7x speed), highlight: faster (1.3x), offset 90°.
    const baseSH = params.shadowHue;
    const baseHH = params.highlightHue;
    params.shadowHue    = (baseSH + t01 * 360 * 0.7) % 360;
    params.highlightHue = (baseHH + t01 * 360 * 1.3 + 180) % 360;
    return () => { params.shadowHue = baseSH; params.highlightHue = baseHH; };
  }
  if(mode === 'balance-shift'){
    // Balance sweeps -80..+80. Dramatic split-point migration.
    const base = params.balance;
    params.balance = 80 * Math.cos(t01 * Math.PI * 2);
    return () => { params.balance = base; };
  }
  if(mode === 'intensity'){
    // Strength fades 0.2..1.0. Toning breathes in and out.
    const base = params.strength;
    params.strength = 0.2 + 0.8 * pingPong(t01);
    return () => { params.strength = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseSH = params.shadowHue;
  const baseHH = params.highlightHue;
  // X → shadowHue (0..360). Y → highlightHue inverted (top=warm 30°, bottom=cool 210°).
  params.shadowHue    = ax * 360;
  params.highlightHue = (1 - ay) * 360;
  return () => {
    params.shadowHue    = baseSH;
    params.highlightHue = baseHH;
  };
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
  if(params.interactive && !params.animate){
    renderAt(0);
  }
}

// ---------- WAEffect contract ----------
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

// Pipeline buckets.
const PRE_KEYS   = new Set(['canvasSize','blur','grain','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['shadowHue','shadowSat','highlightHue','highlightSat','balance','strength']);
const PAINT_KEYS = new Set(['showEffect']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('build'); }
      return;
    }
    if(key === 'mode'){
      if(!params.animate) schedule('paint');
      return;
    }
    if(key === 'interactive'){
      if(!params.animate) schedule('paint');
      return;
    }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(params.animate) return; // animation loop owns the canvas
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
      canvas: cv, name: 'pixart-split-tone',
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

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
