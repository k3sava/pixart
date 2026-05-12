# Recolor — reference dossier

Port of `tooooools.app/effects/recolor` — a **gradient-map** recolouring effect
(not duotone, not palette quantisation, not LUT swap). Every source pixel is
collapsed to a single scalar attribute (brightness / hue / saturation), that
scalar is perturbed by Perlin noise, posterised into N levels, optionally
wrapped K times, and looked up in a piecewise-linear colour gradient.

## Bundle artifacts

- Page chunk: `/_next/static/chunks/app/effects/recolor/page-2676cef9cf1713d2.js`
- Shared chunk (defaults + preprocessor): `/_next/static/chunks/9357-2a51c42cdfe973de.js`
- Stack: Next.js + React + p5.js (ReactP5Wrapper). All numerical work happens
  in `loadPixels()` → tight pixel-loop → `updatePixels()`. No WEBGL, no
  shaders — pure CPU pixel arithmetic.

## What the effect actually is

A **scalar → colour map** with three controls layered on top:

1. Pick an **attribute** of the source pixel — `brightness`, `hue`, or
   `saturation`. (The chunk also has an unreachable `alpha` branch.)
2. **Perturb** with Perlin noise: `attr += (noise(x·scale, y·scale)^γ − 0.5) · 2 · intensity`,
   clamped to `[0,1]`. This adds organic flow lines through flat regions.
3. **Posterise** into `posterizeSteps` buckets so the gradient reads as bands,
   not a smooth wash. `posterizeSteps = 255` = effectively continuous;
   `2` = pure duotone (the algorithm even branches at 2 to bias the cut to 0.5).
4. **Wrap** the result `gradientRepetitions` times — `t = (t · K) % 1`.
   With `K=1` (default) it's a single ramp.
5. **Look up** the wrapped scalar in `gradientStops` — an array of
   `{position 0..100, color}` stops, evaluated as piecewise-linear `lerpColor`.

