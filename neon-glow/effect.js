// pixart/neon-glow — Sobel edge detection with neon color glow and CSS blur composite.
//
// Algorithm:
//   1. Preprocess: resize, blur, grain (shared pipeline).
//   2. Sobel edge detection — produces an edge-magnitude map (0..1 per pixel).
//   3. Build output: dark background (original * background param) + neon edge overlay.
//   4. Paint: draw edge canvas, then draw it again with CSS blur + screen composite
//      for the glow spread. Optional chromatic shift draws offset R/B layers.
//
// Animation modes (cycleMs = 20000):
//   color-spin — hue of glowColor rotates 0→360° continuously.
//   pulse      — glowRadius breathes 2↔20 using cosine.
//   scan       — bright horizontal line sweeps top-to-bottom.
//
// Interactive:
//   Mouse X → glowColor hue (0..360).
//   Mouse Y → glowRadius (2..20). Top = crisp lines, bottom = wide glow.
//
// Credit: inspired by neon glow photography and blacklight art.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (shared with every other effect).
  canvasSize:    600,
  blur:          0,
  grain:         0,
  gamma:         1,
  blackPoint:    0,
  whitePoint:    255,
  // Neon-glow specific.
  glowColor:     '#00ffcc',
  glowRadius:    8,
  edgeThreshold: 30,
  edgeStrength:  0.9,
  chromatic:     4,
  background:    0.1,
  showEffect:    true,
  // Animation / interactive.
  animate:       false,
  mode:          'color-spin',
  interactive:   false,
  // Shared chrome.
  fit:           'cover',
  bg:            '#000000',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let outImg       = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

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

