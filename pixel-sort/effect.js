// pixart/pixel-sort — Kim Asendorf's ASDF pixel-sort (Processing, 2010),
// canvased and reorganised around the pixart 15s-seamless contract.
//
// The algorithm in one sentence: choose a mask (which pixels are "eligible"),
// then within every contiguous run of eligible pixels along a scan line, sort
// the run's pixels by a key (luminance / hue / saturation / red). The mask is
// what gives the effect its identity — Asendorf's original used three
// thresholds (white, black, brightness); we generalise to an "eligible band"
// [thresholdLow, thresholdHigh] on luminance. Pixels OUTSIDE the band break
// runs (acting as walls). Pixels INSIDE the band are sorted within their run.
//
// Why a band (and not Asendorf's single threshold):
//   - A single threshold "eligible if lum > X" gets you horizontal streaks
//     in highlight regions. A *band* gives you streaks in midtones, which is
//     where photographic information lives — more striking on most sources.
//   - Setting low=0 and high=255 → "sort the whole row" (one giant run, classic
//     glitch-poster look). Setting low=80, high=220 → midtone streaks only,
//     shadows + highlights preserved (the canonical Asendorf datamosh look).
//
// References baked into the implementation:
//   - Asendorf, K. (2010) `ASDF pixel sort`. Processing sketch, kimasendorf.com.
//     The original. We mirror the run-based scan + key-based sort.
//   - Temkin, D. (2014) *Glitch::Art* — defined the aesthetic lineage; informs
//     our default of "midtone-band on luminance".
//   - Roberts, A. (Hellocatfood) glitch tutorials — direction sweeps (rows,
//     columns, diagonals) come from his tutorial corpus.
//   - Shadertoy `XdfGzj` — confirms the threshold-as-mask formulation we use.
//
// 15s-loop seamlessness: every animation envelope wraps t to [0,1) before
// evaluation; randomness uses mulberry32(seedFromT(t)); the sort is stable
// and deterministic given equal inputs; we therefore meet the byte-equal
// renderAt(0) === renderAt(1) contract.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Offscreen buffer; preprocessor target.
const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const params = {
  // Preprocessor (shared with the rest of pixart).
  canvasSize:    600,
  blurAmount:    0,
  grainAmount:   0,
  gamma:         1,
  blackPoint:    0,
  whitePoint:    255,
  // Pixel-sort specific.
  // Mode = the animation envelope (see applyAnimationT). All modes hold
  // byte-equal endpoints; defaults to `breath`.
  mode:          'breath',
  // sortBy = which channel becomes the sort key.
  //   luminance  — Asendorf's original; reads as horizontal "rivers of light".
  //   hue        — sorts by HSL hue angle; produces psychedelic rainbow runs.
  //   saturation — quiet pastel zones move to the ends of each run.
  //   red        — single-channel; useful for false-colour datamosh.
  sortBy:        'luminance',
  // Direction of the scan. Rows is the canonical Asendorf direction; diagonals
  // are an Hellocatfood-era extension that read as motion-blur streaks.
  direction:     'row',
  // Eligible band on luminance. Pixels inside [low, high] are sortable; pixels
  // outside break the run. Defaults reproduce the canonical Asendorf midtone-
  // streak look on most photographs.
  thresholdLow:  80,
  thresholdHigh: 220,
  // Flip sort order. With sortReverse:false, larger keys go to the END of
  // each run. With true, larger keys go to the START. Inverting on a
  // luminance sort flips bright runs from "trailing" to "leading".
  sortReverse:   false,
  // Per-pixel bias added to luminance before mask check. Animation modes
  // sweep this to widen / narrow the eligible band dynamically.
  bias:          0,
  // Deterministic jitter seed for rotate / cascade modes.
  seed:          7,
  // Cursor amplifier — inside focusRadius the eligible band widens locally,
  // pulling more streaks under the pointer. Peripheral motion (Carrasco 2011)
  // means the eye is drawn to the edge of the focus circle, which is what we
  // want — the cursor "tugs" streaks toward itself.
  focusRadius:   220,
  // Shared chrome.
  animate:       false,
  interactive:   false,
  fit:           'cover',
  bg:            '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let preprocessed = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;
let _focusCx = -1, _focusCy = -1, _focusR2 = 0, _focusBoost = 0;

// Output buffer — we sort into this and then blit it to #cv.
let outBuf = null;
let outImg = null;

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

// ---------- preprocessor (mirrors edge/ascii) ----------
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

// ---------- sort key extractors ----------
// Luminance: BT.601 luma. Cheap, perceptual, default.
function keyLum(r,g,b){ return 0.299*r + 0.587*g + 0.114*b; }
// Hue: H in [0,360). Achromatic pixels (max==min) map to 0 — they cluster
// at the start of hue-sorted runs, which is the visually correct behaviour
// (greys vs colours separate cleanly).
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
//
// Pure-row sort: scan each row, find runs where keyLum is in [low, high]
// (the eligible band), sort the run in-place by the chosen key. We work in
// "row coordinates" — `direction` is implemented by remapping (x,y) → (i,j)
// at scan time. Diagonals iterate along the matrix anti-/diagonals.
//
// Why we sort indices into a side array (not pixels in place):
//   - We need to read R/G/B/A from the source and write to the OUTPUT image.
//     Sorting indices then gathering writes avoids the swap-overhead of
//     in-place pixel shuffles, and stays cache-friendly on the read side.

let _cascadeFront = 1; // 0..1; how far the sort has swept (cascade mode)
let _angleSnap   = -1; // override `direction` when rotate mode is active
let _bandBias    = 0;  // shifts both thresholds equally (pulse / breath)

function buildSorted(){
  if(!preprocessed){ return; }
  const W = preprocessed.width, H = preprocessed.height;
  if(!outBuf){
    outBuf = new Uint8ClampedArray(W * H * 4);
    outImg = new ImageData(outBuf, W, H);
  } else if(outBuf.length !== W * H * 4){
    outBuf = new Uint8ClampedArray(W * H * 4);
    outImg = new ImageData(outBuf, W, H);
  }
  // Copy the source as the starting point; sorted runs will overwrite.
  outBuf.set(preprocessed.data);

  const px = preprocessed.data;
  const keyFn = getKeyFn(params.sortBy);
  const dirRaw = _angleSnap >= 0 ? _angleSnap : params.direction;
  const lo = clamp(params.thresholdLow  + _bandBias, 0, 255);
  const hi = clamp(params.thresholdHigh - _bandBias, 0, 255);
  const reverse = !!params.sortReverse;
  const bias    = params.bias;
  const useFocus = _focusR2 > 0;

  // Iterate over scan lines determined by direction. We yield a function that
  // walks one scan line by index n, returning the linear pixel index `i = (y*W+x)*4`.
  // This unification lets the sort code be direction-agnostic.
  //
  //   row         : scan lines are horizontal — H lines, W long each
  //   column      : scan lines are vertical   — W lines, H long each
  //   diagonal-1  : ↘ direction (x+y = const) — W+H-1 lines, variable length
  //   diagonal-2  : ↙ direction (x-y = const) — W+H-1 lines, variable length
  //
  // For diagonals we compute (x,y) per step from the diagonal index k and
  // step n along that diagonal. Diagonal sorts produce the streak-blur look
  // popular in Hellocatfood's tutorials and most "Asendorf-diagonal" demos.
  const lines = [];
  if(dirRaw === 'row'){
    for(let y = 0; y < H; y++){
      const len = W;
      const idx = new Int32Array(len);
      for(let x = 0; x < W; x++) idx[x] = (y * W + x) * 4;
      lines.push(idx);
    }
  } else if(dirRaw === 'column'){
    for(let x = 0; x < W; x++){
      const len = H;
      const idx = new Int32Array(len);
      for(let y = 0; y < H; y++) idx[y] = (y * W + x) * 4;
      lines.push(idx);
    }
  } else if(dirRaw === 'diagonal-1'){
    // x + y = k, k in [0, W+H-2]
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
  } else { // diagonal-2: x - y = k, k in [-(H-1), W-1]
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

  // cascade mode wipes the sort across the image. We compute a "front"
  // position along the SAME axis as the scan and only sort lines whose
  // perpendicular coordinate is BEFORE the front. With wrap, the front
  // ends back at start at t=1 → byte-equal endpoint.
  //
  // For row scan, the front is on the Y axis; for column, on X; for diagonals
  // it's the diagonal index k (treated identically). The math is line-index
  // ratio < cascadeFront → sort, else copy.
  const totalLines = lines.length;
  const frontCutoff = _cascadeFront >= 1
    ? totalLines + 1    // sort everything (steady-state when not in cascade)
    : Math.floor(_cascadeFront * totalLines);

  // Scratch arrays sized to the longest line (W or H, whichever is larger).
  // Reused across all lines to avoid GC churn.
  const maxLen = Math.max(W, H);
  const keys     = new Float32Array(maxLen);
  const runOrder = new Int32Array(maxLen);
  const tmpR     = new Uint8ClampedArray(maxLen);
  const tmpG     = new Uint8ClampedArray(maxLen);
  const tmpB     = new Uint8ClampedArray(maxLen);
  const tmpA     = new Uint8ClampedArray(maxLen);

  for(let li = 0; li < totalLines; li++){
    if(li >= frontCutoff) continue; // unsorted region — output already holds source
    const idx = lines[li];
    const L = idx.length;

    // Walk the line; identify run [s, e) of eligible pixels (lumIn = keyLum + bias
    // landing inside [lo, hi], with optional cursor-focus widening). Pixels
    // outside the band become natural walls (Asendorf's design).
    let s = 0;
    while(s < L){
      // find run start: first eligible pixel from s onward
      while(s < L){
        const i = idx[s];
        const r = px[i], g = px[i+1], b = px[i+2];
        let lum = keyLum(r,g,b) + bias;
        if(useFocus){
          // Decode (x,y) from the linear index for distance test.
          const lin = i >>> 2;
          const x = lin % W, y = (lin - x) / W;
          const dx = x - _focusCx, dy = y - _focusCy;
          const d2 = dx*dx + dy*dy;
          if(d2 < _focusR2){
            // Widen the band locally — push lum away from edges so more
            // pixels qualify. Quadratic falloff is a cheap Gaussian.
            const k = 1 - d2 / _focusR2;
            lum += (lum < (lo + hi) / 2 ? +1 : -1) * _focusBoost * k;
          }
        }
        if(lum >= lo && lum <= hi) break;
        s++;
      }
      if(s >= L) break;
      // find run end
      let e = s;
      while(e < L){
        const i = idx[e];
        const r = px[i], g = px[i+1], b = px[i+2];
        let lum = keyLum(r,g,b) + bias;
        if(useFocus){
          const lin = i >>> 2;
          const x = lin % W, y = (lin - x) / W;
          const dx = x - _focusCx, dy = y - _focusCy;
          const d2 = dx*dx + dy*dy;
          if(d2 < _focusR2){
            const k = 1 - d2 / _focusR2;
            lum += (lum < (lo + hi) / 2 ? +1 : -1) * _focusBoost * k;
          }
        }
        if(!(lum >= lo && lum <= hi)) break;
        e++;
      }
      const runLen = e - s;
      if(runLen > 1){
        // Snapshot run pixels + keys, sort the order array.
        for(let n = 0; n < runLen; n++){
          const i = idx[s + n];
          const r = px[i], gg = px[i+1], b = px[i+2], a = px[i+3];
          keys[n] = keyFn(r, gg, b);
          runOrder[n] = n;
          tmpR[n] = r; tmpG[n] = gg; tmpB[n] = b; tmpA[n] = a;
        }
        // Sort indices by key; stable. We use Array.from + sort because
        // typed-array sort doesn't expose a comparator on all engines.
        // For our run sizes (< W), the overhead is dwarfed by the gather.
        const sub = Array.from(runOrder.subarray(0, runLen));
        if(reverse){
          sub.sort((a, b) => keys[b] - keys[a]);
        } else {
          sub.sort((a, b) => keys[a] - keys[b]);
        }
        // Gather: write sorted pixels back to the OUTPUT buffer at
        // positions s..e along this scan line.
        for(let n = 0; n < runLen; n++){
          const dst = idx[s + n];
          const srcN = sub[n];
          outBuf[dst]   = tmpR[srcN];
          outBuf[dst+1] = tmpG[srcN];
          outBuf[dst+2] = tmpB[srcN];
          outBuf[dst+3] = tmpA[srcN];
        }
      }
      s = e + 1; // skip the wall pixel
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
  if(!preprocessed || !outImg){ ctx.restore(); return; }

  // Blit outImg through srcBuf and scale to canvas with the standard contain.
  const sw = outImg.width, sh = outImg.height;
  // Stash into srcBuf (reuse — preprocess will rewrite next tick).
  srcBuf.width = sw; srcBuf.height = sh; // no-op if unchanged
  sctx.putImageData(outImg, 0, 0);

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
// All envelopes wrap t to [0,1) first; cosine pingpong then has
// cos(2π·0) === cos(2π·0) bit-equal — required for byte-equal export endpoints.
// `rotate` is the only mode that varies `direction`; it snaps to the nearest
// of N=4 axes (row, diag-1, column, diag-2) over the full 0→1 sweep, with
// step 0 === step 4 at the seam.
function applyAnimationT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  const pp = (1 - Math.cos(w * 2 * Math.PI)) / 2; // pingpong, peak at 0.5
  let bandBias = 0;
  let angleSnap = -1;
  let cascadeFront = 1; // 1 = sort everything (default)
  switch(params.mode){
    case 'breath': {
      // Cosine widen-then-shrink of the eligible band. Visually: streaks
      // grow long, then retract. Calm, foveal.
      bandBias = -40 * pp; // negative bias narrows lo & widens hi → wider band
      break;
    }
    case 'march': {
      // 4-stop threshold ladder. Each stop is a SAME-frame state at the seam
      // (stop 0 == stop 4), so endpoints meet exactly. Step gives a deliberate
      // VHS-jog feel.
      const stops = [0, -20, -40, -20];
      const stepN = Math.floor(w * 4) % 4;
      bandBias = stops[stepN];
      break;
    }
    case 'rotate': {
      // Direction snaps to the nearest of 4 axes over a full circle. Each
      // 90° step is a different scan axis. At t=1 we're back at row.
      const axes = ['row', 'diagonal-1', 'column', 'diagonal-2'];
      const stepN = Math.floor(w * 4) % 4;
      angleSnap = axes[stepN];
      bandBias = -20 * pp;
      break;
    }
    case 'pulse': {
      // Sharp asymmetric spike — band widens fast then decays slow. The
      // characteristic glitch-impulse beat.
      const spike = w < 0.15 ? w / 0.15 : Math.pow(1 - (w - 0.15) / 0.85, 2.2);
      bandBias = -60 * spike;
      break;
    }
    case 'cascade': {
      // Sort wipes across the image. At t=0 nothing is sorted; at t=0.5 half;
      // at t=1 it wraps back to 0. Reads as a curtain pulling across.
      // For byte-equal endpoints we ensure cascadeFront(0) === cascadeFront(1).
      cascadeFront = (w === 0) ? 0 : w;
      // At t=1 (which we map to w=0) we get cascadeFront=0 — same as t=0. ✓
      bandBias = -30;
      break;
    }
    case 'idle':
    default: {
      // No animation.
      break;
    }
  }
  return { bandBias, angleSnap, cascadeFront };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  _bandBias = anim.bandBias;
  _angleSnap = anim.angleSnap;
  _cascadeFront = anim.cascadeFront;

  // Deterministic grain re-seed for video-free byte-equal endpoints.
  if(params.grainAmount > 0){
    _rng = mulberry32(seedFromT(tLoop) + (params.seed | 0));
    preprocess();
    _rng = Math.random;
  } else if(!preprocessed){
    preprocess();
  }
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    preprocess();
  }
  buildSorted();
  paint();

  _bandBias = 0; _angleSnap = -1; _cascadeFront = 1;
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

const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['sortBy','direction','thresholdLow','thresholdHigh','sortReverse','bias','seed']);
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
    _focusBoost = 40; // band-widening amount in lum units at the centre
    schedule('build');
  } else if(_focusR2 !== 0){
    _focusR2 = 0; _focusBoost = 0;
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
    if(key === 'mode'){ return; } // animation-only
    if(params.animate) return;
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
      canvas: cv, name: 'pixart-pixel-sort',
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
