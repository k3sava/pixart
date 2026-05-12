# Halftone CMYK — reference dossier

The full four-plate offset-print halftone. `pixart/dots` is the single-
channel approximation; this one runs the actual process — RGB → CMYK
decomposition with Grey Component Replacement, per-plate rotated screen
at the canonical angles, subtractive composite onto paper white.

## Algorithmic distinction vs `pixart/dots`

| Aspect             | dots (single-channel)              | halftone-cmyk (four-channel)              |
|--------------------|-------------------------------------|--------------------------------------------|
| Source decomp      | Luminance                           | CMYK with GCR                              |
| Screens            | One rotated grid                    | Four — C@15°, M@75°, Y@0°, K@45°           |
| Composite          | Ink-on-paper rect                   | Multiply blend, plates stacked Y→M→C→K     |
| Misregistration    | n/a                                 | First-class param; animation-driven       |
| Visual register    | Newspaper halftone                  | Newspaper colour photograph               |
| Per-plate strength | n/a                                 | `c/m/y/kStrength` for stylistic regrade   |

## RGB → CMYK with GCR

```
C' = 1 - R           M' = 1 - G           Y' = 1 - B
K  = min(C', M', Y')                                 // grey component
denom = 1 - gcr·K                                     // tone preservation
C  = (C' - gcr·K) / denom
M  = (M' - gcr·K) / denom
Y  = (Y' - gcr·K) / denom
K_out = gcr·K
```

GCR slides between "no replacement" (CMY-only, muddy darks) and "full
replacement" (every grey replaced with black ink). The `denom` rescales
residual CMY so total tonal value is preserved as K rises — without it,
high-GCR images look thin.

## Canonical screen angles

```
Cyan       15°
Magenta    75°
Yellow      0°       (parked on the visible axis — lowest contrast)
Black      45°       (on the diagonal — eye least sensitive to oriented edges)
```

These four numbers are the entire reason any 1970s newspaper photograph
looks the way it does. Adobe PostScript Level 1 (1990), section 7.4 of
the *Language Reference*, bakes them into the `setscreen` primitive.
Any other spacing collapses the rosette into visible moire.

## Reference algorithm

For each of the four channels, walk the rotated cell grid (same scaffold
as `pixart/dots`):

```js
const r = |cos(ang)| + |sin(ang)|;            // rotation widening
const maxSide = cellSize / r;                  // cell ink-area cap
const halfW = W/2, halfH = H/2;
const lines = ceil(diag / cellSize) + 4;

for(i = -lines; i < lines; i++)
  for(j = -lines; j < lines; j++) {
    gx = j·cellSize + remX - halfW;
    gy = i·cellSize + remY - halfH;
    wx = halfW + gx·cos(ang) - gy·sin(ang);
    wy = halfH + gx·sin(ang) + gy·cos(ang);
    if(off-canvas) continue;
    cov = plateCov[ch][wx,wy] * strength;
    drawDot(plateCtx[ch], maxSide, shape, cov);
  }
```

Per-plate canvas is then composited at paint time with `globalComposite
Operation = 'multiply'` and an optional registration offset.

## Parameter reference

| Param            | Range      | What it does                                            |
|------------------|------------|----------------------------------------------------------|
| `mode`           | enum       | Animation envelope                                       |
| `cellSize`       | 4..40 px   | Halftone cell side                                       |
| `cAngle..kAngle` | 0..90°     | Per-plate screen angle                                   |
| `cStrength..kStrength` | 0..2 | Per-plate coverage multiplier                           |
| `registerOffset` | -8..8 px   | Plate misregistration distance (each in its own dir)     |
| `gcr`            | 0..1       | Grey component replacement                               |
| `paperWhite`     | hex        | Paper tone                                               |
| `dotShape`       | enum       | round / square / euclidean (same vocab as `dots/`)       |
| `focusRadius`    | 40..600 px | Cursor sharpening (currently gentle — see notes)         |

## Mode envelope

| Mode      | Envelope                       | What animates                                          | Seam |
|-----------|--------------------------------|---------------------------------------------------------|------|
| idle      | constant                       | nothing                                                 | trivial |
| breath    | cosine pingpong                | all four `*Strength` × 1.0..1.35                        | cos seam |
| register  | cosine pingpong, centred on 0  | `registerOffset` × -0.8..+1.0 around slider             | cos seam |
| march     | 4-stop, channel-rotating       | only one of {C,M,Y,K} visible per quarter               | t=1 → step 0 |
| pulse     | sharp asymmetric               | `kStrength` × 1..1.8 fast spike + slow decay            | curve→base at t=1 |
| swap      | 4-stop composite-order rotation| `channelOrder` rotates through 4 named permutations     | t=1 → step 0 |

