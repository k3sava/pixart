// pixart/stack — port of tooooools.app/animate/stack.
//
// Reverse-engineered from the minified bundle
// (/_next/static/chunks/app/animate/stack/page-a8a2fe83ef4491d6.js,
//  shared chrome + curve presets in /_next/static/chunks/9357-*.js).
//
// What Stack actually is (decoded — confirmed in stack.pretty.js, function `g`):
//   Stack is a *card-deal* animator. N textured rounded-rectangle "cards" are
//   pinned to the canvas centre. Each card has:
//     - a deterministic randomised z-rotation drawn from [-rotationRange,
//       +rotationRange] degrees, seeded via FNV-1a hash of cardKey:rotationSeed
//     - a deterministic randomised (x,y) shift in [-cardShiftX..+cardShiftX] ×
//       [-cardShiftY..+cardShiftY], scaled by a global "spread" factor `l`
//   The animation deals cards onto the stack one at a time. Each loop tick a
//   `visibleCount` is computed from an easing curve applied to the loop phase,
//   ramping from 0 → N·stackCycles+1 visible cards. Cards are drawn in order;
//   visibleCount controls how many are painted. Reaching N reveals the full
//   fanned-out stack. With stackCycles>1, the deal repeats — cards 0..N-1 cycle
//   stackCycles times across the loop (each new "round" deals the same cards
//   again on top, identical to the reference: `c % s` indexing).
//
// Inner-loop math from the bundle (stack.pretty.js lines 228–252, beautified):
//
//   visibleCount(frameIdx):
//     cycles = max(1, round(stackCycles ?? 3))         // bundle default 3
//     s = max(1, totalFrames - 1)
//     c = (frameIdx % totalFrames) / s                 // phase 0..1 incl endpoints
//     d = constrain(c / (cycles>1 ? (cycles-1)/cycles : 1), 0, 1)
//     h = N * cycles
//     return min(h, floor(curve(d) * (h + 1)))
//
//   per-card placement (stack.pretty.js lines 260–296):
//     rot   = map(hash("card-"+idx + ":" + seed),       0, 1, -range, +range)
//     shift = ( map(hash(key+":"+drawIdx+":"+seed+":x"), 0, 1, -shiftX, shiftX),
//               map(hash(key+":"+drawIdx+":"+seed+":y"), 0, 1, -shiftY, shiftY) ) * l
//
//   where `l = max(1, min(W,H)) / 600` is the canvasSize→world-units scale
//   and `drawIdx` is the *deal-index* (not card-index), so even repeated
//   cards (cycle 2+) land at a fresh shift but keep the same rotation.
//
// Per-card draw: TRIANGLE_FAN around (0,0) with rounded-corner vertices
// (linear corner profile, `p(t) = Math.pow(t, 1)`), UVs `(x/w + 0.5, y/h + 0.5)`.
//
// Why "Animation Tool" and not "Effect":
//   The other pixart effects transform pixels of a still source. Stack
//   *manufactures motion* — it deals copies of the source onto a layered
//   pile, progressive in time, with deterministic per-card shifts/rotations.
//   tooooools categorises it under /animate/ alongside slide.
//
// 2D-canvas adaptation (no WebGL):
//   The bundle uses p5 WEBGL with a textured TRIANGLE_FAN to clip the source
//   into a rounded rectangle. Canvas2D has `roundRect` which produces the
//   identical silhouette. Per card: clip to rounded-rect path, drawImage,
//   restore. To avoid re-clipping the texture per card per frame we pre-bake
//   the rounded-clipped source into an offscreen buffer (`cardBuf`) once per
//   source-change. Drawing a card = ctx.translate + rotate + drawImage —
//   the canvas2d hot path. At N=24 the per-frame cost is ~24 drawImage calls
//   + 24 trig evaluations, well inside the 30ms budget at 1280×720.
//
// Single-source adaptation:
//   The reference accepts multiple uploaded textures (`multiple: !0`). pixart
//   is single-source by convention. The reference *already* handles single-
//   texture mode by cycling `a[idx % a.length]` so all cards show the same
//   image — we behave the same. For visual interest with one source we
//   tilt the colour balance subtly per card (a faint multiply tint based on
//   the card index) so the stack reads as discrete cards, not one card
//   over-painted. The tint is OFF by default (`tintCards: false`) — the
//   landing frame relies on rotation+shift alone, matching the reference.
//
// Defaults from the bundle's control list + shared state (9357-*.js):
//   canvasSize:        600
//   canvasAspectRatio: '3:4'   — ignored (pixart canvases are window-sized)
//   cardRadius:        18
//   cardSize:          260
//   rotationRange:     12
//   rotationSeed:      1
//   cardShiftX:        0       — reference ships zero shift (pure rotational fan)
//   cardShiftY:        0
//   stackCycles:       3
//   stackCurve:        'ease-out' (the bundle's u.tW preset; concave-down)
//   durationSeconds:   16
//   backgroundColor:   '#f9f8f5'
//
// Landing-frame tuning (pixart overrides for striking first paint):
//   numCards:        8        — substantial pile; <5 looks sparse, >12 muddies
//   cardShiftX:      18       — gentle horizontal spread; bundle 0 is too rigid
//   cardShiftY:      24       — gentle vertical spread (slightly stronger so
//                               the stack reads as a deal, not a fan)
//   rotationRange:   14       — close to bundle's 12; bumped for visual life
//   stackCycles:     2        — the loop deals the deck twice; cleaner than 3
//   bg:              '#0a0a0a' — matches every other pixart tool's dark chrome
//   animate:         true     — the landing frame already shows motion (deal in
//                               progress); without this Stack is just a still
//
// Step 2 (pattern-set): mode pills + interactive toggle layered on top of the
// existing deal animator.
//
// Animation modes (each runs across the existing cycleMs = durationSeconds*1000):
//
//   deal   — the default card-deal motion from the bundle. Phase = t01.
//   breath — cardSize cosine-pingpongs (200 ↔ 320) while the deal plays. Cards
//            inflate and deflate while landing on the pile. Mutates cardSize per
//            frame, marks texture dirty so the rounded-clipped buffer rebuilds.
//   swirl  — rotationRange cosine-pingpongs (4 ↔ 28) while the deal plays. The
//            fan-spread tightens and loosens — visually distinct from breath
//            (rotation amplitude vs card scale).
//
// Interactive: cursor X → cardSize (120..420), cursor Y → rotationRange
// inverted (0..40). The cursor shapes the pile geometry — wider/narrower fan,
// fatter/thinner cards. Only active when interactive=true. Works alongside
// animate (live cursor reshape during the deal) and without it (frozen pose).
//
// Static default (animate=false): freeze at t01=0.5. With cycles=2 the deal
// curve reaches 1 at t01=0.5 so the entire pile is visible — at t01=0 no
// cards have been dealt yet, so a "freeze at 0" would render nothing. The
// 0.5 freeze guarantees the portrait reads on the stack in the still pose.
//
// Determinism:
//   Per-card rotation depends only on (cardIndex, rotationSeed). Per-card shift
//   depends on (cardIndex, drawIndex, rotationSeed). All seeded by FNV-1a, no
//   floating-point drift. Easing curve is a pure function of t01. We pin t=1
//   to t=0 so renderAt(0) === renderAt(1) byte-equal for export. For video
//   sources, the card texture is rebuilt from PIXSource.advanceFrame() each
//   tick; since advanceFrame() is itself driven by t_loop in PIXSource, the
//   accumulated stack is deterministic from t_loop alone.
'use strict';

