#!/usr/bin/env python3
"""Strip invented wg-row blocks (mode/animate/interactive/focusRadius) from pixart effect index.html files."""
import re, sys, pathlib

TARGETS = {'mode', 'animate', 'interactive', 'focusRadius'}

ROOT = pathlib.Path('/Users/k3sava/projects/pixart')

# Regex to find the opening of a wg-row with one of our target data-keys.
# data-key may appear with single or double quotes.
OPEN_RE = re.compile(r'<div\s+class="wg-row[^"]*"[^>]*data-key="(mode|animate|interactive|focusRadius)"[^>]*>')

def strip_block(text, start_idx, open_match):
    """Given text and the start of a matching opening <div>, find balanced close and remove that span (plus surrounding blank line if any)."""
    # Walk depth-counted scan
    i = open_match.end()
    depth = 1
    # tokenize as we look for <div> and </div>
    pat = re.compile(r'<(/?)div\b[^>]*>', re.IGNORECASE)
    end = None
    for m in pat.finditer(text, i):
        if m.group(1) == '/':
            depth -= 1
            if depth == 0:
                end = m.end()
                break
        else:
            depth += 1
    if end is None:
        raise RuntimeError(f"unbalanced div starting at {start_idx}")
    # Expand to consume the preceding indentation/whitespace from line start and trailing newline
    line_start = text.rfind('\n', 0, start_idx) + 1
    # Only swallow leading whitespace if it's all spaces/tabs between line_start and start_idx
    pre = text[line_start:start_idx]
    if pre.strip() == '':
        start = line_start
    else:
        start = start_idx
    # Swallow one trailing newline
    if end < len(text) and text[end] == '\n':
        end += 1
    return text[:start] + text[end:]

def strip_file(path: pathlib.Path):
    text = path.read_text()
    removed = []
    # Iteratively remove (since indices shift)
    while True:
        m = OPEN_RE.search(text)
        if not m:
            break
        removed.append(m.group(1))
        text = strip_block(text, m.start(), m)
    path.write_text(text)
    return removed

def main():
    effect_dirs = sorted([p for p in ROOT.iterdir() if p.is_dir() and (p / 'index.html').exists() and p.name not in {'docs','scripts','shared','assets'}])
    for d in effect_dirs:
        idx = d / 'index.html'
        removed = strip_file(idx)
        print(f"{d.name}: removed {sorted(removed)}")

if __name__ == '__main__':
    main()
