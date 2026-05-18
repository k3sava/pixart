// pixart/cloth — waving-flag / cloth simulation.
//
// Algorithm:
//   1. Preprocess: scale source to CANVAS_SIZE × (CANVAS_SIZE * aspect).
//   2. For each output pixel, compute a 2-D wave displacement:
//        dx = amplitude * sin(y * freq + phase_x + t)        — horizontal ripple from vertical waves
//        dy = amplitude * sin(x * freq * aspect + phase_y + t * 1.2)  — vertical ripple
//      Up to 3 overlapping wave layers (each rotated 45° from the previous, at
//      half amplitude) for more complex cloth motion.
//   3. Bilinear-sample the preprocessed image at (sx + dx, sy + dy).
//   4. Lighting: approximate the surface normal from the warp gradient (finite
//      differences of dx/dy), then dot it with the light direction to produce a
//      diffuse shading term that is blended on top of the sampled colour.
//
// Modes (cosine envelope across cycleMs=20000):
//   wave    — classic horizontal ripple, flag in the wind.
//   ripple  — circular ripples from image centre (dropped stone in water).
//   billow  — slow large-scale billowing, heavy cloth.
//
// Interactive: cursor X → amplitude, cursor Y → frequency.
//
// WAEffect contract: { cycleMs, renderAt(t_loop), pauseRender(), resumeRender() }.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const CANVAS_SIZE = 600;

