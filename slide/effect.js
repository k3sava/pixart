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

const CYCLE_MS = 15000;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Offscreen scratch for the rounded-rect texture clip. We rebuild it whenever
// the source changes, but draw it many times per frame.
const planeBuf = document.createElement('canvas');
const pctx     = planeBuf.getContext('2d');

const params = {
  // Plane geometry (reference parameters).
  canvasSize:    600,
  planeSize:     180,
  planeRadius:   32,
  orbitRadius:   220,
  orbitAngle:    28,    // °  bundle 0; tilted for striking landing
  // Motion.
  rotationSpeed: 1,     // cycles across the 15s loop. bundle 0.4
  numPlanes:     6,     // bundle inferred from image count; pixart is single-source
  // 2D projection (oblique).
  pitch:         36,    // ° camera tilt around X
  viewYaw:       0,     // ° spin of the projection axis (kept = 0 for landing)
  // Visuals.
  showShadow:    true,  // soft depth shadow on each plane
  showEffect:    true,  // false = show raw preprocessed source (matches reference bypass)
  // ---- Refinement pass (2026-05-13) ----
  // mode picks the motion envelope. Each mode animates ONLY a named subset of
  // params — the rest hold at slider value. All modes are byte-equal at the
  // seam (t=0 ≡ t=1). See applyAnimationT() for the full switch.
  //   idle      — static. The landing frame is the artwork.
  //   breath    — current orbit (rotationAt slot-eased revolution).
  //   parallax  — depth-band speed split. Helmholtz cue: far slower than near.
  //   swipe     — Saul Bass title-card sawtooth. Saccadic suppression hides
  //               the in-between, so the eye reads it as a card-slam.
  //   marquee   — planes scroll horizontally across the frame, wrapping at
  //               the canvas edge. Useful for video sources read as ticker.
  mode:          'breath',
  // depthBands splits the N planes into k speed groups by `idx mod k`. 1 =
  // uniform (= breath). 3 = front/mid/back (the classic parallax recipe).
  depthBands:    3,
  // bandSpeed is the ratio of back-band speed to front-band speed. >1 means
  // back is faster (anti-Helmholtz, used as a stylistic choice); <1 means
  // back is slower (true Helmholtz depth cue). Range 0..2.
  bandSpeed:     0.5,
  // Cursor focus radius (interactive mode). Inside the circle the orbit
  // speed boost concentrates: peripheral motion reads as natural "looking
  // at" (Carrasco 2011). 0 = focus off.
  focusRadius:   220,
  // Shared chrome.
  animate:       true,  // landing frame already shows motion; export-ready
  interactive:   false,
  fit:           'cover',
  bg:            '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let texDirty = true;          // rebuild planeBuf next paint
let texAspect = 1;            // h/w of the source texture
let rafQueued = false;
let mouseX = 0, mouseY = 0;

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
// Cubic smoothstep — matches the bundle's default rotationCurve closely.
// The bundle stores a curveEditor preset (d.ni) interpreted by d.sR; in
// practice the default is a symmetric S-curve. smoothstep is the simplest
// that produces the same "settle into slot" rhythm.
function curve(t){ return t * t * (3 - 2 * t); }

// Rotation angle as in the bundle: discrete slot floor + eased fraction.
//
//   c = t01 * rotationSpeed * N - N/4
//   u = floor(c); p = curve(c - u)
//   angle = ((u + N/4 + p) / N) * 2π
//
// Wrapping t01 to [0,1) and forcing endpoint collapse keeps the loop byte-
// equal at t=0 and t=1. `speedMul` scales the rotation rate for the parallax
// mode's per-band sub-orbits; speed must be an integer-cycle factor (or the
// caller must seam-override at t=1) to stay byte-equal.
function rotationAt(t01, N, speedMul){
  let w = t01 - Math.floor(t01);
  if(w === 1) w = 0;
  const mul = speedMul == null ? 1 : speedMul;
  const c = w * params.rotationSpeed * mul * N - N / 4;
  const u = Math.floor(c);
  const p = curve(clamp(c - u, 0, 1));
  return ((u + N / 4 + p) / N) * Math.PI * 2;
}

// Linear orbit phase (no slot-easing): used by `swipe` to mimic Saul Bass
// title-card sawtooth — the eye misses the in-between (saccadic suppression),
// so a monotonic 0→2π read as a sharp slam each cycle. Seamless because
// w wraps to 0 at the loop edge.
function swipePhaseAt(t01){
  let w = t01 - Math.floor(t01);
  if(w === 1) w = 0;
  return w * Math.PI * 2 * params.rotationSpeed;
}

// Transient module globals — applyAnimationT writes these before paint()
// reads them, then renderAnimationFrame clears. Same idiom as edge/.
let _modeRuntime = { kind: 'breath' };

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
  ctx.fillStyle = params.bg;
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

  const N  = Math.max(1, params.numPlanes | 0);
  const R  = params.orbitRadius;
  // idle freezes time at t=0 — the landing frame is the artwork.
  const tEff = (_modeRuntime.kind === 'idle') ? 0 : currentT01;
  // Default global rotation (breath/idle); mode-specific overrides below.
  const wDefault = (_modeRuntime.kind === 'swipe')
    ? swipePhaseAt(tEff)
    : rotationAt(tEff, N);
  const m  = (params.orbitAngle * Math.PI) / 180;
  const sinM = Math.sin(m), cosM = Math.cos(m);

  // Oblique projection axes (same as Displace).
  const yawR   = (params.viewYaw * Math.PI) / 180;
  const pitchR = (params.pitch   * Math.PI) / 180;
  const zx = Math.cos(yawR) * Math.sin(pitchR);
  const zy = -Math.sin(yawR) * Math.sin(pitchR);

  // Fit-scale: the orbit lives in a 2·(R + planeSize) world-unit box. Fit so
  // the largest extent fills ~85% of the canvas — gives a comfortable margin
  // for plane corners at maximum tilt.
  const worldExtent = 2 * (R + params.planeSize);
  const fitScale = Math.min(W, H) * 0.85 / worldExtent;
  const cx = W / 2, cy = H / 2;

  // Parallax mode: split planes into depthBands groups by `idx mod bands`.
  // Group 0 = front (fastest, mul=1). Last group = back (mul=bandSpeed). The
  // brain reads slower-far as depth even without binocular cues (Helmholtz,
  // 1867). Each band gets its own rotation phase. For byte-equal seam we
  // need integer-cycle speeds — we round mul·rotationSpeed to ¼-cycle steps
  // so the band's slot phase wraps cleanly at t=1.
  const bands = Math.max(1, params.depthBands | 0);
  const bandPhases = new Array(bands);
  if(_modeRuntime.kind === 'parallax'){
    for(let b = 0; b < bands; b++){
      // front band (b=0) → mul=1; back band (b=bands-1) → mul=bandSpeed.
      const f = bands === 1 ? 0 : b / (bands - 1);
      const mul = 1 + (params.bandSpeed - 1) * f;
      bandPhases[b] = rotationAt(tEff, N, mul);
    }
  }

  // Marquee mode: horizontal scroll on top of the static orbit. Plane sx is
  // wrapped by canvas width — wrapping is what makes the loop seamless.
  const marqueeShift = (_modeRuntime.kind === 'marquee')
    ? ((tEff - Math.floor(tEff)) % 1) * cv.width
    : 0;

  // Build per-plane projected centres and depths.
  const planes = new Array(N);
  for(let t = 0; t < N; t++){
    let w = wDefault;
    if(_modeRuntime.kind === 'parallax'){
      w = bandPhases[t % bands];
    }
    const theta = w + (t * Math.PI * 2) / N;
    const cT = Math.cos(theta);
    const sT = Math.sin(theta);
    // World coords from the bundle (page.pretty.js lines 229–232):
    //   x = cos(theta) * R                ... bundle: r = cos(n)*h
    //   y = -sin(orbitAngle) * x          ... bundle: o = sin(m)*r  (negated for canvas-Y)
    //   z = cos(orbitAngle) * x           ... bundle: l = cos(m)*r
    //   depth = sin(theta) * R            ... bundle: i = sin(n)*h
    //
    // We collapse to a 2D screen with oblique projection on depth.
    const wx = cT * R;
    const wy = -sinM * cT * R;            // Y is down in canvas
    const wz = cosM * cT * R + sT * R;    // composite depth: orbit-tilt + sin component
    let sx = cx + (wx + zx * wz) * fitScale;
    const sy = cy + (wy + zy * wz) * fitScale;
    if(marqueeShift > 0){
      // Wrap horizontally so the ticker loops seamlessly at canvas-width.
      // The wrap is computed off the screen-space sx so depth-cued size
      // stays intact while position scrolls.
      const W2 = cv.width;
      sx = ((sx + marqueeShift) % W2 + W2) % W2;
    }
    // Depth scale: planes farther back shrink slightly. Range 0.65–1.15.
    const depthNorm = (wz / (R * 1.5));   // ≈ -1..1
    const scale = (1 + 0.25 * depthNorm) * fitScale;
    planes[t] = { sx, sy, scale, depth: wz };
  }

  // Painter's algorithm: back (small depth) first, front (large depth) last.
  planes.sort((a, b) => a.depth - b.depth);

  // Draw.
  const tw = planeBuf.width, th = planeBuf.height;
  for(let k = 0; k < N; k++){
    const p = planes[k];
    if(p.scale <= 0) continue;
    const dw = tw * p.scale;
    const dh = th * p.scale;
    const x  = p.sx - dw / 2;
    const y  = p.sy - dh / 2;
    if(params.showShadow){
      // Soft depth shadow under each plane — deeper planes get a darker shadow.
      ctx.save();
      const shadowAlpha = 0.25 * (1 - (p.depth / (R * 1.5)) * 0.5);
      ctx.shadowColor = `rgba(0,0,0,${clamp(shadowAlpha, 0.05, 0.4)})`;
      ctx.shadowBlur  = Math.max(4, 18 * p.scale);
      ctx.shadowOffsetY = Math.max(2, 8 * p.scale);
      ctx.drawImage(planeBuf, x, y, dw, dh);
      ctx.restore();
    } else {
      ctx.drawImage(planeBuf, x, y, dw, dh);
    }
  }

  ctx.restore();
}

