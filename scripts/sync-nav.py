#!/usr/bin/env python3
"""Sync the effect-nav block across every effect/index.html.

One canonical list of effect slugs. For each effect folder:
- Find <nav class="effect-nav">...</nav>
- Replace with the canonical nav, marking the current slug as .active
"""
import re
import sys
from pathlib import Path

EFFECTS = [
    "ascii", "bevel", "cellular", "crt", "displace", "distort",
    "dithering", "dots", "edge", "gradients", "patterns", "recolor",
    "scatter", "slide", "stack", "stippling",
]

ROOT = Path(__file__).resolve().parent.parent

def render_nav(active_slug: str) -> str:
    lines = ['<nav class="effect-nav">']
    for slug in EFFECTS:
        cls = ' class="active"' if slug == active_slug else ''
        lines.append(f'    <a href="../{slug}/"{cls}>{slug}</a>')
    lines.append('  </nav>')
    return "\n  ".join(lines)

NAV_RE = re.compile(r'<nav class="effect-nav">.*?</nav>', re.DOTALL)

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
