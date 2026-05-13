# Pixart Phase 1 Audit — Tooooools.app Cross-Reference

Date: 2026-05-13. Scope: inventory-only; control-level cross-reference of all 28 pixart effects against the live tooooools.app reference. No behavioural diffing — that is Phase 2.

**Headline numbers.** Tooooools.app ships 13 effects + 2 animators = **15 references**. Pixart ships **28** effects. That means **13 of the 28 pixart effects have no tooooools origin** — they are pure Claude inventions added in earlier sessions (contour, film-grain, flow-field, halftone-cmyk, ink-wash, kaleidoscope, pixel-sort, rgb-shift, slit-scan, voronoi, watercolor, zoom-blur — plus parts of stippling that drifted). **All 28 pixart effects carry an invented `mode` system** (idle/breath/march/rotate/pulse/etc) plus invented `animate` + `interactive` toggles. None of these exist on tooooools.

Conventions: pixart side from `<slug>/index.html` `wg-row data-key`. Tooooools side from the live right-hand panel innerText. "(claude-invented)" marks pixart controls with no tooooools counterpart.

---

## ascii

**Reference URL:** https://www.tooooools.app/effects/ascii — exists
**tooooools controls:** Blur [slider], Grain [slider], Gamma [slider], Black Point [slider], White Point [slider], Columns [slider], Rows [slider], Character Set [text], Comments [toggle], Show Borders [toggle].
**pixart controls:** source [file], fit, bg, columns, rows, ramp (= Character Set), invertRamp (claude-invented), blur, grain, gamma, blackPoint, whitePoint, fg (claude-invented), fgMatch (claude-invented), bold (claude-invented), comments, borders, tracking (claude-invented), jitter (claude-invented), mode (claude-invented), animate (claude-invented), interactive (claude-invented).
**Invented modes:** idle, breath, march, rotate, pulse.
**Divergence score:** 8 pixart extras + 0 missing + invented mode = **9**.
**One-liner:** Faithful base, but stuffed with invented decorations + a 5-mode system to remove.

## bevel

**Reference URL:** https://www.tooooools.app/effects/bevel — exists
**tooooools controls:** Canvas Size, Blur, Grain, Gamma, Black Point, White Point, Show Effect [toggle], Depth, Light angle, Effect Threshold.
**pixart controls:** source, fit, bg, canvasSize, blurAmount, grainAmount, gamma, blackPoint, whitePoint, depth, lightAngle, effectThreshold, softness (claude-invented), chromaShift (claude-invented), mode (claude-invented), showEffect, animate (claude-invented), interactive (claude-invented).
**Invented modes:** idle, breath, pulse, tilt, march.
**Divergence score:** 5.
**One-liner:** Faithful base; mode system + softness/chromaShift to remove.

## cellular

**Reference URL:** https://www.tooooools.app/effects/cellular-automata — exists (slug differs)
**tooooools controls:** Canvas Size, Blur, Grain, Gamma, Black Point, White Point, Show Effect, Threshold, Cell Size, Steps, Type [select: Classic, LTL, MNCAB, MNCC], Survive Lower Bound, Survive Upper Bound, Birth Lower Bound, Birth Upper Bound (the LTL/MNCA/MNCC families have their own bounds groups when selected).
**pixart controls:** all of the above (under MNCAB pixart names it `mnca…`, MNCC `mncc…`), plus stepsSweep (claude-invented), mode (claude-invented), chirality (claude-invented), gapTone (claude-invented), focusRadius (claude-invented), aliveColor (claude-invented), deadColor (claude-invented), animate, interactive.
**Invented modes:** breath, drift, pulse, march, idle.
**Divergence score:** 8.
**One-liner:** Faithful CA algorithm; mode + chirality/gapTone/focusRadius/colors are decorative inventions.

## contour

