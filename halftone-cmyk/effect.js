// pixart/halftone-cmyk — real CMYK four-channel offset-print halftone.
//
// Decompose source into Cyan / Magenta / Yellow / Black plates (RGB→CMYK
// with GCR), render each plate as a halftone grid at its canonical screen
// angle, then composite the four plates multiplicatively on paper white.
//
// Canonical screen angles: C=15°, M=75°, Y=0°, K=45° (Adobe PostScript
// Language Reference §7.4). Round dots only.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const plateBuf = {
  c: document.createElement('canvas'),
  m: document.createElement('canvas'),
  y: document.createElement('canvas'),
  k: document.createElement('canvas'),
};
const plateCtx = {
  c: plateBuf.c.getContext('2d'),
  m: plateBuf.m.getContext('2d'),
  y: plateBuf.y.getContext('2d'),
  k: plateBuf.k.getContext('2d'),
};

const params = {
  cellSize:       12,
  cAngle:         15,
  mAngle:         75,
  yAngle:         0,
  kAngle:         45,
  cStrength:      1.0,
  mStrength:      1.0,
  yStrength:      1.0,
  kStrength:      1.0,
  gcr:            0.5,
  registerOffset: 1.5,
  paperWhite:     '#fefef8',
  animate:        false,
  mode:           'mist',
  interactive:    false,
  showEffect:     true,
  fit:            'cover',
  bg:             '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

const SRC_W = 600;

let gui;
let preprocessed = null;
let plateCov = { c: null, m: null, y: null, k: null };
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

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
    if(dirty.build) buildPlates();
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
  const W = SRC_W;
  const H = Math.max(1, Math.round(W * aspect));
  if(srcBuf.width !== W || srcBuf.height !== H){
    srcBuf.width = W; srcBuf.height = H;
    for(const k of ['c','m','y','k']){
      plateBuf[k].width = W; plateBuf[k].height = H;
    }
  }
  sctx.save();
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  sctx.restore();

  const id = sctx.getImageData(0, 0, W, H);
  const px = id.data;
  preprocessed = id;

  // RGB → CMYK with GCR.
  //   C' = 1 - R/255, M' = 1 - G/255, Y' = 1 - B/255
  //   K  = min(C', M', Y') * gcr
  //   C  = (C' - K) / (1 - K), and similarly M, Y
  const N = W * H;
  for(const ch of ['c','m','y','k']){
    if(!plateCov[ch] || plateCov[ch].length !== N) plateCov[ch] = new Float32Array(N);
  }
  const gcr = clamp(params.gcr, 0, 1);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    const r = px[i] / 255, gg = px[i+1] / 255, b = px[i+2] / 255;
    const cp = 1 - r, mp = 1 - gg, yp = 1 - b;
    const kRaw = Math.min(cp, mp, yp);
    const k = gcr * kRaw;
    const denom = 1 - k;
    let c, m, y;
    if(denom <= 1e-4){
      c = m = y = 0;
    } else {
      c = (cp - k) / denom;
      m = (mp - k) / denom;
      y = (yp - k) / denom;
    }
    plateCov.c[j] = clamp(c, 0, 1);
    plateCov.m[j] = clamp(m, 0, 1);
    plateCov.y[j] = clamp(y, 0, 1);
    plateCov.k[j] = clamp(k, 0, 1);
  }
}

function sampleCov(ch, x, y, W, H){
  let xi = Math.floor(x); if(xi < 0) xi = 0; else if(xi > W - 1) xi = W - 1;
  let yi = Math.floor(y); if(yi < 0) yi = 0; else if(yi > H - 1) yi = H - 1;
  return plateCov[ch][xi + yi * W];
}

function drawDot(c2d, sz, coverage){
  // Round only: area scales with coverage.
  const rad = Math.sqrt(coverage / Math.PI) * sz;
  c2d.beginPath();
  c2d.arc(0, 0, rad, 0, Math.PI * 2);
  c2d.fill();
}

const CHANNEL_INK = {
  c: '#00aeef',
  m: '#ec008c',
  y: '#fff200',
  k: '#1a1a1a',
};

