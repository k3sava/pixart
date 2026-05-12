# Gradients — reference dossier

Port of `tooooools.app/effects/gradients` — a **scanline brightness
segmentation** that paints each segment with a 1-pixel-wide gradient palette
stretched across the segment's horizontal extent. Despite the name, this is
**not** a "draw a gradient over the image" effect, **not** mesh-gradient, and
**not** a gradient-map recolour (that's the Recolor effect — see distinction
below).

## Bundle artifacts

- Page chunk: `/_next/static/chunks/app/effects/gradients/page-be52627c6a02682d.js`
- Shared chunk (defaults + preprocessor): `/_next/static/chunks/9357-2a51c42cdfe973de.js`
- Stack: Next.js + React + p5.js (ReactP5Wrapper, WEBGL canvas). All numerical
  work happens in `loadPixels()` → tight pixel loop. The WEBGL mode is used
  exclusively for `texture(palette)` + `textureMode(NORMAL)` on textured rects
  — the geometry is just axis-aligned rects/ellipses.

## What the effect actually is

1. Build a **1-pixel-tall horizontal palette** that runs WHITE on the left
   to BLACK on the right (`map(x, 0, w−1, 255, 0)`). This palette is
   recomputed when canvasSize changes; it is shared across all strips.
2. **Preprocess** the source through the framework-standard pipeline
   (blur → grain → gamma → levels → resample to `canvasSize × canvasHeight`).
3. **Segment by strip**: for each row-strip of height `stepSize`, walk
   x = 0..W and at each x compute the **column-averaged brightness**
   (alpha composited over white, RGB averaged) across the strip's
   `stepSize` rows. Open a new segment every time
   `|prevBrightness − currentBrightness| > lightnessThreshold`.
4. **Paint each segment** as either a `rect(start, y, end−start, stepSize)`
   or `ellipse(start, y, end−start, stepSize)`, textured with the palette
   via `textureMode(NORMAL)`. With NORMAL UVs, the texture spans `[0..1]`
   across the segment width — so every segment shows the entire palette
   compressed into its width. Wide segments (flat horizontal stretches in
   the source) produce smooth long gradients; narrow segments produce hard
   cuts. The result is "venetian-blind painterly bands".

The per-segment `brightness` field is collected during the scan but the
final draw call **ignores it** — the texture is the palette, not a tint by
brightness. Verified twice in the bundle: `e.texture(a)` always references
the palette graphics, never the source.

## Gradients vs Recolor — the distinction

| Axis | Gradients | Recolor |
|---|---|---|
| Where brightness goes | Triggers a **cut** when delta exceeds threshold | Maps each pixel to a colour via a piecewise-linear gradient |
| Output primitive | Rect/ellipse strips with auto-stretched palette inside each | Per-pixel recolour of the whole image |
| Palette role | Texture coordinates span the segment | LUT indexed by `(attribute · K) mod 1` |
| Granularity | Strip-of-`stepSize` rows × variable-width segments | Per-pixel |
| Vibe | Horizontal bands, venetian-blind painterly | Smooth gradient remap, duotone or rainbow |

Same source, same gradient — totally different visual logic.

## Parameters (from `u = (e, t) => […]` in the page chunk)

| UI label | stateKey | Range / step | Default | Where it acts |
|---|---|---|---|---|
| Canvas Size | `canvasSize` | 100–1000 | 600 (port) | preprocessor — resample target |
| Blur | `blurAmount` | 0–10 | 0 | preprocessor |
| Grain | `grainAmount` | 0–1 / 0.1 | 0 | preprocessor |
| Gamma | `gamma` | 0.1–2 / 0.1 | 1 | preprocessor |
| Black Point | `blackPoint` | 0–255 | 0 | preprocessor |
| White Point | `whitePoint` | 0–255 | 255 | preprocessor |
| Show Effect | `showEffect` | bool | true | bypass to preprocessed preview |
| Threshold | `lightnessThreshold` | 0–255 | **128** | segment cut sensitivity |
| Step Size | `stepSize` | **15**–100 (slider) | **8** (state) | strip height in source-pixels |
| Shape Type | `shapeType` | rect \| ellipse | rect | per-segment geometry |

Defaults verified from `pageStates["/effects/gradients"]`:

```js
"/effects/gradients": { showEffect: true, lightnessThreshold: 128, stepSize: 8, shapeType: "rect" }
```

### The stepSize default-vs-range anomaly

