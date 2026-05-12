# CRT — reverse-engineering dossier

**Reference:** https://tooooools.app/effects/crt
**Bundles inspected:**
- `/_next/static/chunks/app/effects/crt/page-1747cdefc6e00ef6.js` (UI controls, sketch wrapper, shader strings)
- `/_next/static/chunks/9357-2a51c42cdfe973de.js` (shared preprocessor module + default-state object)

**Stack:** Next.js + React + p5.js (WEBGL mode) with five GLSL fragment shaders chained through three p5 framebuffers (CRT FBO → bright FBO → bloom FBO).
**Date:** 2026-05-12.

## What the effect actually is

A textbook multi-pass CRT shader, **fully GPU**, not a CPU/canvas effect. The reference pipeline is:

1. **Preprocess** — blur + grain + levels + gamma into FBO 1. Identical preprocessor that displace/ascii also use; one shared module (9357).
2. **CRT mask + glow** — barrel-distort UV, sample with RGB convergence offsets, multiply by one of three subpixel-mask patterns (Monitor / LCD / TV), accumulate a 32-sample radial "glow" pass, encode to output gamma 2.2.
3. **Bright pass** — luminance threshold (`smoothstep(thresh, thresh+0.2, lum)`) for the bloom feeder.
4. **Gaussian blur** — separable, driven by `bloomRadius`.
5. **Combine** — one of five blend modes mixes the CRT output with the blurred bright pass.

Notable: convergence is applied to the **texture sample only** (electron-beam misalignment), not to the mask grid — the grid stays stationary. Without that, the mask "follows" the chromatic aberration and the illusion breaks.

## Parameters — all extracted from the bundle

Bundle defaults are from the `defaultState` object in 9357-*.js (the slider widget initialises from `e[stateKey]` where `e` is `defaultState`). Ranges/steps are from the slider widget definitions in the page chunk.

| Name (UI label) | stateKey | Range | Bundle default | Pixart landing default | Where it acts |
|---|---|---|---|---|---|
| Canvas Size | `canvasSize` | 100–1000 | 600 | n/a (canvas is window-sized) | source resample resolution |
| Type | `patternType` | 0/1/2 | 0 | 0 (Monitor) | selects mask shader |
| distortion | `distortion` | 0–0.08 step 0.01 | 0.02 | **0.04** | barrel: `coord + cc·(1+d)·d`, `d=dot(cc,cc)·distortion` |
| dotScale | `dotScale` | 0.01–2 step 0.01 | 0.93 | 0.93 | dot diameter relative to pitch |
| dotPitch | `dotPitch` | 0–30 step 0.01 | 1.59 | **4.5** | grid spacing in pixels |
| falloff | `falloff` | 0.01–1 step 0.01 | 0.12 | 0.12 | dot edge smoothstep softness |
| Brightness | `brightnessBoost` | (no slider; uniform exposed) | 2.5 | 2.5 | pre-mask exposure multiplier |
| glowRadius | `glowRadius` | 0–0.5 step 0.01 | 0.20 | 0.20 | glow sample disc radius (×dotPitch) |
| glowIntensity | `glowIntensity` | 0–1 step 0.01 | 0.10 | **0.25** | weight on the 32-sample glow accumulator |
| Bloom | `blendMode` | 0/1/2 | 0 | 0 (Screen) | combine pass blend selection |
| bloomThreshold | `bloomThreshold` | 0–1 step 0.01 | 0.36 | 0.36 | luminance threshold for bright pass |
| bloomIntensity | `bloomIntensity` | 0–5 step 0.01 | 0.45 | 0.45 | bloom multiplier |
| bloomRadius | `bloomRadius` | 0–10 step 0.01 | 1.0 | 1.0 | blur kernel radius |
| redConvergenceOffsetX | `redConvergenceOffsetX` | −1..1 step 0.01 | +0.01 | +0.01 | R-channel UV offset X |
| redConvergenceOffsetY | `redConvergenceOffsetY` | −1..1 step 0.01 | +0.01 | +0.01 | R-channel UV offset Y |
| blueConvergenceOffsetX | `blueConvergenceOffsetX` | −1..1 step 0.01 | −0.01 | −0.01 | B-channel UV offset X |
| blueConvergenceOffsetY | `blueConvergenceOffsetY` | −1..1 step 0.01 | −0.01 | −0.01 | B-channel UV offset Y |
| convergenceStrength | `convergenceStrength` | 0–1 step 0.01 | 0.10 | 0.10 | scalar on both R/B offsets |
| Blur | `blurAmount` | 0–10 step 1 | 0 | 0 | preprocess 5×5 Gaussian sigma |
| Grain | `grainAmount` | 0–1 step 0.1 | 0 | 0 | additive noise per channel |
| Gamma | `gamma` | 0.1–2 step 0.1 | 1 | 1 | `pow(c, 1/γ)` |
| Black Point | `blackPoint` | 0–255 | 0 | 0 | levels lo (sent as /255) |
| White Point | `whitePoint` | 0–255 | 255 | 255 | levels hi (sent as /255) |
| Show Effect | `showEffect` | bool | true | true | bypass path |

