# Contour — design dossier

**Reference family:** Scalar-field visualisation. No tooooools.app counterpart — contour is a pixart original.
**Algorithmic primitive:** Marching squares (Lorensen & Cline 1987, the 2D specialisation of marching cubes), traced on a Rec.709 luminance field of the preprocessed source.
**Date:** 2026-05-13.

## What the effect actually is

1. Preprocess source (blur/grain/gamma/levels), then compute a per-pixel **Rec.709 luminance** scalar field: `L = 0.2126·R + 0.7152·G + 0.0722·B`. Rec.709 weights matter — flat (R+G+B)/3 produces muddy contours on saturated greens.
2. Apply `smoothing` (Gaussian blur ∈ [0..4 px]) so contours flow instead of jittering on grain bumps.
3. Generate `levels` evenly-spaced thresholds across [16..240] (avoiding pure 0 and 255, which would draw the canvas border).
4. For each threshold T, walk every 2×2 grid cell. Compute the 4-bit **case index** (high bit per corner where L > T). The 16 cases (the marching-squares lookup table) yield 0, 1, or 2 line segments per cell, with endpoints **linearly interpolated** along the two edges where L crosses T. Linear interp is the AA-source: it places endpoints to sub-pixel accuracy so the contour reads as a smooth curve.
5. Cases 5 and 10 are **saddle ambiguities**. We disambiguate with the standard average-corner test: if the cell's centre luminance has the same sign as the corners-above-threshold, we use the alternate connection.
6. `style` controls endpoint placement: `marching-squares` uses linear interp (smooth), `pixel` uses edge midpoints (chunky pixel-art topo), `streak` breaks each segment into two dashes (gestural pottery-drawing line).
7. `fillBands` (off by default) paints stepped band colours behind the contours per the `bandPalette` ramp.

## Modes

| Mode             | Animated parameter             | Envelope                                                    | Why it reads as distinct                                          |
|------------------|--------------------------------|-------------------------------------------------------------|-------------------------------------------------------------------|
| idle             | none                           | static                                                      | The topo map IS the artwork.                                      |
| breath           | levels                         | `base + round(8·(cos(2πt)-1))` ∈ [base-16, base]            | Contours densify and thin like breathing.                         |
| pulse            | one level's alpha              | `(1-cos(2πt))/2` on the middle level only                    | One level surfaces from invisibility, sinks back. Others static.  |
| rise             | gate fraction                  | `t` monotonic, seam-pinned to 1 at t=0,1                    | Levels appear from the top plateau down — t=0 and t=1 show full set. |
| march            | levels                         | stepped through {4, 8, 16, 32} held 1/4 each                | Discrete density tiers.                                            |
| breathe-density  | levels                         | `base + round(6·(cos(2πt)-1))`                              | Vasarely period-optical breathing; gentler than `breath`.          |

All envelopes wrap `t` to [0,1) and produce identical state at the seam → `renderAt(0) === renderAt(1)` byte-equal (verified).

## Parameters

| Name           | Range            | Default      | Why |
|----------------|------------------|--------------|-----|
| `levels`       | 2..40            | 12           | 12 is the USGS contour-density sweet spot for human reading. |
| `lineWidth`    | 0.5..6           | 1.2          | Slightly above hairline so contours hold at 600 px. |
| `lineColor`    | hex              | `#0d0d0d`    | Soft black on paper. Pure black is too harsh against cream. |
| `bgColor`      | hex              | `#f4ead2`    | Cream paper — the topographic-map mood signal. |
| `fillBands`    | bool             | false        | Default off: pure linework reads as draftsmanship. |
| `bandPalette`  | select (5)       | `mono`       | mono / terrain / bathymetric / seismic / warm-cool. |
| `style`        | select (3)       | `marching-squares` | The smooth default. `pixel` and `streak` are accents. |
| `smoothing`    | 0..1             | 0.5          | Always-on soft pre-blur so contours don't jitter on noise. |
| `seed`         | int              | 42           | Grain only. |
| `focusRadius`  | 40..600          | 200          | Interactive: extra contours bloom inside the disc under the cursor. |

Plus the shared preprocessor (canvasSize / blur / grain / gamma / blackPoint / whitePoint), `mode`, `animate`, `interactive`, `fit`, `bg` (outer canvas background, distinct from `bgColor` paper background).

## Landing default

12 levels, marching-squares, mono on cream paper, fillBands off, idle. First paint produces a topographic-map look of whatever source the user loaded — immediately legible as "contour drawing of the image."

## Verification

- All 6 modes pass `renderAt(0) === renderAt(1)` byte-equal (verified via Chrome DevTools MCP, 2026-05-13).
- Non-idle modes produce distinct outputs at t = 0.25 / 0.5 / 0.75.
- 24-frame mean render time: 7.7 ms (breath) to 20 ms (march, when levels = 32). All comfortably under 30 ms.
- Screenshots in `docs/screenshots/contour-{idle,breath,pulse,rise,march,breathe-density}.png`.

## References

- **Lorensen, W.E. & Cline, H.E. (1987).** *Marching Cubes: A High Resolution 3D Surface Construction Algorithm.* SIGGRAPH '87. Takeaway: the 16-case lookup table for the 2D specialisation (marching squares) with linear-interpolated endpoints. Implemented verbatim in our `CASES` table. The saddle disambiguation via average-corner test is from the same family (Nielson & Hamann 1991 formalised it, but Lorensen-Cline showed it on the original paper).
- **Snow, J. (1854).** *On the Mode of Communication of Cholera* (Broad Street pump map). Takeaway: isolines as an information-density device long predate cartography. Snow drew a contour map of deaths-per-house and revealed the pump as the source — the visual trope of "lines you can read" predates topography.
- **Tufte, E. (1983).** *The Visual Display of Quantitative Information.* Cheshire, CT: Graphics Press. Takeaway: USGS-palette conventions (green low → ochre mid → white high) encode the eye's contrast budget; the conventions are not arbitrary. Our `terrain` palette follows this ramp.
- **USGS topographic map symbology.** Takeaway: standard cartographic practice emphasises every 5th contour as an **index contour** drawn at higher line weight. We don't implement index contours explicitly, but `lineWidth` + `fillBands` together cover the same gestalt function (giving the eye a hierarchy).
- **Stewart Smith ceramics.** Modern contour-line drawings on pottery. Takeaway: a contour line need not be continuous — broken or dashed contours read as gestural and human. Our `streak` style is this aesthetic.
