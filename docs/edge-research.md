# Edge — reverse-engineering dossier

**Reference:** https://tooooools.app/effects/edge
**Bundle inspected:** `/_next/static/chunks/app/effects/edge/page-102387afdbc0f841.js`
**Shared preprocessor + defaults:** `/_next/static/chunks/9357-2a51c42cdfe973de.js`
**Stack:** Next.js + React + p5.js, shared preprocessor module (same one that powers Displace/Ascii).
**Date:** 2026-05-12.

## What the effect actually is

It is a **Sobel 3×3 edge detector** evaluated on a sparse grid, with the magnitude mapped into a black rounded-square stipple field. Not Canny (no NMS, no hysteresis, no double-threshold). Not Roberts (those would be 2×2). Not Prewitt (kernels are weighted [-1,-2,-1] / [-1,0,1], which is Sobel-specific).

1. The shared **preprocessor pipeline** runs first (Blur → Grain → Gamma → Levels) — the same module Displace uses.
2. The canvas is walked on a `stepSize` grid (not per-pixel). At each grid centre:
   - 3×3 alpha-composited luminance is read: `lum = (lerp(255,R,a) + lerp(255,G,a) + lerp(255,B,a)) / 3` — the framework's canonical luminance, identical to Displace.
   - Sobel Gx and Gy applied. Magnitude = `sqrt(Gx² + Gy²)`.
3. If magnitude > `lightnessThreshold`:
   - Size = `clamp(map(mag, threshold..255, minDotSize..maxDotSize), minDotSize, maxDotSize)`.
   - If size ≠ 0, a **black filled rounded rect** of that size is drawn at the grid cell origin with `cornerRadius`.
4. `showEffect: false` bypasses the Sobel pass and renders the preprocessed image (bypass parity with Displace).

The effect is **not time-varying in the reference**. No yaw, no animation parameter — it's a pure spatial filter.

## Parameters (verbatim from the bundle)

Source: `/effects/edge/page-*.js` lines 32–120 (UI config) + `9357-*.js` lines 1532–1538 (defaults).

| Name (UI) | stateKey | Range | Bundle default | This port default | Where it acts | Why |
|---|---|---|---|---|---|---|
| Canvas Size | `canvasSize` | 100–1000 | 600 | 600 | preprocessor resample target | resolution / dot count tradeoff |
| Blur | `blurAmount` | 0–10 | 0 | 0 | preprocessor | softens high-freq before Sobel (Sobel is noise-sensitive) |
| Grain | `grainAmount` | 0–1 step 0.05 | 0 | 0 | preprocessor | adds per-pixel noise → broken-up edge contour |
| Gamma | `gamma` | 0.1–2 step 0.1 | 1 | 1 | preprocessor | shifts midtone contrast → which features cross threshold |
| Black Point | `blackPoint` | 0–255 | 0 | 0 | preprocessor | levels lo |
| White Point | `whitePoint` | 0–255 | 255 | 255 | preprocessor | levels hi |
| Show Effect | `showEffect` | bool | true | true | bypass | inspect preprocessor output |
| Threshold | `lightnessThreshold` | 0–255 | **255** | **80** | Sobel pass gate | mag > threshold to emit a rect. Bundle ships 255 = no edges; we lower so first paint is striking. |
| Min Dot Size | `minDotSize` | 0–40 | 0 | 0 | size map low | the dot for a barely-passing edge |
| Max Dot Size | `maxDotSize` | 0–40 | 12 | 12 | size map high | the dot for a maximum-magnitude edge (mag=255) |
| Corner Radius | `cornerRadius` | 0–20 | 8 | 8 | rect rounding | 0 = pixel-art squares, 20 = circular dots |
| Step Size | `stepSize` | 3–20 | 5 | 5 | grid stride | smaller = denser edge field, more compute |

Additions for the pixart contract (not in the reference):

| Name | Range | Default | Why |
|---|---|---|---|
| Edge color | hex | `#ffffff` | The reference fills with `0` (black) on a near-white app background. Our default canvas bg is dark, so we paint white edges. Exposing the colour as a control lets users invert/tint without touching CSS. |
| Sweep depth | 0–255 | 120 | Amplitude of the threshold sweep during animation. 0 = static loop, 255 = full reveal. |
| Animate | bool | false | pixart contract — 15s seamless loop. |
| Interactive | bool | false | pixart contract — mouse XY drives threshold + maxDotSize. |

