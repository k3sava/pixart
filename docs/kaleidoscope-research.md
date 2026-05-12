# Kaleidoscope — design dossier

**Reference family:** UV-warp siblings of `distort`. No tooooools.app counterpart — kaleidoscope is a pixart original.
**Algorithmic primitive:** N-fold polar fold with optional mirror reflection on alternate wedges. Equivalent to Brewster's two-mirror kaleidoscope (mirrors at angle π/N) projected into a sampling kernel.
**Date:** 2026-05-13.

## What the effect actually is

For each output pixel (x, y):

1. Compute Cartesian offset from canvas centre: (dx, dy) = (x - W/2, y - H/2).
2. Polar: r = √(dx² + dy²); θ = atan2(dy, dx) + angleOffset.
3. Fold θ into the wedge [0, 2π/N) via `θ mod 2π/N`. If `mirror` is on, reflect alternate slices (`θ' = wedge - θ` on odd slices) so the seam is continuous and the mirrors join.
4. Map back to source space: sx = ox + r·cos θ'; sy = oy + r·sin θ', where (ox, oy) is the polar origin (canvas centre, optionally offset by `sampleX`/`sampleY`).
5. Sample preprocessed source at (sx, sy), wrapped toroidally so high zoom doesn't leave black halos.
6. If `recurseDepth > 0`, re-fold the result coordinate D more times with a bias half-wedge added between folds. Fractal kaleidoscope.

The effect is a pure spatial filter on a per-pixel basis — like `distort`, but the warp is computed from polar math rather than sampled from an image. No randomness in the core path (grain is the only randomness, and it is mulberry32-seeded per loop fraction).

## Modes

| Mode    | Animated parameter            | Envelope                                                   | Why it reads as distinct                                      |
|---------|-------------------------------|------------------------------------------------------------|---------------------------------------------------------------|
| idle    | none                          | static                                                     | Rest frame is the artwork.                                    |
| breath  | segments                      | `base + round(4·(cos(2πt) - 1))` ∈ [base-8, base]          | N changes continuously; the petal count "breathes".           |
| spin    | angleOffset                   | `angleOffset + t·2π` (monotonic)                           | Whole pattern rotates exactly one turn; 2π ≡ 0 → seam closes. |
| pulse   | zoom                          | `base · (1 + 0.8·env(t))` with sharp-attack envelope        | Radial zoom in, slow out. Reads as the cell "inhaling".       |
| march   | segments                      | stepped through {4, 6, 8, 12} held 1/4 each, seam-pinned   | Discrete N changes — quartet of fold counts.                  |
| recurse | recurseDepth                  | pingpong stepped 0 → target → 0                            | Fractal recursion blooms; the fold inside the fold appears.   |

All envelopes wrap `t` to [0,1) and force exact `t=0` state at the seam → `renderAt(0) === renderAt(1)` byte-equal (verified).

## Parameters

| Name           | Range          | Default     | Why |
|----------------|----------------|-------------|-----|
| `segments`     | 2..32          | 8           | Classic Brewster kaleidoscope is 6- or 8-fold; we pick 8. |
| `angleOffset`  | -π..π          | 0           | Rotates the fold pattern. Spin animates this. |
| `mirror`       | bool           | true        | Brewster's actual instrument has mirrors; rotation-only (off) reads as a pinwheel, not a kaleidoscope. |
| `sampleX/Y`    | -1..1          | 0           | Off-centre source-sampling. Cursor drives these in interactive mode. |
| `zoom`         | 0.3..3         | 1.2         | Default >1 pulls more detail into the cell — first paint is "rich". |
| `recurseDepth` | 0..3           | 0           | 0 is classical; ≥1 is fractal. |
| `tint`         | hex+alpha      | transparent | Optional overlay. |
| `seed`         | int            | 42          | Only used by grain. |
| `focusRadius`  | 40..600        | 220         | Interactive — cursor moves fold origin. |

Plus the shared preprocessor (canvasSize / blur / grain / gamma / blackPoint / whitePoint), `mode`, `animate`, `interactive`, `fit`, `bg`.

## Landing default

8 segments, mirror on, zoom 1.2, no tint, idle. On first paint the user sees a classic 8-fold kaleidoscope read of whatever source they loaded.

## Verification

- All 6 modes pass `renderAt(0) === renderAt(1)` byte-equal (verified via Chrome DevTools MCP, 2026-05-13).
- Non-idle modes produce distinct outputs at t = 0.25 / 0.5 / 0.75.
- 24-frame mean render time: 14–18 ms (recurse is the slowest because depth multiplies the per-pixel fold count).
- Screenshots in `docs/screenshots/kaleidoscope-{idle,breath,spin,pulse,march,recurse}.png`.

## References

- **Brewster, D. (1816).** *A Treatise on the Kaleidoscope.* Edinburgh: Constable. Takeaway: the geometric primitive is "two plane mirrors at angle π/N," producing N-fold rotation + mirror symmetry. Everything else (object cell, rotation, recursive zoom) is decoration around that primitive. Our `mirror` + `segments` is Brewster's instrument expressed as a sampling kernel.
- **Quilez, I.** *Polar coordinates & symmetry.* iquilezles.org/articles/symmetry. Takeaway: mod-fold the angle into a wedge, flip alternate slices for mirror seams. This is the implementation here. Quilez's shader uses GLSL `mod`; we use the JS equivalent with explicit branch for negative angles.
- **Escher, M.C. (1959).** *Circle Limit III.* Hyperbolic tessellation with rotational symmetry. Takeaway: rotational tilings read as "infinite" because the eye cannot locate the tile boundary. Our `recurse` mode reproduces that feeling in Euclidean space by folding the fold — each iteration multiplies effective symmetry.
- **Manfred Mohr (1969).** *P-018.* Pen-plotter algorithmic art. Takeaway: algorithmic symmetry alone is enough to read as composed; Mohr proved this with a FORTRAN program and a Benson plotter. No randomness needed, no source image needed — just the symmetry primitive.
- **Shadertoy MdSfDz** (kaleidoscope gallery). Takeaway: a single monotonic angleOffset sweep across the loop is the canonical "kaleidoscope spin" animation. Our `spin` mode is this exactly.
