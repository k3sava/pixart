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
// Step 2 (pattern-set): animation + interactive cursor layered on top.
//
// Defaults were chosen by sweeping each control alone across its full slider
// range against `portrait.jpg` in Playwright (see docs/step2-screenshots/ and
// docs/step2-research.md). Sweet spot for "bevel reads AND portrait stays
// recognizable":
//
//   depth=20           — reference default; ≥60 collapses face into grain.
//   lightAngle=45      — reference default; portrait reads at any angle so
//                        we keep the bundle value as the static landing.
//   blackPoint=0       — pulling bp up >100 starts dissolving the figure.
//   whitePoint=255     — full range; pre-tone-mode midpoint, mode shifts it.
//   effectThreshold=0  — every gradient writes a relief value; raising it
//                        produces a beautiful etched-outline-only look that
//                        the `etch` mode exploits.
//
// Animation modes (each = a gentle cosine envelope across cycleMs=15000):
//
//   breathe — lightAngle slowly orbits the subject (0 → 360, one revolution
//             per loop). Cursor-as-light's static cousin; cinematic.
//   tone    — whitePoint drifts above and below default (130 ↔ 255). The
//             relief "breathes" between pale charcoal and crisp etching.
//   etch    — effectThreshold cosine 0 ↔ 1.5. Subject's flat regions dissolve
//             to mid-grey and re-emerge — a rhythmic reveal.
//
// Interactive: cursor X drives lightAngle (light orbits with the cursor),
// cursor Y drives depth (5..80 — pressing down = deeper relief). One metaphor:
// cursor IS the light.
'use strict';

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

const srcBuf = document.createElement('canvas');
const sctx   = srcBuf.getContext('2d', { willReadFrequently: true });

const outBuf = document.createElement('canvas');
const octx   = outBuf.getContext('2d');

const params = {
  canvasSize:        600,
  blurAmount:        0,
  grainAmount:       0,
  gamma:             1,
  blackPoint:        0,
  whitePoint:        255,
  depth:             20,
  lightAngle:        45,
  effectThreshold:   0,
  animate:           false,
  mode:              'breathe',
  interactive:       false,
  showEffect:        true,
  fit:               'cover',
  bg:                '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let lumGrid = null;
let outData = null;
let dirty = { pre: true, build: true, paint: true };
let rafQueued = false;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t){ return a + (b - a) * t; }

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
      const n = (0.5 - Math.random()) * g * 255;
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

  const N = W * H;
  if(!lumGrid || lumGrid.length !== N) lumGrid = new Float32Array(N);
  for(let i = 0, j = 0; i < px.length; i += 4, j++){
    const a = px[i+3] / 255;
    lumGrid[j] = (lerp(255, px[i], a) + lerp(255, px[i+1], a) + lerp(255, px[i+2], a)) / 3;
  }

  if(!outData || outData.width !== W || outData.height !== H){
    outData = octx.createImageData(W, H);
  }
}

function buildBevel(){
  if(!preprocessed || !outData){ return; }
  const W = preprocessed.width, H = preprocessed.height;
  const px = preprocessed.data;
  const out = outData.data;
  const depth = params.depth;
  const th    = params.effectThreshold;
  const rad = (params.lightAngle * Math.PI) / 180;
  const lx  = Math.cos(rad);
  const ly  = Math.sin(rad);
  const dx = Math.round(lx);
  const dy = Math.round(ly);
  const dOff = dx + dy * W;

  out.fill(0);

  const x0 = 1, x1 = W - 1;
  const y0 = 1, y1 = H - 1;

  for(let y = y0; y < y1; y++){
    const rowL = y * W;
    for(let x = x0; x < x1; x++){
      const j = rowL + x;
      const i = j * 4;
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
      out[i] = v; out[i+1] = v; out[i+2] = v; out[i+3] = px[i+3];
    }
  }

  octx.putImageData(outData, 0, 0);
}

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

  const sw = outBuf.width, sh = outBuf.height;
  const aspect = sw / sh;
  let dw, dh;
  if(W / H > aspect){ dh = H * 0.96; dw = dh * aspect; }
  else              { dw = W * 0.96; dh = dw / aspect; }
  const ox = (W - dw) / 2, oy = (H - dh) / 2;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(outBuf, ox, oy, dw, dh);

  ctx.restore();
}

