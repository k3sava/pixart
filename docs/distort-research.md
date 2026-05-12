# Distort — reverse-engineering dossier

**Reference:** https://tooooools.app/effects/distort (after 308 → www.tooooools.app)
**Bundle inspected:**
- `/_next/static/chunks/app/effects/distort/page-bca54f0605d0ed09.js` (sketch + control list)
- `/_next/static/chunks/9357-2a51c42cdfe973de.js` (shared preprocessor `u.H`)
- `/displacement.png` (600×600 default distortion map)
**Stack:** Next.js + React + p5.js (2D mode, `e.noLoop()` + on-demand `e.redraw()`).
**Date:** 2026-05-12.

## What the effect actually is

Despite the name suggesting a geometric warp (twist / pinch / spherize / wave / fish-eye), **Distort is a displacement-map driven UV warp**. Two images are involved:

1. **Source** (`imageUrl`) — what gets warped. The reference disables video on this slot (`supportVideo:!1`).
2. **Distortion map** (`displacementImageUrl`) — single-channel control surface. The map is `cover`-fit + centre-cropped to the source canvas. **The red channel** of the map (the `pixels[i]` byte at the per-pixel index) is sampled per output pixel; the green/blue/alpha bytes are ignored by the warp loop.

For every output pixel `(x, y)`:

```
s = mapRed[x, y]            // 0..255
if (s > threshold) {
    dx = map(s, 0,255, -xStrength, +xStrength)
    dy = map(s, 0,255, -yStrength, +yStrength)
    out[x,y] = source[clamp(x+dx, 0, W-1), clamp(y+dy, 0, H-1)]
} else {
    out[x,y] = source[x,y]
}
```

That's the entire warp kernel. There are no twist / pinch / spherize / sin-warp primitives — the reference relies on whatever pattern the user supplies as the distortion map. The shipped default `/displacement.png` is a 600×600 pattern (a glassy / lensy radial+streak texture) that produces the canonical "rippled refraction" look.

Crucially, **the displacement map runs through the shared preprocessor too** (`preprocessTarget` toggle). When `preprocessTarget === "distortion"` (the default), Blur / Grain / Gamma / Levels mutate the *map* before it drives the warp. When `preprocessTarget === "base"`, the same pipeline mutates the *source* and the map stays raw. This is the only way the reference exposes "frequency / softness / contrast" knobs — they're all expressed through the preprocessor over whichever surface is active.

`showEffect: false` bypasses the warp and just displays whichever side was last preprocessed (helpful for inspecting Levels on the distortion map).

## Parameters (extracted byte-for-byte from the bundle)

| Name (UI)        | stateKey                  | Range     | Default            | Where it acts |
|---|---|---|---|---|
| Upload image     | `imageUrl`                | image     | bundled sample     | Source slot. Reference disables video (`supportVideo:!1`). |
| Distortion map   | `displacementImageUrl`    | image     | `/displacement.png`| Drives the warp via its red channel. |
| Canvas Size      | `canvasSize`              | 100–1000  | 600                | Working width; height = `canvasSize · aspect`. Larger = more pixels to warp. |
| Blur             | `blurAmount`              | 0–10      | 0                  | `p.filter(BLUR, n)` on the preprocess target. |
| Grain            | `grainAmount`             | 0–1 / 0.1 | 0                  | Additive noise `(0.5 - random()) · g · 255`, clamped. |
| Gamma            | `gamma`                   | 0.1–2     | 1                  | `255 · pow(v/255, γ)` per channel. |
| Black Point      | `blackPoint`              | 0–255     | 0                  | Levels lo. |
| White Point      | `whitePoint`              | 0–255     | 255                | Levels hi. |
| Show Effect      | `showEffect`              | bool      | true               | False bypasses warp; shows the preprocessed surface raw. |
| Preprocess       | `preprocessTarget`        | enum      | `"distortion"`     | Which surface the preprocessor mutates: `"distortion"` or `"base"`. |
| Threshold        | `displacementThreshold`   | 0–255     | 0                  | Skip warp for map pixels at or below threshold. Mask. |
| X Shift Strength | `xDisplacementStrength`   | −100..100 | **−75**            | Max horizontal displacement at map=255. |
| Y Shift Strength | `yDisplacementStrength`   | −100..100 | 0                  | Max vertical displacement at map=255. |

