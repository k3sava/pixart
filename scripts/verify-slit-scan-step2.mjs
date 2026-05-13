import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/step2-screenshots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', e => console.error('PAGEERROR', e.message));
page.on('console', m => { if(m.type() === 'error') console.error('CONSOLE', m.text()); });
await page.goto('http://localhost:8001/slit-scan/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.WAEffect && window.PIXSource && window.PIXSource.getCanvas());
await page.waitForTimeout(500);

await page.evaluate(() => {
  const overlays = document.querySelectorAll('[class*="help"], .wa-help, dialog[open], .shortcuts-overlay');
  overlays.forEach(o => o.remove());
});
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

async function setKey(key, val){
  await page.evaluate(({key,val}) => {
    const row = document.querySelector(`.wg-row[data-key="${key}"]`);
    if(!row) return false;
    if(row.classList.contains('wg-bool')){
      const cb = row.querySelector('input[type=checkbox]');
      if(cb.checked !== val){ cb.checked = val; cb.dispatchEvent(new Event('change', {bubbles:true})); }
    } else if(row.classList.contains('wg-select')){
      const sel = row.querySelector('select');
      if(sel){ sel.value = String(val); sel.dispatchEvent(new Event('change', {bubbles:true})); }
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

async function frameAt(t){
  return await page.evaluate(async (t) => {
    window.WAEffect.renderAt(t);
    await new Promise(r => requestAnimationFrame(r));
    return document.getElementById('cv').toDataURL('image/png');
  }, t);
}

await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT, 'slit-scan-default.png') });

const bench = await page.evaluate(async () => {
  const start = performance.now();
  for(let i=0;i<24;i++){ window.WAEffect.renderAt(i/24); }
  return (performance.now() - start) / 24;
});
console.log('mean frame ms:', bench.toFixed(2));

await setKey('animate', true);
await setKey('mode', 'breath');
await page.waitForTimeout(80);
const breathMid = await frameAt(0.5);
await page.screenshot({ path: path.join(OUT, 'slit-scan-breath.png') });

await setKey('mode', 'tilt');
await page.waitForTimeout(80);
const tiltMid = await frameAt(0.5);
await page.screenshot({ path: path.join(OUT, 'slit-scan-tilt.png') });

await setKey('animate', false);
await setKey('interactive', true);
await page.mouse.move(640, 400);
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT, 'slit-scan-interactive_center.png') });

function sliceHash(s){ let h=0; for(let i=1000;i<5000;i+=37){ h = (h*31 + s.charCodeAt(i)) | 0; } return h; }
const hb = sliceHash(breathMid), ht = sliceHash(tiltMid);
console.log('breath', hb, 'tilt', ht);
console.log('distinct?', hb !== ht);

await browser.close();
console.log('OK');
