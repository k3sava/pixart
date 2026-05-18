// pixart/kaleido-morph — Kaleidoscope with float-interpolated fold count.
//
// For each frame, the warp is computed at floor(N) and ceil(N) fold counts
// and the two results are blended by the fractional part of N. This creates
// a continuously morphing mandala rather than a discrete fold step.
//
// Warp algorithm is identical to kaleidoscope/effect.js: Brewster two-mirror
// polar fold, toroidal source sampling, optional mirroring of alternate slices.
//
// Animation modes:
//
//   morph — N sweeps 3 → 12 → 3 via cosine pingpong. The mandala smoothly
//           expands and contracts its petal count. The blended cross-fade makes
//           the transition continuous rather than a sudden jump.
//   spin  — Continuous angleOffset rotation (0 → 2π). Uses params.segments as
//           the fixed (possibly fractional) fold count. No morphing.
//   bloom — zoom breathes 0.8 ↔ 1.8 while N floats between minFolds and
//           maxFolds at double the cycle frequency. Two independent rhythms.
//
// Interactive: X → _currentMorphN (2..14), Y → zoom (0.3..3).
// Metaphor: cursor chooses the fold count and depth simultaneously.
//
// Tested defaults:
//   segments=6   — 6 folds is a classic hexagonal mandala, clear morphing.
//   zoom=1.2     — slightly magnified; hides the raw source boundary.
//   mirror=true  — continuous seams essential for smooth morph cross-fade.
//   minFolds=3, maxFolds=12 — full range; morph mode sweeps the whole span.
'use strict';

const CYCLE_MS = 20000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });
const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d');