**Reference URL:** none. Tooooools does not ship a contour effect.
**Reference exists?** no — this is a Claude invention.
**tooooools controls:** N/A.
**pixart controls:** source, fit, bg, canvasSize, blurAmount, grainAmount, gamma, blackPoint, whitePoint, mode, style, bandPalette, levels, lineWidth, smoothing, lineColor, bgColor, fillBands, seed, focusRadius, animate, interactive.
**Invented modes:** idle, breath, pulse, rise, march, breathe-density; style values marching-squares/pixel/streak also Claude-invented.
**Divergence score:** N/A (no reference); 12+ invented controls + mode.
**One-liner:** Reference doesn't exist; this is a Claude invention.

## crt

**Reference URL:** https://www.tooooools.app/effects/crt — exists
**tooooools controls:** Canvas Size, Blur, Grain, Gamma, Black Point, White Point, Show Effect, Type [select: Monitor, TV, LCD], distortion, dotScale, dotPitch, falloff, glowRadius, glowIntensity, Bloom [select: Screen, Light, HDR], bloomThreshold, bloomIntensity, bloomRadius, redConvergenceOffsetX/Y, blueConvergenceOffsetX/Y.
**pixart controls:** all of the above (pixart names Type as `patternType`, Bloom as `blendMode`), plus brightnessBoost (claude-invented), convergenceStrength (claude-invented), mode (claude-invented), interlace (claude-invented), chromaConverge (claude-invented), focusRadius (claude-invented), showEffect, animate, interactive.
**Invented modes:** breath, roll, flicker, drift, idle.
**Divergence score:** 7.
**One-liner:** Faithful base — verify Bloom blendMode values match Screen/Light/HDR — mode system to remove.

## displace

**Reference URL:** https://www.tooooools.app/effects/displace — exists
**tooooools controls:** Canvas Size, Blur, Grain, Gamma, Black Point, White Point, Show Effect, Step Size, Displacement, Dot Size.
**pixart controls:** source, fit, bg, canvasSize, blurAmount, grainAmount, gamma, blackPoint, whitePoint, pixelDensity (≈ Step Size?), yDisplacement (≈ Displacement), dotSize, viewYaw (claude-invented), pitch (claude-invented), eddyScale (claude-invented), vorticity (claude-invented), focusRadius (claude-invented), mode (claude-invented), showEffect, animate, interactive.
**Invented modes:** idle, breath, rotate, pulse, march, swirl.
**Divergence score:** 7.
**One-liner:** Algorithm is suspect — pixart is doing 3D "viewYaw/pitch/eddyScale/vorticity" theatre; tooooools is a simple step-displacement.

## distort

**Reference URL:** https://www.tooooools.app/effects/distort — exists
**tooooools controls:** distortion map [file upload], Canvas Size, Blur, Grain, Gamma, Black Point, White Point, Show Effect, Preprocess [select: distortion, base], Threshold, X Shift Strength, Y Shift Strength.
**pixart controls:** source, fit, bg, distortionMap, canvasSize, blurAmount, grainAmount, gamma, blackPoint, whitePoint, preprocessTarget, displacementThreshold, xDisplacementStrength, yDisplacementStrength, harmonic (claude-invented), phaseOffset (claude-invented), focusRadius (claude-invented), mode (claude-invented), showEffect, animate, interactive.
**Invented modes:** idle, breath, rotate, pulse, march, harmonic.
**Divergence score:** 5.
**One-liner:** Faithful base; harmonic/phaseOffset/mode are theatrics to remove.

## dithering

**Reference URL:** https://www.tooooools.app/effects/dithering — exists
**tooooools controls:** Canvas Size, Blur, Grain, Gamma, Black Point, White Point, Show Effect, Pattern [select: F-S, Bayer, Random], Pixel Size, Color Mode [toggle], Threshold.
**pixart controls:** all of the above (pixart calls them patternType, pixelSize, colorMode, lightnessThreshold), plus colorCount (claude-invented), pixelSweep (claude-invented), mode (claude-invented), serpentine (claude-invented), bias (claude-invented), focusRadius (claude-invented), showEffect, animate, interactive.
**Invented modes:** breath, march, pulse, rotate, swap, idle.
**Divergence score:** 7.
**One-liner:** Faithful base; mode + serpentine/bias/colorCount/pixelSweep all to remove (or verified separately).

