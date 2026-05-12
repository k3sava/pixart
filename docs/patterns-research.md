# Patterns — reference dossier

Port of `tooooools.app/effects/patterns` (canonical URL, no typo this time).

## Bundle artifacts

- Page chunk: `/_next/static/chunks/app/effects/patterns/page-4f9e64748661ad47.js`
- Shared chunk (defaults + preprocessor): `/_next/static/chunks/9357-2a51c42cdfe973de.js`
- Six pattern PNGs at `/pattern-{1..6}.png` (700 B – 1.2 KB each — tiny
  halftone tiles). Mirrored to `patterns/patterns/pattern-{1..6}.png`.

Both chunks fetched via `curl -sL` and beautified with `prettier`.

## What the effect actually is

This is **not** a procedural pattern catalog (lines / grid / zigzag / circles).
It is a **photo-mosaic / collage** renderer:

1. User uploads N pattern images. Bundle ships 6 defaults.
2. For each pattern, the bundle alpha-composites RGB onto white and computes a
   per-pixel weighted magnitude:
   ```
   averageBrightness = mean(sqrt(0.299 R² + 0.587 G² + 0.114 B²))
   ```
   (note: not Rec.601 luminance — it's the *root* of the weighted sum of
   squared channels, which the bundle uses purely as an ordering metric).
3. Catalog is sorted **darkest → brightest** by that scalar.
4. The source canvas is laid out on a grid with:
   ```
   n     = min(W, H) / gridDensityNumber   # target cell size
   cols  = ceil(W / n)
   rows  = ceil(H / n)
   cellW = W / cols
   cellH = H / rows
   ```
   `gridDensityNumber` is "cells across the *shorter* side", not width.
5. For each cell, the bundle samples a **single source pixel** at the cell's
   top-left (`(floor(c*cellW) + floor(r*cellH)*W)*4`). No averaging.
6. Cell luminance is the framework's canonical alpha-composited luminance:
   `L = (lerp(255,R,a) + lerp(255,G,a) + lerp(255,B,a)) / 3`.
7. If `L < lightnessThreshold`, the cell is filled with
   `catalog[ clamp(floor(L/threshold * N), 0, N-1) ].img` drawn at the cell
   rect. Otherwise the cell is empty (canvas bg shows through).

Darker source pixel → smaller index into the darkest→brightest catalog →
darker pattern tile. The threshold acts as a "light cutoff" past which the
mosaic stops drawing and lets the background through.

## Reference algorithm (verbatim from the bundle)

Beautified `page-patterns.js` lines 154–191:

```js
let n = Math.min(t.width, t.height) / r.gridDensityNumber,
    l = Math.ceil(t.width  / n),
    a = Math.ceil(t.height / n),
    o = t.width  / l,    // cellW
    i = t.height / a;    // cellH

for (let n_ = 0; n_ < a; n_++)
  for (let a_ = 0; a_ < l; a_++) {
    let l_ = (Math.floor(a_ * o) + Math.floor(n_ * i) * t.width) * 4,
        s = t.pixels[l_], u = t.pixels[l_+1], d = t.pixels[l_+2],
        h = t.pixels[l_+3] / 255,
        p = (e.lerp(255,s,h) + e.lerp(255,u,h) + e.lerp(255,d,h)) / 3;

    if (p < r.lightnessThreshold) {
      let img = c[e.constrain(
                  e.floor((p / r.lightnessThreshold) * c.length),
                  0, c.length - 1)].img;
      t.image(img, a_*o, n_*i, o, i);
    }
  }
```

And the catalog prep (lines 122–153):

```js
for each pattern image im:
  loadPixels()
  n = 0
  for each pixel: alpha-composite RGB onto white;
                  n += sqrt(0.299 R² + 0.587 G² + 0.114 B²)
  averageBrightness = n / (W*H)
patterns.sort((a, b) => a.averageBrightness - b.averageBrightness)
```

