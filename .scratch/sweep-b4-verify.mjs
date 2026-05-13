import { chromium } from '/Users/k3sava/projects/pixart/node_modules/playwright/index.mjs';
const slugs = ['slit-scan','stack','stippling','voronoi','watercolor','zoom-blur'];
const heavy = new Set(['voronoi','stack','stippling']);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport:{width:1280,height:800}})).newPage();

for (const slug of slugs) {
  await page.goto(`http://localhost:8001/${slug}/`, { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(heavy.has(slug)?2500:1200);

  const out = await page.evaluate(async () => {
    const sel = document.querySelector('[data-key="mode"] select');
    const modes = Array.from(sel.options).map(o=>o.value);
    const snaps = {};
    if (window.pauseRender) window.pauseRender();
    for (const m of modes) {
      sel.value = m;
      sel.dispatchEvent(new Event('change', { bubbles:true }));
      await new Promise(r=>setTimeout(r, 100));
      if (window.renderAt) window.renderAt(0.5);
      await new Promise(r=>setTimeout(r, 600));
      const d = document.getElementById('cv').toDataURL();
      // hash via small sample at varied offsets
      snaps[m] = { len:d.length, head:d.slice(50,150), mid:d.slice(d.length/2, d.length/2+100), tail:d.slice(-150) };
    }
    return { modes, snaps, hasPause: !!window.pauseRender, hasRenderAt: !!window.renderAt };
  });
  console.log(slug, JSON.stringify(out));
}
await browser.close();
