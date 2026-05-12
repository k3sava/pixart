# Cellular Automata — reverse-engineering dossier

**Reference:** https://tooooools.app/effects/cellular-automata
**Bundle inspected:** `/_next/static/chunks/app/effects/cellular-automata/page-b74913d968c06cb2.js`
**Shared chunk (defaults + preprocessor list):** `/_next/static/chunks/9357-2a51c42cdfe973de.js`
**Stack:** Next.js + React + p5.js sketch via ReactP5Wrapper, shared preprocessor module.
**Date:** 2026-05-12.

## What the effect actually is

A two-stage pipeline:

1. **Seed** — preprocessed source is rasterised into a coarse grid of `cellSize×cellSize` blocks. A cell is **alive (1)** iff **any** pixel inside the block has unweighted luminance `(R+G+B)/3 ≤ threshold`. The bundle's seeder short-circuits on the first hit. The source's dark regions become live cells; brights become dead.
2. **Step** — the grid is advanced through `steps` generations of a chosen ruleset (`Classic`, `LTL`, `MNCAB`, `MNCC`) with toroidal wrap. Each step is a pure synchronous double-buffer update.
3. **Paint** — fill background white, then draw each alive cell as a `cw+1 × ch+1` black rectangle (the `+1` hides cell-grid seams from sub-pixel rounding).

This is image-seeded cellular automata, not a randomly-seeded Game of Life. The image *is* the initial condition. Running 0 generations shows a hard luminance threshold (a 1-bit poster). Running many generations dissolves it into rule-shaped texture.

## Algorithm — exact translation from minified source

```js
// seedGrid (from page chunk, function expression assigned to inner n).
let R = Math.ceil(e.width / t.cellSize),
    L = Math.ceil(e.height / t.cellSize);
n = Array(L); e.loadPixels();
for (let cy = 0; cy < L; cy++) {
  n[cy] = Array(R);
  for (let cx = 0; cx < R; cx++) {
    // hitInBlock(x0,y0,cs,th)
    n[cy][cx] = hitInBlock(e, cx*cs, cy*cs, cs, t.threshold) ? 1 : 0;
  }
}
function hitInBlock(e, x0, y0, cs, th) {
  for (let y = y0; y < y0+cs && y < e.height; y++)
    for (let x = x0; x < x0+cs && x < e.width; x++) {
      let i = (y*e.width + x) * 4;
      if ((e.pixels[i] + e.pixels[i+1] + e.pixels[i+2]) / 3 <= th) return true;
    }
  return false;
}
```

```js
// Classic step
function moore(e, t) {
  let r = 0;
  for (let l = -1; l <= 1; l++) for (let o = -1; o <= 1; o++) {
    if (l === 0 && o === 0) continue;
    let a = (e + l + n.length) % n.length, i = (t + o + n[0].length) % n[0].length;
    r += n[a][i];
  }
  return r;
}
// classicRule
n[e][t] === 1
  ? (moore >= r.surviveLowerBound && moore <= r.surviveUpperBound ? 1 : 0)
  : (moore >= r.birthLowerBound   && moore <= r.birthUpperBound   ? 1 : 0)
```

```js
// LTL step — identical structure, radius 5 (11×11 neighbourhood).
for (let l = -5; l <= 5; l++) for (let o = -5; o <= 5; o++) { ... }
// LTL count range 0..120 (121 cells − centre).
```

```js
// helper h() — ring mean at radius r (centre excluded; divisor is count
// excluding centre, because o++ lives inside the skip branch).
function h(e, t, r) {
  let sum = 0, cnt = 0;
  for (let a = -r; a <= r; a++) for (let i = -r; i <= r; i++) {
    if (a === 0 && i === 0) continue;
    sum += n[(e+a+H)%H][(t+i+W)%W]; cnt++;
  }
  return sum / cnt;
}

// MNCAB — alive iff radius-1 ring mean OR radius-2 ring mean ∈ [t1..t2].
let m1 = h(e,t,1), m2 = h(e,t,2);
return (m1>=t1 && m1<=t2) || (m2>=t1 && m2<=t2) ? 1 : 0;

// MNCC — chained parity flips over rings 1..4.
let s = n[e][t], M = [h(e,t,1),h(e,t,2),h(e,t,3),h(e,t,4)];
for (let k=1; k<=4; k++)
  if (M[k-1] >= rkLower && M[k-1] <= rkUpper) s = 1 - s;
return s;
```

