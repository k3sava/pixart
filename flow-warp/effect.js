// pixart/flow-warp — fluid displacement warp that bends image pixels as if
// stirred in liquid, using a time-evolving trig-based noise field.
//
// Algorithm:
//   1. Preprocess: scale source to canvasSize × canvasSize.
//   2. For each output pixel (x, y), compute a displacement vector (dx, dy)
//      from a layered sine/cosine octave field (Perlin-approximation):
//        dx = Σ  sin(x*f + phaseX + t) + 0.5*sin(x*2f - phaseX + t*1.3)  / oct
//        dy = Σ  cos(y*f + phaseY + t) + 0.5*cos(y*2f - phaseY + t*0.7)  / oct
//   3. With colorBleed: R/G/B channels sample from slightly different offsets,
//      giving chromatic-aberration-style colour fringing.
//   4. Bilinear interpolate when sampling source to avoid pixel stepping.
//
// Modes (cosine envelope across cycleMs=20000):
//   flow    — phase_t advances at `speed`; default meditative liquid feel.
//   vortex  — adds radial rotation to the displacement field over time;
//              creates spiralling tornado vortex.
//   wave    — displacement magnitude pulsates in/out (breath-like).
//
// Interactive: cursor X → strength, cursor Y → scale.
//
// Key differences from other effects:
//   • flow-field: draws vector streaks. flow-warp warps SOURCE PIXELS.
//   • displace:   uses external luminance map. flow-warp uses internal noise.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const CANVAS_SIZE = 600;

const params = {
  // Core warp
  strength:    40,   // 0–100  displacement magnitude in px (at canvasSize)
  scale:       30,   // 0–100  warp feature size (low=big swirls, high=fine)
  speed:       30,   // 0–100  animation speed
  octaves:     2,    // 1–4    detail layers
  twist:       20,   // 0–100  rotational component
  colorBleed:  20,   // 0–100  chromatic aberration spread (px)
  // Animation
  animate:     false,
  mode:        'flow',   // flow | vortex | wave
  interactive: false,
  // Standard shared
  fit:         'cover',
  bg:          '#0a0a0a',
  showEffect:  true,
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;       // ImageData at CANVAS_SIZE × (CANVAS_SIZE * aspect)
let dirty = { pre: true, paint: true };
let rafQueued = false;

// ─── helpers ──────────────────────────────────────────────────────────────────
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

function schedule(level){
  if(level === 'pre') dirty.pre = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre) preprocess();
    paint(0);
    dirty.pre = dirty.paint = false;
  });
}

