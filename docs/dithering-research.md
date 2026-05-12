# Dithering — reverse-engineering dossier

**Reference:** https://tooooools.app/effects/dithering
**Bundle inspected:** `/_next/static/chunks/app/effects/dithering/page-c651560ea284d530.js`
**Shared preprocessor + defaults:** `/_next/static/chunks/9357-2a51c42cdfe973de.js`
**Stack:** Next.js + React + p5.js. Same shared preprocessor module that powers Displace/Edge/Ascii.
**Date:** 2026-05-12.

## What the effect actually is

A canonical image-dithering pipeline. Source → preprocess → downsample to a low-res grid → quantise via one of three patterns → upsample back as solid `pixelSize × pixelSize` pixel-blocks. Operates on **images and videos** (not text — wordart's `dither` is a separate, typography-only effect that has nothing in common with this).

Three patterns ship in the bundle, two colour modes:

| Pattern | Mono behaviour | Colour behaviour |
|---|---|---|
| F-S (Floyd-Steinberg) | scale by 255/threshold, threshold-127, propagate 7/3/5/1 over 16 | nearest palette colour by weighted RGB distance, propagate RGB error 7/3/5/1 over 16 |
| Bayer | 4×4 Bayer matrix `[[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]]`; local threshold = `(t/128)·(M/16)·255` | two nearest palette colours; pick `M/16 < .5 ? a : b` |
| Random | local threshold = `t · random() · 2` | two nearest palette colours; pick `random() < .5 ? a : b` |

Atkinson and Sierra are **not** in the reference. We don't add them — that would expand surface area beyond what tooooools ships.

## Parameters (verbatim from the bundle)

Source: `/effects/dithering/page-*.js` lines 33–118 (UI config + `h` builder), 122–143 (palette `p(n)`), 145–151 (nearest-pair `g`), 152–367 (sketch `m` + `shouldRedraw` predicate). Defaults in `9357-*.js`.

| Name (UI) | stateKey | Range | Bundle default | This port default | Where it acts | Why |
|---|---|---|---|---|---|---|
| Canvas Size | `canvasSize` | 100–1000 | 600 | 600 | preprocessor resample | resolution / cell count tradeoff |
| Blur | `blurAmount` | 0–10 | 0 | 0 | preprocessor | pre-smooth before quantising |
| Grain | `grainAmount` | 0–1 step .05 | 0 | 0 | preprocessor | adds noise → richer F-S dither pattern |
| Gamma | `gamma` | 0.1–2 | 1 | 1 | preprocessor | midtone curve before quantise |
| Black Point | `blackPoint` | 0–255 | 0 | 0 | preprocessor | levels lo |
| White Point | `whitePoint` | 0–255 | 255 | 255 | preprocessor | levels hi |
| Show Effect | `showEffect` | bool | true | true | bypass | inspect preprocessor output |
| Pattern | `patternType` | F-S / Bayer / Random | F-S | F-S | algorithm choice | the three patterns ship in the bundle |
| Pixel Size | `pixelSize` | 1–20 | **2** | **4** | grid stride | how big each dither block is. Bundle ships 2 (very fine, looks like noise from a glance); we bump to 4 so the dithering is *visible* on landing without scrolling/zooming. |
| Color Mode | `colorMode` | bool | false | false | mono vs palette | mono is the iconic dithering look — print, e-ink, MacPaint |
| Threshold | `lightnessThreshold` | 0–255 | 255 | 255 | F-S exposure / Bayer-Random gate | shown only when `colorMode=false` (mutually exclusive in bundle's `h` builder). Default 255 gives standard 127-pivot for F-S mono and the widest threshold range for Bayer. |
| Color Count | `colorCount` | 2–32 | 24 | 24 | palette size | shown only when `colorMode=true`. 24 gives a usable 4-colour-cube + black + white. |

Additions for the pixart contract (not in the reference):

| Name | Range | Default | Why |
|---|---|---|---|
| Sweep depth | `pixelSweep` | 0–20 | 6 | Amplitude of `pixelSize` pingpong during animation. 0 = static loop. |
| Animate | bool | false | pixart contract — 15s seamless loop. |
| Interactive | bool | false | pixart contract — mouse XY drives threshold + pixelSize. |

## Palette generation (`p(n)` from the bundle)

Always seeds **black + white** first, then fills the remainder with a uniform 3D colour-cube:

```
r = ceil((n - 2) ^ (1/3))
step = 255 / (r - 1)
for l in [0..r), m in [0..r), a in [0..r):
  if (l,m,a) == (0,0,0) or (r-1,r-1,r-1): skip   // already covered by B+W
  push { r: l*step, g: m*step, b: a*step }
  if palette.length == n: stop
```

So:
- `colorCount=2` → exact mono (black + white)
- `colorCount=8` → black, white, and the six unique colour-cube corners (the classic 8-bit-Mac duotone palette)
- `colorCount=24` (default) → the bundle's "useful" palette; ~3 levels per channel after the corners

## Algorithm — exact translation from minified source

The bundle ships the algorithm as `m = E(function(e,t,r){…})` where `E` is the
shared sketch-runner from `9357-*.js`. Beautified inner loop:

```js
// Downsample to grid of (W/pixelSize) × (H/pixelSize) cells.
// Each cell averages its source rect with alpha-composited-over-white blend.
let u = downsample(image, pixelSize, colorMode);

// Apply pattern.
switch (patternType) {
  case "F-S":
    if (colorMode) fsColor(u, palette(colorCount));
    else            fsMono(u, threshold);
    break;
  case "Bayer":
    if (colorMode) bayerColor(u, palette(colorCount));
    else            bayerMono(u, threshold);
    break;
  case "Random":
    if (colorMode) randColor(u, palette(colorCount));
    else            randMono(u, threshold);
    break;
}

// Upsample: emit one {x,y,w,h,fill} rect per cell into `f` (`_rectangles`).
```

F-S mono in the bundle (lines 246–256):

```js
function fsMono(grid, threshold) {
  let s = 255 / threshold;
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      let i = x + y*gw;
      let v = Math.min(255, grid[i] * s);
      let q = v > 127 ? 255 : 0;
      grid[i] = q;
      let e = v - q;
      if (x+1 < gw)               grid[i+1]      += 7*e/16 / s;
      if (x-1 >= 0 && y+1 < gh)   grid[i+gw-1]   += 3*e/16 / s;
      if (y+1 < gh)               grid[i+gw]     += 5*e/16 / s;
      if (x+1 < gw && y+1 < gh)   grid[i+gw+1]   += 1*e/16 / s;
    }
}
```

The `/ s` on each error term is the quirk that makes `threshold` work as an exposure control rather than a hard cutoff. At `threshold=255` it's a no-op (s=1, standard 127-pivot F-S). At `threshold=128` everything brighter than 64 in the source quantises to white — the dither field shifts toward highlights. This is also why the bundle's `lightnessThreshold` default sits at 255 (= "neutral exposure").

F-S colour (lines 211–244):

```js
let weights = { r: .299, g: .587, b: .114 };
function nearestColor(r, g, b, palette) {
  let bd = Infinity, best;
  for (let p of palette) {
    let dr = (r - p.r) * weights.r;
    let dg = (g - p.g) * weights.g;
    let db = (b - p.b) * weights.b;
    let d = dr*dr + dg*dg + db*db;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
// Then 7/3/5/1 propagation of (orig - quantised) per channel, clamped.
```

Bayer mono (lines 278–290) — the 4×4 matrix is hard-coded in two places (mono + colour variants):

```js
const M = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
for (let y = 0; y < gh; y++)
  for (let x = 0; x < gw; x++) {
    let i = x + y*gw;
    let local = (threshold / 128) * (M[y%4][x%4] / 16) * 255;
    grid[i] = grid[i] > local ? 255 : 0;
  }
```

Random mono (lines 305–311):

```js
for (let y = 0; y < gh; y++)
  for (let x = 0; x < gw; x++) {
    let i = x + y*gw;
    let local = threshold * Math.random() * 2;
    grid[i] = grid[i] > local ? 255 : 0;
  }
```

Pageinvalidation predicate (lines 361–367):

```js
let r = ["pixelSize", "lightnessThreshold", "patternType", "colorMode", "colorCount"]
        .some(r => e[r] !== t[r]);
return { shouldRedraw: r, shouldReprocess: r };
```

Defaults block (`9357-*.js`):

```js
"/effects/dithering": {
  showEffect: !0,
  lightnessThreshold: 255,
  patternType: "F-S",
  pixelSize: 2,
  colorMode: !1,
  colorCount: 24
}
```

## Divergences in this port (and why)

| Reference | This port | Reason |
|---|---|---|
| `pixelSize` default = 2 | 4 | Bundle's 2 looks like fine noise on landing — the dithering pattern isn't legible without a closer look. 4 makes the algorithm visibly *itself* on first paint. |
| Threshold + colorCount mutually exclusive in UI | Both rows always present | The bundle hides whichever is irrelevant via the `h` builder's spread. Our GUI doesn't have conditional rows; the inactive value is simply ignored by the active code path. Acceptable surface trade. |
| p5 `random()` (non-deterministic) for Random pattern | mulberry32 seeded from `t_loop` | Required for byte-equal loop endpoints. |
| `pow()` per pixel for gamma | 256-entry LUT | Shared with Displace/Edge; ~10× faster. |
| Image only | `PIXSource.isVideo()` → `advanceFrame()` per RAF | pixart contract. |
| Static (no time dimension) | 15s `pixelSize` pingpong when `animate` is on | pixart contract. See below for why this knob and not threshold. |
| `t.fill()` per cell with p5 colour objects | Flat `Float32Array` rect-list + `fillStyle = 'rgb(r,g,b)'` | ~3× faster paint loop. The bundle's `_rectangles` array is the equivalent data shape; we just stay packed instead of allocating per-rect objects. |
| Cells are `{x:x+w/2, y:y+h/2, …}` (centre) | Cells are `{x:x0, y:y0, …}` (top-left) | The bundle stores centres but draws via `t.rect(s, u, d-s, h-u)` (top-left) — the centre field is for the click-handler hit-test, not paint. We don't have that handler; storing top-left simplifies the draw. |
| Sub-pixel seams visible at non-integer scale | 0.5-px overlap pad | Necessary when canvas scale isn't an integer multiple of the grid step. Reference renders 1:1 in p5 so this never bites it. |

## Why pixelSize-sweep animation (not threshold or pattern rotation)

Three candidate axes for an effect that's statically defined in the reference:

1. **Threshold sweep.** Works for F-S (exposure shifts) and Bayer (matrix biases), but the bundle ships threshold at 255 — sweeping toward 0 clips the F-S dither into pure black abruptly. Visually a "fade-out" that ends in nothing. Rejected.
2. **Pattern rotation** (F-S → Bayer → Random → F-S). Causes hard discontinuities in the dither field — Bayer's structured grid is visually nothing like F-S's diffusion noise. The cut between them at loop midpoints looks broken, not animated. Rejected.
3. **`pixelSize` pingpong** (4 → 10 → 4). Each step is a continuous re-scale of the dither field; the dot-grain breathes. Reads as deliberate motion (think early-2000s music-video glitch transitions). **Shipped.**

The cosine pingpong `(1-cos(2πt))/2` guarantees byte-equal endpoints because `cos(0) == cos(2π)` is enforced by an explicit `if(w === 1) w = 0;` wrap before the trig call.

## Performance notes

At `canvasSize=600, pixelSize=4`, grid is 150 × (H/4) ≈ 11k cells:

- preprocess: 600·H·4 ≈ 1.4M ops; ~4 ms
- downsample: 11k cells × ~16 pixel reads; ~3 ms
- F-S mono: 11k cells, serial — ~5 ms (can't be vectorised; each cell reads errors written by neighbours)
- Bayer / Random: ~1 ms each (trivially parallel)
- paint: 11k `fillRect` calls; ~4 ms
- **Total per frame ≈ 12–16 ms** — well under 30 ms budget.

Worst case (`canvasSize=1000, pixelSize=1, F-S colour, colorCount=32`):
- grid: 1M cells, palette: 32 colours
- F-S colour: ~80 ms — too slow for live RAF
- Acceptable for export; the reference has the exact same property (no GPU shader path). Users are expected to leave `pixelSize ≥ 2`.

The `Random` pattern uses `_rng` (seeded mulberry32) only when `params.animate` is on or grain is in play. In idle scrub mode we use `Math.random` directly — same as the reference — so the dither field re-rolls on every interactive build. This is deliberate (matches the bundle's behaviour: drag the slider, see the noise re-roll) and is what makes "Random" feel distinct from Bayer at runtime.

## What we explicitly did NOT add

- **Atkinson / Sierra / Stucki / Jarvis-Judice-Ninke.** The bundle doesn't ship these. Adding more error-diffusion kernels would expand surface area without matching the reference identity. (F-S is the canonical one anyway.)
- **8×8 or 16×16 Bayer matrices.** Bundle ships 4×4 only.
- **Hue-preserving quantization** (LAB / OKLab nearest-colour). Bundle uses weighted-RGB Euclidean, which is the "BT.601 luma weights" hack. Faster and matches the bundle's output exactly.
- **Per-channel mono dither** (R/G/B channels dithered separately). Out of scope; this would be a fundamentally different look.
- **Palette presets** (Game Boy, Mac, NES). The reference exposes `colorCount` as a scalar instead — same idea, less surface area.

These were called out as possibilities; skipping them keeps the port faithful to what tooooools ships.