```js
// Paint
e.background(255); e.noStroke(); e.fill(0);
let cw = e.width / n[0].length, ch = e.height / n.length;
for (let y=0; y<n.length; y++) for (let x=0; x<n[y].length; x++)
  if (n[y][x] === 1) e.rect(Math.floor(x*cw), Math.floor(y*ch), cw+1, ch+1);
```

## Parameters (all from bundle defaults)

| Name (UI) | stateKey | Range | Default | Where it acts | Why |
|---|---|---|---|---|---|
| Canvas Size | `canvasSize` | 100–1000 | 600 | preprocessor sample | Trades resolution for grid count and speed. |
| Blur / Grain / Gamma / Black / White | preprocessor | (shared) | 0 / 0 / 1 / 0 / 255 | shared preprocessor | Conditions the source before seeding. |
| Show Effect | `showEffect` | bool | true | bypass | Inspect what the preprocessor did. |
| Threshold | `threshold` | 0–255 | 128 | seed | Luminance cutoff for alive cells. Dark-leaning. |
| Cell Size | `cellSize` | 1–10 | 2 | seed | Source pixels per cell. Smaller = denser grid, slower step. |
| Steps | `steps` | 1–50 | 1 | step | Number of CA generations per frame. |
| Type | `neighborhoodType` | enum | "Classic" | step | Selects ruleset. |
| Survive Lower / Upper | `surviveLowerBound` / `Upper` | 0–8 | 1 / 8 | classic step | Live-cell survival count range. Bundle's S1..8 keeps loners alive. |
| Birth Lower / Upper | `birthLowerBound` / `Upper` | 0–8 | 3 / 3 | classic step | Dead-cell birth count range. B3..3 is Conway-strict birth. |
| LTL Survive Lower / Upper | `ltlSurviveLower` / `Upper` | 0–200 | 47 / 102 | LTL step | Range over 120-cell Moore. |
| LTL Birth Lower / Upper | `ltlBirthLower` / `Upper` | 0–200 | 15 / 91 | LTL step | (same) |
| MNCA Threshold 1 / 2 | `mncaThreshold1` / `2` | 0–1 | 0.35 / 0.70 | MNCAB step | Ring-mean band. |
| Nk Lower / Upper (k=1..4) | `mnccThresholdkLower` / `Upper` | 0–1 | (see below) | MNCC step | Per-ring parity-flip bands. |

Bundle `pageStates["/effects/cellular-automata"]`:

```js
{ showEffect: true, threshold: 128, cellSize: 2, steps: 1,
  neighborhoodType: "Classic",
  surviveLowerBound: 1, surviveUpperBound: 8,
  birthLowerBound: 3, birthUpperBound: 3,
  ltlSurviveLower: 47, ltlSurviveUpper: 102,
  ltlBirthLower: 15, ltlBirthUpper: 91,
  mncaThreshold1: 0.35, mncaThreshold2: 0.70,
  mnccThreshold1Lower: 0.262, mnccThreshold1Upper: 0.903,
  mnccThreshold2Lower: 0.342, mnccThreshold2Upper: 0.378,
  mnccThreshold3Lower: 0.342, mnccThreshold3Upper: 0.382,
  mnccThreshold4Lower: 0.889, mnccThreshold4Upper: 0.978 }
```

