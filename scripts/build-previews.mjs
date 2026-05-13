#!/usr/bin/env node
/* Build per-effect homepage video previews.
 *
 * For each effect: launches headless Chromium at the effect page, asks
 * PIXSource to load the sample video, captures ~4s of frames from #cv via
 * page.screenshot, then encodes to H.264 MP4 via ffmpeg.
 *
 * slide and stack have their own internal animations — they would
 * over-animate against the video source. For those we use a still image
 * sample instead.
 */
import { chromium } from 'playwright';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'assets/previews');
const BASE = process.env.PIXART_BASE || 'http://localhost:8001';

const ALL_EFFECTS = [
  'ascii','bevel','cellular','contour','crt','displace','distort','dithering',
  'dots','edge','film-grain','flow-field','gradients','halftone-cmyk',
  'ink-wash','kaleidoscope','patterns','pixel-sort','recolor','rgb-shift',
  'scatter','slide','slit-scan','stack','stippling','voronoi','watercolor',
  'zoom-blur',
];
const onlyArg = process.argv.slice(2);
const EFFECTS = onlyArg.length ? onlyArg : ALL_EFFECTS;

// Effects that have their own time-driven animation; use a still image so
// the captured loop shows only their built-in motion, not video movement on
// top of it.
const STILL_SOURCES = new Set(['slide','stack']);
const VIDEO_SAMPLE = '../assets/samples/clip.mp4';
const STILL_SAMPLE = '../assets/samples/landscape.jpg';

const FPS = Number(process.env.PIX_FPS || 24);
const DURATION_S = Number(process.env.PIX_DUR || 4);
const FRAME_COUNT = FPS * DURATION_S;
const FRAME_INTERVAL_MS = Math.round(1000 / FPS);
const VIEWPORT = { width: 480, height: 300 };

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

async function captureSlug(browser, slug) {
  const url = `${BASE}/${slug}/`;
  const sample = STILL_SOURCES.has(slug) ? STILL_SAMPLE : VIDEO_SAMPLE;
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  const tmp = mkdtempSync(join(tmpdir(), `pix-${slug}-`));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Wait for PIXSource to exist.
    await page.waitForFunction(() => !!window.PIXSource, { timeout: 8000 });
    await page.evaluate((s) => window.PIXSource.loadUrl(s), sample);
    // Let video begin playing / effect repaint.
    await page.waitForTimeout(1500);

    // Many effects only repaint on PIXSource onChange. Video doesn't auto-pump
    // frames into the source canvas — kick off a RAF loop calling advanceFrame
    // so each new video frame triggers a notify → paint cycle.
    await page.evaluate(() => {
      if (window.__pixPumpStarted) return;
      window.__pixPumpStarted = true;
      const tick = () => {
        try { window.PIXSource?.advanceFrame(); } catch {}
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.waitForTimeout(300);

    const cv = await page.$('#cv');
    if (!cv) throw new Error('no #cv canvas');

    for (let i = 0; i < FRAME_COUNT; i++) {
      const t0 = Date.now();
      await cv.screenshot({ path: join(tmp, `f-${String(i).padStart(3, '0')}.png`) });
      const elapsed = Date.now() - t0;
      const wait = FRAME_INTERVAL_MS - elapsed;
      if (wait > 0) await page.waitForTimeout(wait);
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
    if (ff.status !== 0) {
      throw new Error(`ffmpeg failed: ${ff.stderr?.slice(-400)}`);
    }
    const size = statSync(dst).size;
    return { ok: true, size };
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
  const sizes = ok.map(r => r.size).sort((a,b)=>a-b);
  const median = sizes.length ? sizes[Math.floor(sizes.length/2)] : 0;
  const max = sizes.length ? sizes[sizes.length-1] : 0;
  console.log(`\nbuilt ${ok.length}/${EFFECTS.length}  median=${(median/1024).toFixed(0)}KB  max=${(max/1024).toFixed(0)}KB`);
}

main().catch(e => { console.error(e); process.exit(1); });
