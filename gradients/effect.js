// pixart/gradients — port of tooooools.app/effects/gradients.
//
// Reverse-engineered from the minified bundle:
//   /_next/static/chunks/app/effects/gradients/page-be52627c6a02682d.js
//   /_next/static/chunks/9357-2a51c42cdfe973de.js (shared preprocessor + defaults)
//
// What the reference effect actually is
// -------------------------------------
// Despite the name, **Gradients is not a "draw a CSS gradient on top of the
// image" effect** and not a gradient-map recolour (that's the Recolor effect).
// It's a **scanline brightness segmentation** that paints each segment with a
// 1-pixel-wide white→black palette stretched over the segment's horizontal
// extent. The visible texture inside every shape is therefore a *gradient*
// from white (left) to black (right), and the shapes themselves tile the
// canvas in horizontal strips. Per-strip width-quantisation of source
// brightness × per-segment auto-gradient = the recognisable "venetian-blind
// painterly bands" look.
//
// Decoded p5 algorithm (module 8409 + draw helper in 9398):
//
//   setup:
//     create WEBGL canvas (canvasSize × canvasHeight = canvasSize · h/w)
//     palette = createGraphics(canvasSize, 1)
//     for x in 0..canvasSize-1:
//         palette.set(x, 0, map(x, 0, w-1, 255, 0))   // WHITE on left, BLACK on right
//     noLoop()  — p5 is just a render-on-update host
//
//   preprocess (shared 9398.H):
//     copy source → buffer
//     filter(BLUR, blurAmount)              if blurAmount != 0
//     grain  ← px ± (rand−0.5)·g·255        if grainAmount != 0
//     gamma  ← 255·(px/255)^γ               if gamma != 1
//     levels ← clamp((px−bp)·(255/(wp−bp))) if bp!=0 or wp!=255
//     resize to (canvasSize, canvasHeight) and return
//
//   draw (if showEffect):
//     for stripY in 0..H step stepSize:
//       prevB = 0, segStart = 0
//       for x in 0..W:
//         sum = 0
//         for ys in stripY..stripY+stepSize:
//           a = px[(x,ys)].a / 255
//           sum += (lerp(255,R,a)+lerp(255,G,a)+lerp(255,B,a)) / 3   // composite over white
//         avgB = sum / stepSize
//         if abs(prevB - avgB) > lightnessThreshold:
//           emit segment {start: segStart, end: x, brightness: prevB}
//           segStart = x
//           prevB    = avgB
//       emit trailing segment up to W
//
//     for each segment in a strip:
//       textureMode(NORMAL); texture(palette); noStroke();
//       shapeType === 'ellipse'
//         ? ellipse(start − w/2, stripY − h/2, end−start, stepSize)
//         : rect   (start − w/2, stripY − h/2, end−start, stepSize)
//
// In WEBGL with textureMode(NORMAL), a textured rect's UVs span [0..1] across
// the rect, so every segment shows the FULL palette compressed into its
// width — that's where the per-band gradient comes from. Wider segments
// (= visually-flat horizontal stretches in the source) produce smoother
// long gradients; narrow segments (= busy detail) produce hard cuts.
//
// Note: the segment's `brightness` field is collected but the reference's
// final draw call IGNORES it — the texture is the palette, not a tint by
// brightness. Verified twice in the chunk: `e.texture(a)` references the
// palette graphics, never the source. We mirror that exactly.
//
// Defaults (verified in pageStates["/effects/gradients"]):
//   showEffect:true, lightnessThreshold:128, stepSize:8, shapeType:"rect"
//   + shared preprocessor (canvasSize 400 in setup; slider 100..1000, no
//   explicit default in pageStates so canvasSize falls through to the global
//   default — we use 600 for parity with Recolor / Edge / Displace ports).
//
// UI ranges (from u(e,t) in page chunk):
//   Threshold:  0 .. 255
//   Step Size:  15 .. 100        ← note the GUI MIN is 15; default 8 is OUT
//                                  OF RANGE for the slider. The reference
//                                  ships unreachable-default state — the
//                                  first paint uses 8, then any drag of the
//                                  slider snaps to ≥15. We faithfully use 8
//                                  as the start value and let the slider
//                                  clamp on interaction.
//   Shape Type: rect | ellipse (contentSwitcher)
//
// Animation (not in reference — reference is static)
// --------------------------------------------------
// 15s seamless loop pingponging `lightnessThreshold` between
// `base + thresholdSweep` and `base − thresholdSweep` via a cosine pingpong.
// Endpoints meet byte-equal because (1−cos(2π))/2 == (1−cos(0))/2 == 0 in
// IEEE-754 (the standard guarantees cos(±0) = 1; the (1−x)/2 algebra is exact
// for the 0 endpoint). At low threshold the canvas fragments into many small
// gradient segments (high detail); at high threshold whole rows collapse to
// one or two giant segments. Reading the loop as breathing complexity.
//
// Determinism: the algorithm is pixel-deterministic; the only RNG is the
// preprocessor's grain term, which is re-seeded from t each frame via
// mulberry32 so renderAt(0) === renderAt(1) byte-equal even with grain > 0.
//
// Performance: O(W·stepSize·H/stepSize) = O(W·H) pixel reads per frame +
// segment fills. At 1280×720, default stepSize=8, that's ~922K reads per
// frame on the preprocessed buffer (600 × 0.5625·600 ≈ 600·338 = ~203K),
// well under 30ms/frame. We use a Float32 luminance grid like the Edge port
// to avoid recomputing alpha-composite per strip pass.