Notes that matter for parity:

- The catalog ordering metric is **not** Rec.601 luminance. It's
  `sqrt(sum(w_c · c²))`. Different from the per-cell sampling luminance.
  Preserved verbatim.
- Sampling is **one source pixel per cell** (top-left). No averaging, no
  centroid. The "grain" of the mosaic comes from the source pixel itself.
- `clamp(floor(L/threshold * N), 0, N-1)` — when `L === threshold` the result
  is `N` and gets clamped back to `N-1`. Preserved.

## Bundle defaults (from `9357-*.js`, `pageStates["/effects/patterns"]`)

| key                | bundle | pixart  | reason for divergence                        |
|--------------------|-------:|--------:|----------------------------------------------|
| imageUrls          | 6 PNGs | 6 PNGs  | mirrored locally                             |
| showEffect         | true   | true    |                                              |
| lightnessThreshold | 178    | 220     | striking landing — 178 leaves edges bare     |
| gridDensityNumber  | 49     | 49      |                                              |

Preprocessor (shared with Displace/Edge/Cellular/Stippling): `canvasSize 600,
blur 0, grain 0, gamma 1, blackPoint 0, whitePoint 255` — unchanged.

Added pixart-only params:

- `densitySweep` (default 18) — amplitude of the grid-density pingpong.
- `bgColor` (`#f5f1ea`, paper cream) — background under the mosaic.

## Implementation decisions

- **Catalog as `{img, averageBrightness, url}[]`**, sorted on load, never
  re-sorted. `loadCatalog()` is async + race-guarded via `catalogLoadId` so
  rapid source/pattern swaps don't interleave.
- **Source-space build, canvas-space paint.** Same pattern as
  stippling/edge/cellular ports. `buildCells()` emits `[x,y,w,h,idx]` in
  source coords; `paint()` maps with `contain` and a 0.96 inset.
- **lumGrid cache** identical to the other ports: one alpha-composited pass
  over the preprocessed pixels, indexed by the cell's top-left.
- **Crisp tiles**: `ctx.imageSmoothingEnabled = false` for the cell draws so
  pixel-art halftone PNGs blow up clean. Toggle restored after the loop.
- **No clip rect**: cells tile exactly, no overflow. Skipped the clip overhead.
- **Animation.** Reference is static. We sweep `gridDensityNumber` on a
  cosine pingpong (rounded to int, clamped 10..150). Denser mid-cycle reveals
  more cells; endpoint density is identical so the loop closes byte-equal.
- **No WebGL.** Default settings run at sub-millisecond median, 2.16 ms avg
  at 1280×720. Massive headroom under the 30 ms budget.

## Verification

Performed at 1280×720, default settings, via Playwright MCP:

- `WAEffect.renderAt(0)` byte-equal to `WAEffect.renderAt(1)` (`toDataURL`).
- `WAEffect.renderAt(0.5)` differs from both (anim is doing work).
- Idempotent: `renderAt(0)` after `renderAt(0.5)` returns same bytes.
- 20-sample render benchmark: median 0.80 ms, avg 2.16 ms, max 9.30 ms.
- Landing frame: visible mosaic of halftone tiles over the portrait sample;
  threshold=220 fills most of the subject.
- Image AND video sources both render (cycled through samples; clip.mp4
  rendered identically after `advanceFrame()`).
- Console clean (only the harmless `favicon.ico` 404).

## Divergences from the bundle (summary)

| area               | divergence                          | reason                                |
|--------------------|-------------------------------------|---------------------------------------|
| lightnessThreshold | 178 → 220                           | striking landing frame                |
| paint bg           | n/a → `bgColor` (paper-cream)       | gives the mosaic a frame              |
| animation          | none → density pingpong (15s)       | reference is static; we ship loops    |

Algorithmic body (cell layout, single-pixel sampling, alpha-composited
luminance, sorted-catalog index mapping, clamp floor) preserved exactly.
