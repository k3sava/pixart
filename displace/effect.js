// pixart/displace — port of tooooools.app/effects/displace.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/effects/displace/page-94d478f52043269a.js,
//  shared preprocessor in /_next/static/chunks/9357-*.js).
//
// The reference is NOT a UV-warp displacement (no x' = x + scaleX·R sampling).
// It is a 3D dot-cloud where each grid cell becomes one dot whose Z is driven
// by the alpha-composited luminance of the source after a preprocessor pipeline
// (Blur → Grain → Gamma → Levels). The cloud is rendered in p5 WEBGL with a
// perspective camera + orbitControl, so the user spins the field by dragging.
//
// We're on a 2D canvas (no WebGL stack in pixart), so we project the cloud
// with an oblique axonometric matrix:
//
//     screen.x = world.x + cos(yaw)·sin(pitch) · z
//     screen.y = world.y - sin(yaw)·sin(pitch) · z   (Y is down in canvas)
//
// At yaw=0 it collapses to a top-down view (no apparent displacement). At
// yaw=90°/pitch=45° you get the classic tooooools.app look: dots sheared
// upward along their luminance. Yaw sweeps 0→360° across the 15s loop so the
// motion is seamless (cos/sin both wrap).
//
// Parameters ported 1:1 from tooooools:
//   canvasSize    100..1000   600    grid extent in source pixels
//   blurAmount    0..10       0      p5 BLUR kernel radius — approximated by 2D box-blur
//   grainAmount   0..1 step.1 0      additive luminance noise
//   gamma         0.1..2      1      pow(v/255, gamma)
//   blackPoint    0..255      0      levels in
//   whitePoint    0..255      255    levels in
//   pixelDensity  4..20       8      grid stride (a.k.a. "Step Size")
//   yDisplacement -500..500   180    z range from luminance
//   dotSize       4..100      8      stroke weight (point diameter)
//   showEffect    bool        true   bypass shows preprocessed image
//
// Additions to make 2D-canvas viable + match the wordart contract:
//   viewYaw       0..360      55     rotates the projection (the orbitControl
//                                    drag-yaw equivalent). 0 = top-down.
//   pitch         0..90       45     tilt of the projection.
//   bgMode        select      'dark' inherited shared bg colour vs auto.
//   animate/interactive — standard pixart contract.
//
// Determinism: when seeded by t_loop, the grain RNG is mulberry32 and yaw is
// pure trig in t_loop, so renderAt(0) === renderAt(1) byte-equal.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Offscreen buffer for the preprocessed source. We sample its pixels each
// build, then draw screen-space dots.
const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  canvasSize:    600,
  blurAmount:    0,
  grainAmount:   0,
  gamma:         1,
  blackPoint:    0,
  whitePoint:    255,
  pixelDensity:  8,
  yDisplacement: 180,
  dotSize:       8,
  showEffect:    true,
  viewYaw:       55,   // landing frame: clear oblique read
  pitch:         45,
  animate:       false,
  interactive:   false,
  fit:           'cover',
  bg:            '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let preprocessed = null; // ImageData of srcBuf after pipeline
let dots = null;         // Float32-packed: [x, y, z, r, g, b] per dot
let dotCount = 0;
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
    if(dirty.build) buildDots();
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