// ---------- colour helpers ----------
function hexToRgb(hex){
  const h = String(hex || '').replace('#','');
  const v = (h.length === 3)
    ? h.split('').map(c => c + c).join('')
    : h.padEnd(6, '0');
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if(max !== min){
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch(max){
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l){
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
function rgbToHex(r, g, b){
  return '#' + [r, g, b].map(v => clamp(v | 0, 0, 255).toString(16).padStart(2, '0')).join('');
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
  const g   = params.grain;
  const rnd = Math.random;
  if(g !== 0){
    for(let i = 0; i < px.length; i += 4){
      const n = (0.5 - rnd()) * g * 255;
      px[i]   = clamp(px[i]   + n, 0, 255);
      px[i+1] = clamp(px[i+1] + n, 0, 255);
      px[i+2] = clamp(px[i+2] + n, 0, 255);
    }
  }
  sctx.putImageData(id, 0, 0);
  preprocessed = id;
}

// ---------- build (Sobel edge detection + neon overlay) ----------
function buildOutput(){
  if(!preprocessed){ outImg = null; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const data = preprocessed.data;

  // Step 1: Sobel edge magnitude (per pixel, 0..1).
  const edges = new Float32Array(W * H);
  for(let y = 1; y < H - 1; y++){
    for(let x = 1; x < W - 1; x++){
      const lum = (dx, dy) => {
        const idx = ((y + dy) * W + (x + dx)) * 4;
        return (data[idx] * 0.299 + data[idx+1] * 0.587 + data[idx+2] * 0.114) / 255;
      };
      const gx = -lum(-1,-1) - 2*lum(-1,0) - lum(-1,1) + lum(1,-1) + 2*lum(1,0) + lum(1,1);
      const gy = -lum(-1,-1) - 2*lum(0,-1) - lum(1,-1) + lum(-1,1) + 2*lum(0,1) + lum(1,1);
      edges[y * W + x] = Math.sqrt(gx*gx + gy*gy);
    }
  }

  // Step 2: Compose output — dark background + neon edges.
  const [nr, ng, nb] = hexToRgb(params.glowColor);
  const out = new Uint8ClampedArray(W * H * 4);
  const threshold = params.edgeThreshold / 100;
  const str = params.edgeStrength;
  const bgAmt = params.background;

  for(let i = 0; i < W * H; i++){
    const edgeMag = Math.min(1, edges[i]);
    const isEdge = edgeMag > threshold ? (edgeMag - threshold) / (1 - threshold) : 0;
    const p4 = i * 4;

    const origR = data[p4]   * bgAmt;
    const origG = data[p4+1] * bgAmt;
    const origB = data[p4+2] * bgAmt;

    const neonAmt = isEdge * str;
    out[p4]   = Math.round(Math.min(255, origR + nr * neonAmt));
    out[p4+1] = Math.round(Math.min(255, origG + ng * neonAmt));
    out[p4+2] = Math.round(Math.min(255, origB + nb * neonAmt));
    out[p4+3] = data[p4+3];
  }

  outImg = new ImageData(out, W, H);
}

// ---------- drawScaled helper ----------
function drawScaled(targetCtx, srcCanvas, fit){
  const dw = targetCtx.canvas.width, dh = targetCtx.canvas.height;
  const sw = srcCanvas.width, sh = srcCanvas.height;
  if(fit === 'cover'){
    const scale = Math.max(dw/sw, dh/sh);
    const ox = (dw - sw * scale) / 2;
    const oy = (dh - sh * scale) / 2;
    targetCtx.drawImage(srcCanvas, ox, oy, sw * scale, sh * scale);
  } else {
    const scale = Math.min(dw/sw, dh/sh);
    const ox = (dw - sw * scale) / 2;
    const oy = (dh - sh * scale) / 2;
    targetCtx.drawImage(srcCanvas, ox, oy, sw * scale, sh * scale);
  }
}

// ---------- scan line overlay (drawn on top during paint) ----------
// scanPhase is 0..1, updated each animation frame.
let scanPhase = 0;

function drawScanLine(scanlineY){
  // A semi-transparent bright horizontal band
  const [nr, ng, nb] = hexToRgb(params.glowColor);
  const grd = ctx.createLinearGradient(0, scanlineY - 8, 0, scanlineY + 8);
  grd.addColorStop(0,   `rgba(${nr},${ng},${nb},0)`);
  grd.addColorStop(0.5, `rgba(${nr},${ng},${nb},0.55)`);
  grd.addColorStop(1,   `rgba(${nr},${ng},${nb},0)`);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = grd;
  ctx.fillRect(0, scanlineY - 8, cv.width, 16);
  ctx.restore();
}

// ---------- paint ----------
function paint(){
  window.WAGUI?.flashValues(params);
  fitCanvas();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, cv.width, cv.height);

  if(!preprocessed){ ctx.restore(); return; }

  if(!params.showEffect){
    // Show original source
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    drawScaled(ctx, srcBuf, params.fit);
    ctx.restore();
    return;
  }

  if(!outImg){ ctx.restore(); return; }

  // Build an offscreen edge canvas at the native output resolution.
  const edgeCanvas = document.createElement('canvas');
  edgeCanvas.width  = outImg.width;
  edgeCanvas.height = outImg.height;
  edgeCanvas.getContext('2d').putImageData(outImg, 0, 0);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Layer 1: sharp base (dark bg + raw edge lines).
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  drawScaled(ctx, edgeCanvas, params.fit);

  // Layer 2: blurred glow (screen composite = additive light).
  if(params.glowRadius > 0){
    ctx.save();
    ctx.filter = `blur(${params.glowRadius}px)`;
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 1;
    drawScaled(ctx, edgeCanvas, params.fit);
    ctx.restore();
  }

  // Layer 3: chromatic aberration — offset R-bleed left, B-bleed right.
  if(params.chromatic > 0){
    const shift = params.chromatic;
    const blurR = Math.max(1, params.glowRadius * 0.7);

    // R bleed left
    ctx.save();
    ctx.filter = `blur(${blurR}px)`;
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.45;
    ctx.translate(-shift, 0);
    drawScaled(ctx, edgeCanvas, params.fit);
    ctx.restore();

    // B bleed right
    ctx.save();
    ctx.filter = `blur(${blurR}px)`;
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.45;
    ctx.translate(shift, 0);
    drawScaled(ctx, edgeCanvas, params.fit);
    ctx.restore();
  }

  // Layer 4: scan line (only during scan animation mode).
  if(params.animate && params.mode === 'scan'){
    drawScanLine(scanPhase * cv.height);
  }

  ctx.restore();
}

// ---------- animation ----------
const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

// Animated parameter snapshots — used to restore after renderAt.
let animGlowColor  = null;  // override hex string, or null = use params
let animGlowRadius = null;  // override number, or null

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'color-spin'){
    // Rotate hue of glowColor by t01*360.
    const [r, g, b] = hexToRgb(params.glowColor);
    const [h, s, l] = rgbToHsl(r, g, b);
    const newH = (h + t01 * 360) % 360;
    const [nr, ng, nb] = hslToRgb(newH, Math.max(0.7, s), Math.max(0.5, l));
    const savedColor = params.glowColor;
    params.glowColor = rgbToHex(nr, ng, nb);
    return () => { params.glowColor = savedColor; };
  }
  if(mode === 'pulse'){
    // glowRadius breathes 2↔20.
    const saved = params.glowRadius;
    params.glowRadius = 2 + 18 * pingPong(t01);
    return () => { params.glowRadius = saved; };
  }
  if(mode === 'scan'){
    // scanPhase drives the visible scan line in paint(); no param change needed.
    scanPhase = t01;
    return () => {};
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);

  // X → hue (0..360), Y → glowRadius (2..20).
  const savedColor  = params.glowColor;
  const savedRadius = params.glowRadius;
  const [cr, cg, cb] = hexToRgb(params.glowColor);
  const [, s, l] = rgbToHsl(cr, cg, cb);
  const newHue = ax * 360;
  const [nr, ng, nb] = hslToRgb(newHue, Math.max(0.7, s), Math.max(0.5, l));
  params.glowColor   = rgbToHex(nr, ng, nb);
  params.glowRadius  = 2 + ay * 18;

  return () => {
    params.glowColor  = savedColor;
    params.glowRadius = savedRadius;
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

// Pipeline key sets.
const PRE_KEYS   = new Set(['canvasSize','blur','grain','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['glowColor','edgeThreshold','edgeStrength','background']);
const PAINT_KEYS = new Set(['glowRadius','chromatic','showEffect']);

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
    if(key === 'fit'){
      window.PIXSource?.setParam('fit', params.fit);
      schedule('pre');
      return;
    }
    if(key === 'bg'){
      schedule('paint');
      return;
    }
    if(params.animate) return; // animation loop owns the canvas
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else if(PAINT_KEYS.has(key)) schedule('paint');
    else                         schedule('build');
  });

  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });

  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-neon-glow',
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