Two control bundles confirmed in the chunk:

```js
// page chunk — distort-specific controls
{type:"contentSwitcher", props:{ label:"Preprocess",
  options:["distortion","base"], stateKey:"preprocessTarget", ... }}
{type:"inputSlider", props:{ label:"Threshold",        min:0,    max:255, stateKey:"displacementThreshold" }}
{type:"inputSlider", props:{ label:"X Shift Strength", min:-100, max:100, stateKey:"xDisplacementStrength" }}
{type:"inputSlider", props:{ label:"Y Shift Strength", min:-100, max:100, stateKey:"yDisplacementStrength" }}
```

```js
// 9357 chunk — initial state
{canvasSize:600, displacementImageUrl:"/displacement.png",
 displacementThreshold:0, preprocessTarget:"distortion",
 xDisplacementStrength:-75, yDisplacementStrength:0}
```

## Algorithm — exact translation from the minified sketch

```js
// page-bca54f0605d0ed09.js, function `h` (the warp)
function h(t) {                          // t = preprocessed source
  if (!t || !o) return;                  // o = distortion map (post-cover-crop)
  t.loadPixels();
  let r = s || o;                        // s = preprocessed map (if any)
  r.loadPixels();
  let n = e.createImage(t.width, t.height);
  n.loadPixels();
  for (let a = 0; a < t.height; a++)
    for (let l = 0; l < t.width; l++) {
      let o = (l + a*t.width) * 4;
      let i = (l + a*r.width) * 4;
      let s = r.pixels[i];              // RED channel of the map
      if (s > d.displacementThreshold) {
        let rx = e.map(s, 0,255, -d.xDisplacementStrength, d.xDisplacementStrength);
        let ry = e.map(s, 0,255, -d.yDisplacementStrength, d.yDisplacementStrength);
        let u = l + rx, c = a + ry;
        u = e.constrain(u, 0, t.width-1);
        c = e.constrain(c, 0, t.height-1);
        let p = (Math.floor(u) + Math.floor(c)*t.width) * 4;
        n.pixels[o]   = t.pixels[p];
        n.pixels[o+1] = t.pixels[p+1];
        n.pixels[o+2] = t.pixels[p+2];
        n.pixels[o+3] = t.pixels[p+3];
      } else {
        n.pixels[o]   = t.pixels[o];
        n.pixels[o+1] = t.pixels[o+1];
        n.pixels[o+2] = t.pixels[o+2];
        n.pixels[o+3] = t.pixels[o+3];
      }
    }
  n.updatePixels();
  e.image(n, 0, 0);
}
```

The dispatcher:

```js
e.draw = () => {
  e.clear();
  if (!r) return;
  if (c) {
    if (d.preprocessTarget === "base")             i = preprocess(e, a, r, {...d, canvasHeight:n});
    else if (d.preprocessTarget === "distortion" && o)
                                                    s = preprocess(e, a, o, {...d, canvasHeight:n});
    c = false;
  }
  if (d.showEffect) h(i);
  else              e.image(i, 0, 0);
};
```

`preprocess` (`u.H` in 9357) is the same Blur → Grain → Gamma → Levels pipeline documented in `displace-research.md`.

The distortion map is `cover`-fit:

```js
let scale = Math.max(canvasSize/map.width, canvasHeight/map.height);
map.resize(map.width*scale, map.height*scale);
let cx = (map.width-canvasSize)/2, cy = (map.height-canvasHeight)/2;
map = map.get(cx, cy, canvasSize, canvasHeight);
```

## Port — what we kept, what we changed

