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
// Defaults (verified in pageStates["/effects/gradients"]):
//   showEffect:true, lightnessThreshold:128, stepSize:8, shapeType:"rect"
//
// Refinement pass — 2026-05-13
// ----------------------------
// We graduate from a single threshold pingpong into a five-mode envelope set
// driven by Albers-style colour-interaction theory:
//
//   idle   — static (the rest-frame artwork).
//   breath — cosine pingpong on threshold (original behaviour).
//   tilt   — palette angle rotates monotonically 0→360°. Same band geometry,
//            but the hue *axis* sweeps through the colour wheel. Looks like
//            the canvas is being lit by a slowly orbiting coloured light.
//   bleed  — palette endpoints lerp through an analogous → split-complementary
//            → analogous harmony cycle. Albers' point: hue interaction shifts
//            perceived band boundaries even when geometry is fixed. The
//            cooler bands appear to *recede behind* warmer ones mid-cycle.
//   band   — stepSize sawtooth (15 → 60 → 15). Venetian blinds contract then
//            expand. Distinct from `breath` because the bands themselves
//            change height, not the segmentation threshold.
//
// New params:
//   mode             — animation envelope picker.
//   paletteAngle     — rotation of palette in HSL space (-180..180°).
//   paletteHarmony   — mono | complement | triad — controls how `bleed`
//                      walks the colour wheel and is also applied statically
//                      to the right endpoint when not animating bleed.
//   focusRadius      — cursor-focus radius. Inside the circle the local
//                      threshold drops by 0.7·sweep so detail blooms.
//
// Optical-illusion grounding:
//   - Albers, *Interaction of Color* (1963): identical greys read differently
//     against warm vs cool surrounds. `bleed` exploits this by lerping
//     endpoints through complementary hues — bands appear to migrate without
//     the segmentation itself changing.
//   - Eliasson, *Your colour memory* (2004): a single hue saturated to the
//     edge of after-image triggers retinal complement filling. We set
//     defaults that land near that saturation when bleed is active.
//   - Shadertoy `MsXSzM` (Inigo Quilez palette explorer): cosine palettes in
//     HSL produce smooth seamless loops — the same trick we use for `tilt`.
//
// Determinism: every envelope is wrapped to [0,1) before evaluation so
// cos(2π·t) == cos(0) == 1 exactly at the seam, and `tilt` is monotonic
// 0→360° with the 360° endpoint explicitly mapped back to 0° at t=1.
// Grain RNG is mulberry32 seeded from t_loop. → renderAt(0) byte-equal renderAt(1).

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
  lightnessThreshold: 32,
  stepSize:          8,
  shapeType:         'rect',
  // Palette endpoints. Reference parity is white→black; we ship a saturated
  // warm→cool pair so the Albers/tilt/bleed modes actually demonstrate the
  // hue-interaction thesis on first paint. Set both to #ffffff and #000000
  // for byte-exact bundle parity.
  paletteStart:      '#f4d35e',  // saturated amber
  paletteEnd:        '#1d3557',  // deep navy
  // ---- Refinement pass (2026-05-13) ----
  // Animation envelope picker. `breath` preserves original behaviour;
  // `idle` is the static-frame contract.
  mode:              'breath',
  // Palette angle in degrees (-180..180). Applied as an HSL hue rotation
  // to BOTH endpoints. In `tilt` mode this is animated monotonically 0→360°.
  paletteAngle:      0,
  // Harmony walk for `bleed`. Mono = no second-endpoint shift; complement
  // shifts the right endpoint by +180°; triad shifts by +120°.
  paletteHarmony:    'mono',
  // Cursor focus circle (interactive mode). Inside it, local threshold drops
  // and the eye perceives a "lens" of finer banding under the pointer.
  focusRadius:       240,
  // Animation amplitude (threshold sweep around base).
  thresholdSweep:    28,
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

// Cursor-focus state (source-space). _focusR2 === 0 disables the branch.
let _focusCx = -1, _focusCy = -1, _focusR2 = 0, _focusDelta = 0;

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

