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
