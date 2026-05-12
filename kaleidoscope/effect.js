// pixart/kaleidoscope — N-fold rotational + mirror symmetry on a UV warp.
//
// What it is (single sentence): for each output pixel (x,y) compute polar
// coordinates (r, θ) about a fold origin, fold θ into the wedge [0, 2π/N]
// (with mirror reflection on alternate wedges so the seam is continuous),
// then sample the source at (r·cos θ', r·sin θ'). Recursive depth folds the
// fold. This is the same UV-warp family as distort, only the warp is polar
// rather than image-driven.
//
// Why polar fold and not a tessellation grid:
//   - Brewster's original kaleidoscope (1816) is two mirrors at angle π/N
//     producing N-fold rotational + mirror symmetry — algebraically identical
//     to "θ mod 2π/N with alternate-wedge reflection". We are emulating
//     Brewster's instrument, not Escher's Circle-Limit (which is hyperbolic
//     and needs Möbius transforms, not Euclidean fold).
//   - Sampling once per output pixel keeps the cost O(W·H) — fast enough for
//     interactive sliders. Recursive depth multiplies by depth, not by N.
//
// References baked into the implementation:
//   - Brewster, D. (1816) *A Treatise on the Kaleidoscope*. Takeaway: the
//     two-mirror angle θ = π/N is the geometric primitive; everything else
//     (object cell, rotation, zoom) is decoration around that primitive.
//   - Quilez, I. *Polar coordinates & symmetry*
//     (iquilezles.org/articles/symmetry). Takeaway: mod-fold the angle, flip
//     alternate slices for mirror seams. This is the implementation here.
//   - Escher, M.C. *Circle Limit III* (1959). Takeaway: rotational tilings
//     read as "infinite" because the eye can't tell where the tile ends —
//     we reproduce that with recursive zoom (fold the fold).
//   - Manfred Mohr *P-018* (1969). Takeaway: algorithmic symmetry alone is
//     enough to feel composed — Mohr proved this with a plotter and a few
//     hundred lines of FORTRAN.
//   - Shadertoy MdSfDz gallery. Takeaway: an angle offset that rotates
//     monotonically across the loop produces the canonical "kaleidoscope
//     spin" without any other animation.
//
// 15s seamless loop discipline: every envelope wraps t to [0,1), the
// segment-count `breath` envelope returns to its t=0 value at t=1 by
// construction, `spin` adds exactly 2π (≡ 0 mod 2π), `march` snaps to the
// same tier at t=0 and t=1, `pulse` and `recurse` are cosine pingpongs.
// → renderAt(0) byte-equals renderAt(1).
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });
const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d');

const params = {
  // Preprocessor (shared with edge / distort / flow-field).
  canvasSize:  600,
  blurAmount:  0,
  grainAmount: 0,
  gamma:       1,
  blackPoint:  0,
  whitePoint:  255,
  // Kaleidoscope-specific.
  mode:        'idle',
  // Default = classic 8-fold; mirror on; zoom 1.2 for a richer field on
  // first paint. Per the brief: "8 segments, mirror on, zoom 1.2, no tint."
  segments:    8,
  angleOffset: 0,
  mirror:      true,
  // Normalised offset of the polar origin within the source [-1..1].
  sampleX:     0,
  sampleY:     0,
  // Radial multiplier — values > 1 zoom into the cell, < 1 zoom out so
  // more of the source bleeds in.
  zoom:        1.2,
  recurseDepth: 0,
  tint:        '#00000000',
  seed:        42,
  // Cursor moves the fold origin in interactive mode.
  focusRadius: 220,
  // Shared chrome.
  animate:     false,
  interactive: false,
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let preprocessed = null;
let dirty = { pre: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// Transient module globals — written by renderAnimationFrame, read by warp().
// All reset at frame end so the static-render path stays branchless.
let _segAnim     = null;
let _angleAnim   = null;
let _zoomAnim    = null;
let _depthAnim   = null;
let _sampleXAnim = null;
let _sampleYAnim = null;

// ── helpers ──────────────────────────────────────────────────
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

// ── preprocessor (canonical pipeline) ────────────────────────
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
    if(doGamma){ r = lut[r|0]; gg = lut[gg|0]; b = lut[b|0]; }
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

// ── colour helpers ───────────────────────────────────────────
function parseHexA(s){
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(s||''));
  if(!m) return null;
  const v = parseInt(m[1], 16);
  const a = m[2] !== undefined ? parseInt(m[2], 16) : 255;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, a];
}

