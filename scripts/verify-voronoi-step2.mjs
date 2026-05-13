import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/step2-screenshots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.error('PAGEERROR', e.message));
page.on('console', m => { if(m.type() === 'error') console.error('CONSOLE', m.text()); });
await page.goto('http://localhost:8001/voronoi/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.WAEffect && window.PIXSource && window.PIXSource.getCanvas());
await page.waitForTimeout(800);
// Dismiss help overlay if present.
await page.keyboard.press('Escape').catch(()=>{});
await page.waitForTimeout(200);

async function frameAt(t){
  return await page.evaluate(async (t) => {
    window.WAEffect.renderAt(t);
    await new Promise(r => requestAnimationFrame(r));
    return document.getElementById('cv').toDataURL('image/png');
  }, t);
}

async function setKey(key, val){
  await page.evaluate(({key,val}) => {
    const row = document.querySelector(`.wg-row[data-key="${key}"]`);
    if(!row) return false;
    if(row.classList.contains('wg-bool')){
      const cb = row.querySelector('input[type=checkbox]');
      if(cb.checked !== val){ cb.checked = val; cb.dispatchEvent(new Event('change', {bubbles:true})); }
    } else if(row.classList.contains('wg-select')){
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

// 1) Default screenshot
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'voronoi-default.png') });

// 2) Bench — 24 frames in hue mode (paint-only path)
await setKey('mode', 'hue');
await setKey('animate', true);
await page.waitForTimeout(120);
const benchHue = await page.evaluate(async () => {
  const start = performance.now();
  for(let i=0;i<24;i++){ window.WAEffect.renderAt(i/24); }
  return (performance.now() - start) / 24;
});
console.log('mean frame ms [hue]:', benchHue.toFixed(2));

const hueMid = await frameAt(0.5);
await page.evaluate(() => window.WAEffect.pauseRender());
await page.evaluate(async () => { window.WAEffect.renderAt(0.5); await new Promise(r => requestAnimationFrame(r)); });
await page.screenshot({ path: path.join(OUT, 'voronoi-hue.png') });
await page.evaluate(() => window.WAEffect.resumeRender());

// 3) tone mode
await setKey('mode', 'tone');
await page.waitForTimeout(120);
const benchTone = await page.evaluate(async () => {
  const start = performance.now();
  for(let i=0;i<24;i++){ window.WAEffect.renderAt(i/24); }
  return (performance.now() - start) / 24;
});
console.log('mean frame ms [tone]:', benchTone.toFixed(2));
const toneMid = await frameAt(0.5);
await page.evaluate(() => window.WAEffect.pauseRender());
await page.evaluate(async () => { window.WAEffect.renderAt(0.5); await new Promise(r => requestAnimationFrame(r)); });
await page.screenshot({ path: path.join(OUT, 'voronoi-tone.png') });
await page.evaluate(() => window.WAEffect.resumeRender());

// 5) interactive
await setKey('animate', false);
await setKey('interactive', true);
await page.mouse.move(640, 400);
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'voronoi-interactive_center.png') });

function sliceHash(s){ let h=0; for(let i=1000;i<5000;i+=37){ h = (h*31 + s.charCodeAt(i)) | 0; } return h; }
const hH = sliceHash(hueMid), hT = sliceHash(toneMid);
console.log('hue', hH, 'tone', hT);
console.log('distinct:', hH !== hT);

await browser.close();
console.log('OK');
