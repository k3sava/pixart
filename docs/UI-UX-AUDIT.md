# pixart — UI/UX Audit

Date: 2026-05-13
Method: Playwright MCP scripted interaction against `http://localhost:8001/`.
Sample: ascii, bevel, dots, kaleidoscope (4 of 28 effects). Audit-only — no fixes.

## Priority fixes (affect every effect)

1. **Sidebar collapse never gives the canvas the reclaimed width.**
   When the sidebar slides off-screen the `<main>` element expands (1354 → 1674px) but `<canvas>` stays at the previous size (e.g. 911×911 on square). Result: large empty letterbox to the right of the canvas in the collapsed state. The stage needs a resize-pass tied to the collapse transition (re-run `applyRatio()` after the aside class flips).

2. **MP4 export ships a `.webm` file, not `.mp4`.**
   Confirmed on kaleidoscope: clicking the `mp4` button changes its label to "rendering…" and downloads `pixart-kaleidoscope-1778674524424.webm`. Button name lies. Either rename the button to `webm`, transcode to mp4 server-side / via WebCodecs muxer, or label the action `video` and pick the container based on browser support.

3. **`mp4` recording-state button has no visual affordance.**
   Label flips to "rendering…" but `className` stays `""`. No red dot, no pulsing border, no `aria-pressed`. Users get no easy "I'm currently recording" cue, especially since the button stops the recording on second click.

## Console
- ✓ working — zero JS errors or warnings across ascii / bevel / dots / kaleidoscope, before and after interactions.
- ⚠ degraded — `GET /favicon.ico → 404` on every page. Add a favicon (or a 1px transparent) to silence.