## dots

**Reference URL:** https://www.tooooools.app/effects/dots — exists
**tooooools controls:** Canvas Size, Blur, Grain, Gamma, Black Point, White Point, Show Effect, Threshold, Grid Type [select: Regular, Benday], Grid Angle, Min Dot Size, Max Dot Size, Corner Radius, Step Size, Noise.
**pixart controls:** source, fit, bg, canvasSize, blurAmount, grainAmount, gamma, blackPoint, whitePoint, lightnessThreshold, gridType, angle, stepSize, minDotSize, maxDotSize, cornerRadius, displacementFactor (≈ Noise?), angleSweep (claude-invented), mode (claude-invented), dotShape (claude-invented — values round/square/euclidean), screenAngleOffset (claude-invented), focusRadius (claude-invented), dotColor (claude-invented), bgColor (claude-invented), showEffect, animate, interactive.
**Invented modes:** breath, march, pulse, rotate, swirl, idle.
**Divergence score:** 8.
**One-liner:** Faithful base; mode + dotShape/angleSweep/screenAngleOffset/colors all invented decoration.

## edge

**Reference URL:** https://www.tooooools.app/effects/edge — exists
**tooooools controls:** Canvas Size, Blur, Grain, Gamma, Black Point, White Point, Show Effect, Threshold, Min Dot Size, Max Dot Size, Corner Radius, Step Size.
**pixart controls:** source, fit, bg, canvasSize, blurAmount, grainAmount, gamma, blackPoint, whitePoint, lightnessThreshold, minDotSize, maxDotSize, cornerRadius, stepSize, thresholdSweep (claude-invented), mode (claude-invented), kernelFamily (claude-invented — sobel/scharr/prewitt), haloStrength (claude-invented), focusRadius (claude-invented), edgeColor (claude-invented), showEffect, animate, interactive.
**Invented modes:** breath, rotate, pulse, march, dazzle, idle.
**Divergence score:** 8.
**One-liner:** Faithful base; kernelFamily/halo/mode/colors invented — though kernelFamily is a defensible upgrade if real.

## film-grain

**Reference URL:** none. Tooooools does not ship a film-grain effect.
**Reference exists?** no — Claude invention.
**pixart controls:** source, fit, bg, canvasSize, mode, filmStock (portra-400/vision3-5219/ektar-100/velvia-50), grainAmount, grainSize, halation, halationRadius, gateWeave, vignette, matte, temperature, seed, focusRadius, animate, interactive.
**Invented modes:** idle, breath, flicker, march, pulse, roll.
**Divergence score:** N/A.
**One-liner:** Reference doesn't exist; this is a Claude invention. Film-stock simulation is plausible but unvalidated.

## flow-field

**Reference URL:** none.
**Reference exists?** no — Claude invention.
**pixart controls:** mode, colorMode, particles, steps, stepLength, noiseScale, flowStrength, lineWidth, alpha, seed, focusRadius, inkColor (+ preprocessing).
**Invented modes:** idle, breath, swirl, pulse, march, drift.
**Divergence score:** N/A.
**One-liner:** Reference doesn't exist; Claude invention.

## gradients

**Reference URL:** https://www.tooooools.app/effects/gradients — exists
**tooooools controls:** Canvas Size, Blur, Grain, Gamma, Black Point, White Point, Show Effect, Threshold, Step Size, Shape Type [select: rect, ellipse].
**pixart controls:** source, fit, bg, canvasSize, blurAmount, grainAmount, gamma, blackPoint, whitePoint, showEffect, lightnessThreshold, stepSize, shapeType, paletteStart (claude-invented), paletteEnd (claude-invented), thresholdSweep (claude-invented), mode (claude-invented), paletteHarmony (claude-invented), paletteAngle (claude-invented), focusRadius (claude-invented), animate, interactive.
**Invented modes:** idle, breath, tilt, bleed, band; harmony values mono/complement/triad also invented.
**Divergence score:** 7.
**One-liner:** Tiny tooooools effect made baroque; mode + palette system to strip.

