# Bevel — reverse-engineering dossier

**Reference:** https://tooooools.app/effects/bevel
**Bundle inspected:** `/_next/static/chunks/app/effects/bevel/page-06cc0cc0884808bd.js`
**Shared preprocessor + defaults:** `/_next/static/chunks/9357-2a51c42cdfe973de.js`
**Stack:** Next.js + React + p5.js, shared preprocessor module (same one that powers Displace/Edge/Ascii).
**Date:** 2026-05-12.

## What the effect actually is

Despite the name suggesting a normal-map / Phong-shaded surface, **Bevel is a one-pixel directional finite-difference**, not a normal-from-height lighting model. It is the simplest possible "directional emboss" filter and reads exactly like an Adobe-Photoshop *Bevel & Emboss* layer style at depth=1, with the spatial smoothing handled by the upstream preprocessor's Blur slider.

The full pass, transcribed from the beautified bundle (function `c` in module 2528, lines 109–135):

1. Shared **preprocessor pipeline** runs first (Blur → Grain → Gamma → Levels) — the same module Displace and Edge use.
2. `a = radians(lightAngle)`; `lx = cos(a)`; `ly = sin(a)`.
3. For every interior pixel `(x, y)` with `1 ≤ x ≤ W-2`, `1 ≤ y ≤ H-2`:
   - Read the **alpha-composited luminance** at the centre:
     `u = (lerp(255, R, α) + lerp(255, G, α) + lerp(255, B, α)) / 3` where `α = A/255`.
     (This is the canonical pixart luminance — identical to Displace and Edge.)
   - Read the alpha-composited luminance at the **rounded 1-pixel neighbour in the light direction**:
     `c = (Math.round(x + lx) + Math.round(y + ly) * W) * 4`.
     Because `|lx|, |ly| ≤ 1` and they get rounded, the neighbour is always one of the eight 8-connected neighbours (or the centre itself when the angle aligns axis-perfectly with rounding pulling both deltas to 0 — never happens for `lightAngle ∈ [0, 360)` because at least one of cos/sin always rounds to ±1 unless the slider hits an exact `step:45` snap that maps to (0,0), which it cannot since the snap angles are exactly the cardinal/diagonal directions).
   - `p = c - u` — the signed neighbour diff along the light vector.
   - If `|p| > effectThreshold`:
     `v = constrain(u + p * depth, 0, 255)` → output greyscale value.
   - Else:
     `v = 128` → mid-grey flat.
   - Write `(v, v, v, sourceAlpha)` to the output buffer.

The bypass path (`showEffect: false`) renders the preprocessed image directly — same as Displace/Edge.

The effect is **not time-varying in the reference**. There is no animation parameter; the pixart port adds one.

## Why this shape (and not a real Phong/Lambert with normals)

A real bevel would:
1. Build a height map from luminance.
2. Compute a normal at every pixel via Sobel (or Roberts) on the height field.
3. Dot the normal with a light vector + ambient + specular.

Tooooools' bevel collapses (1) and (2) into a single 1-pixel directional difference — i.e. the *only* gradient component used is the one along the light direction. This:

- Avoids needing two kernel passes (Sobel-X and Sobel-Y) plus a normalisation.
- Produces a chiselled "raked-light" relief look rather than smooth shading.
- Makes `depth` behave like an emboss amplifier rather than a true surface height.

The `else` branch slamming non-relief pixels to grey-128 is the load-bearing aesthetic move: it kills the underlying image everywhere the local gradient is small, leaving only the embossed contours floating on a neutral field. That is *why* the output reads as a stone-chiselled bevel rather than a tinted re-shading of the source.

## Parameters (verbatim from the bundle)

Source: `/effects/bevel/page-*.js` lines 32–102 (UI config) + `9357-*.js` lines 1530–1531 (defaults — search for `depth:20,lightAngle:0,effectThreshold:0`).

