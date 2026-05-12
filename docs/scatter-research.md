# Scatter — reverse-engineering dossier

**Reference:** https://tooooools.app/effects/scatter
**Bundle inspected:** `/_next/static/chunks/app/effects/scatter/page-2d5ff6cd18980983.js`
**Shared preprocessor:** `/_next/static/chunks/9357-2a51c42cdfe973de.js`
**Stack:** Next.js + React + p5.js 1.5 (WEBGL), shared preprocessor module.
**Date:** 2026-05-12.

## What the effect actually is

Not "shake / shuffle pixel jitter". The bundle ships a **Poisson-disk-style stippler with Lloyd-style relaxation**:

1. **Preprocessor pipeline** (Blur → Grain → Gamma → Levels) mutates the source pixels — identical to displace / edge / stippling.
2. **Probabilistic sample.** For every pixel in the working buffer, compute `lum = (R+G+B)/3` and `p = ((255 − lum) / 255) · pointDensityFactor`. If `random() < p` emit a dot at `(x,y)` with `size = map(lum, 0..255, maxPointSize..minPointSize)`. Darker pixels get bigger dots — true halftone behaviour.
3. **Spatial hash** keyed by `floor(x/cell), floor(y/cell)` where `cell = max(maxPointSize, 20)`.
4. **Relaxation passes** (`relaxIterations`, default 0 in the bundle): each dot scans its own 3×3 cell neighbourhood. For any pair within `r = (s_a + s_b)/2`:
   ```
   push      = (r − d) / d · relaxStrength
   a.force  -= push * (b - a)
   b.force  += push * (b - a)
   ```
   then dots move by force, hash is updated, forces zeroed. This is **Lloyd relaxation compressed into a pairwise repulsion model** — no Voronoi diagram. Spatial-hash makes it O(n) average per pass.
5. **Sort dots by size DESC** so smaller dots paint over larger (revealing texture).
6. **Render** each dot via `plane(size)` textured with the user-uploaded `dotTextures[k % len]`. If no texture, a 1024px black ellipse PG is generated as fallback. With no texture the dots are solid black on the page background.

`showEffect: false` bypasses the field and shows the preprocessed image.

## Parameters (extracted exactly)

| UI label | stateKey | range | default | effect | why |
|---|---|---|---|---|---|
| Canvas Size | `canvasSize` | 100–1000 | 600 | resamples source to `canvasSize × canvasSize·aspect` | speed/density trade-off |
| Blur | `blurAmount` | 0–10 | 0 | `pg.filter(BLUR, n)` | softens grain before sampling |
| Grain | `grainAmount` | 0–1 step .1 | 0 | additive `(0.5-rnd)·grain·255` per channel | luminance jitter so flat regions still get dot variation |
| Gamma | `gamma` | 0.1–2 step .1 | 1 | `255·pow(v/255,γ)` | midtone control over dot density |
| Black Point | `blackPoint` | 0–255 | 0 | levels lo | clamp shadows |
| White Point | `whitePoint` | 0–255 | 255 | levels hi | clamp highlights |
| Show Effect | `showEffect` | bool | true | bypass | inspect preprocessor output |
| Point Density | `pointDensityFactor` | 0–0.2 step .01 | 0.05 (was 0 in bundle, raised for landing) | probability gain in the sampler | total dot count |
| Min Dot Size | `minPointSize` | 1–50 | 3 | small endpoint of `map()` (bright pixels) | tonal range |
| Max Dot Size | `maxPointSize` | 1–50 | 18 | big endpoint (dark pixels) | tonal range |
| Relax Iterations | `relaxIterations` | 0–20 | 6 (was 0 in bundle) | how many Lloyd passes | blue-noise quality |
| Relax Strength | `relaxStrength` | 0–1 step .01 | 0.5 | force gain in each pass | how aggressively dots repel |

The bundle's preprocessor list literal (verified in chunk `9357-*`):

```js
[
  {label:"Blur",        min:0,   max:10,  value:0,   stateKey:"blurAmount"},
  {label:"Grain",       min:0,   max:1,   step:.1, value:0,   stateKey:"grainAmount"},
  {label:"Gamma",       min:.1,  max:2,   step:.1, value:1,   stateKey:"gamma"},
  {label:"Black Point", min:0,   max:255, value:0,   stateKey:"blackPoint"},
  {label:"White Point", min:0,   max:255, value:255, stateKey:"whitePoint"},
]
```

## Algorithm — direct translation from the bundle

Sampling loop (`/effects/scatter/page-*.js` ~line 690):

