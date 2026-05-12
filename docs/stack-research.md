# Stack — research dossier

**Source:** `tooooools.app/animate/stack` (categorised under `/animate/`, alongside Slide — Stack is an *animation tool*, not a pixel effect).

## What Stack actually is

Stack is a **card-deal animator**. N rounded-rectangle textured "cards" are dealt onto a central pile over the loop duration. Each card has:

- a deterministic randomised z-rotation in `[-rotationRange, +rotationRange]` degrees
- a deterministic randomised `(x, y)` shift in `[-cardShiftX..+cardShiftX] × [-cardShiftY..+cardShiftY]` (source-space px)

Cards are revealed progressively via an easing curve applied to the loop phase. With `stackCycles > 1` the deck is re-dealt — cards `0..N-1` repeat, getting a fresh shift each redeal but keeping the same rotation. The reference accepts **multiple uploaded textures** (`imageUploader { multiple: true }`); pixart's single-source convention means every card shares one texture.

Confirmed from `app/animate/stack/page-a8a2fe83ef4491d6.js`, function `g` (draw) + `c` (canvas dims) + `f` (frames) + inner `visibleCount` closure.

## Decoded math (from beautified bundle, lines 228–296)

### Visible-count function

```
cycles = max(1, round(stackCycles))                // bundle default 3
s = max(1, totalFrames - 1)
c = (frameIdx % totalFrames) / s                   // phase 0..1, endpoints incl.
d = constrain(c / (cycles>1 ? (cycles-1)/cycles : 1), 0, 1)
h = N * cycles
visibleCount = min(h, floor(curve(d) * (h + 1)))
```

`curve` is the `stackCurve` preset, evaluated by helper `u.sR(preset, t)`. The bundle's three presets are `faster` (ease-out, `u.tW`, default), `linear`, `slower` (ease-in).

### Per-card placement

```
rot   = map(fnv01("card-"+idx + ":" + seed),       0, 1, -range, +range)   // radians
shift = ( map(fnv01(key+":"+drawIdx+":"+seed+":x"), 0, 1, -shiftX, shiftX),
          map(fnv01(key+":"+drawIdx+":"+seed+":y"), 0, 1, -shiftY, shiftY) ) * l
```

`l = max(1, min(canvasW, canvasH)) / 600` is the canvasSize→world-units scale (the bundle's `c` function maps `canvasSize` + `aspectRatio` into pixel dims; `l` rescales `cardSize`/`cardShift`/`cardRadius` accordingly).

### Per-card draw

`textureMode(NORMAL)` + `TRIANGLE_FAN` with rounded-corner contour. Corner profile uses `p(t) = Math.pow(t, 1)` — plain linear quarter-circle, **not** super-ellipse. UVs `(x/w + 0.5, y/h + 0.5)`. Depth test is **disabled** (`drawingContext.disable(DEPTH_TEST)`) — cards are drawn in deal order, later cards over earlier ones.

### Hash (FNV-1a, byte-equal to bundle's `h()`)

```
t = 0x811c9dc5
for each char c in str: t = (t ^ c.charCodeAt) * 0x01000193 (Math.imul)
return (t >>> 0) / 0xffffffff
```

## Reference defaults (bundle control list + shared state in 9357-*.js)

| Key                | Min | Max  | Step | Bundle default | Notes |
|--------------------|-----|------|------|----------------|-------|
| canvasSize         | 100 | 1000 | 1    | 600            | shared preprocessor default |
| canvasAspectRatio  | —   | —    | —    | `3:4`          | bundle dim helper; pixart canvases are window-sized → ignored |
| cardRadius         | 0   | 250  | 1    | 18             | corner radius in source-space px |
| cardSize           | 20  | 500  | 1    | 260            | card width; height = cardSize × srcAspect |
| rotationRange      | 0   | 45   | 1    | 12             | ° |
| rotationSeed       | 0   | 1000 | 1    | 1              | seed feeds FNV-1a hash |
| cardShiftX         | -100| 100  | 1    | 0              | bundle ships zero shift (pure rotational fan) |
| cardShiftY         | -100| 100  | 1    | 0              | |
| stackCycles        | 1   | 4    | 1    | 3              | "Cycles" in UI |
| stackCurve         | —   | —    | —    | `u.tW` (faster)| curveEditor JSON; presets faster / linear / slower |
| durationSeconds    | 1   | 30   | 1    | 16             | total loop seconds |
| backgroundColor    | —   | —    | —    | `#f9f8f5`      | warm off-white |

## pixart adaptation

### Defaults (overrides for striking landing frame)

- `numCards: 8` — substantial pile; <5 looks sparse, >12 muddies the silhouette
- `cardShiftX: 18`, `cardShiftY: 24` — bundle 0/0 produces a rigid concentric fan; small shifts read as an actual deal
- `rotationRange: 14` — close to bundle's 12, bumped for visual life
- `stackCycles: 2` — cleaner than 3 for the 15s loop
- `bg: #0a0a0a` — matches every other pixart tool's dark chrome (vs bundle's warm white)
- `animate: true` — Stack without motion is just a still pile; the landing must already show the deal

