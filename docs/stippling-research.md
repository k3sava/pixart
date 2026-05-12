# Stippling — reference dossier

Port of `tooooools.app/effects/stipping` (URL typo in the source; the in-bundle
title is "Stippling"). pixart ships as `stippling/` (correct spelling), and the
algorithm is preserved exactly.

## Bundle artifacts

- Page chunk: `/_next/static/chunks/app/effects/stipping/page-ae6102acc68fcb3e.js`
- Shared chunk (defaults + preprocessor): `/_next/static/chunks/9357-2a51c42cdfe973de.js`
- Both fetched via `curl -sL` from `https://www.tooooools.app/`, beautified
  with `js-beautify`.

The reference route 301-redirects `www.` then 404s on `/effects/stippling` —
the canonical URL is `/effects/stipping` (typo retained in production). We
keep the corrected spelling for the pixart route.

## What the effect actually is

Despite the name, this is **not** classic stippling:

- Not Weighted Voronoi Stippling (Secord 2002 / Lloyd's relaxation).
- Not Bridson Poisson-disk.
- Not blue-noise / error-diffusion stippling.

It's a **rotated halftone-bar grid**: an `xSquares × ySquares` mesh of
vertical rectangles, rotated by `angle`, whose **widths** are mapped from the
source luminance under each cell centre. Darker source pixel → wider bar.
This is closer to the Ben Day dot screens used in mid-century print
(`gridType: "Benday"` literally adds the half-cell row offset that turns the
grid into a staggered Ben Day pattern). Calling it "stippling" is loose
usage, but we honour the reference.

## Reference algorithm (verbatim from the bundle)

Beautified `page-stipping.js` lines 142-204, transcribed with identifier
restorations:

```js
let r = e.radians(a.angle || 0);
let n = Math.abs(Math.cos(r)) + Math.abs(Math.sin(r));   // rotation widening
let l = t.height / a.ySquares / n;                       // cell height
let o = t.width  / a.xSquares / n;                       // cell width
let i = t.width / 2,  s = t.height / 2;                  // canvas centre
let u = Math.sqrt(W*W + H*H);                            // diagonal
let d = u / 2 + Math.max(o, l);                          // sweep half-extent
let p = (l - 0.1) * 0.99;                                // y-step
let c = (o - 0.1) * 0.99;                                // x-step

for (let f = -d; f < u + d; f += p) {
  let y = "Benday" === a.gridType
          ? (o - 0.1) / 2 * (Math.floor(f / p) % 2)      // staggered rows
          : 0;
  for (let o_ = -d; o_ < u + d; o_ += c) {
    let uu = o_ + y, dd = f;
    let cx = i + uu * cos(r) - dd * sin(r);              // canvas-space x
    let cy = s + uu * sin(r) + dd * cos(r);              // canvas-space y

    let {r:R, g:G, b:B, a:A} = sample(cx, cy);
    let S = A / 255;
    let w = (lerp(255,R,S) + lerp(255,G,S) + lerp(255,B,S)) / 3;    // lum
    let x = w < a.lightnessThreshold
          ? map(w, 0, threshold, maxSquareWidth, minSquareWidth)
          : minSquareWidth;
    let C = (x > 1 ? x + 0.05 : x) / n;                  // width, anti-gap
    // ... rotated-bbox vs canvas culling test ...
    translate(cx, cy); rotate(r); rect(-C/2, -l/2, C, l);
  }
}
```

Notes that matter for byte-equal parity:

- `n = |cos| + |sin|` divides both cell dimensions and the final width —
  it shrinks the grid so the rotated rectangles tile without overlap.
- The `(l - 0.1) * 0.99` step (instead of `l`) produces a subtle gap between
  cells; we preserve it.
- The `+0.05` width nudge for `x > 1` is a sub-pixel anti-gap quirk;
  preserved.
- Luminance is **alpha-composited** (`lerp(255, ch, alpha)`), the same
  channel weighting Displace and Edge use — not the unweighted `(R+G+B)/3`
  Cellular uses. Confirmed against bundle line 178.

## Bundle defaults (from `9357-*.js`, `pageStates["/effects/stipping"]`)

| key                | bundle | pixart  | reason for divergence                                |
|--------------------|-------:|--------:|------------------------------------------------------|
| showEffect         | true   | true    |                                                      |
| lightnessThreshold | 128    | 200     | striking landing frame — 128 produces sparse stipple |
| ySquares           | 90     | 90      |                                                      |
| xSquares           | 90     | 90      |                                                      |
| minSquareWidth     | 1      | 1       |                                                      |
| maxSquareWidth     | 4      | 5       | fatter darks read better against paper-cream bg      |
| gridType           | Regular| Regular |                                                      |
| angle              | 0      | 15      | deliberate rotation reads on first paint             |

Preprocessor (shared with Displace/Edge/Cellular): `canvasSize 600, blur 0,
grain 0, gamma 1, blackPoint 0, whitePoint 255` — unchanged.

Added pixart-only params:

- `angleSweep` (default 20°) — amplitude of the angle pingpong during loop.
- `dotColor` (`#000000`) / `bgColor` (`#f5f1ea`, paper cream).

## Implementation decisions

- **Source-space build, canvas-space paint.** `buildDots()` runs the cell
  loop in preprocessed-source coordinates (W × H = `canvasSize` × derived).
  `paint()` maps with `contain` and a 0.96 inset, exactly mirroring the
  cellular/edge port — keeps grid square regardless of canvas aspect.
- **lumGrid cache.** One alpha-composited luminance pass per `preprocess()`,
  reused across cells. Sample is a clamp-to-edge `floor()` lookup, same as
  the bundle's helper.
- **Float32Array dot pool.** 5 floats per dot (cx, cy, w, h, angle). Worst
  case sized to `((u + 2d)/p) × ((u + 2d)/c)` to absorb the rotation
  overshoot. At 90×90 grid with 15° angle this is ~13.3 k dots per frame.
- **Clip path during paint.** Rotation overshoot can push cells past the
  source-mapped rect; we `ctx.clip()` to that rect so dots never bleed onto
  the page bg.
- **Animation.** The reference is static. We sweep `angle` on a cosine
  pingpong: `angle(t) = base + sweep · (2·pingpong(t) - 1)`. Endpoints meet
  byte-equal (verified: `cv.toDataURL()` identical at t=0, t=1, and on
  idempotent re-renders).
- **No WebGL.** Default settings run at ~6 ms median / ~10 ms avg per frame
  at 1280×720. Well under the 30 ms budget. WebGL not justified.

## Algorithm classification (vs canonical stippling)

A true Weighted Voronoi port would:

1. Seed N points (rejection-sample on luminance).
2. Compute the Voronoi diagram (Fortune / d3-delaunay).
3. Lloyd-relax centroids weighted by `(255 - lum)` for K iterations.
4. Paint final centroids as constant-radius dots.

That's `O(N log N)` per iteration with `N ≈ 5–20 k` for a striking image,
which is feasible (d3-delaunay does ~5 k points in ~3 ms) but the visual
identity diverges from the reference. We file it as a future
`weighted-voronoi/` effect, NOT a divergence inside `stippling/`.

## Verification

Performed at 1280×720, default settings, via Playwright MCP:

- `WAEffect.renderAt(0)` byte-equal to `WAEffect.renderAt(1)` (`toDataURL`
  comparison).
- Idempotent: `renderAt(0)` after `renderAt(0.5)` returns same bytes.
- 20-sample render benchmark: avg 10.37 ms, median 6.10 ms, max 65 ms (first
  frame with preprocessor warmup).
- Landing frame: visible halftone bars at 15°, full coverage on the pixart
  placeholder source.
- Console clean (only the known harmless `assets/samples/portrait.jpg` 404).

## Divergences from the bundle (summary)

| area               | divergence                          | reason                                |
|--------------------|-------------------------------------|---------------------------------------|
| lightnessThreshold | 128 → 200                           | striking landing frame                |
| maxSquareWidth     | 4 → 5                               | balance against paper-cream bg        |
| angle              | 0 → 15°                             | reads as deliberate on first paint    |
| animation          | none → angle pingpong (15s)         | reference is static; we ship loops    |
| paint bg           | n/a → `bgColor` (paper-cream)       | gives dots an inked-on-paper frame    |

Algorithmic body (cell loop, luminance mapping, anti-gap nudges, Benday
offset, rotated-bbox cull) preserved exactly.
