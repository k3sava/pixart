#!/usr/bin/env node
/* Build per-effect homepage video previews.
 *
 * Spec: skip splash; load assets/samples/portrait.jpg via PIXSource;
 * sweep ONE signature param cosine-pingpong over the capture window for
 * static effects; for slide/stack let their natural animation run via
 * WAEffect.renderAt(N/total). Capture #cv frames → ffmpeg → mp4.
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

const SIGNATURE = {
  ascii: { key: 'columns', min: 24, max: 140 },
  bevel: { key: 'lightAngle', min: 0, max: 360 },
  cellular: { key: 'cellSize', min: 2, max: 14 },
  contour: { key: 'levels', min: 4, max: 32 },
  crt: { key: 'dotPitch', min: 1, max: 10 },
  displace: { key: 'displacement', min: -150, max: 150 },
  distort: { key: 'xShiftStrength', min: -100, max: 100 },
  dithering: { key: 'pixelSize', min: 1, max: 12 },
  dots: { key: 'maxDotSize', min: 4, max: 30 },
  edge: { key: 'lightnessThreshold', min: 30, max: 200 },
  'film-grain': { key: 'grainAmount', min: 0, max: 1 },
  'flow-field': { key: 'stepLength', min: 0.5, max: 5 },
  gradients: { key: 'stepSize', min: 4, max: 40 },
  'halftone-cmyk': { key: 'cellSize', min: 4, max: 30 },
  'ink-wash': { key: 'brushPressure', min: 0.3, max: 2 },
  kaleidoscope: { key: 'segments', min: 3, max: 16 },
  patterns: { key: 'gridDensityNumber', min: 20, max: 80 },
  'pixel-sort': { key: 'thresholdLow', min: 30, max: 180 },
  recolor: { key: 'posterizeSteps', min: 2, max: 24 },
  'rgb-shift': { key: 'rOffsetX', min: -15, max: 15 },
  scatter: { key: 'maxPointSize', min: 4, max: 24 },
  'slit-scan': { key: 'spread', min: -1, max: 1 },
  stippling: { key: 'angle', min: -45, max: 45 },
  voronoi: { key: 'seedCount', min: 60, max: 400 },
  watercolor: { key: 'wetness', min: 0, max: 1 },
  'zoom-blur': { key: 'strength', min: 0.1, max: 0.9 },
  slide: 'animator',
  stack: 'animator',
};

const ALL_EFFECTS = Object.keys(SIGNATURE);
const onlyArg = process.argv.slice(2);
const EFFECTS = onlyArg.length ? onlyArg : ALL_EFFECTS;

const SAMPLE = '../assets/samples/portrait.jpg';
const FPS = Number(process.env.PIX_FPS || 24);
const DURATION_S = Number(process.env.PIX_DUR || 3.5);
const FRAME_COUNT = Math.round(FPS * DURATION_S);
const VIEWPORT = { width: 480, height: 300 };

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

async function captureSlug(browser, slug) {
  const sig = SIGNATURE[slug];
  if (!sig) throw new Error(`no signature for ${slug}`);
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

    await page.evaluate((s) => window.PIXSource.loadUrl(s), SAMPLE);
    await page.waitForTimeout(700);

    // Force one repaint to ensure source pipeline applied.
    await page.evaluate(() => { try { window.WAEffect.renderAt?.(0); } catch {} });
    await page.waitForTimeout(150);

    const cv = await page.$('#cv');
    if (!cv) throw new Error('no #cv canvas');

    const isAnimator = sig === 'animator';

    for (let i = 0; i < FRAME_COUNT; i++) {
      const t = i / Math.max(1, FRAME_COUNT - 1);
      if (isAnimator) {
        await page.evaluate((tt) => {
          try { window.WAEffect.renderAt(tt); } catch {}
        }, t);
      } else {
        // Cosine pingpong 0→1→0
        const m = (1 - Math.cos(2 * Math.PI * t)) / 2;
        const value = sig.min + (sig.max - sig.min) * m;
        await page.evaluate(({ k, v }) => {
          const row = document.querySelector(`.wg-row[data-key="${k}"]`);
          if (row && row._write) row._write(v);
          else {
            // Fallback: directly poke the effect param if exposed.
            try { if (window.WAEffect?.params) window.WAEffect.params[k] = v; } catch {}
          }
          try { window.WAEffect.renderAt?.(0); } catch {}
        }, { k: sig.key, v: value });
      }
      await page.waitForTimeout(60);
      await cv.screenshot({ path: join(tmp, `f-${String(i).padStart(3, '0')}.png`) });
    }

    const dst = resolve(OUT, `${slug}.mp4`);
    const ff = spawnSync('ffmpeg', [
      '-y', '-framerate', String(FPS),
      '-i', join(tmp, 'f-%03d.png'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '30',
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
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout >90s')), 90000)),
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