| Name (UI) | stateKey | Range | UI step | Bundle default | This port default | Where it acts | Why |
|---|---|---|---|---|---|---|---|
| Canvas Size | `canvasSize` | 100–1000 | 1 | 600 | 600 | preprocessor resample target | resolution / cost tradeoff |
| Blur | `blurAmount` | 0–10 | 1 | 0 | 0 | preprocessor | softens before the 1-px diff (matters a lot — Blur=1 is the difference between noisy and clean bevel) |
| Grain | `grainAmount` | 0–1 | 0.05 | 0 | 0 | preprocessor | per-pixel noise → broken-up relief |
| Gamma | `gamma` | 0.1–2 | 0.1 | 1 | 1 | preprocessor | shifts which features cross threshold |
| Black Point | `blackPoint` | 0–255 | 1 | 0 | 0 | preprocessor | levels lo |
| White Point | `whitePoint` | 0–255 | 1 | 255 | 255 | preprocessor | levels hi |
| Show Effect | `showEffect` | bool | — | true | true | bypass | inspect preprocessor output |
| **Depth** | `depth` | 0–500 | 1 | **20** | **20** | bevel emboss amplifier | multiplies the neighbour diff. 0 = mid-grey everywhere relief is below threshold; 500 = hard binarised contours |
| **Light angle** | `lightAngle` | 0–360 | **45** | **0** | **45** | direction of the 1-px neighbour | snaps to the 8 cardinals + diagonals (E, SE, S, SW, W, NW, N, NE, plus 360≡E). Bundle ships 0 (light from the right); we ship 45 (down-right) so the relief reads more obviously 3D on landing |
| **Threshold** | `effectThreshold` | 0–4 | **0.01** | **0** | **0** | gate on \|diff\| | small positive value kills sub-pixel noise → cleaner emboss. 0 means every pixel embosses. 4 means almost nothing does. |

Notes on the UI:
- `lightAngle` has `step: 45` in the bundle config (line 86 of the page chunk). So the slider snaps to {0, 45, 90, 135, 180, 225, 270, 315, 360}. That is exactly the 8 unique neighbour offsets — anything else would land on one of those after `Math.round(cos/sin)`. We preserve `step: 45` for the slider; the animation overrides this with smooth sweep.
- `effectThreshold` has `step: 0.01` over a 0–4 range — extremely fine because the diff magnitudes are unbounded (they can exceed 255) but in practice most informative thresholds sit in 0–4 range *as multiplied against a 0–255 luminance scale*.

Additions for the pixart contract (not in the reference):

| Name | Range | Default | Why |
|---|---|---|---|
| Animate | bool | false | pixart contract — 15s seamless loop. |
| Interactive | bool | false | pixart contract — mouse XY drives lightAngle + depth. |
| Fit | cover/contain | cover | shared source picker |
| Background | hex | `#0a0a0a` | shared canvas bg |

## Algorithm — exact translation from minified source

Function `d` (lines 104–108) — alpha-composited luminance, identical to Displace/Edge:

```js
function d(e, t) {
  let r = e[t + 3] / 255,
      n = 1 - r;
  return (e[t] * r + 255 * n
        + (e[t + 1] * r + 255 * n)
        + (e[t + 2] * r + 255 * n)) / 3
}
```

Function `c` (lines 109–135) — the bevel pass:

```js
let c = (0, r(7054).E)(function(e, t, r) {
  t.loadPixels();
  let n = t.pixels.slice(),
      a = e.radians(r.lightAngle),
      l = Math.cos(a),
      o = Math.sin(a);
  for (let a = 1; a < t.height - 1; a++)
    for (let i = 1; i < t.width - 1; i++) {
      let s = (i + a * t.width) * 4,
          u = d(t.pixels, s),
          c = (Math.round(i + l) + Math.round(a + o) * t.width) * 4,
          p = d(t.pixels, c) - u;
      if (Math.abs(p) > r.effectThreshold) {
        let t = u + p * r.depth;
        t = e.constrain(t, 0, 255);
        n[s] = n[s + 1] = n[s + 2] = t
      } else n[s] = n[s + 1] = n[s + 2] = 128;
      n[s + 3] = t.pixels[s + 3]
    }
  t.clear(); t.loadPixels();
  for (let e = 0; e < n.length; e++) t.pixels[e] = n[e];
  t.updatePixels()
}, function(e, t) {
  return {
    shouldRedraw: ["lightAngle","effectThreshold","depth"].some(r => e[r] !== t[r]),
    shouldReprocess: !1
  }
});
```