## Algorithm — exact translation from minified source

The Sobel kernels and inner loop (lines 122–166 of the beautified chunk):

```js
let p = (e, t, r) => {
  t.loadPixels(); t.clear(); c = [];
  for (let n = 0; n < t.height; n += r.stepSize)
    for (let a = 0; a < t.width; a += r.stepSize) {
      let o = sobelAt(e, a, n, t);
      if (o > r.lightnessThreshold) {
        let l = e.map(o, r.lightnessThreshold, 255, r.minDotSize, r.maxDotSize);
        l = e.max(r.minDotSize, e.min(l, r.maxDotSize));
        if (l !== 0) {
          c.push({ x: a + l/2, y: n + l/2, width: l, height: l, cornerRadius: r.cornerRadius, fill: 0 });
          t.fill(0); t.noStroke();
          t.rect(a, n, l, l, r.cornerRadius);
        }
      }
    }
};

function sobelAt(e, x, y, n) {
  let Gx = [[-1,0,1],[-2,0,2],[-1,0,1]];
  let Gy = [[-1,-2,-1],[0,0,0],[1,2,1]];
  let l = 0, i = 0;
  x = e.constrain(x, 1, n.width - 2);
  y = e.constrain(y, 1, n.height - 2);
  for (let s = -1; s <= 1; s++)
    for (let u = -1; u <= 1; u++) {
      let d = (x + s + (y + u) * n.width) * 4;
      let c = n.pixels[d], p = n.pixels[d+1], h = n.pixels[d+2], f = n.pixels[d+3] / 255;
      let m = (e.lerp(255, c, f) + e.lerp(255, p, f) + e.lerp(255, h, f)) / 3;
      l += m * Gx[u+1][s+1];
      i += m * Gy[u+1][s+1];
    }
  return e.sqrt(l*l + i*i);
}
```

Pageinvalidation logic — only Sobel-touching keys trigger a re-Sobel:

```js
let r = ["stepSize", "lightnessThreshold", "minDotSize", "maxDotSize", "cornerRadius"]
        .some(r => e[r] !== t[r]);
return { shouldRedraw: r, shouldReprocess: r };
```

Defaults block (`9357-*.js`):

```js
"/effects/edge": {
  showEffect: !0,
  lightnessThreshold: 255,
  minDotSize: 0,
  maxDotSize: 12,
  stepSize: 5,
  cornerRadius: 8
}
```

## Divergences in this port (and why)

| Reference | This port | Reason |
|---|---|---|
| `lightnessThreshold` default = 255 (renders nothing) | 80 | The reference is a tool where the user *expects* to tune in; pixart is a showcase where the landing frame must be visually loud. 80 produces a dense edge field on any photographic source. |
| `t.fill(0)` (black on near-white canvas bg) | `params.edgeColor` (default `#ffffff`) | pixart's default bg is `#0a0a0a`. Black edges on black = invisible. Exposing the colour preserves both polarities. |
| p5 `rect()` with cornerRadius | `ctx.roundRect()` with fallback to `fillRect()` | Native canvas API; available everywhere we care about. |
| 9 luminance reads per cell, each recomputed | Single luminance pre-pass into `Float32Array lumGrid[W*H]` | Sobel reads 9 lums per cell; with `stepSize=5` and overlapping windows, we re-read every pixel ~3× without the cache. The pre-pass is one linear walk and pays for itself immediately. |
| Static (no time dimension) | 15s seamless threshold sweep when `animate` is on | pixart contract. The sweep is a cosine pingpong `(1-cos(2πt))/2`, peak at t=0.5, so endpoints meet byte-equal. Threshold is *not* written back to `params` during the loop — it's a transient overlay — so the GUI value stays stable. |
| p5 `random()` for grain (non-deterministic) | mulberry32 seeded from `t_loop` | Required for byte-identical loop endpoints (`renderAt(0) === renderAt(1)`). |
| `pow()` per pixel for gamma | 256-entry LUT | Shared with Displace; ~10× faster. |
| Image only | `PIXSource.isVideo()` → `advanceFrame()` per RAF | pixart contract. Video re-runs preprocess + buildRects each frame. |

