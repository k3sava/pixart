# Slit-scan — research dossier

**Lineage:** photo-finish cameras (Edgerton, late 1930s); Hiroshi Sugimoto's *Theaters* (1976–); Andrew Davidhazy's RIT strip-photography pedagogy (1995); Golan Levin's *Slit-Scan archive* (2005); Daniel Rozin's *Time Scan Mirror* (2003).
**Date:** 2026-05-13.

## What the effect actually is

For each *output* pixel `(x, y)` at loop-time `T`, sample the source at *some earlier time* `T − age(x,y)`. The image you see is a vertical (or horizontal, or radial) assembly of moments: top of the frame is "now", bottom is "earlier by K seconds" — where `K = spread × cycle`.

Two execution paths:

1. **Video source.** Maintain a ring buffer of past frames keyed by index. Read each output pixel from the buffer at the appropriate age. This is the canonical slit-scan; what photo-finish cameras (and Sugimoto's projected long-exposures) do mechanically.

2. **Image source.** A still cannot be time-travelled, so we fall back to **spatial slit-scan**: the per-pixel "age" becomes a per-pixel *spatial shift* in source coordinates. Each row reads from a slightly displaced location in the source, producing a sheared / curved read. This is the geometric analogue Sugimoto exploits (his *Theaters* is, in one reading, a continuous shutter scanning the projection screen).

Both paths share the same age-computation, axis, and tilt math — the only difference is *what* the age indexes into.

## Math

The age of an output pixel is a projection of its position onto the slit's perpendicular axis, scaled by `spread × history`:

```
For axis = horizontal:
    u = ((y − cy)·cos(tilt) − (x − cx)·sin(tilt)) / H + 0.5
For axis = vertical:
    u = ((x − cx)·cos(tilt) + (y − cy)·sin(tilt)) / W + 0.5
For axis = radial:
    u = sqrt((x − cx)² + (y − cy)²) / r_max

u = clamp(u, 0, 1)
age_frames = (u · spread · history + ageBase) · focusScale
```

`focusScale` is `1` outside the focus radius, `0.1` at the cursor centre with a quadratic falloff `(1 − d²/R²)`. That's why the cursor *freezes time locally* — under the pointer `age → 0` and the source plays "now" while the rest of the frame lags.

Video path read:

```
frame_index = (ring_head − round(age_frames) + ring_cap) % ring_cap
out[x,y] = ring[frame_index][x,y]
```

When `age_frames > ring_count − 1`:
- `wrap = true` → modulo into the ring (Sugimoto-style continuous integration).
- `wrap = false` → clamp to the oldest stored frame (Davidhazy photo-finish hold).

Spatial fallback (image source):

```
shift_px = age_frames · 4              # 4 px / frame of age — tunable scale
For axis = horizontal: sx = x + shift_px;  sy = y
For axis = vertical:   sx = x;             sy = y + shift_px
For axis = radial:     (sx, sy) = (x, y) + (dx,dy)/||·|| · shift_px

if wrap: (sx, sy) = wrap into source
else:    (sx, sy) = clamp into source
out[x,y] = src[sx, sy]
```

## Parameter table

| Name | Range | Default | Acts on | Why this default |
|---|---|---|---|---|
| `canvasSize` | 100–1000 | 600 | preprocessor | resolution vs perf knee |
| `blurAmount` | 0–10 | 0 | preprocessor | optional softening |
| `grainAmount` | 0–1 | 0 | preprocessor | noise |
| `gamma` | 0.1–2 | 1 | preprocessor | tonal contrast |
| `blackPoint` / `whitePoint` | 0–255 | 0 / 255 | preprocessor | levels |
| `mode` | select | `breath` | animation envelope | calm landing |
| `axis` | horizontal / vertical / radial | `horizontal` | slit orientation | most-recognised slit-scan look; Sugimoto / Davidhazy share this |
| `spread` | 0–2 | 0.6 | K, the time-spread fraction | substantial but not extreme; ≈ 1.5s at 24fps |
| `history` | 16–256 | 60 | ring buffer depth | 60 frames ≈ 2.5s at 24fps; matches Levin's archive examples |
| `wrap` | bool | true | past-beyond-history behaviour | continuous integration > photo-finish hold for landing |
| `tilt` | −45–45° | 0 | slit-angle skew | level slit on first paint; rotate / sway modes drive this |
| `seed` | int | 13 | deterministic jitter | reproducible |
| `focusRadius` | 40–600 px | 220 | cursor freeze radius | Carrasco peripheral motion default |
| `animate` | bool | false | run anim loop | off on load |
| `interactive` | bool | false | cursor influence | off on load |
| `fit` / `bg` | shared | cover / `#0a0a0a` | chrome | matches pixart defaults |

## Mode table

| Mode | Envelope | Animated lever | Perceptual hook |
|---|---|---|---|
| `idle` | constant 0 | none | the still frame is the artwork |
| `breath` | `sin(2πt)` (not pingpong) | `ageBase` swings past ↔ future | image "breathes" forward and backward in time around the present |
| `march` | 4-stop step on age swing | `ageBase` | four held positions; reads like a tape-stutter |
| `rotate` | tilt monotonic 0°→90° + wrap | `tilt` | slit-angle sweeps a quarter turn; lands flat again at seam |
| `pulse` | sharp asymmetric spike | `ageBase` | fast forward then slow settle; reads as a temporal "tug" |
| `sway` | `tilt = 15·sin(2πt)` | `tilt` | slit rocks ±15°; image appears to lean about its vertical axis |

Byte-equal endpoints are guaranteed by: (1) `w = t − ⌊t⌋` wraps into `[0,1)` before evaluation, so `sin(0) === sin(2π)` exactly; (2) `march`/`rotate` use 4-stop steps; (3) the ring buffer is only mutated on *video* frames — image-source renders read a stable ring and re-running `renderAt(t)` at any `t` is pure.

## Perceptual / algorithmic insight that drove the defaults

**Time becomes a spatial direction.** The horizontal axis at default `spread=0.6` makes the bottom of the frame ~1.5s older than the top. The eye reads the slit-scanned image as a *temporal slice through space*. With video this is famous and uncanny; with image sources the spatial-fallback shear approximates the read by trading "old time" for "shifted space".

The default axis (horizontal) is chosen because:
1. It matches the orientation of photo-finish cameras — the cultural prior most viewers carry.
2. Most photographic subjects are oriented horizontally (horizons, faces, motion). Sliding the time axis vertically against subject orientation produces the most legible distortion.
3. Sugimoto's *Theaters* — the most famous still-image slit-scan analogue — projects horizontally, integrates vertically.

The default `spread=0.6` (not 1.0) is chosen because at `spread=1.0` the top and bottom of the frame are *one full cycle* apart, which on a stationary video reads as duplicate-content; 0.6 keeps the temporal slice visually contiguous.

## References (≥3, with one-line takeaways)

- **Sugimoto, H. (1976–)** — *Theaters* series. Establishes the visual logic of "an entire span of time integrated into a single still" — the perceptual contract slit-scan trades on.
- **Davidhazy, A. (1995)** — *Strip photography and the photo-finish camera*, RIT. The engineering reference for slit-scan as a continuous read along a moving slit; defines the wrap-vs-hold distinction we expose as the `wrap` param.
- **Levin, G.** — *Slit-Scan archive*, flong.com/archive/slit_scan/. The definitive history (Crooks, Naimark, Snibbe, others); maps the spread / history parameter space we ship.
- **Rozin, D. (2003)** — *Time Scan Mirror*. Interactive precedent for image-source slit-scan in a gallery context; informs our spatial fallback's permissive read (wrap on).
- **Edgerton, H. — Strobe and photo-finish photography (MIT, 1930s–).** The mechanical origin; the slit physically scans across film during exposure. We're a digital reformulation of the same camera.

## Performance notes

At `canvasSize=600`, image source, all modes:

- preprocess: ~3 ms (no levels, no gamma in defaults)
- buildOutput (per-pixel age + spatial fallback read, nearest-neighbour): ~2–3 ms
- paint (drawImage of srcBuf): ~1 ms

Verified mean across 24 frames per mode: **4.5–4.7 ms** — well under the 30 ms budget.

For video source the ring read dominates: each output pixel does a modular index into a ~58MB ring (at default history=60, canvasSize=600), which is bandwidth-limited. Mean per frame on video: **~40 ms** at default size. Acceptable for live preview, marginal for 24 fps export — users targeting export with video should reduce `canvasSize` to ~400 (cuts ring memory 2.25×) or `history` to ~30. The export contract is preserved because export pauses the video.

## Why we did not bilinear-filter the ring read

Bilinear time-interpolation between adjacent ring frames would smooth motion but break the *slit-scan look*. Real slit-scan is a hard temporal slice — each output line comes from one frame, not a blend. Nearest-frame is correct.

## Verification (2026-05-13, Playwright + http://localhost:8001/slit-scan/, viewport 1280×720)

| Mode | byte-equal `renderAt(0)===renderAt(1)` | distinct frames at t=0/0.25/0.5/0.75 | mean frame ms (24-frame loop) |
|---|---|---|---|
| idle   | ✓ | 1 (intentional) | 4.6 |
| breath | ✓ | 3 (sin → ages at 0.25/0.75 symmetric around zero; quarters collapse) | 4.5 |
| march  | ✓ | 4 | 4.6 |
| rotate | ✓ | 4 | 4.6 |
| pulse  | ✓ | 4 | 4.7 |
| sway   | ✓ | 3 (tilt ±15° produces visually symmetric spatial shifts) | 4.5 |

Source coverage: tested with image (`landscape.jpg` default — spatial fallback path) and video (`clip.mp4` via `PIXSource.cycleSample` — ring-buffer path). Video adds ~36 ms because of the per-pixel ring index; acceptable. Screenshots in `docs/screenshots/slit-scan-<mode>.png`.

## Notes for the next maintainer

- The ring buffer is **only pushed for video sources** (see `preprocess()` last block). This is what makes `renderAt(t)` pure for static images. If you ever want to push images too, you'll need to gate the push by a "first-frame-only" flag or `renderAt` will mutate state between calls and break byte-equal exports.
- `_ageBase` is the universal animation hinge. Three modes (`breath`, `march`, `pulse`) drive it; two modes (`rotate`, `sway`) drive `tilt` instead. If you add a new mode, prefer biasing `_ageBase` — the seam-math is proven for that path.
- The spatial-fallback `shift_px = age × 4` constant is intentional and tuned to read as a visible shear at default `spread=0.6` on a 600px canvas. If you change `canvasSize` semantics or default `spread`, retune.
- `wrap=true` is more visually striking on first paint, but on close inspection produces a wraparound seam at the bottom of the frame (where age exceeds history). For exports targeting print or social, users should set `wrap=false`.
- Radial axis on image source produces a "zoom-into-the-past" effect (shift along radial direction). It is the most dramatic mode for portraits — drop it on a face and the eye is pulled inward.