const params = {
  // Cloth controls
  amplitude:  30,   // 0–100  wave height (px at canvasSize)
  frequency:  25,   // 0–100  wave tightness
  speed:      40,   // 0–100  animation speed
  shading:    60,   // 0–100  strength of 3-D lighting overlay
  lightAngle: 45,   // 0–360  direction of light source (degrees)
  waves:       2,   // 1–3    number of overlapping wave patterns
  // Animation
  animate:    false,
  mode:       'wave',   // wave | ripple | billow
  interactive: false,
  // Standard shared
  fit:        'cover',
  bg:         '#0a0a0a',
  showEffect:  true,
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;   // ImageData at CANVAS_SIZE × (CANVAS_SIZE * aspect)
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

// ─── wave displacement ────────────────────────────────────────────────────────
// Returns [dx, dy] for a single wave layer at angle `rotRad`.
// The wave pattern is computed in a rotated coordinate frame so multiple layers
// can be at different orientations for complex cloth motion.
function waveLayer(sx, sy, amp, freq, tSec, phase_x, phase_y, rotRad, mode, cx, cy){
  // Rotate the sampling position for angled wave layers.
  const cos = Math.cos(rotRad);
  const sin = Math.sin(rotRad);
  const rx = sx * cos + sy * sin;
  const ry = -sx * sin + sy * cos;

  let dx, dy;

  if(mode === 'ripple'){
    // Circular ripple from image centre.
    const dCx = sx - cx;
    const dCy = sy - cy;
    const dist = Math.sqrt(dCx * dCx + dCy * dCy) + 0.001;
    const wave = amp * Math.sin(dist * freq + tSec);
    dx = wave * (dCx / dist);
    dy = wave * (dCy / dist);
  } else if(mode === 'billow'){
    // Slow large-scale billow — low-frequency, composite wave.
    dx = amp * Math.sin(ry * freq * 0.4 + phase_x + tSec * 0.7)
       + amp * 0.4 * Math.sin(ry * freq * 0.8 + phase_x * 1.5 + tSec * 0.9);
    dy = amp * 0.5 * Math.sin(rx * freq * 0.3 + phase_y + tSec * 0.8)
       + amp * 0.25 * Math.sin(rx * freq * 0.6 + phase_y * 1.3 + tSec * 1.0);
  } else {
    // 'wave' — classic flag ripple.
    // Primary: horizontal undulation driven by vertical position.
    dx = amp * Math.sin(ry * freq + phase_x + tSec);
    // Secondary: slight vertical flutter driven by horizontal position.
    dy = amp * 0.35 * Math.sin(rx * freq + phase_y + tSec * 1.2);
  }

  // Rotate displacement back into image space.
  return [
    dx * cos - dy * sin,
    dx * sin + dy * cos,
  ];
}

// Compute total warp displacement for pixel (sx, sy) at time tSec.
function clothWarp(sx, sy, cx, cy, tSec, amp, freq, numWaves, mode){
  let tdx = 0, tdy = 0;
  const ampFalloff = 1.0;  // first wave at full amp
  for(let w = 0; w < numWaves; w++){
    const rotRad = (w * Math.PI) / 4;   // 0°, 45°, 90° …
    const wAmp   = amp * (w === 0 ? 1.0 : 0.45 / w);  // each extra wave at ~45% amp
    const [dx, dy] = waveLayer(sx, sy, wAmp, freq, tSec,
                                /* phase_x */ w * 1.2,
                                /* phase_y */ w * 2.1,
                                rotRad, mode, cx, cy);
    tdx += dx;
    tdy += dy;
  }
  return [tdx, tdy];
}

// Approximate surface normal from finite-difference gradient of warp.
// Returns a unit normal (nx, ny, nz) pointing roughly toward the viewer.
function surfaceNormal(sx, sy, cx, cy, tSec, amp, freq, numWaves, mode){
  const eps = 1.0;
  const [dx0, dy0] = clothWarp(sx,       sy,       cx, cy, tSec, amp, freq, numWaves, mode);
  const [dxR, dyR] = clothWarp(sx + eps, sy,       cx, cy, tSec, amp, freq, numWaves, mode);
  const [dxD, dyD] = clothWarp(sx,       sy + eps, cx, cy, tSec, amp, freq, numWaves, mode);

  // Tangent vectors in the warped surface.
  const tx = eps + (dxR - dx0), ty = 0,           tz = dyR - dy0;
  const bx = 0,                 by = eps + (dyD - dy0), bz = dxD - dx0;

  // Normal = cross(T, B).
  let nx = ty * bz - tz * by;
  let ny = tz * bx - tx * bz;
  let nz = tx * by - ty * bx;
  const len = Math.sqrt(nx*nx + ny*ny + nz*nz) + 0.001;
  return [nx/len, ny/len, nz/len];
}

// ─── paint ────────────────────────────────────────────────────────────────────
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

  const outW = Math.round(dw) | 0;
  const outH = Math.round(dh) | 0;
  if(outW <= 0 || outH <= 0){ ctx.restore(); return; }

  const output = ctx.createImageData(outW, outH);
  const outData = output.data;

  // Map params → useful numbers.
  // Amplitude: 0–100 → 0–60 px in source space.
  const amp    = (params.amplitude / 100) * 60;
  // Frequency: 0–100 → 0.004–0.08 cycles/px (tighter waves at higher values).
  const freq   = 0.004 + (params.frequency / 100) * 0.076;
  const numWaves = clamp(params.waves | 0, 1, 3);
  const shading  = params.shading / 100;        // 0–1
  const mode     = params.mode;
  const tSec     = t;

  // Light direction from angle (XY plane; z=0.6 always faces viewer).
  const lRad = (params.lightAngle * Math.PI) / 180;
  const lx   = Math.cos(lRad);
  const ly   = Math.sin(lRad);
  const lz   = 0.6;
  const lLen = Math.sqrt(lx*lx + ly*ly + lz*lz);
  const nlx  = lx / lLen, nly = ly / lLen, nlz = lz / lLen;

  const cx = sw / 2;
  const cy = sh / 2;

  for(let oy2 = 0; oy2 < outH; oy2++){
    for(let ox2 = 0; ox2 < outW; ox2++){
      // Map output pixel → source space.
      const sx = (ox2 / outW) * sw;
      const sy = (oy2 / outH) * sh;

      const [dx, dy] = clothWarp(sx, sy, cx, cy, tSec, amp, freq, numWaves, mode);

      // Sample warped source colour.
      const [r, g, b] = bilinear(src, sw, sh, sx + dx, sy + dy);

      // Diffuse lighting: dot(normal, light).
      let shade = 1.0;
      if(shading > 0.01){
        const [nx, ny, nz] = surfaceNormal(sx, sy, cx, cy, tSec, amp, freq, numWaves, mode);
        const dot = nx * nlx + ny * nly + nz * nlz;
        // Remap dot into a pleasant shading range: 0.35 (shadow) .. 1.35 (highlight).
        shade = 1.0 + shading * (dot - 0.5) * 0.7;
        shade = clamp(shade, 0.2, 1.6);
      }

      const i = (oy2 * outW + ox2) * 4;
      outData[i]   = clamp(r * shade, 0, 255);
      outData[i+1] = clamp(g * shade, 0, 255);
      outData[i+2] = clamp(b * shade, 0, 255);
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

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'billow'){
    // Slow billow: amplitude gently swells and contracts over the cycle.
    const base = params.amplitude;
    params.amplitude = base * (0.6 + 0.4 * pingPong(t01));
    return () => { params.amplitude = base; };
  }
  if(mode === 'ripple'){
    // Ripple: frequency pulsates slightly for a more organic feel.
    const base = params.frequency;
    params.frequency = base * (0.8 + 0.4 * pingPong(t01));
    return () => { params.frequency = base; };
  }
  // 'wave' — default; time advances naturally.
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseAmp   = params.amplitude;
  const baseFreq  = params.frequency;
  // X: amplitude 0..100. Y: frequency 0..100.
  params.amplitude  = ax * 100;
  params.frequency  = ay * 100;
  return () => { params.amplitude = baseAmp; params.frequency = baseFreq; };
}

function renderAt(t01){
  // Advance time; speed 50 = 1× real time over the 20 s loop.
  const tSec = t01 * (CYCLE_MS / 1000) * (params.speed / 50);
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  paint(tSec);
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
      canvas: cv, name: 'pixart-cloth',
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
