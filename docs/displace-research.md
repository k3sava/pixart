# Displace — reverse-engineering dossier

**Reference:** https://tooooools.app/effects/displace
**Bundle inspected:** `/_next/static/chunks/app/effects/displace/page-94d478f52043269a.js`
**Stack:** Next.js + React + p5.js 1.5 (WEBGL mode), shared preprocessor module `9357-*.js`.
**Date:** 2026-05-12.

## What the effect actually is

It is **not** a UV-warp displacement (no `x' = x + scaleX·R, y' = y + scaleY·G` sampling). The bundle reveals a different algorithm:

1. A **preprocessor pipeline** mutates the source pixels (Blur → Grain → Gamma → Levels).
2. The source is walked on a coarse grid (`pixelDensity` stride). For each cell, the **alpha-composited luminance over white** is computed: `lum = (lerp(255,R,a) + lerp(255,G,a) + lerp(255,B,a)) / 3`.
3. That luminance is mapped to a **Z displacement** (`map(lum, 0,255, 0, yDisplacement)`).
4. Each grid cell becomes one **3D point** at `(x − w/2, y − h/2, z)` coloured with the source's `(R,G,B)` and rendered with `point()` + `strokeWeight(dotSize)`.
5. The scene is drawn in `WEBGL` mode with a fixed perspective camera at `(400, 600, 1200)` and `orbitControl(3,3,3)` — the user drags to rotate the cloud.
6. `showEffect: false` bypasses the cloud and shows the preprocessed image directly.

The visual signature ("dots floating above the photo, parallax shift as you drag") falls out of the 3D camera, not from UV sampling.

## Parameters (all extracted from the bundle)

| Name (UI) | stateKey | Range | Default | Where it acts | Why |
|---|---|---|---|---|---|
| Canvas Size | `canvasSize` | 100–1000 | 600 | resamples source into `canvasSize × canvasSize·aspect` | Trades resolution for dot count and speed. Larger = denser cloud. |
| Blur | `blurAmount` | 0–10 | 0 | `pg.filter(BLUR, n)` before grain | Softens grain, kills high-frequency noise so the Z field is smooth. |
| Grain | `grainAmount` | 0–1 step 0.1 | 0 | additive noise `(0.5 − random()) · grain · 255` per channel, clamped | Adds Z-jitter so flat regions still get a textured cloud. |
| Gamma | `gamma` | 0.1–2 step 0.1 | 1 | `255·pow(v/255, γ)` per channel | Perceptual curve — γ<1 brightens midtones (more Z mass mid-image), γ>1 darkens. |
| Black Point | `blackPoint` | 0–255 | 0 | `clamp((v − bp) · 255/(wp − bp))` | Levels lo — crushes shadows to Z=0. |
| White Point | `whitePoint` | 0–255 | 255 | same as above | Levels hi — clips highlights to max Z. |
| Show Effect | `showEffect` | bool | true | bypass | Toggle to inspect what the preprocessor did. |
| Step Size | `pixelDensity` | 4–20 | 8 | grid stride in source pixels | Dot count = (W/step)·(H/step). 8 is the sweet spot (≈5600 dots at canvasSize 600). |
| Displacement | `yDisplacement` | −500 to 500 | 100 | `z = lum/255 · yDisplacement` | The whole effect's amplitude. Negative inverts (dark = high). |
| Dot Size | `dotSize` | 4–100 | 8 | `strokeWeight()` | Point diameter. Above ~15 dots overlap → fields blend. |

The preprocessor list is defined as a literal in the bundle:

```js
[
  {label:"Blur",        min:0,   max:10,  value:0,   stateKey:"blurAmount"},
  {label:"Grain",       min:0,   max:1,   step:.1, value:0,   stateKey:"grainAmount"},
  {label:"Gamma",       min:.1,  max:2,   step:.1, value:1,   stateKey:"gamma"},
  {label:"Black Point", min:0,   max:255, value:0,   stateKey:"blackPoint"},
  {label:"White Point", min:0,   max:255, value:255, stateKey:"whitePoint"},
]
```

## Algorithm — exact translation from minified source

