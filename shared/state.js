// pixart shared state — image / video source manager + cross-effect persistence.
//
// Effects sample from a single offscreen `sourceCanvas`. Two source types:
//   - image: an HTMLImageElement drawn once into sourceCanvas
//   - video: an HTMLVideoElement; advanceFrame() blits the current frame each tick
//
// Public surface (window.PIXSource):
//   getCanvas()        → HTMLCanvasElement (do not mutate; treat as read-only)
//   getCtx()           → 2D context on that canvas (willReadFrequently)
//   getImageData(w,h)  → ImageData sized w×h, fit "cover" by default
//   isReady()          → has a frame been drawn yet?
//   isVideo()          → boolean
//   advanceFrame()     → if video, copy current video frame into sourceCanvas; returns true if changed
//   loadFile(file)     → File from <input type=file> or drag/drop
//   loadUrl(url)       → http(s) URL or blob URL
//   cycleSample()      → load next bundled sample
//   onChange(fn)       → effect subscribes; called whenever source updates (post-load or per video frame)
//   width / height     → natural dimensions of current source
//   params             → { fit:'cover'|'contain', bg:'#000', playRate:1, loopVideo:true }
//
// Cross-effect persisted keys (localStorage prefix `pix.`):
//   sourceUrl, fit, bg, playRate, loopVideo
'use strict';

