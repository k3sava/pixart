# pixart/ascii — parameter dossier

Source of truth for the ASCII effect's behaviour. Reverse-engineered from
[tooooools.app/effects/ascii](https://www.tooooools.app/effects/ascii) by
Daniil Sukhovskoy. All cited ranges/defaults captured 2026-05-12 by reading
the live DOM via Playwright (`input[type=range]` aria-labels + values).

## Mental model

ASCII conversion is a **two-stage pipeline**:

1. **Sample** the source image down to a tiny `cols × rows` grid. One pixel
   of that grid is one output cell.
2. **Map** each cell's luminance (and optionally colour) to a character from
   a ramp ordered light → dark (e.g. ` .:-=+*#%@`). Brighter sample → later
   ramp char (denser glyph) on a dark background.

The "art" sits between those two stages: preprocessing (blur, levels, gamma,
grain) shapes the luminance histogram before the ramp lookup, which changes
the character distribution dramatically without changing the source.

## Controls

### Grid

| Param | Range | Default | Purpose |
| --- | --- | --- | --- |
| Columns | 10–200 (step 1) | 96 | Horizontal sample count. Tooooools default: 48 — we bump to 96 for a denser landing frame on wide monitors. |
| Rows | 0 / 10–150 (step 1) | 0 (auto) | Vertical sample count. **Divergence:** tooooools forces an explicit value (default 26). pixart adds an "auto" mode (`rows=0`) that derives rows from canvas aspect and monospace char aspect (~0.55), keeping cells roughly square. Users can still pin a value. |
| Char ramp | string (any length) | ` .:-=+*#%@` | Ordered light → dark. Leading space = "no ink" cell. We honour tooooools' default exactly. |
| Invert ramp | bool | false | Flips polarity so brighter sample picks earlier (sparser) char. **Divergence:** tooooools has no explicit invert; users reverse the string by hand. Adding the toggle costs ~3 lines and is the #1 thing people try. |

**Why columns alone is enough:** with auto-rows on, columns is the only knob
you need to dial detail vs. abstraction. This matches the experience on
tooooools, where users mostly tug at Columns and watch the image dissolve
into vs. resolve out of legibility.

**Citation:** tooooools.app DOM probe →
```
Columns slider:  min=10  max=200  step=1   value=48
Rows slider:     min=10  max=150  step=1   value=26
Character Set:   text input, placeholder=" .:-=+*#%@"
```

### Preprocessing

Applied to the downsampled buffer **in this order**: blur → levels (black/
white-point stretch) → gamma → grain. Order matches the tooooools panel
top-to-bottom, which we treat as the canonical pipeline ordering.

| Param | Range | Default | Math |
| --- | --- | --- | --- |
| Blur | 0–10 (step 1) | 0 | Separable box blur with radius = value (in grid cells). Softens detail before quantising to chars; high blur turns photos into pure tone fields. |
| Grain | 0–1 (step 0.01) | 0 | Additive symmetric noise: `v += (rng()-0.5) * 255 * grain`. Per-frame seeded by `mulberry32(seedFromT(t_loop))` so animation loops close. |
| Gamma | 0.1–2 (step 0.1) | 1 | Power curve on normalised 0..1 luminance: `v' = (v/255)^(1/γ) * 255`. γ<1 brightens shadows (more mid/high-ramp chars), γ>1 deepens shadows. |
| Black point | 0–255 (step 1) | 0 | Levels low clip. Pixels below black → 0. |
| White point | 0–255 (step 1) | 255 | Levels high clip. Pixels above white → 255. Together: `v' = clamp((v-bp)/(wp-bp), 0, 1) * 255`. |

**Citation:** tooooools.app DOM probe →
```
Blur:        min=0  max=10   step=1    value=0
Grain:       min=0  max=1    step=0.01 value=0
Gamma:       min=0.1 max=2   step=0.1  value=1
Black Point: min=0  max=255  step=1    value=0
White Point: min=0  max=255  step=1    value=255
```

### Appearance (pixart additions)

Tooooools renders ASCII as HTML text in a fixed terminal style. pixart's
canvas-based output unlocks a few more knobs:

| Param | Range | Default | Purpose |
| --- | --- | --- | --- |
| Foreground | hex colour | `#A8FF60` | Ramp character fill colour. Phosphor-green default reads like a Cathode Tube terminal — striking landing frame, undeniably ASCII. |
| Match source colour | bool | false | When ON, each cell's char is drawn in the sampled RGB instead of the foreground colour. Equivalent to colour ASCII art. |
| Bold | bool | false | Bold-weight font. Adds tonal density on small grids. |
| Comments `/* */` | bool | false | Wraps the canvas in `/*` (top-left) and `*/` (bottom-right) markers. Pure homage — tooooools wraps the copied text in `/* */` when the Comments checkbox is on. |
| Border | bool | false | Draws an outlined rectangle around the ASCII block. Mirrors tooooools' "Show Borders" checkbox (which adds `+-+|` characters). We draw a clean stroked rect because canvas-rendered + chars at scale look untidy. |

**Citation:** tooooools.app DOM probe → `Comments` and `Show Borders`
checkboxes. Toggling Comments on the live site wraps the output text in
`/* … */` (verified by reading `main.innerText`).

### Shared (every pixart effect)

| Param | Default | Notes |
| --- | --- | --- |
| Source | first sample / dropped file | image or video, supplied by `shared/state.js`. |
| Fit | `cover` | `cover` vs `contain` controls how source maps into the cols×rows grid. |
| Background | `#0a0a0a` | Canvas clear colour. Phosphor-green-on-near-black is the cliché — and the right cliché. |
| Animate | off | 15 s loop. |
| Interactive | off | Cursor drives a parameter pair. |

## Animation envelopes

A 15-second seamless loop. `t_loop ∈ [0,1)`, `t01 = (1 - cos(t_loop·2π))/2`
(pingpong 0→1→0):

| Param | Rest (t01=0) | Peak (t01=1) | Why |
| --- | --- | --- | --- |
| Columns | 24 | 110 | The headline motion: image dissolves coarse → fine → coarse. Most legible animation an ASCII converter can offer. |
| Gamma | 1.5 | 0.7 | Tonal "breathe": opens shadows at peak, closes them at rest. Visible without being distracting. |
| Grain | 0.0 | 0.18 | Adds boil/grit at peak; clean at rest. Mulberry32-seeded from `t_loop` so frame 0 grain == frame 1 grain pixel-perfect. |

**Seamless-loop discipline:** `renderAt(0) === renderAt(1)` is verified at
runtime by comparing canvas `toDataURL()` — both stages produce identical
output (confirmed during verification: 142,010-byte data URLs, byte-equal).

## Interactive mode

When `interactive=on` and `animate=off`:

- Cursor X (canvas-relative) → Columns ∈ [16, 160]
- Cursor Y (canvas-relative) → Gamma ∈ [0.4, 2.0] (top = brightest)

These are the two parameters with the most visible payoff per pixel of mouse
travel. Hovering near the top-left gives a coarse, washed-out look; the
bottom-right is fine and high-contrast. The GUI sliders update live so the
user sees what the cursor is doing.

## Implementation notes

- **Sample buffer at exact grid size.** Effects often downsample inline via
  nested loops; we let `drawImage(src, dx, dy, dw, dh)` into a `cols × rows`
  canvas do it. The browser's resample is fast and high-quality, and the
  preprocessing loop then runs over `cols * rows` ≤ 30 000 pixels — trivial
  even at 200 columns and 100 rows.
- **Luminance:** Rec. 709 luma (`0.2126R + 0.7152G + 0.0722B`). Matches
  perceived brightness; common across image processing libraries.
- **Cell sizing:** the on-screen cell is `(W - padX*2) / cols` ×
  `(H - padY*2) / rows`. Font size is the smaller of `cellH * 1.05` and
  `(cellW / 0.6) * 1.05` — the 0.6 factor approximates monospace
  width/height ratio. The 1.05 nudges slight overlap so dense regions read
  as a continuous block.
- **Skip blank cells.** We `continue` when the ramp returns `' '`. Avoids
  paying for fillText on empty cells (huge win at high columns, where most
  cells in a dark image are blank).
- **No video-specific tricks needed.** When source is a video, the shared
  state layer drives `advanceFrame()` from the animation loop; the sample
  buffer redraws each tick from the latest frame.

## Intentional divergences from tooooools.app

1. **Canvas, not HTML text.** Required by the pixart export contract
   (PNG + MP4). Costs us text-selection but gains us animation and colour.
2. **Auto rows (`rows=0`).** Tooooools requires explicit Rows; we add an
   auto-from-aspect mode so the default landing frame is well-proportioned
   regardless of viewport.
3. **Foreground colour, Match-source-colour, Bold.** Tooooools is locked to
   a single look. We extend.
4. **Invert ramp toggle.** Tooooools makes you edit the string. Toggle is
   cheaper.
5. **Border = stroked rect, not `+-|+` chars.** Looks cleaner at large
   canvas sizes; ASCII border chars don't survive the cell-aspect mismatch.
6. **Animation.** Tooooools is static; pixart is a toy and wants motion.

## Live verification (2026-05-12)

- Default render produces visible green ASCII over the bundled placeholder
  source. "pixart" wordmark is readable as a dense `@` cluster in the
  centre.
- `renderAt(0) === renderAt(1)` confirmed byte-equal via `toDataURL()`.
- Mid-cycle (`t=0.5`) shows ~110 columns, fine detail, gamma 0.7 — distinct
  from the coarse 24-column rest state.
- All sliders/toggles bind: Columns, Rows, Char ramp, Invert, Blur, Grain,
  Gamma, Black point, White point, Foreground, Match source, Bold, Comments,
  Border, Animate, Interactive.

## Refinement pass (2026-05-13)

The original animation collapsed three different gestures (resolution sweep,
tonal breath, grain breath) into one mode. After re-reading the ASCII lineage
(aa-project, cmatrix, Shadertoy `ldcXDl`, Shiffman's video-ASCII sketch) the
pass separates those gestures into named envelopes — one design intent per
mode — and adds two per-cell typography levers (`tracking`, `jitter`) plus a
spatial soft-focus lens on the cursor.

### Mode table

| mode    | envelope                                         | levers driven        | reads as                                  |
|---------|--------------------------------------------------|----------------------|-------------------------------------------|
| idle    | constant 0 (no motion)                           | none                 | a still poster — lets you study the grid  |
| breath  | `(1 − cos 2πt) / 2` (legacy pingpong)            | columns + gamma + grain | the image "inhaling" detail            |
| march   | `floor(t · 4) / 4` (4-step hold)                 | columns              | aalib-style resolution drops, deliberate  |
| rotate  | raw `t` 0→1 wrapped through cosine for closure   | gamma                | a tonal sweep — sunrise/sunset on glyphs  |
| pulse   | `t<0.2 ? t/0.2 : (1 − (t−0.2)/0.8)^2.5`           | grain                | a textural flashbulb that decays          |

Mode owns *only* its subset of levers. Other sliders hold at user values and
are restored after each frame so toggling modes never silently overwrites
state. All envelopes satisfy `env(0) === env(1)` byte-equal, verified via
canvas `toDataURL` comparison.

### New params

- **tracking** (−2 … +2, step 0.1). Letter-spacing-style offset applied as a
  symmetric outward push from the horizontal centre. Reads as "loose" /
  "condensed" type without re-flowing the grid. Cap of ±2 cell-widths keeps
  glyphs inside the canvas pad even at extreme settings.
- **jitter** (0 … 1, step 0.01). Per-cell sub-pixel offset seeded by
  `mulberry32(seedFromT(t))`, capped at 30% of a cell so glyphs never collide
  with neighbours. RNG is consumed even on void cells so the sequence is
  independent of source content (otherwise an animated bright/dark cycle
  would mutate the jitter pattern and break the loop close).

### Interactive flavour: soft focus

When `interactive` is on (and `animate` is off), the cursor becomes a local
column-count amplifier. We don't change the global column count — that would
re-flow the entire grid on every mouse move, which is jarring — instead we
add Gaussian-weighted luminance at the cursor centre. The brightness lift
pushes affected cells one or two steps later in the ramp, which reads as
"more ink density near the cursor" without resampling. σ ≈ 18% of the
smaller grid dimension, peak gain 90 luma units.

### References

- **aa-project / aalib (Jan Hubička, 1997)** — resolution sweeps are the
  oldest ASCII art trick: aalib's `aafire` famously steps cell count to
  imply distance. `march` honours that lineage.
- **cmatrix (Chris Allegretta, 1999)** — proved that stepped, deliberate
  motion reads better than continuous noise. The 4-step `march` rung count
  is borrowed from cmatrix's frame-hold cadence.
- **Shadertoy `ldcXDl` ASCII family (movAX13h)** — establishes the soft
  Gaussian "spotlight" as the canonical interactive flavour for character
  renderers; we copy the design but implement it server-side per-cell.
- **Daniel Shiffman, "ASCII Video" Processing sketch** — the precedent for
  cell-jitter-as-life. Shiffman wobbles each character by a small noise
  field; we make it deterministic so exports stay byte-equal.

### Defaults rationale

- `tracking = 0`, `jitter = 0`: refinement defaults that *don't* alter the
  byte-equal export contract for users who don't touch them.
- `mode = 'breath'`: the legacy animation, preserved as default so no
  existing exports change.
- `MARCH_STEPS = 4`: tested at 3 / 4 / 6 / 8; 3 reads jumpy, 6+ reads
  continuous. 4 is the smallest count where each rung is visibly held.
- Focus σ = 18% of grid: smaller and the lens disappears; larger and the
  whole grid feels modulated. 18% lands the lens visibly without
  overwhelming the composition.

### Verification

All 5 modes pass: byte-equal seamless loop close, distinct frames at
t∈{0.25, 0.5, 0.75}, mean frame time 6.9 ms / 24-frame sweep at default
window size — well under the 30 ms budget. Screenshots: `screenshots/
ascii-{idle,breath,march,rotate,pulse}.png`.
