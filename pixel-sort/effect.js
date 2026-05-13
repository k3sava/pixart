// pixart/pixel-sort — Kim Asendorf's ASDF pixel-sort (Processing, 2010).
//
// Algorithm: for each scan line (row / column / diagonal), find contiguous
// runs of pixels whose luminance falls within [thresholdLow, thresholdHigh].
// Within each run, sort the pixels by the chosen key (luminance / hue /
// saturation / red). Pixels outside the band act as walls and are left in
// place — that's what preserves the silhouette.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  direction:     'row',
  sortBy:        'luminance',
  thresholdLow:  80,
  thresholdHigh: 220,
  sortReverse:   false,
  showEffect:    true,
  fit:           'cover',
  bg:            '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

let outBuf = null;
let outImg = null;

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
    if(dirty.build) buildSorted();
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

// ---------- preprocessor ----------
function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
  const W = 600;
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

// ---------- sort key extractors ----------
function keyLum(r,g,b){ return 0.299*r + 0.587*g + 0.114*b; }
function keyHue(r,g,b){
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
  const d = mx - mn;
  if(d === 0) return 0;
  let h;
  if(mx === r)      h = ((g - b) / d) % 6;
  else if(mx === g) h = (b - r) / d + 2;
  else              h = (r - g) / d + 4;
  h *= 60;
  if(h < 0) h += 360;
  return h;
}
function keySat(r,g,b){
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
  if(mx === 0) return 0;
  return (mx - mn) / mx * 255;
}
function keyRed(r,g,b){ return r; }

function getKeyFn(name){
  if(name === 'hue') return keyHue;
  if(name === 'saturation') return keySat;
  if(name === 'red') return keyRed;
  return keyLum;
}

// ---------- sorter ----------
function buildSorted(){
  if(!preprocessed){ return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(!outBuf || outBuf.length !== W * H * 4){
    outBuf = new Uint8ClampedArray(W * H * 4);
    outImg = new ImageData(outBuf, W, H);
  }
  outBuf.set(preprocessed.data);

  const px = preprocessed.data;
  const keyFn = getKeyFn(params.sortBy);
  const dirRaw = params.direction;
  const lo = clamp(params.thresholdLow,  0, 255);
  const hi = clamp(params.thresholdHigh, 0, 255);
  const reverse = !!params.sortReverse;

  const lines = [];
  if(dirRaw === 'row'){
    for(let y = 0; y < H; y++){
      const idx = new Int32Array(W);
      for(let x = 0; x < W; x++) idx[x] = (y * W + x) * 4;
      lines.push(idx);
    }
  } else if(dirRaw === 'column'){
    for(let x = 0; x < W; x++){
      const idx = new Int32Array(H);
      for(let y = 0; y < H; y++) idx[y] = (y * W + x) * 4;
      lines.push(idx);
    }
  } else if(dirRaw === 'diagonal-1'){
    for(let k = 0; k < W + H - 1; k++){
      const xStart = Math.max(0, k - (H - 1));
      const xEnd   = Math.min(W - 1, k);
      const len    = xEnd - xStart + 1;
      const idx = new Int32Array(len);
      for(let n = 0; n < len; n++){
        const x = xStart + n;
        const y = k - x;
        idx[n] = (y * W + x) * 4;
      }
      lines.push(idx);
    }
  } else { // diagonal-2
    for(let k = -(H - 1); k < W; k++){
      const xStart = Math.max(0, k);
      const xEnd   = Math.min(W - 1, k + H - 1);
      const len    = xEnd - xStart + 1;
      const idx = new Int32Array(len);
      for(let n = 0; n < len; n++){
        const x = xStart + n;
        const y = x - k;
        idx[n] = (y * W + x) * 4;
      }
      lines.push(idx);
    }
  }

  const maxLen = Math.max(W, H);
  const keys     = new Float32Array(maxLen);
  const runOrder = new Int32Array(maxLen);
  const tmpR     = new Uint8ClampedArray(maxLen);
  const tmpG     = new Uint8ClampedArray(maxLen);
  const tmpB     = new Uint8ClampedArray(maxLen);
  const tmpA     = new Uint8ClampedArray(maxLen);

  for(let li = 0; li < lines.length; li++){
    const idx = lines[li];
    const L = idx.length;

    let s = 0;
    while(s < L){
      // find run start
      while(s < L){
        const i = idx[s];
        const lum = keyLum(px[i], px[i+1], px[i+2]);
        if(lum >= lo && lum <= hi) break;
        s++;
      }
      if(s >= L) break;
      // find run end
      let e = s;
      while(e < L){
        const i = idx[e];
        const lum = keyLum(px[i], px[i+1], px[i+2]);
        if(!(lum >= lo && lum <= hi)) break;
        e++;
      }
      const runLen = e - s;
      if(runLen > 1){
        for(let n = 0; n < runLen; n++){
          const i = idx[s + n];
          const r = px[i], gg = px[i+1], b = px[i+2], a = px[i+3];
          keys[n] = keyFn(r, gg, b);
          runOrder[n] = n;
          tmpR[n] = r; tmpG[n] = gg; tmpB[n] = b; tmpA[n] = a;
        }
        const sub = Array.from(runOrder.subarray(0, runLen));
        if(reverse){
          sub.sort((a, b) => keys[b] - keys[a]);
        } else {
          sub.sort((a, b) => keys[a] - keys[b]);
        }
        for(let n = 0; n < runLen; n++){
          const dst = idx[s + n];
          const srcN = sub[n];
          outBuf[dst]   = tmpR[srcN];
          outBuf[dst+1] = tmpG[srcN];
          outBuf[dst+2] = tmpB[srcN];
          outBuf[dst+3] = tmpA[srcN];
        }
      }
      s = e + 1;
    }
  }
}

// ---------- paint ----------
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);
  if(!preprocessed){ ctx.restore(); return; }

  const sw = preprocessed.width, sh = preprocessed.height;
  srcBuf.width = sw; srcBuf.height = sh;
  if(params.showEffect && outImg){
    sctx.putImageData(outImg, 0, 0);
  } else {
    sctx.putImageData(preprocessed, 0, 0);
  }

  const aspect = sw / sh;
  let dw, dh;
  if(params.fit === 'cover'){
    if(W / H > aspect){ dw = W; dh = W / aspect; }
    else              { dh = H; dw = H * aspect; }
  } else { // contain
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: 0,
  renderAt: () => paint(),
  pauseRender: () => {},
  resumeRender: () => paint(),
};

const PRE_KEYS   = new Set(['fit','bg']);
const BUILD_KEYS = new Set(['sortBy','direction','thresholdLow','thresholdHigh','sortReverse']);
const PAINT_KEYS = new Set(['showEffect']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('paint'); else schedule('paint');
      return;
    }
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => { schedule('pre'); });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-pixel-sort',
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