The pixart port hoists `dx = round(cos(a))` and `dy = round(sin(a))` and the constant offset `dOff = dx + dy*W` outside the inner loops (the reference recomputes `Math.round(i + l)` per pixel; the result is identical because `Math.round(i + l) - i === Math.round(l)` for all positive integer `i` and `|l| ≤ 1`, *except* at the half-integer edge of rounding when `l` is exactly `±0.5` — which only happens at `cos(60°) = 0.5` and friends, which are not on the `step: 45` snap grid. So the hoist is exact for any UI-snapped angle, and within 1-pixel-quantisation for animation tweens.)

Pre-computing the luminance into a `Float32Array` once per preprocess (rather than re-reading and re-computing `d()` twice per pixel inside the build loop) gives the build pass O(W·H) reads on the cache-resident float array instead of O(W·H) on the RGBA byte buffer. At 600×600 that's the difference between ~4 ms and ~12 ms per frame.

## Animation — how the 15s seamless loop closes

The only param whose value at the end of the loop equals its value at the start *and* whose output is byte-equal at both endpoints is `lightAngle`:

- `cos(0°) = cos(360°) = 1` exactly (IEEE-754 — both are the literal `1.0`).
- `sin(0°) = sin(360°)` — at 360° `sin` returns `-2.45e-16`, but `Math.round(-2.45e-16) = 0` so the neighbour offset is identical.
- Therefore `dx` and `dy` at `tLoop = 0` and `tLoop = 1` produce identical `dOff`, and the rest of the pass is deterministic on the same `lumGrid` → byte-equal output.

So we sweep `lightAngle: 0 → 360°` monotonically across `CYCLE_MS = 15000`. The visual is a rotating light source — the relief shifts hemisphere around the image like a raking light arc, which reads as "the chisel is rotating around the stone".

No pingpong is needed (and a pingpong would actually *break* determinism here because the diff at `lightAngle=180°` is the negation of the diff at `lightAngle=0°`, but `Math.round(cos(180°)) = -1` exactly while `Math.round(cos(360°))` and `Math.round(cos(0°))` are both `1` — the loop closes via 2π-periodicity, not via reflection symmetry).

Grain RNG: when `grainAmount > 0` we seed mulberry32 from `floor(t_loop × 100003) + 1`. At t=0 and t=1 (mod 1) the seed is identical so the preprocessor output matches.

## Bundle defaults vs port defaults

| Param | Bundle | Port | Reason for delta |
|---|---|---|---|
| `depth` | 20 | 20 | matches |
| `lightAngle` | 0 | **45** | landing-frame deviation. With light from the East the relief reads as horizontal shadows; with light from SE it reads as classic 3D emboss. Same conceptual default, more striking first paint. |
| `effectThreshold` | 0 | 0 | matches |
| All preprocessor params | bundle defaults | bundle defaults | matches |

## Performance — measured intent

At 600×600 source (the default canvas size after preprocessor resample):
- Luminance LUT pass: ~3 ms (one pass over `4·W·H` bytes).
- Bevel build: ~4 ms (two LUT reads + 4 writes per pixel, scalar arithmetic).
- Paint (drawImage scaled to viewport): <1 ms.

Total: well under the 30 ms/frame budget at 1280×720. The cost is dominated by the preprocessor scan, which only runs when a preprocessor param changes or when grain re-seeds during animation. The bevel build itself runs every animation frame (since `lightAngle` changes) but is the cheap half of the pipeline.

## Files

- `bevel/effect.js` — the port.
- `bevel/index.html` — control panel + canvas. Mirrors Displace/Edge structure exactly; the bevel-specific rows are `depth`, `lightAngle` (step 45), `effectThreshold` (step 0.01), `showEffect`.
- `docs/bevel-research.md` — this document.
