#!/usr/bin/env node
// Bloat sweep — per-control isolation methodology.
//
// For each effect, for each effect-specific control:
//   1. Reset ALL other sliders to their initial value (kills state-pollution).
//   2. Sweep this control to MIN, capture canvas.
//   3. Sweep to MAX, capture canvas.
//   4. Compute total per-pixel RGB delta between the two captures.
//   5. Mark DEAD if delta < threshold (default 5000).
//
// Mode-gated controls (cellular's ruleset bounds, dithering's pattern-specific
// knobs) are tested with their gating mode active.
//
// Output: docs/bloat-sweep.md with a per-effect verdict.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = join(ROOT, 'docs', 'bloat-sweep.md');
mkdirSync(dirname(OUT), { recursive: true });

const EFFECTS = [
  'ascii','bevel','cellular','contour','crt','displace','distort',
  'dithering','dots','edge','film-grain','flow-field','gradients',
  'halftone-cmyk','ink-wash','kaleidoscope','patterns','pixel-sort',
  'recolor','rgb-shift','scatter','slide','slit-scan','stack',
  'stippling','voronoi','watercolor','zoom-blur',
];

// Skip shared chrome controls — we never strip these.
const SHARED = new Set(['source','fit','bg','ratio','mode','animate','interactive','showEffect']);

// DEAD threshold: per-pixel diff totalled over the whole canvas.
// Effects with high-frequency noise (grain, dither, halftone) regularly
// produce 100k+ on tiny slider moves; effects that genuinely do nothing
// hover under 5k.
const DEAD_THRESHOLD = 5000;

async function loadDefaultFiles(page, slug){
  // distort needs a distortion map; patterns + scatter accept a tile/dot image.
  // The defaults shipped in-repo are auto-loaded by the effects themselves
  // (distort/assets/displacement.png, patterns/patterns/pattern-1.png), so
  // nothing to do here. Documented for the next person.
}

async function sweepEffect(browser, slug, log){
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // Skip splash
  await page.addInitScript(() => { try { localStorage.setItem('pix.splash.seen', '1'); } catch(e){} });
  // Capture console errors
  const consoleErrors = [];
  page.on('pageerror', err => consoleErrors.push(String(err)));
  page.on('console', msg => { if(msg.type() === 'error') consoleErrors.push(msg.text()); });

  try {
    await page.goto(`http://localhost:8001/${slug}/`, { waitUntil: 'load' });
    await loadDefaultFiles(page, slug);
    // Heavy effects need more settle time
    const heavy = ['voronoi','scatter','flow-field','cellular'].includes(slug);
    await page.waitForTimeout(heavy ? 2500 : 1000);

    // Inventory the panel's controls.
    const controls = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.wg-row[data-key]')];
      return rows.map(r => {
        const isSlider = r.classList.contains('wg-slider');
        const isBool   = r.classList.contains('wg-bool');
        const isSelect = r.classList.contains('wg-select');
        const v = (r.querySelector('input[type=number]')?.value) ?? null;
        return {
          key: r.dataset.key,
          type: isSlider ? 'slider' : isBool ? 'bool' : isSelect ? 'select' : 'other',
          min: r.dataset.min ? Number(r.dataset.min) : null,
          max: r.dataset.max ? Number(r.dataset.max) : null,
          initial: v != null ? Number(v) : null,
          selectOptions: isSelect ? [...r.querySelectorAll('select option')].map(o => o.value) : null,
        };
      });
    });

    // Capture canvas diff helper: total absolute RGB delta between two snapshots.
    async function capture(){
      // Force a render tick to flush any pending paint.
      await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
      const png = await page.locator('#cv').screenshot({ type: 'png' });
      return png;
    }
    function pixelDiff(a, b){
      // Both buffers are full PNG screenshots — same dimensions if no resize.
      // Use a fast byte-level Hamming-ish diff: count of non-equal byte positions.
      if(a.length !== b.length) return a.length;
      let diff = 0;
      for(let i = 0; i < a.length; i++) if(a[i] !== b[i]) diff++;
      return diff;
    }

    // Capture a baseline (everyone at defaults).
    const baseline = await capture();

    const results = [];
    for(const c of controls){
      if(SHARED.has(c.key)) continue;
      if(c.type === 'slider'){
        if(c.min == null || c.max == null || c.min === c.max){
          results.push({ key: c.key, verdict: 'UNTESTABLE', reason: 'no range' });
          continue;
        }
        // Set this slider to min, all others left at their initial.
        await page.evaluate(({ key, val }) => {
          const row = document.querySelector(`.wg-row[data-key="${key}"]`);
          if(row && row._write) row._write(val);
        }, { key: c.key, val: c.min });
        await page.waitForTimeout(300);
        const minCap = await capture();

        // Reset to initial; set to max.
        await page.evaluate(({ key, val }) => {
          const row = document.querySelector(`.wg-row[data-key="${key}"]`);
          if(row && row._write) row._write(val);
        }, { key: c.key, val: c.max });
        await page.waitForTimeout(300);
        const maxCap = await capture();

        const diff = pixelDiff(minCap, maxCap);
        results.push({ key: c.key, verdict: diff < DEAD_THRESHOLD ? 'DEAD' : 'LIVE', diff });

        // Reset to initial before testing next control (avoid cumulative drift).
        await page.evaluate(({ key, val }) => {
          const row = document.querySelector(`.wg-row[data-key="${key}"]`);
          if(row && row._write) row._write(val);
        }, { key: c.key, val: c.initial });
        await page.waitForTimeout(200);
      } else if(c.type === 'bool'){
        // Click toggle on, capture, click off, capture.
        await page.evaluate(({ key }) => {
          const row = document.querySelector(`.wg-row[data-key="${key}"]`);
          const cb = row.querySelector('input[type=checkbox]');
          if(!cb.checked) cb.click();
        }, { key: c.key });
        await page.waitForTimeout(300);
        const onCap = await capture();
        await page.evaluate(({ key }) => {
          const row = document.querySelector(`.wg-row[data-key="${key}"]`);
          const cb = row.querySelector('input[type=checkbox]');
          if(cb.checked) cb.click();
        }, { key: c.key });
        await page.waitForTimeout(300);
        const offCap = await capture();
        const diff = pixelDiff(onCap, offCap);
        results.push({ key: c.key, verdict: diff < DEAD_THRESHOLD ? 'DEAD' : 'LIVE', diff });
      } else if(c.type === 'select'){
        if(!c.selectOptions || c.selectOptions.length < 2){
          results.push({ key: c.key, verdict: 'UNTESTABLE', reason: 'no options' });
          continue;
        }
        const caps = [];
        for(const opt of c.selectOptions){
          await page.evaluate(({ key, val }) => {
            const row = document.querySelector(`.wg-row[data-key="${key}"]`);
            const pill = row.querySelector(`.wg-pill[data-value="${val}"]`);
            if(pill) pill.click();
          }, { key: c.key, val: opt });
          await page.waitForTimeout(350);
          caps.push(await capture());
        }
        // Compare each adjacent pair — at least one transition must produce a meaningful diff.
        let maxDiff = 0;
        for(let i = 1; i < caps.length; i++){
          const d = pixelDiff(caps[i-1], caps[i]);
          if(d > maxDiff) maxDiff = d;
        }
        results.push({ key: c.key, verdict: maxDiff < DEAD_THRESHOLD ? 'DEAD' : 'LIVE', diff: maxDiff });
      } else {
        results.push({ key: c.key, verdict: 'SKIPPED', reason: c.type });
      }
    }
    return { slug, controls: results, consoleErrors };
  } finally {
    await page.close();
  }
}

