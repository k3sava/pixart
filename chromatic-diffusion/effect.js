// pixart/chromatic-diffusion — soft, painterly chromatic aberration via
// per-channel blur + directional offset.
//
// Algorithm:
//   1. preprocess() — resample source to canvasSize × canvasSize ImageData.
//   2. buildOutput() — three-stage pipeline:
//        a. Extract R, G, B channel buffers (separate Float32 planes).
//        b. Apply a fast separable box-blur (3 passes ≈ Gaussian) to each
//           channel at different radii:  R → blurR, G → blurG, B → blurB.
//           radii are derived from `blur` param scaled by channel weights.
//        c. Optionally weight diffusion to edges (Sobel edge map × edgeMask).
//        d. Offset each channel by different amounts along `angle` ± `twist`.
//           R offsets in angle+twist/2, B in angle-twist/2 direction.
//           G stays near-centre (anchor channel).
//        e. Optional hueShift on R and B: rotate their hue by ±hueShift.
//        f. Recombine: R from shifted+blurred R channel, G from G channel,
//           B from shifted+blurred B channel. Additive composite.
//   3. paint() — scale output buffer onto the display canvas.
//
// Animation modes (WAEffect contract, cycleMs = 20000):
//   breathe  — spread oscillates 0 ↔ params.spread (channels merge/separate).
//   rotate   — angle continuously sweeps 0 → 360°.
//   prismatic— hueShift sweeps 0 → 100 in a rainbow loop.
//
// Interactive: cursor X → spread (0..100), cursor Y → angle (0..360).
//
// Defaults:  a subtle prism-diffusion visible on portrait.jpg without
// melting the face. sweep spread 0→100 to feel the full range.

'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Shared preprocessor knobs.
  canvasSize:   600,
  fit:          'cover',
  bg:           '#0a0a0a',
  // Effect params.
  spread:       20,       // 0–100 — channel separation distance in px
  blur:         30,       // 0–100 — per-channel blur softness
  angle:        30,       // 0–360 — direction of R↔B spread
  twist:        20,       // 0–100 — rotational offset between R and B
  edgeMask:     40,       // 0–100 — concentrate diffusion on detected edges
  hueShift:     15,       // 0–100 — prismatic hue rotation on R/B
  // Animation + display.
  animate:      false,
  mode:         'breathe',
  interactive:  false,
  showEffect:   true,
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;   // ImageData at canvasSize × canvasSize
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

function schedule(level){
  if(level === 'pre')   { dirty.pre = true; dirty.build = true; }
  if(level === 'build') { dirty.build = true; }
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
  const w = cv.clientWidth  || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ---------- preprocess ----------
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
  preprocessed = sctx.getImageData(0, 0, W, H);
}

// ---------- fast separable box-blur ----------
// Approximates Gaussian via 3 passes of horizontal+vertical box blur.
// Works on a Float32Array in-place. Clamps to edges (no wrap).
function boxBlurH(src, tmp, W, H, r){
  if(r < 1){ tmp.set(src); return; }
  const norm = 1 / (2 * r + 1);
  for(let y = 0; y < H; y++){
    const row = y * W;
    let sum = 0;
    // Seed: left edge clamped.
    for(let x = -r; x <= r; x++){
      sum += src[row + clamp(x, 0, W - 1)];
    }
    for(let x = 0; x < W; x++){
      tmp[row + x] = sum * norm;
      const xOut = clamp(x - r,     0, W - 1);
      const xIn  = clamp(x + r + 1, 0, W - 1);
      sum += src[row + xIn] - src[row + xOut];
    }
  }
}

function boxBlurV(src, tmp, W, H, r){
  if(r < 1){ tmp.set(src); return; }
  const norm = 1 / (2 * r + 1);
  for(let x = 0; x < W; x++){
    let sum = 0;
    for(let y = -r; y <= r; y++){
      sum += src[clamp(y, 0, H - 1) * W + x];
    }
    for(let y = 0; y < H; y++){
      tmp[y * W + x] = sum * norm;
      const yOut = clamp(y - r,     0, H - 1);
      const yIn  = clamp(y + r + 1, 0, H - 1);
      sum += src[yIn * W + x] - src[yOut * W + x];
    }
  }
}

function gaussianBlur(plane, W, H, r){
  if(r < 1) return;
  const tmp = new Float32Array(W * H);
  // 3 passes of box blur ≈ Gaussian.
  for(let pass = 0; pass < 3; pass++){
    boxBlurH(plane, tmp, W, H, r);
    boxBlurV(tmp, plane, W, H, r);
  }
}

