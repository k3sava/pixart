# pixart E2E verification report

Run date: 2026-05-12
Server: http://localhost:8001/
Harness: Playwright MCP, one tab, navigation between effects.

## Summary

**16 / 16 effects pass core checks** (page loads 200, no JS exceptions, no app-asset 404s, canvas renders non-uniform content, nav has 16 entries with active class on current slug, controls panel has effect-specific customisations beyond the standard baseline, and `WAEffect.renderAt(0)` == `WAEffect.renderAt(1)` byte-equal — seamless loop holds across the board).

**Soft notes (not failures):**

- **crt** — `WAEffect.renderAt(t)` is time-invariant (identical bytes at t=0, 0.5, 1). Expected: CRT is a static post-process filter with no time-varying parameters. Flagged for awareness, not a defect.
- **slide** — `WAEffect.renderAt(t)` is time-invariant despite the controls panel exposing `rotationSpeed` / `orbitAngle`. Likely `renderAt` only samples the configured angle and animation is driven only when the animate toggle is on (i.e. via internal time accumulator rather than the `t` parameter). Worth confirming this is intentional; if `renderAt` is supposed to be the seamless-loop sampler, it should phase off `t` for these planes.

**Console noise** (intentional, not flagged): on `/ascii/` a favicon 404 hits because that page set its own favicon path; on `/bevel/` and `/cellular/` there is 1 warning each (CSP / non-fatal). Every other slug returned zero console errors and zero warnings during the test window.

## Per-effect table

| slug | console errors | canvas ok | animation ok | loop seamless | screenshot | notes |
|---|---|---|---|---|---|---|
| ascii | 0 (favicon 404 ignored) | yes | yes (differs) | yes (byte-equal) | docs/screenshots/ascii.png | 15 custom controls (columns/rows/ramp/blur/grain/gamma/blackPoint/whitePoint/fg/fgMatch/bold/comments/borders/invertRamp/bg) |
| bevel | 0 | yes | yes (differs) | yes (byte-equal) | docs/screenshots/bevel.png | 10 custom controls (depth/lightAngle/effectThreshold/...) |
| cellular | 0 | yes | yes (differs) | yes (byte-equal) | docs/screenshots/cellular.png | 32 custom controls (cell automaton parameters incl. LTL / MNCA / MNCC bands) |
| crt | 0 | yes | time-invariant (intentional) | yes (byte-equal) | docs/screenshots/crt.png | 23 custom controls. Static post-process — `renderAt(t)` does not vary with `t`. Soft flag. |
| displace | 0 | yes | yes (differs) | yes (byte-equal) | docs/screenshots/displace.png | 12 custom controls (pixelDensity/yDisplacement/dotSize/viewYaw/pitch) |
| distort | 0 | yes | yes (differs) | yes (byte-equal) | docs/screenshots/distort.png | 12 custom controls (distortionMap/preprocessTarget/x|yDisplacementStrength/...) |
| dithering | 0 | yes | yes (differs) | yes (byte-equal) | docs/screenshots/dithering.png | 13 custom controls (patternType/pixelSize/colorMode/colorCount/pixelSweep/...) |
| dots | 0 | yes | yes (differs) | yes (byte-equal) | docs/screenshots/dots.png | 18 custom controls (gridType/angle/stepSize/min|maxDotSize/cornerRadius/displacementFactor/angleSweep/dotColor/bgColor/...) |
| edge | 0 | yes | yes (differs) | yes (byte-equal) | docs/screenshots/edge.png | 14 custom controls (lightnessThreshold/min|maxDotSize/cornerRadius/thresholdSweep/edgeColor/...) |
| gradients | 0 | yes | yes (differs) | yes (byte-equal) | docs/screenshots/gradients.png | 13 custom controls (lightnessThreshold/stepSize/shapeType/paletteStart|End/thresholdSweep/...) |
| patterns | 0 | yes | yes (differs) | yes (byte-equal) | docs/screenshots/patterns.png | 11 custom controls (gridDensityNumber/densitySweep/bgColor/...) |
| recolor | 0 | yes | yes (differs) | yes (byte-equal) | docs/screenshots/recolor.png | 20 custom controls (posterizeSteps/noiseIntensity|Scale|Gamma/gradientRepetitions/colorAttribute/stop1|2|3Pos|Color/hueRotationAmount/...) |
| scatter | 0 | yes | yes (differs) | yes (byte-equal) | docs/screenshots/scatter.png | 12 custom controls (pointDensityFactor/min|maxPointSize/relaxIterations/relaxStrength/...) |
| slide | 0 | yes | time-invariant (review) | yes (byte-equal) | docs/screenshots/slide.png | 10 custom controls (numPlanes/planeSize|Radius/orbitRadius|Angle/rotationSpeed/pitch/viewYaw/showShadow). `renderAt(t)` does not vary across t=0/0.5/1 — verify whether `renderAt` is meant to drive the orbit. |
| stack | 0 | yes | yes (differs) | yes (byte-equal) | docs/screenshots/stack.png | 12 custom controls (numCards/cardSize|Radius/rotationRange|Seed/cardShiftX|Y/stackCycles/easing/showShadow/tintCards) |
| stippling | 0 | yes | yes (differs) | yes (byte-equal) | docs/screenshots/stippling.png | 17 custom controls (gridType/angle/x|ySquares/min|maxSquareWidth/angleSweep/dotColor/bgColor/...) |

## Verification methodology

- **Canvas ok**: drew `#cv` into an offscreen 64x64 2D canvas via `drawImage`, then read 1024 pixel samples — pass requires >0 non-black pixels AND >1 unique RGB triple. This pattern is robust to WebGL backings where `#cv.getContext('2d')` would return null.
- **Animation ok**: `WAEffect.renderAt(0)` vs `WAEffect.renderAt(0.5)` — pass requires the two `cv.toDataURL()` strings to differ.
- **Loop seamless**: `WAEffect.renderAt(0)` vs `WAEffect.renderAt(1)` — pass requires byte-equal data URLs. All 16 pass.
- **Nav**: `.effect-nav a` count must equal 16, and `.effect-nav .active` must contain the current slug name. All 16 pass.
- **Controls panel**: filtered `.wg .wg-row[data-key]` values, excluded the standard baseline (`source`, `fit`, `background` / `bg`, `animate`, `interactive`). Pass requires at least one effect-specific row. All 16 pass with rich customisation.

## Recommended follow-up

1. **crt** and **slide**: confirm whether `WAEffect.renderAt(t)` is supposed to phase the visible animation. For crt this is almost certainly correct (static filter). For slide, the orbiting planes look like they should rotate with `t` — if so, route `rotationSpeed * t` into `renderAt`.
2. The ascii favicon 404 is unique to that page — drop the `<link rel="icon">` or point it to a shared asset to silence the console.

Artifacts: `/Users/k3sava/projects/pixart/docs/screenshots/<slug>.png` (16 files).
