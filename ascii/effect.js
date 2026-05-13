// pixart/ascii — converts the current source (image or video frame) into a
// monospace ASCII grid rendered on canvas. Static effect (Pass 2): no
// animation, no interactive cursor, no fg/fgMatch/bold/tracking/jitter/
// invertRamp. The reference panel does not expose these.
'use strict';

const DEFAULT_RAMP = ' .:-=+*#%@';
const FG = '#A8FF60'; // fixed phosphor-green output

function clamp(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');

const params = {
  // Grid + ramp
  columns: 96,
  rows: 0,
  ramp: DEFAULT_RAMP,
  // Preprocessing
  blur: 0,
  grain: 0,
  gamma: 1,
  blackPoint: 0,
  whitePoint: 255,
  // Format
  comments: false,
  borders: false,
  showEffect: true,
  // Shared
  fit: 'cover',
  bg: '#0a0a0a',
};
if(window.PIXState) window.PIXState.hydrate(params);

let gui;

const sampleCv = document.createElement('canvas');
const sampleCtx = sampleCv.getContext('2d', { willReadFrequently: true });

function fitCanvas(){
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if(cv.width !== w) cv.width = w;
  if(cv.height !== h) cv.height = h;
}

function gridDims(){
  const cols = Math.max(8, Math.round(params.columns));
  const aspect = cv.width / Math.max(1, cv.height);
  const autoRows = Math.max(8, Math.round(cols / aspect / 1.82));
  const rows = params.rows > 0 ? Math.max(8, Math.round(params.rows)) : autoRows;
  return { cols, rows };
}

function boxBlur(imgData, radius){
  if(radius <= 0) return;
  const { data, width: w, height: h } = imgData;
  const tmp = new Uint8ClampedArray(data.length);
  const r = Math.min(radius, 10);
  for(let y = 0; y < h; y++){
    for(let x = 0; x < w; x++){
      let sr=0, sg=0, sb=0, n=0;
      for(let k = -r; k <= r; k++){
        const xx = clamp(x + k, 0, w - 1);
        const i = (y * w + xx) * 4;
        sr += data[i]; sg += data[i+1]; sb += data[i+2]; n++;
      }
      const o = (y * w + x) * 4;
      tmp[o] = sr/n; tmp[o+1] = sg/n; tmp[o+2] = sb/n; tmp[o+3] = data[o+3];
    }
  }
  for(let y = 0; y < h; y++){
    for(let x = 0; x < w; x++){
      let sr=0, sg=0, sb=0, n=0;
      for(let k = -r; k <= r; k++){
        const yy = clamp(y + k, 0, h - 1);
        const i = (yy * w + x) * 4;
        sr += tmp[i]; sg += tmp[i+1]; sb += tmp[i+2]; n++;
      }
      const o = (y * w + x) * 4;
      data[o] = sr/n; data[o+1] = sg/n; data[o+2] = sb/n;
    }
  }
}

function preprocess(imgData){
  const { data } = imgData;
  const bp = params.blackPoint, wp = params.whitePoint;
  const span = Math.max(1, wp - bp);
  const gamma = clamp(params.gamma, 0.05, 5);
  const invG = 1 / gamma;
  const grain = clamp(params.grain, 0, 1);
  for(let i = 0; i < data.length; i += 4){
    for(let c = 0; c < 3; c++){
      let v = data[i + c];
      v = ((v - bp) / span) * 255;
      v = clamp(v, 0, 255);
      v = Math.pow(v / 255, invG) * 255;
      if(grain > 0){
        v += (Math.random() - 0.5) * 255 * grain;
      }
      data[i + c] = clamp(v, 0, 255);
    }
  }
}

function rampChar(lum, ramp){
  const r = ramp.length > 0 ? ramp : DEFAULT_RAMP;
  let idx = Math.floor(clamp(lum, 0, 255) / 256 * r.length);
  if(idx >= r.length) idx = r.length - 1;
  return r.charAt(idx);
}

function paint(){
  if(!window.PIXSource) return;
  const w = cv.width, h = cv.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = params.bg;
  ctx.fillRect(0, 0, w, h);

  const src = window.PIXSource.getCanvas();
  const { cols, rows } = gridDims();

  if(sampleCv.width !== cols || sampleCv.height !== rows){
    sampleCv.width = cols; sampleCv.height = rows;
  }
  sampleCtx.imageSmoothingEnabled = true;
  sampleCtx.imageSmoothingQuality = 'high';
  sampleCtx.fillStyle = params.bg;
  sampleCtx.fillRect(0, 0, cols, rows);
  const sw = src.width, sh = src.height;
  const fit = params.fit;
  const sr = sw / sh, dr = cols / rows;
  let dw, dh;
  if(fit === 'contain' ? sr > dr : sr < dr){
    dw = cols; dh = cols / sr;
  } else {
    dh = rows; dw = rows * sr;
  }
  const dx = (cols - dw) / 2, dy = (rows - dh) / 2;
  try { sampleCtx.drawImage(src, dx, dy, dw, dh); } catch(e){ /* video not ready */ }

  const img = sampleCtx.getImageData(0, 0, cols, rows);
  if(params.blur > 0) boxBlur(img, Math.round(params.blur));
  preprocess(img);
  const data = img.data;

  const padX = (params.borders || params.comments) ? 24 : 0;
  const padY = (params.borders || params.comments) ? 32 : 0;
  const areaW = w - padX * 2;
  const areaH = h - padY * 2;
  const cellW = areaW / cols;
  const cellH = areaH / rows;
  const fontSize = Math.max(4, Math.min(cellH * 1.05, cellW / 0.6 * 1.05));
  ctx.font = `500 ${fontSize}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = FG;
  ctx.imageSmoothingEnabled = false;

  const ramp = params.ramp && params.ramp.length ? params.ramp : DEFAULT_RAMP;

  for(let y = 0; y < rows; y++){
    for(let x = 0; x < cols; x++){
      const i = (y * cols + x) * 4;
      const r8 = data[i], g8 = data[i+1], b8 = data[i+2];
      const lum = 0.2126 * r8 + 0.7152 * g8 + 0.0722 * b8;
      const ch = rampChar(lum, ramp);
      if(ch === ' ') continue;
      const px = padX + (x + 0.5) * cellW;
      const py = padY + (y + 0.5) * cellH;
      ctx.fillText(ch, px, py);
    }
  }

  if(params.borders){
    const tlx = padX - cellW * 0.5, tly = padY - cellH * 0.5;
    const brx = padX + areaW + cellW * 0.5, bry = padY + areaH + cellH * 0.5;
    ctx.strokeStyle = FG;
    ctx.lineWidth = Math.max(1, fontSize * 0.06);
    ctx.strokeRect(tlx, tly, brx - tlx, bry - tly);
  }
  if(params.comments){
    const fs = Math.max(10, fontSize * 0.9);
    ctx.font = `500 ${fs}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = FG;
    ctx.fillText('/*', 6, 4);
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('*/', w - 6, h - 4);
  }

  ctx.restore();
}

window.WAEffect = {
  cycleMs: 0,
  renderAt(_t){ paint(); },
  pauseRender(){},
  resumeRender(){ paint(); },
};

function init(){
  gui = new WAGui(document.getElementById('panel'), params);
  gui.on((key) => {
    if(key === 'fit' || key === 'bg') window.PIXSource?.setParam(key, params[key]);
    if(window.PIXState && window.PIXState.isShared(key)) window.PIXState.set(key, params[key]);
    paint();
  });
  if(window.PIXSource){
    window.PIXSource.onChange(() => paint());
  }
  if(window.WAExport){
    window.WAExport.wire({
      canvas: cv, name: 'pixart-ascii',
      pngBtn: document.getElementById('export-png'),
      mp4Btn: document.getElementById('export-mp4'),
      rec: document.querySelector('.wa-rec'),
    });
  }
  window.addEventListener('resize', () => { fitCanvas(); paint(); });
  fitCanvas();
  paint();
}

document.addEventListener('DOMContentLoaded', init);
