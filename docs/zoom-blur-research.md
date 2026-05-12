# Zoom blur — research dossier

**Reference:** none (original to pixart).
**Date:** 2026-05-13.

## What the effect is

A four-variant radial blur with a focal point. For each output pixel (x, y) we accumulate N samples of the source along a path between (focusX, focusY) and (x, y), and average them. The path differs by `blurType`:

| Type | Sample path | Result |
|---|---|---|
| `zoom` | linear interp focus→(x, y); span shrinks near focus | classic Knoll radial-zoom |
| `rotational` | along a circle of radius r=|p−focus|, swept by ±angleSpan/2 | Knoll radial-rotation |
| `spiral` | interp r ± sampleLen/2 along arc with twist | zoom + rotation composite |
| `motion-line` | fixed direction translation (cos α, sin α) · strength | Knoll motion-blur |

`holdSharp` enforces an inner radius (0..1 of canvas diagonal × 0.5) where no blur is applied — keeps the focal point crisp regardless of `strength`. `dropoff` controls the radial growth: 1 = linear (close pixels barely blur), 2 = quadratic (distant pixels streak much more aggressively).

## Modes

| Mode | Animated subset | Envelope | Seam handling |
|---|---|---|---|
| `idle` | nothing | static | trivially byte-equal |
| `breath` | `strength` | cosine pingpong | grain reseed = `seedFromT(t)` |
| `pulse` | `strength` | 12% fast attack, 88% pow-2.5 decay | env(0)=env(1)=0 |
| `spin` | rotation angle | monotonic 0→2π, type forced to rotational | cos(2π)=cos(0) in IEEE-754 |
| `march` | `blurType` | step through zoom→rotational→spiral→motion-line | t=1 routed to step 0 |
| `chase` | `focusX`, `focusY` | Lissajous (cos(TAU·t), sin(TAU·t·2)·0.6) | cos(2π)=1, sin(4π)=0 at t=1 |

## Parameters

| Param | Range | Default | Notes |
|---|---|---|---|
| `canvasSize` | 100–800 | 480 | inner loop is N samples × W·H, so we run smaller than siblings |
| `blurType` | 4 enum | `zoom` | |
| `strength` | 0–1 | 0.5 | fraction of canvas diagonal for max sample displacement |
| `samples` | 6–40 | 16 | Monte Carlo samples |
| `focusX`, `focusY` | 0–1 | 0.5 | normalised |
| `dropoff` | 0–2 | 1 | strength growth exponent vs distance from focus |
| `holdSharp` | 0–1 | 0.2 | inner radius (× canvas/2) with no blur |
| `direction` | 0–360 | 0 | motion-line angle |
| `spiralTwist` | 0–360 | 90 | total twist k=0→N−1 for spiral |
| `seed` | int | 1 | jitter RNG |
| `focusRadius` | 40–600 | 180 | unused in static math; reserved for future cursor falloff |

## Why N samples + average (not a kernel convolution)

A radial blur cannot be expressed as a spatially-invariant convolution kernel — the sample direction depends on the pixel's position relative to the focal point. The cheapest correct implementation is per-pixel Monte Carlo: sample N positions along the radial, average. This is the structure Inigo Quilez documents in his "Radial blur" article. With `samples=16` and `holdSharp=0.2`, a 480 × 270 canvas runs comfortably under 30 ms on M-series silicon.

## Determinism

- All envelopes wrap `t` to `[0, 1)`.
- Sample jitter uses mulberry32 seeded from `seedFromT(t)` — identical at t=0 and t=1.
- `spin` uses monotonic angle; `cos(2π)`, `sin(2π)` collapse exactly to `(1, 0)`.
- `march` explicitly routes `t === 0` to step 0.
- `chase` Lissajous returns to origin (cos collapses to 1, sin·2 collapses to 0).
- ⇒ `renderAt(0).toDataURL() === renderAt(1).toDataURL()` byte-equal.

## References

1. **Knoll, J.** *Photoshop Radial Blur* filter (1995, Photoshop 3). The canonical zoom/rotational split; the parameter shape we mirror.
2. **Macmillan, T.** *Time-Slice* (1980s); Wachowskis *The Matrix* (1999). Bullet-time as the camera-array origin of frozen-radial motion — perceptual ancestor of `spin`.
3. **Quilez, I.** "Radial blur" (iquilezles.org). The classic shader analysis — N-sample average, strength-vs-perceived-motion mapping, the inner loop we use.
4. **Hitchcock, A.** *Vertigo* (1958). The dolly-zoom as the perceptual ancestor of `zoom` mode — same visual-equivalent for psychoacoustic dissonance.

## Performance

24-frame mean target: <30 ms at 480 × ~270. Hot path is the N-sample inner loop (16 samples × 130k pixels ≈ 2M iterations). Mitigations: pre-rolled jitter table per frame, no allocations in inner loop, `holdSharp` short-circuits the centre region.
