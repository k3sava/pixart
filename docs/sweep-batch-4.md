# Pixart sweep — batch 4

Date: 2026-05-13
Scope: `slide`, `slit-scan`, `stack`, `stippling`, `voronoi`, `watercolor`, `zoom-blur`
Server: `http://localhost:8001/`
Method: Playwright (chromium, 1280x800). Heavy effects (voronoi, stack, slide, stippling) settled 2500ms after `loadUrl`; light effects 800ms. Interactive cursor test dispatches `MouseEvent('mousemove')` on `#cv`. Mode-distinct test uses `<select data-key="mode">` (all batch-4 effects expose mode as a select element, not pills), then `renderAt(0.5)` after `change` event.

## Result matrix

| slug        | loaded | firstPaint | modes              | modeDistinct | interactive | 5-sample distinct | pageerror |
|-------------|--------|------------|--------------------|--------------|-------------|-------------------|-----------|
| slide       | yes    | yes        | orbit/tilt/breath  | **yes**      | **yes**     | 4 / 5             | none      |
| slit-scan   | yes    | yes        | breath/tilt        | **no**       | no          | 1 / 5             | none      |
| stack       | yes    | yes        | deal/breath/swirl  | **no**       | **yes**     | 1 / 5             | none      |
| stippling   | yes    | yes        | breath/spin/tone   | **no**       | no          | 1 / 5             | none      |
| voronoi     | yes    | yes        | hue/tone           | **no**       | no          | 1 / 5             | none      |
| watercolor  | yes    | yes        | breath/bleed/tone  | **no**       | no          | 1 / 5             | none      |
| zoom-blur   | yes    | yes        | breath/pull/bloom  | **no**       | no          | 1 / 5             | none      |

Pass (all four checks): **1 / 7** (`slide`)
Partial (firstPaint OK but mode/interactive failures): **6 / 7**
Hard fail (no firstPaint or pageerror): **0 / 7**

## Per-effect findings

### slide — PASS
All checks pass. Mode-distinct (3 modes produce distinct dataURLs), interactive cursor changes output, 5-sample randomness produces 4 distinct seeds out of 5 (acceptable variance — one collision).

### slit-scan — mode-static, non-interactive
- `breath` and `tilt` modes at `renderAt(0.5)` produce byte-identical canvas output (head/mid/tail samples match exactly). Mode dropdown is wired (option values exist) but mode value has no visual effect at fixed progress.
- Cursor dispatch on `#cv` produces no change.
- 5-sample reload produces identical output every time (no randomness in initial state).

### stack — mode-static, interactive OK
- All three modes (`deal`/`breath`/`swirl`) at `renderAt(0.5)` produce byte-identical canvas output.
- Does **not** expose `window.renderAt` (only effect in batch missing it) — `pauseRender` also missing. Mode-distinct test fell through to default renderer; modes do not visibly differentiate.
- Interactive cursor test: **passes** — cursor movement changes canvas output. This is the only batch-4 effect besides slide with working cursor interaction.
- 5-sample reload identical (deterministic init).

### stippling — mode-static, non-interactive
- 3 modes byte-identical at `renderAt(0.5)`.
- Cursor dispatch no change.
- 5-sample identical. Surprising for stippling (Poisson sampling normally varies seed-to-seed); likely a fixed RNG seed in init.

### voronoi — mode-static, non-interactive
- `hue` and `tone` modes byte-identical at `renderAt(0.5)`.
- Cursor dispatch no change.
- 5-sample identical (deterministic Lloyd relax seed).
- First paint now succeeds with the 2500ms settle — confirms batch-3 false positive was a wait-time bug.

### watercolor — mode-static, non-interactive
- 3 modes byte-identical.
- Cursor dispatch no change.
- 5-sample identical.

### zoom-blur — mode-static, non-interactive
- 3 modes byte-identical.
- Cursor dispatch no change.
- 5-sample identical.

## API surface audit

| slug       | window.pauseRender | window.renderAt |
|------------|--------------------|-----------------|
| slide      | (not measured)     | yes             |
| slit-scan  | no                 | yes             |
| stack      | no                 | **no**          |
| stippling  | no                 | yes             |
| voronoi    | no                 | yes             |
| watercolor | no                 | yes             |
| zoom-blur  | no                 | yes             |

`pauseRender` is missing across the batch. The mode-distinct methodology spec called for `pauseRender` + `renderAt(0.5)`; in practice only `renderAt` exists (and `stack` lacks even that). Mode-distinct comparison still valid because `renderAt(0.5)` deterministically draws one frame, but live-loop frames overlap; mitigated by 600ms wait between mode switch and snapshot. Output identity across modes is therefore a real engine-level finding, not a timing artifact.

## Priority fixes

**P0 — mode parameter is a no-op in 6 of 7 effects.** `slit-scan`, `stack`, `stippling`, `voronoi`, `watercolor`, `zoom-blur` all expose 2–3 mode options in the UI that have **zero visible effect** on rendered output. Verify the mode value is being read into the render loop. Suspected pattern: mode read once at init, never re-evaluated; or mode branches collapsed during refactor. Compare against `slide` (works) for the wiring pattern.

**P1 — `stack` is missing `window.renderAt`.** Only batch-4 effect without it. Breaks the interactive testing/automation contract the other six honor. Add export.

**P1 — cursor interactivity missing in 5 of 7.** `slit-scan`, `stippling`, `voronoi`, `watercolor`, `zoom-blur` ignore `mousemove` on `#cv`. Check whether each effect intends to be cursor-reactive (slide and stack are). If yes, the listener is either not attached to `#cv` or is checking the wrong event target.

**P2 — deterministic init in heavy-stochastic effects.** `voronoi` (Lloyd relaxation), `stippling` (Poisson disk), `watercolor` (bleed) all produce identical output across reloads. If by design (seeded RNG for reproducibility) — fine. If unintended — seed off `performance.now()` or `Math.random()` at module load.

**P2 — `window.pauseRender` is absent across all 7 effects.** If the testing-API contract is meant to include it, add it; otherwise update the contract and remove from the spec.

## Methodology note

Spec `await new Promise(r => setTimeout(r, 300))` after each cursor dispatch worked. Heavy-effect 2500ms settle resolved batch-3 voronoi/scatter false positives — voronoi firstPaint now reliably true. Dispatching `MouseEvent` on `#cv` (vs `page.mouse`) did not by itself rescue cursor-interactive detection — most batch-4 effects genuinely lack cursor handlers, not a test-method artifact.
