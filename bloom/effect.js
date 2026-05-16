// pixart/bloom — luminance-threshold glow.
//
// Three-stage pipeline:
//   1. Bright pass: copy of source where pixels below `threshold` are zeroed
//      (warmth tint slightly biases the kept colour toward warm).
//   2. Blur the bright pass via canvas filter (radius px).
//   3. Composite source as base, then bright-blur on top with the 'lighter'
//      blend at `intensity` alpha — produces a photographic glow that wraps
//      bright regions without overcooking shadows.
//
// Modes (cosine envelope across cycleMs=20000):
//   throb — intensity pingpongs 0.4× ↔ 1.0× of base. Glow breathes; build
//           runs once.
//   aura  — radius pingpongs 0.4× ↔ 1.4× of base. Glow expands and
//           contracts; rebuilds the blur each frame.
//   tone  — threshold drifts ±35 around base. Bright regions reveal then
//           recede; rebuilds bright pass + blur each frame.
//
// Interactive: cursor X → threshold (60..220), cursor Y → radius (5..60).
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });
const brightBuf = document.createElement('canvas');
const bctx = brightBuf.getContext('2d', { willReadFrequently: true });
const blurBuf = document.createElement('canvas');
const blctx = blurBuf.getContext('2d');

const params = {
  canvasSize:  600,
  threshold:   170,
  radius:      26,
  intensity:   1.1,
  tint:        0.25,
  animate:     false,
  mode:        'throb',
  interactive: false,
  showEffect:  true,
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

function schedule(level){
  if(level === 'pre')   dirty.pre = true;
  if(level === 'pre' || level === 'build') dirty.build = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre)   preprocess();
    if(dirty.build) buildBright();
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

function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = params.canvasSize;
  const H = Math.max(1, Math.round(W * aspect));
  if(srcBuf.width !== W || srcBuf.height !== H){
    srcBuf.width = W; srcBuf.height = H;
    brightBuf.width = W; brightBuf.height = H;
    blurBuf.width = W; blurBuf.height = H;
  }
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  preprocessed = sctx.getImageData(0, 0, W, H);
}

function buildBright(){
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;
  const src = preprocessed.data;
  const out = bctx.createImageData(W, H);
  const od = out.data;
  const th = params.threshold;
  const tint = params.tint;
  for(let i = 0; i < src.length; i += 4){
    const r = src[i], g = src[i+1], b = src[i+2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if(lum > th){
      const k = (lum - th) / Math.max(1, 255 - th); // 0..1 above threshold
      const warmR = r + tint * 60 * k;
      const warmG = g + tint * 25 * k;
      const warmB = b - tint * 20 * k;
      od[i]   = clamp(warmR * k, 0, 255);
      od[i+1] = clamp(warmG * k, 0, 255);
      od[i+2] = clamp(warmB * k, 0, 255);
      od[i+3] = 255;
    } else {
      od[i]   = 0; od[i+1] = 0; od[i+2] = 0; od[i+3] = 255;
    }
  }
  bctx.putImageData(out, 0, 0);

  // Blur into blurBuf via canvas filter (GPU-accelerated path).
  blctx.clearRect(0, 0, W, H);
  blctx.filter = `blur(${Math.max(0.5, params.radius)}px)`;
  blctx.drawImage(brightBuf, 0, 0);
  blctx.filter = 'none';
}

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
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;

  ctx.drawImage(srcBuf, ox, oy, dw, dh);
  if(!params.showEffect){ ctx.restore(); return; }

  // Composite the blurred bright pass with 'lighter' for additive glow.
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = clamp(params.intensity, 0, 3);
  ctx.drawImage(blurBuf, ox, oy, dw, dh);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  ctx.restore();
}

// ---------- animation ----------
const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;
function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

// Track which mode last touched the bright/blur buffers so we know whether
// to rebuild on the next renderAt.
let _builtThreshold = -1;
let _builtRadius = -1;

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'throb'){
    // Paint-only: scale intensity 0.4..1.0 of base via pingpong.
    const base = params.intensity;
    params.intensity = base * (0.4 + 0.6 * pingPong(t01));
    return () => { params.intensity = base; };
  }
  if(mode === 'aura'){
    // Rebuild blur each frame at scaled radius.
    const base = params.radius;
    params.radius = Math.max(1, base * (0.4 + 1.0 * pingPong(t01)));
    return () => { params.radius = base; };
  }
  if(mode === 'tone'){
    const base = params.threshold;
    params.threshold = clamp(base + 35 * Math.cos(t01 * Math.PI * 2), 0, 255);
    return () => { params.threshold = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseTh = params.threshold;
  const baseR  = params.radius;
  params.threshold = 60 + ax * 160;
  params.radius    = 5 + ay * 55;
  return () => { params.threshold = baseTh; params.radius = baseR; };
}

function renderAt(t01){
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  if(params.threshold !== _builtThreshold || params.radius !== _builtRadius){
    buildBright();
    _builtThreshold = params.threshold;
    _builtRadius = params.radius;
  }
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

window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){ if(params.animate) startAnimation(); else paint(); return cv; },
};

const PRE_KEYS   = new Set(['canvasSize','fit','bg']);
const BUILD_KEYS = new Set(['threshold','radius','tint']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('paint'); }
      return;
    }
    if(key === 'mode' || key === 'interactive'){
      if(!params.animate) schedule('paint');
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
    else                         schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){ window.PIXSource.onChange(() => schedule('pre')); }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-bloom',
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