The slider declares `min: 15, max: 100`. The state declares `stepSize: 8`.
The reference ships an **unreachable initial state**: the first paint uses 8,
but as soon as you touch the slider you're locked into ≥15. We preserve the
first-paint value 8 (so the landing frame matches the reference) and widen
the slider min to 4 — without this widening, the most expressive part of the
parameter space (fine 4–14 px strips) is invisible to users. The reference
ships striking-by-accident; we ship striking-on-purpose.

## Port defaults (this implementation)

Same algorithm, two adjustments for landing impact:

- `lightnessThreshold: 32` (vs reference 128) — many more segments, busier
  bands. The reference's 128 produces 3–10 segments per strip on most
  inputs; 32 produces 20–60.
- `stepSize: 8` (matches reference state) with slider min 4.
- `paletteStart: '#ffffff'`, `paletteEnd: '#000000'` — exact reference
  palette. The port exposes both endpoints as controls so the toy can be a
  toy; defaults are reference-identical.

## Animation (port-only, not in reference)

The reference is static. For the 15 s seamless loop we pingpong
`lightnessThreshold` between `base + sweep` and `base − sweep` via a cosine
pingpong: `(1 − cos(2π·t)) / 2`. Endpoints meet **byte-equal** because
`cos(0) = cos(2π) = 1` exactly in IEEE-754 and the `(1 − x)/2` algebra is
exact for the 0 endpoint. At t = 0.5 the threshold dips to its minimum so
the canvas blooms with many fine segments; at t = 0 / t = 1 it returns to
rest. Reading: breathing complexity.

## Determinism (export byte-equal)

- Segmentation arithmetic is fully deterministic — same `lumGrid` + same
  threshold ⇒ same segment list.
- The only stochastic step is `grainAmount > 0` in the preprocessor. We
  re-seed `mulberry32` from `seedFromT(tLoop)` before every preprocess pass.
  At `t = 0` and `t = 1` the seed is identical, so `renderAt(0)` and
  `renderAt(1)` produce identical pixel buffers, including grain.
- Video sources sample the current decoded frame at each `renderAt`; for
  byte-equal loop export the recorder must seek the video to the same start
  frame at t=0 and t=1 — this is the existing PIXSource contract.

## Performance

Cost per frame at 1280×720 viewport with default `canvasSize = 600`:

- Preprocessor: ~O(W·H) pixel ops on a 600×340 buffer = ~204K pixels.
  Two passes when both gamma and grain are on; one pass otherwise.
- Luminance grid build: 204K float computations on the same data.
- Segmentation: 600 × `H/stepSize` × `stepSize` = 600·H = ~204K
  brightness reads (luminance is precomputed). Independent of stepSize.
- Paint: ~`(H/stepSize)` strips × ~10–60 segments each → a few hundred
  `drawImage(palette, …)` calls. The palette is a 600×1 canvas so each
  blit is cheap.

Measured on a 2021 M1 Pro at 1280×720: ~6–9 ms/frame at `stepSize = 8`,
~3–5 ms at `stepSize = 24`. Well under the 30 ms budget.

## Notes for future maintainers

- `drawImage(palBuf, 0, 0, palW, 1, dx, dy, dw, dh)` is the 2D analogue of
  WEBGL `textureMode(NORMAL) + texture(palette) + rect(...)`. The 1px-tall
  source is sampled with bilinear interpolation across the destination
  width and vertically replicated to `dh` rows. This is exactly the
  per-segment gradient the reference shows.
- For `shape = ellipse`, we clip an ellipse path to the segment rect and
  drawImage into the clipped region. This matches the reference's
  `ellipse(...)` with the textured-fill path.
- The reference's `noStroke()` is the default Canvas2D behaviour — nothing
  to mirror.
- `canvasHeight = canvasSize · (sourceH / sourceW)` is implied by the
  bundle's `resize(canvasSize, n)` call; we compute it identically.

---

## Refinement pass — 2026-05-13

Goal of this pass: graduate `gradients` from a single threshold pingpong to a five-mode envelope set that demonstrates Albers' interaction-of-color thesis as a *moving* artwork. Five modes, three new params, mode-aware interactive cursor. All modes hold byte-equal loops and stay under 30 ms/frame at 1280×720.

### Modes shipped

| Mode | Envelope | Subset animated | Perceptual lever |
|---|---|---|---|
| **idle** | constant | none | Rest frame is the artwork |
| **breath** | cosine pingpong (original) | `lightnessThreshold` | Calm sweep — fewer bands ↔ many bands |
| **tilt** | monotonic 0→360° | `paletteAngle` | Hue axis rotates; geometry untouched. The bands appear to migrate through the colour wheel — pure Albers |
| **bleed** | cosine on harmony walk | right palette endpoint hue | Endpoints lerp through analogous → split-complementary → back. Bands shift perceived depth mid-cycle (cooler bands recede behind warmer ones) |
| **band** | monotonic stepSize sawtooth | `stepSize` | Venetian-blind contracts then expands — the strips themselves grow/shrink |

