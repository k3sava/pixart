# Dots — reference dossier

Port of `tooooools.app/effects/dots`. Dots is the **round-dot sibling of
Stippling** — same halftone family, different cell primitive.

## Bundle artifacts

- Page chunk: `/_next/static/chunks/app/effects/dots/page-796cf0ef3ab6e76d.js`
- Shared chunk (defaults + preprocessor): `/_next/static/chunks/9357-2a51c42cdfe973de.js`

Both fetched via `curl -sL https://www.tooooools.app/...` and beautified with
`js-beautify`. Local copies stashed at `/tmp/dots-page.beauty.js` and
`/tmp/9357.beauty.js` for diff parity checks.

## Algorithmic distinction vs Stippling

Both effects share the same scaffolding (alpha-composited luminance,
rotation widening `n = |cos|+|sin|`, threshold gate, Benday stagger, the
canonical preprocessor stack). The cell primitive differs:

| Aspect            | Stippling (`/effects/stipping`)     | Dots (`/effects/dots`)             |
|-------------------|--------------------------------------|------------------------------------|
| Cell primitive    | Vertical bar (rect)                  | Square / rounded square            |
| Cell sizing       | Width varies, height = full cell `l` | Both sides vary together (`k×k`)   |
| Grid resolution   | `xSquares × ySquares` (counts)       | `stepSize` (pixels per cell)       |
| Corner radius     | n/a (sharp rects)                    | `cornerRadius` ∈ [0..20]           |
| Jitter            | none                                 | Perlin `displacementFactor` ∈ [0..20] |
| Visual register   | Newspaper halftone bars              | Newspaper halftone dots / Ben Day  |

At `cornerRadius = 20` with `maxDotSize ≤ 40`, the rounded square's radius
saturates at half-side and the dot reads as a perfect circle. This is how
Dots ships its "round halftone" look despite using `rect()`.

## Reference algorithm (verbatim)

From beautified `page-dots.js` lines 154-208, identifiers restored:

```js
let n = e.radians(a.angle || 0),
    r = Math.abs(Math.cos(n)) + Math.abs(Math.sin(n));      // rotation widening
let l = a.stepSize, o = a.stepSize;
let i = sqrt(W*W + H*H);                                     // diagonal
let s = W/2, u = H/2;                                        // canvas centre
let d = ceil(i/o) + 4, p = ceil(i/l) + 4;                    // cell-count caps
let f = (W % l) / 2, m = (H % o) / 2;                        // remainder-centre
let y = 0.5 / Math.max(1, a.displacementFactor / 50);        // noise frequency

for (let i = -d; i < d; i++) {
  let d = "Benday" === a.gridType ? l/2 * (i % 2) : 0;       // row stagger
  for (let h = -p; h < p; h++) {
    let p = h*l + d + f - s,                                  // pre-rot dx
        S = i*o + m - u,                                      // pre-rot dy
        w = s + p*cos(n) - S*sin(n),                          // canvas x
        C = u + p*sin(n) + S*cos(n),                          // canvas y
        v = a.maxDotSize / r + a.displacementFactor;          // cull margin
    if (w < -v || w > W+v || C < -v || C > H+v) continue;

    let x = w, M = C;
    if (a.displacementFactor > 0) {
      let t = noise(w*y, C*y),
          n = noise(w*y + 100, C*y + 100),
          r = (t - .5) * displacementFactor * 2,
          l = (n - .5) * displacementFactor * 2;
      x = w + r; M = C + l;
    }

    let lum = sampleAlphaLum(clamp(floor(x), 0, W-1),
                             clamp(floor(M), 0, H-1));
    let k = (lum < threshold
              ? map(lum, 0, threshold, maxDotSize, minDotSize)
              : minDotSize) / r;
    if (k === 0) continue;

    push(); translate(x, M); rotate(n);
    fill(0); noStroke();
    rect(-k/2, -k/2, k, k, cornerRadius);
    pop();
  }
}
```

Notes that matter for parity:

- `stepSize` is **pixels per cell** (range 3-20 in UI), not a cell count.
  That's the key knob; `xSquares/ySquares` from Stippling have no equivalent.
- Cull margin `v` includes `+ displacementFactor` because jitter can push a
  cell outwards by up to `displacementFactor` pixels.
- Noise frequency `y` shrinks as `displacementFactor` grows (a higher
  amplitude needs a lower frequency for the field to read as "natural") —
  bundle quirk preserved.
- Luminance gate: `lum < threshold` → bigger dot, else clamp to `minDotSize`.
  The reference ships `fill(0)` for every dot (black). We expose `dotColor`
  + paper `bgColor` so the field reads on any backing.

## Bundle defaults (`pageStates["/effects/dots"]`)

```js
{
  showEffect:         true,
  lightnessThreshold: 128,
  minDotSize:         1,
  maxDotSize:         10,
  stepSize:           8,
  displacementFactor: 2,
  cornerRadius:       4,
  gridType:           "Regular",   // "Regular" | "Benday"
  angle:              0,
}
```