function fitCanvas(){
  const w = cv.clientWidth  || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ─── preprocess ───────────────────────────────────────────────────────────────
function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = (window.PIXSource?.height || srcCv.height) / (window.PIXSource?.width || srcCv.width);
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

// ─── bilinear sampler ─────────────────────────────────────────────────────────
// Returns [r, g, b] interpolated from the source ImageData at fractional (sx, sy).
function bilinear(data, W, H, sx, sy){
  const x0 = clamp(Math.floor(sx), 0, W - 1);
  const y0 = clamp(Math.floor(sy), 0, H - 1);
  const x1 = clamp(x0 + 1, 0, W - 1);
  const y1 = clamp(y0 + 1, 0, H - 1);
  const tx = sx - x0;
  const ty = sy - y0;
  const i00 = (y0 * W + x0) * 4;
  const i10 = (y0 * W + x1) * 4;
  const i01 = (y1 * W + x0) * 4;
  const i11 = (y1 * W + x1) * 4;
  const r = (data[i00]   * (1-tx) + data[i10]   * tx) * (1-ty)
          + (data[i01]   * (1-tx) + data[i11]   * tx) * ty;
  const g = (data[i00+1] * (1-tx) + data[i10+1] * tx) * (1-ty)
          + (data[i01+1] * (1-tx) + data[i11+1] * tx) * ty;
  const b = (data[i00+2] * (1-tx) + data[i10+2] * tx) * (1-ty)
          + (data[i01+2] * (1-tx) + data[i11+2] * tx) * ty;
  return [r, g, b];
}

// ─── warp field ───────────────────────────────────────────────────────────────
// Returns [dx, dy] displacement for pixel (px, py) at time t (seconds).
// Uses layered sine/cosine octaves as a Perlin approximation.
// cx, cy are the image centre for twist offset.
function warpField(px, py, cx, cy, t, freq, strength, octaves, twistAmt){
  let dx = 0, dy = 0;
  let amp = 1, ampSum = 0;
  let f = freq;
  // Layered trig octaves — each octave doubles the frequency, halves the amp.
  for(let o = 0; o < octaves; o++){
    const phaseShift = o * 1.618;  // golden-ratio phase offset per octave
    dx += amp * (Math.sin(px * f + phaseShift + t * 0.73)
              + 0.5 * Math.sin(px * 2 * f - phaseShift + t * 1.31));
    dy += amp * (Math.cos(py * f + phaseShift + t * 0.91)
              + 0.5 * Math.cos(py * 2 * f - phaseShift + t * 0.67));
    ampSum += amp * 1.5;  // max contribution from this octave
    amp *= 0.5;
    f   *= 2.0;
  }
  // Normalise to [-1, 1] range then scale by strength.
  dx = (dx / ampSum) * strength;
  dy = (dy / ampSum) * strength;

  // Twist: add a rotational component based on distance from centre.
  if(twistAmt > 0){
    const rx = px - cx;
    const ry = py - cy;
    const dist = Math.sqrt(rx * rx + ry * ry);
    const twistAngle = (twistAmt / 50) * (dist / (cx || 1)) * Math.sin(t * 0.5);
    const cos = Math.cos(twistAngle);
    const sin = Math.sin(twistAngle);
    const tdx = rx * cos - ry * sin - rx;
    const tdy = rx * sin + ry * cos - ry;
    dx += tdx * (twistAmt / 100);
    dy += tdy * (twistAmt / 100);
  }

  return [dx, dy];
}

// ─── paint ────────────────────────────────────────────────────────────────────
// t is time in seconds (0 for static render).
function paint(t){
  window.WAGUI?.flashValues(params);
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!preprocessed){ ctx.restore(); return; }

  const sw = preprocessed.width, sh = preprocessed.height;
  const src = preprocessed.data;

  if(!params.showEffect){
    const aspect = sw / sh;
    let dw, dh;
    if(W / H > aspect){ dh = H; dw = dh * aspect; }
    else              { dw = W; dh = dw / aspect; }
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  // Fit source rect inside canvas (90% of screen, centred).
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.9; dw = dh * aspect; }
  else              { dw = W * 0.9; dh = dw / aspect; }
  const ox = (W - dw) / 2;
  const oy = (H - dh) / 2;

  // Output resolution = displayed canvas region in pixel steps of 1.
  // We render directly into an ImageData at output size.
  const outW = Math.round(dw) | 0;
  const outH = Math.round(dh) | 0;
  if(outW <= 0 || outH <= 0){ ctx.restore(); return; }

  const output = ctx.createImageData(outW, outH);
  const outData = output.data;

  // Warp parameters.
  // scale: 0=big swirls (low freq), 100=fine texture (high freq).
  const freq      = (params.scale / 100) * 0.08 + 0.002;   // 0.002 – 0.082
  const strength  = params.strength * 0.8;                  // 0–80 px in source space
  const octaves   = clamp(params.octaves | 0, 1, 4);
  const twistAmt  = params.twist;
  const bleed     = (params.colorBleed / 100) * 6;          // 0–6 px channel offset
  const tSec      = t;

  const cx = sw / 2;
  const cy = sh / 2;

  for(let oy2 = 0; oy2 < outH; oy2++){
    for(let ox2 = 0; ox2 < outW; ox2++){

      // Map output pixel to source space.
      const sx = (ox2 / outW) * sw;
      const sy = (oy2 / outH) * sh;

      const [dx, dy] = warpField(sx, sy, cx, cy, tSec, freq, strength, octaves, twistAmt);

      let r, g, b;

      if(bleed > 0.5){
        // Chromatic aberration: R/G/B sampled from slightly offset positions.
        const [rr] = bilinear(src, sw, sh, sx + dx * 1.02 + bleed, sy + dy * 0.98);
        const [, gg] = bilinear(src, sw, sh, sx + dx,               sy + dy);
        const [, , bb] = bilinear(src, sw, sh, sx + dx * 0.98 - bleed, sy + dy * 1.02);
        r = rr; g = gg; b = bb;
      } else {
        [r, g, b] = bilinear(src, sw, sh, sx + dx, sy + dy);
      }

      const i = (oy2 * outW + ox2) * 4;
      outData[i]   = r;
      outData[i+1] = g;
      outData[i+2] = b;
      outData[i+3] = 255;
    }
  }

  ctx.putImageData(output, Math.round(ox), Math.round(oy));
  ctx.restore();
}

// ─── animation + interactive ──────────────────────────────────────────────────
const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01, tSec){
  const mode = params.mode;
  if(mode === 'vortex'){
    // Add a time-growing twist so the image slowly spirals.
    const base = params.twist;
    params.twist = 50 + 45 * Math.sin(t01 * Math.PI * 2);
    return () => { params.twist = base; };
  }
  if(mode === 'wave'){
    // Strength pulsates 0 ↔ full (breath-like).
    const base = params.strength;
    params.strength = base * pingPong(t01) * 2;
    return () => { params.strength = base; };
  }
  // 'flow' — default; no param mutation, time naturally advances.
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseStrength = params.strength;
  const baseScale    = params.scale;
  // X: strength 0 → 80. Y: scale 0 → 100.
  params.strength = ax * 80;
  params.scale    = ay * 100;
  return () => { params.strength = baseStrength; params.scale = baseScale; };
}

function renderAt(t01){
  const tSec = t01 * (CYCLE_MS / 1000) * (params.speed / 50);
  const restoreMode = params.animate ? applyMode(t01, tSec) : () => {};
  const restoreInt  = applyInteractive();
  // Compute tSec for warp field (affected by mode/interactive already resolved).
  const tFinal = t01 * (CYCLE_MS / 1000) * (params.speed / 50);
  paint(tFinal);
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

// ─── WAEffect contract ─────────────────────────────────────────────────────────
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else { paint(0); }
    return cv;
  },
};

// ─── init ──────────────────────────────────────────────────────────────────────
const PRE_KEYS = new Set(['fit', 'bg']);

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
    if(PRE_KEYS.has(key)) schedule('pre');
    else                  schedule('paint');
  });

  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => {
    hasMouse = false;
    if(!params.animate) schedule('paint');
  });

  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }

  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-flow-warp',
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