const params = {
  canvasSize:  600,
  blur:        0,
  grain:       0,
  gamma:       1,
  blackPoint:  0,
  whitePoint:  255,
  // Kaleido-morph-specific.
  segments:    6.0,
  zoom:        1.2,
  sampleX:     0,
  sampleY:     0,
  mirror:      true,
  minFolds:    3,
  maxFolds:    12,
  // Animation + interactive.
  animate:     false,
  mode:        'morph',
  interactive: false,
  showEffect:  true,
  // Shared chrome.
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui, preprocessed = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// Module-level animated state.
let _currentMorphN = params.segments;
let _angleOffset   = 0;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

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
  if(cv.width !== w)  cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ── preprocessor ──────────────────────────────────────────────
function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = (window.PIXSource?.height || srcCv.height) / (window.PIXSource?.width || srcCv.width);
  const W = params.canvasSize;
  const H = Math.max(1, Math.round(W * aspect));
  if(srcBuf.width !== W || srcBuf.height !== H){
    srcBuf.width = W; srcBuf.height = H;
    outBuf.width = W; outBuf.height = H;
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
  const g = params.grain, gm = params.gamma, bp = params.blackPoint, wp = params.whitePoint;
  const span = Math.max(1, wp - bp);
  const scale = 255 / span;
  const doGrain = g !== 0, doGamma = gm !== 1, doLevels = bp !== 0 || wp !== 255;
  let lut = null;
  if(doGamma){ lut = new Uint8ClampedArray(256); for(let i=0;i<256;i++) lut[i]=Math.round(255*Math.pow(i/255,gm)); }
  for(let i = 0; i < px.length; i += 4){
    let r = px[i], gg = px[i+1], b = px[i+2];
    if(doGrain){ const n=(0.5-Math.random())*g*255; r=clamp(r+n,0,255); gg=clamp(gg+n,0,255); b=clamp(b+n,0,255); }
    if(doGamma){ r=lut[r|0]; gg=lut[gg|0]; b=lut[b|0]; }
    if(doLevels){ r=clamp((r-bp)*scale,0,255); gg=clamp((gg-bp)*scale,0,255); b=clamp((b-bp)*scale,0,255); }
    px[i]=r; px[i+1]=gg; px[i+2]=b;
  }
  sctx.putImageData(id, 0, 0);
  preprocessed = id;
}

// ── warpKaleidoscope: N-fold polar warp into outData ─────────
function warpKaleidoscope(N, angleOffset, zoom, sampleX, sampleY, outData){
  const src = preprocessed.data;
  const W = preprocessed.width, H = preprocessed.height;
  const wedge = (Math.PI * 2) / N;
  const cx = W * 0.5, cy = H * 0.5;
  const ox = cx + sampleX * cx;
  const oy = cy + sampleY * cy;
  const invZ = 1 / Math.max(0.01, zoom);
  const TAU = Math.PI * 2;
  const mirror = params.mirror;

  for(let y = 0; y < H; y++){
    const dy0 = y - cy;
    for(let x = 0; x < W; x++){
      const dx0 = x - cx;
      const r = Math.hypot(dx0, dy0) * invZ;
      let a = ((Math.atan2(dy0, dx0) % TAU) + TAU) % TAU;
      const slice = Math.floor(a / wedge);
      a -= slice * wedge;
      if(mirror && (slice & 1)) a = wedge - a;
      const th = a + angleOffset;
      const sx = ox + r * Math.cos(th);
      const sy = oy + r * Math.sin(th);
      const ix = ((sx | 0) % W + W) % W;
      const iy = ((sy | 0) % H + H) % H;
      const si = (ix + iy * W) * 4;
      const oi = (x + y * W) * 4;
      outData[oi]   = src[si];
      outData[oi+1] = src[si+1];
      outData[oi+2] = src[si+2];
      outData[oi+3] = 255;
    }
  }
}

// ── buildOutput: blend floor(N) and ceil(N) warps ─────────────
function buildOutput(){
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;
  if(outBuf.width !== W || outBuf.height !== H){
    outBuf.width = W; outBuf.height = H;
  }

  const morphN = clamp(_currentMorphN, 2.0, 14.0);
  const loN = Math.max(2, Math.floor(morphN));
  const hiN = Math.ceil(morphN);
  const frac = morphN - loN;

  const imgLo = octx.createImageData(W, H);
  warpKaleidoscope(loN, _angleOffset, params.zoom, params.sampleX, params.sampleY, imgLo.data);

  if(frac < 0.001){
    octx.putImageData(imgLo, 0, 0);
    return;
  }

  const imgHi = octx.createImageData(W, H);
  warpKaleidoscope(hiN, _angleOffset, params.zoom, params.sampleX, params.sampleY, imgHi.data);

  // Blend: lo * (1-frac) + hi * frac.
  const loD = imgLo.data, hiD = imgHi.data;
  const out = octx.createImageData(W, H);
  const outD = out.data;
  const inv = 1 - frac;
  for(let i = 0; i < loD.length; i += 4){
    outD[i]   = loD[i]   * inv + hiD[i]   * frac;
    outD[i+1] = loD[i+1] * inv + hiD[i+1] * frac;
    outD[i+2] = loD[i+2] * inv + hiD[i+2] * frac;
    outD[i+3] = 255;
  }
  octx.putImageData(out, 0, 0);
}

// ── paint ─────────────────────────────────────────────────────
function paint(){
  window.WAGUI?.flashValues(params);
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);
  if(!preprocessed){ ctx.restore(); return; }

  const surface = params.showEffect ? outBuf : srcBuf;
  const aspect = surface.width / surface.height;
  let dw, dh;
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(surface, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ── animation + interactive ───────────────────────────────────
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const baseMorphN = _currentMorphN;
  const baseAngle  = _angleOffset;
  const baseZoom   = params.zoom;

  if(params.mode === 'morph'){
    // N sweeps 3 → 12 → 3 via pingpong.
    _currentMorphN = 3 + 9 * pingPong(t01);
  } else if(params.mode === 'spin'){
    // Continuous rotation, fixed fold count.
    _angleOffset = t01 * Math.PI * 2;
    _currentMorphN = params.segments;
  } else { // bloom
    // Zoom breathes; N floats between minFolds and maxFolds at 2× frequency.
    params.zoom = 0.8 + 1.0 * pingPong(t01);
    const t2 = (t01 * 2) % 1;
    _currentMorphN = params.minFolds + (params.maxFolds - params.minFolds) * pingPong(t2);
  }

  return () => {
    _currentMorphN = baseMorphN;
    _angleOffset   = baseAngle;
    params.zoom    = baseZoom;
  };
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const rect = cv.getBoundingClientRect();
  const ax = clamp(mouseX / rect.width,  0, 1);
  const ay = clamp(mouseY / rect.height, 0, 1);
  const baseN    = _currentMorphN;
  const baseZoom = params.zoom;
  _currentMorphN = 2 + ax * 12;      // 2..14
  params.zoom    = 0.3 + ay * 2.7;   // 0.3..3
  return () => { _currentMorphN = baseN; params.zoom = baseZoom; };
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

// ── WAEffect contract ─────────────────────────────────────────
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else { schedule('build'); }
    return cv;
  },
};

const PRE_KEYS = new Set(['canvasSize','blur','grain','gamma','blackPoint','whitePoint','fit','bg']);

function init(){
  _currentMorphN = params.segments;

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
    if(key === 'segments'){
      _currentMorphN = params.segments;
      if(!params.animate) schedule('build');
      return;
    }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(params.animate) return;
    if(PRE_KEYS.has(key)) schedule('pre');
    else                  schedule('build');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('build'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-kaleido-morph',
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
