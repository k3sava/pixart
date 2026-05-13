// pixart/slit-scan — spatial slit-scan (sheared read).
//
// Slit-scan is fundamentally temporal: for video, each output row is sampled
// from a different past frame. This effect is static (cycleMs: 0, no animation
// loop), so we use the spatial-shear fallback for both image and video sources:
// for each row y, shift the source horizontally (axis: horizontal) or each
// column x vertically (axis: vertical) by (u/extent) * spread * canvasExtent.
// The result is a slanted version of the source — Sugimoto's `Theaters`
// integration in space rather than time.
//
// Video sources: we snapshot the current PIXSource.getCanvas() at paint time
// and apply the same spatial shear. A true temporal ring buffer is out of
// scope for a static effect; documented as a known limitation.
'use strict';

const CYCLE_MS = 0;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Working buffer for the source (W x H matched to source aspect at fixed width).
const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  axis:       'horizontal',
  spread:     0.6,
  tilt:       0,
  showEffect: true,
  fit:        'cover',
  bg:         '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

const SRC_WIDTH = 600;

let gui;
let preprocessed = null;
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

function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = SRC_WIDTH;
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

// Spatial slit-scan: for axis=horizontal, shift each row by an amount that
// grows with y, producing a horizontal shear. axis=vertical shears columns.
// `tilt` rotates the slit's reference axis so the shear direction is rotated.
function buildOutput(){
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;
  const src = preprocessed.data;
  const out = sctx.createImageData(W, H);
  const dst = out.data;

  const axis = params.axis;
  const tiltRad = params.tilt * Math.PI / 180;
  const cosT = Math.cos(tiltRad), sinT = Math.sin(tiltRad);
  const cx = W / 2, cy = H / 2;

  // Max shear in pixels: spread * extent. Centred so u=0 → -max/2, u=1 → +max/2.
  const maxShearX = params.spread * W;
  const maxShearY = params.spread * H;

  for(let y = 0; y < H; y++){
    for(let x = 0; x < W; x++){
      const dx = x - cx, dy = y - cy;
      let u, shiftPx, sx = x, sy = y;
      if(axis === 'horizontal'){
        // u from rotated y coordinate (tilt rotates the slit).
        const yr = dy * cosT - dx * sinT;
        u = (yr / H) + 0.5;
        u = clamp(u, 0, 1);
        shiftPx = (u - 0.5) * maxShearX;
        sx = x + shiftPx;
      } else { // vertical
        const xr = dx * cosT + dy * sinT;
        u = (xr / W) + 0.5;
        u = clamp(u, 0, 1);
        shiftPx = (u - 0.5) * maxShearY;
        sy = y + shiftPx;
      }
      sx = clamp(sx, 0, W - 1);
      sy = clamp(sy, 0, H - 1);
      const sOff = ((sy | 0) * W + (sx | 0)) * 4;
      const dOff = (y * W + x) * 4;
      dst[dOff]   = src[sOff];
      dst[dOff+1] = src[sOff+1];
      dst[dOff+2] = src[sOff+2];
      dst[dOff+3] = src[sOff+3];
    }
  }
  sctx.putImageData(out, 0, 0);
}

function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);
  if(!preprocessed){ ctx.restore(); return; }

  // If showEffect is off, draw the un-sheared source. Re-rasterise from
  // PIXSource to avoid leaking the previously-built shear into srcBuf.
  if(!params.showEffect){
    const srcCv = window.PIXSource?.getCanvas();
    if(srcCv){
      const sw = preprocessed.width, sh = preprocessed.height;
      const aspect = sw / sh;
      let dw, dh;
      if(W / H > aspect){ dh = H; dw = H * aspect; }
      else              { dw = W; dh = W / aspect; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(srcCv, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    ctx.restore();
    return;
  }

  const sw = srcBuf.width, sh = srcBuf.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

window.WAEffect = {
  cycleMs: 0,
  renderAt(){ paint(); },
  pauseRender(){},
  resumeRender(){ paint(); },
};

const PRE_KEYS   = new Set(['fit','bg']);
const BUILD_KEYS = new Set(['axis','spread','tilt']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(key === 'showEffect') { schedule('paint'); return; }
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-slit-scan',
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
