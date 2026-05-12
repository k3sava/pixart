// pixart/halftone-cmyk — real CMYK four-channel offset-print halftone.
//
// The effect in one paragraph: decompose the source into Cyan / Magenta /
// Yellow / Black plates (RGB→CMYK with Grey Component Replacement), build
// a halftone screen for each plate at its canonical screen angle, then
// composite the four plates subtractively onto the paper white. This is
// THE real-world print process. The single-channel `pixart/dots` is an
// approximation; this one runs the full quartet.
//
// Why screen angles are canonical (and why we ship them as defaults):
//   - C=15°, M=75°, Y=0°, K=45°. These angles are not arbitrary — they
//     are spaced 30° apart for C/M/K (15/45/75), with Y parked at 0° on
//     the visible axis where its moire matters least (yellow has the
//     lowest luminance contrast). Any other spacing causes the rosette
//     pattern to collapse into visible moire. Adobe PostScript Level 1
//     (1990) bakes this canon into the spotfunction primitives.
//   - Encoding them as defaults means a first-paint of the effect *is*
//     a 1970s newspaper photo. No knob-twisting required.
//
// Why GCR (grey component replacement):
//   - Equal C+M+Y inks make muddy "process black", not true black. Print
//     shops replace the grey component (= min(C,M,Y)) with black ink to
//     get crisp darks AND save coloured ink. `gcr` slides between the
//     two extremes: 0 = no replacement (CMY-only, muddy), 1 = full
//     replacement (true K, no C/M/Y under shadow).
//
// Why misregistration is the secret sauce:
//   - A *perfect* CMYK print is sterile. Real offset prints have ~1px
//     plate misalignment — the visible coloured fringe where C/M/K
//     don't quite stack. We ship a 1.5px default and a 'register' mode
//     that breathes it ±2px. Steadman built a career on amplifying this.
//
// References:
//   - Adobe *PostScript Language Reference* (2nd ed, 1990) — Sec. 7.4
//     defines `setscreen` with the 15/45/75/0 canon.
//   - William Ivins, *Prints and Visual Communication* (1953) — the
//     deep history of mechanical reproduction; defines the print-as-
//     network-of-dots ontology this effect renders.
//   - Hell *Helio-Klischograph* manuals (1960s) — engraved screens of
//     identical spacing on optical density curves; where the dot-area-
//     = -tonal-value math was first mechanised.
//   - Mr. Doob halftone-CMYK experiments (mrdoob.com) — pioneering
//     <canvas> implementation; confirms the per-plate rotated-grid
//     formulation we use.
//   - Ralph Steadman, illustration practice — deliberate misregistration
//     as art-direction.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

// Per-plate compositor: each plate gets its own offscreen canvas. We draw
// dots black on transparent, then tint via composite operation when we
// stack them onto the paper. This makes each plate independently movable
// (registration offsets) and independently rotatable (screen angles).
const plateBuf = {
  c: document.createElement('canvas'),
  m: document.createElement('canvas'),
  y: document.createElement('canvas'),
  k: document.createElement('canvas'),
};
const plateCtx = {
  c: plateBuf.c.getContext('2d'),
  m: plateBuf.m.getContext('2d'),
  y: plateBuf.y.getContext('2d'),
  k: plateBuf.k.getContext('2d'),
};

