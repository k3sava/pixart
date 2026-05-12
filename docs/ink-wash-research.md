# Ink-wash — reference dossier

Sumi-e (墨絵) stylisation. The monochrome, calligraphic cousin of
`pixart/watercolor`. Where watercolor preserves region colour and paint
diffusion, ink-wash is one ink, one paper, one gesture — Sesshū, not
Curtis-Anjyo-Salesin.

## What it is

A four-pass stylisation:

1. **Edge detect** — Sobel 3×3 on BT.601 luminance. Magnitude is kept as
   Float32 so the stroke-thickness map has the dynamic range it needs
   to fade smoothly at the dry-brush ends.
2. **Stroke render** — at every Sobel pixel above a base threshold
   (~40 magnitude), drop a soft ink circle whose radius scales with
   `brushPressure × normalised_magnitude` and whose alpha scales with
   `inkDensity × dry-brush-curve(mN)`.
3. **Bleed** — copy the ink layer, gaussian-blur it by `bleed` px, lay
   it back **under** the strokes (`destination-over` at 0.55 alpha).
   This is the rice-paper soak: the halo around darks.
4. **Paper** — value-noise grain tinted with `inkColor`, alpha-masked
   so only fibres above a threshold (~0.55) appear. Deterministic with
   `mulberry32(seed)`.

## Why edges, not segmentation

