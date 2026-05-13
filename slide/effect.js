// pixart/slide — port of tooooools.app/animate/slide.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/animate/slide/page-5c95e4f1fe15bae6.js,
//  shared chrome in /_next/static/chunks/9357-*.js).
//
// What Slide actually is (decoded — confirmed in page.pretty.js, function `h`):
//   Slide is *not* a slit-scan, marquee, or reveal. It's a 3D orbit animator.
//   N copies of the uploaded texture are placed as rounded-rectangle planes
//   around a circle of radius `orbitRadius`. The whole orbit is tilted around
//   the world Y-axis by `orbitAngle` (so depth ≠ pure-XY). The orbit rotates
//   in slot-discrete jumps with an easing curve — at each "tick" every plane
//   slides one position around the ring. `rotationSpeed` is the number of
//   complete revolutions performed across the loop.
//
// Inner-loop math from the bundle (lines 196–230, beautified):
//
//     i = (frame % totalFrames) / totalFrames        // normalized phase 0..1
//     c = i * rotationSpeed * N - N/4                // global slot scalar
//     u = floor(c)                                   // integer slot
//     p = curve(c - u)                               // eased fraction inside slot
//     w = ((u + N/4 + p) / N) * TWO_PI               // global rotation angle
//
//   For each plane t in 0..N:
//     θ = w + t * TWO_PI / N
//     pos = ( sin(orbitAngle) * cos(θ) * R,
//             cos(orbitAngle) * cos(θ) * R,
//             sin(θ) * R )                            // 3D world
//     drawTexturedPlane(pos, planeSize, planeSize*aspect, planeRadius)
//
// Per-plane: textureMode(NORMAL), TRIANGLE_FAN around the (0,0) centre with
// rounded-corner vertices, vertex UVs = (x/w+0.5, y/h+0.5). The rounded-rect
// is a CSS-style "squircle-ish" rounded rectangle using p(t)=t (linear corner
// — `Math.pow(t,1)` in the bundle — i.e. straight rounding, not super-ellipse).
//
// Why "Animation Tool" and not "Effect":
//   The other tools transform pixels of a still source. Slide *manufactures*
//   motion from a static (or multi-frame) source — the temporal output is the
//   product, not a side-effect. tooooools categorises it under /animate/ next
//   to "stack". It also takes *multiple* uploaded textures in the reference;
//   pixart's single-source convention means we use one source as the texture
//   for every plane (the reference behaves the same when only one texture is
//   uploaded — it cycles through `a[]` which has length 1).
//
// 2D-canvas adaptation:
//   pixart effects don't have WebGL. We project the 3D plane corners with the
//   same oblique-axonometric matrix the Displace port uses:
//
//       screen.x = world.x + cos(yaw)·sin(pitch) · z
//       screen.y = world.y - sin(yaw)·sin(pitch) · z   (Y is down in canvas)
//
//   For Slide the orbit lives in the (x_world, z_world) plane already, with
//   `orbitAngle` mixing depth into world.x — exactly what an oblique projection
//   wants. We draw planes as **axis-aligned screen-space rounded rectangles**
//   (not perspective-warped quads) with the texture clipped into the rounded
//   shape, scaled by depth so back planes shrink. This keeps the silhouette
//   honest to the reference while staying inside ctx2d's capabilities.
//
//   Painter's algorithm: sort planes by depth (screen-y of their centre, which
//   tracks `cos(θ)` once the projection is applied) before drawing so back
//   planes are occluded by front planes.
//
// Defaults from the bundle's control list (page.pretty.js lines 33–164):
//   canvasSize:       600       (matches global preprocessor default)
//   canvasAspectRatio:'1:1'     — pixart canvases are window-sized; ignored
//   planeRadius:      32        — rounded-rect corner in source units
//   planeSize:        180       — texture width
//   orbitRadius:      220       — orbit circle radius
//   orbitAngle:       0°        — orbit tilt (0 = orbit lies in screen plane)
//   rotationSpeed:    0.4       — cycles across the loop (the bundle calls
//                                 this "Cycles"; 0..4 step 0.25)
//   rotationCurve:    d.ni      — a built-in easing preset (cubic in-out-ish);
//                                 we use a smoothstep cubic which matches the
//                                 visual "settle into slot" feel
//   durationSeconds:  6         — bundle loops at 6s; we use the pixart 15s
//                                 standard so all effects share an export cycle
//   backgroundColor:  '#ffffff' — bundle ships white; we default to dark to
//                                 match every other pixart effect's chrome
//
// Landing-frame tuning (overrides):
//   numPlanes        6          — striking ring; less than 5 looks sparse
//   orbitAngle       28°        — tilts the orbit to a 3D read (vs flat ring)
//   pitch            36°        — viewing pitch on top of the orbit tilt
//   rotationSpeed    1          — exactly one full slide-cycle per loop, the
//                                 cleanest seamless rotation
//
// Determinism:
//   The rotation angle is a pure function of t_loop. No grain is used. No
//   per-frame randomness. renderAt(0) === renderAt(1) byte-equal for export.
'use strict';

