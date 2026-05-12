# pixart homepage — design + perf notes

Built 2026-05-13. Replaces the 1-line `index.html` redirect with a 28-card grid,
category filter chips, live search, and a compact-nav re-architecture.

## Perf strategy: static pre-rendered thumbnails

The brief offered three live-preview strategies plus a static-thumbnail escape
hatch. I took the escape hatch — and not as a compromise, as the right call.

Why:

1. **Honesty.** Each thumbnail is a real frame of the real effect (rendered
   inside the effect page on a sample image, screenshotted), not a CSS-filter
   pastiche pretending to be the effect.
2. **Cost.** 28 simultaneously running canvases — even time-sliced — burn
   battery, hurt main-thread responsiveness, and require every effect's full
   ~600-line module loaded at homepage paint. With `<img>` thumbs, the
   homepage ships ~30 KB of JS + 28 lazy-loaded webp files (~20 KB each).
3. **Determinism.** Static thumbnails look identical on every device. Live
   previews drift in subtle ways across hardware.

The downside: thumbnails don't *move*. Compensating moves:

- Each card has a slow `transition: transform 8s ease` zoom on hover (+1.5%
  scale, *not* the Stripe +5%).
- Subtle brightness/saturation lift on hover.
- Staggered fade-in on first paint (≤480 ms total).
- Theme switcher still applies — bg/border/text recolour across all 28 cards.

If we ever want motion in the cards, the path is to extend
`scripts/build-thumbnails.mjs` to emit animated `.webp` (cwebp -q 78 with N
input frames) per slug, then keep the `<img>` markup. The grid itself
doesn't change.

### Thumbnail pipeline

`scripts/build-thumbnails.mjs`:

- For each of the 28 effects, picks the best available source from
  `docs/screenshots/` in this preference order:
  `<slug>.png` → `<slug>-breath.png` → `<slug>-bloom.png` → `<slug>-pulse.png`
  → first match.
- Pipes through `cwebp -q 78 -resize 560 0` (preserves aspect, scales width
  to 560 px — retina target for ~280×180 card slot).
- Writes `pixart/assets/thumbs/<slug>.webp`.

Re-run with `node scripts/build-thumbnails.mjs` after re-shooting any effect.

## Search + filter

- `/` (anywhere outside an input) focuses the search field.
- Live filter on `keyup` — no debounce because we only mutate visibility on
  28 nodes; cost is negligible.
- Chips are category filters: All, Type, Tonal, Halftone, Geometric,
  Cinematic, Painterly, Glitch, Generative, Motion. Each shows its count.
- Search + chip compose. "8 of 28" count updates live.
- Empty state appears when no card matches; includes a "clear search" reset.
- Arrow keys move focus between visible cards once one is focused.

## Compact nav (re-architecture)

The previous flat 16-entry strip didn't scale to 28. New shape:

```
[ ‹ ]  pixart / current-effect  [ › ]    [ › ]
```

- Two arrow buttons cycle prev/next alphabetically (also wired to ← / →
  globally via `shared/keys.js`).
- A `pixart` link returns to the homepage.
- The "current ›" pill opens a full nav overlay (modal) grouped by category.
- ⌘K / Ctrl+K opens the overlay from anywhere, including text inputs.
- `/` opens the overlay (was: showed splash; splash is now `?` only).
- Inside the overlay: live search filters across slugs; ↑↓ moves focus;
  Enter opens; Esc closes.

CSS lives in `shared/chrome.css` under `.effect-nav.compact` and
`.pix-nav-overlay`. Mobile: overlay docks to bottom as a sheet.

## Style discipline (audit)

- No purple/violet gradients. Cards use theme tokens (`--bg`, `--text`,
  `--bar-border`) — they recolour cleanly across all five themes (default,
  brutalist, editorial, terminal, zen).
- No "Discover" / "Explore" copy. The lede reads:
  > 28 client-side image effects. drop a picture, pick a treatment, play.
- No emoji.
- Hover ≠ scale(1.05). Border lights up, name underlines, image gently zooms
  to 1.015 over 8 s.
- Effect names use DM Sans (display); badges use JetBrains Mono.

## What I'd improve next

1. **Animated thumbnails.** Extend `build-thumbnails.mjs` to record 24
   frames from the effect's animation loop (via Playwright + headless
   Chromium hitting `?animate=1&duration=2`), encode each into a 24-frame
   animated webp. Total page weight goes from ~30 KB JS + 28×20 KB images
   = ~590 KB → roughly ~1.8 MB. Acceptable for desktop; gate on
   `prefers-reduced-motion: no-preference`.
2. **Hover micro-interactions.** Wire one real frame of the effect to render
   on hover via a single shared `<canvas>` that mounts the hovered effect's
   `WAEffect.renderAt(t)`. One canvas, one effect at a time = bounded cost.
3. **Deep-link filters.** `pixart/#cat=glitch` should pre-apply the chip.
   30 LOC; deferred.
4. **Recent / favourite effects.** A pinned row above the category grid for
   the last 3 effects the user opened (read from `localStorage`).
5. **Sample picker on the homepage.** Drop an image on the grid, every card
   re-renders against it. Path here is canvas-on-hover (see #2) plus a
   shared source bus.

## References

- everywhere.tools — wall-of-cards convention, dense grid, name + category
  badge per card.
- toooools.app — direct lineage. pixart effects are ports.
- Apple developer site — restrained hover (no scale-bounce).
- Stripe Press grids — what *not* to do: the scale(1.05) lift is everywhere
  and feels generic now.
- ableton.com Live device browser — category chip pattern (single-select
  with counts) feels right at this size.

## Files touched

- `pixart/index.html` — new homepage (replaces redirect).
- `pixart/scripts/sync-nav.py` — `EFFECTS` extended to 28; nav block now
  compact form.
- `pixart/scripts/build-thumbnails.mjs` — new; produces 28 webps.
- `pixart/assets/thumbs/<slug>.webp` — 28 thumbnails (gitignore? — see
  follow-up).
- `pixart/shared/chrome.css` — added `.effect-nav.compact` + nav overlay.
- `pixart/shared/keys.js` — 28-effect awareness, ⌘K, `/` opens overlay,
  splash text updated.
- All 28 `pixart/<slug>/index.html` — nav block rewritten by sync-nav.py.
- `pixart/docs/screenshots/homepage*.png` — verification captures.
