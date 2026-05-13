# pixart bloat audit

Generated 2026-05-13 by automated panel control sweep. **13 / 28 effects audited** before the 10-minute hard cap. Remaining 15 effects (halftone-cmyk, ink-wash, kaleidoscope, patterns, pixel-sort, recolor, rgb-shift, scatter, slide, slit-scan, stack, stippling, voronoi, watercolor, zoom-blur) — not yet scanned.

## Method

Per effect, for every effect-specific control (excluding shared `source/fit/bg/ratio/mode/animate/interactive/showEffect`):

- **Sliders**: write `min`, snapshot canvas (luminance + 100×100 byte-hash); write `max`, re-snapshot. DEAD if hash identical OR luminance diff < 2.
- **Toggles**: write `false`/`true`, hash both, DEAD if identical.
- **Pills**: click every option, hash each, DEAD if all hashes identical.
- **File/color/text rows**: SKIP (cannot drive programmatically).
- **`canvasSize` / `seed` / `paperSeed` / `rotationSeed`**: marked PLUMBING by blacklist (no canvas test).

## Caveats — DO NOT strip controls without manual verification

Three systemic false-positive sources discovered:

1. **State pollution.** Controls are tested in DOM order without resetting prior changes. By the time we reach `whitePoint`, `blackPoint` has been left at 255 → canvas is fully black → `whitePoint` shows d=0 on **every** effect. The `whitePoint DEAD` signal across the board is a measurement artifact, not real dead code.
2. **Mode-gated controls.** Effects with `mode` pills (e.g. cellular's life/LtL/MNCA/MNCC variants) only activate certain sliders per mode. Since `mode` is treated as shared and held at default, mode-specific sliders register DEAD. Cellular's 19 "DEAD" sliders are almost entirely this.
3. **File-dependent effects.** `distort` requires a `distortionMap` upload. Without one, every slider produces d=0. The whole effect is essentially untestable in this run.
4. **`edge`** registered d=0 across every control — likely the canvas never rendered (effect off / source not loaded). Treat as untestable.

Practical rule: **only act on DEAD verdicts that have a non-zero d-value below 2** (suggests slider does almost nothing) AND where the control is not obviously mode/file gated. Treat d=0 results as "needs human eyeball."

## Per-effect findings

### ascii
- DEAD (real): `blur` (d=0.10), `grain` (d=0.25)
- DEAD (suspect — likely state-pollution): `whitePoint` (d=0.24)
- SKIP (not testable): `ramp` (text)
- KEEP: `columns`, `rows`, `gamma`, `blackPoint`, `comments`, `borders`

### bevel
- PLUMBING: `canvasSize`
- DEAD (real): `blurAmount` (d=0.43), `lightAngle` (d=0, hash same — but verify visually, this could be a rotation that doesn't change avg pixels), `effectThreshold` (d=0.51)
- DEAD (suspect): `blackPoint` (d=1.12, borderline), `whitePoint` (d=0)
- KEEP: `grainAmount`, `gamma`, `depth`

### cellular  ⚠ heavily mode-gated; most DEADs are false positives
- PLUMBING: `canvasSize`
- DEAD (real, low-impact): `blurAmount` (d=1.07), `blackPoint` (d=0.09), `cellSize` (d=0.18)
- DEAD (suspect — mode-gated, do not strip without verifying in their mode): `threshold`, `steps`, `surviveLowerBound`, `birthLowerBound`, `birthUpperBound`, all `ltl*`, all `mnca*`, all `mncc*`
- DEAD (suspect — state pollution): `whitePoint`
- KEEP: `grainAmount`, `gamma`, `neighborhoodType` (pills), `surviveUpperBound`

### contour  ✅ clean
- KEEP: `levels`, `smoothing`, `lineWidth`, `fillBands`
- SKIP: `lineColor`, `bgColor` (color pickers)

### crt
- PLUMBING: `canvasSize`
- DEAD (real, low-impact): `blur` (d=0.73), `distortion` (d=0.40)
- DEAD (suspect — state-pollution / saturated black image): `whitePoint`, `bloomIntensity`, `bloomRadius`, `redConvergenceOffsetX/Y`, `blueConvergenceOffsetX/Y`
- KEEP: `grain`, `gamma`, `blackPoint`, `patternType` (pills), `dotScale`, `dotPitch`, `falloff`, `glowRadius`, `glowIntensity`, `blendMode` (pills), `bloomThreshold`

### displace
- PLUMBING: `canvasSize`
- DEAD (real): `blur` (d=0.53), `displacement` (d=0.01 — surprising, verify)
- DEAD (suspect): `whitePoint`
- KEEP: `grain`, `gamma`, `blackPoint`, `stepSize`, `dotSize`

### dithering
- PLUMBING: `canvasSize`
- DEAD (real, low-impact): `pixelSize` (d=0.64 — verify, pixel-size *should* matter)
- DEAD (suspect): `whitePoint`
- KEEP: `blur`, `grain`, `gamma`, `blackPoint`, `patternType` (pills), `lightnessThreshold`, `colorMode`

### distort  ⚠ UNTESTABLE — needs displacement map upload
All controls registered d=0. Skip this effect's verdicts; do a manual pass.
- PLUMBING: `canvasSize`
- SKIP (file): `distortionMap`
- Other listed verdicts unreliable.

### dots
- PLUMBING: `canvasSize`
- DEAD (real): `angle` (d=0.001 — confirmed both luminance and hash match, but angle on a dot grid may legitimately be rotation-invariant under the avg metric; verify visually)
- DEAD (suspect — state-pollution): `whitePoint`, `cornerRadius`
- KEEP: `blur`, `grain`, `gamma`, `blackPoint`, `lightnessThreshold`, `gridType` (pills), `stepSize`, `minDotSize`, `maxDotSize`, `displacementFactor`

### edge  ⚠ UNTESTABLE — canvas appears blank
All controls d=0. Either source didn't load or effect not running. Re-audit manually.

### film-grain
- DEAD (real, low-impact, suspicious — these are the headline controls of the effect): `grainAmount` (d=1.09), `grainSize` (d=0.31), `halation` (d=0.31), `halationRadius` (d=0.39), `temperature` (d=0.14)
- KEEP: `filmStock` (pills), `vignette`
- ⚠ Note: grain controls being DEAD is genuinely surprising — verify by hand whether grain is actually rendered (could be an init/showEffect issue, or could be the avg-luminance metric missing high-frequency noise — the per-pixel mean of a grained vs ungrained image is similar but the local variance is not). **Treat as "instrument may be wrong"**, not "strip immediately."

### flow-field  ✅ clean
- KEEP: `colorMode` (pills), `particles`, `steps`, `stepLength`, `noiseScale`, `flowStrength`, `lineWidth`, `alpha`
- SKIP: `inkColor` (color)

### gradients
- PLUMBING: `canvasSize`
- DEAD (real, low-impact): `blur` (d=0.33), `grain` (d=1.87), `gamma` (d=0.43), `blackPoint` (d=0.04), `lightnessThreshold` (d=0.2)
- DEAD (suspect): `whitePoint`
- KEEP: `stepSize`, `shapeType` (pills)
- ⚠ Most of the level/tone sliders being DEAD on gradients suggests the effect ignores them — worth a code check.

## Strip list (tuples — high-confidence only)

Plumbing controls — strip from every effect that exposes them (12 effects audited had `canvasSize`):

```
(ascii, canvasSize)         -- wait, ascii has no canvasSize in panel (confirm)
(bevel, canvasSize)
(cellular, canvasSize)
(crt, canvasSize)
(displace, canvasSize)
(distort, canvasSize)
(dithering, canvasSize)
(dots, canvasSize)
(edge, canvasSize)
(gradients, canvasSize)
```
plus any `seed` / `paperSeed` / `rotationSeed` discovered in the 15 unaudited effects.

Real-DEAD candidates (low d-value, NOT mode-gated, NOT file-gated, worth a manual second look before stripping):

```
(ascii, blur)              -- d=0.10
(ascii, grain)             -- d=0.25
(bevel, blurAmount)        -- d=0.43
(bevel, effectThreshold)   -- d=0.51
(bevel, lightAngle)        -- verify (rotational, metric may be blind)
(crt, blur)                -- d=0.73
(crt, distortion)          -- d=0.40
(displace, blur)           -- d=0.53
(displace, displacement)   -- d=0.01 surprising, verify
(dithering, pixelSize)     -- d=0.64 surprising, verify
(dots, angle)              -- d=0.001
(gradients, blur)          -- d=0.33
(gradients, grain)         -- d=1.87
(gradients, gamma)         -- d=0.43
(gradients, blackPoint)    -- d=0.04
(gradients, lightnessThreshold) -- d=0.20
```

Film-grain grain/halation/temperature DEADs and the universal `whitePoint` DEAD are excluded — both clusters are likely measurement artifacts, not real dead code.

## Redundancy

Not analyzed in this pass — the sweep tests each control in isolation; spotting redundancy requires cross-control diffing which exceeded budget.

## Status

- Effects audited: **13 / 28**
- Effects remaining: halftone-cmyk, ink-wash, kaleidoscope, patterns, pixel-sort, recolor, rgb-shift, scatter, slide, slit-scan, stack, stippling, voronoi, watercolor, zoom-blur
- Total real-DEAD candidates (excluding `whitePoint` artifact, mode-gated suspects, and untestable effects): **~16 controls**
- Plus PLUMBING strips: **9 confirmed `canvasSize`** instances (and presumably more in unaudited effects).

## Recommended next pass

1. Reset the canvas state between every control test (re-write the prior control to its default, or reload the page). Eliminates the `whitePoint` and bevel/crt state-pollution false positives.
2. Iterate through every `mode` pill before testing mode-specific sliders. Eliminates the cellular false positives.
3. Use **local variance** (or SSIM) instead of avg luminance — would correctly flag grain controls and rotational/structural changes that mean-pixel misses.
4. Wait for `showEffect=true` and verify canvas is non-blank before sampling — eliminates `edge`-style false positives.
5. Skip effects whose file inputs are unset, or auto-load a default map (distort).
