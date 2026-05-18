// pixart/datamosh — Video datamoshing simulation.
//
// Simulates the datamosh artifact from corrupted video compression: pixel blocks
// from a "previous frame" bleed into the current frame, creating smeared motion-
// blur and ghost effects. Classic internet/vaporwave aesthetic.
//
// Pipeline: preprocess() → buildOutput() → paint()
//   preprocess: reads PIXSource, scales to canvasSize, stores as `preprocessed` ImageData.
//   buildOutput: generates block-level motion vectors (random seeds), blends current
//                pixels with prev-frame pixels warped by the vector. High `amount`
//                favors prev-frame → smear/ghost. Accumulates `prevFrame` across
//                animation ticks for decaying echo. Optional `glitch` tears hard
//                blocks of pixels with no blending.
//   paint: draws `outImg` scaled to canvas.
//
// Defaults were chosen by sweeping against portrait.jpg:
//   blockSize  = 16   — reads clearly as block-based corruption without dissolving
//   amount     = 60   — strong datamosh visible but face still readable
//   decay      = 20   — prev-frame fades slowly → long ghost trail
//   randomize  = 40   — chaotic but not pure noise
//   glitch     = 15   — occasional hard tears without overwhelming the image
//
// Animation modes (each = cosine envelope across cycleMs = 15000):
//   flow    — motion vectors slowly rotate; smooth liquid smear
//   burst   — periodic bursts of heavy datamoshing, then clearing
//   cascade — blocks shift downward, creating a vertical cascade
//
// Interactive:
//   X → amount (0..100, blend strength)
//   Y → blockSize (8..64, block size)
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  blockSize:   16,
  amount:      60,
  decay:       20,
  randomize:   40,
  glitch:      15,
  animate:     false,
  mode:        'flow',
  interactive: false,
  showEffect:  true,
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let outBuf = null;
let outImg = null;
// prevFrame accumulates across animation ticks for the echo effect
let prevFrame = null;
// prevFrameFromPreprocess is updated each time preprocess() runs
// to re-anchor the prev frame to the actual source
let prevFrameSeeded = false;

let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

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
  const W = 600;
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

  // Seed prevFrame from the clean source on first preprocess or source change.
  // This gives the datamosh a real reference frame to smear from.
  prevFrame = new ImageData(
    new Uint8ClampedArray(preprocessed.data),
    W, H
  );
  prevFrameSeeded = true;
}

