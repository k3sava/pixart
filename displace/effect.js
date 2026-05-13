// pixart/displace — faithful port of tooooools.app/effects/displace.
//
// Algorithm (the simple original, pre-3D-bolt-on):
//   1. Preprocess the source: blur → grain → gamma → levels.
//   2. Walk the preprocessed buffer on a `stepSize` grid.
//   3. For each cell, draw a `dotSize` dot at the source position, vertically
//      offset by `displacement * (luminance / 255)`.
//
// No 3D projection, no animation, no interactive basin. Static render.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  canvasSize:   600,
  blur:         0,
  grain:        0,
  gamma:        1,
  blackPoint:   0,
  whitePoint:   255,
  stepSize:     8,
  displacement: 180,
  dotSize:      8,
  showEffect:   true,
  fit:          'cover',
  bg:           '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let dirty = { pre: true, paint: true };
let rafQueued = false;

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
  const g  = params.grain;
  const gm = params.gamma;
  const bp = params.blackPoint;
  const wp = params.whitePoint;
  const span = Math.max(1, wp - bp);
  const scale = 255 / span;
  const doGrain  = g !== 0;
  const doGamma  = gm !== 1;
  const doLevels = bp !== 0 || wp !== 255;
  let lut = null;
  if(doGamma){
    lut = new Uint8ClampedArray(256);
    for(let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, gm));
  }
  for(let i = 0; i < px.length; i += 4){
    let r = px[i], gg = px[i+1], b = px[i+2];
    if(doGrain){
      const n = (0.5 - Math.random()) * g * 255;
      r  = clamp(r  + n, 0, 255);
      gg = clamp(gg + n, 0, 255);
      b  = clamp(b  + n, 0, 255);
    }
    if(doGamma){
      r  = lut[r | 0];
      gg = lut[gg | 0];
      b  = lut[b  | 0];
    }
    if(doLevels){
      r  = clamp((r  - bp) * scale, 0, 255);
      gg = clamp((gg - bp) * scale, 0, 255);
      b  = clamp((b  - bp) * scale, 0, 255);
    }
    px[i] = r; px[i+1] = gg; px[i+2] = b;
  }
  sctx.putImageData(id, 0, 0);
  preprocessed = id;
}

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
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  const sw = preprocessed.width, sh = preprocessed.height;
  const px = preprocessed.data;
  const stride = Math.max(1, params.stepSize | 0);
  const disp = params.displacement;

  // Fit source rect inside canvas.
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.9; dw = dh * aspect; }
  else              { dw = W * 0.9; dh = dw / aspect; }
  const fitScale = dw / sw;
  const ox = (W - dw) / 2;
  const oy = (H - dh) / 2;

  const ds = Math.max(1, params.dotSize * fitScale * 0.5);
  const useRects = params.dotSize * fitScale < 5;

  for(let y = 0; y < sh; y += stride){
    for(let x = 0; x < sw; x += stride){
      const i = (x + y * sw) * 4;
      const r = px[i], g = px[i+1], b = px[i+2];
      const a = px[i+3] / 255;
      const lr = 255 + (r - 255) * a;
      const lg = 255 + (g - 255) * a;
      const lb = 255 + (b - 255) * a;
      const lum = (lr + lg + lb) / 3;
      const dy = disp * (lum / 255);
      const sx = ox + x * fitScale;
      const sy = oy + (y + dy) * fitScale;
      ctx.fillStyle = 'rgb(' + (r|0) + ',' + (g|0) + ',' + (b|0) + ')';
      if(useRects){
        ctx.fillRect(sx - ds, sy - ds, ds * 2, ds * 2);
      } else {
        ctx.beginPath();
        ctx.arc(sx, sy, ds, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.restore();
}

window.WAEffect = {
  cycleMs: 0,
  renderAt(){ paint(); },
  pauseRender(){},
  resumeRender(){ paint(); },
};

const PRE_KEYS = new Set(['canvasSize','blur','grain','gamma','blackPoint','whitePoint','fit','bg']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(PRE_KEYS.has(key)) schedule('pre');
    else                  schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-displace',
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