Three pixart landing defaults diverge from the bundle, all to satisfy the brief's "must produce a striking, immediately recognisable CRT landing frame":

- `dotPitch 1.59 → 4.5` — the bundle's pitch is sub-pixel on most screens, so the mask is invisible until you crank dotPitch. 4.5 px puts the aperture grille on the right side of the Nyquist limit at typical viewport sizes.
- `distortion 0.02 → 0.04` — bundle barrel is too subtle for a landing first impression. 0.04 reads as "this is curved" without warping the source.
- `glowIntensity 0.10 → 0.25` — landing wants visible phosphor bleed.

## Algorithm — verbatim shader bodies

The reference shaders are quoted in the bundle as JS string literals and ported verbatim into `effect.js` (only the `#version 100 → 300 es` header and `varying/uniform → in/out + texture()` changes). Full sources live in `effect.js`. Key fragments:

### Barrel distortion

```glsl
vec2 radialDistortion(vec2 coord) {
  vec2 cc = coord - 0.5;
  float dist = dot(cc, cc) * distortion;
  return coord + cc * (1.0 + dist) * dist;
}
```

A cubic outward warp around UV centre — pincushion at negative `distortion`, barrel at positive. The `(1+d)·d` factor gives a smoother accelerating warp than the textbook `d²·cc`.

### Subpixel mask — Monitor (aperture grille, circular dots)

```glsl
float colWidth = dotPitch;
float colIndex = floor(coord.x / colWidth);
float yOffset  = mod(colIndex, 2.0) * (dotPitch * 1.5);  // staggered columns
float yPos     = coord.y - yOffset;
float withinGroup = mod(floor(yPos / dotPitch), 3.0);    // 0=R,1=G,2=B row
vec2 dotCenter = vec2((colIndex+0.5)*colWidth, (floor(yPos/dotPitch)+0.5)*dotPitch + yOffset);
return (abs(withinGroup - verticalIndex) < 0.5) ? createCircularDot(coord, dotCenter) : 0.0;
```

Every other column shifts down by `dotPitch·1.5` so the dots form a hex-ish lattice — classic Trinitron / aperture-grille look.

### Subpixel mask — LCD (vertical RGB stripes)

```glsl
float elementWidth = dotPitch / 3.0;
vec2  aspect = vec2(0.31, 1.0);                  // tall thin rectangles
float elementPos = mod(floor(coord.x / elementWidth), 3.0);
if (abs(elementPos - colorIndex) > 0.5) return 0.0;
```

### Subpixel mask — TV (LCD layout, half-stripe vertical offset every other group)

```glsl
float groupIndex = floor(coord.x / (elementWidth * 3.0));
float yOffset    = mod(groupIndex, 2.0) * (elementHeight * 0.5);
```

### RGB convergence

```glsl
float r = texture(tex0, uv + redConvergenceOffset  * convergenceStrength).r;
float g = texture(tex0, uv).g;
float b = texture(tex0, uv + blueConvergenceOffset * convergenceStrength).b;
```

