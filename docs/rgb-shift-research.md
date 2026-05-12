# RGB Shift — research dossier

**Reference:** chromatic-aberration as a stylistic device. No specific tooooools effect mirrored; this expands what `crt`'s `chromaShift` does by an order of magnitude. The animation envelopes and per-channel XY split take the music-video glitch trope (Aphex Twin, Boards of Canada, David Lewandowski) and turn each axis into a tunable knob.
**Date:** 2026-05-13.

## What the effect is

Chromatic aberration on steroids. The source is decomposed into three channels (additive RGB by default, optionally subtractive CMY or three luminance bands) and each channel is displaced independently in XY. The three displaced channels recombine via a chosen blend (`add` / `screen` / `lighten` / `over`) with an optional radial `fringe` envelope (which makes the aberration grow with distance from frame centre, matching real lens optics) and a post-blend `gain` for luminance shaping. A cursor `focusRadius` attenuates the offsets to zero locally, creating a calm eye in the storm.

The 6 animation envelopes give six visually-distinct *kinds* of aberration motion — together they cover the perceptual space from "stationary glitch" through "rotational chromatic clock" to "stuttering VHS error".

## Math — per pass

1. **Preprocessor** (shared): blur → grain (mulberry32 seeded from `t`) → gamma → levels.
2. **Sample**: for each output pixel `(x, y)` and each channel `c ∈ {R, G, B}`:
   - `(dx, dy)` = the channel's offset, multiplied by `fringe·r²/rmax² + (1-fringe)` where `r` is distance to frame centre.
   - In interactive mode multiply additionally by `(1 - (1 - d²/R²))` if `d < focusRadius`.
   - Source sample = nearest-neighbour at `(x - dx, y - dy)`, clamped to edges.
3. **Chroma model**:
   - `additive` → take channel `c` directly from the sample.
   - `subtractive` → take `255 - sample[c]`, recombine, invert the recombined RGB at the end. Equivalent to a CMY split.
   - `luma-only` → precompute three luminance bands (shadows / mids / highlights) per pixel; the "channel" selects which band's pixel is sampled. Produces a tonally-segmented chromatic split.
4. **Recombine** via blend (per-channel is rank-1; `add` and `over` are equivalent at the pixel level; `screen` and `lighten` are kept for parity with familiar names and produce slight per-channel ceiling shifts).
5. **Gain** multiplies the final RGB.

## Parameter table

| name | range | default | role |
|---|---|---|---|
| canvasSize | 100–1000 | 600 | preprocessor resample target |
| blurAmount | 0–10 | 0 | softens source before split |
| grainAmount | 0–1 | 0 | per-pixel noise |
| mode | select | `orbit` | animation envelope |
| rOffsetX / Y | -40–40 | 4 / 0 | red-channel displacement (px) |
| gOffsetX / Y | -40–40 | 0 / 0 | green-channel displacement |
| bOffsetX / Y | -40–40 | -4 / 0 | blue-channel displacement (opposite-signed for stereoscopic feel) |
| blend | select | `add` | recombine model |
| gain | 0–2 | 1.0 | post-blend luminance |
| fringe | 0–1 | 0.3 | radial envelope: 0 = uniform shift, 1 = corners only (lens-like) |
| chromaMode | select | `additive` | RGB / CMY / luminance-band split |
| focusRadius | 40–600 | 180 | cursor calm-eye radius (interactive only) |
| animate | bool | false | enable 15s loop |
| interactive | bool | false | cursor-driven focus |

## Mode table

| mode | envelope | animated params | perceptual hook |
|---|---|---|---|
| **idle** | constant | none | the static landing artwork |
| **breath** | `(1-cos(2πt))/2` (cosine pingpong) | all channels' offsets scale in unison | pure foveal motion — the whole frame breathes |
| **orbit** | `(cos(a+φ), sin(a+φ))` per channel at 120° apart | all channels rotate around origin at equal radius | the canonical music-video RGB clock — monotonic in t |
| **pulse** | `t<0.2 ? t/0.2 : (1-(t-0.2)/0.8)^2.5` | offset magnitude on every channel | glitch hit — sharp attack, slow decay |
| **march** | stepped through [0.4, 0.7, 1.0, 0.7] | offset magnitude per step, t=1 pinned to step 0 | stuttering VHS error — visible quantisation |
| **drift** | per-channel Lissajous (R=1:1 circle, G=2:1 figure-8, B=1:2 vertical figure-8) | independent XY motion per channel | each colour gets its own dance; the whole closes at t=1 because all frequencies are integer |

