// pixart/bevel — port of tooooools.app/effects/bevel.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/bevel/page-06cc0cc0884808bd.js,
//  shared preprocessor + page defaults in /_next/static/chunks/9357-2a51c42cdfe973de.js).
//
// What the reference effect is (function `c` in module 2528):
//
//   loadPixels
//   a = radians(lightAngle); l = cos(a); o = sin(a)
//   for y in 1..H-2:
//     for x in 1..W-2:
//       s   = (x + y*W) * 4
//       u   = lum_alphaComposited(pixels, s)
//       c   = (round(x+l) + round(y+o)*W) * 4    // 1-px offset in light dir
//       p   = lum_alphaComposited(pixels, c) - u // signed neighbour diff
//       if abs(p) > effectThreshold:
//         t  = constrain(u + p*depth, 0, 255)
//         out[s..s+2] = t                        // 3-channel grey shading
//       else:
//         out[s..s+2] = 128                      // mid-grey "flat"
//       out[s+3] = pixels[s+3]                   // preserve source alpha
//
// Luminance is alpha-composited over white (matches Displace + Edge):
//   lum(px, i) = ( px[i]*α + 255*(1-α)
//               + px[i+1]*α + 255*(1-α)
//               + px[i+2]*α + 255*(1-α) ) / 3
//   where α = px[i+3] / 255
//
// This is *not* Phong/Lambert with a normal map. It is a 1-pixel directional
// finite-difference: the gradient component along the light vector becomes a
// "relief" multiplier. Bright-edge-toward-light = pixel pushed brighter;
// dark-edge-toward-light = pixel pushed darker. The mid-grey "else" branch
// kills the underlying image everywhere the local relief is flat, which is
// what produces the chiselled-from-stone look — only the contours survive,
// rendered as grey lift/recess deltas around a 128 base.
//
// Bundle defaults (from pageStates["/effects/bevel"] in the shared chunk):
//   depth: 20, lightAngle: 0, effectThreshold: 0
//   + preprocessor: canvasSize 600, blur 0, grain 0, gamma 1, bp 0, wp 255
//
// UI step from the page chunk: `lightAngle` is `step: 45` (so the slider snaps
// to {0, 45, 90, 135, 180, 225, 270, 315, 360}); `effectThreshold` is `step: .01`
// over 0..4; `depth` is integer 0..500.
//
// Why `depth` is unbounded by 1 (0..500): when threshold is small, almost every
// pixel hits the "if" branch and the multiplier amplifies the neighbour-diff
// into hard high-contrast embossing. At depth=20 the relief is subtle and
// striking; at depth=500 it's near-binarised hard edges.
//
// Pixart deviations (documented per project conventions):
//   - Landing-frame `lightAngle: 45` rather than 0 — a diagonal light reads
//     more obviously 3D than a horizontal one and survives on portrait and
//     landscape sources alike. The bundle ships 0; we ship 45.
//   - `depth` default kept at the bundle's 20.
//   - `effectThreshold` default kept at the bundle's 0 (every pixel embosses).
//   - Standard pixart additions: animate / interactive / fit / bg.
//
// Animation: sweep `lightAngle` 0→360° monotonically across the 15s loop. This
// is the only knob whose value at 360° equals its value at 0° (cos/sin are
// 2π-periodic), so the loop closes byte-equal without a pingpong. The visual
// is a rotating light source — the relief shifts hemisphere around the image
// like a moving raking light, which is exactly how a real bevel "reads".
//
// Determinism: when grain is non-zero the grain RNG is mulberry32 seeded from
// t_loop. The finite-difference is deterministic. renderAt(0) === renderAt(1)
// byte-equal for export.
//
// Performance: 600×600 source ≈ 360k pixels × 2 lum reads × cheap arithmetic
// ≈ 4–6 ms per frame on M-series, well under the 30 ms budget at 1280×720.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Offscreen buffer for the preprocessed source.
const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

// Output ImageData we writePixels into each build, then drawImage-scale to cv.
const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d');

const params = {
  // Preprocessor (shared with Displace / Edge / Ascii).
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  // Bevel-specific (bundle defaults; landing-frame override on lightAngle).
  depth:             20,
  lightAngle:        45,   // bundle ships 0; 45 reads more 3D on first paint
  effectThreshold:   0,
  showEffect:        true,
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
let preprocessed = null; // ImageData of srcBuf after pipeline
let lumGrid = null;      // Float32Array of W*H alpha-composited luminance
let outData = null;      // ImageData written by buildBevel
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

// mulberry32 — deterministic RNG seeded per-frame for the seamless loop.
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
  if(level === 'pre') dirty.pre = true;
  if(level === 'pre' || level === 'build') dirty.build = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre)   preprocess();
    if(dirty.build) buildBevel();
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