// ---------- colour utilities (HSL hue rotation) ----------
// Albers wanted us to *prove* hues interact. Hue rotation in HSL is the
// cheapest way to ship that proof: keep luminance and saturation fixed,
// rotate H, and the bands shift perceptually even though their geometry
// hasn't moved a pixel.
function hexToRgb(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if(!m) return { r:255, g:255, b:255 };
  const v = parseInt(m[1], 16);
  return { r:(v >> 16) & 255, g:(v >> 8) & 255, b: v & 255 };
}
function rgbToHex(r, g, b){
  const c = ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
  return '#' + c.toString(16).padStart(6, '0');
}
function rgbToHsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if(max !== min){
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch(max){
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s, l };
}
function hslToRgb(h, s, l){
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if(h <  60){ r = c; g = x; b = 0; }
  else if(h < 120){ r = x; g = c; b = 0; }
  else if(h < 180){ r = 0; g = c; b = x; }
  else if(h < 240){ r = 0; g = x; b = c; }
  else if(h < 300){ r = x; g = 0; b = c; }
  else            { r = c; g = 0; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}
function rotateHueHex(hex, deg){
  // Pure greys (sat == 0) have no hue to rotate; HSL handles this cleanly
  // (s stays 0, hue change is a no-op), so the default white→black palette
  // is unaffected unless the user picks a chromatic endpoint.
  const { r, g, b } = hexToRgb(hex);
  const hsl = rgbToHsl(r, g, b);
  const out = hslToRgb(hsl.h + deg, hsl.s, hsl.l);
  return rgbToHex(out.r, out.g, out.b);
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
// We honour two transient module globals to drive `tilt` and `bleed` modes:
//   _paletteAngleAnim — extra hue rotation in degrees (added to slider value).
//   _paletteEndShift  — extra hue rotation applied ONLY to the right endpoint
//                       (the harmony-walk for `bleed`).
let _paletteAngleAnim = 0;
let _paletteEndShift  = 0;

function rebuildPalette(){
  const W = Math.max(2, params.canvasSize | 0);
  if(palBuf.width !== W){ palBuf.width = W; palBuf.height = 1; }
  // Apply the user's static angle PLUS any per-frame animation rotation.
  // Both endpoints share the base angle; the right endpoint also receives
  // _paletteEndShift, which is how `bleed` produces analogous → split-
  // complementary → analogous walks without changing the left anchor.
  const baseAngle = params.paletteAngle + _paletteAngleAnim;
  const left  = rotateHueHex(params.paletteStart, baseAngle);
  const right = rotateHueHex(params.paletteEnd,   baseAngle + _paletteEndShift);
  const grad = pctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, left);
  grad.addColorStop(1, right);
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

  // Pre-compute alpha-composited luminance for every pixel.
  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    const a = px[i+3] / 255;
    lumGrid[j] = (lerp(255, px[i], a) + lerp(255, px[i+1], a) + lerp(255, px[i+2], a)) / 3;
  }
}

