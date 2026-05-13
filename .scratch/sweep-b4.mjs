import { chromium } from '/Users/k3sava/projects/pixart/node_modules/playwright/index.mjs';

const slugs = ['slide','slit-scan','stack','stippling','voronoi','watercolor','zoom-blur'];
const heavy = new Set(['voronoi','stack','slide','stippling']);
const BASE = 'http://localhost:8001';

const results = {};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

page.on('pageerror', e => { results.__lastErr = e.message; });
page.on('console', msg => { if (msg.type()==='error') results.__lastConsoleErr = msg.text(); });

async function settle(slug) {
  const ms = heavy.has(slug) ? 2500 : 800;
  await page.waitForTimeout(ms);
}

for (const slug of slugs) {
  const r = { slug, loaded:false, firstPaint:false, modes:[], modeDistinct:null, interactive:null, fiveSampleDistinct:null, errors:[] };
  try {
    results.__lastErr = null; results.__lastConsoleErr = null;
    await page.goto(`${BASE}/${slug}/`, { waitUntil:'domcontentloaded', timeout:15000 });
    r.loaded = true;
    await settle(slug);

    // first paint check
    const fp = await page.evaluate(() => {
      const cv = document.getElementById('cv');
      if (!cv) return { ok:false, reason:'no #cv' };
      const ctx = cv.getContext('2d');
      if (!ctx) return { ok:true, webgl:true }; // probably webgl
      const w = cv.width, h = cv.height;
      const data = ctx.getImageData(0,0,Math.min(w,200),Math.min(h,200)).data;
      let nonZero = 0;
      for (let i=0;i<data.length;i+=4) if (data[i]||data[i+1]||data[i+2]) nonZero++;
      return { ok: nonZero > 100, nonZero, total: data.length/4 };
    });
    r.firstPaintInfo = fp;
    r.firstPaint = !!fp.ok;

    // mode-distinct test
    const modeInfo = await page.evaluate(() => {
      const sel = document.querySelector('[data-key="mode"] select');
      if (!sel) return { modes:[] };
      return { modes: Array.from(sel.options).map(o=>o.value) };
    });
    r.modes = modeInfo.modes;

    if (modeInfo.modes.length >= 2 && typeof (await page.evaluate(()=>typeof window.pauseRender)) === 'string') {
      const distinctResults = [];
      try {
        await page.evaluate(() => { if (window.pauseRender) window.pauseRender(); });
        const snaps = {};
        for (const m of modeInfo.modes.slice(0,3)) {
          await page.evaluate((mode) => {
            const sel = document.querySelector('[data-key="mode"] select');
            sel.value = mode;
            sel.dispatchEvent(new Event('change', { bubbles:true }));
            if (window.renderAt) window.renderAt(0.5);
          }, m);
          await page.waitForTimeout(heavy.has(slug)?1200:400);
          const d = await page.evaluate(() => document.getElementById('cv').toDataURL().slice(0,5000));
          snaps[m] = d;
        }
        const vals = Object.values(snaps);
        const allDistinct = new Set(vals).size === vals.length;
        r.modeDistinct = allDistinct;
        r.modeSnapsLens = vals.map(v=>v.length);
      } catch (e) {
        r.errors.push('modeDistinct: '+e.message);
      }
    } else {
      r.modeDistinct = 'n/a';
    }

    // interactive cursor test (dispatch on #cv)
    try {
      // first resume rendering
      await page.evaluate(() => { if (window.resumeRender) window.resumeRender(); });
      await page.waitForTimeout(300);
      const interactiveResult = await page.evaluate(async () => {
        const cv = document.getElementById('cv');
        const r = cv.getBoundingClientRect();
        cv.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 50, clientY: r.top + 50, bubbles: true }));
        await new Promise(res => setTimeout(res, 300));
        const a = cv.toDataURL();
        cv.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width - 50, clientY: r.top + r.height - 50, bubbles: true }));
        await new Promise(res => setTimeout(res, 300));
        const b = cv.toDataURL();
        return { interactive: a !== b, aLen: a.length, bLen: b.length };
      });
      r.interactive = interactiveResult.interactive;
    } catch (e) {
      r.errors.push('interactive: '+e.message);
    }

    // 5-sample test (reload, sample, repeat)
    try {
      const samples = [];
      for (let i=0;i<5;i++) {
        await page.goto(`${BASE}/${slug}/`, { waitUntil:'domcontentloaded' });
        await page.waitForTimeout(1500);
        const d = await page.evaluate(() => document.getElementById('cv').toDataURL().slice(0,3000));
        samples.push(d);
      }
      r.fiveSampleDistinct = new Set(samples).size;
    } catch (e) {
      r.errors.push('fiveSample: '+e.message);
    }

    if (results.__lastErr) r.errors.push('pageerror: '+results.__lastErr);
    if (results.__lastConsoleErr) r.errors.push('console: '+results.__lastConsoleErr);
  } catch (e) {
    r.errors.push('outer: '+e.message);
  }
  results[slug] = r;
  console.log(JSON.stringify({slug, firstPaint:r.firstPaint, modes:r.modes.length, modeDistinct:r.modeDistinct, interactive:r.interactive, fiveSampleDistinct:r.fiveSampleDistinct, errs:r.errors.length}));
}

await browser.close();
console.log('\n===RESULTS===');
console.log(JSON.stringify(results, null, 2));
