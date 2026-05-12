# Watercolor — research dossier

**Reference:** Non-photorealistic rendering (NPR) literature on watercolour, plus traditional / contemporary practice — Curtis et al. (SIGGRAPH '97), Bousseau et al. (Eurographics 2006), Hockney's iPad work, and the Japanese sumi-e tradition. No specific tooooools effect mirrored.
**Date:** 2026-05-13.

## What the effect is

A stylised watercolour-painting filter built as a multi-pass pipeline:

1. **Sobel-driven edge bleed** — strong luminance edges register as "paper bleeds". A wet-gradient floor (`60 - 50·wetness`) lets every edge bleed at high wetness, while a dry brush (`wetness=0`) only darkens the strongest contours. The darken factor itself is also wetness-modulated, mimicking how pigment pools more aggressively on wet paper.
2. **Tolerance-bounded mean smoothing** — 3×3 neighbour mean, but only neighbours within `±tolerance` of the centre's luminance contribute. This is the classic bilateral-filter trick (Tomasi & Manduchi, 1998), simplified to a fixed 3×3 kernel: it preserves edges while flattening interior tones the way pigment pools on damp paper. Tolerance is `5 + smoothing·75` luminance units.
3. **Wet rim** — along dark→light boundaries, the lighter side gets a small brightness bump. Approximates the pigment halo at a wash edge. Active only above `mag > 40` and only when `wetRim > 0`.
4. **Paper grain** — deterministic mulberry32 seeded from `paperSeed`. Multiplied in at strength `paperGrain·0.35`, mean preserved at 1 (no luminance drift).
5. **Palette LUT** — five named palettes (`natural`, `sepia`, `prussian-blue`, `ink-wash`, `gouache-pastel`). Luminance is preserved by sampling a 256-entry LUT at the post-smoothing luminance and lerping toward it by `tone`.

The cursor `focusRadius` attenuates `wetness` to zero locally — equivalent to dabbing a dry brush over a wet wash to sharpen detail under the pointer.

## Math — per pass

For each output pixel `(x, y)` at preprocessed luminance `lum[j]`:

```
localWet = wetness * (1 - max(0, 1 - d²/R²))   if inside cursor focus
mean = average over 3x3 neighbours where |lum[k] - lum[j]| < tol
edgeMagFloor = 60 - 50·localWet
if mag > edgeMagFloor:
    e = ((mag - edgeMagFloor) / 200) · edgeStrength
    out *= 1 - e·(0.45 + 0.35·localWet)
if mag > 40 and signedGrad > 0:
    out += (mag - 40)/215 · wetRim · 40
out *= 1 + (rng - 0.5)·paperGrain·0.35    [grain]
if palette ≠ natural:
    luminance = (R·299 + G·587 + B·114)/1000
    out = lerp(out, LUT[luminance], tone)
```

## Parameter table

| name | range | default | role |
|---|---|---|---|
| canvasSize | 100–1000 | 600 | preprocessor resample target |
| blurAmount | 0–10 | 0 | source softening |
| wetness | 0–1 | 0.4 | edge-bleed extent and depth |
| edgeStrength | 0–1 | 0.5 | outline darkness |
| smoothing | 0–1 | 0.6 | interior flatness (bilateral tolerance) |
| paperGrain | 0–1 | 0.35 | grain multiplier |
| paperSeed | 1–99 | 1 | deterministic grain plate |
| palette | select | `natural` | LUT remap |
| tone | 0–1 | 0.4 | strength of palette mapping |
| wetRim | 0–1 | 0.2 | rim glow along dark→light edges |
| focusRadius | 40–600 | 180 | cursor dry-brush radius |
| mode | select | `breath` | animation envelope |
| bg | hex | `#f7f1e3` | warm paper white background |

The default background is a warm paper white, not the pixart-standard dark — a watercolour on a black canvas reads wrong. Users can override.

## Mode table

| mode | envelope | animated params | perceptual hook |
|---|---|---|---|
| **idle** | constant | none | the static painting |
| **breath** | `(1-cos(2πt))/2` cosine pingpong | `wetness` | the painting breathes wet ↔ dry |
| **bloom** | `t<0.2 ? t/0.2 : (1-(t-0.2)/0.8)^2.5` | `wetness` and `edgeStrength` together | a drop hits the page: outlines darken momentarily, paper darkens, then slowly dries |
| **march** | stepped through 4 paper seeds [1, 7, 19, 53] | `paperSeed` | same painting, four different papers cycle past |
| **dry** | cosine pingpong inverted on wetness, paired on edge | `edgeStrength`, `wetness` | the painting dries as you watch — wet edges at seam, brittle outlines at midpoint |
| **wash** | cosine pingpong on `smoothing` and a slow grain-seed walk | `smoothing`, `paperSeed` | broad wash → tight detail → broad wash |

**Landing default** is `breath` mode at wetness=0.4, edgeStrength=0.5, smoothing=0.6, paperGrain=0.35, palette=`natural`, tone=0.4 — produces a recognisable watercolour-paint look without over-stylising.

## Perceptual hook

1. **Bilateral mean as cheap watercolour wash**. A true bilateral filter is `O(W·H·k²·k_range)`; the watercolour effect needs only a *visual* approximation, not a true bilateral. A tolerance-bounded 3×3 mean costs `O(W·H·9)` and reads as a wash because the human visual system is forgiving of interior smoothness (Hockney's lesson: brushstrokes need only suggest, not describe).
2. **Edge bleed scaled by wetness**. Dropping the gradient-magnitude threshold as wetness rises (instead of only scaling the darkening strength) is what makes the cursor "dry brush" effect physical — a dry brush refuses to bleed at all but still draws outlines, exactly mirroring the experiment of dabbing a tissue on wet pigment.
3. **Wet rim**. The bright halo on the lighter side of a dark→light edge is a Mach-band cousin: real watercolour leaves pigment at the receding edge of a wash, brightening the *next* pixel slightly. We approximate via `signedGrad > 0` and add a luminance bump. Reads as "this was painted, not filtered".

## References

1. **Curtis, C. J. et al. (1997)**. *Computer-Generated Watercolor*. SIGGRAPH '97. The seminal paper — three Kubelka-Munk pigment passes simulate the physical layering of wet pigment. Our pipeline trades the KM passes for a single mean smooth + edge bleed, capturing the perceptual signature at <5% the cost. **Takeaway:** wet-on-wet pigment pooling can be approximated by edge-aware smoothing.
2. **Bousseau, A. et al. (2006)**. *Interactive Watercolor Rendering with Temporal Coherence and Abstraction*. Eurographics 2006. Their *edge-darkening* and *pigment-density* tricks inform our wet-rim and edge-bleed passes. **Takeaway:** edge-darkening must be magnitude-thresholded, not blanket, or the whole frame turns muddy.
3. **David Hockney — *iPad paintings*** (2010+, "A Bigger Picture" series). The brush-stroke economy school — radically flattened interior tones, loose outlines. Informs the `smoothing=0.6` default and the willingness to let `wetRim` brighten beyond the source value. **Takeaway:** the eye reads "watercolour" from very few cues if those cues are correct.
4. **Sumi-e tradition (Sesshū Tōyō, 15th-c.) and contemporary stylised work (David Lewandowski)**. Wet-rim contrast as a narrative emphasis. **Takeaway:** rim brightness is a deliberate aesthetic choice in Eastern ink painting, not a side effect — exposing it as a slider honours the tradition.

## Performance notes

At canvasSize=600 (W·H ≈ 360k pixels):
- preprocessor: ~4 ms
- luminance precompute: 1 linear walk, ~1 ms
- bilateral mean + Sobel + rim + grain + palette LUT (fused inner loop): ~7 ms
- paint: ~2 ms

Measured 24-frame sweep: **13.2–13.9 ms / frame** mean across all six modes. Under the 30 ms budget with headroom. Memory: one Float32Array (lum) + one Float32Array (grain buffer) + one ImageData (output) — proportional to canvas area, no growth.

## Verification (2026-05-13, http://localhost:8001/watercolor/, image source)

| Mode   | seam byte-equal | distinct at t={0,0.25,0.5,0.75} | mean ms |
|---|---|---|---|
| idle   | ✓ | 1 (intentional) | 13.5 |
| breath | ✓ | 3 (pingpong symmetry) | 13.5 |
| bloom  | ✓ | 4 | 13.6 |
| march  | ✓ | 4 | 13.5 |
| dry    | ✓ | 3 (pingpong symmetry on inverse) | 13.8 |
| wash   | ✓ | 4 | 13.2 |

Video source (clip.mp4 via `PIXSource.cycleSample`): renders without error at t=0.3. Per the framework contract, byte-equal endpoints are only guaranteed on image sources.

Screenshots in `docs/screenshots/watercolor-<mode>.png`.

## Notes for the next maintainer

- The grain buffer is allocated per build; if you make the build run-faster path matter, hoist it to a module-level Float32Array and only reseed when `paperSeed` changes.
- `wetRim` is intentionally conservative (default 0.2). At >0.6 the rim becomes the dominant feature and the painting reads as "neon outlined" rather than "watercolour". The slider goes to 1.0 because users will want it; the default is where the eye reads "watercolour".
- The default `bg` colour is `#f7f1e3` (warm paper white) — every other effect ships dark. If you reuse this dossier as a template for a similar NPR effect, decide first whether the background is part of the artwork.
- The bilateral mean uses a 3×3 stencil for speed. A 5×5 stencil at the same tolerance produces a measurably more "watercolour-like" wash but costs ~3× more. Worth the upgrade if performance budget grows.
