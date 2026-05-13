import { chromium } from 'playwright';
import fs from 'fs';

const EFFECTS = ['ascii','bevel','cellular','contour','crt','displace','distort'];
const SAMPLES = ['portrait.jpg','landscape.jpg','macro.jpg','cityscape.jpg','clip.mp4'];
const BASE = 'http://localhost:8001';

function brightStd(data){
  const n = data.length/4;
  let s=0, s2=0;
  for(let i=0;i<data.length;i+=4){
    const b = 0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
    s += b; s2 += b*b;
  }
  const m = s/n;
  return Math.sqrt(Math.max(0, s2/n - m*m));
}

async function sampleCanvasStd(page){
  return await page.evaluate(() => {
    const cv = document.querySelector('canvas');
    if(!cv) return {err:'no canvas'};
    const w = cv.width, h = cv.height;
    if(!w || !h) return {err:'zero size'};
    const cx = Math.max(0, (w-200)/2|0);
    const cy = Math.max(0, (h-200)/2|0);
    const sw = Math.min(200, w), sh = Math.min(200, h);
    try {
      const ctx = cv.getContext('2d') || cv.getContext('webgl2') || cv.getContext('webgl');
      // For 2d canvas:
      if(cv.getContext('2d')){
        const d = cv.getContext('2d').getImageData(cx, cy, sw, sh).data;
        return {data: Array.from(d)};
      }
      // WebGL: read pixels
      const gl = cv.getContext('webgl2') || cv.getContext('webgl');
      if(gl){
        const px = new Uint8Array(sw*sh*4);
        gl.readPixels(cx, cy, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return {data: Array.from(px)};
      }
      return {err:'no ctx'};
    } catch(e){ return {err:e.message}; }
  });
}

async function canvasHash(page){
  return await page.evaluate(() => {
    const cv = document.querySelector('canvas');
    try { return cv.toDataURL().slice(-200); } catch(e){ return 'err:'+e.message; }
  });
}

async function auditEffect(browser, slug){
  const result = { slug, console:'✓ clean', samples:{}, modes:'', interactive:'', errors:[] };
  const page = await browser.newPage({ viewport:{width:1200,height:800} });
  const consoleErrors = [];
  page.on('console', m => { if(m.type()==='error'){ const t = m.text(); if(!/favicon|404/i.test(t)) consoleErrors.push(t); } });
  page.on('pageerror', e => consoleErrors.push('pageerror: '+e.message));

  try {
    await page.goto(`${BASE}/${slug}/`, { waitUntil:'load', timeout:15000 });
    await page.waitForTimeout(800);

    // Get mode options
    const modes = await page.$$eval(`[data-key="mode"] select option`, opts => opts.map(o=>o.value));

    // Per sample
    for(const s of SAMPLES){
      await page.evaluate((url) => window.PIXSource && window.PIXSource.loadUrl(url), `../assets/samples/${s}`);
      await page.waitForTimeout(900);
      const r = await sampleCanvasStd(page);
      if(r.err){ result.samples[s] = '✗ '+r.err; continue; }
      const std = brightStd(r.data);
      result.samples[s] = std < 5 ? `✗ flat (std-dev ${std.toFixed(1)})` : `✓ (std ${std.toFixed(1)})`;
    }

    // Reset to portrait for mode test
    await page.evaluate(() => window.PIXSource && window.PIXSource.loadUrl('../assets/samples/portrait.jpg'));
    await page.waitForTimeout(600);

    // Turn animate ON
    await page.evaluate(() => {
      const cb = document.querySelector('[data-key="animate"] input[type=checkbox]');
      if(cb && !cb.checked) cb.click();
    });
    await page.waitForTimeout(300);

    // Try each mode via PIXState.set
    const hashes = {};
    for(const m of modes){
      await page.evaluate((m) => { try { window.PIXState && window.PIXState.set('mode', m); } catch(e){}
        const sel = document.querySelector('[data-key="mode"] select');
        if(sel){ sel.value = m; sel.dispatchEvent(new Event('change', {bubbles:true})); }
      }, m);
      await page.waitForTimeout(400);
      hashes[m] = await canvasHash(page);
    }
    const uniqHashes = new Set(Object.values(hashes));
    if(uniqHashes.size === modes.length){
      result.modes = `✓ ${modes.length} modes`;
    } else {
      // identify collapsed
      const dupes = [];
      const seen = {};
      for(const [m,h] of Object.entries(hashes)){
        if(seen[h]) dupes.push(`${m}=${seen[h]}`);
        else seen[h] = m;
      }
      result.modes = `✗ collapsed: ${dupes.join(',')}`;
    }

    // Interactive
    await page.evaluate(() => {
      const cb = document.querySelector('[data-key="interactive"] input[type=checkbox]');
      if(cb && !cb.checked) cb.click();
    });
    await page.waitForTimeout(300);
    const cv = await page.$('canvas');
    if(!cv){ result.interactive = '✗ no canvas'; }
    else {
      const box = await cv.boundingBox();
      await page.mouse.move(box.x + 50, box.y + 50);
      await page.waitForTimeout(400);
      const h1 = await canvasHash(page);
      await page.mouse.move(box.x + 250, box.y + 250);
      await page.waitForTimeout(400);
      const h2 = await canvasHash(page);
      result.interactive = (h1 !== h2) ? '✓' : '✗ no diff on cursor move';
    }
  } catch(e){
    result.errors.push(e.message);
  }

  if(consoleErrors.length){
    result.console = '✗ ' + consoleErrors.slice(0,2).join(' | ').slice(0,200);
  }
  await page.close();
  return result;
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  for(const slug of EFFECTS){
    console.log('Auditing', slug);
    const r = await auditEffect(browser, slug);
    results.push(r);
  }
  await browser.close();

  // Write markdown
  let md = '# Sweep Batch 1 — ascii, bevel, cellular, contour, crt, displace, distort\n\n';
  md += `Date: 2026-05-13\n\n`;
  for(const r of results){
    md += `## ${r.slug}\n`;
    md += `- console:        ${r.console}\n`;
    for(const s of SAMPLES){
      const pad = (s+':').padEnd(14,' ');
      md += `- ${pad}  ${r.samples[s] || '?'}\n`;
    }
    md += `- modes distinct: ${r.modes}\n`;
    md += `- interactive:    ${r.interactive}\n`;
    if(r.errors.length) md += `- errors:         ${r.errors.join(' | ')}\n`;
    md += '\n';
  }

  // Priority fixes
  md += '## Priority fixes\n\n';
  const issues = [];
  for(const r of results){
    if(r.console.startsWith('✗')) issues.push({sev:1, t:`${r.slug}: console errors — ${r.console}`});
    for(const s of SAMPLES){
      if((r.samples[s]||'').startsWith('✗')) issues.push({sev:2, t:`${r.slug} / ${s}: ${r.samples[s]}`});
    }
    if(r.modes.startsWith('✗')) issues.push({sev:3, t:`${r.slug}: modes — ${r.modes}`});
    if(r.interactive.startsWith('✗')) issues.push({sev:4, t:`${r.slug}: interactive — ${r.interactive}`});
  }
  issues.sort((a,b)=>a.sev-b.sev);
  for(const i of issues) md += `- ${i.t}\n`;

  fs.writeFileSync('/Users/k3sava/projects/pixart/docs/sweep-batch-1.md', md);
  console.log('Wrote sweep-batch-1.md with', issues.length, 'issues');
  console.log(JSON.stringify(results.map(r=>({slug:r.slug, modes:r.modes, interactive:r.interactive, console:r.console.slice(0,50)})), null, 2));
})();
