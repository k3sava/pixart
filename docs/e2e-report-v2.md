# pixart v2.0 — e2e sweep report

Date: 2026-05-13
Server: `http://localhost:8001/`
Harness: Playwright MCP, headless Chromium, viewport 1280×800 (mobile check at 375×667).

## Sweep methodology

For each of the 28 effect pages we verified:

1. Page loads HTTP 200, no JS console exceptions.
2. `window.WAEffect.cycleMs === 15000`.
3. Default-mode seamless loop: `WAEffect.renderAt(0)` then `renderAt(1)` produce byte-equal canvas `toDataURL()`.
4. Canvas is non-uniform (≥2 distinct sampled pixel triples — WebGL canvases verified via `toDataURL` byte-size + cycle continuity instead of `getImageData`).
5. Compact nav block present (`.effect-nav.compact`) with prev arrow, current button (`#effect-nav-open`), chevron (`.effect-nav-chev`); clicking current opens overlay (`.pix-nav-overlay.visible`).

Homepage (`http://localhost:8001/`):

- 28 `.pix-card` entries.
- 10 `.home-chip` filter chips (all + 9 categories: type, tonal, halftone, geometric, cinematic, painterly, glitch, generative, motion).
- `/` keystroke focuses `#home-search`.
- Mobile 375×667 → grid renders 2 columns (`grid-template-columns: 163px 163px`).

## Results — homepage

| Check | Result |
|---|---|
| 28 cards | PASS |
| 10 chips | PASS |
| `/` focuses search | PASS |
| Mobile 2-col | PASS |

## Results — 28 effects

| slug | cycle=15000 | loopEqual | non-uniform | nav+chev+overlay |
|---|---|---|---|---|
| ascii | PASS | PASS | PASS | PASS |
| bevel | PASS | PASS | PASS | PASS |
| cellular | PASS | PASS | PASS | PASS |
| contour | PASS | PASS | PASS | PASS |
| crt | PASS | PASS | PASS (WebGL) | PASS |
| displace | PASS | PASS | PASS | PASS |
| distort | PASS | PASS | PASS | PASS |
| dithering | PASS | PASS | PASS | PASS |
| dots | PASS | PASS | PASS | PASS |
| edge | PASS | PASS | PASS | PASS |
| film-grain | PASS | PASS | PASS | PASS |
| flow-field | PASS | PASS | PASS | PASS |
| gradients | PASS | PASS | PASS | PASS |
| halftone-cmyk | PASS | PASS | PASS | PASS |
| ink-wash | PASS | PASS | PASS | PASS |
| kaleidoscope | PASS | PASS | PASS | PASS |
| patterns | PASS | PASS | PASS | PASS |
| pixel-sort | PASS | PASS | PASS | PASS |
| recolor | PASS | PASS | PASS | PASS |
| rgb-shift | PASS | PASS | PASS | PASS |
| scatter | PASS | PASS | PASS | PASS |
| slide | PASS | PASS | PASS | PASS |
| slit-scan | PASS | PASS | PASS | PASS |
| stack | PASS | PASS | PASS | PASS |
| stippling | PASS | PASS | PASS | PASS |
| voronoi | PASS | PASS | PASS | PASS |
| watercolor | PASS | PASS | PASS | PASS |
| zoom-blur | PASS | PASS | PASS | PASS |

**Total: 28/28 effect pages PASS. Homepage PASS.**

## Fixes applied

None required. All 28 effects shipped clean.

## Notes

- `crt` uses a WebGL canvas, so the 2D `getImageData` sampling probe returned an error during automated sweep. Byte-equal `toDataURL` snapshots at t=0 and t=1 confirmed the seamless-loop guarantee for CRT's default mode, and the 2.4 MB data URL size confirms the canvas is genuinely populated.
- The compact nav exposes prev/current/next + overlay chevron in a single row, with the current-effect button (`#effect-nav-open`) opening the 28-effect grid overlay.
