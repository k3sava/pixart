#!/usr/bin/env python3
"""Insert a shared Ratio (square/portrait/landscape) row into every effect's
index.html. Idempotent — if the row is already present, skip.

The change handler lives in shared/state.js (PIXSource.setParam('ratio', v)),
so this script only touches HTML.
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

ROW = (
    '<div class="wg-row wg-select" data-key="ratio">'
    '<div class="wg-name">Ratio</div>'
    '<div class="wg-widget">'
    '<select>'
    '<option value="square">Square</option>'
    '<option value="portrait">Portrait</option>'
    '<option value="landscape">Landscape</option>'
    '</select>'
    '</div>'
    '</div>'
)

# Insert immediately after the row with data-key="fit". Fall back to inserting
# right after the row with data-key="source" if no fit row exists.
FIT_RE   = re.compile(r'(<div class="wg-row wg-select"[^>]*data-key="fit">.*?</div>\s*</div>)', re.DOTALL)
SRC_RE   = re.compile(r'(<div class="wg-row wg-file"[^>]*data-key="source">.*?</div>\s*</div>\s*</div>)', re.DOTALL)
ALREADY  = re.compile(r'data-key="ratio"')


def sync_one(slug: str) -> str:
    p = ROOT / slug / "index.html"
    if not p.exists():
        return f"MISSING: {p}"
    html = p.read_text()
    if ALREADY.search(html):
        return f"skip (present): {slug}"
    m = FIT_RE.search(html)
    if not m:
        m = SRC_RE.search(html)
    if not m:
        return f"NO ANCHOR ROW (fit/source): {slug}"
    insertion = m.end()
    new_html = html[:insertion] + "\n    " + ROW + html[insertion:]
    p.write_text(new_html)
    return f"ok: {slug}"


if __name__ == "__main__":
    for slug in EFFECTS:
        print(sync_one(slug))