function buildOnePlate(ch, angleDeg, strength){
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;
  const c2d = plateCtx[ch];
  c2d.save();
  c2d.clearRect(0, 0, W, H);
  if(strength <= 0.001){ c2d.restore(); return; }

  c2d.fillStyle = CHANNEL_INK[ch];

  const ang = angleDeg * Math.PI / 180;
  const cosR = Math.cos(ang), sinR = Math.sin(ang);
  const r = Math.abs(cosR) + Math.abs(sinR);
  const cell = Math.max(2, params.cellSize | 0);
  const diag = Math.sqrt(W * W + H * H);
  const halfW = W / 2, halfH = H / 2;
  const lines = Math.ceil(diag / cell) + 4;
  const remX = (W % cell) / 2, remY = (H % cell) / 2;
  const maxSide = cell / r;

  for(let i = -lines; i < lines; i++){
    for(let j = -lines; j < lines; j++){
      const gx = j * cell + remX - halfW;
      const gy = i * cell + remY - halfH;
      const wx = halfW + gx * cosR - gy * sinR;
      const wy = halfH + gx * sinR + gy * cosR;
      if(wx < -maxSide || wx > W + maxSide || wy < -maxSide || wy > H + maxSide) continue;

      const covRaw = sampleCov(ch, wx, wy, W, H);
      const cov = clamp(covRaw * strength, 0, 1);
      if(cov <= 0.005) continue;

      c2d.save();
      c2d.translate(wx, wy);
      c2d.rotate(ang);
      drawDot(c2d, maxSide, cov);
      c2d.restore();
    }
  }
  c2d.restore();
}

const PLATE_REG_DIR = {
  c: { dx:  1, dy:  0 },
  m: { dx:  0, dy:  1 },
  y: { dx: -1, dy:  0 },
  k: { dx:  0, dy: -1 },
};

function buildPlates(){
  if(!preprocessed) return;
  buildOnePlate('c', params.cAngle, params.cStrength);
  buildOnePlate('m', params.mAngle, params.mStrength);
  buildOnePlate('y', params.yAngle, params.yStrength);
  buildOnePlate('k', params.kAngle, params.kStrength);
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
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  if(!params.showEffect){
    ctx.drawImage(srcBuf, ox, oy, dw, dh);
    ctx.restore();
    return;
  }

  ctx.fillStyle = params.paperWhite;
  ctx.fillRect(ox, oy, dw, dh);

  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, dw, dh);
  ctx.clip();

  // Subtractive ink stack via multiply blending.
  ctx.globalCompositeOperation = 'multiply';

  const reg = params.registerOffset;
  for(const ch of ['y', 'm', 'c', 'k']){
    const dir = PLATE_REG_DIR[ch];
    const ddx = dir.dx * reg, ddy = dir.dy * reg;
    ctx.drawImage(plateBuf[ch], ox + ddx * scale, oy + ddy * scale, dw, dh);
  }
  ctx.restore();

  ctx.restore();
}

// ---------- animation ----------
//
// Modes (each = a gentle cosine envelope across cycleMs=15000):
//
//   mist    — registerOffset pingpongs ±default amplitude (plates drift in/out
//             of registration). Paint-only, ~free.
//   breath  — cellSize pingpongs 8 ↔ 18 (halftone screen grows/shrinks).
//             Triggers buildPlates each frame; still <30ms.
//   kPulse  — kStrength cosine 0.4 ↔ 1.4 (black plate intensifies/fades).
//
// Interactive: cursor X → cellSize (4..30), cursor Y → registerOffset (-8..8).
//
const CYCLE_MS = 20000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'mist'){
    const base = params.registerOffset;
    const amp = Math.max(2, Math.abs(base) || 3);
    params.registerOffset = amp * Math.cos(t01 * Math.PI * 2);
    return () => { params.registerOffset = base; };
  }
  if(mode === 'breath'){
    const base = params.cellSize;
    params.cellSize = 8 + 10 * pingPong(t01);
    return () => { params.cellSize = base; };
  }
  if(mode === 'kPulse'){
    const base = params.kStrength;
    params.kStrength = 0.9 + 0.5 * Math.cos(t01 * Math.PI * 2);
    return () => { params.kStrength = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseCell = params.cellSize;
  const baseReg  = params.registerOffset;
  params.cellSize = 4 + ax * 26;
  params.registerOffset = -8 + ay * 16;
  return () => { params.cellSize = baseCell; params.registerOffset = baseReg; };
}

function modeNeedsBuild(){
  return params.mode === 'breath' || params.mode === 'kPulse';
}

function renderAt(t01){
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  // Build only when modulating a build-key. Interactive always touches cellSize.
  const needsBuild = (params.animate && modeNeedsBuild()) || (params.interactive && hasMouse);
  if(needsBuild) buildPlates();
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

const PRE_KEYS   = new Set(['gcr','fit','bg']);
const BUILD_KEYS = new Set(['cellSize','cAngle','mAngle','yAngle','kAngle','cStrength','mStrength','yStrength','kStrength']);
const PAINT_KEYS = new Set(['registerOffset','paperWhite','showEffect']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('paint'); }
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
      canvas: cv, name: 'pixart-halftone-cmyk',
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