// ---------- datamosh build ----------
function buildOutput(overrides){
  if(!preprocessed){ return; }
  const W = preprocessed.width, H = preprocessed.height;

  if(!outBuf || outBuf.length !== W * H * 4){
    outBuf = new Uint8ClampedArray(W * H * 4);
    outImg = new ImageData(outBuf, W, H);
  }
  if(!prevFrame || prevFrame.width !== W || prevFrame.height !== H){
    prevFrame = new ImageData(new Uint8ClampedArray(preprocessed.data), W, H);
  }

  const src = preprocessed.data;
  const prev = prevFrame.data;
  const out = outBuf;

  // Read params (overrides allowed for animation modes)
  const bs       = clamp(Math.round(overrides?.blockSize ?? params.blockSize), 4, 128);
  const amount   = clamp(overrides?.amount ?? params.amount, 0, 100) / 100;
  const decay    = clamp(overrides?.decay  ?? params.decay,  0, 100) / 100;
  const rndAmt   = clamp(overrides?.randomize ?? params.randomize, 0, 100) / 100;
  const glitch   = clamp(overrides?.glitch ?? params.glitch, 0, 100) / 100;
  const mode     = overrides?.mode ?? params.mode;
  const t01      = overrides?.t01 ?? 0;

  // Compute motion vector angle per mode
  let angle = 0;
  let downBias = 0; // cascade mode only
  let burstScale = 1;
  if(mode === 'flow'){
    angle = t01 * Math.PI * 2;
  } else if(mode === 'burst'){
    // Burst: periodic heavy datamosh bursts. Intensity follows abs(sin(t * π * 4)).
    // During burst peak, amount doubles; between bursts it drops to near zero.
    burstScale = Math.abs(Math.sin(t01 * Math.PI * 4));
    angle = t01 * Math.PI * 2;
  } else if(mode === 'cascade'){
    // Cascade: blocks always flow downward
    angle = Math.PI / 2;
    downBias = 1;
  }

  const rnd = mulberry32(Math.round(t01 * 1000) | 0);

  // Base motion magnitude: randomize drives the variance
  const maxVec = Math.max(bs * 2, 8);

  // Count blocks
  const bCols = Math.ceil(W / bs);
  const bRows = Math.ceil(H / bs);

  for(let br = 0; br < bRows; br++){
    for(let bc = 0; bc < bCols; bc++){
      // Per-block random offset
      const localRnd = mulberry32((br * 1000 + bc + 1) | 0);
      const rndAngle = localRnd() * Math.PI * 2;
      const rndMag   = localRnd() * rndAmt;

      // Motion vector for this block
      const baseVecX = Math.cos(angle) * (1 - rndAmt) + Math.cos(rndAngle) * rndAmt;
      const baseVecY = Math.sin(angle) * (1 - rndAmt) + Math.sin(rndAngle) * rndAmt;
      let mag = maxVec * (0.3 + rndMag * 0.7);
      if(mode === 'burst') mag *= burstScale;

      const mvx = Math.round(baseVecX * mag);
      const mvy = Math.round(baseVecY * mag + (downBias ? mag * 0.5 : 0));

      // Hard glitch: random blocks get torn entirely (prev-frame with wild offset)
      const isGlitch = rnd() < glitch * 0.25;
      const glitchOffX = isGlitch ? Math.round((rnd() - 0.5) * W * 0.3) : 0;
      const glitchOffY = isGlitch ? Math.round((rnd() - 0.5) * H * 0.3) : 0;

      // Effective blend: burst modulates amount
      const effectiveAmount = mode === 'burst'
        ? amount * (0.1 + burstScale * 0.9)
        : amount;

      // Fill this block in out buffer
      const x0 = bc * bs, y0 = br * bs;
      const x1 = Math.min(x0 + bs, W);
      const y1 = Math.min(y0 + bs, H);

      for(let py = y0; py < y1; py++){
        for(let px = x0; px < x1; px++){
          const i = (py * W + px) * 4;

          // Sample prev frame at warped position
          const sx = clamp(px + mvx + glitchOffX, 0, W - 1);
          const sy = clamp(py + mvy + glitchOffY, 0, H - 1);
          const si = (sy * W + sx) * 4;

          const cr = src[i],   cg = src[i+1], cb = src[i+2];
          const pr = prev[si], pg = prev[si+1], pb = prev[si+2];

          if(isGlitch && glitch > 0){
            // Hard tear: just prev-frame pixel, no blend
            out[i]   = pr;
            out[i+1] = pg;
            out[i+2] = pb;
            out[i+3] = 255;
          } else {
            // Blend: current × (1-amount) + prev-warped × amount
            out[i]   = Math.round(cr * (1 - effectiveAmount) + pr * effectiveAmount);
            out[i+1] = Math.round(cg * (1 - effectiveAmount) + pg * effectiveAmount);
            out[i+2] = Math.round(cb * (1 - effectiveAmount) + pb * effectiveAmount);
            out[i+3] = 255;
          }
        }
      }
    }
  }

  // Accumulate prev frame: blend out → prevFrame with decay
  // decay=0 means prev accumulates indefinitely (maximum smear)
  // decay=100 means prev resets to source each frame (no echo)
  const decayToSrc = decay;
  const keepPrev   = 1 - decayToSrc;
  for(let i = 0; i < prev.length; i += 4){
    prev[i]   = Math.round(out[i]   * keepPrev + src[i]   * decayToSrc);
    prev[i+1] = Math.round(out[i+1] * keepPrev + src[i+1] * decayToSrc);
    prev[i+2] = Math.round(out[i+2] * keepPrev + src[i+2] * decayToSrc);
    prev[i+3] = 255;
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

  const sw = preprocessed.width, sh = preprocessed.height;
  srcBuf.width = sw; srcBuf.height = sh;
  if(params.showEffect && outImg){
    sctx.putImageData(outImg, 0, 0);
  } else {
    sctx.putImageData(preprocessed, 0, 0);
  }

  const aspect = sw / sh;
  let dw, dh;
  if(params.fit === 'cover'){
    if(W / H > aspect){ dw = W; dh = W / aspect; }
    else              { dh = H; dw = H * aspect; }
  } else {
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ---------- animation ----------
const CYCLE_MS = 15000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  // All modes: pass t01 + mode override into buildOutput
  // restore is a no-op since we use overrides, not param mutation
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseAmount    = params.amount;
  const baseBlockSize = params.blockSize;
  params.amount    = ax * 100;
  params.blockSize = Math.round(8 + ay * 56);  // 8..64
  return () => { params.amount = baseAmount; params.blockSize = baseBlockSize; };
}

function renderAt(t01){
  const restoreInt = applyInteractive();
  // Build with mode-specific overrides passed directly
  buildOutput({
    blockSize: params.blockSize,
    amount:    params.amount,
    decay:     params.decay,
    randomize: params.randomize,
    glitch:    params.glitch,
    mode:      params.mode,
    t01:       t01,
  });
  paint();
  restoreInt();
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
  if(!params.animate) schedule('build');
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else { buildOutput(); paint(); }
    return cv;
  },
};

const PRE_KEYS   = new Set(['fit','bg']);
const BUILD_KEYS = new Set(['blockSize','amount','decay','randomize','glitch']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('build'); }
      return;
    }
    if(key === 'mode'){
      if(!params.animate) schedule('build');
      return;
    }
    if(key === 'interactive'){
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
    else                         schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', handleMouseLeave);
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-datamosh',
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
