#!/usr/bin/env python3
"""Sync the effect-nav block across every effect/index.html.

With 28 effects the flat strip is too crowded, so the canonical nav is now a
compact pill that opens an overlay menu. The overlay is built client-side from
window.PIXART_EFFECTS, so each effect page only needs to declare the *current*
slug — the rest is rendered by shared/keys.js.

This script normalises the <nav class="effect-nav"> block on every effect page
to the compact form, with the current slug visible.
"""
import re
import sys
from pathlib import Path

# 28 effects, alphabetised. Source of truth — mirrored in shared/keys.js.
EFFECTS = [
    "ascii", "bevel", "cellular", "contour", "crt",
    "displace", "distort", "dithering", "dots", "edge",
    "film-grain", "flow-field", "gradients", "halftone-cmyk",
    "ink-wash", "kaleidoscope", "patterns", "pixel-sort",
    "recolor", "rgb-shift", "scatter", "slide", "slit-scan",
    "stack", "stippling", "voronoi", "watercolor", "zoom-blur",
]

# Category groupings — also mirrored in shared/keys.js and index.html.
CATEGORIES = {
    "Type":       ["ascii"],
    "Tonal":      ["bevel", "edge", "gradients", "recolor", "contour"],
    "Halftone":   ["dots", "dithering", "stippling", "halftone-cmyk"],
    "Geometric":  ["displace", "distort", "kaleidoscope", "voronoi"],
    "Cinematic":  ["crt", "film-grain", "zoom-blur", "rgb-shift"],
    "Painterly":  ["ink-wash", "watercolor"],
    "Glitch":     ["pixel-sort", "slit-scan", "scatter"],
    "Generative": ["flow-field", "cellular", "patterns"],
    "Motion":     ["slide", "stack"],
}

ROOT = Path(__file__).resolve().parent.parent


def render_nav(active_slug: str) -> str:
    """Compact nav: current slug + chevron that opens the overlay (wired in keys.js)."""
    prev_idx = (EFFECTS.index(active_slug) - 1) % len(EFFECTS)
    next_idx = (EFFECTS.index(active_slug) + 1) % len(EFFECTS)
    prev_slug = EFFECTS[prev_idx]
    next_slug = EFFECTS[next_idx]
    return (
        # The left-side breadcrumb already grounds the page in "pixart" — repeating
        # the word here was noise. The home link survives as a small grid glyph
        # ("⊞") with a tooltip so the back-to-grid affordance is still discoverable.
        '<nav class="effect-nav compact" aria-label="Effect navigation">\n'
        f'    <a class="effect-nav-arrow" href="../{prev_slug}/" title="Previous effect ({prev_slug})" aria-label="Previous">‹</a>\n'
        '    <a href="../" class="effect-nav-home" title="All effects" aria-label="All effects">⊞</a>\n'
        f'    <button type="button" class="effect-nav-current" id="effect-nav-open" aria-haspopup="dialog" aria-expanded="false" title="Browse all 28 effects">\n'
        f'      <span class="effect-nav-name">{active_slug}</span>\n'
        '      <span class="effect-nav-chev">›</span>\n'
        '    </button>\n'
        f'    <a class="effect-nav-arrow" href="../{next_slug}/" title="Next effect ({next_slug})" aria-label="Next">›</a>\n'
        '  </nav>'
    )


NAV_RE = re.compile(r'<nav\s+class="effect-nav[^"]*"[^>]*>.*?</nav>', re.DOTALL)


def sync_one(slug: str) -> str:
    p = ROOT / slug / "index.html"
    if not p.exists():
        return f"MISSING: {p}"
    html = p.read_text()
    if not NAV_RE.search(html):
        return f"NO NAV BLOCK: {p}"
    new_html = NAV_RE.sub(render_nav(slug), html, count=1)
    p.write_text(new_html)
    return f"ok: {slug}"


if __name__ == "__main__":
    for slug in EFFECTS:
        print(sync_one(slug))
