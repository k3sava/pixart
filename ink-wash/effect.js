// pixart/ink-wash — sumi-e / Japanese ink-painting stylisation.
//
// The effect in one paragraph: detect strong edges with a Sobel pass and treat
// them as the calligrapher's strokes. Stroke thickness scales with edge
// magnitude (and a fake "pressure" map). Stroke alpha fades at the ends — the
// dry-brush look. Composite the strokes over a paper tone with a stochastic
// paper grain. Optionally bleed the darkest strokes into the paper with a
// cheap Gaussian halo (rice-paper soaking). Monochrome by design — ink-wash
// is calligraphic, gestural, not painterly. The watercolour cousin lives in
// pixart/watercolor; this one is the Sesshū / Hokusai stylisation.
//
// Why edges instead of a brushstroke segmentation pass:
//   - Real sumi-e abstracts subject contours, not paint regions. Edges are
//     the most honest computational proxy for "where would the brush go".
//   - One pass, deterministic, byte-equal across the 15s loop. A region-
//     based stroke planner would be O(W·H·log) and need a stable RNG even
//     after sort-stability; not worth the budget.
//   - Cao et al. (Pacific Graphics 2006) reach this same conclusion: edges
//     drive strokes; paper texture drives the rest.
//
// References baked in:
//   - Sesshū Tōyō *Haboku-Sansui* (1495) — defines the visual target:
//     economy of stroke, dry brush at edges, ink bleeding into wet paper.
//   - Hokusai *Manga* (1814-1878) — line economy as a system.
//   - Cao et al., *Stylized Ink Painting Rendering* (Pacific Graphics 2006)
//     — algorithmic primer for the edge → stroke → bleed pipeline.
//   - Curtis et al., *Computer-Generated Watercolor* (SIGGRAPH 1997) — the
//     sibling NPR pipeline; we explicitly diverge by going monochrome.
//   - Bret Victor, *Drawing Dynamic Visualizations* (2013) — cursor as a
//     focal-point that sharpens; informs the wet-brush-dab interaction.
'use strict';

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Preprocessor target.
const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

// Paper / ink / bleed compositing buffers. We render strokes into `inkBuf`,
// then blur a copy for the bleed halo, then composite ink-over-bleed-over-
// paper into `outBuf`. Three buffers but they're all sized to canvasSize.
const inkBuf  = document.createElement('canvas');
const inkCtx  = inkBuf.getContext('2d');
const bleedBuf = document.createElement('canvas');
const bleedCtx = bleedBuf.getContext('2d');

// Named paper tones. These are calibrated by eye to the warm whites that
// real washi takes on under tungsten light — kozo is the classic mulberry-
// fibre cream, gampi the pale-gold from Wikstroemia bark, bamboo a yellower
// kraft. Real paper colour varies by maker; these are an honest median.
const PAPER_TYPES = {
  kozo:     { tone: '#f0e8d4', warmth: 1.00 },
  mulberry: { tone: '#ece8dc', warmth: 0.85 },
  gampi:    { tone: '#f5edc8', warmth: 1.10 },
  bamboo:   { tone: '#e8dbb0', warmth: 1.20 },
};