// ---------- preprocessor (matches tooooools' /utils/preprocessor) ----------
//
// Order is load-bearing: blur first (operates on raw colour), then grain
// (adds noise that survives the rest), then gamma (perceptual curve), then
// levels (clamp-stretch). This is the exact order in the reference bundle.
function preprocess(){
  // Square buffer at canvasSize — tooooools uses canvasSize × (size*h/w).
  // We mirror that aspect so dot layout matches the live reference.
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
  // 1) draw source into the working buffer at canvasSize.
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(srcCv, 0, 0, W, H);
  sctx.restore();

  // 2) Blur — p5.filter(BLUR, n) is a separable Gaussian-ish. Canvas's
  //    `filter:'blur(npx)'` is a close stand-in and is GPU-accelerated.
  if(params.blurAmount > 0){
    // Re-rasterise through CSS filter for a fast box-blur. Round-trip via a
    // temp canvas to avoid leaving filter state on the working ctx.
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const t = tmp.getContext('2d');
    t.filter = `blur(${params.blurAmount}px)`;
    t.drawImage(srcBuf, 0, 0);
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(tmp, 0, 0);
  }

  // 3) Grain + 4) Gamma + 5) Levels — single pixel pass, cache-friendly.
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
  // Precompute gamma LUT — pow() is slow inside a 600k-pixel loop.
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
}

