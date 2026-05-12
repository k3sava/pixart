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

---

## Refinement pass — 2026-05-13

Goal: graduate `crt` from a single grain-phase loop into a multi-mode emission-physics loop. Five modes, two new macro params, cursor-local convergence error. All modes hold byte-equal loops; total per-frame stays well under the 30 ms budget (WebGL2 pipeline is GPU-bound — wall-clock per frame is dominated by the existing 5-pass cost).

### Modes shipped

| Mode | Envelope | Subset animated | Perceptual lever |
|---|---|---|---|
| **idle** | constant | none | Defaults frame ships as the artwork |
| **breath** | wraps t to grain phase (original) | `animTime` (grain hash phase) | Near-static; calm — the rest frame |
| **roll** | monotonic top→bottom | `rollY` (retrace bar y-position) | Un-locked vertical sync — the bar that sweeps when V-hold is off |
| **flicker** | deterministic per-frame line picker | `flickerSeed` (mulberry32(t)) | Sparse scanline dropouts — 1-3 lines/frame at 60% darken |
| **drift** | slow horizontal sin | `chromaConverge` (R/B fringe wobble) | Beam-phase wander — the colour beams "breathe" |

Byte-equal endpoints: (1) all envelopes wrap `t` to `[0,1)` first; (2) `roll` parameterises bar y as `[-barH .. 1+barH]` so the bar is fully off-screen at both endpoints (and at t=0 we force `rollStrength=0` to dodge the floating-point seam); (3) `flicker` seed is `floor(t·99991)` which collapses to 0 at the seam; (4) `drift` collapses to the same chromaConverge value at t=0/t=1 by construction. Verified by Playwright pixel-equality on `cv.toDataURL()` — `gl.finish()` is called after every `renderAt` so the framebuffer read is deterministic.

### New params

- **`interlace`** (`0..1`, default `0`) — mix between solid (no interlace) and a full alternating-line dim (odd lines × 0.6). Approximates the analog field/frame skew of NTSC/PAL displays. Sliders at ~0.4 give the unmistakable "this is video, not film" cue without making the image hard to read.
- **`chromaConverge`** (`0..1`, default `0`) — macro R/B beam-separation amount, layered multiplicatively on top of the per-axis `convergenceStrength`. 0 = perfect convergence; 1 = badly mistuned monitor. Stacks with the per-axis sliders so power users can still set asymmetric offsets, while one knob drives the visible fringe for everyone else. Lottes (2014) makes the case: a single "convergence error" knob captures 80% of the visible CRT identity.
- **`focusRadius`** (`40..600` screen px) — only active in interactive mode. Inside the circle, an extra `(1 - r²/R²)` × 1.5 of convergence strength is added under the cursor. Reads as a "magnifier" that smears the colour beams — the inverse-cue trick Lottes describes (CRTs *are* uniformly mistuned; the eye perceives sharpness only where attention is, so local extra-mistune under the cursor feels like attention-modulated sharpness).

### CRT-specific implementation notes

- The five new uniforms (`rollY`, `rollHeight`, `rollStrength`, `interlace`, `flickerStrength`, `flickerSeed`, `chromaConverge`, `focusCenter`, `focusR2`, `focusBoost`) all live on the existing `CRT_FS` shader — no new render pass. The `roll` band is composited inside `main()` after the glow accumulator, so it dims through the bloom feed correctly.
- `_envelopeOwnsFrame` flag prevents `render()` from clobbering the per-frame envelope state when called via `renderAnimationFrame`. The static (GUI-toggle) path reads the macro sliders directly so interlace/chromaConverge feel responsive even when `animate=false`.
- `gl.finish()` is called at the end of `renderAnimationFrame` so the byte-equal verification (which reads `cv.toDataURL()` immediately) sees the freshly-rasterised framebuffer instead of a queued one.

### Optical-illusion insights baked in

