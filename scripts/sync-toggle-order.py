#!/usr/bin/env python3
"""Enforce canonical placement of the animation chrome rows at the TOP of
every effect's control panel — right after Background. User wants mode +
animate + interactive visible without scrolling.

Final layout per panel:
  Source · Fit · Ratio · Background · Mode · Animate · Interactive
  [effect-specific knobs]
  showEffect at the bottom

Idempotent: if already canonical, no change.
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
# Rows moved to the TOP of the panel, in this order, right after `bg`.
TOP_KEYS = ["mode", "animate", "interactive"]
# Kept where it is (typically near the bottom).
BOTTOM_KEY = "showEffect"

ROOT = Path(__file__).resolve().parent.parent


def extract_row(html: str, key: str):
    """Return (block, html_without_block) for the wg-row with the given key.
    Block includes the full <div class="wg-row..."> ... </div> outer element.
    Returns (None, html) if not found.
    """
    # Find the opening <div ... data-key="<key>"...>
    pat = re.compile(r'(\s*)<div\s+class="wg-row[^"]*"\s+data-key="' + re.escape(key) + r'"[^>]*>', re.DOTALL)
    m = pat.search(html)
    if not m:
        return None, html
    start = m.start()
    indent = m.group(1)
    # Walk the string from m.end() balancing <div>/</div>.
    depth = 1
    i = m.end()
    while depth > 0 and i < len(html):
        nxt_open = html.find('<div', i)
        nxt_close = html.find('</div>', i)
        if nxt_close == -1:
            return None, html
        if nxt_open != -1 and nxt_open < nxt_close:
            depth += 1
            i = nxt_open + 4
        else:
            depth -= 1
            i = nxt_close + 6
    end = i
    block = html[start:end]
    return block, html[:start] + html[end:]


def sync_one(slug: str) -> str:
    p = ROOT / slug / "index.html"
    if not p.exists():
        return f"MISSING: {p}"
    html = p.read_text()
    new_html = html
    blocks = {}
    for key in TOP_KEYS + [BOTTOM_KEY]:
        block, new_html = extract_row(new_html, key)
        if block is None:
            return f"{slug}: missing row {key}"
        blocks[key] = block

    # Insert TOP_KEYS immediately after the `bg` row's closing.
    bg_re = re.compile(r'<div\s+class="wg-row[^"]*"\s+data-key="bg"[^>]*>', re.DOTALL)
    m = bg_re.search(new_html)
    if not m:
        return f"{slug}: no bg row to anchor after"
    # Walk forward to find the closing </div> of the bg row (depth-balanced).
    depth = 1
    i = m.end()
    while depth > 0 and i < len(new_html):
        nxt_open = new_html.find('<div', i)
        nxt_close = new_html.find('</div>', i)
        if nxt_close == -1: return f"{slug}: unbalanced bg row"
        if nxt_open != -1 and nxt_open < nxt_close:
            depth += 1; i = nxt_open + 4
        else:
            depth -= 1; i = nxt_close + 6
    after_bg = i  # position just after the bg row closes
    top_block = "\n    " + "\n    ".join(blocks[k].strip() for k in TOP_KEYS)
    new_html = new_html[:after_bg] + top_block + new_html[after_bg:]

    # Re-append showEffect at the end of wg-body (where it traditionally lives).
    body_open = new_html.find('<div class="wg-body">')
    if body_open == -1: return f"{slug}: no wg-body found"
    depth = 1
    i = body_open + len('<div class="wg-body">')
    while depth > 0 and i < len(new_html):
        nxt_open = new_html.find('<div', i)
        nxt_close = new_html.find('</div>', i)
        if nxt_close == -1: return f"{slug}: unbalanced wg-body"
        if nxt_open != -1 and nxt_open < nxt_close:
            depth += 1; i = nxt_open + 4
        else:
            depth -= 1
            if depth == 0: break
            i = nxt_close + 6
    body_close = i
    show_block = "\n    " + blocks[BOTTOM_KEY].strip() + "\n  "
    new_html = new_html[:body_close] + show_block + new_html[body_close:]

    if new_html == html:
        return f"skip (already canonical): {slug}"
    p.write_text(new_html)
    return f"ok: {slug}"


if __name__ == "__main__":
    for slug in EFFECTS:
        print(sync_one(slug))
