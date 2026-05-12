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
// Parameters ported 1:1 from tooooools (see displace-research.md).
//
// Determinism: when seeded by t_loop, the grain RNG is mulberry32 and yaw is
// pure trig in t_loop, so renderAt(0) === renderAt(1) byte-equal.
//
// ---- Refinement pass (2026-05-13) ----
//
// `mode` selects one of six envelopes (idle / breath / rotate / pulse /
// march / swirl). Each animates a different subset of params; everything
// else holds at its slider value. The Z-component carries two new
// expressive knobs:
//
//   eddyScale — scales the Z height of every dot. Multiplier in 1..40, where
//               1 = parity with previous behaviour and 40 = a near-vertical
//               column of dots. Reads as the dot-cloud "rising" off the page.
//   vorticity — a curl-like bias: shifts Z by `vorticity · (R - G)` so warm
//               hues lift, cool hues sink (or vice versa). Breaks the
//               top/bottom symmetry an alpha-luminance cloud otherwise has,
//               and is what makes a `swirl` orbit read as a real 3D object
//               rather than a 2D dot field.
//
// Cursor focus: in interactive mode, the cursor is a *displacement basin*.
// Inside `focusRadius` (screen px → projected to source space), Z gets
// +eddyScale · (1 − r²/R²) added, so the local area lifts toward the
// camera. Falloff is a cheap quadratic Gaussian approximation (Iñigo
// Quilez, "Domain warping").
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
  // ---- Refinement pass (2026-05-13) ----
  mode:          'breath',
  // Z-component multiplier. `swirl` reads best at eddyScale ≥ 4.
  eddyScale:     1,
  // Curl-like bias on Z. Breaks the top-bottom symmetry an alpha-luminance
  // cloud otherwise has. Range [-1, +1] — sign flip swaps which channel lifts.
  vorticity:     0,
  // Cursor focus-radius (screen px). Inside the circle, Z gets a quadratic
  // bump scaled by `eddyScale`. Outside, no spatial override.
  focusRadius:   240,
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

// Transient module globals for per-mode state. They are read by buildDots /
// paint each frame and reset by renderAnimationFrame after the frame is
// committed. This keeps the inner loops branchless when animation is off.
let _yawAnim   = null;  // override viewYaw for this frame (rotate, swirl)
let _pitchAnim = null;  // override pitch for this frame (swirl)
let _yScale    = 1;     // multiplies yDisplacement (pulse, march)
let _marchLevel = null; // discrete Z scale step in [0,1] for march mode
// Cursor focus state (source-space). _focusR2 == 0 ⇒ feature off.
let _focusCx = -1, _focusCy = -1, _focusR2 = 0;

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
// levels (clamp-stretch).
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
}