// ---------- animation ----------
//
// One pure renderAt(t01) that:
//   1. snapshots the user's "base" values of the modulated control
//      (so mode envelopes oscillate around the user-set defaults, not hard-
//       coded constants — moving the slider while animate is on still works);
//   2. applies the active mode's cosine envelope to the right control;
//   3. rebuilds the bevel + paints.
//
// We restore the base values after each frame so the GUI displays the user's
// intended defaults, not the momentary modulated value (otherwise the number
// boxes would visibly jitter every frame).
const CYCLE_MS = 15000;
let animationId = null;
let animationStartTime = 0;
let mouseX = 0, mouseY = 0, hasMouse = false;

// Cosine envelope: 0..1..0..1 across t in [0,1) — smooth ping-pong.
// Using (1 - cos(2π t)) / 2 = sine-shaped 0→1→0; for full-circle sweeps
// (e.g. lightAngle) we use plain t so it monotonically wraps the loop.
function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

function applyMode(t01){
  // returns {restore: () => void} so the caller can roll back after render.
  const mode = params.mode;
  if(mode === 'breathe'){
    const base = params.lightAngle;
    params.lightAngle = (t01 * 360) % 360;
    return () => { params.lightAngle = base; };
  }
  if(mode === 'tone'){
    // Drift whitePoint between 130 and 255 (verified-recognisable lower bound
    // from the whitePoint sweep). Centre at 192, amplitude 62.
    const base = params.whitePoint;
    params.whitePoint = 192 + 63 * Math.cos(t01 * Math.PI * 2);
    return () => { params.whitePoint = base; };
  }
  if(mode === 'etch'){
    // 0 ↔ 1.5 cosine. At 0 the full image, at 1.5 only high-gradient relief
    // survives. pingPong gives a gentle reveal/conceal rhythm.
    const base = params.effectThreshold;
    params.effectThreshold = 1.5 * pingPong(t01);
    return () => { params.effectThreshold = base; };
  }
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseAngle = params.lightAngle;
  const baseDepth = params.depth;
  params.lightAngle = ax * 360;
  // Y maps to depth 5..80 — top of canvas = shallow, bottom = deep relief.
  params.depth = 5 + ay * 75;
  return () => { params.lightAngle = baseAngle; params.depth = baseDepth; };
}

// Track whether the last frame baked a modulated whitePoint into the
// preprocessed buffer. If so, the next non-tone frame must re-preprocess
// using the user's actual whitePoint to wipe the leftover modulation.
let preprocessedIsToneModulated = false;
function renderAt(t01){
  // tone-mode modulates whitePoint, a preprocessor key — re-run preprocess.
  // lightAngle / effectThreshold / depth only need buildBevel().
  const isTone = params.animate && params.mode === 'tone';
  const needsPre = isTone || preprocessedIsToneModulated;
  const restoreMode = params.animate ? applyMode(t01) : () => {};
  const restoreInt  = applyInteractive();
  if(needsPre) preprocess();
  buildBevel();
  paint();
  restoreInt();
  restoreMode();
  preprocessedIsToneModulated = isTone;
}

function animationLoop(){
  if(!params.animate){ animationId = null; return; }
  const elapsed = performance.now() - animationStartTime;
  renderAt((elapsed % CYCLE_MS) / CYCLE_MS);
  animationId = requestAnimationFrame(animationLoop);
}

function startAnimation(){
  if(animationId) return;
  animationStartTime = performance.now();
  animationLoop();
}
function stopAnimation(){
  if(animationId){ cancelAnimationFrame(animationId); animationId = null; }
}

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  hasMouse = true;
  if(params.interactive && !params.animate){
    // Static interactive: render once per move.
    renderAt(0);
  }
}

window.WAEffect = {
  cycleMs: CYCLE_MS,
  renderAt(t){ renderAt(t || 0); return cv; },
  pauseRender(){ stopAnimation(); },
  resumeRender(){
    if(params.animate) startAnimation();
    else { paint(); }
    return cv;
  },
};

const PRE_KEYS   = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);
const BUILD_KEYS = new Set(['depth','lightAngle','effectThreshold']);
const PAINT_KEYS = new Set(['showEffect']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){
      if(params.animate) startAnimation();
      else { stopAnimation(); schedule('paint'); }
      return;
    }
    if(key === 'mode'){
      // Modes only matter when animating; nothing else changes.
      if(!params.animate) schedule('paint');
      return;
    }
    if(key === 'interactive'){
      if(!params.animate) schedule('paint');
      return;
    }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(params.animate) return; // animation loop owns the canvas
    if(PRE_KEYS.has(key))        schedule('pre');
    else if(BUILD_KEYS.has(key)) schedule('build');
    else                         schedule('paint');
  });
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', () => { hasMouse = false; if(!params.animate) schedule('paint'); });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-bevel',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
  if(params.animate) startAnimation();
}

document.addEventListener('DOMContentLoaded', init);
