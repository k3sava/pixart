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

    # 4) video → mp4 (legacy; the icon swap below replaces both png/mp4 text).
    html = re.sub(
        r'(<button id="export-mp4"[^>]*>)video(</button>)',
        r'\1mp4\2',
        html,
    )

    # 5) text labels (png / mp4) → inline SVG icons. Both inherit colour
    #    via currentColor so themes cascade. Icons read as image-download
    #    and film-strip-with-play.
    PNG_ICON = (
        '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" '
        'fill="none" stroke="currentColor" stroke-width="1.4" '
        'stroke-linecap="round" stroke-linejoin="round">'
        '<rect x="2.5" y="3" width="11" height="8" rx="1"/>'
        '<path d="M2.5 9.5 l3-2.5 2.5 2 2-1.5 3.5 2.5"/>'
        '<circle cx="6" cy="6" r="1" fill="currentColor" stroke="none"/>'
        '<path d="M8 12 v3 m0 0 l-1.5 -1.5 m1.5 1.5 l1.5 -1.5"/>'
        '</svg>'
    )
    MP4_ICON = (
        '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" '
        'fill="none" stroke="currentColor" stroke-width="1.4" '
        'stroke-linecap="round" stroke-linejoin="round">'
        '<rect x="2" y="4" width="9.5" height="8" rx="1"/>'
        '<path d="M11.5 6.5 l3 -1.5 v6 l-3 -1.5 z" fill="currentColor"/>'
        '</svg>'
    )
    html = re.sub(
        r'(<button id="export-png"[^>]*>)png(</button>)',
        lambda m: m.group(1) + PNG_ICON + m.group(2),
        html,
    )
    html = re.sub(
        r'(<button id="export-mp4"[^>]*>)mp4(</button>)',
        lambda m: m.group(1) + MP4_ICON + m.group(2),
        html,
    )

    if html == orig:
        return f"skip (already clean): {slug}"
    p.write_text(html)
    return f"ok: {slug}"


if __name__ == "__main__":
    for slug in EFFECTS:
        print(sync_one(slug))
