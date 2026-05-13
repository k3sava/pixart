// pixart/pixel-sort — Kim Asendorf's ASDF pixel-sort (Processing, 2010).
//
// Algorithm: for each scan line (row / column / diagonal), find contiguous
// runs of pixels whose luminance falls within [thresholdLow, thresholdHigh].
// Within each run, sort the pixels by the chosen key (luminance / hue /
// saturation / red). Pixels outside the band act as walls and are left in
// place — that's what preserves the silhouette.
//
// Step 2 (pattern-set): animation + interactive cursor layered on top.
//
// Defaults were chosen by sweeping each control alone against portrait.jpg
// in Playwright. Sweet spot for "sort streaks read AND portrait recognizable":
//
//   direction='row'        — horizontal streaks read most clearly as sort.
//   sortBy='luminance'     — preserves tonal structure of the subject.
//   thresholdLow=90        — keeps shadows as walls; protects facial features.
//   thresholdHigh=200      — keeps highlights as walls; protects skin.
//   The band [90..200] sorts the midtones (skin, fabric) while the very dark
//   and very bright regions stay put. Widening the band beyond [60..240]
//   dissolves the face. Narrowing below [120..180] reads as no-op.
//
// Animation modes (each = cosine envelope across cycleMs=15000):
//
//   band — thresholdLow ping-pongs 30 ↔ 150 around the user-set base. The
//          band's dark wall slides in and out, so the sorted region grows
//          and shrinks from the shadow side.
//   flow — thresholdHigh ping-pongs 140 ↔ 250. The bright wall slides, so
//          the band breathes from the highlight side (opposite end of band).
//
// Interactive: cursor X → thresholdLow (30..180), cursor Y → thresholdHigh
// (60..240). The cursor literally IS the sort band — top-left = wide & dark,
// bottom-right = narrow & bright.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  direction:     'row',
  sortBy:        'luminance',
  thresholdLow:  90,
  thresholdHigh: 200,
  sortReverse:   false,
  animate:       false,
  mode:          'band',
  interactive:   false,
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
  let lo = clamp(params.thresholdLow,  0, 255);
  let hi = clamp(params.thresholdHigh, 0, 255);
  if(lo > hi){ const t = lo; lo = hi; hi = t; }
  const reverse = !!params.sortReverse;

  // Build line index arrays.
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
      while(s < L){
        const i = idx[s];
        const lum = keyLum(px[i], px[i+1], px[i+2]);
        if(lum >= lo && lum <= hi) break;
        s++;
      }
      if(s >= L) break;
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
  } else {
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ---------- animation ----------
const CYCLE_MS = 15000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  const mode = params.mode;
  if(mode === 'band'){
    // thresholdLow pings 30 ↔ 150. Dark wall slides — band widens/narrows
    // from the shadow side.
    const base = params.thresholdLow;
    params.thresholdLow = 30 + 120 * pingPong(t01);
    return () => { params.thresholdLow = base; };
  }
  if(mode === 'flow'){
    // thresholdHigh pings 140 ↔ 250. Bright wall slides — opposite end of
    // the band moves; band breathes from the highlight side.
    const base = params.thresholdHigh;
    params.thresholdHigh = 140 + 110 * pingPong(t01);
    return () => { params.thresholdHigh = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseLo = params.thresholdLow;
  const baseHi = params.thresholdHigh;
  params.thresholdLow  = 30  + ax * 150;   // 30..180
  params.thresholdHigh = 60  + ay * 180;   // 60..240
  return () => { params.thresholdLow = baseLo; params.thresholdHigh = baseHi; };
}

function renderAt(t01){
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  buildSorted();
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

const PRE_KEYS   = new Set(['fit','bg']);
const BUILD_KEYS = new Set(['sortBy','direction','thresholdLow','thresholdHigh','sortReverse']);

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
      schedule('paint');
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
  if(params.animate) startAnimation();
}

document.addEventListener('DOMContentLoaded', init);
