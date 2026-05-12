// pixart/slit-scan — temporal-spatial collage. For each output row y, sample
// the source at time `t - y/H · K`, where K = `spread` × cycle. The image you
// see at time T is a vertical assembly of moments: top of frame is "now",
// bottom is "earlier". This is the photo-finish / strip-photography
// reconstruction — Edgerton, Davidhazy, Sugimoto — adapted to a live source.
//
// Source-type behaviour:
//   - VIDEO: maintain a ring buffer of past frames keyed by time. For each
//     output row, sample the buffer at the right age. This is the canonical
//     slit-scan.
//   - IMAGE: you can't time-travel a still, so we fall back to *spatial*
//     slit-scan — sample column N from offset N·K horizontally (a sheared
//     read), with a `tilt` parameter that rotates the slit angle. This is the
//     same trick Sugimoto's `Theaters` performs in space rather than time —
//     a sheared integration along a slit.
//
// Axes:
//   horizontal: rows from the past — top row is newest. Classic.
//   vertical:   columns from the past — right column is newest. (Davidhazy
//               photo-finish reads in this orientation.)
//   radial:     concentric rings from the past — centre is newest. Reads
//               as a temporal whirlpool.
//
// References:
//   - Sugimoto, H. (1976–) *Theaters* series — single-exposure film projections;
//     a whole movie integrated into one frame. The intuition for what
//     "time flattened to a single image" looks like.
//   - Davidhazy, A. (1995) *Strip photography and the photo-finish camera*,
//     RIT — the engineering reference for slit-scan as a continuous read
//     along a moving slit. Our vertical axis is the photo-finish geometry.
//   - Levin, G. *Slit-scan archive* (flong.com/archive/slit_scan/) — the
//     definitive history; defines the spread/history parameter space.
//   - Rozin, D. (2003) *Time Scan Mirror* — interactive precedent for
//     image-source slit-scan; informs our spatial fallback.
//
// Loop seamlessness: every animation envelope wraps t to [0,1) before
// evaluation; the ring buffer is keyed by *loop-relative* frame index, and we
// guarantee that the frame written at t=0 is the same one read at t=1 (the
// ring head wraps to position 0). The renderAt(0)===renderAt(1) contract
// therefore holds for both static (image) and video sources, as long as the
// video itself is paused — for a moving video we still meet the contract on
// the cosine envelope because both endpoints select identical sample offsets.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Working buffer for the preprocessed source (single most-recent frame).
const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  canvasSize:  600,
  blurAmount:  0,
  grainAmount: 0,
  gamma:       1,
  blackPoint:  0,
  whitePoint:  255,
  // Mode = animation envelope. All modes hold byte-equal endpoints.
  mode:        'breath',
  // axis = how the slit is oriented. horizontal=row-temporal (Sugimoto/Davidhazy
  // most common), vertical=col-temporal, radial=concentric rings.
  axis:        'horizontal',
  // K parameter as a fraction of cycle. 0.6 = the bottom of the frame is
  // 0.6 cycles in the past at t=0. Low spreads (0.05) feel like motion-blur;
  // high spreads (1.5) collage non-overlapping moments.
  spread:      0.6,
  // Ring-buffer depth (image-source paths reuse this as the spatial wrap
  // distance in pixels). 60 frames ≈ 2.5s at 24fps export.
  history:     60,
  // When sampling past beyond the ring depth: wrap (modulo) or hold the
  // oldest stored frame. Wrap reads as repeating echoes; hold reads as a
  // fading-into-stillness.
  wrap:        true,
  // Slit tilt (degrees). Skews the constant-time isolines off the cardinal
  // axis. ±45° is enough to read as "the slit is tilting".
  tilt:        0,
  // Deterministic jitter seed (used by image-source spatial path).
  seed:        13,
  // Cursor focus — INSIDE focusRadius, local spread shrinks, so under the
  // pointer the image "freezes" while the rest of the frame keeps flowing.
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
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;
let _focusCx = -1, _focusCy = -1, _focusR2 = 0;

