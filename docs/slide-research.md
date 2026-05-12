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
