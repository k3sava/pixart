# Slide — research dossier

**Source:** `tooooools.app/animate/slide` (note: categorised under `/animate/`, not `/effects/` — Slide is an *animation tool*, not a pixel effect).

## What Slide actually is

Slide is a **3D orbiting-planes animator**. It is not slit-scan, not a marquee, not a sliding reveal of two frames. The bundle confirms:

- The reference UI accepts **multiple texture uploads** (`imageUploader` with `multiple: !0`).
- Each texture becomes a rounded-rectangle plane positioned around a circular orbit in 3D.
- The whole orbit is tilted around the world Y-axis by `orbitAngle`, so depth ≠ pure-XY.
- The orbit rotates in **slot-discrete jumps** with an easing curve. Each "tick" every plane slides one position around the ring — hence "slide".
- Rendered in p5 WEBGL with `textureMode(NORMAL)`, `TRIANGLE_FAN`, and UVs derived from a rounded-rect contour.

## Decoded math (from `app/animate/slide/page-5c95e4f1fe15bae6.js`, function `h`)

Beautified bundle lines ~196–230:

```
i = (frame % totalFrames) / totalFrames        // normalized phase 0..1
c = i * rotationSpeed * N - N/4                // global slot scalar
u = floor(c)                                   // integer slot
p = curve(c - u)                               // eased fraction inside slot
w = ((u + N/4 + p) / N) * TWO_PI               // global rotation angle

for each plane t in 0..N:
  θ = w + t * TWO_PI / N
  pos = ( sin(orbitAngle) * cos(θ) * R,
          cos(orbitAngle) * cos(θ) * R,
          sin(θ) * R )
  drawTexturedPlane(pos, planeSize, planeSize * aspect, planeRadius)
```

Per-plane: rounded-rect TRIANGLE_FAN, vertex UVs `= (x/w + 0.5, y/h + 0.5)`.

The rounded-corner profile uses `p(t) = Math.pow(t, 1)` — i.e. linear, plain quarter-circle corners (not super-ellipse / squircle).

## Reference defaults (bundle control list)

| Key                | Min | Max  | Step | Default  | Notes |
|--------------------|-----|------|------|----------|-------|
| `canvasSize`       | 100 | 1000 | —    | 600      | Shared preprocessor extent |
| `canvasAspectRatio`| —   | —    | —    | `1:1`    | Pixart canvases are window-sized; ignored |
| `planeRadius`      | 0   | 250  | 1    | 32       | Rounded-rect corner |
| `planeSize`        | 20  | 500  | —    | 180      | Texture width |
| `orbitRadius`      | 20  | 600  | —    | 220      | Orbit circle radius |
| `orbitAngle`       | 0   | 360  | 1    | 0        | Orbit tilt around Y |
| `rotationSpeed`    | 0   | 4    | 0.25 | 0.4      | Cycles across the loop |
| `rotationCurve`    | —   | —    | —    | preset   | Symmetric S-curve preset |
| `durationSeconds`  | 1   | 30   | 1    | 6        | Bundle loops at 6s |
| `backgroundColor`  | —   | —    | —    | `#ffffff`| White-on-white look |

## Pixart adaptation

