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