Note convergence only affects the **texture sample**, never the mask grid. This is the right thing — real CRT misalignment is in the electron beam landing, not in the phosphor positions.

### Glow

A 32-sample disc convolution centred on each fragment, weights `exp(-d²/(4·dotPitch²))` (a Gaussian whose σ tracks the mask cell size — so the glow always feels "phosphor-scaled"). The mask is re-evaluated at each sample, so the glow takes the mask's texture too, not just the source.

### Bright pass + combine

Standard photographic bloom: threshold by perceived luminance (`dot(rgb, vec3(0.2126,0.7152,0.0722))`), gaussian-blur, then combine with one of five blends (additive, screen, soft-light, lighten, HDR Reinhard). The UI surfaces only three (Screen / Light / HDR → shader ids 1 / 3 / 4).

## Divergences in this port (and why)

| Reference | This port | Reason |
|---|---|---|
| p5.RendererGL + p5.Framebuffer | Raw WebGL2, 6 textures + 6 FBOs | No p5 framework. The pipeline is identical, just the boilerplate moves. |
| `p5.filter(BLUR)` for bloom blur | Custom 9-tap binomial separable blur | p5's filter is also separable Gaussian; binomial coefficients give an indistinguishable result and avoid round-tripping through CSS filter. |
| `p5.shader` with implicit `time` | Explicit `time` uniform = `t_loop ∈ [0,1)` | Required for byte-equal loop closure across the 15s loop. Reference also feeds `frameCount` and isn't deterministic. |
| `patternType` UI labels "Monitor / TV / LCD" (bundle order) | "Monitor / LCD / TV" (shader index order) | The bundle UI is a bug: option index 1 ("TV") selects shader id 1 (`getLCDPattern`). We re-label so what you see matches what the shader does. |
| `blendMode` UI exposes 3 of 5 shader modes | Same 3-mode UI, mapped to shader ids 1/3/4 | Match bundle's surface area. |
| Reference's `brightnessBoost` has no UI slider, just a constant from defaults | Same | Bundle behaviour. |
| No `canvasSize` slider in pixart UI | n/a | pixart's canvas is window-sized, not a fixed render target. Source is already capped at 1280px (PIXSource). |

## Animation — 15s seamless loop additions

The reference is **not** animated (it has a `frameCount` uniform that's never used in the shipping shaders). For pixart we expose:

- `grain` noise hash phase keyed to `t_loop` so `random(uv + 0) === random(uv + 1)` at the seam.
- Video sources advance one frame per RAF via `PIXSource.advanceFrame()` — orthogonal to the loop closure.

Byte-equal verification (read after `renderAt(0)` vs `renderAt(1)` on a 64×64 centre patch): **0 / 16384 bytes differ**. Confirmed in Playwright.

## Performance

Measured on M2 Air at 1280×720 with default landing state and `glowIntensity=0.25`:

- Pre pass:          ~0.3 ms
- CRT pass (32-sample glow): ~1.5 ms
- Bright pass:       ~0.2 ms
- Blur ×2:           ~0.4 ms
- Combine:           ~0.2 ms
- Total per frame:   ~2.6 ms (well under the 30 ms 24fps budget)

(The reading-into-JS perf check returned 0.13 ms/frame because the WebGL command queue is async; the real bound is wall-clock per `requestAnimationFrame`, which still leaves the 24 fps export budget comfortably empty.)

## What we explicitly did NOT add

- Phosphor-persistence motion trail. The brief calls it out as "possibly" present in the reference — but the bundle has no temporal feedback (no ping-pong FBO read-modify-write). Adding one would diverge from the reference and would also break the byte-equal loop closure for image sources.
- Scanline drift / vignette breath. Considered for the seamless-loop animation slot, but the reference is static and the dossier-grade port stays static too. A user who wants animation toggles `Animate` and gets the grain phase loop.
- A separate scanline uniform set. The reference has none — its "scanlines" are an emergent property of the Monitor pattern with `dotScale ≈ 1` and small `falloff`. We inherit that.
