// pixart/rgb-shift — chromatic aberration via per-channel offsets.
//
// Algorithm:
//   1. Preprocessor (shared) produces a W×H RGBA buffer.
//   2. Extract three single-channel frames (R-only, G-only, B-only) by
//      masking the other two channels to zero. Each frame is a tinted-pure
//      red / green / blue image.
//   3. Draw each frame onto an output canvas offset by (rOffsetX, rOffsetY),
//      (gOffsetX, gOffsetY), (bOffsetX, bOffsetY) respectively, recombined
//      with the chosen composite mode (add → 'lighter', screen → 'screen',
//      lighten → 'lighten', over → 'source-over').
//   4. `fringe` controls a radial multiplier on the offsets via a 9-tile
//      grid — but at our pixel scale we apply it as a simple scalar on the
//      offsets between centre and frame-edge approximation: at fringe=0 the
//      offsets apply uniformly; at fringe=1 they vanish at the centre and
//      reach full magnitude at the corners. Approximated by re-projecting
//      through a radial-mask alpha on each channel.
//   5. `gain` post-multiplies the composite via globalAlpha on each pass.

'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d');

// Per-channel single-channel canvases reused across paints.
const chanR = document.createElement('canvas');
const chanG = document.createElement('canvas');
const chanB = document.createElement('canvas');
const chanRCtx = chanR.getContext('2d');
const chanGCtx = chanG.getContext('2d');
const chanBCtx = chanB.getContext('2d');

const params = {
  // Preprocessor (shared).
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Per-channel offsets in px. Subtle horizontal stereoscopic split at default.
  rOffsetX:          6,
  rOffsetY:          0,
  gOffsetX:          0,
  gOffsetY:          0,
  bOffsetX:         -6,
  bOffsetY:          0,
  blend:            'add',
  gain:              1.0,
  fringe:            0.3,
  showEffect:        true,
  fit:               'cover',
  bg:                '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
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

// ---------- preprocessor (shared) ----------
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

  if(params.blurAmount > 0){
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const t = tmp.getContext('2d');
    t.filter = `blur(${params.blurAmount}px)`;
    t.drawImage(srcBuf, 0, 0);
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(tmp, 0, 0);
  }

  const id = sctx.getImageData(0, 0, W, H);
  preprocessed = id;
}

// ---------- build ----------
// Split preprocessed into three single-channel ImageDatas, then composite
// each at its per-channel offset using the chosen blend mode.
function buildOutput(){
  if(!preprocessed){ return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(outBuf.width !== W || outBuf.height !== H){
    outBuf.width = W; outBuf.height = H;
    chanR.width = W; chanR.height = H;
    chanG.width = W; chanG.height = H;
    chanB.width = W; chanB.height = H;
  }
  const src = preprocessed.data;

  // Build three single-channel ImageDatas. Each is pure-red / pure-green /
  // pure-blue version of the source. With 'lighter' composite these sum
  // back into a faithful colour image when offsets are zero.
  const rImg = new ImageData(W, H);
  const gImg = new ImageData(W, H);
  const bImg = new ImageData(W, H);
  const rd = rImg.data, gd = gImg.data, bd = bImg.data;

  // Fringe-driven radial mask. fringe=0 → alpha=255 everywhere (uniform
  // shift). fringe=1 → alpha rises from 0 at centre to 255 at corners on a
  // squared falloff. Applied as alpha on each single-channel frame so the
  // un-shifted source still shows through at centre when fringe>0.
  const fringe = clamp(params.fringe, 0, 1);
  const cx = W * 0.5, cy = H * 0.5;
  const rmax2 = cx*cx + cy*cy;

  for(let y = 0, j = 0; y < H; y++){
    for(let x = 0; x < W; x++, j += 4){
      let a = 255;
      if(fringe > 0){
        const dxr = x - cx, dyr = y - cy;
        const r2 = (dxr*dxr + dyr*dyr) / rmax2;
        a = ((1 - fringe) + fringe * r2) * 255;
        if(a < 0) a = 0; else if(a > 255) a = 255;
      }
      rd[j]   = src[j];   rd[j+1] = 0; rd[j+2] = 0; rd[j+3] = a;
      gd[j]   = 0; gd[j+1] = src[j+1]; gd[j+2] = 0; gd[j+3] = a;
      bd[j]   = 0; bd[j+1] = 0; bd[j+2] = src[j+2]; bd[j+3] = a;
    }
  }

  chanRCtx.putImageData(rImg, 0, 0);
  chanGCtx.putImageData(gImg, 0, 0);
  chanBCtx.putImageData(bImg, 0, 0);

  // Composite mode mapping.
  let comp = 'lighter';
  switch(params.blend){
    case 'screen':  comp = 'screen';      break;
    case 'lighten': comp = 'lighten';     break;
    case 'over':    comp = 'source-over'; break;
    case 'add':
    default:        comp = 'lighter';     break;
  }

  const gain = clamp(params.gain, 0, 4);

  octx.save();
  // For 'over' the bg has to be the unshifted source so channels visibly stack
  // on top of it; for additive blends we start from black.
  octx.globalCompositeOperation = 'source-over';
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, W, H);

  octx.globalAlpha = gain;
  octx.globalCompositeOperation = comp;
  octx.drawImage(chanR, params.rOffsetX, params.rOffsetY);
  octx.drawImage(chanG, params.gOffsetX, params.gOffsetY);
  octx.drawImage(chanB, params.bOffsetX, params.bOffsetY);
  octx.restore();
}

// ---------- paint ----------
function paint(){
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
  const aspect = imgW / imgH;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(outBuf, ox, oy, dw, dh);
  ctx.restore();
}

// ---------- WAEffect ----------
window.WAEffect = {
  cycleMs: 0,
  renderAt: () => { paint(); return cv; },
  pauseRender: () => {},
  resumeRender: () => { paint(); return cv; },
};

const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['rOffsetX','rOffsetY','gOffsetX','gOffsetY','bOffsetX','bOffsetY','blend','gain','fringe']);
const PAINT_KEYS = new Set(['showEffect']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-rgb-shift',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
}

document.addEventListener('DOMContentLoaded', init);