Real sumi-e abstracts contour, not region. Edges are the most honest
computational proxy for "where would the brush go" and they cost one
linear pass. A region-based stroke planner (Hertzmann '98, Litwinowicz
'97) would need a stable RNG for stroke ordering AND a region-stable
sort even after re-rendering — too many failure modes for the byte-equal
loop contract. Cao et al. (Pacific Graphics 2006) reach the same
conclusion: edges drive strokes, paper texture does the rest.

## Why monochrome

Watercolor (`pixart/watercolor`) is the sibling that keeps colour and
models pigment diffusion. Ink-wash is the artistic *negation* of that —
one ink, gestural, calligraphic. Adding hue would betray the form. The
warmth comes from the *paper*, not the ink. Four canonical paper tones
ship as `paperType`: kozo (warm cream), mulberry (cool ivory), gampi
(pale gold), bamboo (yellower kraft) — calibrated by eye against real
washi under tungsten light.

## Parameter reference

| Param           | Range      | What it does                                                  | When to touch                              |
|-----------------|------------|----------------------------------------------------------------|---------------------------------------------|
| `mode`          | enum       | Animation envelope; see modes below                            | Pick the temporal motif                     |
| `inkColor`      | hex        | Brush colour                                                   | `#0d0d0d` reads as sumi; tint for variants  |
| `paperColor`    | hex        | Paper tone                                                     | Auto-overridden by `paperType`              |
| `paperType`     | enum       | Named papers: kozo / mulberry / gampi / bamboo                 | Set the warmth register                     |
| `brushPressure` | 0..2       | Global stroke thickness multiplier                             | Crank for bold, drop for wispy              |
| `inkDensity`    | 0..1       | Alpha of strokes at peak magnitude                             | Drop for "wet" feel                         |
| `bleed`         | 0..30      | Gaussian halo radius around strokes                            | Bigger = wetter paper                       |
| `dryBrush`      | 0..1       | Magnitude-extreme falloff (tip & root fade)                    | 0 = uniform stroke; 1 = wisps               |
| `paperGrain`    | 0..1       | Stochastic paper-texture overlay alpha                         | Off for plastic; up for fibre               |
| `seed`          | 1..9999    | Paper-grain RNG seed                                           | Cycle to try different sheets               |
| `focusRadius`   | 40..600    | Cursor sharpening radius (interactive)                         | Bret-Victor focal lens                      |

## Mode envelope

All modes wrap `t` to `[0,1)` first; all are byte-equal at the seam.
Only the named parameters animate; others hold at slider.

| Mode    | Envelope                                  | What animates                          | Seam      |
|---------|--------------------------------------------|----------------------------------------|-----------|
| idle    | constant                                   | nothing                                | trivial   |
| breath  | cosine pingpong                            | `brushPressure` × 0.65..1.35           | cos(0)≡cos(2π) |
| flick   | 4-stop sawtooth                            | `brushPressure` × [1.0,1.6,0.8,1.3]    | t=1 → step 0 |
| seep    | cosine pingpong                            | `bleed` × 0.4..2.0; `inkDensity` × 0.85..1.0 | cos seam |
| march   | 4-stop ladder, named papers                | `paperColor` ∈ {kozo,mulberry,gampi,bamboo} | t=1 → step 0 |
| dry     | cosine pingpong (re-wet at midpoint)       | `inkDensity` 0..1..0; `bleed` 0.2..1.6 | cos seam |

`dry` is conceptually a monotonic "the painting dries" — but a strict
0→1 ramp wouldn't satisfy byte-equal at the seam. We implement it as a
pingpong (dry then re-wet) so the loop closes, and the reading is still
honest: "the painting evolves through wetness states".

## Perceptual hook

The combination that lands the sumi-e identity on first paint is
**dry-brush + bleed + warm paper**. Drop any one of the three and the
effect collapses into edge-detection-with-grain (no bleed), or
hard-edge ink (no dry brush), or sterile mono on white (no paper
warmth). The three together produce a stroke whose tip fades into wet
paper haze on warm cream — which is the Sesshū look.

## References (1-line takeaways)

1. **Sesshū Tōyō, *Haboku-Sansui* (1495)** — defines the visual target:
   economy of stroke, dry brush at edges, ink bleeding into wet paper.
   We literally aim for this image's stroke distribution.
2. **Hokusai, *Manga* (1814-1878, 15 vols)** — line economy as a system;
   confirms that contour-only abstraction (no shading) is sufficient to
   carry subject identity. This is the brief for an edge-driven NPR.
3. **Cao Jian, Pao K-Y, Singh Karan, *Stylized Ink Painting Rendering*
   (Pacific Graphics 2006)** — algorithmic primer for the edge → stroke
   → bleed pipeline. Confirms a single Sobel pass + halo blur reaches
   recognisable sumi-e without region segmentation.
4. **Curtis, Anderson, Seims, Fleischer, Salesin, *Computer-Generated
   Watercolor* (SIGGRAPH 1997)** — the sibling pipeline; we explicitly
   diverge by going monochrome. Worth reading for the diffusion math
   we deliberately omit.
5. **Bret Victor, *Drawing Dynamic Visualizations* (Stanford HCI 2013)**
   — cursor as a focal-point that sharpens. Informs the wet-brush-dab
   focus interaction. The local-suppression-of-bleed idea is his.

## Performance

- 600² preprocessed buffer.
- Sobel: one linear pass with a scratch luma buffer (9 reads/pixel × 1
  output) → ~3.5ms.
- Stroke render: O(W·H) early-out at the threshold gate; ~6-12ms typical
  at the default threshold and pressure.
- Bleed: one canvas `filter: blur(N)` pass + one `destination-over`
  composite → ~6ms at `bleed=8`, ~12ms at `bleed=24`.
- Paper grain: per-pixel mulberry32 + ImageData put — ~6ms; pre-tinted
  RGBA inside `createImageData` then drawn via a tmp canvas.
- Measured per-mode mean across 24 frames (M-class Mac, 1280×720
  output canvas): see "Verification" table below.

## Verification — browser, 2026-05-13

`python3 -m http.server 8001` → `http://localhost:8001/ink-wash/`.

| mode    | seam byte-equal | t=.25/.5/.75 distinct | mean ms/24f |
|---------|------------------|------------------------|-------------|
| idle    | ✓                | n/a                    | 28.2        |
| breath  | ✓                | ✓                      | 24.3        |
| flick   | ✓                | ✓                      | 23.4        |
| seep    | ✓                | ✓                      | 28.3        |
| march   | ✓                | ✓                      | 24.3        |
| dry     | ✓                | ✓                      | 25.0        |

All under the 30ms/frame budget. Screenshots at
`docs/screenshots/ink-wash-<mode>.png`.

Determinism: when grain is non-zero, `_rng = mulberry32(seedFromT(t) +
seed)` during preprocess, then restored to `Math.random`. Paper-grain
canvas is rebuilt deterministically inside `renderInkAndBleed`. Sobel
and stroke compositor are pure. Therefore `renderAt(0) === renderAt(1)`
byte-equal in every mode.