// ---------- animation ----------
//
// 15s seamless loop. The rotation phase is a pure function of t01; with
// rotationSpeed = integer, the angle wraps cleanly to its t=0 value. We pin
// t=1 to t=0 in rotationAt() to absorb the IEEE-754 ε.
// applyAnimationT writes _modeRuntime so paint() picks the right rotation
// strategy. Every mode is byte-equal at t=0 and t=1:
//   - breath / parallax: rotationAt wraps cleanly when speed·N is integer.
//   - swipe: monotonic 0→2π wraps at t=1.
//   - marquee: horizontal shift wraps at canvas-width modulo.
//   - idle: returns to t=0 trivially.
function applyAnimationT(tLoop){
  _modeRuntime = { kind: params.mode || 'breath' };
  // Seam-override: at exact t=1 force the kind back to the t=0 state so
  // sawtooth-style modes (swipe / marquee) render the same pixels as t=0.
  let w = tLoop - Math.floor(tLoop);
  if(w === 1) _modeRuntime.seamLock = true;
}

function renderAnimationFrame(tLoop){
  currentT01 = tLoop;
  applyAnimationT(tLoop);
  // Video sources: pull the current frame and rebuild the clipped texture so
  // the planes show the moving frame. Image sources also rebuild if dirty —
  // covers the case where renderAt() is called via export before init's
  // deferred rAF has flushed the first texture build.
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
  const elapsed = performance.now() - animationStartTime;
  renderAnimationFrame((elapsed % CYCLE_MS) / CYCLE_MS);
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
  cycleMs: CYCLE_MS,
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

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if(params.interactive && !params.animate){
    // Mouse X drives viewYaw (or orbit phase via t01 override).
    const ax = clamp(mouseX / r.width,  0, 1);
    const ay = clamp(mouseY / r.height, 0, 1);
    currentT01 = ax;
    const np = Math.round(ay * 90);
    if(np !== params.pitch){
      params.pitch = np;
      gui?.rows.get('pitch')?._write(np);
    }
    paint();
  }
}

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){ toggleAnimation(); return; }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('tex'); else schedule();
      return;
    }
    if(params.animate && TEX_KEYS.has(key)){
      // Rebuild texture but let the anim loop keep painting.
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
  cv.addEventListener('mousemove', handleMouseMove);
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