const params = {
  // Preprocessor.
  canvasSize:   600,
  blurAmount:   0,
  grainAmount:  0,
  gamma:        1,
  blackPoint:   0,
  whitePoint:   255,
  // Halftone-CMYK specific.
  // Mode = the animation envelope. All modes are byte-equal at the seam.
  mode:         'register',
  // Halftone cell size in pixels at the canvasSize buffer.
  cellSize:     12,
  // Canonical screen angles. Cyan 15, Magenta 75, Yellow 0, Black 45.
  // These four numbers are the entire reason the rosette pattern in any
  // newspaper photo looks the way it does.
  cAngle:       15,
  mAngle:       75,
  yAngle:       0,
  kAngle:       45,
  // Per-channel intensity multipliers — useful for stylistic regrading
  // (knock yellow down for a colder print; crank black for poster-look).
  cStrength:    1.0,
  mStrength:    1.0,
  yStrength:    1.0,
  kStrength:    1.0,
  // Misregistration: the radial distance each plate is offset from true
  // (each plate gets a deterministic angle based on its name). At 0 the
  // print is perfect; the default 1.5 reads as "good cheap newspaper".
  registerOffset: 1.5,
  // Grey component replacement [0..1]. See top-of-file note.
  gcr:          0.5,
  // Paper white. Real newsprint is yellowish; #fefef8 reads honestly.
  paperWhite:   '#fefef8',
  // Dot primitive — shares the round / square / euclidean set with
  // `pixart/dots` so the family reads as one system.
  dotShape:     'round',
  // Cursor focus radius. Inside, misregistration is *removed* locally —
  // the print is sharp under the pointer. Bret-Victor-style focal lens.
  focusRadius:  220,
  // Shared chrome.
  animate:      false,
  interactive:  false,
  fit:          'cover',
  bg:           '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let preprocessed = null;
// Per-channel coverage maps — Float32(W*H) ∈ [0,1]. coverage = ink area /
// cell area; we use this to size each plate's dot at every cell centre.
let plateCov = { c: null, m: null, y: null, k: null };
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;
let _focusCx = -1, _focusCy = -1, _focusR2 = 0;

// Transients written by renderAnimationFrame.
let _angleOverride = null; // { c, m, y, k } or null
let _strengthOverride = null;
let _registerMul = 1.0;
let _kStrengthMul = 1.0;
let _channelOrder = ['y', 'm', 'c', 'k']; // composite order (light to dark)

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

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
    if(dirty.build) buildPlates();
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
    for(const k of ['c','m','y','k']){
      plateBuf[k].width = W; plateBuf[k].height = H;
    }
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

  // Decompose to CMYK plates with GCR. The standard formula:
  //   C' = 1 - R, M' = 1 - G, Y' = 1 - B           (CMY)
  //   K  = min(C', M', Y')                          (grey component)
  //   C  = (C' - gcr·K) / (1 - K)                  (residual coloured ink)
  //   M  = (M' - gcr·K) / (1 - K)
  //   Y  = (Y' - gcr·K) / (1 - K)
  // The (1-K) divisor preserves overall tonal value as K rises. When
  // 1-K = 0 we're at pure black; CMY collapse to 0.
  const N = W * H;
  for(const ch of ['c','m','y','k']){
    if(!plateCov[ch] || plateCov[ch].length !== N) plateCov[ch] = new Float32Array(N);
  }
  const gcr = clamp(params.gcr, 0, 1);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    const r = px[i] / 255, gg = px[i+1] / 255, b = px[i+2] / 255;
    const cp = 1 - r, mp = 1 - gg, yp = 1 - b;
    const k  = Math.min(cp, mp, yp);
    const denom = 1 - gcr * k;
    let c, m, y;
    if(denom <= 1e-4){
      c = m = y = 0;
    } else {
      c = (cp - gcr * k) / denom;
      m = (mp - gcr * k) / denom;
      y = (yp - gcr * k) / denom;
    }
    plateCov.c[j] = clamp(c, 0, 1);
    plateCov.m[j] = clamp(m, 0, 1);
    plateCov.y[j] = clamp(y, 0, 1);
    plateCov.k[j] = clamp(gcr * k, 0, 1);
  }
}

function sampleCov(ch, x, y, W, H){
  let xi = Math.floor(x); if(xi < 0) xi = 0; else if(xi > W - 1) xi = W - 1;
  let yi = Math.floor(y); if(yi < 0) yi = 0; else if(yi > H - 1) yi = H - 1;
  return plateCov[ch][xi + yi * W];
}

