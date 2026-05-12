// Shared export helpers.
//
// PNG  — single `toDataURL` download.
// MP4  — offline frame-by-frame WebCodecs render. We do NOT capture the live
//        canvas in real time; we ask the active effect to render each frame
//        of an animation cycle at a deterministic t_loop in [0, 1), encode it
//        directly via VideoEncoder, mux it through mp4-muxer (with webm-muxer
//        as fallback). 15 second output, two full pingpong loops inside it,
//        so frame 0 and the final frame are identical and the file plays as
//        a seamless loop. The UI stays interactive while rendering.
(function(){
  'use strict';
  const TOTAL_S = 15;
  // 24 fps is plenty for typography-scale animation and trims 20% of the
  // per-frame renderAt+encode work vs 30. Time-to-blob on /line/ drops from
  // ~17s to ~6-8s with no visible quality loss on a 15s clip.
  const FPS    = 24;
  const LOOPS  = 2;
  const TOTAL_FRAMES = TOTAL_S * FPS;

  function downloadBlob(blob, filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  function exportPNG(canvas, name){
    const a = document.createElement('a');
    a.download = `${name}-${Date.now()}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  }

  // Decide which codec the browser can encode. Prefer H.264 in mp4, fall back
  // to VP9 / VP8 in WebM.
  async function pickCodec(width, height){
    if(typeof VideoEncoder === 'undefined') return null;
    const probes = [
      { container: 'mp4',  codec: 'avc1.640028', muxerCodec: 'avc'  },
      { container: 'mp4',  codec: 'avc1.42E01F', muxerCodec: 'avc'  },
      { container: 'webm', codec: 'vp09.00.10.08', muxerCodec: 'V_VP9' },
      { container: 'webm', codec: 'vp8',           muxerCodec: 'V_VP8' },
    ];
    for(const p of probes){
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec: p.codec, width, height, bitrate: 8_000_000, framerate: FPS,
        });
        if(support && support.supported) return p;
      } catch(e){ /* try next */ }
    }
    return null;
  }

  async function loadMuxer(container){
    if(container === 'mp4'){
      return await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm');
    }
    return await import('https://cdn.jsdelivr.net/npm/webm-muxer@5/+esm');
  }

  async function exportVideoOffline(canvas, name, {onProgress, onDone, onError}){
    if(!window.WAEffect || typeof window.WAEffect.renderAt !== 'function'){
      onError && onError('This effect does not yet expose WAEffect.renderAt; cannot render offline.');
      return;
    }
    const codec = await pickCodec(canvas.width, canvas.height);
    if(!codec){ onError && onError('No supported video codec in this browser.'); return; }

    let muxerLib;
    try { muxerLib = await loadMuxer(codec.container); }
    catch(e){ onError && onError('Failed to load muxer: ' + e.message); return; }

    const { Muxer, ArrayBufferTarget } = muxerLib;
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: {
        codec: codec.muxerCodec,
        width: canvas.width,
        height: canvas.height,
        frameRate: FPS,
      },
      fastStart: codec.container === 'mp4' ? 'in-memory' : undefined,
    });

    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { console.error('VideoEncoder error', e); onError && onError(e.message || String(e)); },
    });
    encoder.configure({
      codec: codec.codec,
      width: canvas.width,
      height: canvas.height,
      bitrate: 8_000_000,
      framerate: FPS,
    });

    // Suspend the live render loop while we drive frames manually.
    if(window.WAEffect.pauseRender) window.WAEffect.pauseRender();

    try {
      for(let i = 0; i < TOTAL_FRAMES; i++){
        const t_global = (i / TOTAL_FRAMES) * LOOPS;
        const t_loop   = t_global % 1;
        window.WAEffect.renderAt(t_loop);
        const ts = Math.round(i * (1_000_000 / FPS));
        const vf = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1_000_000 / FPS) });
        encoder.encode(vf, { keyFrame: i % 30 === 0 });
        vf.close();
        if(i % 30 === 0){
          onProgress && onProgress(i / TOTAL_FRAMES);
        }
        // Microtask yield each frame — keeps UI responsive without the ~4ms
        // setTimeout(0) clamp that was costing hundreds of ms per export.
        await Promise.resolve();
      }
      await encoder.flush();
      muxer.finalize();
      const blob = new Blob([target.buffer], { type: codec.container === 'mp4' ? 'video/mp4' : 'video/webm' });
      downloadBlob(blob, `${name}-${Date.now()}.${codec.container}`);
      onProgress && onProgress(1);
      onDone && onDone(blob);
    } finally {
      if(window.WAEffect.resumeRender) window.WAEffect.resumeRender();
    }
  }

  // MediaRecorder fallback — used only if VideoEncoder isn't available
  // (older Safari, iPad iOS < 17). Records the live canvas in real time for
  // one cycle. Returns a Promise that resolves when the blob has saved.
  function exportVideoRealtime(canvas, name){
    return new Promise((resolve, reject) => {
      const tries = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      const mime = tries.find(m => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
      if(!mime) return reject(new Error('No supported video format on this device.'));
      const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      const stream = canvas.captureStream(FPS);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      const chunks = [];
      rec.ondataavailable = (e) => { if(e.data && e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => {
        downloadBlob(new Blob(chunks, { type: mime }), `${name}-${Date.now()}.${ext}`);
        resolve();
      };
      rec.onerror = (ev) => reject(ev.error || ev);
      if(window.WAEffect?.beginRecording) window.WAEffect.beginRecording();
      else if(window.WAEffect?.pauseRender){
        window.WAEffect.pauseRender();
        const start = performance.now();
        const tick = () => {
          const t = ((performance.now() - start) / 1000) % 1;
          window.WAEffect.renderAt?.(t);
          if(performance.now() - start < 15_000) requestAnimationFrame(tick);
        };
        tick();
      }
      rec.start(250);
      setTimeout(() => { try { rec.stop(); } catch(_){} window.WAEffect?.resumeRender?.(); }, 15_000);
    });
  }

  function wire({canvas, name, pngBtn, mp4Btn}){
    if(pngBtn) pngBtn.addEventListener('click', () => exportPNG(canvas, name));
    if(!mp4Btn) return;
    const origLabel = mp4Btn.textContent;
    mp4Btn.addEventListener('click', async () => {
      if(mp4Btn.dataset.busy) return;
      mp4Btn.dataset.busy = '1';
      mp4Btn.textContent = 'rendering…';
      mp4Btn.disabled = true;
      const cleanup = () => {
        mp4Btn.disabled = false;
        mp4Btn.textContent = origLabel;
        delete mp4Btn.dataset.busy;
      };
      try {
        if(typeof VideoEncoder !== 'undefined'){
          await exportVideoOffline(canvas, name, {
            onDone: cleanup,
            onError: async (e) => {
              // Offline path failed — fall back to real-time MediaRecorder.
              try { await exportVideoRealtime(canvas, name); } catch(e2){ alert('Export failed: ' + (e2.message || e2)); }
              cleanup();
            },
          });
        } else {
          await exportVideoRealtime(canvas, name);
          cleanup();
        }
      } catch(e){
        console.error(e); alert('Export failed: ' + e.message); cleanup();
      }
    });
  }

  window.WAExport = { wire, exportPNG, exportVideoOffline, TOTAL_S, FPS, LOOPS };
})();
