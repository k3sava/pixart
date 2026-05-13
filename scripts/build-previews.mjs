#!/usr/bin/env node
/* Build per-effect homepage video previews.
 *
 * Spec (post step-2 Animate ON rollout):
 *   - Skip splash via addInitScript.
 *   - Load portrait.jpg via PIXSource (boot default).
 *   - Toggle Animate ON via .wg-row[data-key="animate"] _write(true) — every
 *     effect now has its own natural animation mode driven by RAF.
 *   - Screenshot #cv at 24fps for 4s (96 frames) → ffmpeg mp4 ~640x400.
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
  'ascii','bevel','cellular','contour','crt','displace','distort','dithering',
  'dots','edge','film-grain','flow-field','gradients','halftone-cmyk','ink-wash',
  'kaleidoscope','patterns','pixel-sort','recolor','rgb-shift','scatter','slide',
  'slit-scan','stack','stippling','voronoi','watercolor','zoom-blur',
];
const onlyArg = process.argv.slice(2);
const EFFECTS = onlyArg.length ? onlyArg : ALL_EFFECTS;

const FPS = Number(process.env.PIX_FPS || 24);
const DURATION_S = Number(process.env.PIX_DUR || 4);
const FRAME_COUNT = Math.round(FPS * DURATION_S);
const FRAME_INTERVAL_MS = Math.round(1000 / FPS);
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

    // PIXSource boots with portrait.jpg by default. Give it time to apply.
    await page.waitForTimeout(700);

    // Toggle Animate ON via gui row API.
    const animateOk = await page.evaluate(() => {
      const row = document.querySelector('.wg-row[data-key="animate"]');
      if (!row || typeof row._write !== 'function') return false;
      row._write(true);
      return true;
    });
    if (!animateOk) throw new Error('animate row not found');

    // Give the RAF loop a moment to ramp.
    await page.waitForTimeout(250);

    const cv = await page.$('#cv');
    if (!cv) throw new Error('no #cv canvas');

    const start = Date.now();
    for (let i = 0; i < FRAME_COUNT; i++) {
      const target = i * FRAME_INTERVAL_MS;
      const lag = target - (Date.now() - start);
      if (lag > 0) await page.waitForTimeout(lag);
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
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout >120s')), 120000)),
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