**Landing default** is `orbit` at the slider magnitude (R=4, B=-4, G=0) with `fringe=0.3` and `chromaMode=additive` — produces a recognisable music-video glitch on first paint.

## Perceptual hook

Three things make the effect read as "more alive" than crt's single-knob chromaShift:

1. **Per-channel XY**. Real chromatic aberration is wavelength-dependent — red, green, and blue refract at slightly different angles, so each ends up offset along a *different* vector. Exposing six knobs (instead of one magnitude) lets the user match that physical reality, or break it for stylised effect.
2. **Radial fringe (r² envelope)**. Real lens chromatic aberration is r²-shaped — almost zero at the optical centre, growing with the square of the radial distance. The `fringe` knob blends between "uniform global shift" (`fringe=0`) and "true optical fringing" (`fringe=1`).
3. **Orbit mode at 120° apart**. Three channels orbiting a common origin at 120° apart is the signature Aphex-Twin / Boards-of-Canada motion language. It's monotonic in `t` (the orbit walks around once per loop) but the perceptual signature is "the colours are alive and breathing apart", which is what a music video wants.

## References

1. **Aphex Twin — *Windowlicker*** (1999, dir. Chris Cunningham). The canonical RGB-split motion-language piece. The morph sequences expose this exact decomposition.
2. **Boards of Canada — *Geogaddi*** booklet treatment (Warp, 2002). Static channel offsets on photographic source — the starting point that `idle` mode emulates.
3. **Bret Victor — *Drawing Dynamic Visualizations*** (CMU 2013). The cursor-as-focal-point pattern; ported here as the `focusRadius` "still eye in the storm".
4. **David Lewandowski — *Late for Meeting*** (2009). Narrative use of chromatic aberration as punctuation, not overlay; informs the `pulse` envelope's attack-decay shape.

## Performance notes

At canvasSize=600 (typical), one build pass is W·H = 360,000 pixels × 3 channels × 1 sample each ≈ 1.08M operations. Measured ~4 ms/frame on M-series in additive mode, ~6 ms in luma-only (the band precompute adds one linear walk). Mean of 24-frame sweep: **4.0–4.4 ms** depending on mode. Well under the 30 ms budget at all canvas sizes ≤ 800.

## Verification (2026-05-13, http://localhost:8001/rgb-shift/, image source)

| Mode   | seam byte-equal | distinct at t={0,0.25,0.5,0.75} | mean ms (24-frame sweep) |
|---|---|---|---|
| idle   | ✓ | 1 (intentional) | 4.0 |
| breath | ✓ | 3 (pingpong symmetry: t=0.25≡t=0.75) | 3.9 |
| orbit  | ✓ | 4 | 4.2 |
| pulse  | ✓ | 4 | 4.1 |
| march  | ✓ | 3 (step ladder visits 3 unique magnitudes) | 4.2 |
| drift  | ✓ | 4 | 4.4 |

Video source (clip.mp4 via `PIXSource.cycleSample`): renders without error at t=0.3. Video frame advance happens once per `renderAt`, so byte-equal at t=0 vs t=1 is *not* expected with video — that contract holds for image sources only (consistent with edge / recolor / distort).

Screenshots in `docs/screenshots/rgb-shift-<mode>.png`.

## Notes for the next maintainer

- `blend = screen / lighten / over` are kept for naming parity with familiar tools but at the per-pixel single-channel level they all collapse to roughly the same output. The most expressive lever is `chromaMode`, not `blend`.
- `luma-only` is the artistic-variant chroma mode and lights up dramatically on subjects with strong tonal separation (portraits, sunset photos). It's intentionally non-default — the additive RGB split is what users expect from a "chromatic aberration" effect.
- The fringe r² formula matches optics; if you want a "more stylised" radial mode, consider an r⁴ exponent instead — that puts the entire shift in the outermost quarter of the frame and reads as a heavier vignette.