// ---------- preprocessor (identical to Displace/Edge; shared semantics) ----------
function preprocess(){
  const srcCv = window.PIXSource?.getCanvas();
  if(!srcCv) return;
  const aspect = srcCv.height / srcCv.width;
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

  // Precompute alpha-composited luminance. The bevel inner loop reads 2 of
  // these per pixel (centre + neighbour), so the LUT pays off immediately and
  // keeps the per-frame cost roughly the same as a single ImageData scan.
  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    const a = px[i+3] / 255;
    lumGrid[j] = (lerp(255, px[i], a) + lerp(255, px[i+1], a) + lerp(255, px[i+2], a)) / 3;
  }

  // Allocate the output ImageData up-front so build() just writes into it.
  if(!outData || outData.width !== W || outData.height !== H){
    outData = octx.createImageData(W, H);
  }
}

// ---------- bevel build (mirrors module-2528 function `c`) ----------
function buildBevel(){
  if(!preprocessed || !outData){ return; }
  const W = preprocessed.width, H = preprocessed.height;
  const px = preprocessed.data;
  const out = outData.data;
  const depth = params.depth;
  const th    = params.effectThreshold;
  // Reference uses radians, then Math.round(x + cos(a)) — i.e. a 1-pixel
  // neighbour that snaps to one of {(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),...}.
  // We replicate that snap so the result is byte-identical to the reference
  // at integer lightAngle values.
  const rad = (params.lightAngle * Math.PI) / 180;
  const lx  = Math.cos(rad);
  const ly  = Math.sin(rad);
  // Per-pixel offset in luminance grid units. At any integer x the neighbour
  // index is (round(x+lx) - x) on the x axis and similarly for y; these are
  // constant across the grid, so hoist them.
  const dx = Math.round(lx); // -1, 0, or 1
  const dy = Math.round(ly); // -1, 0, or 1
  const dOff = dx + dy * W;  // signed offset in the W*H luminance buffer

  // Borders (the reference iterates 1..W-2, 1..H-2; the outer rim is left
  // untouched, i.e. alpha=0 in the output). We fill the rim with mid-grey
  // alpha-0 so it composes invisibly against the bg.
  // First clear the whole buffer to (0,0,0,0); putImageData replaces, not
  // composes, so transparent rim is fine.
  out.fill(0);

  // If dOff drops the neighbour outside the buffer for some y range, clamp
  // the iteration window. With |dx|,|dy| <= 1 the safe interior is the same
  // 1..W-2, 1..H-2 the reference uses.
  const x0 = 1, x1 = W - 1;
  const y0 = 1, y1 = H - 1;

  for(let y = y0; y < y1; y++){
    const rowL = y * W;
    for(let x = x0; x < x1; x++){
      const j = rowL + x;          // luminance index
      const i = j * 4;             // pixel index (RGBA)
      const u = lumGrid[j];
      const p = lumGrid[j + dOff] - u;
      let v;
      if((p < 0 ? -p : p) > th){
        v = u + p * depth;
        if(v < 0)   v = 0;
        if(v > 255) v = 255;
      } else {
        v = 128;
      }
      out[i]     = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = px[i + 3];
    }
  }
  octx.putImageData(outData, 0, 0);
}

// ---------- paint ----------
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!preprocessed){ ctx.restore(); return; }

  // showEffect=false → preprocessor preview (bundle bypass path).
  if(!params.showEffect){
    const aspect = preprocessed.width / preprocessed.height;
    let dw, dh;
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  // object-fit:contain into the canvas so the bevel never crops.
  const sw = outBuf.width, sh = outBuf.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;

  // Hard-edged bevel pixels read better unsmoothed at typical scales.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(outBuf, ox, oy, dw, dh);

  ctx.restore();
}

// ---------- animation ----------
//
// Pure monotonic sweep of lightAngle 0→360°. cos/sin are 2π-periodic so the
// frame at t=1 (angle=360°) is exactly the frame at t=0 (angle=0°). No
// pingpong needed; the loop closes by construction.
function applyAnimationT(tLoop){
  const tWrap = ((tLoop % 1) + 1) % 1;
  // At tWrap=1 (which we never see because of the mod) angle would be 360;
  // at tWrap=0 angle is 0. Identical neighbour offset → identical output.
  return { lightAngle: tWrap * 360 };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  const restAngle = params.lightAngle;
  params.lightAngle = anim.lightAngle;

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
  buildBevel();
  paint();

  params.lightAngle = restAngle;
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

// Which keys touch which pipeline stage.
const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['depth','lightAngle','effectThreshold']);
const PAINT_KEYS = new Set(['showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    // Mouse X drives lightAngle (0..360), Mouse Y drives depth (0..200).
    // These are the two most expressive bevel controls.
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    const nAng = Math.round(ax * 360);
    const nDep = Math.round((1 - ay) * 200);
    let touched = false;
    if(nAng !== params.lightAngle){
      params.lightAngle = nAng; touched = true;
      gui?.rows.get('lightAngle')?._write(nAng);
    }
    if(nDep !== params.depth){
      params.depth = nDep; touched = true;
      gui?.rows.get('depth')?._write(nDep);
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
    if(params.animate) return; // anim loop owns the frame
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => {
      if(!params.animate) schedule('pre');
    });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-bevel',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  cv.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
}

document.addEventListener('DOMContentLoaded', init);