// ── warp: the kaleidoscope itself ────────────────────────────
//
// For each output pixel:
//   1. (x,y) → (dx,dy) centred on canvas, scaled by zoom.
//   2. (r,θ) = polar(dx,dy).
//   3. θ' = fold(θ + angleOffset) into wedge [0, 2π/N]; if mirror, reflect
//      alternate wedges. This is the Brewster two-mirror primitive.
//   4. (sx,sy) = source-centre + (r·cos θ', r·sin θ'), offset by (sampleX,sampleY).
//   5. Sample preprocessed source at (sx,sy) (nearest neighbour — bilinear
//      would be smoother but the symmetry seams stay anti-aliased by the
//      perceptual fold itself).
//   6. recurseDepth: re-fold the result coordinate D times. Each pass
//      compounds N-fold symmetry into N^D-fold effective symmetry — but
//      because the source is finite, the result reads as fractal recursion
//      rather than dense rotation.
function warp(){
  if(!preprocessed) return null;
  const W = preprocessed.width, H = preprocessed.height;
  const src = preprocessed.data;
  const out = octx.createImageData(W, H);
  const o = out.data;

  const N = Math.max(2, Math.round(_segAnim !== null ? _segAnim : params.segments));
  const wedge = (Math.PI * 2) / N;
  const angOff = _angleAnim !== null ? _angleAnim : params.angleOffset;
  const zoom = _zoomAnim !== null ? _zoomAnim : params.zoom;
  const depth = Math.max(0, Math.round(_depthAnim !== null ? _depthAnim : params.recurseDepth));
  const sxN = _sampleXAnim !== null ? _sampleXAnim : params.sampleX;
  const syN = _sampleYAnim !== null ? _sampleYAnim : params.sampleY;
  const mirror = params.mirror;

  const cx = W * 0.5, cy = H * 0.5;
  // Sample origin offset in source pixels (normalised −1..1 across a half-extent).
  const ox = cx + sxN * cx;
  const oy = cy + syN * cy;
  const invZ = 1 / Math.max(0.01, zoom);

  const tint = parseHexA(params.tint);
  const tA = tint ? tint[3] / 255 : 0;

  for(let y = 0; y < H; y++){
    const dy0 = (y - cy);
    for(let x = 0; x < W; x++){
      const dx0 = (x - cx);
      // Polar; scale by zoom so zoom>1 pulls a smaller region across the cell.
      let r  = Math.hypot(dx0, dy0) * invZ;
      let th = Math.atan2(dy0, dx0) + angOff;

      // The fold. Reduce th into wedge [0, wedge). Mirror alternate slices.
      for(let d = 0; d <= depth; d++){
        // Bring into [0, 2π)
        let a = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const slice = Math.floor(a / wedge);
        a -= slice * wedge;
        if(mirror && (slice & 1)) a = wedge - a;
        th = a;
        // Recursive: re-add bias to angle and re-fold. Because we already
        // collapsed into the wedge, adding a stepped bias creates a finer
        // sub-fold each iteration — the "fold the fold" effect.
        if(d < depth) th += wedge * 0.5 + angOff;
      }

      // Back to Cartesian, anchored at the (possibly off-centre) sample origin.
      const sx = ox + r * Math.cos(th);
      const sy = oy + r * Math.sin(th);

      // Wrap (toroidal) so we never leave a black halo at high zoom.
      let ix = ((sx | 0) % W + W) % W;
      let iy = ((sy | 0) % H + H) % H;
      const si = (ix + iy * W) * 4;
      const oi = (x + y * W) * 4;

      let R = src[si], G = src[si+1], B = src[si+2];
      if(tA > 0){
        R = lerp(R, tint[0], tA);
        G = lerp(G, tint[1], tA);
        B = lerp(B, tint[2], tA);
      }
      o[oi]   = R;
      o[oi+1] = G;
      o[oi+2] = B;
      o[oi+3] = 255;
    }
  }
  octx.putImageData(out, 0, 0);
  return outBuf;
}

