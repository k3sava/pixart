import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = '/Users/k3sava/projects/pixart/docs/step2-sweep';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport:{width:1280,height:800}})).newPage();
page.on('pageerror', e => console.error('PE', e.message));
await page.goto('http://localhost:8001/displace/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.PIXSource && window.PIXSource.getCanvas());
await page.waitForTimeout(400);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);

async function setKey(key, val){
  await page.evaluate(({key,val}) => {
    const row = document.querySelector(`.wg-row[data-key="${key}"]`);
    if(!row) return;
    if(row.classList.contains('wg-bool')){
      const cb = row.querySelector('input[type=checkbox]');
      if(cb.checked !== val){ cb.checked = val; cb.dispatchEvent(new Event('change',{bubbles:true})); }
    } else if(row.classList.contains('wg-select')){
      const sel = row.querySelector('select');
      if(sel){ sel.value = val; sel.dispatchEvent(new Event('change',{bubbles:true})); }
    } else {
      const inp = row.querySelector('input[type=number]');
      inp.value = val; inp.dispatchEvent(new Event('input',{bubbles:true}));
      inp.dispatchEvent(new Event('change',{bubbles:true}));
    }
  }, {key,val});
  await page.waitForTimeout(80);
}

// sweep displacement
for(const d of [0, 60, 120, 180, 240, 320, 400]){
  await setKey('displacement', d);
  await page.screenshot({ path: `${OUT}/disp-${d}.png` });
}
// reset
await setKey('displacement', 180);
// sweep stepSize
for(const s of [4, 6, 8, 10, 14, 18]){
  await setKey('stepSize', s);
  await page.screenshot({ path: `${OUT}/step-${s}.png` });
}
await setKey('stepSize', 8);
// sweep dotSize
for(const d of [2, 4, 6, 8, 12, 18, 28]){
  await setKey('dotSize', d);
  await page.screenshot({ path: `${OUT}/dot-${d}.png` });
}
await setKey('dotSize', 8);
// sweep whitePoint
for(const w of [120, 160, 200, 230, 255]){
  await setKey('whitePoint', w);
  await page.screenshot({ path: `${OUT}/wp-${w}.png` });
}
await setKey('whitePoint', 255);
console.log('sweep done');
await browser.close();