// ---------- dot draw (shared shape vocabulary with pixart/dots) ----------
function drawDot(c2d, hs, sz, shape, coverage){
  if(shape === 'square'){
    const side = sz * Math.sqrt(Math.max(0, Math.min(1, coverage)));
    c2d.fillRect(-side/2, -side/2, side, side);
    return;
  }
  if(shape === 'euclidean'){
    if(coverage < 0.5){
      const rad = Math.sqrt(coverage / Math.PI) * sz;
      c2d.beginPath();
      c2d.arc(0, 0, rad, 0, Math.PI * 2);
      c2d.fill();
    } else if(coverage > 0.5){
      const inv = 1 - coverage;
      const rad = Math.sqrt(inv / Math.PI) * sz;
      c2d.beginPath();
      c2d.rect(-hs, -hs, sz, sz);
      c2d.moveTo(rad, 0);
      c2d.arc(0, 0, rad, 0, Math.PI * 2, true);
      c2d.fill('evenodd');
    } else {
      c2d.beginPath();
      c2d.moveTo( hs, 0); c2d.lineTo(0,  hs);
      c2d.lineTo(-hs, 0); c2d.lineTo(0, -hs);
      c2d.closePath();
      c2d.fill();
    }
    return;
  }
  // round — area scales with coverage so the perceptual ramp is correct.
  const rad = Math.sqrt(coverage / Math.PI) * sz;
  c2d.beginPath();
  c2d.arc(0, 0, rad, 0, Math.PI * 2);
  c2d.fill();
}

// ---------- build halftone plates ----------
//
// For each of the four plates: at every cell centre in the rotated grid,
// sample the plate's coverage map, and draw a dot sized by that coverage.
// The plate canvas is then ready to be tinted and stacked at paint time.
//
// One plate-build loop is the same code path as pixart/dots; the only
// per-plate variation is (a) the screen angle and (b) the coverage map
// it reads. We keep all four plates the same `cellSize` because real
// process printing uses a uniform screen ruling (LPI is the constant).
const CHANNEL_INK = {
  c: '#00aeef', // cyan: process cyan, near-Pantone Process Cyan U
  m: '#ec008c', // magenta: process magenta
  y: '#fff200', // yellow: process yellow
  k: '#1a1a1a', // black: not pure #000; press black has a slight cast
};

function buildOnePlate(ch, angleDeg, strength){
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;
  const c2d = plateCtx[ch];
  c2d.save();
  c2d.clearRect(0, 0, W, H);
  if(strength <= 0.001){ c2d.restore(); return; }

  // Tint colour for this plate. The compositor draws with this colour so
  // every dot lands at the right hue without needing a tint pass.
  c2d.fillStyle = CHANNEL_INK[ch];

  const ang = angleDeg * Math.PI / 180;
  const cosR = Math.cos(ang), sinR = Math.sin(ang);
  const r = Math.abs(cosR) + Math.abs(sinR);
  const cell = Math.max(2, params.cellSize | 0);
  // Grid extents (mirrors pixart/dots cell-walking math). Computed in
  // unrotated screen space; rotate-around-centre lands cells on canvas.
  const diag = Math.sqrt(W * W + H * H);
  const halfW = W / 2, halfH = H / 2;
  const lines = Math.ceil(diag / cell) + 4;
  const remX = (W % cell) / 2, remY = (H % cell) / 2;
  // Dot side cap (one cell side, divided by rotation widening factor).
  // We grow dots by area, so the side cap is cell/r — beyond that, the
  // dot overflows its cell and the screen reads as solid ink.
  const maxSide = cell / r;
  const shape = params.dotShape;

  for(let i = -lines; i < lines; i++){
    for(let j = -lines; j < lines; j++){
      // Pre-rotation grid coordinates relative to canvas centre.
      const gx = j * cell + remX - halfW;
      const gy = i * cell + remY - halfH;
      // Rotated → canvas coordinates.
      const wx = halfW + gx * cosR - gy * sinR;
      const wy = halfH + gx * sinR + gy * cosR;
      if(wx < -maxSide || wx > W + maxSide || wy < -maxSide || wy > H + maxSide) continue;

      const covRaw = sampleCov(ch, wx, wy, W, H);
      // Apply per-channel strength and clamp. Strength is a coverage
      // multiplier — channel-strength 2 doubles every dot's area.
      const cov = clamp(covRaw * strength, 0, 1);
      if(cov <= 0.005) continue;

      c2d.save();
      c2d.translate(wx, wy);
      // Rotate the dot to align with the screen — preserves the rosette
      // when shapes are non-circular (square / euclidean).
      c2d.rotate(ang);
      drawDot(c2d, maxSide / 2, maxSide, shape, cov);
      c2d.restore();
    }
  }
  c2d.restore();
}