Inherits the shared preprocessor defaults (`canvasSize` 600, `blurAmount` 0,
`grainAmount` 0, `gamma` 1, `blackPoint` 0, `whitePoint` 255).

## Parameter reference

| Param                 | Range      | What it does                                                                          | Why it matters                                                                          | When you'd touch it                                              |
|-----------------------|------------|----------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| `canvasSize`          | 100-1000   | Long-edge of preprocessed source buffer                                                | Sets density vs perf trade-off                                                          | Crank to 1000 for hi-res PNG                                     |
| `blurAmount`          | 0-10       | Pre-blur (`CanvasFilter("blur(Npx)")`)                                                 | Smooths noise; gentler dot transitions                                                  | Photographs with skin/fabric                                     |
| `grainAmount`         | 0-1        | Per-pixel random noise added pre-luminance                                             | Breaks up dead regions; adds texture                                                    | Flat backgrounds                                                 |
| `gamma`               | 0.1-2      | `out = 255 * (in/255) ^ gamma`                                                         | Push midtones up (>1) or down (<1)                                                      | Recovering dark detail                                           |
| `blackPoint/whitePoint` | 0-255    | Levels remap                                                                           | Stretch contrast before threshold                                                       | Washed-out sources                                               |
| `showEffect`          | bool       | Bypass dot pass; show preprocessor output                                              | Tune preprocessor in isolation                                                          | Always-on debug toggle                                           |
| `lightnessThreshold`  | 0-255      | Luminance gate; below ⇒ scale dot size up                                              | Inverts to control "where dots appear"                                                  | Most-used knob                                                   |
| `minDotSize`          | 0-50       | Floor size; lit regions cap at this                                                    | Coverage in highlights                                                                  | Set 0 to leave whites empty                                      |
| `maxDotSize`          | 0-50       | Ceiling at lum=0                                                                       | Boldness of darks                                                                       | Crank for chunky look                                            |
| `stepSize`            | 3-20       | Pixels between cell centres                                                            | Grid density. Smaller = more dots                                                       | First-pass scale knob                                            |
| `cornerRadius`        | 0-20       | Rounded-rect corner radius                                                             | 0 ⇒ sharp squares; 20 ⇒ circles                                                         | Almost always max for "dots" feel                                |
| `displacementFactor`  | 0-20       | Perlin jitter amplitude (pixels)                                                       | Breaks the grid; reads as organic                                                       | Off for tight halftone; up for hand-stippled                     |
| `gridType`            | enum       | `Regular` (axis-aligned) / `Benday` (half-cell stagger)                                | Benday = vintage comic-book offset                                                      | Stylistic choice                                                 |
| `angle`               | -45..45°   | Grid rotation                                                                          | Print-screen rotation kills moiré with subject                                          | 15° = "designed"                                                 |

## pixart additions / departures