## halftone-cmyk

**Reference URL:** none.
**Reference exists?** no — Claude invention.
**pixart controls:** mode, dotShape, paperWhite, cellSize, gcr, registerOffset, c/m/y/kAngle, c/m/y/kStrength, focusRadius.
**Invented modes:** idle, breath, register, march, pulse, swap.
**Divergence score:** N/A.
**One-liner:** Reference doesn't exist; Claude invention. CMYK halftone is real graphics — algorithm validity unknown.

## ink-wash

**Reference URL:** none.
**Reference exists?** no — Claude invention.
**pixart controls:** mode, paperType (kozo/mulberry/gampi/bamboo), inkColor, paperColor, brushPressure, inkDensity, bleed, dryBrush, paperGrain, seed, focusRadius.
**Invented modes:** idle, breath, flick, seep, march, dry.
**Divergence score:** N/A.
**One-liner:** Reference doesn't exist; Claude invention. Probably hand-wavy "paper texture + blur".

## kaleidoscope

**Reference URL:** none.
**Reference exists?** no — Claude invention.
**pixart controls:** mode, segments, angleOffset, mirror, sampleX, sampleY, zoom, recurseDepth, tint, seed, focusRadius.
**Invented modes:** idle, breath, spin, pulse, march, recurse.
**Divergence score:** N/A.
**One-liner:** Reference doesn't exist; Claude invention.

## patterns

**Reference URL:** https://www.tooooools.app/effects/patterns — exists
**tooooools controls:** Upload patterns [file — tile image], Canvas Size, Blur, Grain, Gamma, Black Point, White Point, Show Effect, Threshold, Grid Density.
**pixart controls:** source, fit, bg, canvasSize, blurAmount, grainAmount, gamma, blackPoint, whitePoint, lightnessThreshold, gridDensityNumber, densitySweep (claude-invented), bgColor, mode (claude-invented), tileFamily (claude-invented — truchet/smith/quarter-arc/photo), seed, tileColor (claude-invented), showEffect, animate, interactive.
**Reference missing in pixart:** Upload patterns file — pixart uses a procedural `tileFamily` select instead. This is a *fundamental* algorithm divergence.
**Invented modes:** idle, breath, march, swap, pulse.
**Divergence score:** 7 (incl. missing file upload + invented tileFamily replacing it).
**One-liner:** Algorithm is wrong: pixart procedurally generates tiles, but the tooooools effect tiles a user-uploaded image. Needs Phase 2 rework.

## pixel-sort

**Reference URL:** none.
**Reference exists?** no — Claude invention.
**pixart controls:** mode, sortBy (luminance/hue/saturation/red), direction, thresholdLow, thresholdHigh, bias, seed, focusRadius, sortReverse.
**Invented modes:** idle, breath, march, rotate, pulse, cascade.
**Divergence score:** N/A.
**One-liner:** Reference doesn't exist; Claude invention. Pixel sort is a known technique — algorithm correctness still unverified.

## recolor

**Reference URL:** https://www.tooooools.app/effects/recolor — exists
**tooooools controls:** Canvas Size, Blur, Grain, Gamma, Black Point, White Point, Show Effect, Posterize, Noise Intensity, Noise Scale, Noise Gamma, Gradient { Repetitions, Map [brightness/hue/saturation], Stops [n stops with pos + color], flip [toggle], space [select] }.
**pixart controls:** source, fit, bg, canvasSize, blurAmount, grainAmount, gamma, blackPoint, whitePoint, showEffect, posterizeSteps, noiseIntensity, noiseScale, noiseGamma, gradientRepetitions, colorAttribute (= Map), stop1Pos/Color, stop2Pos/Color, stop3Pos/Color, hueRotationAmount (claude-invented), levels (claude-invented duplicate of posterize?), palette (claude-invented), mode (claude-invented), animate, interactive.
**Reference missing in pixart:** dynamic stops (tooooools allows n stops with flip + space); pixart hardcodes 3.
**Invented modes:** breath, posterize, shift, dual, idle.
**Divergence score:** 6.
**One-liner:** Faithful base but stops UI is fixed-3 instead of dynamic; mode + palette + hueRotation invented.

