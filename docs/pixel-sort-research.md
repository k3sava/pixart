# Pixel-sort — research dossier

**Lineage:** Kim Asendorf, *ASDF pixel sort* (Processing, 2010, kimasendorf.com).
**Aesthetic ancestors:** Daniel Temkin (*Glitch::Art*, 2014), Antonio Roberts (Hellocatfood) glitch tutorials, the broader datamosh-poster movement.
**Date:** 2026-05-13.

## What the effect actually is

A run-based scan-line sort. For every line in the chosen direction (row / column / diagonal):

1. Walk the line, identifying **runs** of pixels that pass an eligibility mask. The mask is `thresholdLow ≤ luminance + bias ≤ thresholdHigh`. Pixels outside the band act as **walls** that break runs.
2. Within each run, **sort the pixels** by a key (`luminance` / `hue` / `saturation` / `red`). Sort is stable and ascending by default; `sortReverse` flips it.
3. Write the sorted run back into the output image in the same scan-line positions. Walls and out-of-band pixels are passed through unchanged.

The effect's identity comes entirely from the mask + the sort key. Setting the band to `[0, 255]` gives "sort the whole row" (one giant run; classic Asendorf glitch poster). Setting `[80, 220]` gives midtone-only streaks; shadows and highlights are preserved, which is the look most photographic sources benefit from.

## Math

Per scan line `S` of length `L` (indexed by `n ∈ [0, L)`):

```
runs = []
n = 0
while n < L:
    while n < L and not eligible(S[n]): n += 1
    s = n
    while n < L and eligible(S[n]):     n += 1
    if n - s > 1:
        runs.append((s, n))         # half-open

for (s, e) in runs:
    pixels = S[s:e]
    pixels.sort_by(key_fn)          # stable; reverse if sortReverse
    S[s:e] = pixels                 # gather into output buffer
```

Eligibility for a pixel `p`:

```
lum = 0.299·R + 0.587·G + 0.114·B + bias
       (+ focus_boost · (1 - d² / focusRadius²)   if interactive and inside circle)
return thresholdLow ≤ lum ≤ thresholdHigh
```

Sort keys (all return a scalar ordered ascending):

| Key | Formula | Why it reads the way it does |
|---|---|---|
| `luminance` | BT.601 luma | Asendorf's original; reads as "rivers of light" |
| `hue`       | HSL hue angle (0–360°, achromatic → 0) | Sorts colours into spectrum order — psychedelic rainbow runs |
| `saturation`| `(max−min)/max · 255` | Pastels and greys cluster at one end — quiet-vs-loud streaks |
| `red`       | R channel | False-colour datamosh; the cheapest possible key |

Direction is implemented as a list-of-line-index-arrays, each of which addresses pixels in the order the scan should walk. Diagonals are computed once per build:
- `diagonal-1` (↘): `x + y = k`, k ∈ [0, W+H−2]
- `diagonal-2` (↙): `x − y = k`, k ∈ [−(H−1), W−1]

Diagonal runs cross visually arbitrary regions and read as motion-blur streaks — the Hellocatfood-tutorial signature.

## Parameter table

| Name | Range | Default | Acts on | Why this default |
|---|---|---|---|---|
| `canvasSize` | 100–1000 | 600 | preprocessor | resolution vs perf knee |
| `blurAmount` | 0–10 | 0 | preprocessor | optional softening |
| `grainAmount` | 0–1 step 0.05 | 0 | preprocessor | noise before mask = jittered run boundaries |
| `gamma` | 0.1–2 step 0.1 | 1 | preprocessor | tonal contrast → which pixels qualify |
| `blackPoint` / `whitePoint` | 0–255 | 0 / 255 | preprocessor | levels remap |
| `mode` | select | `breath` | animation envelope | calm landing, easy to compare to other modes |
| `sortBy` | luminance / hue / saturation / red | `luminance` | sort key | Asendorf's canonical key |
| `direction` | row / column / diagonal-1 / diagonal-2 | `row` | scan axis | the canonical Asendorf horizontal streak |
| `thresholdLow` | 0–255 | 80 | mask gate | excludes deep shadows |
| `thresholdHigh` | 0–255 | 220 | mask gate | excludes blown highlights — midtones do the work |
| `sortReverse` | bool | false | sort order | bright trails *behind* runs (= "tails", which read as motion) |
| `bias` | −128–128 | 0 | per-pixel lum offset | animation modes drive this |
| `seed` | int | 7 | grain / future jitter | reproducible loop |
| `focusRadius` | 40–600 px | 220 | cursor amplifier | Carrasco-peripheral motion default |
| `animate` | bool | false | run anim loop | off-on-load; press to engage |
| `interactive` | bool | false | cursor influence | off-on-load |
| `fit` / `bg` | shared | cover / `#0a0a0a` | chrome | matches pixart defaults |

## Mode table