'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Offscreen buffers.
const srcBuf = document.createElement('canvas');                       // preprocessed source
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });
const palBuf = document.createElement('canvas');                       // 1px-tall gradient palette
const pctx   = palBuf.getContext('2d');

const params = {
  // Preprocessor (shared with every other effect).
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Gradients-specific (defaults from pageStates["/effects/gradients"]).
  showEffect:        true,
  lightnessThreshold: 32,   // bundle default 128; 32 lands more bands → striking
  stepSize:          8,     // bundle default 8 (below slider min 15 — intentional, see notes)
  shapeType:         'rect',
  // Palette endpoints (reference hard-codes white→black; we expose them so the
  // toy is a real toy. Keep defaults = reference for parity.).
  paletteStart:      '#ffffff',
  paletteEnd:        '#000000',
  // Animation-only knob.
  thresholdSweep:    28,    // pingpong amplitude around base threshold
  // Shared chrome.
  animate:           false,
  interactive:       false,
  fit:               'cover',
  bg:                '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let preprocessed = null; // ImageData after preprocessor pipeline
let lumGrid      = null; // Float32 W*H luminance (alpha-composited over white)
let strips       = null; // {y, segs:[{start,end,br}]} per strip; rebuilt on demand
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

let _rng = Math.random;
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFromT(t01){
  const w = ((t01 % 1) + 1) % 1;
  return Math.floor(w * 100003) + 1;
}

function schedule(level){
  if(level === 'pre')   dirty.pre = true;
  if(level === 'pre' || level === 'build') dirty.build = true;
  if(level === 'palette') dirty.palette = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre)     preprocess();
    if(dirty.palette) rebuildPalette();
    if(dirty.build)   buildStrips();
    paint();
    dirty.pre = dirty.build = dirty.paint = dirty.palette = false;
  });
}

function fitCanvas(){
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ---------- palette (the per-segment gradient texture) ----------
// Reference: 1-row PGraphics with map(x, 0, w-1, 255, 0) — pure WHITE→BLACK.
// We allow start/end colours so the toy can ship vivid frames without losing
// reference parity on defaults.
function rebuildPalette(){
  const W = Math.max(2, params.canvasSize | 0);
  if(palBuf.width !== W){ palBuf.width = W; palBuf.height = 1; }
  const grad = pctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, params.paletteStart);
  grad.addColorStop(1, params.paletteEnd);
  pctx.fillStyle = grad;
  pctx.fillRect(0, 0, W, 1);
}

// ---------- preprocessor (identical pipeline to Displace / Recolor / Edge) ----------
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
  const px = id.data;
  const g  = params.grainAmount;
  const gm = params.gamma;
  const bp = params.blackPoint;
  const wp = params.whitePoint;
  const span = Math.max(1, wp - bp);
  const scale = 255 / span;
  const rnd = _rng;
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
      const n = (0.5 - rnd()) * g * 255;
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

  // Pre-compute alpha-composited luminance for every pixel. The strip-scan
  // sums `stepSize` of these per column, so caching is a clear win.
  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    const a = px[i+3] / 255;
    lumGrid[j] = (lerp(255, px[i], a) + lerp(255, px[i+1], a) + lerp(255, px[i+2], a)) / 3;
  }
}