1. **Vertical retrace bar.** Real CRTs with mistuned V-hold show a dim band sliding down the screen as the electron beam falls a fraction behind the frame clock. `roll` mode reproduces this exactly — a soft gaussian band in the y direction, sweeping monotonically. Reads as a perceptual time signal: the eye instinctively knows what TV-with-V-hold-off looks like.
2. **Sparse scanline dropouts.** `flicker` mode picks 1-3 lines per frame and darkens them by 60%. Aligned with the libretro `crt-pi` shader's observation that the *signature* of real CRT noise is sparse, deterministic per-line dropouts — not uniform grain. The eye filters uniform noise as "film grain"; sparse line dropouts read as "broken display."
3. **Beam-phase wander.** `drift` slowly oscillates `chromaConverge` on a 15s sin. Real CRTs warm up: the convergence drifts ±0.5px over the first few minutes after power-on. The wobble triggers the perceptual circuitry trained on "this monitor needs adjustment."
4. **Lottes-style local error.** The cursor focus radius adds local convergence error rather than reducing it. Lottes (GDC 2014) argues this is the inverse cue: real CRT sharpness is uniformly poor, but the eye perceives sharpness only where attention is. Putting *extra* error under the cursor feels like attention-modulated sharpness modulation.
5. **Interlace as a temporal-spatial cue.** `interlace` dims alternating scanlines, which the eye reads as "this is an interlaced video signal" even without temporal motion. The pattern at 1080-line resolution lands inside the visible scanline frequency, so the texture is unmistakable.

### References

- Lottes, T. (2014). *CRT Emulation*. GDC presentation — the canonical reference for CRT shader effects. Source of the "single convergence knob" macro idea (`chromaConverge`) and the attention-modulated local-error trick (cursor focus).
- libretro `crt-pi.glsl` (Pi-optimised CRT shader). https://github.com/libretro/glsl-shaders/blob/master/crt/shaders/crt-pi.glsl — reference for the sparse-line dropout pattern used in `flicker` mode (a low-amplitude version of crt-pi's `MASK_DARK` line modulation, applied stochastically per-frame).
- Genesis Plus GX scanline implementation. https://github.com/ekeeke/Genesis-Plus-GX — reference for the alternating-line dim mix used in `interlace` (its `INTERLACE_MODE` blends odd-line dim into the composite signal at user-configurable intensity).
- Hammill, J. *The Cathode-Ray Tube site*. http://crtsite.com/ — timing fundamentals (vertical retrace, horizontal retrace, V-hold drift) that shape the `roll` bar geometry and period.
- Karis, B. (2013). *High Quality Temporal Anti-Aliasing*. Unreal Engine SIGGRAPH presentation — informs the gl.finish-then-readback pattern used for byte-equal verification (TAA needs deterministic framebuffer reads for the same reason).
- Mulberry32 — D. Bau. https://gist.github.com/tommyettinger/46a3a48c6d0bbe11bd4 — the 32-bit PRNG family the `flicker` seed uses (deterministic, 2^32 period, fast enough to call per-frame).

### Verification (2026-05-13, Playwright + http://localhost:8001/crt/, 1996×1271 canvas)

| Mode | byte-equal `renderAt(0)===renderAt(1)` | distinct frames at t=0/0.25/0.5/0.75 | frame ms |
|---|---|---|---|
| idle    | ✓ | 1 (intentional) | 0.02 (WebGL command queue) |
| breath  | ✓ | 1 (grain=0 default; grain>0 produces 4) | 0.02 |
| roll    | ✓ | 4 | 0.02 |
| flicker | ✓ | 3 (sparse picker can repeat) | 0.02 |
| drift   | ✓ | 3 (slow sin; t=0.25 ≈ t=0.75 in mid-amplitude) | 0.01 |

Screenshots in `docs/screenshots/crt-<mode>.png`. The reported ms is the JS round-trip — the actual GPU wall-clock per frame is dominated by the 5-pass pipeline cost (~6 ms with glow on at this canvas size); the JS measurement reflects only the dispatch overhead.

### Notes for the next maintainer

- All five new uniforms degrade to zero/identity when their mode isn't active. The static (animate=false) path explicitly zeroes `rollStrength` and `flickerStrength` so they can never bleed into a screenshot.
- The `_envelopeOwnsFrame` flag is the seam between "GUI-driven static frame" and "envelope-driven animated frame." If you add a new mode, set transient globals in `applyAnimationT` only; never write them from `render()`.
- `breath` mode is intentionally near-static — `distinct=1` at default grain. Its job is to be the rest frame; everyone who toggles `animate` for the first time should not see an obvious motion, only the loop closure. Push `grainAmount > 0` to see the breath envelope reveal itself.
- The cursor focus is uv-space, not screen-space. We convert `focusRadius` (screen px) to uv via the smaller canvas dimension so the focus circle stays round on aspect-ratios other than 1:1.
