#!/usr/bin/env node
/* Build per-effect homepage thumbnails.
 *
 * Strategy: each effect already has at least one screenshot in
 * docs/screenshots/ (some have a bare <slug>.png, others only <slug>-breath.png
 * or <slug>-bloom.png). Pick the best available, downscale to a homepage card
 * size (560×360 retina) and encode as a .webp into assets/thumbs/<slug>.webp.
 *
 * This is the static-thumbnail path documented in docs/homepage-research.md.
 * Re-run after re-shooting any effect.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOTS = resolve(ROOT, 'docs/screenshots');
const OUT = resolve(ROOT, 'assets/thumbs');

const EFFECTS = [
  'ascii','bevel','bloom','cellular','contour','crosshatch','crt','displace',
  'distort','dithering','dots','edge','film-grain','flow-field','gradients',
  'halftone-cmyk','ink-wash','kaleidoscope','mosaic','patterns','pixel-sort',
  'recolor','rgb-shift','scatter','slit-scan','stippling','voronoi','watercolor',
];

// Preference: <slug>.png > <slug>-breath.png > <slug>-bloom.png > first match.
const SUFFIX_ORDER = ['', '-breath', '-bloom', '-pulse', '-march', '-rotate', '-idle'];

function pickSource(slug) {
  for (const suf of SUFFIX_ORDER) {
    const p = resolve(SHOTS, `${slug}${suf}.png`);
    if (existsSync(p)) return p;
  }
  // Fallback: glob for any <slug>-*.png via shell.
  try {
    const out = execSync(`ls ${JSON.stringify(SHOTS)}/${slug}-*.png 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch (_) {}
  return null;
}

function build() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  let ok = 0, missing = 0;
  for (const slug of EFFECTS) {
    const src = pickSource(slug);
    if (!src) {
      console.log(`MISSING source for ${slug}`);
      missing++;
      continue;
    }
    const dst = resolve(OUT, `${slug}.webp`);
    // cwebp -resize w h: passing 0 for one dim preserves aspect ratio.
    // Target ~560 wide retina; cwebp handles the rescale at encode time.
    try {
      execSync(`cwebp -quiet -q 78 -resize 560 0 ${JSON.stringify(src)} -o ${JSON.stringify(dst)}`, { stdio: 'inherit' });
      ok++;
    } catch (e) {
      console.error(`FAIL ${slug}: ${e.message}`);
    }
  }
  console.log(`\nthumbnails: ${ok} built, ${missing} missing (of ${EFFECTS.length})`);
}

build();