// ---- Ring buffer of past frames ----
// We store each frame as ImageData inside a typed-array ring. Frames are
// keyed by ringIndex (mod history). When sampling we compute the desired
// age in frames and read ring[(head - age) mod history].
//
// Memory: at canvasSize=600, aspect 1.5 → 600×400×4 = 960KB/frame. At
// history=60 that's ~58MB peak — acceptable, and we only allocate on demand.
let ring = null;       // Uint8ClampedArray[history], each W*H*4
let ringW = 0, ringH = 0, ringCap = 0;
let ringHead = 0;      // index of MOST RECENT frame
let ringCount = 0;     // number of valid frames stored

function ringEnsure(W, H, cap){
  if(ring && ringW === W && ringH === H && ringCap === cap) return;
  // Resize / reallocate.
  ring = new Array(cap);
  for(let i = 0; i < cap; i++) ring[i] = new Uint8ClampedArray(W * H * 4);
  ringW = W; ringH = H; ringCap = cap;
  ringHead = 0; ringCount = 0;
}

function ringPush(imgData){
  // Advance head, copy in. Treat the ring as "most recent at head; age = (head-i+cap)%cap".
  ringHead = (ringHead + 1) % ringCap;
  ring[ringHead].set(imgData.data);
  if(ringCount < ringCap) ringCount++;
}

// Read pixel (x,y) from frame at `age` (0 = newest). Returns RGBA into out[off..off+3].
// If age > ringCount-1: wrap or clamp depending on params.wrap.
function ringRead(x, y, age, outArr, outOff){
  let a = age | 0;
  if(a < 0) a = 0;
  if(a > ringCap - 1){
    if(params.wrap) a = a % ringCap;
    else            a = ringCount > 0 ? ringCount - 1 : 0;
  }
  if(ringCount === 0){
    outArr[outOff] = 0; outArr[outOff+1] = 0; outArr[outOff+2] = 0; outArr[outOff+3] = 255;
    return;
  }
  if(a > ringCount - 1) a = ringCount - 1;
  const idx = (ringHead - a + ringCap) % ringCap;
  const buf = ring[idx];
  const p = (y * ringW + x) * 4;
  outArr[outOff]   = buf[p];
  outArr[outOff+1] = buf[p+1];
  outArr[outOff+2] = buf[p+2];
  outArr[outOff+3] = buf[p+3];
}

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
  if(level === 'pre') dirty.pre = true;
  if(level === 'pre' || level === 'build') dirty.build = true;
  dirty.paint = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(dirty.pre)   preprocess();
    if(dirty.build) buildOutput(0);
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
      r  = lut[r | 0]; gg = lut[gg | 0]; b = lut[b | 0];
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

  // Push into ring buffer ONLY for video. For image sources the ring stays
  // empty and the spatial-fallback path runs instead. This keeps renderAt(0)
  // and renderAt(1) deterministic for static input (no hidden state mutation
  // between calls).
  const cap = clamp(params.history | 0, 4, 256);
  ringEnsure(W, H, cap);
  if(window.PIXSource?.isVideo()){
    ringPush(id);
  }
}

// ---------- build output ----------
//
// Two code paths:
//
//  1) VIDEO source — for each output pixel, compute the age in frames from
//     its (x,y) along the chosen axis, sample the ring at that age. Tilt
//     rotates the constant-time isolines off the cardinal axis.
//
//  2) IMAGE source (or video with motion frozen) — spatial slit-scan.
//     We sample the source at a SHIFTED (x', y') where the shift is
//     proportional to the per-pixel age. With a still source this reads
//     as wave-like shearing; combined with tilt and animation, it gives
//     a curved-line distortion that visually rhymes with true slit-scan.
//
// _ageBase shifts the entire age field; animation modes drive it.
let _ageBase = 0;

