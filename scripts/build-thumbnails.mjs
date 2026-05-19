#!/usr/bin/env node
/* Build per-effect homepage thumbnails for pixart.
 *
 * Extracts a frame from assets/previews/<slug>.mp4 at 3s.
 * Falls back to docs/screenshots/ if no mp4 exists.
 *
 * Output: assets/thumbs/<slug>.webp at 560px wide.
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOTS = resolve(ROOT, 'docs/screenshots');
const PREVIEWS = resolve(ROOT, 'assets/previews');
const OUT = resolve(ROOT, 'assets/thumbs');
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';

const ALL_EFFECTS = [
  'ascii','bevel','bloom','caustic','cellular','chromatic-diffusion','cloth','collapse','contour',
  'crosshatch','crt','datamosh','displace','distort','dithering',
  'dots','edge','erosion','film-grain','flow-field','flow-warp','glitch-scan','gradients',
  'halftone-cmyk','ink-wash','kaleido-morph','kaleidoscope','mesh-gradient','moire','mosaic','neon-glow',
  'patterns','photomosaic','pixel-sort','prismatic','recolor','rgb-shift','scatter','sift','slit-scan',
  'split-tone','stack','stippling','superpixel','voronoi','watercolor','zoom-blur',
];

const skipExisting = process.argv.includes('--skip-existing');
const argEffects = process.argv.slice(2).filter(a => !a.startsWith('--'));
const EFFECTS = argEffects.length ? argEffects : ALL_EFFECTS;

function build() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  let ok = 0, missing = 0;
  for (const slug of EFFECTS) {
    const dst = resolve(OUT, `${slug}.webp`);
    if (skipExisting && existsSync(dst)) {
      console.log(`SKIP ${slug}.webp already exists`);
      ok++;
      continue;
    }

    const mp4 = resolve(PREVIEWS, `${slug}.mp4`);
    if (!existsSync(mp4)) {
      console.log(`MISSING ${slug} — no mp4`);
      missing++;
      continue;
    }
    const tmp = mkdtempSync(join(tmpdir(), `pix-thumb-${slug}-`));
    const png = join(tmp, 'f.png');
    try {
      const ff = spawnSync(FFMPEG, ['-y','-ss','3','-i', mp4, '-vframes','1','-vf','scale=560:-1', png], { encoding:'utf8' });
      if (ff.status !== 0) throw new Error(`ffmpeg: ${ff.stderr?.slice(-200)}`);
      execSync(`cwebp -quiet -q 78 ${JSON.stringify(png)} -o ${JSON.stringify(dst)}`, { stdio: 'inherit' });
      console.log(`OK   ${slug.padEnd(20)} (mp4 frame)`);
      ok++;
    } catch (e) {
      console.error(`FAIL ${slug} (mp4): ${e.message}`);
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
  console.log(`\nthumbnails: ${ok} built, ${missing} missing (of ${EFFECTS.length})`);
}

build();