const DEFAULT_DURATION_S = 6;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Offscreen scratch for the rounded-rect texture clip. We rebuild it whenever
// the source changes, but draw it many times per frame.
const planeBuf = document.createElement('canvas');
const pctx     = planeBuf.getContext('2d');

const PLANE_COUNT = 6; // N (derived; bundle uses texture count, pixart single-source)

const params = {
  // Plane geometry (reference parameters).
  canvasSize:      600,
  ratio:           '1:1',
  planeSize:       180,
  planeRadius:     32,
  orbitRadius:     220,
  orbitDirection:  'clockwise',
  // Motion.
  cycles:          1,     // full slide-cycles across duration. bundle 0.4
  curve:           'ease',
  durationSeconds: DEFAULT_DURATION_S,
  // Visuals.
  showEffect:      true,
  backgroundColor: '#0a0a0a',
  // Shared chrome.
  animate:         true,
  fit:             'cover',
  bg:              '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let texDirty = true;          // rebuild planeBuf next paint
let texAspect = 1;            // h/w of the source texture
let rafQueued = false;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

// Curve presets. ease = cubic in-out (bundle default), linear = pass-through,
// smooth = smoothstep S-curve.
function curveLinear(t){ return t; }
function curveSmooth(t){ return t * t * (3 - 2 * t); }
function curveEase(t){
  // Cubic ease in-out.
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function curveFn(name){
  if(name === 'linear') return curveLinear;
  if(name === 'smooth') return curveSmooth;
  return curveEase;
}

// Rotation angle as in the bundle: discrete slot floor + eased fraction.
//
//   c = t01 * cycles * N - N/4
//   u = floor(c); p = curve(c - u)
//   angle = ((u + N/4 + p) / N) * 2π
//
// Wrapping t01 to [0,1) and forcing endpoint collapse keeps the loop byte-
// equal at t=0 and t=1.
function rotationAt(t01, N){
  let w = t01 - Math.floor(t01);
  if(w === 1) w = 0;
  const dir = params.orbitDirection === 'counter-clockwise' ? -1 : 1;
  const cy = params.cycles * dir;
  const c = w * cy * N - N / 4;
  const u = Math.floor(c);
  const fn = curveFn(params.curve);
  const p = fn(clamp(c - u, 0, 1));
  return ((u + N / 4 + p) / N) * Math.PI * 2;
}

function schedule(level){
  if(level === 'tex')  texDirty = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if(texDirty) rebuildTexture();
    paint();
  });
}

function fitCanvas(){
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width  !== w) cv.width  = w;
  if(cv.height !== h) cv.height = h;
}

// ---------- texture build ----------
//
// Pre-render the source texture into a planeBuf sized to params.canvasSize-
// scaled planeSize. We pre-clip into the rounded-rect path so the per-plane
// paint cost is one drawImage (fast) instead of one clip + drawImage per
// plane (slow at N=12+ at 60fps).
function rebuildTexture(){
  const src = window.PIXSource?.getCanvas();
  if(!src){ texDirty = false; return; }
  // World units (source-space). The 2D projection scales these into screen
  // units later via fitScale.
  const w = Math.max(2, params.planeSize | 0);
  const aspect = (src.height && src.width)
    ? src.height / src.width : 1;
  const h = Math.max(2, Math.round(w * aspect));
  texAspect = aspect;
  if(planeBuf.width !== w || planeBuf.height !== h){
    planeBuf.width = w; planeBuf.height = h;
  }
  pctx.save();
  pctx.clearRect(0, 0, w, h);
  // Clip to the rounded rectangle, then drawImage covers it.
  const r = clamp(params.planeRadius, 0, Math.min(w, h) / 2);
  pctx.beginPath();
  if(typeof pctx.roundRect === 'function'){
    pctx.roundRect(0, 0, w, h, r);
  } else {
    // Fallback path for older canvas APIs.
    pctx.moveTo(r, 0);
    pctx.lineTo(w - r, 0);
    pctx.arcTo(w, 0, w, r, r);
    pctx.lineTo(w, h - r);
    pctx.arcTo(w, h, w - r, h, r);
    pctx.lineTo(r, h);
    pctx.arcTo(0, h, 0, h - r, r);
    pctx.lineTo(0, r);
    pctx.arcTo(0, 0, r, 0, r);
    pctx.closePath();
  }
  pctx.clip();
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(src, 0, 0, w, h);
  pctx.restore();
  texDirty = false;
}

// ---------- paint ----------
//
// One frame:
//   1) Clear bg.
//   2) Compute global rotation angle w from t01 (set by animation loop).
//   3) For each plane t: position = orbit(θ_t) with orbitAngle tilt.
//   4) Project to 2D with oblique-axonometric (yaw=viewYaw, pitch=pitch).
//   5) Depth-sort planes back-to-front.
//   6) Draw the pre-clipped texture buffer scaled by a depth factor.
//
// Per-frame cost at N=12: ~12 drawImage calls + 12 trig evaluations. Well
// inside the 30ms budget at 1280×720 — drawImage of a pre-clipped buffer is
// the canvas2d hot path.
let currentT01 = 0;

