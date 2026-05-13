#!/usr/bin/env python3
"""Strip plumbing controls from every effect's index.html. Plumbing = an
internal buffer dimension or RNG seed that doesn't help a toy user.

Confirmed strips:
  - canvasSize  (render-buffer resolution)
  - seed        (deterministic RNG seed)
  - paperSeed   (ink-wash paper grain seed)

Kept (despite name):
  - rotationSeed on stack  (real shuffle-the-layout affordance; future
                            rename to "Shuffle" lives in sync-labels.py)
  - seedSource on voronoi  (user-facing placement strategy select)

Idempotent.
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
STRIP_KEYS = {"canvasSize", "seed", "paperSeed"}

ROOT = Path(__file__).resolve().parent.parent


def strip_row(html: str, key: str):
    """Remove the wg-row block with the given data-key. Returns (new_html, removed?)."""
    pat = re.compile(r'(\s*)<div\s+class="wg-row[^"]*"\s+data-key="' + re.escape(key) + r'"[^>]*>', re.DOTALL)
    m = pat.search(html)
    if not m:
        return html, False
    start = m.start()
    depth = 1
    i = m.end()
    while depth > 0 and i < len(html):
        nxt_open = html.find('<div', i)
        nxt_close = html.find('</div>', i)
        if nxt_close == -1:
            return html, False
        if nxt_open != -1 and nxt_open < nxt_close:
            depth += 1
            i = nxt_open + 4
        else:
            depth -= 1
            i = nxt_close + 6
    return html[:start] + html[i:], True


def sync_one(slug: str) -> str:
    p = ROOT / slug / "index.html"
    if not p.exists():
        return f"MISSING: {p}"
    html = p.read_text()
    removed = []
    for key in STRIP_KEYS:
        html, did = strip_row(html, key)
        if did:
            removed.append(key)
    if not removed:
        return f"skip (already clean): {slug}"
    p.write_text(html)
    return f"ok: {slug} (stripped {', '.join(removed)})"


if __name__ == "__main__":
    for slug in EFFECTS:
        print(sync_one(slug))