// ---------- dot cloud build (tooooools' generatePixels, refined) ----------
//
// Walk the preprocessed source on a `pixelDensity` grid. For each cell the
// Z component is:
//
//   z_base = (lum / 255) · yDisplacement · eddyScale · _yScale
//   z_curl = vorticity · (R - G)              // breaks top/bottom symmetry
//   z_focus = (inside cursor circle) ? eddyScale · yDisplacement · (1 - r²/R²)
//           : 0
//   z = (march mode) ? z_base × _marchLevel  : z_base
//       + z_curl + z_focus
//
// `march` snaps Z onto 4 discrete heights so the cloud appears to step
// upward in slabs — a classic Bauhaus-poster cue.
function buildDots(){
  if(!preprocessed){ dotCount = 0; return; }
  const W = preprocessed.width, H = preprocessed.height;
  const px = preprocessed.data;
  const stride = Math.max(1, params.pixelDensity | 0);
  const z0 = params.yDisplacement * params.eddyScale * _yScale;
  const curlK = params.vorticity;
  const useFocus = _focusR2 > 0;
  const focusGain = params.eddyScale * params.yDisplacement;
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
      let z = (lum / 255) * z0;
      if(_marchLevel !== null){
        // Step-march onto 4 height tiers. Same input lum → same tier across t.
        z = Math.floor((lum / 255) * 4) / 4 * z0 * _marchLevel;
      }
      // Curl bias. Sign of (R - G) labels each dot warm vs cool; vorticity
      // selects how strongly that label pushes the dot out of the plane.
      z += curlK * (r - g);
      if(useFocus){
        const dx = x - _focusCx, dy = y - _focusCy;
        const d2 = dx*dx + dy*dy;
        if(d2 < _focusR2){
          const k = 1 - d2 / _focusR2;
          z += focusGain * k;
        }
      }
      const o = n * 6;
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
// Oblique axonometric projection. Each dot's z shifts its screen position
// along the rotated "up" axis. Painter's algorithm by Z ensures depth order.
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

  if(!dots || dotCount === 0){ ctx.restore(); return; }

  const cs = params.canvasSize;
  const ch = preprocessed.height;
  const fitScale = Math.min(W, H) * 0.9 / Math.max(cs, ch);
  const cx = W / 2, cy = H / 2;

  // Effective yaw/pitch may be overridden by the animation envelope.
  const yawDeg   = _yawAnim   !== null ? _yawAnim   : params.viewYaw;
  const pitchDeg = _pitchAnim !== null ? _pitchAnim : params.pitch;
  const yawR   = (yawDeg   * Math.PI) / 180;
  const pitchR = (pitchDeg * Math.PI) / 180;
  const zx = Math.cos(yawR) * Math.sin(pitchR);
  const zy = -Math.sin(yawR) * Math.sin(pitchR);

  const ds = Math.max(1, params.dotSize * fitScale * 0.5);
  // Painter's algorithm by raw Z. Sign chooses front-vs-back depending on the
  // projection "up" direction so the visible front stays on top regardless
  // of orbit position. Insertion sort is fine for 1k–6k dots.
  const order = new Int32Array(dotCount);
  for(let i = 0; i < dotCount; i++) order[i] = i;
  const sortSign = zy >= 0 ? 1 : -1;
  for(let i = 1; i < dotCount; i++){
    const v = order[i];
    const vz = dots[v * 6 + 2] * sortSign;
    let j = i - 1;
    while(j >= 0 && dots[order[j] * 6 + 2] * sortSign > vz){
      order[j + 1] = order[j]; j--;
    }
    order[j + 1] = v;
  }

  // fillRect at the same size is ~3x faster than arc() and visually
  // indistinguishable below ~5px.
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
// 15s seamless loop. Every envelope is a pure function of t_loop wrapped to
// [0,1) so cos(2π·t)==cos(0)==1 in IEEE-754 and renderAt(0) byte-equals
// renderAt(1). Each mode animates ONLY its named parameter subset; the
// others hold at slider value.
//
//   idle    : everything holds. The rest frame IS the artwork.
//   breath  : cosine pingpong on yaw + pitch (the original sweep) — calm,
//             foveal, reads as the field "breathing".
//   rotate  : yaw runs monotonic 0→360°, pitch holds. The dot cloud reads
//             as a 3D object on an orbital pedestal (Vasarely Vega-Nor).
//   pulse   : yDisplacement spikes (sharp 0→1 in t<0.2) then decays. A
//             single flashbulb-style swell each cycle.
//   march   : Z snaps onto 4 discrete tiers and steps through them. With
//             seam-override at t=1 → tier 0 (== t=0). Bauhaus-poster cue.
//   swirl   : yaw 0→360° AND pitch 0→3·360° (coprime ratio). The projection
//             traces a Lissajous orbit; the eye locks onto the closed curve
//             as one continuous motion (Lissajous, 1857).
function applyAnimationT(tLoop){
  let t = tLoop - Math.floor(tLoop);
  if(t === 1) t = 0;
  const pp = (1 - Math.cos(t * 2 * Math.PI)) / 2;     // pingpong, peaks at 0.5
  let yawAnim = null, pitchAnim = null, yScale = 1, marchLevel = null;
  switch(params.mode){
    case 'rotate': {
      // Monotonic yaw sweep. Pitch holds at slider. cos/sin 2π-periodic so
      // the frame at t=1 equals t=0 by construction.
      yawAnim = t * 360;
      break;
    }
    case 'pulse': {
      // Asymmetric spike: sharp attack, slow decay. yDisplacement peaks
      // 2.4× midway through the attack and returns to 1× by t=1.
      const env = t < 0.2 ? t / 0.2 : Math.pow(1 - (t - 0.2) / 0.8, 2.5);
      yScale = 1 + 1.4 * env;
      break;
    }
    case 'march': {
      // 4 discrete tiers; floor() snaps. Seam-override: at t=1 force tier 0
      // so renderAt(1) byte-equals renderAt(0).
      const steps = 4;
      const idx = t === 0 ? 0 : Math.min(steps - 1, Math.floor(t * steps));
      marchLevel = (idx + 1) / steps;         // 0.25, 0.5, 0.75, 1.0
      break;
    }
    case 'swirl': {
      // Lissajous: yaw 1× and pitch 3×, monotonic in both, coprime ratio.
      // Both wrap exactly at t=0/t=1 because sin/cos are 2π-periodic.
      yawAnim   = t * 360;
      pitchAnim = 30 + 30 * (1 - Math.cos(t * 2 * Math.PI * 3)) / 2;
      break;
    }
    case 'idle': {
      // No-op.
      break;
    }
    case 'breath':
    default: {
      // Original behaviour: yaw 0→360° monotonic, pitch cosine pingpong.
      yawAnim   = t * 360;
      pitchAnim = 30 + pp * 30;
      break;
    }
  }
  return { yawAnim, pitchAnim, yScale, marchLevel };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  _yawAnim    = anim.yawAnim;
  _pitchAnim  = anim.pitchAnim;
  _yScale     = anim.yScale;
  _marchLevel = anim.marchLevel;

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
  buildDots();
  paint();

  _yawAnim = null; _pitchAnim = null; _yScale = 1; _marchLevel = null;
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

// Pipeline-stage routing. Most knobs only need a rebuild; the projection
// knobs (viewYaw, pitch, dotSize, showEffect) are paint-only.
const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['pixelDensity','yDisplacement','eddyScale','vorticity']);
const PAINT_KEYS = new Set(['dotSize','viewYaw','pitch','showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive){
    if(!preprocessed) return;
    // Map cursor from canvas-space to source-space so the focus basin tracks
    // across canvas-size changes. The dot cloud is drawn centred at fitScale,
    // so reverse that mapping.
    const W = cv.width, H = cv.height;
    const cs = params.canvasSize, ch = preprocessed.height;
    const fitScale = Math.min(W, H) * 0.9 / Math.max(cs, ch);
    const cx = W / 2, cy = H / 2;
    // Source-space coords (origin at top-left of source buffer).
    const sx = (mouseX - cx) / fitScale + preprocessed.width  / 2;
    const sy = (mouseY - cy) / fitScale + preprocessed.height / 2;
    const rSrc = params.focusRadius / fitScale;
    _focusCx = sx; _focusCy = sy; _focusR2 = rSrc * rSrc;
    if(!params.animate) schedule('build');
  } else if(_focusR2 !== 0){
    _focusR2 = 0;
    if(!params.animate) schedule('build');
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
    if(key === 'mode'){ /* anim envelope changes; no static rebuild needed */ return; }
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