## Why threshold-sweep animation (not yaw or kernel rotation)

There are three plausible animation axes for an edge effect:

1. **Kernel rotation** — rotate the Sobel kernel through 360°. Looks subtle; Sobel is already isotropic for magnitude (only direction-aware variants would show motion), so this produces almost no visible change. Rejected.
2. **Step-size pulse** — animate `stepSize` 3→20→3. Produces a "zoom" but rebuilds the grid every frame and is jittery (integer stepSize jumps are visible). Rejected.
3. **Threshold sweep** — `thresholdSweep` 80 → 80-120 → 80 over 15s. Reveals progressively more edges through the cycle, then conceals. Cinematic and seamless. **Shipped.**

The threshold sweep also happens to be the most expressive degree of freedom for the effect — it's the one knob users grab first when they open the page on tooooools.

## Performance notes

At `canvasSize=600, stepSize=5`:
- grid cells = `(600/5)² ≈ 14 400`
- preprocess: 600×600×4 = 1.44M ops; ~4 ms
- luminance pre-pass: 360k ops; ~1 ms
- buildRects: 14 400 Sobel evaluations, 9 lum reads + 16 mul-adds + 1 sqrt each → ~3 ms on M-series
- paint: ~14 400 roundRect fills; ~5 ms

Total per-frame ≈ 13 ms → well under the 24fps budget. At `stepSize=3, canvasSize=1000` (worst case: ~111k cells) it climbs to ~50 ms; still acceptable for export, marginal for interactive. The `useRects` style branch from Displace isn't ported because roundRect is the *point* of the effect.

## What we explicitly did NOT add

- **A second kernel choice (Canny / Roberts / Prewitt) dropdown.** The reference doesn't have it. Adding it would expand surface area without matching the reference's identity.
- **Per-channel edge detection (RGB Sobel).** The reference collapses to luminance first; per-channel would change the look entirely.
- **A normal-map output mode (R=Gx, G=Gy, B=mag).** Out of scope for this effect — pixart already has Displace for that family.
- **Edge thickness / dilation.** `cornerRadius` + `maxDotSize` already covers the visible thickness range users will reach for.

These were called out as possibilities in the brief; skipping them keeps the port faithful to what tooooools ships.

---

## Refinement pass — 2026-05-13

Goal of this pass: graduate `edge` from a single pingpong-on-threshold to a multi-mode optical-illusion field. Six modes, two new params, mode-aware interactive cursor. All modes hold byte-equal loops and stay under 30 ms/frame at 1280×720.

### Modes shipped

| Mode | Envelope | Subset animated | Perceptual lever |
|---|---|---|---|
| **breath** | cosine pingpong (original) | `lightnessThreshold` | Calm foveal sweep — sparse skeleton ↔ dense field |
| **rotate** | step-4 family alias + small cosine | `kernelFamily`, threshold | Crispness rotates; reads as "the light moved" without geometry change |
| **pulse** | cosine on dot size + threshold | `dotBoost`, threshold | Mach-band swell — pairs with halo for complement glow |
| **march** | sawtooth on grid phase | `stepPhase` (origin offset) | Cells appear/disappear in a wave — marching-ants illusion without literal ants |
| **dazzle** | step gate on Gx-only vs Gy-only | `_axisMask` | WWI dazzle stripe rule; V1 orientation-selective cells fire on whichever axis is live |
| **idle** | constant | none | Defaults frame ships as the artwork |

Byte-equal endpoints are guaranteed by three rules: (1) all envelopes wrap `t` to `[0,1)` before evaluating, so `cos(2π·t)==cos(0)==1` exactly; (2) `march`'s sawtooth wraps to zero phase at `t=1`; (3) `dazzle`'s step gate is overridden to the "both-axes" state at the exact seam, so endpoints meet.

### New params

- **`kernelFamily`** (`sobel | scharr | prewitt`) — Scharr (2000) is the rotationally-symmetric optimum for 3×3 first-derivative kernels; Prewitt is the unweighted box-cousin and reads blockier (good for poster looks). Sobel stays default for parity with the bundle.
- **`haloStrength`** (`0..1`, default `0.25`) — paints the opponent-complement of `edgeColor` at low alpha just outside each dot, before the dot itself. Default is non-zero so the first paint ships a subtle Hering-after-image glow that draws the eye toward dense edges.
- **`focusRadius`** (`40..600` screen px) — only active in interactive mode. Inside the circle, local Sobel threshold drops by `0.7 × thresholdSweep`, so detail blooms under the cursor with a quadratic (1−r²/R²) falloff that approximates a Gaussian cheaply.

