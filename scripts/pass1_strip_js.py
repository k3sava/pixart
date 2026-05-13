#!/usr/bin/env python3
"""Pass 1 JS strip: force animate=false, interactive=false in params for 26 effects.
Skip slide and stack (real animators — Pass 3 reworks them).
The HTML rows for mode/animate/interactive/focusRadius are already gone via pass1_strip_html.py.
"""
import re, pathlib

ROOT = pathlib.Path('/Users/k3sava/projects/pixart')
SKIP = {'slide', 'stack'}

# Match `  animate: <expr>,` or `  animate: <expr>` (last in object) and force to false.
# Same for interactive. Only edit the first occurrence in the file (the params const).
def force_false(text, key):
    # Allow leading whitespace, the key, colon, any value up to comma or newline.
    # Use re.subn with count=1.
    pat = re.compile(rf'(^\s*){re.escape(key)}\s*:\s*[^,\n]+(,?)\s*(//[^\n]*)?$', re.MULTILINE)
    new_text, n = pat.subn(rf'\g<1>{key}: false\g<2>', text, count=1)
    return new_text, n

def process(path: pathlib.Path):
    text = path.read_text()
    orig = text
    text, n1 = force_false(text, 'animate')
    text, n2 = force_false(text, 'interactive')
    if text != orig:
        path.write_text(text)
    return n1, n2

def main():
    effect_dirs = sorted([p for p in ROOT.iterdir() if p.is_dir() and (p / 'effect.js').exists() and p.name not in {'docs','scripts','shared','assets'}])
    for d in effect_dirs:
        if d.name in SKIP:
            print(f"{d.name}: SKIPPED (real animator)")
            continue
        js = d / 'effect.js'
        n1, n2 = process(js)
        print(f"{d.name}: animate→false ({n1}), interactive→false ({n2})")

if __name__ == '__main__':
    main()
