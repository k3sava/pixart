// pixart/kaleidoscope — N-fold rotational + mirror symmetry on a UV warp.
//
// For each output pixel (x, y):
//   1. Compute polar (r, θ) about the canvas centre.
//   2. Fold θ into the wedge [0, 2π/N] via modulo.
//   3. If `mirror`, reflect alternate slices so the seam is continuous
//      (Brewster two-mirror primitive: the slice index parity flips the wedge).
//   4. Add `angleOffset` to rotate the whole pattern.
//   5. Sample source at sample-origin + (r·cos θ', r·sin θ'); wrap toroidally.
//
// References: Brewster (1816), Quilez polar-symmetry article, Shadertoy
// MdSfDz. No tessellation, no Möbius — pure Euclidean fold.
'use strict';

const CYCLE_MS = 0;

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
  segments:    8,
  angleOffset: 0,
  mirror:      true,
  sampleX:     0,
  sampleY:     0,
  zoom:        1.2,
  // Show the effect, or fall through to raw source.
  showEffect:  true,
  // Shared chrome.
  fit:         'cover',
  bg:          '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;
let preprocessed = null;
let dirty = { pre: true, paint: true };
let rafQueued = false;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

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

// ── preprocessor ─────────────────────────────────────────────
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

// ── warp: the kaleidoscope itself ────────────────────────────
function warp(){
  if(!preprocessed) return null;
  const W = preprocessed.width, H = preprocessed.height;
  const src = preprocessed.data;
  const out = octx.createImageData(W, H);
  const o = out.data;

  const N = Math.max(2, Math.round(params.segments));
  const wedge = (Math.PI * 2) / N;
  const angOff = params.angleOffset;
  const zoom = params.zoom;
  const sxN = params.sampleX;
  const syN = params.sampleY;
  const mirror = params.mirror;

  const cx = W * 0.5, cy = H * 0.5;
  const ox = cx + sxN * cx;
  const oy = cy + syN * cy;
  const invZ = 1 / Math.max(0.01, zoom);
  const TAU = Math.PI * 2;

  for(let y = 0; y < H; y++){
    const dy0 = (y - cy);
    for(let x = 0; x < W; x++){
      const dx0 = (x - cx);
      const r = Math.hypot(dx0, dy0) * invZ;
      let th = Math.atan2(dy0, dx0);

      // Fold θ into [0, wedge). Mirror alternate slices for continuous seams.
      let a = ((th % TAU) + TAU) % TAU;
      const slice = Math.floor(a / wedge);
      a -= slice * wedge;
      if(mirror && (slice & 1)) a = wedge - a;
      th = a + angOff;

      const sx = ox + r * Math.cos(th);
      const sy = oy + r * Math.sin(th);

      const ix = ((sx | 0) % W + W) % W;
      const iy = ((sy | 0) % H + H) % H;
      const si = (ix + iy * W) * 4;
      const oi = (x + y * W) * 4;

      o[oi]   = src[si];
      o[oi+1] = src[si+1];
      o[oi+2] = src[si+2];
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

  const surface = params.showEffect ? (warp() || srcBuf) : srcBuf;
  const aspect = surface.width / surface.height;
  let dw, dh;
  if(W / H > aspect){ dh = H; dw = H * aspect; }
  else              { dw = W; dh = W / aspect; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(surface, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ── WAEffect contract (no animation) ─────────────────────────
window.WAEffect = {
  cycleMs: 0,
  renderAt: () => paint(),
  pauseRender: () => {},
  resumeRender: () => paint(),
};

const PRE_KEYS = new Set(['canvasSize','blurAmount','grainAmount','gamma','blackPoint','whitePoint','fit','bg']);

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg'){
      window.PIXSource?.setParam(key, params[key]);
      if(key === 'fit') schedule('pre'); else schedule('paint');
      return;
    }
    if(PRE_KEYS.has(key)) schedule('pre');
    else                  schedule('paint');
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => schedule('pre'));
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-kaleidoscope',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); schedule('paint'); });
  fitCanvas();
  schedule('pre');
}

document.addEventListener('DOMContentLoaded', init);