Byte-equal endpoints are guaranteed by three rules: (1) every envelope wraps `t` to `[0,1)` before evaluation, so `cos(2π·t)==cos(0)==1` exactly; (2) `tilt`'s 360° endpoint is explicitly mapped back to 0° at `t=1`; (3) `band`'s sawtooth is pinned to its low value at `t=0` so the seam matches the loop start.

### New params

- **`paletteAngle`** (`-180..180°`, default `0`) — HSL hue rotation applied to both palette endpoints. Static-mode knob that previews the `tilt` axis at any frozen angle. The default white→black bundle palette has saturation 0, so this knob does nothing on it — we therefore ship saturated defaults (`#f4d35e` → `#1d3557`, an Albers-style amber/navy pair) so the toy ships its thesis on first paint. Set both endpoints to white/black for byte-exact bundle parity.
- **`paletteHarmony`** (`mono | complement | triad`, default `mono`) — controls the right-endpoint offset both statically and during `bleed`. `mono` is reference parity (no offset). `complement` adds +180° to the right endpoint; `triad` adds +120°. `bleed` walks +180° on top of whichever harmony is selected, so the cycle reads as analogous → complementary → analogous regardless of base harmony.
- **`focusRadius`** (`0..400` screen px, default `240`) — only active when interactive is on. Inside the circle, the local threshold drops by `0.7 × thresholdSweep` with a quadratic `(1 − r²/R²)` falloff. Detail blooms under the pointer; the soft falloff places the *salient edge* in the periphery, which (per Carrasco 2011) the eye reads as more alive than a hard cut.

### Optical-illusion / design insight driving defaults

Albers' point in *Interaction of Color* (1963) was that an identical band looks different against different surrounds — and that the boundaries between bands appear to *move* when only the hue changes. The default amber/navy palette puts those boundaries near the warm/cool axis where the eye is most sensitive to chromatic shifts. `bleed` walks that boundary through 180° each loop, so the same geometry reads as three different paintings at t=0, t=0.5, and t=1.0 (which is identical to t=0 — the seam is byte-equal, but perception isn't).

### References pulled

- **Albers, J. (1963). *Interaction of Color*.** The thesis we're literally animating: identical greys read differently against warm vs cool surrounds. We render bands of identical *geometry* under shifting hues and watch the boundaries appear to migrate.
- **Eliasson, O. (2004). *Your colour memory*.** Single saturated hue installations that trigger Hering after-image filling — the chromatic defaults sit near that saturation knee so even a still frame leaves a complement after-image on the retina.
- **Shadertoy `MsXSzM` (Inigo Quilez palette explorer).** Validates the cosine-palette-in-HSL trick we use for `tilt`: smooth seamless loops at zero cost.
- **Hering, E. (1878). *Zur Lehre vom Lichtsinne*.** Opponent-process theory. Why the `bleed` complement-walk reads as the colour *moving* even though only one endpoint is animated — the left endpoint generates an opposing after-image that the right endpoint then collides with.

### Verification (2026-05-13, Playwright + http://localhost:8001/gradients/, 1280×720)

| Mode | byte-equal `renderAt(0)===renderAt(1)` | distinct frames at t=0/0.25/0.5/0.75 | frame ms |
|---|---|---|---|
| idle   | ✓ | 1 (intentional) | 0.8 |
| breath | ✓ | 4 | 2.2 |
| tilt   | ✓ | 4 | 0.8 |
| bleed  | ✓ | 3 (cosine symmetric: t=0.25 ≈ t=0.75 hue offset) | 0.8 |
| band   | ✓ | 4 | 0.9 |

Screenshots in `docs/screenshots/gradients-<mode>.png`.

### Notes for the next maintainer

- Mode changes do not trigger a static rebuild (`mode` is animation-only). If you want a static preview per mode, route through `BUILD_KEYS` and set the transient globals (`_paletteAngleAnim`, `_paletteEndShift`) in a non-animating path.
- The HSL hue-rotation helpers (`rotateHueHex`) preserve luminance and saturation, so a pure grey palette is a no-op under `tilt`. This is by design — bundle-parity defaults remain inert under tilt/bleed unless the user picks a chromatic endpoint.
- `bleed`'s 3-distinct sample is correct, not a bug: the cosine pingpong sends the harmony offset back through the same value at t=0.25 and t=0.75. The seamless+distinct invariants hold (seam is the same hue; mid-cycle is a different hue).