// ---------- edge detection (Sobel, returns Float32Array 0..1) ----------
function sobelEdge(r, g, b, W, H){
  const edge = new Float32Array(W * H);
  const lum = new Float32Array(W * H);
  for(let i = 0; i < W * H; i++){
    lum[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
  }
  for(let y = 1; y < H - 1; y++){
    for(let x = 1; x < W - 1; x++){
      const i = y * W + x;
      const gx = (
        -lum[(y-1)*W+(x-1)] + lum[(y-1)*W+(x+1)]
        - 2*lum[y*W+(x-1)]  + 2*lum[y*W+(x+1)]
        - lum[(y+1)*W+(x-1)]+ lum[(y+1)*W+(x+1)]
      );
      const gy = (
        -lum[(y-1)*W+(x-1)] - 2*lum[(y-1)*W+x] - lum[(y-1)*W+(x+1)]
        + lum[(y+1)*W+(x-1)]+ 2*lum[(y+1)*W+x] + lum[(y+1)*W+(x+1)]
      );
      edge[i] = clamp(Math.sqrt(gx*gx + gy*gy) / 255, 0, 1);
    }
  }
  return edge;
}

// ---------- hue rotation in RGB space ----------
// Rotates hue by `deg` degrees using the matrix approach.
function rotateHue(rVal, gVal, bVal, deg){
  if(deg === 0) return [rVal, gVal, bVal];
  const rad = deg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const nr = clamp(
    rVal*(0.213+cos*0.787-sin*0.213) + gVal*(0.715-cos*0.715-sin*0.715) + bVal*(0.072-cos*0.072+sin*0.928),
    0, 255);
  const ng = clamp(
    rVal*(0.213-cos*0.213+sin*0.143) + gVal*(0.715+cos*0.285+sin*0.140) + bVal*(0.072-cos*0.072-sin*0.283),
    0, 255);
  const nb = clamp(
    rVal*(0.213-cos*0.213-sin*0.787) + gVal*(0.715-cos*0.715+sin*0.715) + bVal*(0.072+cos*0.928+sin*0.072),
    0, 255);
  return [nr, ng, nb];
}

// ---------- build ----------
function buildOutput(){
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;

  if(outBuf.width !== W || outBuf.height !== H){
    outBuf.width = W; outBuf.height = H;
  }

  const src = preprocessed.data;
  const N   = W * H;

  // Extract channels into float planes (0..255).
  const rPlane = new Float32Array(N);
  const gPlane = new Float32Array(N);
  const bPlane = new Float32Array(N);
  for(let i = 0, j = 0; i < src.length; i += 4, j++){
    rPlane[j] = src[i];
    gPlane[j] = src[i+1];
    bPlane[j] = src[i+2];
  }

  // Compute Sobel edge map (before blur).
  const edgeMaskStr = clamp(params.edgeMask, 0, 100) / 100;
  let edgeMap = null;
  if(edgeMaskStr > 0){
    edgeMap = sobelEdge(rPlane, gPlane, bPlane, W, H);
  }

  // Blur radii — R and B get more blur, G less (it is the anchor).
  const blurNorm = clamp(params.blur, 0, 100) / 100;
  const maxBlurPx = W * 0.04;   // max blur = 4% of width
  const blurR = Math.round(blurNorm * maxBlurPx * 1.3);
  const blurG = Math.round(blurNorm * maxBlurPx * 0.5);
  const blurB = Math.round(blurNorm * maxBlurPx * 1.3);

  gaussianBlur(rPlane, W, H, blurR);
  gaussianBlur(gPlane, W, H, blurG);
  gaussianBlur(bPlane, W, H, blurB);

  // If edgeMask is set, blend blurred back with original per pixel.
  // Pixels with low edge strength get LESS blur (close to original).
  if(edgeMaskStr > 0 && edgeMap){
    // Re-extract originals for blend.
    const r0 = new Float32Array(N);
    const g0 = new Float32Array(N);
    const b0 = new Float32Array(N);
    for(let i = 0, j = 0; i < src.length; i += 4, j++){
      r0[j] = src[i]; g0[j] = src[i+1]; b0[j] = src[i+2];
    }
    for(let j = 0; j < N; j++){
      const e = edgeMap[j];
      // blend factor: 1 on edges (full blur), 0 in flat regions (no blur).
      const k = clamp(e * 2, 0, 1) * edgeMaskStr;
      rPlane[j] = r0[j] * (1 - k) + rPlane[j] * k;
      gPlane[j] = g0[j] * (1 - k) + gPlane[j] * k;
      bPlane[j] = b0[j] * (1 - k) + bPlane[j] * k;
    }
  }

  // Channel offsets — spread pixels along angle±twist/2.
  const spreadPx  = clamp(params.spread, 0, 100) / 100 * (W * 0.06);
  const angleRad  = params.angle * Math.PI / 180;
  const twistDeg  = clamp(params.twist, 0, 100) / 100 * 45; // max 45° twist
  const rAngle    = angleRad + twistDeg * Math.PI / 180;
  const bAngle    = angleRad - twistDeg * Math.PI / 180;

  const rDx = Math.round(Math.cos(rAngle) * spreadPx);
  const rDy = Math.round(Math.sin(rAngle) * spreadPx);
  const bDx = Math.round(-Math.cos(bAngle) * spreadPx);
  const bDy = Math.round(-Math.sin(bAngle) * spreadPx);
  // G stays at origin (anchor).

  // Hue rotation amounts for R and B.
  const hueAmount = clamp(params.hueShift, 0, 100) / 100 * 30; // max 30°

  // Composite result: for each output pixel, sample R from rPlane at (-rDx,-rDy),
  // G from gPlane, B from bPlane at (-bDx,-bDy).
  const out = new ImageData(W, H);
  const od  = out.data;

  for(let y = 0; y < H; y++){
    for(let x = 0; x < W; x++){
      const j = y * W + x;

      // Sample R channel with offset.
      const rxs = clamp(x - rDx, 0, W - 1);
      const rys = clamp(y - rDy, 0, H - 1);
      let rVal = rPlane[rys * W + rxs];

      // Sample G channel (anchor, no offset).
      let gVal = gPlane[j];

      // Sample B channel with offset.
      const bxs = clamp(x - bDx, 0, W - 1);
      const bys = clamp(y - bDy, 0, H - 1);
      let bVal = bPlane[bys * W + bxs];

      // Hue shift on R channel (+hueAmount) and B (-hueAmount).
      if(hueAmount > 0){
        const [rr, rg, rb] = rotateHue(rVal, gVal, bVal, hueAmount);
        const [br, bg, bb] = rotateHue(rVal, gVal, bVal, -hueAmount);
        // Mix hue-shifted result back.
        rVal = rr; bVal = bb;
        // Subtle influence on G from both shifts.
        gVal = clamp((rg + bg) * 0.5, 0, 255);
      }

      od[j * 4]     = clamp(rVal, 0, 255);
      od[j * 4 + 1] = clamp(gVal, 0, 255);
      od[j * 4 + 2] = clamp(bVal, 0, 255);
      od[j * 4 + 3] = src[j * 4 + 3];
    }
  }

  octx.putImageData(out, 0, 0);
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

  if(!params.showEffect){
    const aspect = preprocessed.width / preprocessed.height;
    let dw, dh;
    if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
    else              { dw = W * 0.96; dh = dw / aspect; }
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  const imgW = outBuf.width, imgH = outBuf.height;
  if(imgW === 0 || imgH === 0){ ctx.restore(); return; }
  const aspect = imgW / imgH;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(outBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
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
  if(mode === 'breathe'){
    // spread oscillates 0 ↔ params.spread.
    const base = params.spread;
    const liveSpread = pingPong(t01) * base;
    params.spread = liveSpread;
    return () => { params.spread = base; };
  }
  if(mode === 'rotate'){
    // angle sweeps 0 → 360.
    const base = params.angle;
    params.angle = (t01 * 360) % 360;
    return () => { params.angle = base; };
  }
  if(mode === 'prismatic'){
    // hueShift sweeps the full 0→100 loop (rainbow shift).
    const base = params.hueShift;
    params.hueShift = pingPong(t01) * 100;
    return () => { params.hueShift = base; };
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

const PRE_KEYS   = new Set(['canvasSize','fit','bg']);
const BUILD_KEYS = new Set(['spread','blur','angle','twist','edgeMask','hueShift']);

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

  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv,
      name:   'pixart-chromatic-diffusion',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec:    document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
  if(params.animate) startAnimation();
}

document.addEventListener('DOMContentLoaded', init);