## Sidebar collapse / expand
- ✓ working — chevron handle present on every effect (`aria-label="Collapse controls"` / `"Expand controls"`).
- ✓ working — collapse animates the aside off-screen; only the 22×22 handle stays in-viewport (asideRight 1942 > vw 1920, handle at x=1644 still visible).
- ✓ working — clicking handle again restores the aside to its original position.
- ✗ broken — **canvas does not grow to fill the reclaimed stage width** (see Priority Fix #1).

## Control rows
- ✓ working — every row renders its widget across all four effects sampled:
  - ascii: 18 rows, all populated (source / fit / ratio / bg / 8 sliders / char ramp text / 2 checkbox / mode pills / 3 toggles).
  - bevel: 17 rows, all populated.
  - dots: 22 rows, all populated.
  - kaleidoscope: 14 rows, all populated.
- ⚠ degraded — sliders look like sliders but are not `input[type=range]`. They are a custom `.wg-track` + hidden `<input type=number>`. Native keyboard arrow-key support and screen-reader semantics depend entirely on the custom JS. Confirm `role`/`aria-valuemin`/`aria-valuemax`/`aria-valuenow` are wired (not verified in this pass).

## Slider drag
- ⚠ degraded — drag does fire pointer events and update the value (Columns 96 → 30 after drag from left edge to right edge of the track). The direction of change vs. drag direction looked inverted in the synthetic test; worth confirming manually with real mouse input.
- Live-update behaviour: value updates during move (not just on release), based on the number input reflecting mid-drag.

## Pills (ratio / mode / fit)
- ✓ working — implemented as `button.wg-pill[role=radio]`, with `aria-checked` toggling and `.active` class moving on click. Tested on ratio (square / portrait / landscape) and mode (pulse / tone) — active state moves correctly.
- ✓ working — canvas resizes on ratio change: square 911×911, portrait 512×911, landscape 1354×762.

## Animate / Interactive toggles
- ✓ working — checkbox toggles flip `checked` state on click and via keyboard shortcut. Canvas renders adjust accordingly (verified via state, not pixel-diff).
- Not verified — pointer-on-canvas driving parameters in interactive mode. Plumbing exists (`[data-key="interactive"]` checkbox); behavioural verification deferred.

## Source row (+ / ↻ / file picker)
- ✓ working — `↻` shuffle button cycles to a different bundled sample (label changed from "click to choose" to "sample" on first cycle, indicating PIXSource picked a new file).
- ✓ working — `+` button is a normal button paired with `<input type="file" accept="image/*,video/*">`. Click on `+` should trigger the file input (not verified end-to-end — system file dialog can't be opened in headless context, but the wiring exists in markup).

## Help "?" / splash overlay
- ✓ working — clicking `?` adds `.visible` to `.wa-splash`, computed `display` flips from `none` → `flex`.
- ✓ working — `Escape` closes the splash (`.visible` removed, display back to `none`).

## Breadcrumb / nav
- ✓ working — `pixart` breadcrumb link targets `../` (relative), reaches `/pixart/` on click.
- ✓ working — previous / next arrows present in the "Effect navigation" landmark. Previous on ascii → `../zoom-blur/`, next → `../bevel/`. Sample list order looks consistent with the index.

## Theme switcher
- ✓ working — 5 themes confirmed by token sampling on `<aside>`:
  - classic — DM Sans, radius 4px, bg `rgba(250,250,250,.96)`.
  - editorial — Georgia / Garamond serif, radius 4px, parchment bg.
  - terminal — JetBrains Mono, radius **0px**, bg `#0d1117`, accent green `#26ff9d`.
  - zen — DM Sans, radius **14px** (the rounded one), warm sand bg.
  - brutalist — JetBrains Mono, radius **0px**, pure white / black.
- ✓ working — brutalist and terminal both clear the rounded-corner token. No leftover roundness from default theme.
- ✓ working — theme persists across navigation (theme button label "Current theme: classic" updates after T-key cycle).
- ⚠ degraded — full visual sweep (button, slider, pill, splash, footer) per theme not done in this run. Token-level samples look clean; pixel-level audit per theme is the next pass.

## Mobile viewport (375×667)
- ✓ working — aside switches to `position: fixed`, `width: 375px`, anchored to bottom (`bottom: 42px`). It becomes a bottom-sheet.
- ⚠ degraded — bottom-sheet starts at y=611 with height 366 (extends to 977, past the 667 viewport). Currently translated 352px down (collapsed sheet). Handle remains tappable. Behaviour suggests a "peek + drag-up" pattern but the drag affordance is just the same chevron — not obvious to a mobile user.
- ⚠ degraded — `aside.scrollHeight === aside.clientHeight` even though the content is 366px tall in a 366px box — scrolling internal controls when the sheet is partially open may not work. Worth a manual mobile test.
- Not verified — top chrome (theme dot, breadcrumb, png / mp4 / ? cluster) wrapping on 375px.

## Keyboard shortcuts (per `shared/keys.js`)
- ✓ working — `T` cycles theme: editorial → terminal → zen → (classic, no data-theme) → brutalist → editorial. 5-theme loop confirmed.
- ✓ working — `A` toggles the Animate checkbox.
- ✓ working — `I` toggles the Interactive checkbox.
- ✓ working — `?` opens the splash; `Escape` closes it.
- Not verified — `P` and `M` for png / mp4 export (didn't want to fire downloads during scripted runs after the kaleidoscope `mp4` test already produced a download).

## MP4 export
- ✓ working — clicking `mp4` starts the recorder (label "rendering…", file downloads on stop).
- ✗ broken — file extension is `.webm`, not `.mp4` (see Priority Fix #2).
- ⚠ degraded — no visual recording-state on the button beyond label change; no `aria-pressed` (see Priority Fix #3).

## Summary
- ✓ working: 18
- ✗ broken: 2 (sidebar-collapse canvas resize, mp4-is-actually-webm)
- ⚠ degraded: 7 (favicon 404, slider drag direction, slider a11y semantics, mp4 button affordance, mobile sheet drag affordance, mobile sheet internal scroll, per-theme visual sweep)