// ---------- dot cloud build (tooooools' generatePixels) ----------
//
// Walk the preprocessed source on a `pixelDensity` grid. For each cell:
//   alphaComp = (lerp(255,R,a) + lerp(255,G,a) + lerp(255,B,a)) / 3
//   z         = map(alphaComp, 0..255, 0..yDisplacement)
//   color     = source's (R,G,B) at that cell
//
// `alphaComp` is "luminance composited over white". Brighter pixels → larger z.
function buildDots(){
  if(!preprocessed){ dotCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const px = preprocessed.data;
  const stride = Math.max(1, params.pixelDensity | 0);
  const z0 = params.yDisplacement;
  // Worst-case dot count, allocated once. 6 floats per dot.
  const cap = Math.ceil(W / stride) * Math.ceil(H / stride);
  if(!dots || dots.length < cap * 6) dots = new Float32Array(cap * 6);
  let n = 0;
  for(let y = 0; y < H; y += stride){
    for(let x = 0; x < W; x += stride){
      const i = (x + y * W) * 4;
      const r = px[i], g = px[i+1], b = px[i+2];
      const a = px[i+3] / 255;
      // alpha-composite over white, then mean of channels — matches reference.
      const lum = (lerp(255, r, a) + lerp(255, g, a) + lerp(255, b, a)) / 3;
      const z   = (lum / 255) * z0;
      const o = n * 6;
      // Centre the cloud so the projection pivots in the middle.
      dots[o]   = x - W / 2;
      dots[o+1] = y - H / 2;
      dots[o+2] = z;
      dots[o+3] = r;
      dots[o+4] = g;
      dots[o+5] = b;
      n++;
    }
  }
  dotCount = n;
}

// ---------- paint ----------
//
// Oblique axonometric projection. The reference camera is a fixed perspective
// at (400, 600, 1200) looking at origin with orbitControl spinning yaw + pitch.
// We approximate with a 2D shear: each dot's z shifts its screen position
// along the rotated "up" axis. This produces the same parallax / spread look.
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!preprocessed){ ctx.restore(); return; }

  // showEffect=false → draw the preprocessed image and bail (matches reference
  // bypass path).
  if(!params.showEffect){
    const aspect = preprocessed.width / preprocessed.height;
    let dw, dh;
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
    ctx.drawImage(srcBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  if(!dots || dotCount === 0){ ctx.restore(); return; }

  // Fit-to-canvas scale: the dot cloud lives in canvasSize × canvasSize·aspect
  // world units; scale so the largest dimension fills ~90% of the canvas.
  const cs = params.canvasSize;
  const ch = preprocessed.height;
  const fitScale = Math.min(W, H) * 0.9 / Math.max(cs, ch);
  const cx = W / 2, cy = H / 2;

  const yawR   = (params.viewYaw   * Math.PI) / 180;
  const pitchR = (params.pitch     * Math.PI) / 180;
  const zx = Math.cos(yawR) * Math.sin(pitchR);
  // Y is down in canvas, so negate for a natural "up" sky tilt.
  const zy = -Math.sin(yawR) * Math.sin(pitchR);

  const ds = Math.max(1, params.dotSize * fitScale * 0.5);
  // Painter's algorithm: depth-sort so back dots draw first. Use the projected
  // y as a cheap depth proxy — works because dots with larger z move along
  // the projection axis and we want the highest-z (or lowest, depending on
  // yaw) to render last. We sort indices by (zy>0 ? z : -z) so the visible
  // "front" stays on top.
  const order = new Int32Array(dotCount);
  for(let i = 0; i < dotCount; i++) order[i] = i;
  const sortSign = zy >= 0 ? 1 : -1;
  // Insertion sort is fine for typical 1k–6k dots. Array.sort with closure is
  // slower; we inline.
  for(let i = 1; i < dotCount; i++){
    const v = order[i];
    const vz = dots[v * 6 + 2] * sortSign;
    let j = i - 1;
    while(j >= 0 && dots[order[j] * 6 + 2] * sortSign > vz){
      order[j + 1] = order[j]; j--;
    }
    order[j + 1] = v;
  }

  // Draw. Filling tiny circles via ctx.arc per dot is the bottleneck at
  // 5k+ dots. fillRect at the same size is ~3x faster and visually
  // indistinguishable below ~6px. We branch.
  const useRects = params.dotSize * fitScale < 5;
  for(let k = 0; k < dotCount; k++){
    const o = order[k] * 6;
    const wx = dots[o], wy = dots[o+1], z = dots[o+2];
    const sx = cx + (wx + zx * z) * fitScale;
    const sy = cy + (wy + zy * z) * fitScale;
    const r = dots[o+3] | 0, g = dots[o+4] | 0, b = dots[o+5] | 0;
    ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
    if(useRects){
      ctx.fillRect(sx - ds, sy - ds, ds * 2, ds * 2);
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, ds, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

// ---------- animation ----------
//
// 15s seamless loop: yaw sweeps 0→360°, pitch oscillates between 30° and 60°
// on a pingpong. These are pure functions of t_loop so the loop closes.
function applyAnimationT(tLoop){
  const tWrap = ((tLoop % 1) + 1) % 1;
  const t01   = (1 - Math.cos(tWrap * 2 * Math.PI)) / 2;
  params.viewYaw = tWrap * 360;
  params.pitch   = 30 + t01 * 30;
  if(gui){
    gui.rows.get('viewYaw')?._write(Math.round(params.viewYaw));
    gui.rows.get('pitch')?._write(Math.round(params.pitch));
  }
}

function renderAnimationFrame(tLoop){
  applyAnimationT(tLoop);
  // Re-seed grain deterministically so endpoints match for export.
  if(params.grainAmount > 0){
    _rng = mulberry32(seedFromT(tLoop));
    preprocess();
    _rng = Math.random;
    buildDots();
  }
  // Video sources: pull the current frame into PIXSource then redo pre/build.
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    // advanceFrame fires onChange → schedule('pre'), but we want it now.
    preprocess(); buildDots();
  }
  paint();
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

// Keys that need a fresh preprocess pass (anything that mutates the pixel
// buffer). pixelDensity / yDisplacement / dotSize / view* are paint-or-build.
const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['pixelDensity','yDisplacement']);
const PAINT_KEYS = new Set(['dotSize','viewYaw','pitch','showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    // Mouse X drives viewYaw (0..360), Mouse Y drives pitch (0..90).
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    const ny = Math.round(ax * 360);
    const np = Math.round(ay * 90);
    let touched = false;
    if(ny !== params.viewYaw){ params.viewYaw = ny; touched = true; gui?.rows.get('viewYaw')?._write(ny); }
    if(np !== params.pitch){   params.pitch   = np; touched = true; gui?.rows.get('pitch')?._write(np); }
    if(touched) schedule('paint');
  }
}

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){ toggleAnimation(); return; }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      // bg is paint-only; fit changes the source canvas → pre.
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
      canvas: cv, name: 'pixart-displace',
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