// ── paint ────────────────────────────────────────────────────
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);

  if(!preprocessed){ ctx.restore(); return; }

  const surface = warp() || srcBuf;
  const aspect = surface.width / surface.height;
  let dw, dh;
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(surface, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ── animation envelopes ──────────────────────────────────────
//
//   idle    — static fold. Rest frame is the artwork.
//   breath  — segment count cosine pingpong. N cycles 4..16 around slider.
//             Reads as the pattern "breathing" denser and sparser.
//   spin    — angleOffset 0→2π monotonic. Whole pattern rotates exactly one
//             turn — endpoints equal because 2π ≡ 0 mod 2π.
//   pulse   — zoom spike. Sharp asymmetric envelope (fast in, slow out)
//             returning to slider value at the seam.
//   march   — N steps through {4,6,8,12} held 1/4 each. Seam-pin at t=1
//             snaps to tier 0 → byte-equal with t=0.
//   recurse — depth steps 0→target→0 across the loop (pingpong-ish step
//             function), so the fractal "fold the fold" effect blooms and
//             retreats. Held depth values are byte-equal at endpoints.
function applyAnimationT(tLoop){
  let t = tLoop - Math.floor(tLoop);
  if(t === 1) t = 0;
  const TAU = Math.PI * 2;
  const pp = (1 - Math.cos(t * TAU)) / 2;
  let seg = null, ang = null, zoom = null, depth = null, sx = null, sy = null;
  switch(params.mode){
    case 'idle': break;
    case 'breath': {
      // N breathes around the slider value by ±4 segments.
      const base = params.segments;
      seg = clamp(Math.round(base + 4 * Math.cos(t * TAU) - 4), 2, 32);
      // At t=0 and t=1: cos(0)=cos(2π)=1 → +4-4 = 0 offset. Byte-equal.
      seg = clamp(Math.round(base + 4 * (Math.cos(t * TAU) - 1) / 2 * 2), 2, 32);
      // Simpler & exact: base + round(4·cos(2πt) - 4), which is 0 at seams.
      seg = clamp(Math.round(base + 4 * (Math.cos(t * TAU) - 1)), 2, 32);
      break;
    }
    case 'spin': {
      // Monotonic 0→2π. wraps to 0 at t=1.
      ang = params.angleOffset + t * TAU;
      break;
    }
    case 'pulse': {
      // Sharp zoom-in then slow zoom-out, returning to slider value.
      // f(0)=f(1)=1; peak at t≈0.18.
      const env = t < 0.2 ? t / 0.2 : Math.pow(1 - (t - 0.2) / 0.8, 2.5);
      const base = params.zoom;
      zoom = base * (1 + 0.8 * env);
      break;
    }
    case 'march': {
      const tiers = [4, 6, 8, 12];
      const idx = t === 0 ? 0 : Math.min(tiers.length - 1, Math.floor(t * tiers.length));
      seg = tiers[idx];
      break;
    }
    case 'recurse': {
      // Pingpong depth: 0 → recurseDepth(slider, or 2 if 0) → 0.
      const target = params.recurseDepth > 0 ? params.recurseDepth : 2;
      depth = Math.round(target * pp);
      break;
    }
  }
  return { seg, ang, zoom, depth, sx, sy };
}

function renderAnimationFrame(tLoop){
  const a = applyAnimationT(tLoop);
  _segAnim = a.seg; _angleAnim = a.ang; _zoomAnim = a.zoom;
  _depthAnim = a.depth; _sampleXAnim = a.sx; _sampleYAnim = a.sy;

  const needPre = params.grainAmount > 0;
  if(needPre){ _rng = mulberry32(seedFromT(tLoop)); preprocess(); _rng = Math.random; }
  else if(!preprocessed){ preprocess(); }
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    preprocess();
  }
  paint();

  _segAnim = null; _angleAnim = null; _zoomAnim = null;
  _depthAnim = null; _sampleXAnim = null; _sampleYAnim = null;
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
    schedule('paint');
  }
}

// ── WAEffect contract ────────────────────────────────────────
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

const PRE_KEYS = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive){
    // The cursor MOVES the fold origin. Map cursor → normalised [-1..1].
    const W = cv.width, H = cv.height;
    const nx = clamp((mouseX / r.width) * 2 - 1, -1, 1);
    const ny = clamp((mouseY / r.height) * 2 - 1, -1, 1);
    params.sampleX = nx;
    params.sampleY = ny;
    if(!params.animate) schedule('paint');
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
    if(key === 'mode'){ return; }
    if(params.animate) return;
    if(PRE_KEYS.has(key)) schedule('pre');
    else                  schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => { if(!params.animate) schedule('pre'); });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-kaleidoscope',
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