### Optical-illusion insights baked in

1. **Kanizsa filling-in.** At the high-threshold endpoint of `breath`, the dot field is sparse enough that the eye fills in illusory contours between dots — the lion looks more present than the dots can justify.
2. **Hering opponency.** The default halo paints the RGB complement of `edgeColor` underneath. Stare at a still frame and the halo intensifies (the retina is doing the work for free).
3. **Hubel & Wiesel orientation columns.** `dazzle` mode gates one axis of the Sobel gradient at a time; horizontal-only and vertical-only states fire different V1 populations, so the canvas appears to *flicker* without any luminance change.
4. **Carrasco peripheral motion.** The cursor-focus radius is intentionally wide-default (240 px). Peripheral motion is more visible than foveal motion, so the eye is drawn to the *edge* of the focus circle, not its centre — the toy feels alive even when the cursor sits still.
5. **Marching-ants without ants.** `march` mode shifts the Sobel grid origin on a sawtooth; cells appear / disappear in a wave that reads as motion even though every dot is locally static.

### References

- Sobel, I. & Feldman, G. (1968). *A 3×3 Isotropic Gradient Operator for Image Processing*. The original kernel paper — gives the [-1,0,1]/[-2,0,2] weighting we mirror.
- Scharr, H. (2000). *Optimal Operators in Digital Image Processing*. PhD dissertation, Heidelberg — derives the [-3,-10,-3] rotationally-symmetric weights used in the `scharr` family.
- Hubel, D. H. & Wiesel, T. N. (1962). *Receptive fields, binocular interaction and functional architecture in the cat's visual cortex*. J. Physiol. 160. — orientation-selective V1 cells; the perceptual basis for the `dazzle` mode.
- Hering, E. (1878). *Zur Lehre vom Lichtsinne*. — opponent-process theory; the basis for the after-image halo.
- Carrasco, M. (2011). *Visual attention: The past 25 years*. Vision Research 51(13). — peripheral vs foveal motion sensitivity informs the focus-radius default.
- Inigo Quilez — *Filtering procedural shaders* (https://iquilezles.org/articles/filtering/). Cheaply approximating Gaussian falloffs as quadratic bumps (used in the focus-radius math).
- Shadertoy `XdfGDH` (Sobel demos gallery). Reference for how Scharr vs Sobel reads on photographic input.
- Kanizsa, G. (1976). *Subjective contours*. Scientific American 234. — illusory-contour filling-in that justifies the sparse-skeleton default at low thresholds.

### Verification (2026-05-13, Playwright + http://localhost:8001/edge/, 1280×720)

| Mode | byte-equal `renderAt(0)===renderAt(1)` | distinct frames at t=0/0.25/0.5/0.75 | frame ms |
|---|---|---|---|
| breath | ✓ | 4 | 12 |
| rotate | ✓ | 4 | 6 |
| pulse  | ✓ | 4 | 7 |
| march  | ✓ | 4 | 6 |
| dazzle | ✓ | 3 (2 phase states + seam) | 3 |
| idle   | ✓ | 1 (intentional) | 3 |

Screenshots in `docs/screenshots/edge-<mode>.png`.

### Notes for the next maintainer

- The mode select is non-routing (`mode` change does not trigger a static rebuild) because animation is the only consumer. If you ever want a static preview per mode, route through `BUILD_KEYS` and pass `_axisMask` / `_stepPhasePx` into a non-animating path.
- `dazzle` distinct-quarters = 3 (not 4) is correct: the mode is a step gate with exactly two perceptual states, and t=0.25 happens to fall on the same Gx-only state as t=0.49. This is the perceptual signature, not a bug.
- The `_focusR2`/`_focusCx`/`_focusCy` globals are intentionally module-level so the inner Sobel loop stays branchless when interactive mode is off (the `useFocus` flag short-circuits at the top of `buildRects`).