(function(){
  const PREFIX = 'pix.';
  const SHARED_KEYS = ['fit', 'bg', 'playRate', 'loopVideo', 'sourceUrl', 'ratio'];

  // Output aspect ratios. The canvas is centered inside .wa-stage with
  // letterboxing in the bg colour. Width:Height pairs.
  const RATIOS = {
    square:    [1, 1],
    portrait:  [9, 16],
    landscape: [16, 9],
  };

  // Bundled samples shipped with the site. Add more files to assets/samples/.
  // Each entry is a relative URL from any /pixart/<effect>/ page.
  const SAMPLES = [
    '../assets/samples/macro.jpg',
    '../assets/samples/landscape.jpg',
    '../assets/samples/portrait.jpg',
    '../assets/samples/cityscape.jpg',
    '../assets/samples/clip.mp4',
  ];

  function readRaw(k){ try { return localStorage.getItem(PREFIX + k); } catch(e){ return null; } }
  function read(k, fb){
    const v = readRaw(k); if(v == null) return fb;
    if(v === 'true') return true; if(v === 'false') return false;
    if(/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  }
  function write(k, v){ if(v == null) return; try { localStorage.setItem(PREFIX + k, String(v)); } catch(e){} }
  function isShared(k){ return SHARED_KEYS.includes(k); }

  const params = {
    fit:       read('fit', 'cover'),
    bg:        read('bg', '#000000'),
    ratio:     read('ratio', 'landscape'),
    playRate:  read('playRate', 1),
    loopVideo: read('loopVideo', true),
  };

  // Offscreen canvas at a fixed max dimension. Effects resample from this.
  // 1280px on the longest side is plenty for the 24fps MP4 export and keeps
  // sampling cheap on mobile.
  const MAX_DIM = 1280;
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = MAX_DIM; sourceCanvas.height = MAX_DIM;
  const sctx = sourceCanvas.getContext('2d', { willReadFrequently: true });

  let media = null;            // current HTMLImageElement | HTMLVideoElement
  let mediaType = null;        // 'image' | 'video'
  let mediaReady = false;
  let natW = MAX_DIM, natH = MAX_DIM;
  let sampleIndex = 0;
  const listeners = new Set();

  function fitRect(srcW, srcH, dstW, dstH, mode){
    const sr = srcW / srcH;
    const dr = dstW / dstH;
    let w, h;
    if(mode === 'contain' ? sr > dr : sr < dr){
      w = dstW; h = dstW / sr;
    } else {
      h = dstH; w = dstH * sr;
    }
    return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h };
  }

  function drawIntoSource(){
    if(!media || !mediaReady) return false;
    const w = sourceCanvas.width, h = sourceCanvas.height;
    sctx.save();
    sctx.fillStyle = params.bg;
    sctx.fillRect(0, 0, w, h);
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    const r = fitRect(natW, natH, w, h, params.fit);
    try { sctx.drawImage(media, r.x, r.y, r.w, r.h); } catch(e){ /* video not yet decoded */ }
    sctx.restore();
    return true;
  }

  function notify(){ for(const fn of listeners) fn(); }

  function setSource(el, type, w, h){
    media = el;
    mediaType = type;
    natW = w || el.naturalWidth || el.videoWidth || MAX_DIM;
    natH = h || el.naturalHeight || el.videoHeight || MAX_DIM;
    mediaReady = true;
    drawIntoSource();
    notify();
  }

  function loadUrl(url){
    if(!url) return Promise.reject(new Error('empty url'));
    return new Promise((resolve, reject) => {
      // Heuristic: video if extension is mp4/mov/webm or mime hints (blob: with type).
      const isVid = /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url) ||
                    (window._pixForceVideo === true);
      if(isVid){
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.playsInline = true; v.muted = true; v.loop = !!params.loopVideo; v.autoplay = true;
        v.preload = 'auto';
        v.playbackRate = params.playRate;
        v.onloadeddata = () => { setSource(v, 'video', v.videoWidth, v.videoHeight); v.play().catch(() => {}); resolve({type:'video', el:v}); };
        v.onerror = () => reject(new Error('video load failed: ' + url));
        v.src = url;
      } else {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { setSource(img, 'image', img.naturalWidth, img.naturalHeight); resolve({type:'image', el:img}); };
        img.onerror = () => reject(new Error('image load failed: ' + url));
        img.src = url;
      }
      write('sourceUrl', url);
    });
  }

  function loadFile(file){
    if(!file) return Promise.reject(new Error('no file'));
    const url = URL.createObjectURL(file);
    window._pixForceVideo = /^video\//i.test(file.type);
    return loadUrl(url).finally(() => { window._pixForceVideo = false; });
  }

  function cycleSample(){
    sampleIndex = (sampleIndex + 1) % SAMPLES.length;
    return loadUrl(SAMPLES[sampleIndex]).catch(() => {});
  }

  function advanceFrame(){
    if(mediaType !== 'video' || !media) return false;
    // Only redraw if the video has advanced. readyState >= 2 = HAVE_CURRENT_DATA.
    if(media.readyState < 2) return false;
    drawIntoSource();
    notify();
    return true;
  }

  function getImageData(w, h){
    if(!w) w = sourceCanvas.width;
    if(!h) h = sourceCanvas.height;
    if(w === sourceCanvas.width && h === sourceCanvas.height){
      return sctx.getImageData(0, 0, w, h);
    }
    // Resample into a temp canvas at requested size.
    const t = document.createElement('canvas');
    t.width = w; t.height = h;
    const tctx = t.getContext('2d', { willReadFrequently: true });
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(sourceCanvas, 0, 0, w, h);
    return tctx.getImageData(0, 0, w, h);
  }

  function onChange(fn){ listeners.add(fn); return () => listeners.delete(fn); }

  function setParam(k, v){
    if(!(k in params)) return;
    params[k] = v;
    if(k === 'fit' || k === 'bg') { drawIntoSource(); notify(); }
    if(k === 'playRate' && media && mediaType === 'video') media.playbackRate = v;
    if(k === 'loopVideo' && media && mediaType === 'video') media.loop = !!v;
    if(k === 'ratio') applyRatio();
    if(isShared(k)) write(k, v);
  }

  // Resize the on-screen canvas to fit the selected ratio within .wa-stage,
  // letterboxed with the bg colour. Triggers a custom 'pix:fit' event so
  // each effect's own fitCanvas() can repaint at the new client dimensions
  // (we use a custom event, not window.resize, to avoid recursive feedback
  // when the window resize listener calls applyRatio()).
  let _applyingRatio = false;
  function applyRatio(){
    if(_applyingRatio) return;
    _applyingRatio = true;
    try {
      const cv = document.getElementById('cv');
      const stage = document.querySelector('.wa-stage');
      if(!cv || !stage){ _applyingRatio = false; return; }
      const r = RATIOS[params.ratio] || RATIOS.landscape;
      const aspect = r[0] / r[1];
      const sw = stage.clientWidth;
      const sh = stage.clientHeight;
      let w, h;
      if(sw / sh > aspect){ h = sh; w = h * aspect; }
      else { w = sw; h = w / aspect; }
      cv.style.width  = Math.round(w) + 'px';
      cv.style.height = Math.round(h) + 'px';
      cv.style.position = 'absolute';
      cv.style.left = '50%';
      cv.style.top  = '50%';
      cv.style.transform = 'translate(-50%, -50%)';
      window.dispatchEvent(new Event('resize'));
    } finally {
      _applyingRatio = false;
    }
  }
  // Apply once on DOM ready, and re-apply on viewport resize.
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', applyRatio);
  } else {
    queueMicrotask(applyRatio);
  }
  window.addEventListener('resize', () => {
    if(_applyingRatio) return; // skip self-triggered resizes
    applyRatio();
  }, { passive: true });

  window.PIXSource = {
    getCanvas: () => sourceCanvas,
    getCtx:    () => sctx,
    getImageData,
    isReady:   () => mediaReady,
    isVideo:   () => mediaType === 'video',
    mediaType: () => mediaType,
    advanceFrame,
    loadFile,
    loadUrl,
    cycleSample,
    onChange,
    setParam,
    applyRatio,
    params,
    get width(){ return natW; },
    get height(){ return natH; },
    SHARED_KEYS,
  };

  // Bootstrap: paint a placeholder pattern so effects have a non-empty source
  // even before any image/video loads. This makes first paint of every effect
  // visible without requiring a sample asset to exist on disk.
  function paintPlaceholder(){
    const w = sourceCanvas.width, h = sourceCanvas.height;
    // Radial gradient + checker overlay. Gives effects a wide tonal range
    // (deep blacks to bright highlights) and a recognisable structure.
    const g = sctx.createRadialGradient(w*0.35, h*0.35, 0, w*0.5, h*0.5, Math.max(w,h)*0.7);
    g.addColorStop(0, '#fff'); g.addColorStop(0.5, '#888'); g.addColorStop(1, '#0a0a0a');
    sctx.fillStyle = g; sctx.fillRect(0, 0, w, h);
    const tile = 80;
    for(let y = 0; y < h; y += tile){
      for(let x = 0; x < w; x += tile){
        if(((x/tile) + (y/tile)) % 2 === 0){
          sctx.fillStyle = 'rgba(255,255,255,0.06)';
          sctx.fillRect(x, y, tile, tile);
        }
      }
    }
    sctx.fillStyle = '#fff';
    sctx.font = 'bold 96px "Helvetica Neue", Arial, sans-serif';
    sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
    sctx.fillText('pixart', w/2, h/2);
    natW = w; natH = h; mediaReady = true;
  }
  paintPlaceholder();
  notify();

  // Every fresh page load starts on macro.jpg (the tree). The prior behaviour of
  // resuming whatever `pix.sourceUrl` localStorage held meant each effect's
  // page could open with a different image, depending on which sample the
  // user last cycled to on each page — operator-visible drift. With the
  // shared blob URL also unrecoverable after reload (object URLs die with
  // the document), there's nothing useful to resume. Cycle/upload during
  // the session still works as expected.
  loadUrl(SAMPLES[0]).catch(() => {});

  // Drag and drop anywhere on the page.
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if(!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    loadFile(e.dataTransfer.files[0]).catch(err => console.warn('drop load failed', err));
  });

  // Cross-effect params hydrator (drop-in equivalent of wordart's WAState.hydrate).
  function hydrate(p){
    for(const k of SHARED_KEYS){
      if(!(k in p)) continue;
      const v = readRaw(k); if(v == null) continue;
      p[k] = read(k, p[k]);
    }
  }

  // Back-compat alias: some effects (and shared/gui.js) probe WAState.
  window.PIXState = {
    get: read, set: write, hydrate, isShared, SHARED_KEYS,
    // Sample/phrase shuffling stub for the shared gui.js shuffle button.
    randomPhrase: () => null,
  };
})();
