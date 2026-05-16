// pixart/crosshatch — pen-and-ink hatch lines whose density tracks luminance.
//
// Up to 4 hatch layers, each at a fixed angle (0°, 45°, 90°, 135°). For each
// layer, a parallel ruling of lines spans the canvas at `spacing` pixels
// apart. Each line is sampled at intervals (≈spacing) along its length; at
// each sample, if source luminance falls below that layer's activation
// threshold, a short ink stroke is drawn through the point.
//
// Darker source pixels survive more layer thresholds → cross-hatch builds
// up tone naturally. Lighter pixels are blank paper.
//
// Modes (cosine envelope across cycleMs=20000):
//   scribble — every layer's angle drifts ±0.25 rad in a phase-shifted sine.
//              Lines wobble; the drawing looks alive.
//   tone     — global luminance bias drifts ±40, so the whole drawing
//              fades from sparse strokes to dense cross-hatch.
//   march    — each line is offset along its own normal by sin(2π t) ·
//              spacing. Rulings march sideways within their layer.
//
// Interactive: cursor X → spacing (5..14), cursor Y → layers (1..4).
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  canvasSize:  600,
  layers:      3,
  spacing:     8,
  lineLength:  14,
  lineWidth:   1.2,
  ditherLevel: 0.4,
  animate:     false,
  mode:        'scribble',
  interactive: false,
  showEffect:  true,
  fit:         'cover',
  bg:          '#f4ead4',
  ink:         '#1a140d',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let lumGrid = null;
let dirty = { pre: true, paint: true };
let rafQueued = false;

const ANGLES = [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4];

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

function schedule(level){
  if(level === 'pre') dirty.pre = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre) preprocess();
    paint();
    dirty.pre = dirty.paint = false;
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
  if(srcBuf.width !== W || srcBuf.height !== H){ srcBuf.width = W; srcBuf.height = H; }
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  preprocessed = sctx.getImageData(0, 0, W, H);

  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  const px = preprocessed.data;
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    lumGrid[j] = 0.299 * px[i] + 0.587 * px[i+1] + 0.114 * px[i+2];
  }
}

// Paint-time modulation state.
let _scribblePhase = 0; // adds to per-layer angle
let _toneBias = 0;      // adds to luminance comparator (positive = darker → more lines)
let _marchOffset = 0;   // 0..1 fraction of spacing — offset along line normal

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
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  const fitScale = dw / sw;
  const ox = (W - dw) / 2;
  const oy = (H - dh) / 2;

  const layers = clamp(params.layers | 0, 1, 4);
  const spacing = Math.max(2, params.spacing);
  const half = Math.max(2, params.lineLength) / 2;
  const wob = params.ditherLevel;

  ctx.strokeStyle = params.ink;
  ctx.lineWidth = params.lineWidth;
  ctx.lineCap = 'round';

  // Diagonal length sufficient to cover canvas regardless of angle.
  const diag = Math.sqrt(sw * sw + sh * sh);
  const cx = sw / 2, cy = sh / 2;

  for(let li = 0; li < layers; li++){
    // Activation threshold: layer 0 (lightest tone) activates first.
    // 4 layers → thresholds at ~204, 153, 102, 51 with bias.
    const baseThresh = 255 - ((li + 1) / (layers + 1)) * 255;
    const thresh = clamp(baseThresh + _toneBias, 0, 255);

    const angle = ANGLES[li] + (_scribblePhase ? Math.sin(_scribblePhase + li * 1.5) * 0.25 : 0);
    const ca = Math.cos(angle), sa = Math.sin(angle);
    // Direction along the line (unit), and normal (perpendicular).
    const nx = -sa, ny = ca;

    // Ruling sweep: line k passes through (cx + k*spacing*nx, cy + k*spacing*ny).
    const sweep = Math.ceil(diag / spacing) + 2;
    const marchPx = _marchOffset * spacing;

    for(let k = -sweep; k <= sweep; k++){
      const off = k * spacing + marchPx;
      const baseX = cx + off * nx;
      const baseY = cy + off * ny;
      const samples = Math.ceil(diag / spacing) + 2;
      for(let s = -samples; s <= samples; s++){
        const t = s * spacing;
        const sx = baseX + t * ca;
        const sy = baseY + t * sa;
        if(sx < 0 || sx >= sw || sy < 0 || sy >= sh) continue;
        const lum = lumGrid[(sx | 0) + (sy | 0) * sw];
        if(lum >= thresh) continue;

        // Stroke half-length jitters with wobble for hand-drawn feel.
        const j = wob ? (1 - wob * 0.5 + wob * (((sx * 131 + sy * 977 + li) % 100) / 100)) : 1;
        const hl = half * j;
        const x1 = ox + (sx - ca * hl) * fitScale;
        const y1 = oy + (sy - sa * hl) * fitScale;
        const x2 = ox + (sx + ca * hl) * fitScale;
        const y2 = oy + (sy + sa * hl) * fitScale;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }
  }
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
  if(mode === 'scribble'){
    _scribblePhase = t01 * Math.PI * 2;
    return () => { _scribblePhase = 0; };
  }
  if(mode === 'tone'){
    _toneBias = 40 * Math.cos(t01 * Math.PI * 2);
    return () => { _toneBias = 0; };
  }
  if(mode === 'march'){
    _marchOffset = Math.sin(t01 * Math.PI * 2);
    return () => { _marchOffset = 0; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseSpacing = params.spacing;
  const baseLayers = params.layers;
  params.spacing = Math.round(5 + ax * 9);
  params.layers  = clamp(Math.round(1 + ay * 3), 1, 4);
  return () => { params.spacing = baseSpacing; params.layers = baseLayers; };
}

function renderAt(t01){
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
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

const PRE_KEYS = new Set(['canvasSize','fit']);

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
      if(key === 'fit') window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(params.animate) return;
    if(PRE_KEYS.has(key)) schedule('pre');
    else                  schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){ window.PIXSource.onChange(() => schedule('pre')); }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-crosshatch',
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