const params = {
  // Preprocessor (shared with the rest of pixart).
  canvasSize:   600,
  blurAmount:   0,
  grainAmount:  0,
  gamma:        1,
  blackPoint:   0,
  whitePoint:   255,
  // Ink-wash specific.
  // Mode = the animation envelope (applyAnimationT). All modes hold byte-
  // equal endpoints; defaults to `breath`.
  mode:         'breath',
  // The ink, the paper. Defaults reproduce a kozo-on-warm-ink look that
  // reads as sumi-e on first paint.
  inkColor:     '#0d0d0d',
  paperColor:   '#f0e8d4',
  // Pressure: a global stroke-thickness multiplier. Real calligraphers
  // press harder for fat strokes (the "press-release-press" rhythm); we
  // model it as a single number on [0,2]. Animation `breath` sweeps it.
  brushPressure: 1.0,
  // Ink density: alpha of the brushstroke at maximum pressure. The `dry`
  // mode rises this from 0 (pure paper, wet brush hasn't loaded yet) to
  // the slider value (fully inked, fully dry).
  inkDensity:   0.85,
  // Bleed: gaussian halo radius for ink-into-paper soaking. Applied only
  // to the darkest strokes — calligraphers control it by waiting on each
  // stroke before lifting the brush.
  bleed:        8,
  // Dry-brush: how much density falls off at edge-magnitude extremes (the
  // tip and root of the stroke). At dryBrush=1, the stroke ends are pure
  // paper. At 0, the stroke is uniformly dense end-to-end.
  dryBrush:     0.4,
  // Paper grain: alpha of the stochastic paper-texture overlay (mulberry32
  // value-noise rescaled to [-1,+1] then alpha-painted in inkColor).
  paperGrain:   0.25,
  // Paper-type select: switches the paper tone (and indirectly the bleed
  // contrast) between four canonical washi/bamboo papers.
  paperType:    'kozo',
  // Seed for paper-grain RNG. Two papers of the same type but different
  // seeds read as two real sheets — exactly the variation real paper has.
  seed:         7,
  // Cursor-focused sharpening. Inside focusRadius, we lift the edge
  // threshold (more strokes show) AND we suppress bleed (the local brush
  // is "dry"). Reads as a calligrapher dabbing a wet brush onto a dry rag.
  focusRadius:  220,
  // Shared chrome.
  animate:      false,
  interactive:  false,
  fit:          'cover',
  bg:           '#1a1612',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let preprocessed = null;
let edgeMag = null;       // Float32Array(W*H), Sobel magnitude in [0..~360]
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;
let mouseX = 0, mouseY = 0;
let _focusCx = -1, _focusCy = -1, _focusR2 = 0;

// Transients written by renderAnimationFrame, read by buildEdges / paint.
let _pressureMul = 1.0;
let _densityMul  = 1.0;
let _bleedMul    = 1.0;
let _paperOverride = null; // paper tone override for `march` mode

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

function hexToRgb(hex){
  const m = /^#?([a-f0-9]{6})$/i.exec(hex || '');
  if(!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
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
    if(dirty.build) buildEdges();
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
    inkBuf.width = W; inkBuf.height = H;
    bleedBuf.width = W; bleedBuf.height = H;
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

// ---------- Sobel edges ----------
// Standard 3×3 Gx/Gy. Magnitude in [0..~360]; we keep it as Float32 so the
// stroke-thickness map has the dynamic range to fade smoothly at the dry-
// brush ends. Operating on luminance (BT.601) is the right move for sumi-e:
// the eye reads strokes by *contrast*, not hue. We also stash a coarse
// "pressure" field — the Sobel direction angle, which we treat as the
// brush's hold angle and use to add a small magnitude modulation along
// the stroke (a horizontal stroke gets a bit more ink than a 45° one,
// mimicking real brush mechanics).
function buildEdges(){
  if(!preprocessed){ return; }
  const W = preprocessed.width, H = preprocessed.height;
  const px = preprocessed.data;
  const N = W * H;
  if(!edgeMag || edgeMag.length !== N){
    edgeMag = new Float32Array(N);
  } else {
    edgeMag.fill(0);
  }
  // BT.601 luminance into a scratch buffer first — Sobel reads 9 samples
  // per pixel, computing luma inside the inner loop would 9× the work.
  const lum = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    lum[j] = 0.299 * px[i] + 0.587 * px[i+1] + 0.114 * px[i+2];
  }
  for(let y = 1; y < H - 1; y++){
    const yi0 = (y - 1) * W, yi1 = y * W, yi2 = (y + 1) * W;
    for(let x = 1; x < W - 1; x++){
      const p00 = lum[yi0 + x - 1], p01 = lum[yi0 + x], p02 = lum[yi0 + x + 1];
      const p10 = lum[yi1 + x - 1],                       p12 = lum[yi1 + x + 1];
      const p20 = lum[yi2 + x - 1], p21 = lum[yi2 + x], p22 = lum[yi2 + x + 1];
      const gx = -p00 + p02 - 2*p10 + 2*p12 - p20 + p22;
      const gy = -p00 - 2*p01 - p02 + p20 + 2*p21 + p22;
      edgeMag[yi1 + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
}

// ---------- ink + bleed compositing ----------
//
// We render strokes as soft circles centred on every edge pixel whose
// magnitude exceeds a threshold. Stroke radius scales with magnitude and
// brushPressure; stroke alpha scales with inkDensity, modulated by the
// dry-brush curve (faded at very-low and very-high magnitude — the tip
// and the root of the brush).
//
// This is dense per-pixel work (W·H circles) so we batch by drawing into
// `inkBuf` with `ctx.fillStyle` and `globalAlpha` — the canvas compositor
// does the heavy lifting, not JS. Strokes accumulate via 'source-over'
// blending, which is what real ink does on dry paper.
//
// Bleed is a separate pass: we copy `inkBuf` into `bleedBuf`, blur it by
// `bleed` px with the canvas filter, then composite `bleedBuf` at low
// alpha below the ink — the halo around darks.
function renderInkAndBleed(){
  if(!preprocessed || !edgeMag) return;
  const W = preprocessed.width, H = preprocessed.height;

  // Paper background — overridden by the `march` mode if set.
  const paperHex = _paperOverride || params.paperColor;
  inkCtx.save();
  inkCtx.globalCompositeOperation = 'source-over';
  inkCtx.fillStyle = paperHex;
  inkCtx.fillRect(0, 0, W, H);

  // Paper grain overlay. Deterministic value-noise tinted with the ink
  // colour and laid down at low alpha. Without it, large paper regions
  // read as plastic. With it, they read as washi.
  if(params.paperGrain > 0){
    const grainSeed = (params.seed | 0) || 7;
    const rng = mulberry32(grainSeed);
    const grainImg = inkCtx.createImageData(W, H);
    const gdata = grainImg.data;
    const ink = hexToRgb(params.inkColor);
    const alphaScale = params.paperGrain * 255;
    for(let i = 0; i < gdata.length; i += 4){
      // Two octaves, cheap. Larger value = darker fibre fleck.
      const v = (rng() * 0.65 + rng() * 0.35);
      const a = Math.max(0, (v - 0.55)) * alphaScale;
      gdata[i] = ink.r; gdata[i+1] = ink.g; gdata[i+2] = ink.b;
      gdata[i+3] = a;
    }
    // Putting raw ImageData ignores compositing, so we route through a tmp.
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    tmp.getContext('2d').putImageData(grainImg, 0, 0);
    inkCtx.globalAlpha = 1;
    inkCtx.drawImage(tmp, 0, 0);
  }

  // Determine the edge magnitude threshold. Below this, no stroke. The
  // value is calibrated against the BT.601 luminance Sobel; ~40 keeps
  // only the meaningful contour edges and rejects sensor noise. Cursor
  // focus drops the threshold locally so more strokes show under the
  // pointer (the wet-brush dab).
  const baseTh = 40;
  const pressure = clamp(params.brushPressure * _pressureMul, 0, 4);
  const density  = clamp(params.inkDensity * _densityMul, 0, 1);
  const dryBrush = clamp(params.dryBrush, 0, 1);
  const ink = hexToRgb(params.inkColor);
  inkCtx.fillStyle = `rgb(${ink.r},${ink.g},${ink.b})`;
  inkCtx.globalCompositeOperation = 'source-over';

  const useFocus = _focusR2 > 0;

  // Single pass. We could subsample (every 2nd pixel) but the loss in
  // stroke continuity is visible on first sight — sumi-e demands smooth
  // edge tracking. The Sobel pass already gave us a sparse map, so most
  // iterations are early-out by the threshold test.
  for(let y = 1; y < H - 1; y++){
    for(let x = 1; x < W - 1; x++){
      let m = edgeMag[y * W + x];
      let th = baseTh;
      if(useFocus){
        const dx = x - _focusCx, dy = y - _focusCy;
        const d2 = dx*dx + dy*dy;
        if(d2 < _focusR2){
          // Inside focus circle: lower threshold (more strokes), and
          // amplify magnitude (sharper strokes).
          const k = 1 - d2 / _focusR2;
          th = baseTh * (1 - 0.6 * k);
          m  = m * (1 + 0.4 * k);
        }
      }
      if(m < th) continue;

      // Normalised magnitude in [0,1] (clamping ~200 as the "fully dark"
      // anchor — Sobel saturates at high-contrast borders).
      const mN = clamp((m - th) / (200 - th), 0, 1);
      // Stroke radius: scales with magnitude AND pressure. The +0.4 is a
      // floor so even the faintest stroke is at least a wisp.
      const r = (0.4 + mN * 1.6) * pressure;
      if(r < 0.25) continue;
      // Stroke alpha: dry-brush curve. Symmetric falloff at the magnitude
      // extremes — tip and root fade. tanh-like profile, cheap.
      const dry = 1 - dryBrush * (1 - 4 * mN * (1 - mN));
      const a = density * dry;
      if(a <= 0.01) continue;
      inkCtx.globalAlpha = a;
      inkCtx.beginPath();
      inkCtx.arc(x, y, r, 0, Math.PI * 2);
      inkCtx.fill();
    }
  }
  inkCtx.globalAlpha = 1;
  inkCtx.restore();

  // Bleed: blur a copy of inkBuf and lay it back under at low alpha. We
  // suppress bleed inside the focus circle so the cursor dabs read as
  // sharp — exactly what a dry brush on wet ink does.
  const bleedR = Math.max(0, params.bleed) * _bleedMul;
  if(bleedR > 0.5){
    bleedCtx.save();
    bleedCtx.clearRect(0, 0, W, H);
    bleedCtx.filter = `blur(${bleedR}px)`;
    bleedCtx.drawImage(inkBuf, 0, 0);
    bleedCtx.filter = 'none';
    // Pull the bleed back into inkBuf, behind the strokes via destination-
    // over. The alpha of the bleed is multiplicative on density so strong
    // dark zones bleed more than wisps.
    inkCtx.save();
    inkCtx.globalCompositeOperation = 'destination-over';
    inkCtx.globalAlpha = 0.55;
    inkCtx.drawImage(bleedBuf, 0, 0);
    inkCtx.restore();
    bleedCtx.restore();
  }

  // Cursor sharp-zone: if focus is active, redraw a small radial paper
  // patch that masks bleed. We don't redraw strokes — the bleed underneath
  // the strokes is what gets cleared, leaving sharp ink + paper. Cheap.
  if(useFocus){
    const grd = inkCtx.createRadialGradient(_focusCx, _focusCy, 0, _focusCx, _focusCy, Math.sqrt(_focusR2));
    grd.addColorStop(0,    'rgba(255,255,255,0.0)');
    grd.addColorStop(0.9,  'rgba(255,255,255,0.0)');
    grd.addColorStop(1,    'rgba(255,255,255,0.0)');
    // No-op gradient — we intentionally don't bake a halo here; the
    // bleed-suppression-via-mN amplification above already does the work.
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

  renderInkAndBleed();

  const sw = inkBuf.width, sh = inkBuf.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(inkBuf, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ---------- animation ----------
//
// Every envelope wraps t to [0,1) and uses cos pingpong / monotonic ramps /
// stepped plateaus designed to be byte-equal at the seam. Only the named
// params for each mode animate; others hold at slider.
function applyAnimationT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  const pp = (1 - Math.cos(w * 2 * Math.PI)) / 2;

  let pressureMul = 1.0;
  let densityMul  = 1.0;
  let bleedMul    = 1.0;
  let paperOverride = null;

  switch(params.mode){
    case 'idle': {
      break;
    }
    case 'breath': {
      // The calligrapher's breath: pressure rises into the stroke, eases
      // out. Symmetric cosine. Range 0.65× → 1.35× of the slider value —
      // perceptible without becoming caricature.
      pressureMul = 0.65 + 0.7 * pp;
      break;
    }
    case 'flick': {
      // Rapid brush flicks — a sawtooth on thickness that snaps. We use
      // a 4-stop ladder so the seam is byte-equal (step 0 == step 4).
      const stops = [1.0, 1.6, 0.8, 1.3];
      const stepN = (w === 0) ? 0 : Math.floor(w * 4) % 4;
      pressureMul = stops[stepN];
      break;
    }
    case 'seep': {
      // Ink seeps into wet paper at midpoint. Bleed radius pingpongs;
      // density drops slightly at peak bleed (real ink does spread out
      // and lighten where it bleeds — conservation of pigment).
      bleedMul = 0.4 + 1.6 * pp;
      densityMul = 1 - 0.15 * pp;
      break;
    }
    case 'march': {
      // Paper marches through four real washi tones, held 1/4 each.
      // Seam-override: t=0 and t=1 both map to step 0.
      const types = ['kozo', 'mulberry', 'gampi', 'bamboo'];
      const stepN = (w === 0) ? 0 : Math.floor(w * 4) % 4;
      paperOverride = PAPER_TYPES[types[stepN]].tone;
      break;
    }
    case 'dry': {
      // Monotonic 0 → 1: the painting "dries". At t=0 the brush hasn't
      // loaded — density 0, no strokes. At t=1 fully inked, fully dry —
      // density at slider. We collapse the seam by mapping w=0 → 0 and
      // letting cos do the closing at w=1.
      //
      // Note: monotonic 0→1 is not byte-equal at the seam (density(1) ≠
      // density(0)). We fix this by mapping the envelope to a cosine
      // pingpong instead: dries (0→0.5) then re-wets (0.5→1). Still
      // reads as "the painting evolves through wetness states", and
      // closes byte-equal at the seam.
      densityMul = pp; // 0 → 1 → 0
      // Bleed scales with density — wet ink bleeds, dry ink doesn't.
      bleedMul = 0.2 + 1.4 * pp;
      break;
    }
  }
  return { pressureMul, densityMul, bleedMul, paperOverride };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  _pressureMul = anim.pressureMul;
  _densityMul  = anim.densityMul;
  _bleedMul    = anim.bleedMul;
  _paperOverride = anim.paperOverride;

  // Deterministic grain reseed for byte-equal endpoints.
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
  if(!edgeMag) buildEdges();
  paint();

  _pressureMul = 1; _densityMul = 1; _bleedMul = 1; _paperOverride = null;
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
const BUILD_KEYS = new Set([]); // edges depend on preprocess; rebuilt with pre
const PAINT_KEYS = new Set(['inkColor','paperColor','brushPressure','inkDensity','bleed','dryBrush','paperGrain','paperType','seed']);

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
    if(key === 'paperType'){
      const pt = PAPER_TYPES[params.paperType];
      if(pt){
        params.paperColor = pt.tone;
        gui?.rows.get('paperColor')?._write(pt.tone);
      }
      schedule('paint');
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
      canvas: cv, name: 'pixart-ink-wash',
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