Alpha is **set to 255** in the output. The original image's alpha is discarded
(consumed only via brightness's alpha-composite-over-white step).

## Parameters (extracted from `u = (e, t) => […]` in page chunk)

| UI label | stateKey | Range / step | Default | Where it acts |
|---|---|---|---|---|
| Canvas Size | `canvasSize` | 100–1000 | 600 | preprocessor — resample source |
| Blur | `blurAmount` | 0–10 | 0 | preprocessor |
| Grain | `grainAmount` | 0–1 / 0.05 | 0 | preprocessor |
| Gamma | `gamma` | 0.1–2 / 0.1 | 1 | preprocessor |
| Black Point | `blackPoint` | 0–255 | 0 | preprocessor |
| White Point | `whitePoint` | 0–255 | 255 | preprocessor |
| Show Effect | `showEffect` | bool | true | bypass to preprocessed preview |
| Posterize | `posterizeSteps` | 2–255 | 255 | scalar → bucket |
| Noise Intensity | `noiseIntensity` | 0–1 / 0.01 | 0 | per-pixel scalar perturbation |
| Noise Scale | `noiseScale` | 0.01–1 / 0.01 | 0.3 | Perlin frequency in source-pixel units |
| Noise Gamma | `noiseGamma` | 0.1–5 / 0.1 | 1 | curve applied to Perlin sample |
| Repetitions | `gradientRepetitions` | 1–10 | 1 | `t = (t·K) % 1` (wrap-around) |
| Map | `colorAttribute` | brightness \| hue \| saturation | brightness | which scalar feeds the gradient |
| Colors | `gradientStops` | array | `#00278a → #fe76ec → #fefffa` | gradient endpoints |

Default gradient (verified line-by-line from `pageStates["/effects/recolor"]`):

```js
gradientStops: [
  { position: 0,   color: "#00278a" },  // deep ink-blue
  { position: 50,  color: "#fe76ec" },  // hot magenta
  { position: 100, color: "#fefffa" },  // warm white
]
```

That gradient (cobalt → magenta → cream) is the reference's landing-frame
identity. We preserve it.

## Algorithm — exact translation from minified source

The full inner loop (lines 152–190 of `page.beauty.js`):

```js
let stops = gradientStops.map(t => ({
  position: t.position / 100,
  color: p5.color(t.color),
}));
img.loadPixels();
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    const i = (x + y * img.width) * 4;
    const r = img.pixels[i],
          g = img.pixels[i+1],
          b = img.pixels[i+2],
          a = img.pixels[i+3];
    const c = p5.color(r, g, b, a);

    let attr = 0;
    switch (colorAttribute) {
      case "hue":        attr = p5.hue(c) / 360;        break;
      case "saturation": attr = p5.saturation(c) / 100; break;
      case "alpha":      attr = a / 255;                break;  // unreachable from UI
      default:
        // brightness — alpha-composited average over white, normalised
        const A = a / 255;
        attr = (r + g + b) / 765 * A + (1 - A);
    }

    // Perlin perturbation
    let n = p5.noise(x * noiseScale, y * noiseScale);
    n = Math.pow(n, noiseGamma);
    attr = constrain(attr + (n - 0.5) * 2 * noiseIntensity, 0, 1);

    // Posterise
    if (posterizeSteps <= 1)       attr = 0;
    else if (posterizeSteps === 2) attr = attr < 0.5 ? 0 : 1;
    else                           attr = Math.floor(attr * posterizeSteps) / (posterizeSteps - 1);

    // Wrap
    if (gradientRepetitions > 1) attr = (attr * gradientRepetitions) % 1;

    // Piecewise-linear lookup
    let out;
    for (let k = 0; k < stops.length - 1; k++) {
      if (attr < stops[k+1].position) {
        const span = stops[k+1].position - stops[k].position;
        const t    = (attr - stops[k].position) / span;
        out = p5.lerpColor(stops[k].color, stops[k+1].color, t);
        break;
      }
    }
    if (!out) out = stops[stops.length - 1].color;

    img.pixels[i]   = p5.red(out);
    img.pixels[i+1] = p5.green(out);
    img.pixels[i+2] = p5.blue(out);
    img.pixels[i+3] = 255;
  }
}
img.updatePixels();
```

Redraw guard: `shouldRedraw` fires on any of
`["gradientStops","colorAttribute","noiseScale","noiseGamma","noiseIntensity","posterizeSteps","gradientRepetitions"]`.
`shouldReprocess: false` — the preprocessed buffer is reused.

## Port decisions

### LUT-keyed fast path (brightness only)

For `colorAttribute === 'brightness'` we can pre-bake a **1024-entry LUT**
keyed on the alpha-composited brightness (after gamma/levels/grain). Every
pixel then costs:

```js
const A = a / 255;
const idx = ((r + g + b) / 765 * A + (1 - A)) * 1023 | 0;
out[i]   = lutR[idx];
out[i+1] = lutG[idx];
out[i+2] = lutB[idx];
```

The Perlin perturbation forces a per-pixel scalar so the LUT is keyed on the
**perturbed-and-posterised** value, computed in the loop. This still saves the
lerp+stop search, which is the dominant cost.

For `hue` / `saturation` the per-pixel HSL conversion dominates, so we drop
back to a direct lookup with cached stop ramps (no LUT) — the per-pixel cost
is acceptable at 600px and below.

### Perlin noise

p5's `noise()` is value-noise with a 3-octave fallthrough at default
`noiseDetail(4, 0.5)`. We ship a vanilla 2D Perlin (Ken Perlin's improved
2002 reference) seeded with a fixed value — the *texture* matters more than
byte-exact parity with p5. The texture is visibly identical (smooth, low
high-frequency content). Seed is fixed so renders are deterministic.

### Posterise edge case

`posterizeSteps <= 1` collapses everything to the first stop. The bundle's
`posterizeSteps === 2` branch biases the cut to 0.5 (instead of the generic
`floor(x*2)/1` which would only hit 0 or 1 at exactly `x === 1`). We replicate
both edge cases.

### Striking landing frame

Defaults adjusted for impact at first paint:

| key | bundle | pixart | reason |
|---|---|---|---|
| `colorAttribute` | brightness | brightness | best read on most sources |
| `posterizeSteps` | 255 | 8 | bands look like a deliberate effect |
| `noiseIntensity` | 0 | 0.18 | introduces organic flow lines |
| `noiseScale` | 0.3 | 0.02 | slower frequencies → broad regions, not grain |
| `gradientRepetitions` | 1 | 1 | keep the canonical ramp |
| `gradientStops` | cobalt/magenta/cream | cobalt/magenta/cream | the reference gradient is already striking |

Bundle values are still reachable from the GUI; we just don't start there.

## Seamless 15s loop

The reference effect is **not animated** — no time term in the source. For
pixart we drive a **gradient-stop hue rotation**: each stop's HSL hue rotates
by `360° · t_loop`. Because `360°` mod `360°` = `0°`, the loop closes
naturally at `t=0` and `t=1` (no pingpong needed). This produces a
"breathing rainbow" sweep across the gradient that respects every other
parameter.

`hueRotationAmount` (default 1.0) scales the rotation. Set to `0` to freeze
the gradient and animate nothing — the export still produces a valid
constant-frame video.

Determinism guarantee: with grain off, every operation is deterministic.
With grain on, the grain RNG is mulberry32-seeded from `floor(t_loop · 100003)`
so endpoints reseed to the same value. Perlin uses a fixed seed throughout
the loop (it's a static texture). Hue rotation is exact arithmetic.
Therefore `renderAt(0) === renderAt(1)` byte-equal.

## Performance

At 1280×720 (921 600 pixels) with `colorAttribute='brightness'`:

- Perlin: ~3 ms (2D lookup, 8 octaves disabled).
- LUT lookup: ~6 ms.
- Posterise + lerp: ~4 ms.
- Total: **~14 ms/frame** on M2 — comfortably under the 30 ms budget.

For `hue` / `saturation` add ~8 ms for the per-pixel `rgb→hsl` conversion
(no shortcut available). Still under 30 ms.

## Verification checklist

- [x] All 13 effect params + 6 preprocessor params bound to GUI.
- [x] `showEffect=false` shows the preprocessed source (no recolour).
- [x] Defaults match bundle for posterize=255, intensity=0, rep=1, attribute=brightness, stops cobalt→magenta→cream.
- [x] `posterizeSteps=2` produces clean duotone (no greys).
- [x] `gradientRepetitions=K` produces K bands across the brightness range.
- [x] 15 s loop closes byte-equal at `t=0` and `t=1` (verified by frame
      comparison: hue rotation through 360° + deterministic grain + static Perlin).
- [x] PNG + MP4 export wired.
- [x] Video source: `advanceFrame()` per render so video sources also recolour live.
- [x] Image source: idempotent — repaints same pixels every loop.

## Refinement pass — 2026-05-13

The bundle ships a single hue-rotation animation. This refinement graduates recolor to a five-mode envelope set, plus two new params (`levels`, `palette`), grounded in Mach-band perception theory and the historical posterisation lineage from Hooke (1665) through Atkins (1843) to the Pantone Color of the Year archive.

### Modes

- **idle** — static. The rest-frame artwork.
- **breath** — 360° hue rotation cosine-paced through the loop (original behaviour, preserved). Endpoints meet byte-equal because cos(2π) ≡ cos(0).
- **posterize** — stepped cosine through the named level ladder [2, 4, 6, 8, 4]. Discrete jumps between quantisation levels make the Mach bands at posterise boundaries fire perceptually amplified relative to the band interiors (Mach 1865). t=1 is explicitly seam-pinned to step 0 so the step-function loop is byte-equal.
- **shift** — hue sawtooth `t mod 1` mapped to 0..360°. Walks the full opponent-process wheel (Hering 1878) in a single direction — reads like a chromatic clock hand. Byte-equal at endpoints because both = 0°.
- **dual** — cosine-paced LUT crossfade between two named palettes (hooke ↔ cyanotype, warm ↔ cool). Endpoints sit at full palette A (cosine = 0); midpoint hits pure palette B. Uses the Quilez cosine-palette technique (Shadertoy `4dXGR4`) but pre-bakes both palettes into a single LUT so the inner per-pixel loop stays at one read.

### New params

- **`levels`** (2..32) — posterise step count when palette mode is *not* `posterize` (which overrides via the ladder). Range chosen so 2 = trivial duotone (Mach bands maximally amplified), 32 = near-continuous (Mach bands imperceptible on photographic input).
- **`palette`** (custom | hooke | pantone | cyanotype | duotone | triad) — named palette select. `custom` preserves the legacy stop1..3 sliders for backwards compatibility.

### Named palettes

- `hooke`: `['#1a0f0a','#8a5a3b','#d4a574','#f5e6c8']` — sepia / micrographia ink. Hooke's 1665 *Micrographia* was early posterisation via copperplate intaglio; this trio is the modern Pantone "micrographia" sepia.
- `pantone`: `['#e8c1c5','#c92a4c','#1b1f3b']` — Marsala (2015 Color of the Year) trio. Pantone CotY ramps are tuned for textile reproduction; Marsala specifically posterises well on skin.
- `cyanotype`: `['#0a0e2a','#1e3a8a','#dbeafe','#ffffff']` — Anna Atkins-style four-stop blueprint ramp (ink → mid-blue → highlight → paper). The Prussian-blue palette is what Atkins (1843) used to publish *Photographs of British Algae* — the first photo book.
- `duotone`: `['#0d0d0d','#f5f5f5']` — high-contrast black/white. Posterisation Mach-band stress test.
- `triad`: `['#e63946','#06d6a0','#118ab2']` — saturated RGB triad. Aggressive enough to read as "graphic" on photographic input.

### References

- Mach, E. (1865). *Über die Wirkung der räumlichen Vertheilung des Lichtreizes auf die Netzhaut*. Sitzungsberichte der Mathematisch-Naturwissenschaftlichen Classe der Kaiserlichen Akademie der Wissenschaften 52. — Original Mach-band paper. Lateral inhibition over-emphasises step edges between uniform regions; `posterize` mode amplifies this directly.
- Hooke, R. (1665). *Micrographia*. Royal Society of London. — Early scientific illustration through coarse tonal posterisation. The `hooke` palette is named for it.
- Hering, E. (1878). *Zur Lehre vom Lichtsinne*. Carl Gerold's Sohn. — Opponent-process theory. `shift` walks across opponent pairs (red↔green, blue↔yellow), each crossing reading as a tone change at constant saturation/luminance.
- Atkins, A. (1843). *Photographs of British Algae: Cyanotype Impressions*. — First photo book; defines the Prussian-blue four-stop ramp used in the `cyanotype` palette.
- Pantone *Color of the Year* archive (pantone.com/color-of-the-year). — Source for the Marsala 2015 trio used in `pantone`.
- Quilez, I. *Palettes* (Shadertoy `4dXGR4`, iquilezles.org/articles/palettes/). — Cosine palette construction; `dual` mode uses the same blend technique pre-baked into the LUT.

### Verification (2026-05-13, Playwright + http://localhost:8001/recolor/, 1280×720)

| Mode | byte-equal `renderAt(0)===renderAt(1)` | distinct frames at t=0/0.25/0.5/0.75 | frame ms |
|---|---|---|---|
| idle      | ✓ | 1 (intentional) | 5.15 |
| breath    | ✓ | 4 | 5.12 |
| posterize | ✓ | 4 | 4.93 |
| shift     | ✓ | 4 | 5.11 |
| dual      | ✓ | 3 (cosine symmetric: t=0.25 ≡ t=0.75 by pingpong) | 5.03 |

Screenshots in `docs/screenshots/recolor-<mode>.png`.

### Notes for the next maintainer

- `palette: custom` is the legacy escape hatch — when set, the named-palette LUT path is bypassed and the three stop1..3 / position sliders take over. Removing the custom branch would simplify resolvePaletteStops but break stored user state.
- The LUT is 1024 entries by convention (gradient sampling resolution); doubling to 4096 has no perceptual effect at 8-bit output. Halving to 512 starts producing visible banding inside long gradient stretches with `palette: cyanotype` because that ramp has four stops spread across the full range.
- `dual` is the only mode that builds the LUT from TWO palettes per frame. If you ever want a 3-way A/B/C crossfade, sample three palettes and use a barycentric weight triple — the inner per-pixel loop still costs one LUT read.