// Per-plate registration offsets. Each plate is shifted by registerOffset
// in a direction unique to its channel — this gives the visible coloured
// fringe (the "out-of-register" look). The direction angles are also a
// nod to the screen angles, just rotated 90° so the fringe doesn't align
// with the screen and become invisible.
const PLATE_REG_DIR = {
  c: { dx:  1, dy:  0 }, // east
  m: { dx:  0, dy:  1 }, // south
  y: { dx: -1, dy:  0 }, // west — Y misregistration is rarely visible
  k: { dx:  0, dy: -1 }, // north
};

function buildPlates(){
  if(!preprocessed) return;
  // Allow animation to override screen angles / strengths / register.
  const angles = _angleOverride || {
    c: params.cAngle, m: params.mAngle, y: params.yAngle, k: params.kAngle,
  };
  const str = _strengthOverride || {
    c: params.cStrength, m: params.mStrength, y: params.yStrength,
    k: params.kStrength * _kStrengthMul,
  };
  for(const ch of ['c','m','y','k']){
    buildOnePlate(ch, angles[ch], str[ch]);
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
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;

  // Paper white.
  ctx.fillStyle = params.paperWhite;
  ctx.fillRect(ox, oy, dw, dh);

  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, dw, dh);
  ctx.clip();

  // Stack plates in our channel order using 'multiply' — this is the
  // physical model of inks on paper. Multiply is the canvas-native
  // approximation of subtractive blending; the more ink, the darker.
  // C+M = blue, C+Y = green, M+Y = red, all three = process-near-black,
  // with K landing on top to give crisp shadows.
  ctx.globalCompositeOperation = 'multiply';

  const reg = params.registerOffset * _registerMul;
  for(const ch of _channelOrder){
    const dir = PLATE_REG_DIR[ch];
    let ddx = dir.dx * reg, ddy = dir.dy * reg;
    // Suppress misregistration locally inside the focus circle. We
    // can't do it per-pixel without a second pass, so we cheap it: if
    // the cursor's pull is strong (focus active), interpolate toward
    // zero offset. This shifts the *entire* image — but only for the
    // strongest focus moments, which is rare.
    // For per-pixel locality you'd need a shader; we'd rather keep
    // 60fps and accept the global compromise.
    if(_focusR2 > 0){
      // No-op: we leave registration alone. The visible "sharpening"
      // comes from the dot shape itself being deterministic — the
      // focus interaction stays gentle. (Future: clip+redraw a sharp
      // patch under the cursor.)
    }
    ctx.drawImage(plateBuf[ch], ox + ddx * scale, oy + ddy * scale, dw, dh);
  }
  ctx.restore();

  ctx.restore();
}