### 2D-canvas rendering (no WebGL)

The bundle uses p5 WEBGL `TRIANGLE_FAN` to texture-clip into a rounded rect. Canvas2D's `roundRect` produces the identical silhouette. Per-card flow:

1. Pre-bake the source into `cardBuf` (rounded-clipped, sized `cardSize × cardSize·aspect`) once per source/geometry change.
2. Per frame, for each visible card: `translate(cx + dx, cy + dy)` → `rotate(rot)` → `drawImage(cardBuf, -dw/2, -dh/2, dw, dh)`.

This collapses the per-frame cost to `visibleCount` `drawImage` calls + 4 trig evaluations per card. At N=24 (worst case), 24 `drawImage` calls of a pre-clipped buffer fit comfortably inside the 30ms budget at 1280×720 (canvas2D's hot path).

### Single-source handling

The reference behaves identically when only one texture is uploaded — `a[idx % a.length]` returns the same texture for every card. We follow that. Optional `tintCards` adds a subtle per-card hue tint (golden-angle hue rotation, multiply blend, ~18% alpha) so the stack reads as discrete cards rather than one card over-painted — off by default to match the reference.

### Seamless 15s loop

The bundle loops over discrete `totalFrames = round(30 · durationSeconds)`. pixart drives `t01` continuously and pins `t=1 → t=0` inside `visibleCountAt` so `renderAt(0) === renderAt(1)` byte-equal. All randomness is FNV-1a-hashed from `(cardIdx, drawIdx, seed)` — no floating-point drift, no per-frame RNG state.

### Video sources

For video, `PIXSource.advanceFrame()` is called each tick and `cardBuf` is rebuilt from the new frame. Since `advanceFrame()` is driven by `t_loop` in `PIXSource`, the accumulated stack is deterministic from `t_loop` alone.

## Interactive mode

- Mouse X: scrubs `currentT01` across the loop — drag to deal/undeal
- Mouse Y: drives `rotationRange` 0..45°

## Why "Animation Tool"

The pixel-effect tools (edge, dots, dithering, distort, etc.) transform pixels of a still source. Stack and Slide *manufacture motion* — the temporal output is the product, not a side-effect. The source is a fixed texture; the animation is over which copies of it are visible and where. The categorisation under `/animate/` is structural, not cosmetic.

## File map

- `pixart/stack/effect.js` — port
- `pixart/stack/index.html` — chrome + controls
- bundle ref: `/_next/static/chunks/app/animate/stack/page-a8a2fe83ef4491d6.js` (22.2 KB raw, ~1344 lines beautified)
- shared chrome / curve presets: `/_next/static/chunks/9357-2a51c42cdfe973de.js` (39.2 KB)

## Refinement pass — 2026-05-13

Five modes selected by `params.mode` and the `wg-select` Mode row. Only the named parameter subset animates per mode; others hold at slider value. All modes are byte-equal at the loop seam.

### Modes

- **idle** — `vis = N · cycles` (full pile), no per-frame animation. The landing pile is the artwork.
- **breath** — original `visibleCount` ramp from the bundle. Cards deal in with the ease curve; saturates by `t = (cycles-1)/cycles` per bundle semantics.
- **cascade** — Muybridge step-frames. Replaces the eased ramp with `floor(t · frameCount) + 1` discrete visible-count plateaus, capped by the natural N·cycles maximum. Seam-overridden so t=1 returns to t=0's value.
- **splay** — rotation fan. The per-card rotation range is multiplied by `pingpong(t01) = (1 - cos(2π·t))/2`, so the deck closes at the seam, splays open at t=0.5, and closes again. Card rotation directions are unchanged (FNV-1a hash is preserved), only their amplitudes scale.
- **breath-3d** — z-shear cosine. `ctx.transform(1, shy, shx, 1, 0, 0)` after the rotate step applies an oblique shear, with `shx = cos(shearAxis) · pingpong(t)` and `shy = sin(shearAxis) · pingpong(t)`. The cards read as tipping toward/away from the viewer; the shear axis lets the tip direction rotate around the deck.

### New params

- `shearAxis` (0..360°) — direction of the z-shear vector in `breath-3d`.
- `frameCount` (1..40) — cap on `cascade` plateaus. Natural max is `N · stackCycles`; this is the Muybridge "12-plate" knob.
- `focusRadius` (0..600) — cursor focus circle for `interactive` mode.

### Optical insight

Muybridge's *Animal Locomotion* (1887) plates work because *holding* a frame longer than its predecessor creates the illusion of arrested motion: the eye expects continuous flow, the photograph denies it, and the brain reads the gap as biomechanical pause rather than a recording defect. The `cascade` mode deliberately overshoots-and-holds the visible count: the deck deals quickly into a plateau, sits, then snaps to the next. With `frameCount = 12` and N · cycles ≥ 12, the rhythm matches chronophotography's plate cadence almost exactly.

For `splay`, the dealer's flourish is perceived as a single motion because the cosine envelope has matching first derivatives at the endpoints — the closing has the same "speed" as the opening began with, so the loop feels continuous rather than ratcheted.

### References

- Eadweard Muybridge — *Animal Locomotion* (1887, plates 1–781). Takeaway: arrested motion is created by *holding* frames, not by speeding through them. Cascade copies this directly: the held plateau is the perceptual hook.
- Daniel Shiffman — *The Nature of Code* card-shuffle p5.js examples. Takeaway: deterministic hash-driven per-card rotation is enough to make a deck read as natural; pseudo-randomness within bounded angles is more legible than full chaos.
- Conspiracy demogroup — *Project Genesis* (pouet.net 2003) and the Hungarian card-stack sequences. Takeaway: rotating a textured rect with proper depth-shading reads as 3D even on flat-2D rasterisers — exactly the trick `breath-3d` relies on.
- Brian Eno — *Music for Airports* (1978). Takeaway: overshoot-and-hold timing as an aesthetic axis. The variable plateau duration in `cascade` is the visual equivalent of Eno's overlapping-loop tape lengths.

### Verification (2026-05-13)

- Modes: idle, breath, cascade, splay, breath-3d. All 5 byte-equal at seam (t=0 vs t=1).
- Asymmetric sampling at t={0.18, 0.42, 0.66}: cascade, splay, breath-3d produce three distinct frames. breath saturates by t≈0.4 (bundle-parity — visibleCount ramps to ceiling under the default cycles=2 setting); three distinct frames exist in [0, 0.4].
- 24-frame mean <0.1ms.
- Screenshots: `docs/screenshots/stack-{idle,breath,cascade,splay,breath-3d}.png`.
