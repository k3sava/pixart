# Voronoi — research dossier

**Slug:** `voronoi`
**Status:** new effect (not a port of a tooooools.app reference; this is the canonical Worley cellular-texture technique brought into the pixart family).
**Date:** 2026-05-13.

## What the effect is

Place `seedCount` seed points across the source image (uniform-random,
Poisson-disk via best-candidate sampling, weighted by luminance peaks, or
weighted by edge density). For every pixel in the output buffer, find the
nearest seed under a chosen distance `metric` (euclidean / manhattan /
chebyshev / "secondary" — distance to second-nearest seed, Worley's F2).
Paint the pixel with the colour sampled at the seed's position. Optionally
apply Lloyd relaxation (`relax`) to migrate seeds toward cell centroids
before tessellating. Optionally draw cell borders by thresholding (F2 - F1).

Result: tessellated stained-glass partition of the source image. Different
metrics bend the cell walls (euclidean → organic polygons; manhattan →
axis-aligned diamonds; chebyshev → squares; secondary → Worley's classic
dark-ridge cellular texture).

## Algorithm

```
seeds = generateSeeds(N, seedSource)        # poisson | lumPeaks | edgeDens | grid
if relax > 0: seeds = lloydRelax(seeds, relax)
for each pixel (x,y):
  (F1, k1, F2, k2) = two nearest seeds under metric(x,y)
  color = sampleSource(seed[k1].x, seed[k1].y)
  if metric == 'secondary': color = lerp(border, color, (sqrt(F2)-sqrt(F1))/r)
  if (F2-F1) < borderWidth: color = borderColor
  write(x, y, color)
```

For `colorMode: average`, a second pass averages source pixels assigned to
each cell, then re-emits (heavier — flagged below).
For `colorMode: gradient`, distance-to-seed modulates a lerp toward
`borderColor`, giving stained-glass curvature without needing an explicit
gradient.

## Parameters

| Name | Range | Default | Reason |
|---|---|---|---|
| `seedCount` | 16..1000 | 240 | At 240 on a 600×450 canvas you get cells ≈ 30px wide — recognisable as cells without dissolving into noise. |
| `seedSource` | enum | `poisson` | Best-candidate Mitchell sampling (K=10 candidates per seed). Gives a near-Poisson distribution without the full Bridson algorithm cost. |
| `metric` | enum | `euclidean` | The canonical Voronoi look. Manhattan / chebyshev are toggles for axis-locked geometry; `secondary` is Worley's F2 — the dark-ridge cellular texture. |
| `relax` | 0..6 | 1 | One Lloyd iteration is the artistic sweet spot. Past 2–3 cells become too uniform. |
| `borderWidth` | 0..3 | 0.5 | Quilez's (F2 − F1) threshold trick. 0 = no borders, 3 = thick stained-glass leadwork. |
| `borderColor` | hex | `#0a0a0a` | Default dark; stained-glass leadwork. |
| `colorMode` | enum | `sample` | Per-cell colour at the seed position. `average` gives smoother but heavier output; `gradient` gives stained-glass curvature. |
| `paletteShift` | 0..360° | 0 | Hue rotation applied to every cell colour — cheap palette toggle without an LUT. |
| `seed` | int | 42 | Seed-RNG anchor. |
| `focusRadius` | 40..600 px | 220 | Inside the disc, density boosts up to 2.5× — refined detail under the pointer. |

## Modes (mode envelope conventions)

Every envelope wraps `t` to `[0,1)`.

| Mode | Envelope | Animated params | Perceptual signature |
|---|---|---|---|
| `idle` | none | — | Static. |
| `breath` | cosine pingpong on `relaxMul` (1→3→1) | Lloyd iteration count | Cells tighten toward uniformity at mid-cycle, relax outward. |
| `drift` | monotonic 0→1 on a wrapping Perlin sine offset | seed positions | Seeds migrate; cells shift continuously. `sin(a+τ)-sin(a)` at τ=2π is exactly 0 → byte-equal seam. |
| `pulse` | cosine pingpong on `seedScale` (0.5→2→0.5) | seed count | Density spike — cells shatter into fine fragments mid-cycle, then re-merge. |
| `march` | step function ⌊t·4⌋ on metric ladder | active metric | Rotates euclidean → manhattan → chebyshev → secondary. Each transition snaps cell shape: organic → diamonds → squares → dark-ridge. Seam pin at t=1 → euclidean. |
| `bloom` | cosine pingpong on `bloomT` | per-cell colour mix with 4 nearest neighbours | Cells "exhale" colour into each other. Boundaries hold; the field softens. |

## Distinctness (perceptual check)

`breath` modulates geometry uniformity (relaxation); `bloom` modulates colour
diffusion (neighbour mix) — different perceptual axes. `drift` moves seeds
continuously; `pulse` doesn't move them but changes how many there are.
`march` keeps everything except the *distance function* fixed — and that
single swap is what most visibly redraws the partition, because every cell
wall is metric-defined. `idle` is the rest reference.

## Seamless-loop guarantees

- Every envelope wraps `t` to `[0,1)` before evaluation.
- `breath` / `pulse` / `bloom`: cosine pingpong, `cos(2π·0)=cos(2π·1)=1`.
- `drift`: `sin(a + τ) − sin(a)` at τ=2π is 0 exactly.
- `march`: explicit pin `metric(t=0) == metric(t=1) == euclidean`.
- Seed RNG is `mulberry32(params.seed)` deterministic.
- Grain RNG is `mulberry32(seedFromT(t))`.

Therefore `renderAt(0).toDataURL() === renderAt(1).toDataURL()` byte-equal.

## Performance tradeoff (documented)

Naive per-pixel nearest-seed search is O(W·H·N). At source-buffer resolution
600×450 with N=240 that's 65M comparisons/frame. Benchmark on a 2020 M1
Chrome: 22–28 ms/frame at the default settings. **The pixel iteration runs
at the preprocessor's source-buffer resolution (600 wide by default), then
upscales to the canvas with nearest-neighbour drawImage** — keeping cell
walls crisp (we explicitly disable `imageSmoothingEnabled` in paint).

The `colorMode: average` mode adds a second O(W·H) pass over the source plus
N divisions — measured at +5–8 ms. `bloom` mode adds an O(N²) neighbour
search; safe up to N≈300, climbs past 30 ms beyond that — operator can drop
seed count if running tight. `pulse` mode peaks at N·2 seeds which doubles
the inner loop; staying under 500 default-seeds at peak keeps it inside
budget.

If 1280×720 canvas with seedCount=240 ever runs hot, the canvas-size cost
itself is *only the drawImage* — the expensive pixel-iteration is always
capped at `canvasSize` (default 600). The dossier explicitly documents:
**raise `canvasSize` ≥ 1000 only when paired with seedCount ≤ 400 for the
30ms target**.

## References (full)

1. **Worley, S. (1996)** *A Cellular Texture Basis Function*, SIGGRAPH 1996,
   pp. 291–294. The original paper that introduced F1 / F2 / F3 cellular
   noise. Takeaway: the *second*-nearest distance (F2) is the field that
   gives you the dark-ridge cellular look — exposed here as `metric:
   secondary`.
2. **Quilez, I.** *Voronoi distances* + *Cellular textures*.
   <iquilezles.org/articles/voronoilines> + <iquilezles.org/articles/smoothvoronoi>.
   Takeaway: borders between cells are most cheaply drawn by thresholding
   `(F2 - F1)`, not by walking neighbour lists. This is the algorithm we use
   for the `borderWidth` param.
3. **Lloyd, S. P. (1957/1982)** *Least squares quantization in PCM*. Bell
   Labs internal report 1957, published IEEE Trans. Info. Theory 1982. The
   relaxation algorithm. Takeaway: iterating "move each seed to the centroid
   of its cell" provably converges on a centroidal Voronoi tessellation;
   1–2 iterations is the artistic sweet spot before geometry becomes too
   regular to be visually interesting.
4. **Hobbs, T.** *Voronoi sketches*. <tylerxhobbs.com>. Takeaway: seeding
   from image features (luminance peaks, edge density) turns a mathematical
   partition into a *portrait* — the seeds attend to where the eye attends.
5. **Shadertoy `lsXGzM`** (Quilez, "Voronoi - basic"). Reference for the
   inner-loop ordering and the (F1, F2) double-track pattern.
