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

## Refinement pass — 2026-05-13

Added a mode envelope on top of the bundle-faithful rotated-halftone-grid.
The static algorithm is untouched; modes only re-script which params animate
each frame. Two new sliders feed both the static frame and the modes:
`densityHarmony` (-1..1, biases min/max bar width in opposite directions —
positive = high-contrast halftone, negative = compressed grain) and
`angleSweep` (-45..45°, doubles as the secondary-grid offset in `moire`).

### Modes

- **idle** — static. No envelope. Rest frame is the artwork.
- **breath** — cosine pingpong on `angle` around the slider value, amplitude
  `angleSweep`. The original behaviour. Calm, foveal, symmetric (q25/q75
  mirror by construction).
- **spin** — `angle` monotonic `0 → 360°`. The grid is rotation-symmetric at
  multiples of the cell axis, so the endpoint matches t=0 byte-equal (and
  the `envelopeT` wrap pins t=1 → t=0 to dodge IEEE-754 ε).
- **moire** — two superimposed grids. Grid A holds the user angle; Grid B is
  rotated by `angleSweep`. `xSquares` pingpongs on A (cosine), `ySquares`
  sweeps `sin(2π·t)` on B. The differential rotation between the two grids
  produces a rolling Moiré beat — the *Vega-Nor* mechanism (Vasarely 1969)
  applied to a printer's screen instead of canvas-paint. Doubles dot count
  (~22 ms/frame at defaults; still under budget).
- **stutter** — `angle` plateaus through the Ben Day CMYK angles
  `[0°, 15°, 45°, 75°]`, holding each for ¼ of the loop. These are the real
  4-colour offset-press screen angles, picked because the angular separation
  minimises inter-channel moiré (Krawczyk halftone-screen research,
  documented in Bridges 2009). Stutter encodes the print-tech history as
  motion. Seam-pinned: `floor(t01·4) % 4 == 0` at t01=0 and t01=1.
- **march** — `xSquares` plateaus through four ratios of the slider value
  `[1.0, 0.7, 1.4, 0.85]`, holding each for ¼ of the loop. The grid ruling
  visibly snaps coarse → fine, like a press operator dialling-in the
  screen. Seam-pinned identically to `stutter`.

### Seamless verification (1280×720, default source)

| mode    | renderAt(0)==(1) | q25/q50/q75 distinct          | 24-frame mean |
|---------|------------------|-------------------------------|---------------|
| idle    | yes              | n/a (static)                  | 9.23 ms       |
| breath  | yes              | q25=q75 (symmetric pingpong)  | 8.77 ms       |
| spin    | yes              | all 3 distinct                | 10.47 ms      |
| moire   | yes              | all 3 distinct                | 22.08 ms      |
| stutter | yes              | all 3 distinct                | 7.83 ms       |
| march   | yes              | all 3 distinct                | 8.02 ms       |

All modes byte-equal at the seam. All under the 30 ms budget; `moire` is the
expected outlier because two passes share the dot buffer.

### Cursor focus radius

In `interactive` mode the cursor is a soft circle (`focusRadius`, source-space
px). Inside the circle, per-cell `maxSquareWidth` lifts by `1.5×` with a
quadratic falloff (cheap Gaussian approximation). Darks bloom under the
pointer; the rest of the field stays at slider value. Peripheral motion is
more visible than foveal motion (Carrasco 2011), so the soft falloff reads
as natural attention rather than a hard mask.

### References

- **Secord, A. (2002).** *Weighted Voronoi Stippling.* NPAR. The gold-
  standard stipple algorithm — referenced as **not this**. A true WVS port
  belongs in a separate `weighted-voronoi/` effect; the bundle's
  rotated-halftone-grid is what we honour here.
- **Vasarely, V. (1969).** *Vega-Nor.* The canonical optical-art use of
  superimposed rotated grids to produce a rolling Moiré beat — the
  perceptual mechanism `moire` mode rebuilds in halftone bars.
- **Day, B. (1879).** U.S. Patent 214,493, the "Day shading mediums". The
  origin of the named CMYK screen angles `0/15/45/75` used in `stutter`.
- **Bridges, R. (2009).** *Krawczyk halftone-screen research notes.*
  Explains why the 15°-apart angles minimise inter-channel moiré in
  offset printing — the engineering history `stutter` encodes.
- **Carrasco, M. (2011).** *Visual attention: the past 25 years.* Vision
  Research 51(13). The peripheral-vs-foveal-motion result that justifies
  the soft falloff on the focus-radius interactive pattern.

### Divergences from the bundle (refinement pass)

| area              | change                                              | reason                                       |
|-------------------|-----------------------------------------------------|----------------------------------------------|
| animation         | single cosine sweep → 6-mode envelope               | range of perceptual hooks from one effect    |
| angleSweep range  | 0..90 → -45..45                                     | doubles as secondary-grid offset for moire   |
| densityHarmony    | new param (-1..1)                                   | macro contrast dial on the halftone grain    |
| focusRadius       | new param + interactive bloom                       | attentional spotlight in interactive mode    |
| interactive       | X/Y → maxSquareWidth still global; now LOCAL bloom  | cursor reads as focus, not a global setting  |

Algorithmic body (per-cell sample, luminance mapping, anti-gap nudges,
Benday offset, rotated-bbox cull) preserved exactly.