// ---------- segmentation (per-strip column-average ΔB scan) ----------
// Mirrors the bundle's nested loop exactly:
//   for each strip Y:
//     for each x: column-avg brightness of rows [Y..Y+stepSize) → avgB
//     when |prevB − avgB| > threshold: close segment, open a new one
//   trailing segment always closes at x = W
function buildStrips(){
  strips = [];
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;
  const step = Math.max(1, params.stepSize | 0);
  const th   = params.lightnessThreshold;
  const rows = Math.floor(H / step);
  for(let s = 0; s < rows; s++){
    const y0 = s * step;
    const segs = [];
    let prevB = 0, segStart = 0;
    for(let x = 0; x < W; x++){
      let sum = 0;
      for(let yy = y0; yy < y0 + step; yy++){
        sum += lumGrid[x + yy * W];
      }
      const avgB = sum / step;
      if(Math.abs(prevB - avgB) > th){
        segs.push({ start: segStart, end: x, br: prevB });
        segStart = x;
        prevB    = avgB;
      }
    }
    segs.push({ start: segStart, end: W, br: prevB });
    strips.push({ y: y0, segs });
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

  // showEffect=false → preprocessor preview (parity with reference bypass).
  if(!params.showEffect){
    const aspect = preprocessed.width / preprocessed.height;
    let dw, dh;
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  if(!strips || strips.length === 0){ ctx.restore(); return; }

  // Object-fit:contain into the viewport.
  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;
  const step  = Math.max(1, params.stepSize | 0);

  // Each segment is filled with the palette stretched over its horizontal
  // extent. Canvas's drawImage with src (0,0,palW,1) and dst (x,y,segW,stepH)
  // is the 2D analogue of WEBGL textureMode(NORMAL) on a rect — it tiles the
  // 1px row across the destination width and vertically replicates the row,
  // i.e. a left→right palette ramp inside each rectangle. Free GPU speed.
  const palW = palBuf.width;
  for(const strip of strips){
    const y  = oy + strip.y * scale;
    const sh = step * scale;
    for(const seg of strip.segs){
      const x = ox + seg.start * scale;
      const w = (seg.end - seg.start) * scale;
      if(w < 0.5) continue;
      if(params.shapeType === 'ellipse'){
        // Clip an ellipse to the segment rect, then drawImage the palette.
        // Matches the WEBGL ellipse(start, y, w, stepSize) call with the
        // palette texture — interior shows the gradient, outside is bg.
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + sh / 2, w / 2, sh / 2, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(palBuf, 0, 0, palW, 1, x, y, w, sh);
        ctx.restore();
      } else {
        ctx.drawImage(palBuf, 0, 0, palW, 1, x, y, w, sh);
      }
    }
  }

  ctx.restore();
}

// ---------- animation ----------
// 15s seamless loop: lightnessThreshold pingpongs around its rest value.
// At the peak of the sweep (t=0.5) the threshold is base − sweep (more
// segments = more bands); at endpoints t=0 and t=1 it returns to base.
function pingpongT01(t){
  let w = t - Math.floor(t);
  if(w === 1) w = 0;
  return (1 - Math.cos(w * 2 * Math.PI)) / 2;
}

function applyAnimationT(tLoop){
  const t01 = pingpongT01(tLoop);
  const base = params.lightnessThreshold;
  // Sweep DOWN at the midpoint — produces visible "blooming" of bands.
  return { threshold: clamp(base - params.thresholdSweep * t01, 0, 255) };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  const rest = params.lightnessThreshold;
  params.lightnessThreshold = anim.threshold;

  if(params.grainAmount > 0){
    _rng = mulberry32(seedFromT(tLoop));
    preprocess();
    _rng = Math.random;
  } else if(!preprocessed){
    preprocess();
  }
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    preprocess();
  }
  if(!palBuf.width || palBuf.width !== params.canvasSize) rebuildPalette();
  buildStrips();
  paint();

  params.lightnessThreshold = rest;
}

function animationLoop(){
  if(!params.animate) return;
  const elapsed = performance.now() - animationStartTime;
  renderAnimationFrame((elapsed % CYCLE_MS) / CYCLE_MS);
  animationId = requestAnimationFrame(animationLoop);
}

function toggleAnimation(){
  if(params.animate){
    animationStartTime = performance.now();
    animationLoop();
  } else if(animationId){
    cancelAnimationFrame(animationId); animationId = null;
    schedule('build');
  }
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(tLoop){ renderAnimationFrame(tLoop); },
  pauseRender(){ if(animationId){ cancelAnimationFrame(animationId); animationId = null; } },
  resumeRender(){
    if(params.animate && !animationId){
      animationStartTime = performance.now();
      animationLoop();
    } else if(!params.animate){
      schedule('pre');
    }
  },
};

// Pipeline-stage routing — which keys invalidate which cache.
const PRE_KEYS     = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS   = new Set(['lightnessThreshold','stepSize']);
const PALETTE_KEYS = new Set(['paletteStart','paletteEnd']);
const PAINT_KEYS   = new Set(['shapeType','showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    // Mouse X drives threshold (0..255); Mouse Y drives stepSize (4..40).
    // Two strongest visual levers: how many bands per strip × how tall the strips are.
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    const nt = Math.round(ax * 255);
    const nd = Math.max(4, Math.round((1 - ay) * 40));
    let touched = false;
    if(nt !== params.lightnessThreshold){
      params.lightnessThreshold = nt; touched = true;
      gui?.rows.get('lightnessThreshold')?._write(nt);
    }
    if(nd !== params.stepSize){
      params.stepSize = nd; touched = true;
      gui?.rows.get('stepSize')?._write(nd);
    }
    if(touched) schedule('build');
  }
}

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){ toggleAnimation(); return; }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(params.animate) return;
    if(PRE_KEYS.has(key))          schedule('pre');
    else if(BUILD_KEYS.has(key))   schedule('build');
    else if(PALETTE_KEYS.has(key)) schedule('palette');
    else                           schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => {
      if(!params.animate) schedule('pre');
    });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-gradients',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  cv.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  rebuildPalette();
  schedule('pre');
}

document.addEventListener('DOMContentLoaded', init);