## rgb-shift

**Reference URL:** none.
**Reference exists?** no — Claude invention.
**pixart controls:** mode, rOffsetX/Y, gOffsetX/Y, bOffsetX/Y, blend, gain, fringe, chromaMode, focusRadius.
**Invented modes:** idle, breath, orbit, pulse, march, drift.
**Divergence score:** N/A.
**One-liner:** Reference doesn't exist; Claude invention.

## scatter

**Reference URL:** https://www.tooooools.app/effects/scatter — exists
**tooooools controls:** dot textures upload [file], Canvas Size, Blur, Grain, Gamma, Black Point, White Point, Show Effect, Point Density, Min Dot Size, Max Dot Size, Relax Iterations, Relax Strength.
**pixart controls:** source, fit, bg, canvasSize, blurAmount, grainAmount, gamma, blackPoint, whitePoint, pointDensityFactor, minPointSize, maxPointSize, relaxIterations, relaxStrength, magnetism (claude-invented), coherence (claude-invented), mode (claude-invented), showEffect, animate, interactive.
**Reference missing in pixart:** dot textures upload — pixart appears to render solid dots only.
**Invented modes:** breath, drift, bloom, magnetic, idle.
**Divergence score:** 6.
**One-liner:** Algorithm-light: missing the user-uploaded dot-texture path; mode + magnetism/coherence invented decoration.

## slide

**Reference URL:** https://www.tooooools.app/animate/slide — exists (an animator, not /effects/)
**tooooools controls:** slide textures upload [file], Canvas Size, Ratio [select: 9:16/3:4/1:1/16:9], Corner Radius, Plane Size, Orbit Radius, Orbit Direction, Cycles, Curve [select: ease/linear/smooth], Duration, Background Color. Output: gif/mp4/frames.
**pixart controls:** source, fit, bg, numPlanes (claude-invented), planeSize, planeRadius (≈ Corner Radius), orbitRadius, orbitAngle (≈ Orbit Direction?), rotationSpeed (claude-invented — tooooools uses Cycles + Duration), pitch (claude-invented), viewYaw (claude-invented), mode (claude-invented), depthBands (claude-invented), bandSpeed (claude-invented), focusRadius, showShadow (claude-invented?), showEffect, animate, interactive.
**Reference missing in pixart:** Ratio select, Cycles, Duration, Curve, BackgroundColor, gif/mp4/frames export. Slide is fundamentally an *animator* on tooooools.
**Invented modes:** breath, parallax, swipe, marquee, idle.
**Divergence score:** 12 — very high.
**One-liner:** Algorithm is wrong: tooooools slide is a finite-duration animator with export pipeline; pixart slide is a free-running 3D orbit with invented modes. Needs Phase 2 rework.

## slit-scan

**Reference URL:** none.
**Reference exists?** no — Claude invention.
**pixart controls:** mode, axis (horizontal/vertical/radial), spread, history, tilt, seed, focusRadius, wrap.
**Invented modes:** idle, breath, march, rotate, pulse, sway.
**Divergence score:** N/A.
**One-liner:** Reference doesn't exist; Claude invention. Real slit-scan is video-temporal — pixart can't fake it from a still.

## stack

