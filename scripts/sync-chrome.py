#!/usr/bin/env python3
"""One-shot chrome cleanup across every effect's index.html:
  1. Make the breadcrumb 'pixart' a link back to the homepage.
  2. Remove the redundant ⊞ home glyph from the compact nav.
  3. Change the 'keys' button text to '?'.
  4. Change the 'video' button text to 'mp4'.

Idempotent — applying twice produces no further change.
"""
import re
from pathlib import Path

EFFECTS = [
    "ascii", "bevel", "cellular", "contour", "crt",
    "displace", "distort", "dithering", "dots", "edge",
    "film-grain", "flow-field", "gradients", "halftone-cmyk",
    "ink-wash", "kaleidoscope", "patterns", "pixel-sort",
    "recolor", "rgb-shift", "scatter", "slide", "slit-scan",
    "stack", "stippling", "voronoi", "watercolor", "zoom-blur",
]

ROOT = Path(__file__).resolve().parent.parent


def sync_one(slug: str) -> str:
    p = ROOT / slug / "index.html"
    if not p.exists():
        return f"MISSING: {p}"
    html = p.read_text()
    orig = html

    # 1) breadcrumb pixart → link
    html = html.replace(
        '<span class="current">pixart</span>',
        '<a href="../" class="current">pixart</a>',
    )

    # 2) drop the ⊞ home glyph row from the compact nav (any whitespace before/after)
    html = re.sub(
        r'\s*<a [^>]*class="effect-nav-home"[^>]*>⊞</a>',
        '',
        html,
    )

    # 3) keys button text
    html = re.sub(
        r'(<button id="help-btn"[^>]*>)keys(</button>)',
        r'\1?\2',
        html,
    )

    # 4) video → mp4
    html = re.sub(
        r'(<button id="export-mp4"[^>]*>)video(</button>)',
        r'\1mp4\2',
        html,
    )

    if html == orig:
        return f"skip (already clean): {slug}"
    p.write_text(html)
    return f"ok: {slug}"


if __name__ == "__main__":
    for slug in EFFECTS:
        print(sync_one(slug))
