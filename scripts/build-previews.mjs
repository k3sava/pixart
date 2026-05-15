#!/usr/bin/env node
/* Build per-effect homepage video previews.
 *
 * Spec:
 *   - Skip splash via addInitScript.
 *   - Load portrait.jpg via PIXSource (boot default).
 *   - 20-second seamless loop: source → effect peak → source. Endpoints are
 *     pure source (effect not applied) so the video can loop without a jump.
 *   - Per frame:
 *       t = i / FRAME_COUNT in [0, 1)
 *       1. WAEffect.renderAt(t) — deterministic render at this loop position.
 *       2. Overlay the source canvas on top with alpha = 1 - sin(π·t).
 *          At t=0 / t=1 alpha=1 (source fully covers effect → see source).
 *          At t=0.5 alpha=0 (effect fully visible).
 *   - 480 frames @ 24fps = 20s. Screenshot #cv → ffmpeg mp4 ~640x400.
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'assets/previews');
const BASE = process.env.PIXART_BASE || 'http://localhost:8001';

const ALL_EFFECTS = [
  'ascii','bevel','bloom','cellular','contour','crosshatch','crt','displace',
  'distort','dithering','dots','edge','film-grain','flow-field','gradients',
  'halftone-cmyk','ink-wash','kaleidoscope','mosaic','patterns','pixel-sort',
  'recolor','rgb-shift','scatter','slit-scan','stippling','voronoi','watercolor',
];
const onlyArg = process.argv.slice(2);
const EFFECTS = onlyArg.length ? onlyArg : ALL_EFFECTS;

const FPS = Number(process.env.PIX_FPS || 24);
const DURATION_S = Number(process.env.PIX_DUR || 20);
const FRAME_COUNT = Math.round(FPS * DURATION_S);
const VIEWPORT = { width: 480, height: 300 };

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

async function captureSlug(browser, slug) {
  const url = `${BASE}/${slug}/`;

  const ctx = await browser.newContext({ viewport: VIEWPORT });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('pix.splash.seen', '1'); } catch {}
  });
  const page = await ctx.newPage();
  const tmp = mkdtempSync(join(tmpdir(), `pix-${slug}-`));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => !!window.PIXSource && !!window.WAEffect, { timeout: 10000 });

    // Hide all chrome — header, controls panel, footer, splash — so the
    // captured frames are pure canvas. Element.screenshot() crops to bounds,
    // but overlapping absolute elements still composite on top.
    await page.addStyleTag({ content: `
      .wa-top, .wg, .wa-bottom, .wa-rec, #pix-splash, #pix-nav-overlay { display: none !important; }
      body.wa-effect, .wa-stage { background: #000; }
      .wa-stage { position: fixed; inset: 0; }
      #cv { position: fixed; inset: 0; width: 100vw !important; height: 100vh !important; }
    ` });

    // PIXSource boots with the first SAMPLES entry. Give it time to apply.
    await page.waitForTimeout(700);

    // Toggle Animate ON so applyMode() actually runs inside renderAt(t).
    await page.evaluate(() => {
      const row = document.querySelector('.wg-row[data-key="animate"]');
      if (row && typeof row._write === 'function') row._write(true);
      window.WAEffect.pauseRender?.(); // stop the natural RAF — we drive frames.
    });
    await page.waitForTimeout(250);

    const cv = await page.$('#cv');
    if (!cv) throw new Error('no #cv canvas');

    // Pre-compute source draw rect once — source canvas size doesn't change.
    for (let i = 0; i < FRAME_COUNT; i++) {
      const t = i / FRAME_COUNT; // [0, 1)
      await page.evaluate((t) => {
        // 1. Effect at this loop position.
        window.WAEffect.renderAt(t);
        // 2. Crossfade: overlay source with alpha = 1 - sin(π·t).
        //    sin(π·t) is 0 at endpoints, 1 at midpoint — so overlay is
        //    full at endpoints (source visible) and zero at midpoint
        //    (effect visible). That gives the source → effect → source
        //    arc the user wants from a 20-second loop.
        const cv = document.getElementById('cv');
        // WebGL canvases (CRT) don't expose a 2D context to overlay onto.
        // Detect by getContextAttributes and skip the overlay — these
        // effects still render the source recognizably through the
        // shader pipeline.
        const isWebGL = cv.getContext('webgl2') || cv.getContext('webgl');
        const ctx = isWebGL ? null : cv.getContext('2d');
        const src = !isWebGL && window.PIXSource && window.PIXSource.getCanvas
          ? window.PIXSource.getCanvas()
          : null;
        if (ctx && src) {
          const sw = src.width, sh = src.height;
          const dw = cv.width,  dh = cv.height;
          const sa = sw / sh,   da = dw / dh;
          let drawW, drawH, dx, dy;
          if (sa > da) { drawH = dh; drawW = dh * sa; dx = (dw - drawW) / 2; dy = 0; }
          else         { drawW = dw; drawH = dw / sa; dx = 0;                dy = (dh - drawH) / 2; }
          const alpha = 1 - Math.sin(Math.PI * t);
          if (alpha > 0) {
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.drawImage(src, dx, dy, drawW, drawH);
            ctx.restore();
          }
        }
      }, t);
      await cv.screenshot({ path: join(tmp, `f-${String(i).padStart(3, '0')}.png`) });
    }

    const dst = resolve(OUT, `${slug}.mp4`);
    const ff = spawnSync('ffmpeg', [
      '-y', '-framerate', String(FPS),
      '-i', join(tmp, 'f-%03d.png'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-vf', 'scale=640:400:flags=lanczos',
      dst,
    ], { encoding: 'utf8' });
    if (ff.status !== 0) throw new Error(`ffmpeg failed: ${ff.stderr?.slice(-400)}`);
    return { ok: true, size: statSync(dst).size };
  } finally {
    await ctx.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const slug of EFFECTS) {
    const t0 = Date.now();
    try {
      const r = await Promise.race([
        captureSlug(browser, slug),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout >240s')), 240000)),
      ]);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`OK ${slug.padEnd(16)} ${(r.size/1024).toFixed(0).padStart(4)}KB  ${dt}s`);
      results.push({ slug, ...r });
    } catch (e) {
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`SKIP ${slug.padEnd(15)} ${dt}s  ${e.message}`);
      results.push({ slug, ok: false, error: e.message });
    }
  }
  await browser.close();
  const ok = results.filter(r => r.ok);
  console.log(`\nbuilt ${ok.length}/${EFFECTS.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