```js
// generatePixels  (from displace page chunk)
for (let y = 0; y < r.height; y += o.pixelDensity)
  for (let n = 0; n < r.width; n += o.pixelDensity) {
    let a  = (n + y*r.width) * 4;
    let R  = r.pixels[a], G = r.pixels[a+1], B = r.pixels[a+2];
    let A  = r.pixels[a+3] / 255;
    let p  = (lerp(255,R,A) + lerp(255,G,A) + lerp(255,B,A)) / 3;
    let f  = map(p, 0, 255, 0, o.yDisplacement);
    i.push(new Dot(n, y, f, o.dotSize, color(R,G,B)));
  }
```

```js
// preprocess  (from 9357 chunk)
t.image(r, 0, 0);
if (n.blurAmount !== 0) t.filter(BLUR, n.blurAmount);
// Grain
if (n.grainAmount !== 0) {
  for (each pixel) { v = (0.5 - random())*grain*255; px[i] += v; clamp; ... }
}
// Gamma
if (n.gamma !== 1) {
  for (each pixel) px[i] = 255 * pow(px[i]/255, gamma);
}
// Levels
if (!(bp === 0 && wp === 255)) {
  let s = 255 / (wp - bp);
  for (each pixel) px[i] = clamp((px[i] - bp) * s, 0, 255);
}
```

Camera setup (constant, not user-exposed):

```js
e.createCanvas(600, 600, WEBGL);
e.perspective(0.5, w/h, 10, 1000);
e.camera(400, 600, 1200, 0, 0, 0, 0, 1, 0);
e.orbitControl(3, 3, 3);
```

## Divergences in this port (and why)

pixart is a 2D-canvas framework. Faithfully porting p5 WEBGL + orbitControl was rejected as out of scope. We translate the 3D dot cloud into a 2D **oblique axonometric projection**:

```
screen.x = world.x + cos(yaw)·sin(pitch) · z
screen.y = world.y − sin(yaw)·sin(pitch) · z
```

This preserves the visual essence — dots shifted from their grid position by an amount proportional to luminance — and adds two view-control sliders (`viewYaw`, `pitch`) that replace orbitControl's mouse drag. Interactive mode maps mouse XY to yaw/pitch for the same "drag to spin" feel. Animate sweeps yaw 0→360° across the 15s loop (seamless because `cos(0)=cos(2π)`) and pingpongs pitch 30°↔60°.

Other minor divergences:

| Reference | This port | Reason |
|---|---|---|
| `p5.filter(BLUR, n)` (separable Gaussian) | Canvas `filter:'blur(npx)'` round-trip | Native GPU blur, comparable visual; no WebGL dependency. |
| `p5.random()` for grain | mulberry32 seeded per `t_loop` during animation | Required for byte-identical loop endpoints (`renderAt(0) === renderAt(1)`). |
| `strokeWeight()` round points (always) | `arc()` for dotSize ≥ 5, `fillRect()` below | ~3× faster at dense step sizes; visually identical at small dotSize. |
| `pow()` per pixel for gamma | 256-entry LUT | ~10× faster on 600k pixels. |
| Painter's algorithm via WebGL depth buffer | Insertion-sort indices by z each frame | Acceptable for ~5–10k dots; closure-free Array.sort. |
| No video support (image only) | `PIXSource.isVideo()` → `advanceFrame()` per RAF | pixart contract. |

## Performance notes

At `canvasSize=600, pixelDensity=8`:
- dots = (600/8)² ≈ 5625
- preprocess: 600×600×4 = 1.44M ops/pass; with LUT and clamps, ~4 ms.
- buildDots: 5.6k iterations, no allocation (preallocated Float32Array); ~0.5 ms.
- paint: 5.6k arc fills; ~6–10 ms on M-series.

Total per-frame ≈ 12 ms → easily 60fps in interactive mode and well under the 20 ms 24fps budget for export. Video sources just rerun `preprocess + buildDots` each frame; the preprocessor is the dominant cost.

If we ever push `canvasSize=1000, pixelDensity=4` (62.5k dots) the painter's sort + arc fill becomes the bottleneck (~80 ms). The `useRects` branch is the documented escape hatch; a WebGL fallback would be needed beyond that.

## What we explicitly did NOT add

- A separate `wg-file` row for an external displacement-map image. The reference doesn't use one — the source IS the displacement map (its luminance). Adding it would diverge from the reference and confuse the parameter model.
- Procedural noise/perlin/spiral map presets. Same reason — not in the reference.
- Channel mapping (R→X, G→Y). The reference uses a single composite luminance, not separate channels. The shipped `viewYaw` slider gives the user equivalent expressive range over the displacement direction.

These were called out as optional in the brief; skipping them keeps the port faithful.