(There are three additional keys in the bundle's state object — `edgePreservationThreshold`, `erosionProbability`, `growthProbability`, `extendedNeighborThreshold` — but the page's control list and the rule functions do not read them. They are dead state, likely from a prior ruleset that was cut. We do not surface them.)

## Loop closure (the hardest part of this port)

A CA isn't naturally time-invariant. We picked the option that gives **byte-equal renderAt(0)===renderAt(1)** without distorting the effect:

- **Reseed each frame from the source**, **animate `steps`** on a cosine pingpong:
  `steps(t) = round(baseSteps + stepsSweep · (1 − cos(2π t))/2)`
- At t=0 and t=1 the pingpong is 0, so `steps = baseSteps` at both endpoints. The seed is deterministic (no RNG in seedGrid). The Classic/LTL steps are deterministic. The grain RNG, when on, is mulberry32(seedFromT(t)) — same canonical scheme used by edge.

This produces a "breathing" simulation: at t=0 the image is barely processed (recognisable), mid-cycle it dissolves into rule-shaped pattern, then resolves back. Visually compelling and provably seamless.

Rejected alternatives:
- **Animate threshold** — works but is the same animation as edge's threshold sweep, so flavour collision.
- **True multi-frame simulation** — non-time-invariant, and `steps=1500` over 15s would be unbounded chaos with no return; killing the loop.

## Divergences in this port (and why)

| Reference | This port | Reason |
|---|---|---|
| p5 `loadPixels` + `pixels[]` | Cached `Float32Array lumGrid` of `(R+G+B)/3` | Avoids `getImageData` per cell scan. |
| `Array<Array<0\|1>>` grid | `Uint8Array` flat grid + back-buffer | ~10× less GC pressure; allows `src/dst` swap instead of `n.map(e => [...e])` per step. |
| `n.map(e => [...e])` copy per step | Double-buffered ping-pong (`grid` ↔ `gridB`) | Same semantics, zero allocation. |
| No animation | Steps pingpong on 15s cosine | pixart loop contract. |
| White bg / black cell | Configurable `aliveColor` / `deadColor` (defaults match) | We expose what the reference hardcodes, no behavioural change at defaults. |
| Bundle uses unweighted `(R+G+B)/3` | Same | We deliberately mirror this even though edge/displace use alpha-composited luminance — fidelity to the reference. |
| Bundle defaults `cellSize=2, steps=1` | Defaults `cellSize=3, steps=2` | At 1280×720 canvas the bundle's defaults read as "1-bit poster + minor jitter", not as a CA. Bumping by one each makes the first paint unambiguously CA-shaped. Sliders go to the bundle range. |

## Performance notes

At `canvasSize=600, cellSize=3` → grid ≈ 200×150 = 30k cells.

- Seed: 600×600 = 360k luminance compares (with short-circuit, average ~10× fewer). <1 ms.
- Classic step: 30k × 8 reads = 240k ops. ~1 ms.
- LTL step: 30k × 120 = 3.6M ops. ~10 ms. Acceptable.
- MNCC step: 30k × (8+24+48+80) = 4.8M ops. ~15 ms. Still under the 30 ms 24fps budget for export.
- Paint: 30k `fillRect` worst case. ~3 ms.

Total Classic frame ≈ 5 ms. Total LTL frame ≈ 14 ms. Comfortably under 30 ms target at all rulesets.

A summed-area-table optimisation for LTL/MNCC ring sums would push them to ~2 ms but is not warranted given current headroom. Documented as the escape hatch.

## What we explicitly did NOT add

- **edgePreservationThreshold / erosionProbability / growthProbability / extendedNeighborThreshold** — present in `pageStates` but not referenced by either the control list or any rule function in the page chunk. Dead state from a prior ruleset.
- **Coloured cells sampled from source** — the reference paints monochrome black/white. We expose the two colour swatches but do not pull per-cell colour from the source; that would diverge from the algorithm.
- **A "reset randomly" seed mode** — the reference always seeds from the image, so this would be a different effect.
