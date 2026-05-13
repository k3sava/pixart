import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const OUT = path.resolve('docs/step2-screenshots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.error('PAGEERROR', e.message));
await page.goto('http://localhost:8001/pixel-sort/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.WAEffect && window.PIXSource && window.PIXSource.getCanvas());
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

async function setKey(key, val){
  await page.evaluate(({key,val}) => {
    const row = document.querySelector(`.wg-row[data-key="${key}"]`);
    if(!row) return false;
    if(row.classList.contains('wg-bool')){
      const cb = row.querySelector('input[type=checkbox]');
      if(cb.checked !== val){ cb.checked = val; cb.dispatchEvent(new Event('change',{bubbles:true})); }
    } else if(row.classList.contains('wg-select')){
      const sel = row.querySelector('select');
      if(sel){ sel.value = val; sel.dispatchEvent(new Event('change',{bubbles:true})); }
      const pill = row.querySelector(`[data-value="${val}"]`);
      if(pill) pill.click();
    } else {
      const inp = row.querySelector('input[type=number]');
      inp.value = val; inp.dispatchEvent(new Event('input',{bubbles:true}));
      inp.dispatchEvent(new Event('change',{bubbles:true}));
    }
    return true;
  }, {key,val});
  await page.waitForTimeout(80);
}

const bench = await page.evaluate(async () => {
  await new Promise(r => requestAnimationFrame(r));
  const start = performance.now();
  for(let i=0;i<24;i++){ window.WAEffect.renderAt(i/24); }
  return (performance.now() - start) / 24;
});
console.log('mean frame ms:', bench.toFixed(2));

await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT, 'pixel-sort-default.png') });

async function frozenShot(mode, t, name){
  await setKey('animate', false);
  await setKey('mode', mode);
  await setKey('animate', true);
  await page.evaluate(() => window.WAEffect.pauseRender());
  await page.evaluate((t) => window.WAEffect.renderAt(t), t);
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(OUT, name) });
  return await page.evaluate(() => document.getElementById('cv').toDataURL('image/png'));
}

const bandMid = await frozenShot('band', 0.5, 'pixel-sort-band.png');
const flowMid = await frozenShot('flow', 0.5, 'pixel-sort-flow.png');

function hash(s){ return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10); }
console.log('band', hash(bandMid));
console.log('flow', hash(flowMid));
const allDistinct = new Set([hash(bandMid), hash(flowMid)]).size === 2;
console.log('t=0.5 modes distinct?', allDistinct);

await setKey('animate', false);
await setKey('interactive', true);
const box = await page.evaluate(() => {
  const r = document.getElementById('cv').getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2 };
});
await page.mouse.move(box.x, box.y);
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(OUT, 'pixel-sort-interactive_center.png') });

await browser.close();
console.log('OK');
