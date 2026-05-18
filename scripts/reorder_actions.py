#!/usr/bin/env python3
"""
Reorder .wa-actions buttons in all pixart effect index.html files.
Target order: [export-png] [export-mp4] [toggle-controls] [help-btn]
Note: pixart currently lacks toggle-controls — this script adds it.
Idempotent: skips files already in the new order.
"""

import os
import re

PIXART_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NEW_ACTIONS = '''<div class="wa-actions">
      <button id="export-png" title="save image"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M2,8 l3,-2.5 2.5,2 2.5,-2 4.5,3"/><circle cx="5.5" cy="5.5" r=".9" fill="currentColor" stroke="none"/><line x1="8" y1="12.5" x2="8" y2="15.5"/><polyline points="6,14 8,15.5 10,14"/></svg></button>
      <button id="export-mp4" title="record video"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3.5" width="10" height="9" rx="1.5"/><polygon points="11.5,6.5 14.5,5 14.5,11 11.5,9.5" fill="currentColor" stroke="none"/></svg></button>
      <button id="toggle-controls" title="Toggle controls (C)"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/><circle cx="10" cy="4" r="1.6" fill="var(--bg,#fff)"/><circle cx="5" cy="8" r="1.6" fill="var(--bg,#fff)"/><circle cx="11" cy="12" r="1.6" fill="var(--bg,#fff)"/></svg></button>
      <button id="help-btn" title="Keyboard shortcuts">?</button>
    </div>'''

# Pattern: match the entire wa-actions div from opening tag to closing tag
WA_ACTIONS_PATTERN = re.compile(
    r'<div class="wa-actions">.*?</div>',
    re.DOTALL
)

SKIP_DIRS = {'shared', 'node_modules', 'assets', 'docs', 'scripts'}

def is_already_reordered(content):
    """Check if export-png comes before help-btn AND toggle-controls is present."""
    m = WA_ACTIONS_PATTERN.search(content)
    if not m:
        return False
    block = m.group(0)
    png_pos = block.find('id="export-png"')
    help_pos = block.find('id="help-btn"')
    toggle_pos = block.find('id="toggle-controls"')
    if png_pos == -1 or help_pos == -1 or toggle_pos == -1:
        return False
    # In new order: export-png first, then export-mp4, then toggle-controls, then help-btn
    return png_pos < help_pos and toggle_pos < help_pos and png_pos < toggle_pos

def process_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    if 'wa-actions' not in content:
        print(f"  SKIP (no wa-actions): {path}")
        return False

    if is_already_reordered(content):
        print(f"  SKIP (already done): {path}")
        return False

    new_content = WA_ACTIONS_PATTERN.sub(NEW_ACTIONS, content, count=1)

    if new_content == content:
        print(f"  SKIP (no change): {path}")
        return False

    with open(path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f"  UPDATED: {path}")
    return True

def main():
    updated = 0
    skipped = 0

    for name in sorted(os.listdir(PIXART_ROOT)):
        if name in SKIP_DIRS:
            continue
        effect_dir = os.path.join(PIXART_ROOT, name)
        if not os.path.isdir(effect_dir):
            continue
        index_path = os.path.join(effect_dir, 'index.html')
        if not os.path.isfile(index_path):
            continue
        print(f"Processing: {name}")
        if process_file(index_path):
            updated += 1
        else:
            skipped += 1

    print(f"\nDone. Updated: {updated}, Skipped/already done: {skipped}")

if __name__ == '__main__':
    main()