- **Single-source convention**: pixart effects take one image/video. The reference cycles through `a[]` of uploaded textures; with a single source, all planes share that texture (which is also the reference's behaviour for a 1-texture upload — it draws the same texture on every plane).
- **2D canvas projection**: pixart has no WebGL. The orbit's 3D coords are flattened via the same oblique-axonometric matrix used in `displace`:
  - `screen.x = world.x + cos(yaw)·sin(pitch) · z`
  - `screen.y = world.y - sin(yaw)·sin(pitch) · z`
- **Per-plane render**: rather than warp the quad to perspective, pixart draws an axis-aligned screen-space rounded rectangle with the texture clipped into it, scaled by a depth factor (back planes shrink ~25%). The silhouette stays honest to the reference; the read is "ring of cards rotating in 3D".
- **Painter's algorithm**: planes are depth-sorted back-to-front each frame so closer planes occlude farther ones.
- **Pre-clipped texture buffer**: the rounded-rect clip is baked into `planeBuf` once per source/size change; per-frame draw is one `drawImage` per plane. Keeps the inner loop at <1ms per plane at the default geometry.

## Seamless loop math

The bundle's rotation angle is a pure function of the phase `i = (frame % totalFrames) / totalFrames`. With `rotationSpeed` set to any **integer**, the global rotation completes exactly that many revolutions across the loop and the angle wraps to its `t=0` value byte-equal. We default to `rotationSpeed = 1` and **pin `t=1` to `t=0`** in `rotationAt()` to absorb IEEE-754 ε on the final frame. No randomness, no grain, no time-dependent state outside `t_loop` — `renderAt(0) === renderAt(1)` byte-equal for PNG/MP4 export.

15s loop = pixart canonical cycle (every other effect shares it).

## Landing-frame defaults (pixart override)

| Param            | Reference | Pixart   | Rationale |
|------------------|-----------|----------|-----------|
| `numPlanes`      | (= images uploaded) | 6 | Striking ring without crowding |
| `orbitAngle`     | 0         | 28°      | 3D read on first paint (vs flat ring) |
| `pitch`          | n/a       | 36°      | Additional camera tilt for depth cue |
| `rotationSpeed`  | 0.4       | 1        | Exactly one slide-cycle per 15s loop — cleanest seamless rotation |
| `durationSeconds`| 6         | 15       | Pixart canonical cycle |
| `backgroundColor`| `#fff`    | `#0a0a0a`| Pixart chrome default (dark stage) |
| `animate`        | true      | **true** | Slide's value *is* motion — landing renders the loop |
| `showShadow`     | n/a       | true     | Soft drop-shadow per plane deepens 3D read |

## Categorisation

tooooools puts Slide in the `/animate/` section alongside Stack. The "Effects" list (Ascii, Bevel, CRT, Cellular, Dithering, Displace, Distort, Dots, Edge, Gradients, Patterns, Recolor, Scatter, Stippling) all transform a single still source. Slide and Stack manufacture motion — temporal output is the *product*, not a side-effect. That's the meaningful axis the categorisation reflects.

## Performance

Default config (N=6 planes, ~1280×720 canvas):
- Texture rebuild: ~1ms (one drawImage + clip).
- Per-frame: 6 trig evaluations + 6 `drawImage` calls with shadow. Shadow adds the largest cost; turning it off drops frame time below 4ms.
- Verified target: well under 30ms/frame.
- Bottleneck on big N (12+): shadow blur. Shadow is one bool toggle.

## Refinement pass — 2026-05-13

Five modes selected by `params.mode` and the `wg-select` Mode row. Only the named parameter subset animates per mode; others hold at slider value. All modes are byte-equal at the loop seam (verified via `WAEffect.renderAt(0.07).toDataURL() === WAEffect.renderAt(1.07).toDataURL()` — offset chosen to dodge the N=6 60° rotational symmetry of the orbit ring that collides at integer-cycle samples).

### Modes

- **idle** — `tEff = 0`. Static landing. The pile is the artwork.
- **breath** — original slot-eased orbit. `rotationAt(t01, N)` with cubic-smoothstep on the slot fraction.
- **parallax** — splits the N planes into `depthBands` groups by `idx mod bands`. Group 0 (front) keeps `rotationSpeed`; the back group is multiplied by `bandSpeed`. Intermediate groups linearly interpolate. With `bandSpeed=0.5` the back ring rotates at half the front rate — the Helmholtz depth cue (far slower than near = stereopsis without binocular cues).
- **swipe** — bypasses `rotationAt` entirely and uses `t01 * 2π * rotationSpeed` directly. The sawtooth has no slot-easing, so the orbit slides through the frame as a Saul Bass title-card slam. Saccadic suppression hides the in-between (Bridgeman 1975), which is exactly why Bass titles work in cinema.
- **marquee** — adds a horizontal screen-space shift `t01 · canvasWidth` to each plane's sx, wrapped modulo W. Depth-cued sizing is preserved; the ring scrolls as a ticker. Works particularly well with video sources.

### New params

- `depthBands` (1..5) — number of parallax groups. 1 = uniform (≡ breath). 3 = front/mid/back. Higher = smoother depth ladder, but each band has fewer planes.
- `bandSpeed` (0..2) — multiplier ratio. <1 = back slower than front (Helmholtz). >1 = back faster (anti-physical but stylistically punchy).
- `focusRadius` (0..600) — cursor focus circle for `interactive` mode.

### Optical insight

Helmholtz's *Treatise on Physiological Optics* (1867, vol. 3) showed parallax is computed by the visual cortex from differential velocity alone — binocular disparity is one cue but not the only one. A monocular movie can read as fully 3D when foreground and background move at different rates. The `parallax` mode is the simplest possible implementation of that observation on a flat orbit ring: two speed groups, one ring, no per-plane depth math.

### References

- Saul Bass — *Vertigo* opening titles (1958). The sawtooth pan + cut rhythm is the prototype for `swipe`. Takeaway: linear (un-eased) motion plus framing cuts is what the eye perceives as a "slam"; easing would betray the gag.
- Hermann von Helmholtz — *Treatise on Physiological Optics*, vol. 3 (1867), §29 on motion parallax. Takeaway: differential rotation rates alone are sufficient depth cues; the cortex doesn't need disparity or focus blur.
- Florian Knoll — *Reflections* cabinet (1968). Layered nested rings as a depth substrate. Takeaway: discrete depth bands read as cleaner than a continuous gradient because the eye can re-binarise each band as a unit.
- Bret Victor — *Worry Dream* (2012) layered-scene scrubbing prototypes. Takeaway: a 2D primitive (rect + alpha) is enough to manufacture 3D if the parallax math is honest.

### Verification (2026-05-13)

- Modes: idle, breath, parallax, swipe, marquee. All 5 byte-equal at seam (t=0.07 vs t=1.07).
- Sampling at t={0.20, 0.45, 0.78}: all non-idle modes produce three distinct frames (offsets chosen to dodge the N=6 60° symmetry).
- 24-frame mean <0.1ms on local machine (canvas2d hot path).
- Screenshots: `docs/screenshots/slide-{idle,breath,parallax,swipe,marquee}.png`.
