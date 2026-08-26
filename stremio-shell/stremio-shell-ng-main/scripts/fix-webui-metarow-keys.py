#!/usr/bin/env python3
"""Patch MetaRow/CW item React keys from array index to library _id."""

from __future__ import annotations

import sys
from pathlib import Path

# Stock MetaRow maps posters with key:t (index). Continue Watching reorders
# reuse the first DOM node, so Outer Banks art sticks on a Naruto label.
NEEDLE = '{key:t,className:S(O["meta-item"]'
REPLACEMENT = '{key:e._id||e.id||t,className:S(O["meta-item"]'
MARKER = "key:e._id||e.id||t"


def patch_file(path: Path) -> int:
    text = path.read_text(encoding="utf-8", errors="replace")
    original = text

    if NEEDLE in text:
        text = text.replace(NEEDLE, REPLACEMENT)
        print(f"Patched MetaRow item keys to _id in {path}")
    elif MARKER in text:
        print(f"MetaRow item keys already patched in {path}")
        return 0
    else:
        print(f"WARNING: MetaRow key needle not found in {path}", file=sys.stderr)
        return 1

    if text != original:
        path.write_text(text, encoding="utf-8", newline="")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("Usage: fix-webui-metarow-keys.py <main.js>", file=sys.stderr)
        return 2
    path = Path(argv[1])
    if not path.is_file():
        print(f"File not found: {path}", file=sys.stderr)
        return 2
    return patch_file(path)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