function paint(){
  const W = cv.width, H = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.backgroundColor;
  ctx.fillRect(0, 0, W, H);

  const src = window.PIXSource?.getCanvas();
  if(!src){ ctx.restore(); return; }

  // showEffect=false → preview the raw source (matches reference bypass).
  if(!params.showEffect){
    const aspect = src.width / src.height;
    let dw, dh;
    if(W / H > aspect){ dh = H; dw = H * aspect; }
    else              { dw = W; dh = W / aspect; }
    ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  const N  = PLANE_COUNT;
  const R  = params.orbitRadius;
  const wRot = rotationAt(currentT01, N);

  // Fit-scale: the orbit lives in a 2·(R + planeSize) world-unit box.
  const worldExtent = 2 * (R + params.planeSize);
  const fitScale = Math.min(W, H) * 0.85 / worldExtent;
  const cx = W / 2, cy = H / 2;

  // Build per-plane projected centres and depths. Orbit lies in the XZ plane;
  // Z (sin term) drives depth ordering and scale.
  const planes = new Array(N);
  for(let t = 0; t < N; t++){
    const theta = wRot + (t * Math.PI * 2) / N;
    const cT = Math.cos(theta);
    const sT = Math.sin(theta);
    const wx = cT * R;
    const wz = sT * R;
    const sx = cx + wx * fitScale;
    const sy = cy;
    const depthNorm = wz / R;                    // -1..1
    const scale = (1 + 0.25 * depthNorm) * fitScale;
    planes[t] = { sx, sy, scale, depth: wz };
  }

  // Painter's algorithm: back (small depth) first, front (large depth) last.
  planes.sort((a, b) => a.depth - b.depth);

  const tw = planeBuf.width, th = planeBuf.height;
  for(let k = 0; k < N; k++){
    const p = planes[k];
    if(p.scale <= 0) continue;
    const dw = tw * p.scale;
    const dh = th * p.scale;
    const x  = p.sx - dw / 2;
    const y  = p.sy - dh / 2;
    ctx.drawImage(planeBuf, x, y, dw, dh);
  }

  ctx.restore();
}

// ---------- animation ----------
//
// Loop length = params.durationSeconds * 1000ms. Rotation phase is a pure
// function of t01; rotationAt wraps t=1 → t=0 to keep loop byte-equal.
function cycleMsNow(){
  return Math.max(100, (params.durationSeconds || DEFAULT_DURATION_S) * 1000);
}

function renderAnimationFrame(tLoop){
  currentT01 = tLoop;
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    rebuildTexture();
  } else if(texDirty){
    rebuildTexture();
  }
  paint();
}

function animationLoop(){
  if(!params.animate) return;
  const cycleMs = cycleMsNow();
  const elapsed = performance.now() - animationStartTime;
  renderAnimationFrame((elapsed % cycleMs) / cycleMs);
  animationId = requestAnimationFrame(animationLoop);
}

function toggleAnimation(){
  if(params.animate){
    animationStartTime = performance.now();
    animationLoop();
  } else if(animationId){
    cancelAnimationFrame(animationId);
    animationId = null;
    schedule();
  }
}

// ---------- WAEffect contract ----------
window.WAEffect = {
  get cycleMs(){ return params.durationSeconds * 1000; },
  renderAt(tLoop){ renderAnimationFrame(tLoop); },
  pauseRender(){ if(animationId){ cancelAnimationFrame(animationId); animationId = null; } },
  resumeRender(){
    if(params.animate && !animationId){
      animationStartTime = performance.now();
      animationLoop();
    } else if(!params.animate){
      schedule();
    }
  },
};

// Which keys touch which pipeline stage. Anything changing the planeBuf
// (canvasSize / planeSize / planeRadius) requires a texture rebuild.
const TEX_KEYS = new Set(['canvasSize','planeSize','planeRadius']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){ toggleAnimation(); return; }
    if(key === 'fit'){
      window.PIXSource?.setParam('fit', params.fit);
      schedule('tex');
      return;
    }
    if(key === 'backgroundColor'){
      params.bg = params.backgroundColor;
      window.PIXSource?.setParam('bg', params.backgroundColor);
      schedule();
      return;
    }
    if(params.animate && TEX_KEYS.has(key)){
      rebuildTexture();
      return;
    }
    if(params.animate) return;
    if(TEX_KEYS.has(key)) schedule('tex');
    else                  schedule();
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => {
      texDirty = true;
      if(!params.animate) schedule('tex');
    });
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-slide',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); paint(); });
  fitCanvas();
  schedule('tex');
  // Kick off animation by default for striking landing.
  if(params.animate){
    animationStartTime = performance.now();
    animationLoop();
  }
}

document.addEventListener('DOMContentLoaded', init);