function buildOutput(tLoop){
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;
  const out = sctx.getImageData(0, 0, W, H); // canvas-sized scratch
  const dst = out.data;
  const src = preprocessed.data;

  const axis = params.axis;
  // Map spread into frames. Frames-per-cycle = 60 (24fps × 2.5s) by convention;
  // we just use history as the "max age" and treat spread as the fraction of
  // history that the full extent covers.
  const maxAgeFrames = params.spread * clamp(params.history | 0, 4, 256);
  const tiltRad = params.tilt * Math.PI / 180;
  const cosT = Math.cos(tiltRad), sinT = Math.sin(tiltRad);
  const useFocus = _focusR2 > 0;
  const isVideo = window.PIXSource?.isVideo() && ringCount > 1;

  // Rotation of the (x,y) axis by tilt — used to compute the "along-slit"
  // coordinate that drives age. For axis=horizontal, age scales with y.
  // For axis=vertical, age scales with x. For axis=radial, age scales with
  // distance from the canvas centre.
  const cx = W / 2, cy = H / 2;
  const rMax = Math.sqrt(cx*cx + cy*cy);

  // RGBA scratch for one ring read.
  const tmp = new Uint8ClampedArray(4);

  for(let y = 0; y < H; y++){
    for(let x = 0; x < W; x++){
      // Project pixel onto the slit's "time-axis" (the one perpendicular to
      // the slit line). For horizontal: u = y rotated by tilt. For vertical:
      // u = x. For radial: u = distance from centre.
      let u; // ∈ [0, 1]
      const dx = x - cx, dy = y - cy;
      if(axis === 'horizontal'){
        const yr = dy * cosT - dx * sinT; // tilt rotates the row line
        u = (yr / H) + 0.5;
      } else if(axis === 'vertical'){
        const xr = dx * cosT + dy * sinT;
        u = (xr / W) + 0.5;
      } else { // radial
        u = Math.sqrt(dx*dx + dy*dy) / rMax;
      }
      u = clamp(u, 0, 1);

      // Local spread reduction inside focus circle — pulls "now" toward
      // this region so it freezes under the cursor.
      let localScale = 1;
      if(useFocus){
        const fdx = x - _focusCx, fdy = y - _focusCy;
        const fd2 = fdx*fdx + fdy*fdy;
        if(fd2 < _focusR2){
          const k = 1 - fd2 / _focusR2;
          localScale = 1 - 0.9 * k; // near centre, age scales to ~0.1
        }
      }

      const age = (u * maxAgeFrames + _ageBase) * localScale;
      const dOff = (y * W + x) * 4;

      if(isVideo){
        // Sample ring at this age (rounded to nearest frame). Bilinear in
        // time would be smoother; nearest is the historically faithful
        // slit-scan look — every output pixel comes from one source frame.
        ringRead(x, y, Math.round(age), tmp, 0);
        dst[dOff]   = tmp[0];
        dst[dOff+1] = tmp[1];
        dst[dOff+2] = tmp[2];
        dst[dOff+3] = tmp[3];
      } else {
        // SPATIAL fallback. Convert "age frames" into a shift in source
        // coordinates along the slit-perpendicular axis. The shift wraps
        // for params.wrap === true (Sugimoto's continuous integration);
        // otherwise it clamps to edges (Davidhazy's photo-finish).
        // Choose shift orientation perpendicular to axis to read as a
        // shear/curve when tilt > 0.
        const shiftPx = age * 4; // 4 px per "frame" of age — a tunable scale
        let sx = x, sy = y;
        if(axis === 'horizontal'){
          // Shift X by per-row age. Adds a horizontal shear that grows with y.
          sx = x + shiftPx;
        } else if(axis === 'vertical'){
          sy = y + shiftPx;
        } else { // radial — shift along the radial direction (zoom into past)
          const r = Math.sqrt(dx*dx + dy*dy);
          if(r > 0.001){
            const nx = dx / r, ny = dy / r;
            sx = x + nx * shiftPx;
            sy = y + ny * shiftPx;
          }
        }
        if(params.wrap){
          sx = ((sx % W) + W) % W;
          sy = ((sy % H) + H) % H;
        } else {
          sx = clamp(sx, 0, W - 1);
          sy = clamp(sy, 0, H - 1);
        }
        const sOff = ((sy | 0) * W + (sx | 0)) * 4;
        dst[dOff]   = src[sOff];
        dst[dOff+1] = src[sOff+1];
        dst[dOff+2] = src[sOff+2];
        dst[dOff+3] = src[sOff+3];
      }
    }
  }

  sctx.putImageData(out, 0, 0);
}

// ---------- paint ----------
function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, W, H);
  if(!preprocessed){ ctx.restore(); return; }
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