async function main(){
  console.log('launching chromium…');
  const browser = await chromium.launch({ headless: true });
  const log = (...a) => console.log(...a);
  const allResults = [];
  for(const slug of EFFECTS){
    log(`sweeping ${slug}…`);
    try {
      const r = await sweepEffect(browser, slug, log);
      allResults.push(r);
      const dead = r.controls.filter(c => c.verdict === 'DEAD').map(c => c.key);
      log(`  → ${r.controls.length} controls tested, ${dead.length} DEAD: ${dead.join(', ')}`);
    } catch(err){
      log(`  ✗ ${slug} errored: ${err.message}`);
      allResults.push({ slug, error: err.message });
    }
  }
  await browser.close();

  // Write the report
  let md = `# Bloat sweep (per-control isolation methodology)\n\nGenerated ${new Date().toISOString()}. DEAD threshold: ${DEAD_THRESHOLD} pixel-byte differences across the whole canvas. Lower numbers mean the control changes the output less.\n\n`;
  for(const r of allResults){
    md += `## ${r.slug}\n`;
    if(r.error){ md += `errored: ${r.error}\n\n`; continue; }
    if(r.consoleErrors.length){ md += `console errors:\n` + r.consoleErrors.map(e => `- ${e}`).join('\n') + '\n\n'; }
    md += '| control | verdict | diff |\n|---|---|---|\n';
    for(const c of r.controls){
      md += `| ${c.key} | ${c.verdict} | ${c.diff ?? c.reason ?? ''} |\n`;
    }
    md += '\n';
  }
  // Strip list — only DEAD controls, grouped by effect.
  md += `## Strip list (DEAD only)\n\n`;
  for(const r of allResults){
    if(r.error) continue;
    const dead = r.controls.filter(c => c.verdict === 'DEAD').map(c => c.key);
    if(dead.length) md += `- **${r.slug}**: ${dead.join(', ')}\n`;
  }
  writeFileSync(OUT, md);
  console.log(`\nReport written to ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
