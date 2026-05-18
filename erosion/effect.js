// pixart/erosion — Morphological image erosion.
//
// Sobel edge detection → morphological dilation of the edge mask by
// `erosionRadius` pixels → eroded pixels are desaturated, darkened and
// lightly noised to simulate worn stone, old print, or corroded metal.
//
// Separable max-filter (row pass + column pass) keeps the dilation O(W·H·r)
// rather than O(W·H·r²).
//
// Animation modes:
//
//   erode   — erosionRadius pingpongs 0 → maxRadius → 0 (cosine). The
//             erosion tide rises and falls, alternately consuming and
//             releasing texture.
//   crumble — |sin(t·3π)| envelope. Three pulses per cycle, irregular.
//             Simulates stone crumbling in bursts.
//   age     — Linear grow 0 → maxRadius over 60% of cycle; snap back over
//             the remaining 40%. Aging then sudden restoration.
//
// Interactive: X → erosionRadius (0..maxRadius), Y → edgeThreshold (5..120).
//
// Tested defaults:
//   maxRadius=8      — enough to consume fine detail without burying the subject.
//   edgeThreshold=40 — picks up the main structural edges on a portrait.
//   erosionStrength=0.8 — strong enough to read as worn; leaves some colour.
'use strict';

const CYCLE_MS = 20000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });
const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d');

const params = {
  canvasSize:      600,
  blur:            0,
  grain:           0,
  gamma:           1,
  blackPoint:      0,
  whitePoint:      255,
  // Erosion-specific.
  maxRadius:       8,
  edgeThreshold:   40,
  erosionStrength: 0.8,
  // Animation + interactive.
  animate:         false,
  mode:            'erode',
  interactive:     false,
  showEffect:      true,
  // Shared chrome.
  fit:             'cover',
  bg:              '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui, preprocessed = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

// Module-level animated radius (not stored in params to avoid dirtying GUI).
let _currentErosionRadius = 0;

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

// ── buildOutput: Sobel → dilate → erode pixels ───────────────
function buildOutput(){
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;
  if(outBuf.width !== W || outBuf.height !== H){
    outBuf.width = W; outBuf.height = H;
  }

  const src = preprocessed.data;

  // 1. Sobel edge detection — luminance-based.
  const edgeMap = new Float32Array(W * H);
  for(let y = 1; y < H - 1; y++){
    for(let x = 1; x < W - 1; x++){
      // Sample luminance for 3×3 neighbourhood.
      const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
      const px = (dx, dy) => {
        const i = ((y + dy) * W + (x + dx)) * 4;
        return lum(src[i], src[i+1], src[i+2]);
      };
      const tl = px(-1,-1), tc = px(0,-1), tr = px(1,-1);
      const ml = px(-1, 0),               mr = px(1, 0);
      const bl = px(-1, 1), bc = px(0, 1), br = px(1, 1);
      const Gx = -tl - 2*ml - bl + tr + 2*mr + br;
      const Gy = -tl - 2*tc - tr + bl + 2*bc + br;
      edgeMap[y * W + x] = Math.min(255, Math.sqrt(Gx*Gx + Gy*Gy));
    }
  }

  // 2. Separable morphological dilation by radius r.
  const r = Math.round(clamp(_currentErosionRadius, 0, params.maxRadius));
  let dilatedMap;
  if(r === 0){
    dilatedMap = edgeMap;
  } else {
    // Row pass.
    const rowPass = new Float32Array(W * H);
    for(let y = 0; y < H; y++){
      for(let x = 0; x < W; x++){
        let mx = 0;
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(W - 1, x + r);
        for(let xi = x0; xi <= x1; xi++){
          const v = edgeMap[y * W + xi];
          if(v > mx) mx = v;
        }
        rowPass[y * W + x] = mx;
      }
    }
    // Column pass.
    dilatedMap = new Float32Array(W * H);
    for(let x = 0; x < W; x++){
      for(let y = 0; y < H; y++){
        let mx = 0;
        const y0 = Math.max(0, y - r);
        const y1 = Math.min(H - 1, y + r);
        for(let yi = y0; yi <= y1; yi++){
          const v = rowPass[yi * W + x];
          if(v > mx) mx = v;
        }
        dilatedMap[y * W + x] = mx;
      }
    }
  }

  // 3. Threshold to erosion mask.
  const thresh = params.edgeThreshold;
  const strength = params.erosionStrength;

  // 4. Build output pixels.
  const out = octx.createImageData(W, H);
  const outD = out.data;

  for(let i = 0, pi = 0; i < W * H; i++, pi += 4){
    const sr = src[pi], sg = src[pi+1], sb = src[pi+2];
    if(dilatedMap[i] > thresh){
      // Eroded pixel: desaturate + darken + noise.
      const L = Math.round(0.299 * sr + 0.587 * sg + 0.114 * sb);
      const worn = L * 0.7;
      const noise = (Math.random() - 0.5) * 20;
      outD[pi]   = clamp(sr + (worn + noise - sr) * strength, 0, 255);
      outD[pi+1] = clamp(sg + (worn + noise - sg) * strength, 0, 255);
      outD[pi+2] = clamp(sb + (worn + noise - sb) * strength, 0, 255);
    } else {
      outD[pi]   = sr;
      outD[pi+1] = sg;
      outD[pi+2] = sb;
    }
    outD[pi+3] = 255;
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
  const base = _currentErosionRadius;
  const maxR = params.maxRadius;
  if(params.mode === 'erode'){
    _currentErosionRadius = maxR * pingPong(t01);
  } else if(params.mode === 'crumble'){
    _currentErosionRadius = maxR * (0.3 + 0.7 * Math.abs(Math.sin(t01 * Math.PI * 3)));
  } else { // age
    const f = t01 < 0.6 ? t01 / 0.6 : Math.max(0, 1 - (t01 - 0.6) / 0.4);
    _currentErosionRadius = maxR * f;
  }
  return () => { _currentErosionRadius = base; };
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const rect = cv.getBoundingClientRect();
  const ax = clamp(mouseX / rect.width,  0, 1);
  const ay = clamp(mouseY / rect.height, 0, 1);
  const baseR = _currentErosionRadius;
  const baseT = params.edgeThreshold;
  _currentErosionRadius = ax * params.maxRadius;
  params.edgeThreshold  = 5 + ay * 115;
  return () => { _currentErosionRadius = baseR; params.edgeThreshold = baseT; };
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
const BUILD_KEYS = new Set(['edgeThreshold','erosionStrength','maxRadius']);

function init(){
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
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(params.animate) return;
    if(PRE_KEYS.has(key))   schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                    schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('build'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-erosion',
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