**Reference URL:** https://www.tooooools.app/animate/stack — exists (animator)
**tooooools controls:** card textures upload, Canvas Size, Ratio [select], Corner Radius, Card Size, Rotation Range, Rotation Seed, X Shift Scale, Y Shift Scale, Cycles, Speed [select: faster/linear/slower], Duration, Background Color. Output: gif/mp4/frames.
**pixart controls:** numCards (claude-invented?), cardSize, cardRadius (≈ Corner Radius), rotationRange, rotationSeed, cardShiftX, cardShiftY, stackCycles, easing (≈ Speed), mode (claude-invented), shearAxis (claude-invented), frameCount (≈ Duration), focusRadius, showShadow (claude-invented?), tintCards (claude-invented), showEffect, animate, interactive.
**Reference missing in pixart:** Ratio select, BackgroundColor, gif/mp4/frames export pipeline.
**Invented modes:** breath, cascade, splay, breath-3d, idle.
**Divergence score:** 9.
**One-liner:** Algorithm-shape is closer than slide, but export pipeline (gif/mp4) is missing; mode + tintCards/shearAxis invented.

## stippling

**Reference URL:** https://www.tooooools.app/effects/stipping — exists (slug **stipping** without final l)
**tooooools controls:** Canvas Size, Blur, Grain, Gamma, Black Point, White Point, Show Effect, Threshold, Grid Type [select: Regular, Benday], Grid Angle, Y Squares, X Squares, Min Square Width, Max Square Width.
**pixart controls:** source, fit, bg, canvasSize, blurAmount, grainAmount, gamma, blackPoint, whitePoint, lightnessThreshold, gridType, angle, ySquares, xSquares, minSquareWidth, maxSquareWidth, angleSweep (claude-invented), mode (claude-invented), densityHarmony (claude-invented), focusRadius (claude-invented), dotColor (claude-invented), bgColor (claude-invented), showEffect, animate, interactive.
**Invented modes:** idle, breath, spin, moire, stutter, march.
**Divergence score:** 7.
**One-liner:** Faithful base; mode + angleSweep/densityHarmony invented.

## voronoi

**Reference URL:** none.
**Reference exists?** no — Claude invention.
**pixart controls:** mode, seedSource (poisson/luminance-peaks/edge-density/uniform-grid), metric, colorMode, seedCount, relax, borderWidth, paletteShift, seed, focusRadius, borderColor.
**Invented modes:** idle, breath, drift, pulse, march, bloom.
**Divergence score:** N/A.
**One-liner:** Reference doesn't exist; Claude invention. Voronoi is real, but no tooooools reference for the panel/UX.

## watercolor

**Reference URL:** none.
**Reference exists?** no — Claude invention.
**pixart controls:** mode, wetness, edgeStrength, smoothing, paperGrain, paperSeed, palette, tone, wetRim, focusRadius.
**Invented modes:** idle, breath, bloom, march, dry, wash.
**Divergence score:** N/A.
**One-liner:** Reference doesn't exist; Claude invention. Watercolor sim is hard — likely cosmetic blur+grain.

## zoom-blur

**Reference URL:** none.
**Reference exists?** no — Claude invention.
**pixart controls:** mode, blurType (zoom/rotational/spiral/motion-line), strength, samples, focusX, focusY, dropoff, holdSharp, direction, spiralTwist, seed, focusRadius.
**Invented modes:** idle, breath, pulse, spin, march, chase.
**Divergence score:** N/A.
**One-liner:** Reference doesn't exist; Claude invention.

---

## Summary table

Sorted by divergence (high → low). For Claude inventions divergence is "N/A" but they all need Phase 2 validation that the algorithm actually works.