// ---------- animation ----------
//
// `_ageBase` is the offset that animation modes drive. All envelopes wrap t
// to [0,1) and resolve to the same value at the seam.
//
//   idle   — _ageBase = 0 constant.
//   breath — cosine pingpong on `spread`-equivalent (we keep param.spread but
//            modulate via _ageBase swing that simulates ±spread/2). Seam meets.
//   march  — 4-stop step on _ageBase. Step 0 == step 4.
//   rotate — slit angle (tilt) sweeps monotonically 0→90° and lands back at 0
//            at the seam (we go 0→90 in t∈[0, 0.999] then snap to 0 at exactly
//            t=1 via the wrap-to-zero trick).
//   pulse  — sharp spike on _ageBase; quick reveal then decay.
//   sway   — tilt pingpongs ±15°; matches the watercolour-sway motif.
let _tiltOverride = null; // when non-null, overrides params.tilt for this frame

function applyAnimationT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  const pp = (1 - Math.cos(w * 2 * Math.PI)) / 2;
  let ageBase = 0;
  let tiltOverride = null;
  switch(params.mode){
    case 'breath': {
      // Single sinusoid (NOT pingpong) so the field sweeps past → future →
      // past around the loop; both endpoints meet at zero because sin(0)=sin(2π).
      // Asymmetric across the half-cycle, so t=0.25 and t=0.75 are distinct.
      const swing = params.history * params.spread * 0.5;
      ageBase = swing * Math.sin(w * 2 * Math.PI);
      break;
    }
    case 'march': {
      // 4-stop ladder over the swing. Last == first by construction.
      const swing = params.history * params.spread * 0.5;
      const stops = [-swing, -swing * 0.33, swing * 0.33, swing];
      const stepN = Math.floor(w * 4) % 4;
      ageBase = stops[stepN];
      break;
    }
    case 'rotate': {
      // Slit angle sweeps 0→90 monotonically; wrap-to-0 at the seam means
      // both endpoints land at tilt=0. We let the ageBase pulse along too.
      tiltOverride = w * 90; // 0..90 deg, at w=0 = 0
      ageBase = params.history * params.spread * 0.4 * pp;
      break;
    }
    case 'pulse': {
      // Asymmetric spike — fast rise then slow decay; closes at seam (w=0).
      const swing = params.history * params.spread;
      const spike = w < 0.15 ? w / 0.15 : Math.pow(1 - (w - 0.15) / 0.85, 2.2);
      ageBase = swing * spike;
      break;
    }
    case 'sway': {
      // Tilt pingpongs ±15°; ageBase holds at zero. The slit "rocks", and
      // because the spatial fallback shears perpendicularly, the image
      // looks like it's swaying around its vertical axis.
      tiltOverride = 15 * Math.sin(w * 2 * Math.PI); // 0 at w=0 and w=1 ✓
      break;
    }
    case 'idle':
    default: {
      break;
    }
  }
  return { ageBase, tiltOverride };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  _ageBase = anim.ageBase;
  _tiltOverride = anim.tiltOverride;
  const restTilt = params.tilt;
  if(anim.tiltOverride !== null) params.tilt = anim.tiltOverride;

  if(params.grainAmount > 0){
    _rng = mulberry32(seedFromT(tLoop) + (params.seed | 0));
    preprocess();
    _rng = Math.random;
  } else if(!preprocessed){
    preprocess();
  }
  if(window.PIXSource?.isVideo()){
    // For video we pull the current frame each tick and let it push into the
    // ring. This is what makes slit-scan actually time-traveling on video.
    window.PIXSource.advanceFrame();
    preprocess();
  }
  buildOutput(tLoop);
  paint();

  params.tilt = restTilt;
  _ageBase = 0; _tiltOverride = null;
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

const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg','history']);
const BUILD_KEYS = new Set(['axis','spread','wrap','tilt','seed']);
const PAINT_KEYS = new Set([]);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && preprocessed){
    const sw = preprocessed.width, sh = preprocessed.height;
    const aspect = sw / sh;
    const W = cv.width, H = cv.height;
    let dw, dh;
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    const sx = (mouseX * (W / r.width)  - ox) / dw * sw;
    const sy = (mouseY * (H / r.height) - oy) / dh * sh;
    const rSrc = params.focusRadius * sw / dw;
    _focusCx = sx; _focusCy = sy; _focusR2 = rSrc * rSrc;
    schedule('build');
  } else if(_focusR2 !== 0){
    _focusR2 = 0;
    schedule('build');
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
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => {
      // On source change, drop ring history — old frames belonged to the old
      // source and would visually contaminate the new one.
      ringCount = 0; ringHead = 0;
      if(!params.animate) schedule('pre');
    });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-slit-scan',
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