| Mode | Envelope | Animated lever | Perceptual hook |
|---|---|---|---|
| `idle` | constant 0 | none | rest frame is the artwork |
| `breath` | cosine pingpong | `bias` (band widens then closes) | calm tonal breathe; midtones flood and recede |
| `march` | 4-stop step | `bias` (4 discrete band positions) | deliberate VHS-jog — each stop is a held still |
| `rotate` | 4-stop step | `direction` (row → diag-1 → column → diag-2) | the streak axis "rotates" 90° per beat |
| `pulse` | fast rise + slow decay | `bias` spike | glitch-impulse beat; the field "punches" then settles |
| `cascade` | monotonic 0→1, wraps to 0 at seam | `cascadeFront` (line cutoff) | sort wipes across the image — a curtain of glitch |

Byte-equal loop endpoints are guaranteed by three rules: (1) all envelopes wrap `t` to `[0,1)` before evaluation so `cos(2π·t) == cos(0)` exactly at the seam; (2) `march` and `rotate` are step-4 so `step(0) == step(4)`; (3) `cascade`'s monotonic ramp is replaced by `0` at the exact `w=0` seam point.

## Perceptual / algorithmic insight that drove the defaults

**The eye reads sorted runs as motion blur.** A row where the bright pixels have migrated to one end looks like the bright thing was moving — even on a still source, even though no temporal information exists. This is the central illusion. The default band `[80, 220]` (midtones only) maximises this read because:

1. Midtones carry the photographic information — sorting them produces clearly visible streaks.
2. Excluding shadows preserves the silhouette anchor; without an anchor the streaks feel arbitrary.
3. Excluding highlights preserves specular detail, which we read as material reality.

The combination makes the image look like it has been frozen mid-motion, which is why this default reads as cinematic and not noise.

## References (≥3, with one-line takeaways)

- **Asendorf, K. (2010)** — *ASDF pixel sort* Processing sketch. The original implementation; defined the run-based scan + key-based sort that we mirror.
- **Temkin, D. (2014)** — *Glitch::Art* (glitchet.com lineage). Articulated the aesthetic register: pixel-sort is a *deliberate* glitch, not corruption; the artist controls the mask.
- **Roberts, A. (Hellocatfood) — Pixel sort tutorials.** Extended the canon with diagonal directions and column scans; defined the modern "all four axes" parameter space we ship.
- **Sugimoto, H. (1976–)** — *Theaters* series. Not pixel-sort, but the same intellectual move: a single frame as the integration of many. Useful comparison for thinking about masks as integration boundaries.
- **Shadertoy `XdfGzj`** — Pixel-sort GLSL demo. Confirms the threshold-as-mask formulation we use; informed the spread-band (vs single-threshold) generalisation.

## Performance notes

At `canvasSize=600`, photo source, image (no video ring), `direction=row`:

- preprocess: ~5 ms (600×400×4 with gamma LUT and levels off)
- build (rows × runs × sort): ~10–14 ms depending on band; midtone band gives shorter runs ⇒ faster
- paint (blit ImageData via `srcBuf`): ~2 ms

Verified mean across 24 frames per mode: **11.5–17.8 ms** — comfortably under the 30 ms budget for 24 fps export. Diagonal directions add ~3 ms per build because the line-index arrays are allocated each build (could be cached if it ever mattered).

## Verification (2026-05-13, Playwright + http://localhost:8001/pixel-sort/, viewport 1280×720)

| Mode | byte-equal `renderAt(0)===renderAt(1)` | distinct frames at t=0/0.25/0.5/0.75 | mean frame ms (24-frame loop) |
|---|---|---|---|
| idle    | ✓ | 1 (intentional) | 12.9 |
| breath  | ✓ | 3 (pingpong → bias zeros at quarters collapse to same) | 17.1 |
| march   | ✓ | 3 (4 stops → 3 unique non-seam) | 17.1 |
| rotate  | ✓ | 3 (4 axes → 3 unique non-seam) | 14.5 |
| pulse   | ✓ | 4 | 17.8 |
| cascade | ✓ | 4 | 11.5 |

Source coverage: tested with image (`landscape.jpg` default) and video (`clip.mp4` via `PIXSource.cycleSample`). Video source advances frames between renderAt calls so byte-equal does not hold across a moving clip — but the algorithm runs correctly per frame, and export discipline (pause-then-export) preserves the contract. Screenshots in `docs/screenshots/pixel-sort-<mode>.png`.

## Why these defaults (and not Asendorf's literal)

Asendorf's reference ships with `direction=row, sortBy=luminance, threshold=blackThreshold OR brightnessThreshold OR whiteThreshold` (three discrete masks). We collapsed that to a **band on luminance** because:
- It's a strict superset (low=0 = "white threshold"; high=255 = "black threshold"; band-anywhere = his brightness threshold).
- A single band is more legible in the GUI.
- The midtone-band default produces a more striking landing frame than any of his three discrete masks on most photographic sources.

## Notes for the next maintainer

- The `Array.from(typedArray).sort(cmp)` round-trip is the hot path. For runs longer than ~W (only possible with band [0,255] and row scan on a flat image) it would be worth replacing with an in-place quicksort. Skipped because the default mask always produces sub-row runs.
- `bias` is the animation hinge — every animation mode drives it (except `rotate` which drives `direction` and `cascade` which drives the line cutoff). If you add a new mode, prefer biasing the band over changing other params; the seam-equality math is already proven for that path.
- `interactive` widens the band locally, which can produce *very* long runs under the cursor and momentarily push frame time over 30 ms. This is intentional — the toy should feel "alive" under the pointer.