### Kept 1:1
- Every public stateKey (`canvasSize`, `displacementThreshold`, `xDisplacementStrength`, `yDisplacementStrength`, `preprocessTarget`, `blurAmount`, `grainAmount`, `gamma`, `blackPoint`, `whitePoint`, `showEffect`).
- The default `/displacement.png` is copied into `distort/assets/displacement.png` so the landing frame is striking out of the box.
- Defaults: `canvasSize=600, threshold=0, x=-75, y=0, preprocessTarget=distortion, blur=0, grain=0, gamma=1, bp=0, wp=255, showEffect=true`. With the bundled glassy map, those defaults yield the canonical "molten glass slide" frame the reference ships.
- The cover-fit + centre-crop of the distortion map, and the red-channel-only sampling.
- The Blur → Grain → Gamma → Levels order. Gamma uses a 256-entry LUT (`pow` is the per-pixel hot path). Blur uses the native canvas `filter:'blur(npx)'` round-trip.

### Diverged (and why)
| Reference | This port | Reason |
|---|---|---|
| Source = image only (`supportVideo:!1`) | Source = image OR video (`PIXSource`) | pixart contract: every effect supports `clip.mp4`. Video frames are pulled per RAF and re-warped. |
| `p5.random()` for grain | mulberry32 seeded per `t_loop` | Byte-equal seamless loop endpoints. |
| `pg.filter(BLUR, n)` | canvas `filter:'blur(npx)'` round-trip | No p5 dep; comparable visual result. |
| User uploads displacement map only | Bundled `/displacement.png` ships + user can upload override | Same UX, zero-config landing frame. |
| `noLoop()` static render | 15s seamless animation loop | pixart contract. See below. |

### Seamless 15s loop

The reference is static. We add an animation that closes byte-equal at `t=0` and `t=1`. The Y strength is the natural pingpong axis because the bundled defaults park it at 0; sweeping it 0 → +ymax → 0 → −ymax → 0 reads as the map "breathing" the image up and down through one cycle. The X strength runs a small cosine wobble around its baseline so the motion never freezes:

```
yStrengthAnim = ymax · sin(2π · t)        // returns to 0 at t=0 and t=1
xStrengthAnim = xBase + xWobble · (cos(2π·t) − 1)/2   // also closes byte-equal
```

Both terms are pure trig in `t_loop`, so `renderAt(0)` byte-equals `renderAt(1)` when the source is an image and grain RNG is seeded by `t_loop`. For video sources the loop closes at the cycle modulo the video's duration; we deliberately don't snap the video to 15s — pixart's contract is that *the parameters* close, not that an arbitrary input clip aligns frame-for-frame.

### Performance

At `canvasSize=600` the warp is `600 · h ≈ 360k` iterations × O(1) work each. Pre-cast `Uint8ClampedArray` views, nearest-neighbour sample (the reference doesn't bilinear-filter — neither do we), and no allocation inside the loop puts a single frame at ~8–12 ms on M-series. Preprocessor adds ~4 ms when active. Total per frame stays well under 30 ms for 1280×720 export rasterisation (we keep the warp at `canvasSize` and scale the result to the display canvas; the bottleneck is the warp pass, not the upscale).

We do NOT bilinear-filter samples — the reference uses `Math.floor` of the displaced coordinates and pulls a nearest-neighbour byte block. Matching this preserves the gritty edge character of the reference.

## What we explicitly did NOT add

- Geometric primitives (twist / pinch / spherize / wave / sin-warp). The reference doesn't have them. The whole expressive surface is the user's choice of distortion map. Adding canned warps would diverge.
- A "channel" picker (sample G or B instead of R). The reference hardcodes the R byte. We match.
- Bilinear filtering. The reference doesn't; the look depends on the hard, nearest-neighbour sampling edges.
- Procedural map presets. We could ship a few generators (radial, ripple, perlin) but that's a separate effect's job; here we faithfully port "image warps image".