`register` is the signature mode. The plates literally walk in and out
of register — that's the motion that says "cheap newspaper, fresh off
the press" louder than any pulse or rotation could.

`march` is pedagogical — it reveals the decomposition. The print becomes
just cyan dots for 1/4 of the loop, then just magenta, then yellow, then
black. You watch the rosette assemble itself.

`swap` produces subtle hue shifts because canvas's `multiply` compositor
isn't perfectly commutative across rounding. K-first vs Y-first orders
look measurably different — Steadman would approve.

## Perceptual hook

The combination that lands "1970s newspaper photograph" on first paint
is **cellSize≈12 + canonical angles + 1.5px register**. Any one missing:
without canonical angles you get moire stripes; without misregistration
you get a sterile digital print; without the right cell size you get
either pointillism (too small) or a poster (too big). The trio lands the
identity before any param sweep.

## References (1-line takeaways)

1. **Adobe, *PostScript Language Reference* (2nd ed, 1990), §7.4** — the
   canonical 15/75/0/45 screen-angle quartet codified into `setscreen`.
   We use these as the default angle values verbatim.
2. **William Ivins, *Prints and Visual Communication* (Harvard 1953)** —
   the deep history of mechanical reproduction; defines the print-as-
   network-of-dots ontology this effect renders. Why this matters at all.
3. **Hell GmbH, *Helio-Klischograph* technical manuals (Kiel, 1960s)** —
   the engraved-screen press where dot-area = tonal-value math was
   mechanised. The original analog of our `coverage` map.
4. **Mr. Doob (Ricardo Cabello), halftone CMYK experiments
   (mrdoob.com/lab, c. 2009)** — pioneering `<canvas>` implementation of
   the four-plate composite. Confirms the per-plate rotated-grid
   formulation we use; we extend with GCR + named modes.
5. **Ralph Steadman, illustration practice (1960s-present)** — deliberate
   misregistration as art direction. The `register` mode is a direct
   reading of his oeuvre as an animation envelope.

## Performance

- 600² preprocessed buffer + four 600² plate buffers.
- Preprocess: standard grain/gamma/levels pass + CMYK decomposition
  (1 loop over RGBA → 4 Float32 plates) → ~5ms total.
- Plate build: 4× the `pixart/dots` build loop, but each plate culls
  empty cells (early-out on `cov < 0.005`), so total is ~4-6ms.
- Paint: paper fill + 4 `drawImage` with `multiply` blend → ~1ms.
- Measured mean ms/24f across modes: 1.3 (march, three plates blank) to
  5.6 (breath, all plates active) on M-class Mac at 1280×720 output.

## Verification — browser, 2026-05-13

`python3 -m http.server 8001` → `http://localhost:8001/halftone-cmyk/`.

| mode      | seam byte-equal | t=.25/.5/.75 distinct | mean ms/24f |
|-----------|------------------|------------------------|-------------|
| idle      | ✓                | n/a                    | 5.4         |
| breath    | ✓                | ✓                      | 5.6         |
| register  | ✓                | ✓                      | 5.3         |
| march     | ✓                | ✓                      | 1.3         |
| pulse     | ✓                | ✓                      | 5.0         |
| swap      | ✓                | ✓                      | 4.8         |

All comfortably under the 30ms/frame budget. Screenshots at
`docs/screenshots/halftone-cmyk-<mode>.png`.

Determinism: grain RNG is `mulberry32(seedFromT(t))` during preprocess
(restored to `Math.random` after). CMYK decomposition, plate building,
and the multiply compositor are all pure. `Math.cos/sin` of identical
angles yields identical floats. Therefore `renderAt(0) === renderAt(1)`
byte-equal in every mode.

## Notes on focus / interactivity

The current `interactive` mode tracks the cursor and stores it in
`_focusCx/_focusCy/_focusR2`, but the paint pass leaves misregistration
global. Per-pixel locality (a sharp-print patch under the cursor) needs
either a clip+redraw of the four plates at zero offset inside the focus
disc, or a shader. The current build trades that for steady 60fps; the
focus circle still has perceptual weight via the cursor parallax against
the offset plates. A v2 with clip-and-redraw is a 30-line follow-up.
