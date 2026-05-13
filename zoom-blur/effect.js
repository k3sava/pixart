// pixart/zoom-blur — radial / rotational / spiral / motion-line blur.
//
// For each output pixel (x,y) we accumulate N samples of the source at
// positions interpolated between (focusX, focusY) and (x,y), and average
// them. The result is a motion-blur that radiates — focal point sharp,
// everything else streaks outward along the radial.
//
//     u = (k / (N-1)) · strength
//     sx = lerp(focusX, x, 1 - u)
//     sy = lerp(focusY, y, 1 - u)
//
//   For rotational blur the sample sweeps a tangent arc on the circle of
//   radius r = |p - focus|. Spiral combines both. Motion-line is a fixed
//   directional translation (Knoll's "motion blur" subtype).
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });
const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d');

const CANVAS_SIZE = 480;

const params = {
  blurType:    'zoom',
  strength:    0.4,
  samples:     16,
  focusX:      0.5,
  focusY:      0.5,
  dropoff:     1,
  holdSharp:   0.2,
  direction:   0,
  spiralTwist: 90,
  showEffect:  true,
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let resampled = null;
let dirty = { resample: true, paint: true };
let rafQueued = false;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

function schedule(level){
  if(level === 'resample') dirty.resample = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.resample) resample();
    paint();
    dirty.resample = dirty.paint = false;
  });
}

function fitCanvas(){
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

function resample(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = CANVAS_SIZE;
  const H = Math.max(1, Math.round(W * aspect));
  if(srcBuf.width !== W || srcBuf.height !== H){
    srcBuf.width = W; srcBuf.height = H;
    outBuf.width = W; outBuf.height = H;
  }
  sctx.clearRect(0, 0, W, H);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  resampled = sctx.getImageData(0, 0, W, H);
}

function applyBlur(){
  if(!resampled) return null;
  const W = resampled.width, H = resampled.height;
  const src = resampled.data;
  const out = octx.createImageData(W, H);
  const o = out.data;

  const type = params.blurType;
  const N = clamp(params.samples | 0, 2, 64);
  const strength = clamp(params.strength, 0, 1);
  const maxDist = strength * Math.hypot(W, H);
  const fx = params.focusX * W, fy = params.focusY * H;
  const dropoff = clamp(params.dropoff, 0, 2);
  const holdR = params.holdSharp * Math.hypot(W, H) * 0.5;
  const holdR2 = holdR * holdR;
  const dirRad = (params.direction % 360) * Math.PI / 180;
  const motionDx = Math.cos(dirRad);
  const motionDy = Math.sin(dirRad);
  const twistRad = params.spiralTwist * Math.PI / 180;
  const invN = 1 / Math.max(1, N - 1);

  for(let y = 0; y < H; y++){
    for(let x = 0; x < W; x++){
      const i = (x + y * W) * 4;
      const dx0 = x - fx, dy0 = y - fy;
      const r2 = dx0*dx0 + dy0*dy0;

      if(r2 < holdR2){
        o[i]   = src[i];
        o[i+1] = src[i+1];
        o[i+2] = src[i+2];
        o[i+3] = src[i+3];
        continue;
      }

      const r = Math.sqrt(r2);
      const theta = Math.atan2(dy0, dx0);
      const distNorm = clamp(r / Math.max(1, maxDist), 0, 1);
      const lenFactor = Math.pow(distNorm, dropoff);
      const sampleLen = maxDist * lenFactor;

      let sumR = 0, sumG = 0, sumB = 0, sumA = 0, count = 0;
      for(let k = 0; k < N; k++){
        const u = k * invN;
        let sx, sy;
        switch(type){
          case 'rotational': {
            const angleSpan = strength * 0.6;
            const t01 = u - 0.5;
            const a = theta + t01 * angleSpan;
            sx = fx + r * Math.cos(a);
            sy = fy + r * Math.sin(a);
            break;
          }
          case 'spiral': {
            const rSample = lerp(r - sampleLen * 0.5, r + sampleLen * 0.5, u);
            const a = theta + u * twistRad - twistRad * 0.5;
            sx = fx + rSample * Math.cos(a);
            sy = fy + rSample * Math.sin(a);
            break;
          }
          case 'motion-line': {
            const off = (u - 0.5) * maxDist;
            sx = x + motionDx * off;
            sy = y + motionDy * off;
            break;
          }
          case 'zoom':
          default: {
            const start = 1 - lenFactor;
            const t01 = lerp(start, 1, u);
            sx = fx + (x - fx) * t01;
            sy = fy + (y - fy) * t01;
            break;
          }
        }
        if(sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
        const si = ((sx | 0) + (sy | 0) * W) * 4;
        sumR += src[si];
        sumG += src[si+1];
        sumB += src[si+2];
        sumA += src[si+3];
        count++;
      }
      if(count === 0){
        o[i]   = src[i];
        o[i+1] = src[i+1];
        o[i+2] = src[i+2];
        o[i+3] = src[i+3];
      } else {
        o[i]   = sumR / count;
        o[i+1] = sumG / count;
        o[i+2] = sumB / count;
        o[i+3] = sumA / count;
      }
    }
  }
  octx.putImageData(out, 0, 0);
  return outBuf;
}

function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);
  if(!resampled){ ctx.restore(); return; }

  const surface = params.showEffect ? (applyBlur() || srcBuf) : srcBuf;
  const sw = surface.width, sh = surface.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dw = W; dh = W / aspect; }
  else              { dh = H; dw = H * aspect; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(surface, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

window.WAEffect = {
  cycleMs: 0,
  renderAt(){ paint(); },
  pauseRender(){},
  resumeRender(){ paint(); },
};

const RESAMPLE_KEYS = new Set(['fit']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('resample'); else schedule('paint');
      return;
    }
    if(RESAMPLE_KEYS.has(key)) schedule('resample');
    else schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('resample'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-zoom-blur',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('resample');
}

document.addEventListener('DOMContentLoaded', init);
