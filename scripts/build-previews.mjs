#!/usr/bin/env node
/* Build per-effect homepage video previews for pixart.
 *
 * Approach:
 *   - Canvas forced to fill the full 560×360 viewport (disabling applyRatio).
 *   - No crossfade overlay — the square sourceCanvas would create a "square
 *     within the canvas" artefact. Instead render the effect directly.
 *   - Animate mode ON; drive frames deterministically via WAEffect.renderAt(t).
 *   - t loops 0→1 over DURATION_S seconds — natural fade-in / peak / fade-out.
 *   - 560×360 output matches the 280/180 preview card aspect ratio exactly.
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
  'ascii','bevel','bloom','caustic','cellular','chromatic-diffusion','cloth','contour',
  'crosshatch','crt','datamosh','displace','distort','dithering',
  'dots','edge','film-grain','flow-field','flow-warp','glitch-scan','gradients',
  'halftone-cmyk','ink-wash','kaleidoscope','mesh-gradient','moire','mosaic','neon-glow',
  'patterns','photomosaic','pixel-sort','prismatic','recolor','rgb-shift','scatter','slit-scan',
  'split-tone','stippling','superpixel','voronoi','watercolor',
];
const onlyArg = process.argv.slice(2).filter(a => !a.startsWith('--'));
const skipExisting = process.argv.includes('--skip-existing');
const EFFECTS = onlyArg.length ? onlyArg : ALL_EFFECTS;

const FPS          = Number(process.env.PIX_FPS  || 24);
const DURATION_S   = Number(process.env.PIX_DUR  || 20);
const FRAME_COUNT  = Math.round(FPS * DURATION_S);
// Exact 280/180 card aspect ratio × 2.
const VIEWPORT     = { width: 560, height: 360 };
const FFMPEG       = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

async function captureSlug(browser, slug) {
  const url = `${BASE}/${slug}/`;

  const ctx = await browser.newContext({ viewport: VIEWPORT });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('pix.splash.seen', '1'); } catch {}
    // Force landscape ratio so the effect initialises expecting landscape dims.
    try { localStorage.setItem('pix.ratio', 'landscape'); } catch {}
  });
  const page = await ctx.newPage();
  const tmp = mkdtempSync(join(tmpdir(), `pix-${slug}-`));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => !!window.PIXSource && !!window.WAEffect, { timeout: 10000 });

    // Hide all chrome — header, controls, footer, overlays.
    await page.addStyleTag({ content: `
      .wa-top, .wg, .wa-bottom, .wa-rec,
      #pix-splash, #pix-nav-overlay { display: none !important; }
      html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; background: #000 !important; }
    ` });

    // Wait for PIXSource to load the default sample image.
    await page.waitForTimeout(800);

    // Force the stage + canvas to fill the full viewport.
    // The body class trick: adding panel-collapsed ensures the more-specific
    // `body:not(.panel-collapsed) .wa-stage { right:320px }` rule does not apply.
    // Then we also force canvas via inline styles (highest CSS priority).
    await page.evaluate(([vw, vh]) => {
      // Neutralise the panel-open right-offset on .wa-stage.
      document.body.classList.add('panel-collapsed');

      const stage = document.querySelector('.wa-stage');
      if (stage) {
        stage.style.setProperty('position', 'fixed',   'important');
        stage.style.setProperty('inset',    '0',       'important');
        stage.style.setProperty('right',    '0px',     'important');
        stage.style.setProperty('background', '#000',  'important');
      }

      // Kill applyRatio so it can't shrink the canvas after we resize.
      if (window.PIXSource) window.PIXSource.applyRatio = () => {};

      const cv = document.getElementById('cv');
      if (!cv) return;
      cv.style.setProperty('position',   'fixed', 'important');
      cv.style.setProperty('left',       '0px',   'important');
      cv.style.setProperty('top',        '0px',   'important');
      cv.style.setProperty('width',      vw + 'px', 'important');
      cv.style.setProperty('height',     vh + 'px', 'important');
      cv.style.setProperty('transform',  'none',  'important');
      cv.style.setProperty('max-width',  'none',  'important');
      cv.style.setProperty('max-height', 'none',  'important');

      // Fire both resize signals so each effect's fitCanvas() picks up the
      // new dimensions and repaints at full resolution.
      window.dispatchEvent(new CustomEvent('pix:fit'));
      window.dispatchEvent(new Event('resize'));
    }, [VIEWPORT.width, VIEWPORT.height]);

    await page.waitForTimeout(400);

    // Toggle Animate ON (so renderAt drives applyMode / animation logic)
    // then immediately pause the natural RAF — we'll drive frames ourselves.
    await page.evaluate(() => {
      const row = document.querySelector('.wg-row[data-key="animate"]');
      if (row && typeof row._write === 'function') row._write(true);
      window.WAEffect.pauseRender?.();
    });
    await page.waitForTimeout(200);

    const cvEl = await page.$('#cv');
    if (!cvEl) throw new Error('no #cv canvas');

    for (let i = 0; i < FRAME_COUNT; i++) {
      const t = i / FRAME_COUNT;
      await page.evaluate((t) => { window.WAEffect.renderAt(t); }, t);
      await cvEl.screenshot({ path: join(tmp, `f-${String(i).padStart(3, '0')}.png`) });
    }

    const dst = resolve(OUT, `${slug}.mp4`);
    const ff = spawnSync(FFMPEG, [
      '-y', '-framerate', String(FPS),
      '-i', join(tmp, 'f-%03d.png'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '26',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-vf', `scale=${VIEWPORT.width}:${VIEWPORT.height}:flags=lanczos`,
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
    const dst = resolve(OUT, `${slug}.mp4`);
    if (skipExisting && existsSync(dst)) {
      console.log(`SKIP ${slug.padEnd(16)} already exists`);
      continue;
    }
    const t0 = Date.now();
    try {
      const r = await Promise.race([
        captureSlug(browser, slug),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout >300s')), 300000)),
      ]);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`OK ${slug.padEnd(16)} ${(r.size/1024).toFixed(0).padStart(5)}KB  ${dt}s`);
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
