import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/step2-screenshots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.error('PAGEERROR', e.message));
await page.goto('http://localhost:8001/ascii/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.WAEffect && window.PIXSource && window.PIXSource.getCanvas());
await page.waitForTimeout(400);

// Force the bundled portrait sample by reading-cycle the shuffle until name contains portrait
// PIXSource.getCanvas returns; we trust the boot sample is portrait.jpg per task.

// Helper: render at t01, return dataURL of #cv
async function frameAt(t){
  return await page.evaluate(async (t) => {
    window.WAEffect.renderAt(t);
    await new Promise(r => requestAnimationFrame(r));
    return document.getElementById('cv').toDataURL('image/png');
  }, t);
}

// 1) bench 24 frames
const bench = await page.evaluate(async () => {
  const start = performance.now();
  for(let i=0;i<24;i++){ window.WAEffect.renderAt(i/24); }
  return (performance.now() - start) / 24;
});
console.log('mean frame ms:', bench.toFixed(2));

// 2) default frame (animate off, interactive off)
async function setParams(p){
  await page.evaluate((p) => {
    Object.assign(window.WAEffect ? {} : {}, {});
    // mutate via GUI is tricky; reach into params via the closure isn't possible.
    // Re-init: dispatch input events on hidden inputs / checkboxes by data-key.
  }, p);
}

async function setKey(key, val){
  await page.evaluate(({key,val}) => {
    const row = document.querySelector(`.wg-row[data-key="${key}"]`);
    if(!row) return false;
    if(row.classList.contains('wg-bool')){
      const cb = row.querySelector('input[type=checkbox]');
      if(cb.checked !== val){ cb.checked = val; cb.dispatchEvent(new Event('change', {bubbles:true})); }
    } else if(row.classList.contains('wg-select')){
      // pill or select
      const sel = row.querySelector('select');
      if(sel){ sel.value = val; sel.dispatchEvent(new Event('change', {bubbles:true})); }
      const pill = row.querySelector(`[data-value="${val}"]`);
      if(pill) pill.click();
    } else {
      const inp = row.querySelector('input');
      inp.value = val; inp.dispatchEvent(new Event('input', {bubbles:true}));
      inp.dispatchEvent(new Event('change', {bubbles:true}));
    }
    return true;
  }, {key, val});
}

await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT, 'ascii-default.png'), clip: { x:0, y:0, width:1280, height:800 } });

// 3) mode pulse @ t=0.5
await setKey('mode', 'pulse');
await setKey('animate', true);
await page.waitForTimeout(50);
const pulseMid = await frameAt(0.5);
await page.screenshot({ path: path.join(OUT, 'ascii-pulse.png') });

// 4) mode tone @ t=0.5
await setKey('mode', 'tone');
await page.waitForTimeout(50);
const toneMid = await frameAt(0.5);
await page.screenshot({ path: path.join(OUT, 'ascii-tone.png') });

// 5) default frame again (animate off)
await setKey('animate', false);

// 6) interactive center
await setKey('interactive', true);
await page.mouse.move(640, 400);
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(OUT, 'ascii-interactive_center.png') });

console.log('pulseMid == toneMid?', pulseMid === toneMid);
// quick diff metric on a slice
function sliceHash(s){ let h=0; for(let i=1000;i<5000;i+=37){ h = (h*31 + s.charCodeAt(i)) | 0; } return h; }
console.log('pulseHash', sliceHash(pulseMid), 'toneHash', sliceHash(toneMid));

await browser.close();
console.log('OK');
