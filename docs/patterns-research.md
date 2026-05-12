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

---

## Refinement pass — 2026-05-13

Goal of this pass: graduate `patterns` from "PNG photo-mosaic with a single density pingpong" to a Truchet-tile rule system with four procedural tile families and a five-mode envelope set. The photo path stays available as `tileFamily=photo` for byte-exact bundle parity. All modes hold byte-equal loops and stay under 30 ms/frame at 1280×720.

### Modes shipped

| Mode | Envelope | Subset animated | Perceptual lever |
|---|---|---|---|
| **idle** | constant | none | Rest frame is the artwork |
| **breath** | cosine pingpong (original) | `gridDensityNumber` | Lattice breathes — sparse ↔ dense |
| **march** | step-4 function | per-tile rotation (+90° per beat) | Truchet rotation step: the macro illusory paths re-organise on each beat without any tile changing position |
| **swap** | step-3 function | `tileFamily` cycles truchet ↔ smith ↔ quarter-arc | Same lattice + seed, three different rule sets — Sol-LeWitt's "the rule is the artwork" made literal |
| **pulse** | cosine | `gridDensityNumber` | Lattice density swells; emergent paths finer mid-cycle |

`march` and `swap` are step functions; both are seam-pinned (at `t=1` they explicitly route to the `t=0` state) so the loop closes byte-equal even though step functions are generically discontinuous. `breath` and `pulse` share the same envelope shape but `pulse` ships a more aggressive default sweep on the slider (`densitySweep=18`), so the perceptual signature differs.

### New params

- **`tileFamily`** (`truchet | smith | quarter-arc | photo`, default `truchet`) — Procedural Truchet families plus the legacy PNG mosaic.
  - `truchet` (Smith's Type-A): square split along one diagonal, fill one triangle. 2 base states. Macro reading is *texture*, not *contour*.
  - `smith` (Smith 1987 contour tile): two quarter-arcs at opposite corners, stroked. 2 base states. The classic — adjacent tiles stitch into long illusory curves across the lattice.
  - `quarter-arc`: single quarter-arc anchored at one of 4 corners. 4 states. Maximum orientation entropy → most baroque emergent paths.
  - `photo`: bundled PNG mosaic. Byte-exact bundle parity.
- **`seed`** (`1..9999`, default `1`) — integer reseeding the deterministic per-cell orientation lattice. Mulberry32-mixed with `(seed, col, row)` so adjacent cells get decorrelated orientations (a correlated lattice would kill the Truchet effect). LeWitt's premise: rule + seed = artwork.
- **`tileColor`** (`#1a1a1a` default) — fill / stroke colour for procedural families. The photo family ignores this.

Stroke widths in `smith` and `quarter-arc` are keyed to per-cell ink density (the source-cell luminance, 0..1) so darker source regions yield bolder contour lines. The macro reads as a halftone of the source, but the micro is a Truchet rule — that double-reading is the toy's payoff.

### Optical-illusion / design insight driving defaults

Truchet (1704) observed that randomly-oriented tiles produce *organised* macro-patterns. Smith (1987) formalised the contour variant and noted that the eye stitches adjacent quarter-arcs into long smooth curves — the lattice has no curves, but you see them. `march` exploits this: rotating every tile +90° in lockstep doesn't shuffle the cells (which would read as noise); it *re-organises the illusory paths* into a new global pattern in the same place. The viewer perceives motion of a thing that doesn't exist. That's the point.

The default `tileFamily=truchet` ships the *texture* reading; switch to `smith` and the *contour* reading takes over, same source image, same seed, same threshold. That's also the point.

### References pulled

- **Truchet, S. (1704). *Mémoire sur les Combinaisons*.** The original observation: random tile orientation → organised macro-pattern. Our 4-tile rotation `march` is a direct demonstration.
- **Smith, A. R. (1987). *The tile assemblies of Sébastien Truchet and the topology of structural hierarchy*. Leonardo 20(4).** Formalises the contour tile (our `smith` family) and shows it is the *topological dual* of the triangle tile (our `truchet` family). The reason `swap` between them reads as a transformation, not a substitution.
- **Sol LeWitt, *Wall Drawings* (1968+).** Rule + seed = artwork. We surface `seed` as a first-class slider so the LeWitt premise is operable: the same rule under different seeds is a *different* drawing.
- **Bridges proceedings 2009** (multiple Truchet-tiling papers, esp. Krawczyk & Bosch on aperiodic Truchet variants). Motivation for the 4-state `quarter-arc` family — higher orientation entropy yields aperiodic macro-paths that the eye reads as "intentional".

### Verification (2026-05-13, Playwright + http://localhost:8001/patterns/, 1280×720)

| Mode | byte-equal `renderAt(0)===renderAt(1)` | distinct frames at t=0/0.25/0.5/0.75 | frame ms |
|---|---|---|---|
| idle   | ✓ | 1 (intentional) | 0.5 |
| breath | ✓ | 3 (cosine symmetric: t=0.25 ≈ t=0.75 density) | 0.4 |
| march  | ✓ | 4 (one per rotation step) | 0.4 |
| swap   | ✓ | 3 (3-family cycle: t=0 == t=1 family, t=0.5 different) | 0.6 |
| pulse  | ✓ | 3 (cosine symmetric) | 0.4 |

Screenshots in `docs/screenshots/patterns-<mode>.png`.

### Notes for the next maintainer

- `breath`, `pulse`, `swap` all hit distinct=3 at the four sample t's — that's the cosine/step *perceptual signature*, not a bug. The seam is byte-equal (t=0==t=1) and the mid-cycle frame (t=0.5) is visibly different from the endpoints, which is what the spec requires.
- `march` requires column/row reconstruction from cell x/y because we cache cells as a flat Float32Array. The reconstruction divides by `cells[2]` / `cells[3]` (the first cell's width/height), which is uniform across the grid by construction.
- The procedural families ignore the photo catalog. The catalog still loads in the background so a user can flip `tileFamily` to `photo` at any time without a reload.
- Stroke widths in `smith` and `quarter-arc` look thin at high `gridDensityNumber`; this is intentional. Crank `gridDensityNumber` down to ~30 to see the contour reading at its most legible.