| Param           | pixart default | Bundle default | Reason                                                                                          |
|-----------------|----------------|----------------|--------------------------------------------------------------------------------------------------|
| `lightnessThreshold` | 200       | 128            | Bundle's 128 leaves big white voids on dark subjects; 200 ⇒ full coverage landing frame.        |
| `maxDotSize`         | 14        | 10             | Bolder ink-blot read.                                                                            |
| `cornerRadius`       | 12        | 4              | Reads as round dots out of the box (closer to the effect's nominal name).                       |
| `angle`              | 15        | 0              | Rotated grid reads as deliberate.                                                                |
| `displacementFactor` | 2 (bundle) | 2             | Bundle parity — subtle organic jitter.                                                           |
| `dotColor` / `bgColor` | exposed | hardcoded `fill(0)` | pixart adds a paper-cream backing (`#f5f1ea`) so dots read as ink.                          |
| `angleSweep`         | 360       | n/a            | New, pixart-only animation knob (degrees rotated across the 15s loop).                          |

## Animation (15s seamless loop, byte-equal)

The reference is not animated. pixart adds a `angleSweep` linear ramp:

```js
angle(t) = baseAngle + angleSweep * t01    // t01 = t - floor(t); t=1 → t=0
```

At `angleSweep = 360°` the rotation completes one full revolution per loop.
Because rotation is mathematically modulo 360°, `t=0` and `t=1` produce
identical frames; we explicitly collapse `t=1 → t=0` to dodge IEEE-754
floating ε.

The Perlin displacement field is sampled in *unrotated canvas space* — but
the canvas coordinates `(w, C)` are computed from the rotated grid, so
jitter offsets *do* depend on `angle`. They're nevertheless deterministic
from `(angle, position)` alone, so endpoints match byte-equal.

Grain is re-seeded with `mulberry32(seedFromT(tLoop))` so that channel is
also deterministic.

## Performance

- Default 600² source, `stepSize=8` → 75×75 = 5625 grid centres.
- Rotation widening multiplies cap by ~(diag/W)² ≈ 2× → ~11.3k iterations.
- Viewport cull rejects ~half (off-canvas overshoot).
- Each kept cell: 1 noise call (skipped at `displacementFactor=0`), 1
  Float32 lum lookup, 1 `roundRect` path.
- Measured <30ms/frame at 1280×720 canvas (M-class Mac).

## Pre-flight verification

`python3 -m http.server 8001` → `http://localhost:8001/dots/`. Animate +
PNG/MP4 export buttons wire through `shared/export.js`. The loop is
byte-equal because (a) `angle(0) === angle(1) mod 360`, (b) grain RNG is
seeded from `t`, (c) the value-noise field is built once with a fixed
seed, (d) `Math.cos/sin` of identical angles produce identical floats.

## Refinement pass — 2026-05-13

Six-mode envelope: `idle` · `breath` · `march` · `pulse` · `rotate` · `swirl`.
Two new static params: `dotShape` (round / square / euclidean) and
`screenAngleOffset` (-45..45°). The grid resolution is decoupled into
implicit `xStep` / `yStep` for `swirl` so x and y can animate independently.

### Modes

- **idle** — static. The frame is the artwork.
- **breath** — original `angleSweep` linear rotation with a small (~15%)
  cosine pingpong on `maxDotSize` layered on top. Reads as a deliberate
  rotation that breathes.
- **march** — screen angle steps through `[0°, 15°, 45°, 75°]`, held for
  1/4 of the loop each. These are the canonical CMYK offset-print screen
  angles: yellow at 0° (lightest channel, parked on the visible axis
  where its moire matters least), cyan at 15°, black at 45° (visually
  strongest, on the axis the eye is *least* sensitive to oriented edges
  — diagonal), magenta at 75°. Using them as march plateaus encodes a
  piece of print-tech history that became visible to anyone who's
  examined an offset newspaper print under a loupe.
- **pulse** — sharp asymmetric envelope on `maxDotSize`. 20% of the loop
  is the spike up (ink swell), 80% is the slow decay back to base. The
  decay is `(1−(t−0.2)/0.8)^2.5` so it returns to base at t=1 exactly,
  matching t=0 byte-equal.
- **rotate** — angle monotonic 0 → 360°. The grid rotates once per loop;
  the dot field sweeps through every orientation.
- **swirl** — `xSquares` pingpongs (axis breathes), `ySquares` monotonic
  (axis drifts). Moire interference between the two axes produces a
  rolling beat that reads as a literal optical-illusion field — closer
  to an Op-Art Bridget-Riley plate than a halftone screen. Both axes
  wrap exactly at t=0/t=1 via cos pingpong.

### New static params

- **dotShape** (round / square / euclidean):
  - *round* — current rounded-square (≈ circle at `cornerRadius=20`).
  - *square* — sharp ink-blot, no `roundRect` path. The 1879 Ben-Day
    primitive.
  - *euclidean* — print-canonical halftone spot. Below 50% coverage:
    filled circle of area = coverage·cell. Above 50%: square cell minus
    a circular hole. At exactly 50%: a diamond. This is the shape
    Adobe Photoshop's `Halftone Pattern` filter uses; it's the one that
    actually appears on offset-print plates because of how the dot grows
    on the rubber blanket during transfer.
- **screenAngleOffset** (-45..45°) — additive phase offset on top of
  `angle`. Used to detune one virtual screen against another for moire
  control; composes with the `march` plateaus to slide them off canon.

### References

1. **Roy Lichtenstein technical analysis** (Tate catalog, 2013) — the
   Ben-Day dot pattern is itself an art-historical citation. Confirms
   the visual identity of the round-dot halftone as a *signal* of
   commercial print.
2. **Ben Day (1879 patent, US 214,493)** — the original mechanical
   shading screen. Where the round dot started.
3. **Adobe Photoshop *Halftone Pattern* filter** — the canonical
   euclidean dot rule (circle <50%, diamond at 50%, hole >50%).
   Documented in *Photoshop Filters Reference*; we mirror the rule
   verbatim.
4. **William Fox Talbot (1852)** — *Photographic Engraving*. The
   photogravure ancestor of the screen-angle problem. The screen-angle
   moire he encountered with cross-line plates is exactly what the
   CMYK 0/15/45/75 canon was eventually invented to dodge.

### Verification (browser, 2026-05-13)

| mode    | seam | t=.25 distinct | t=.5 | t=.75 | mean ms/24f |
|---------|------|----------------|------|-------|-------------|
| idle    | ✓    | n/a            | n/a  | n/a   | 6.4         |
| breath  | ✓    | ✓              | ✓    | ✓     | 6.3         |
| march   | ✓    | ✓              | ✓    | ✓     | 5.0         |
| pulse   | ✓    | ✓              | ✓    | ✓     | 5.0         |
| rotate  | ✓    | ✓              | ✓    | ✓     | 5.1         |
| swirl   | ✓    | ✓              | ✓    | ✓     | 7.6         |

All under the 30 ms budget. Screenshots at `docs/screenshots/dots-<mode>.png`.