const DEFAULT_DURATION_SECONDS = 6;

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Offscreen scratch for the rounded-clipped texture. Rebuilt on source change
// or geometry change; reused many times per frame.
const cardBuf = document.createElement('canvas');
const bctx    = cardBuf.getContext('2d');

// Hardcoded default — bundle inferred numCards from upload count, but
// pixart is single-source so we pin to a substantial pile.
const DEFAULT_NUM_CARDS = 8;

const params = {
  // Card geometry (reference parameters).
  canvasSize:    600,
  ratio:         '1:1',
  cardSize:      260,
  cardRadius:    18,
  // Stack composition.
  rotationRange: 14,      // °  bundle 12
  rotationSeed:  1,
  xShiftScale:   18,      // px (source-space) bundle 0
  yShiftScale:   24,      // px (source-space) bundle 0
  // Motion.
  cycles:          2,     // bundle 3
  speed:           'linear', // faster / linear / slower
  durationSeconds: DEFAULT_DURATION_SECONDS,
  // Visuals.
  backgroundColor: '#ffffff',
  showEffect:    true,    // false = preview raw source (matches reference bypass)
  // Step 2 controls.
  mode:          'deal',
  interactive:   false,
  // Shared chrome.
  animate:       true,    // landing frame shows a deal-in-progress
  fit:           'cover',
  bg:            '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let animationId = null;
let animationStartTime = 0;
let texDirty = true;
let texAspect = 1;
let rafQueued = false;
let mouseX = 0, mouseY = 0, hasMouse = false;
let currentT01 = 0;

// Cosine pingpong: 0 → 1 → 0 across t01 ∈ [0,1).
function pingPong(t){ return 0.5 - 0.5 * Math.cos(t * Math.PI * 2); }

// applyMode: mutates params per-frame, returns a restore closure. Called from
// renderAnimationFrame so it covers animate=true and animate=false alike.
function applyMode(t01){
  const mode = params.mode;
  if(mode === 'breath'){
    // cardSize ping-pongs 200 ↔ 320 across the loop. cardSize drives the
    // offscreen texture buffer, so mark texture dirty.
    const base = params.cardSize;
    params.cardSize = Math.round(200 + 120 * pingPong(t01));
    texDirty = true;
    return () => { params.cardSize = base; };
  }
  if(mode === 'swirl'){
    // rotationRange ping-pongs 4 ↔ 28 across the loop. Texture buffer is
    // unaffected (rotation is per-card transform, not in the buffer).
    const base = params.rotationRange;
    params.rotationRange = 4 + 24 * pingPong(t01);
    return () => { params.rotationRange = base; };
  }
  // 'deal' default — no-op
  return () => {};
}

function applyInteractive(){
  if(!params.interactive || !hasMouse) return () => {};
  const r = cv.getBoundingClientRect();
  const ax = clamp(mouseX / r.width,  0, 1);
  const ay = clamp(mouseY / r.height, 0, 1);
  const baseS = params.cardSize;
  const baseR = params.rotationRange;
  params.cardSize      = Math.round(120 + ax * 300);  // 120..420
  params.rotationRange = (1 - ay) * 40;               // 0..40 (Y inverted)
  texDirty = true;
  return () => { params.cardSize = baseS; params.rotationRange = baseR; };
}

// ---------- helpers ----------
function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function mapRange(v, a, b, c, d){ return c + (d - c) * ((v - a) / (b - a)); }

// FNV-1a 32-bit, returns [0,1). Matches the bundle's `h()` byte-for-byte:
//   t = 0x811c9dc5
//   for each char c: t = (t ^ c) * 0x01000193 (Math.imul)
//   return (t >>> 0) / 0xffffffff
function fnv01(str){
  let t = 2166136261;
  for(let i = 0; i < str.length; i++){
    t ^= str.charCodeAt(i);
    t = Math.imul(t, 16777619);
  }
  return (t >>> 0) / 4294967295;
}

// Easing presets. The bundle stores curveEditor JSON evaluated by `u.sR`;
// these three closed-forms cover the user-visible presets (faster / linear / slower).
function ease(t, kind){
  // speed select: faster / linear / slower
  if(kind === 'linear') return t;
  if(kind === 'slower') return t * t;             // slow start
  if(kind === 'faster') return 1 - (1 - t) * (1 - t); // front-loaded
  // legacy fallbacks
  if(kind === 'ease-in') return t * t;
  return 1 - (1 - t) * (1 - t);
}

function schedule(level){
  if(level === 'tex') texDirty = true;
  if(rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    // Route through renderAnimationFrame so mode/interactive apply in the
    // static (animate=off) path too.
    renderAnimationFrame(currentT01);
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
// Pre-render the source into a rounded-clipped buffer at cardSize world units.
// All cards share this buffer; only their transform differs.
function rebuildTexture(){
  const src = window.PIXSource?.getCanvas();
  if(!src){ texDirty = false; return; }
  const w = Math.max(2, params.cardSize | 0);
  const aspect = (src.height && src.width) ? src.height / src.width : 1;
  const h = Math.max(2, Math.round(w * aspect));
  texAspect = aspect;
  if(cardBuf.width !== w || cardBuf.height !== h){
    cardBuf.width = w; cardBuf.height = h;
  }
  bctx.save();
  bctx.clearRect(0, 0, w, h);
  const r = clamp(params.cardRadius, 0, Math.min(w, h) / 2);
  bctx.beginPath();
  if(typeof bctx.roundRect === 'function'){
    bctx.roundRect(0, 0, w, h, r);
  } else {
    // Fallback (linear corner profile, matching bundle's p(t)=t).
    bctx.moveTo(r, 0);
    bctx.lineTo(w - r, 0);
    bctx.arcTo(w, 0, w, r, r);
    bctx.lineTo(w, h - r);
    bctx.arcTo(w, h, w - r, h, r);
    bctx.lineTo(r, h);
    bctx.arcTo(0, h, 0, h - r, r);
    bctx.lineTo(0, r);
    bctx.arcTo(0, 0, r, 0, r);
    bctx.closePath();
  }
  bctx.clip();
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(src, 0, 0, w, h);
  bctx.restore();
  texDirty = false;
}

// ---------- visible count (bundle parity) ----------
//
// Matches the bundle's `visibleCount` calc exactly. We accept t01 directly
// (continuous) instead of frameIdx/totalFrames (discrete) — the math
// collapses identically because c is just the wrapped phase.
function visibleCountAt(t01, N){
  if(N <= 0) return 0;
  const cycles = Math.max(1, Math.round(params.cycles));
  // wrap & pin endpoint
  let w = t01 - Math.floor(t01);
  if(w === 1) w = 0;
  // Bundle: c = (a % o) / (o-1). Continuous form: c = w (already in [0,1]).
  const c = w;
  const d = clamp(c / (cycles > 1 ? (cycles - 1) / cycles : 1), 0, 1);
  const h = N * cycles;
  return Math.min(h, Math.floor(ease(d, params.speed) * (h + 1)));
}

// ---------- paint ----------
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

  const N = DEFAULT_NUM_CARDS;
  const vis = visibleCountAt(currentT01, N);
  if(vis === 0){ ctx.restore(); return; }

  // World-unit → screen scale. The bundle uses `l = max(1, min(W,H)) / 600`.
  // We keep that exact factor so cardSize / cardShift map identically.
  const l = Math.max(1, Math.min(W, H)) / 600;
  const tw = cardBuf.width, th = cardBuf.height;
  const dw = tw * l, dh = th * l;
  const cx = W / 2, cy = H / 2;
  const seed = params.rotationSeed | 0;
  const rangeRad = (params.rotationRange * Math.PI) / 180;

  // Bundle iterates `r = 0..visibleCount`. Card index = r % N, draw index = r.
  // We render in deal order so later cards occlude earlier ones (no z-sort).
  for(let r = 0; r < vis; r++){
    const cardIdx = r % N;
    const key = 'card-' + cardIdx;
    // Rotation: depends only on (cardIdx, seed). Cycling redeals the same
    // card with the same rotation — matches reference behaviour.
    const rotN = fnv01(key + ':' + seed);
    const rot  = mapRange(rotN, 0, 1, -rangeRad, rangeRad);
    // Shift: depends on (cardIdx, drawIdx, seed). Each cycle the same card
    // gets a fresh shift, so cycle 2+ doesn't paint exactly on top.
    const sxN = fnv01(key + ':' + r + ':' + seed + ':x');
    const syN = fnv01(key + ':' + r + ':' + seed + ':y');
    const dx = mapRange(sxN, 0, 1, -params.xShiftScale, params.xShiftScale) * l;
    const dy = mapRange(syN, 0, 1, -params.yShiftScale, params.yShiftScale) * l;

    ctx.save();
    ctx.translate(cx + dx, cy + dy);
    ctx.rotate(rot);
    ctx.drawImage(cardBuf, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  ctx.restore();
}

// ---------- animation ----------
function cycleMs(){
  const s = Math.max(0.1, +params.durationSeconds || DEFAULT_DURATION_SECONDS);
  return s * 1000;
}

function renderAnimationFrame(tLoop){
  currentT01 = tLoop;
  // animate=false freezes at t=0.5 — at cycles=2 the deal curve reaches its
  // full visible count by t=0.5, so the entire pile is rendered. Freezing at
  // t=0 would render zero cards (deal hasn't started).
  const tEff = params.animate ? tLoop : 0.5;
  const restoreMode = applyMode(tEff);
  const restoreInt  = applyInteractive();
  currentT01 = tEff;
  if(window.PIXSource?.isVideo()){
    window.PIXSource.advanceFrame();
    rebuildTexture();
  } else if(texDirty){
    rebuildTexture();
  }
  paint();
  restoreInt();
  restoreMode();
}

function animationLoop(){
  if(!params.animate) return;
  const elapsed = performance.now() - animationStartTime;
  const cm = cycleMs();
  window.WAEffect.cycleMs = cm;
  renderAnimationFrame((elapsed % cm) / cm);
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
  cycleMs: params.durationSeconds * 1000,
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

const TEX_KEYS = new Set(['canvasSize','cardSize','cardRadius']);

function handleMouseMove(e){
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  hasMouse = true;
  if(params.interactive && !params.animate) schedule();
}
function handleMouseLeave(){
  hasMouse = false;
  if(params.interactive && !params.animate) schedule();
}

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'animate'){ toggleAnimation(); return; }
    if(key === 'mode' || key === 'interactive'){
      if(!params.animate) schedule();
      return;
    }
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('tex'); else schedule();
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
      canvas: cv, name: 'pixart-stack',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  cv.addEventListener('mousemove', handleMouseMove);
  cv.addEventListener('mouseleave', handleMouseLeave);
  window.addEventListener('resize', () => { fitCanvas(); paint(); });
  fitCanvas();
  schedule('tex');
  if(params.animate){
    animationStartTime = performance.now();
    animationLoop();
  }
}

document.addEventListener('DOMContentLoaded', init);