| effect | div | invented mode? | needs phase 2? | quick-win fixes |
|---|---|---|---|---|
| slide | 12 | yes | yes — rework | Restore animator shape: Ratio/Cycles/Duration/Curve/gif-mp4 export. Drop orbit-3D. |
| stack | 9 | yes | yes — rework | Add Ratio + Duration + export pipeline; drop mode/tintCards/shearAxis. |
| ascii | 9 | yes | partial | Drop fg/fgMatch/bold/tracking/jitter/invertRamp + mode; verify Character Set behaves. |
| cellular | 8 | yes | partial | Drop chirality/gapTone/focusRadius/alive&deadColor + mode; keep CA bounds. |
| dots | 8 | yes | partial | Drop dotShape/angleSweep/screenAngleOffset/colors/mode; keep GridType Regular/Benday. |
| edge | 8 | yes | yes — verify kernel | Drop kernelFamily (or verify), halo, mode, colors, thresholdSweep. |
| crt | 7 | yes | yes — verify Bloom | Map blendMode to Screen/Light/HDR; drop interlace/chromaConverge/mode. |
| dithering | 7 | yes | partial | Drop serpentine/bias/colorCount/pixelSweep/mode/focusRadius. |
| gradients | 7 | yes | partial | Drop palette system (start/end/harmony/angle), thresholdSweep, mode. |
| stippling | 7 | yes | partial | Drop angleSweep/densityHarmony/focusRadius/colors/mode. |
| displace | 7 | yes | yes — algorithm | Strip viewYaw/pitch/eddyScale/vorticity (likely fake 3D); restore plain step-displace. |
| patterns | 7 | yes | yes — algorithm | Add Upload patterns file input; drop tileFamily procedural + mode. |
| scatter | 6 | yes | yes — algorithm | Add dot textures upload; drop magnetism/coherence/mode. |
| recolor | 6 | yes | partial | Switch to dynamic stops; drop hueRotationAmount/palette/levels/mode. |
| distort | 5 | yes | partial | Drop harmonic/phaseOffset/focusRadius/mode. |
| bevel | 5 | yes | partial | Drop softness/chromaShift/mode + animate/interactive. |
| ascii | (above) | | | |
| contour | N/A | yes | yes — validate | Claude invention; verify algorithm or remove. |
| film-grain | N/A | yes | yes — validate | Claude invention; verify filmStock LUTs are real. |
| flow-field | N/A | yes | yes — validate | Claude invention; verify particle advection actually runs. |
| halftone-cmyk | N/A | yes | yes — validate | Claude invention; CMYK is real graphics — verify. |
| ink-wash | N/A | yes | yes — validate | Claude invention; likely cosmetic blur. |
| kaleidoscope | N/A | yes | yes — validate | Claude invention. |
| pixel-sort | N/A | yes | yes — validate | Claude invention; algorithm is well-known. |
| rgb-shift | N/A | yes | yes — validate | Claude invention; trivial to do correctly. |
| slit-scan | N/A | yes | yes — validate | Claude invention; static-image slit-scan is suspect. |
| voronoi | N/A | yes | yes — validate | Claude invention. |
| watercolor | N/A | yes | yes — validate | Claude invention; likely hand-wave. |
| zoom-blur | N/A | yes | yes — validate | Claude invention; radial blur is well-known. |

## Top-5 to fix first

1. **slide** — fundamentally wrong shape. Tooooools slide is a finite-duration animator with Ratio/Duration/Curve/gif-mp4 export. Pixart slide is a 3D orbit with invented modes. Phase 2 = rebuild as animator.
2. **stack** — same animator pattern; missing Ratio + Duration + gif/mp4 export. Closer than slide but still wrong.
3. **patterns** — algorithm is wrong: tooooools tiles a user-uploaded image; pixart procedurally generates with `tileFamily`. Restore Upload patterns file input.
4. **displace** — pixart added viewYaw/pitch/eddyScale/vorticity that look like fake 3D. Tooooools is a simple step-displacement. Verify or strip.
5. **scatter** — missing the dot-textures upload that tooooools uses to draw the points; pixart only renders generic dots. Algorithm-light.

**Sweeping cleanup that applies to every faithful-base effect (ascii, bevel, cellular, crt, dithering, dots, edge, gradients, recolor, stippling, distort):** strip the invented `mode` dropdown (idle/breath/march/rotate/pulse/etc), the `animate` toggle, and the `interactive` toggle. None of these exist on tooooools. They are pure Claude additions that bloat the panel and create animation paths that "don't work like tooooools.app makes them work" (operator complaint, verbatim).

**Couldn't audit:** none. Every tooooools URL resolved on first try except `stippling` → `stipping` (slug variant noted). Every pixart `index.html` parsed cleanly.