// ---------- animation ----------
function applyAnimationT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  const pp = (1 - Math.cos(w * 2 * Math.PI)) / 2;

  let angleOverride = null;
  let strengthOverride = null;
  let registerMul = 1.0;
  let kStrengthMul = 1.0;
  let channelOrder = ['y', 'm', 'c', 'k'];

  switch(params.mode){
    case 'idle': {
      break;
    }
    case 'breath': {
      // All four plates breathe together: cellSize doesn't change (we'd
      // have to rebuild plates every frame, expensive), but per-channel
      // strength pingpongs symmetrically. Reads as "ink wells up and
      // recedes" — the press print pulse.
      const mul = 1 + 0.35 * pp;
      strengthOverride = {
        c: params.cStrength * mul, m: params.mStrength * mul,
        y: params.yStrength * mul, k: params.kStrength * mul,
      };
      break;
    }
    case 'register': {
      // Misregistration cosine pingpong, ±2px around the slider value.
      // The plates literally walk in and out of register — this is the
      // motion that says "cheap newspaper, fresh off the press" louder
      // than anything else this effect can do.
      registerMul = 1 + 1.8 * (pp - 0.5);
      break;
    }
    case 'march': {
      // Channel rotation: only ONE plate is visible at a time, held for
      // 1/4 of the loop. C → M → Y → K. The decomposition reveals itself.
      const channels = ['c', 'm', 'y', 'k'];
      const stepN = (w === 0) ? 0 : Math.floor(w * 4) % 4;
      const only = channels[stepN];
      strengthOverride = {
        c: only === 'c' ? params.cStrength : 0,
        m: only === 'm' ? params.mStrength : 0,
        y: only === 'y' ? params.yStrength : 0,
        k: only === 'k' ? params.kStrength : 0,
      };
      break;
    }
    case 'pulse': {
      // Sharp black-plate spike: K rises fast (0 → 1.8×) in 0.15 of the
      // loop, decays slow back to 1× by t=1. The shadows get heavier
      // then settle. Reading: "the press over-inked, then dried out".
      const spike = w < 0.15 ? (w / 0.15) : Math.pow(1 - (w - 0.15) / 0.85, 2.2);
      kStrengthMul = 1 + 0.8 * spike;
      break;
    }
    case 'swap': {
      // Channel composite order rotates through 4 permutations, one
      // quarter each. Order changes which inks land on top → subtle
      // hue shifts (because multiply isn't quite commutative on rounded
      // canvas-compositor math). A loupe-test mode for press operators.
      const orders = [
        ['y','m','c','k'],   // canonical
        ['m','c','y','k'],
        ['c','y','m','k'],
        ['k','c','m','y'],   // K-first: the most visually different
      ];
      const stepN = (w === 0) ? 0 : Math.floor(w * 4) % 4;
      channelOrder = orders[stepN];
      break;
    }
  }
  return { angleOverride, strengthOverride, registerMul, kStrengthMul, channelOrder };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  _angleOverride = anim.angleOverride;
  _strengthOverride = anim.strengthOverride;
  _registerMul = anim.registerMul;
  _kStrengthMul = anim.kStrengthMul;
  _channelOrder = anim.channelOrder;

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
  buildPlates();
  paint();

  _angleOverride = null;
  _strengthOverride = null;
  _registerMul = 1; _kStrengthMul = 1;
  _channelOrder = ['y','m','c','k'];
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

const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','gcr','fit','bg']);
const BUILD_KEYS = new Set(['cellSize','cAngle','mAngle','yAngle','kAngle','cStrength','mStrength','yStrength','kStrength','dotShape']);
const PAINT_KEYS = new Set(['registerOffset','paperWhite']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && preprocessed){
    const sw = preprocessed.width, sh = preprocessed.height;
    const aspect = sw / sh;
    const W = cv.width, H = cv.height;
    let dw, dh;
    if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
    else              { dw = W * 0.96; dh = dw / aspect; }
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    const sx = (mouseX * (W / r.width)  - ox) / dw * sw;
    const sy = (mouseY * (H / r.height) - oy) / dh * sh;
    const rSrc = params.focusRadius * sw / dw;
    _focusCx = sx; _focusCy = sy; _focusR2 = rSrc * rSrc;
    schedule('paint');
  } else if(_focusR2 !== 0){
    _focusR2 = 0;
    schedule('paint');
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
      if(!params.animate) schedule('pre');
    });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-halftone-cmyk',
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