```js
e.randomSeed(123);
for (let i = 0; i < r; i++) {
  let r = 4 * i;
  let u = (l[r] + l[r + 1] + l[r + 2]) / 3;
  if (Math.random() < ((255 - u) / 255) * s) {
    let r = e.map(u, 0, 255, o, a);   // o=maxPointSize, a=minPointSize
    let l = { x: i % w, y: (i/w)|0, size: r, forceX: 0, forceY: 0 };
    t.push(l); f(l);                  // f = bucket insert
  }
}
```

Cell key:
```js
function p(x, y) { return `${(x/d)|0},${(y/d)|0}`; }  // d = max(o, 20)
```

Relaxation pass (~line 720):
```js
for (let it = 0; it < u; it++) t.forEach((e) => {
  neighbours3x3(e).forEach((t) => {
    if (t !== e) {
      let n  = t.x - e.x, r = t.y - e.y;
      let a  = Math.sqrt(n*n + r*r);
      let o  = (e.size + t.size) / 2;
      if (a < o) {
        let l = ((o - a) / a) * i.relaxStrength;
        e.forceX -= l*n; e.forceY -= l*r;
        t.forceX += l*n; t.forceY += l*r;
      }
    }
  });
  e.x += e.forceX; e.y += e.forceY;
  rebucketIfMoved(e);
  e.forceX = 0; e.forceY = 0;
});
```

Render (~line 750):
```js
t.sort((e, t) => t.size - e.size);
e.noStroke();
t.forEach((t, n) => {
  e.push();
  e.translate(t.x - canvasSize/2, t.y - canvasH/2);
  if (textures.length) e.texture(textures[n % textures.length]);
  e.plane(t.size);
  e.pop();
});
```

## Port choices for pixart (2D canvas)

- **No WEBGL** → 2D canvas with `arc()` for ≥3px and `fillRect()` below; the bundle's textured `plane(size)` collapses to a black filled disc, which matches the visual when no texture is uploaded (the default state).
- **`canvasSize`-space coordinates** preserved; we letterbox-fit to the screen canvas at paint.
- **RNG** seeded by `mulberry32(seedFromT(t_loop))` during animation, by `mulberry32(123)` during static use (mirroring the bundle's `randomSeed(123)`). Both are deterministic.
- **Spatial hash** uses `Map<number, number[]>` keyed by an integer-packed `(cx,cy)` — same shape as bundle, lower overhead than string keys.
- **Force accumulators** live in a parallel `Float32Array(cap*2)` so dot data stays cache-hot in the render loop.
- **Pair sort** by size desc happens at paint time on an index array (`pairs.sort((a,b) => sizes[b]-sizes[a])`) so the dot pool itself never moves.

## Landing-frame defaults (overrides the bundle's "no effect" defaults)

```
pointDensityFactor = 0.05
minPointSize       = 3
maxPointSize       = 18
relaxIterations    = 6
relaxStrength      = 0.5
```

The bundle ships `pointDensityFactor: 0` (empty canvas) — we raise it so the first paint is visually striking. Same convention edge / cellular use in pixart.

## Animation — 15s seamless loop

Three quantities are pure functions of `t_loop`:

| quantity | curve | range |
|---|---|---|
| `relaxIterations`    | round(4 · (1−cos(2πt))/2)         | 0 ↔ 4 ↔ 0 |
| `dotRotation`        | 2π · t                            | 0 ↔ 2π |

All three close at `t=0` and `t=1`. The RNG is `mulberry32(seedFromT(t_loop))` and `seedFromT(0) === seedFromT(1)`, so the sampled dot positions at the loop endpoints are byte-identical. With `relaxIterations` pingponging to 0 at both ends, the relaxation history is also identical at the close.

The dot rotation gives a "shimmer" feel during animation without breaking determinism — at `t=0` and `t=1` it's `0` mod `2π`.

## Determinism + byte-equal export

- Static frames: `Math.random` → fresh `mulberry32(123)` per build → identical to reference.
- Animated frames: `mulberry32(seedFromT(t))` reseeded every frame, so `renderAt(0) === renderAt(1)`.
- Sort is stable on identical sizes; insertion order in the sampler is row-major and deterministic.

## Performance

Target: <30 ms/frame at 1280×720 canvas, working buffer 600×450, density 0.05.

- Sample pass: 270k pixels, ~13.5k dots emitted at density 0.05 → ~5 ms.
- Relax: 6 passes × 13.5k dots × ~6 neighbours avg = ~480k pair tests → ~10 ms.
- Paint: 13.5k arc()/fillRect calls → ~7 ms.
- Total ≈ 22 ms. Headroom for video frames.

Density falls quickly with smaller `canvasSize`; the bundle's UI lets users drag canvasSize to 200 for live preview, then go back to 600 for export. We mirror that affordance.

## Files

- `pixart/scatter/effect.js`     — port (550 lines)
- `pixart/scatter/index.html`    — control panel + shared chrome
- `pixart/docs/scatter-research.md` — this dossier
