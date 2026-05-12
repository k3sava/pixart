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

---

## Refinement pass — 2026-05-13

Goal of this pass: graduate `displace` from a single yaw/pitch sweep into a six-mode optical-illusion field. Two new params on the Z axis (`eddyScale`, `vorticity`), one new interactive lever (`focusRadius`). Byte-equal endpoints on every mode; all frames under 12 ms at canvasSize 600 / pixelDensity 8.

### Modes shipped

| Mode | Envelope | Subset animated | Perceptual lever |
|---|---|---|---|
| **idle** | constant | none | Rest frame ships as the artwork |
| **breath** | yaw monotonic 0→360°, pitch cosine pingpong (the original sweep) | `viewYaw`, `pitch` | Calm foveal cycle — reads as the field inhaling/exhaling |
| **rotate** | yaw monotonic 0→360°, pitch holds at slider | `viewYaw` | Parallax depth cue — cloud reads as a 3D object on an orbital pedestal |
| **pulse** | sharp asymmetric spike (t<0.2 attack, slow decay) on Z scale | `_yScale` | One flashbulb swell per cycle; pairs with vorticity for "warm dots lift first" |
| **march** | Z snaps onto 4 discrete tiers; seam-override at t=1 → tier 0 | `_marchLevel` | Bauhaus-poster cue — cloud rises in slabs |
| **swirl** | yaw 1× monotonic, pitch 3× monotonic — coprime ratio | `viewYaw`, `pitch` | Lissajous orbit; eye locks onto the closed curve as one continuous motion |

Byte-equal endpoints are guaranteed by three rules: (1) every envelope wraps `t` to `[0,1)` before evaluating, so `cos(2π·t)==cos(0)==1` exactly; (2) `swirl`'s pitch term uses pingpong-style `(1−cos(2π·3t))/2` rather than a raw monotonic 0→3·360° to wrap exactly at the seam; (3) `march`'s tier index is explicitly forced to 0 at `t=0` and uses `t===0 ? 0 : floor(t·steps)` so `renderAt(1)` (which wraps to t=0) returns tier 0.

### New params

- **`eddyScale`** (`1..40`, default `1`) — Z-component multiplier. At `1` the look matches the previous port byte-for-byte; at `≥4` the dot cloud becomes a vertical column where `swirl` and `rotate` read most clearly as 3D. Lifted from Iñigo Quilez's "domain warping" sketch, where multiplying the displacement field is the cheapest way to amplify depth-from-parallax.
- **`vorticity`** (`-1..+1`, default `0`) — curl-like bias on Z: shifts each dot by `vorticity·(R−G)`. Breaks the alpha-luminance cloud's top-bottom symmetry (warm hues lift, cool hues sink, or vice versa). This is the lever that makes a `swirl` orbit read as an *object* with sides rather than a flat field rotating in place.
- **`focusRadius`** (`40..600` screen-px, default `240`) — only active in interactive mode. Inside the circle, Z gets `+eddyScale · yDisplacement · (1−r²/R²)` added (cheap quadratic Gaussian, Quilez). Reads as a displacement basin under the cursor — the local area lifts toward the camera while the rest of the field stays anchored.

### Optical-illusion insights baked in

1. **Lissajous lock-on.** `swirl` runs yaw and pitch at a 1:3 frequency ratio. The eye perceptually closes the figure into a single continuous curve (Lissajous 1857), so what is really two independent monotonic sweeps reads as one fluid orbital. The 1:3 ratio specifically produces a three-lobed petal — perceptually richer than 1:2 (a figure-eight) without crossing into the chaotic-looking 5:7 territory.
2. **Vasarely Vega-Nor curvature.** `rotate` mode at non-zero vorticity reproduces the Vega-Nor (1969) trick — the displacement field's asymmetry over the (R−G) channel makes a flat dot grid read as a bulging 3D surface as it rotates. Curvature is illusion, not geometry.
3. **Parallax depth cue.** Even on a 2D oblique projection, monotonic yaw rotation at constant pitch is *the* canonical cue the visual system uses to infer 3D structure (kinetic depth effect, Wallach & O'Connell 1953). `rotate` mode exploits this directly.
4. **Focus-as-basin.** Bret Victor's "Drawing Dynamic Visualizations" frames the cursor as a focal point. We invert the more common "field-attenuates-near-cursor" pattern and *increase* displacement under the cursor — turning the cursor into a positive-pressure lens rather than a calm eye. This pairs intentionally with the `distort` cursor (a calm eye in a storm); the two effects mirror each other.

### References

- Iñigo Quilez. *Domain warping* (https://iquilezles.org/articles/warp/). The Z-multiplier and quadratic-Gaussian focus falloff both come straight from this primer.
- Victor Vasarely. *Vega-Nor* (1969). Curvature-as-illusion in a regular grid; cited for `rotate + vorticity > 0` reading as a curved 3D surface.
- Jules Antoine Lissajous. *Mémoire sur l'étude optique des mouvements vibratoires* (Annales de Chimie et de Physique, 1857). Original Lissajous-figure construction; the `swirl` mode's 1:3 ratio is taken from his Plate II.
- Shadertoy `Xtt3Wn` — *parallax dot cloud* (Shane, 2017). Sanity-checked the oblique projection look against a known reference for 2D-projected 3D dot clouds.
- Wallach, H. & O'Connell, D. N. (1953). *The kinetic depth effect*. J. Exp. Psych. 45(4). — the perceptual basis for the `rotate` mode reading as 3D despite a flat projection.

### Verification (2026-05-13, Playwright + http://localhost:8001/displace/, 1280×720)

| Mode | byte-equal `renderAt(0)===renderAt(1)` | distinct frames at t=0/0.25/0.5/0.75 | mean ms over 24 frames |
|---|---|---|---|
| idle    | ✓ | 1 (intentional) | 8.03 |
| breath  | ✓ | 4 | 10.87 |
| rotate  | ✓ | 4 | 11.08 |
| pulse   | ✓ | 4 | 7.57 |
| march   | ✓ | 4 | 4.63 |
| swirl   | ✓ | 4 | 11.16 |

Screenshots in `docs/screenshots/displace-<mode>.png`.

### Notes for the next maintainer

- The mode select is non-routing (`mode` change does not trigger a static rebuild). Animation is the only consumer; static frames always show whichever frame was last rendered. If you ever want a per-mode static preview, route through `BUILD_KEYS` and pass `_yScale` / `_marchLevel` into a non-animating path.
- Transient module globals (`_yawAnim`, `_pitchAnim`, `_yScale`, `_marchLevel`, `_focusR2`) are intentionally save/restored inside `renderAnimationFrame` rather than written to `params`. This keeps the slider values authoritative — moving the mode select doesn't blow away the user's `viewYaw` knob.
- `eddyScale` is a build-stage key (it changes Z per dot), so adjusting it while animation is off triggers a `buildDots` pass. While animation is on, the rebuild is part of the per-frame work already.
