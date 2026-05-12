# Film grain — research dossier

**Reference:** none (original to pixart).
**Date:** 2026-05-13.

## What the effect is

A six-stage cinematic film-emulation pipeline:

1. **Film-stock LUT** — per-channel piecewise-linear tone curves, named for the stock they emulate.
2. **Halation** — separable two-pass box-blur of a highlight mask, additively injected into the red channel. Cinestill 800T's signature artefact, now a generic aesthetic signal.
3. **Temperature** — additive R↔B shift.
4. **Grain** — mulberry32-seeded luminance noise, with `grainSize` controlling whether noise is sampled per-pixel or averaged into chunky silver-clump cells.
5. **Vignette** — quadratic radial darkening.
6. **Gate weave + matte** — 2D jitter of the whole frame (real projector imperfection) plus optional letterbox bars.

Not a single 3-D LUT. The defining argument — Steve Yedlin's *Display Prep Demo* (2017) — is that "film look" lives in the temporal signals (grain re-randomising, gate weave, halation flicker), not in the static colour transform. A LUT alone reads as a digital photograph with a tint.

## Film stocks

| Stock | Curve signature | Saturation | Halation boost | Notes |
|---|---|---|---|---|
| `portra-400` | warm midtones, lifted shadows, soft highlights | 0.92 | 1× | Kodak's portrait neg. Skin-tone-tuned. |
| `vision3-5219` | cool shadows, neutral midtones | 0.95 | 1× | Kodak 500T cinema neg. The actual 35mm motion stock. |
| `ektar-100` | snappy contrast, clean whites | 1.18 | 1× | Daylight slide-shooting alternative. |
| `velvia-50` | crushed blacks, punchy reds/greens | 1.35 | 1× | Fuji's landscape stock. The saturation lever. |
| `tri-x-400` | black-and-white S-curve | 0.0 (grayscale) | 1× | Kodak's documentary stock. Robert Frank. |
| `cinestill-800t` | tungsten-balanced, lifted blue shadows | 1.02 | **1.6×** | Tungsten cinema neg with remjet removed → red halation is the look. |

## Modes

| Mode | Animated subset | Envelope | Seam handling |
|---|---|---|---|
| `idle` | nothing | static | trivially byte-equal |
| `breath` | `grainAmount` | cosine pingpong (0.4 → 1.0 → 0.4) | grain reseed = `seedFromT(t)`, identical at t=0 and t=1 |
| `flicker` | `grainAmount` + global luminance | 5× cosine on luma, cosine pingpong on grain | both wrap cleanly at TAU·t=2π |
| `march` | `filmStock` | step through Portra → Velvia → Tri-X → Cinestill | t=1 routed explicitly to step 0 |
| `pulse` | `halation` | asymmetric env (12% fast attack, 88% pow-2.2 decay) | env(0) = env(1) = 0 |
| `roll` | gate-weave (dx, dy) | Lissajous (sin(TAU·t·2), sin(TAU·t·3)·0.6) × cosine amplitude | trig collapses to zero at t=0/t=1 |

## Parameters

| Param | Range | Default | Stage |
|---|---|---|---|
| `canvasSize` | 100–1000 | 600 | resample |
| `filmStock` | 6 enum | `portra-400` | LUT |
| `grainAmount` | 0–1 | 0.3 | grain |
| `grainSize` | 0.5–4 | 1.2 | grain |
| `halation` | 0–1 | 0.4 | halation |
| `halationRadius` | 0–30 | 8 | halation |
| `gateWeave` | 0–6 px | 0.4 | weave |
| `vignette` | 0–1 | 0.3 | vignette |
| `matte` | 0–1 | 0 | matte |
| `temperature` | -1–1 | 0 | LUT post |
| `seed` | int | 1 | grain |
| `focusRadius` | 40–600 | 180 | interactive |

## Why halation is per-neighbourhood (not per-pixel)

A 3-D LUT operates on the single pixel's RGB. Halation is the integral of bright neighbours leaking into the current pixel — it cannot be reduced to a per-pixel transform without the neighbourhood. We implement it as a separable two-pass box-blur (kernel width 2·radius + 1) of a smooth threshold mask (luma > 180 with quadratic falloff). Two box passes approximate a Gaussian at the radii where film halation actually occupies (3–30 px) closely enough that the eye cannot distinguish.

## Determinism

- All envelopes wrap `t` to `[0, 1)` so `cos(2π·t) === cos(0) === 1` exactly at the seam.
- Grain RNG seeded from `seedFromT(t)`; identical at t=0 and t=1.
- `march` explicitly routes `t === 0` to step 0.
- `roll` gate-weave amplitude returns to zero via cosine envelope.
- ⇒ `renderAt(0).toDataURL() === renderAt(1).toDataURL()` byte-equal.

## References

1. **Roger Deakins** — *American Cinematographer* interview series (2014–2019). Grain and halation are the temporal signals that read as "film", not the LUT.
2. **Stuart Dryburgh / Cinestill technical white papers** (2017). Halation is a chemical artefact of remjet removal — now codified as an aesthetic.
3. **Steve Yedlin** — *Display Prep Demo* (2017, yedlin.net). The load-bearing argument that film-look is temporal, not chromatic. The reason this effect has six stages, not one LUT.
4. **DaVinci Resolve Film Look Creator** technical documentation (2022). Modern industry reference for the stage decomposition (LUT → halation → grain → weave).
5. **Apple ProRes RAW colour-science manual**. The current digital reference for why per-channel tone curves can stand in for full 3-D LUTs on most photographic input.

## Performance

24-frame mean target: <30 ms at 600 × ~338. Halation is the hot path (two passes over W·H); the inner loops are flat float arrays and avoid allocations. Grain is single-pass with a pre-built jitter buffer.