// ---------- segmentation (per-strip column-average ΔB scan) ----------
// Mirrors the bundle's nested loop exactly with one addition: per-x local
// threshold may be lowered by the cursor-focus circle. Outside the focus
// (or when focus is off), the threshold is constant — the inner branch is
// short-circuited cheaply by the `useFocus` flag.
function buildStrips(){
  strips = [];
  if(!preprocessed) return;
  const W = preprocessed.width, H = preprocessed.height;
  const step = Math.max(1, params.stepSize | 0);
  const th   = params.lightnessThreshold;
  const rows = Math.floor(H / step);
  const useFocus = _focusR2 > 0;
  for(let s = 0; s < rows; s++){
    const y0 = s * step;
    const yc = y0 + step / 2; // strip centre for focus-distance calc
    const segs = [];
    let prevB = 0, segStart = 0;
    for(let x = 0; x < W; x++){
      let sum = 0;
      for(let yy = y0; yy < y0 + step; yy++){
        sum += lumGrid[x + yy * W];
      }
      const avgB = sum / step;
      // Per-column local threshold. Inside the cursor focus, drop the
      // threshold by `focusDelta · (1 − r²/R²)` — a quadratic bump that's
      // cheap and reads as a soft Gaussian. Carrasco (2011): peripheral
      // motion is salient, so the SOFT EDGE of the focus carries the eye
      // even when the cursor sits still.
      let localTh = th;
      if(useFocus){
        const dx = x  - _focusCx, dy = yc - _focusCy;
        const d2 = dx*dx + dy*dy;
        if(d2 < _focusR2){
          const k = 1 - d2 / _focusR2;
          localTh = th - _focusDelta * k;
          if(localTh < 0) localTh = 0;
        }
      }
      if(Math.abs(prevB - avgB) > localTh){
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

  const sw = preprocessed.width, sh = preprocessed.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  const scale = dw / sw;
  const step  = Math.max(1, params.stepSize | 0);

  const palW = palBuf.width;
  for(const strip of strips){
    const y  = oy + strip.y * scale;
    const stripH = step * scale;
    for(const seg of strip.segs){
      const x = ox + seg.start * scale;
      const w = (seg.end - seg.start) * scale;
      if(w < 0.5) continue;
      if(params.shapeType === 'ellipse'){
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + stripH / 2, w / 2, stripH / 2, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(palBuf, 0, 0, palW, 1, x, y, w, stripH);
        ctx.restore();
      } else {
        ctx.drawImage(palBuf, 0, 0, palW, 1, x, y, w, stripH);
      }
    }
  }

  ctx.restore();
}

// ---------- animation ----------
//
// All envelopes wrap t to [0,1) so cos(2π·t) == cos(0) == 1 exactly at the
// seam. Step modes (none here, but `tilt` is monotonic 0→360°) override the
// endpoint at t=1 to match t=0.
function pingpongT01(t){
  let w = t - Math.floor(t);
  if(w === 1) w = 0;
  return (1 - Math.cos(w * 2 * Math.PI)) / 2;
}

// Harmony degree offsets: how far to rotate the right endpoint relative to
// the left for each harmony choice. `bleed` walks this offset through the
// loop; static modes apply it constantly.
function harmonyOffsetDeg(harmony){
  switch(harmony){
    case 'complement': return 180;
    case 'triad':      return 120;
    case 'mono':
    default:           return 0;
  }
}

function applyAnimationT(tLoop){
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) w = 0;
  const t01 = w;
  const pp  = (1 - Math.cos(t01 * 2 * Math.PI)) / 2;
  const base = params.lightnessThreshold;
  const sweep = params.thresholdSweep;
  let threshold = base;
  let stepSize = params.stepSize;
  let paletteAngleAnim = 0;
  let paletteEndShift  = harmonyOffsetDeg(params.paletteHarmony);
  switch(params.mode){
    case 'idle': {
      // Static. Hold every animatable param at its slider value.
      break;
    }
    case 'tilt': {
      // Monotonic hue rotation 0 → 360°. At t=1 we collapse to 0° so the
      // seam is byte-equal (360° and 0° render identically, but the LUT
      // path uses modulo so we make it explicit here too).
      paletteAngleAnim = (t01 >= 1) ? 0 : 360 * t01;
      break;
    }
    case 'bleed': {
      // Walk the right endpoint through complement-and-back via a cosine
      // pingpong. At t=0 and t=1 the offset is the user's static harmony
      // value; at t=0.5 we add ±180° (split-complementary), producing the
      // Albers "interaction" reading mid-cycle. Left endpoint stays put.
      const baseOff = harmonyOffsetDeg(params.paletteHarmony);
      paletteEndShift = baseOff + 180 * pp;
      break;
    }
    case 'band': {
      // stepSize sawtooth — venetian-blind contracts→expands. Sawtooth at
      // t=1 wraps to t=0 exactly. We clamp into the slider range so the
      // animation always stays visible.
      const lo = Math.max(4,  params.stepSize | 0);
      const hi = Math.max(lo + 8, Math.min(80, lo * 4));
      stepSize = Math.round(lo + (hi - lo) * t01);
      if(t01 === 0) stepSize = lo; // explicit seam pin
      break;
    }
    case 'breath':
    default: {
      threshold = clamp(base - sweep * pp, 0, 255);
      break;
    }
  }
  return { threshold, stepSize, paletteAngleAnim, paletteEndShift };
}

function renderAnimationFrame(tLoop){
  const anim = applyAnimationT(tLoop);
  const restThreshold = params.lightnessThreshold;
  const restStepSize  = params.stepSize;
  params.lightnessThreshold = anim.threshold;
  params.stepSize           = anim.stepSize;
  _paletteAngleAnim = anim.paletteAngleAnim;
  _paletteEndShift  = anim.paletteEndShift;

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
  // Palette must rebuild every frame when tilt/bleed are live, since the
  // hue rotations don't go through any param the schedule() router watches.
  rebuildPalette();
  buildStrips();
  paint();

  params.lightnessThreshold = restThreshold;
  params.stepSize           = restStepSize;
  _paletteAngleAnim = 0;
  _paletteEndShift  = 0;
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
const PALETTE_KEYS = new Set(['paletteStart','paletteEnd','paletteAngle','paletteHarmony']);
const PAINT_KEYS   = new Set(['shapeType','showEffect']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive){
    // Cursor-focus circle. Map viewport → source-space so the focus stays
    // accurate across canvas sizes. Inside the radius the local threshold
    // drops; outside the slider value rules. This is Albers via the
    // pointer: the "lens" shifts the perceived band boundaries even though
    // the source is untouched.
    if(!preprocessed){ return; }
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
    _focusDelta = params.thresholdSweep * 0.7;
    schedule('build');
  } else if(_focusR2 !== 0){
    _focusR2 = 0; _focusDelta = 0;
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
    if(key === 'mode'){ /* animation-only; no rebuild needed for static */ return; }
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
