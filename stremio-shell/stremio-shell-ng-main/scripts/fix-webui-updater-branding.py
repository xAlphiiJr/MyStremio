#!/usr/bin/env python3
"""Rebrand updater banner title from Stremio to MyStremio in bundled main.js."""

from __future__ import annotations

import sys
from pathlib import Path

OLD = "A new version of Stremio is available"
NEW = "A new version of MyStremio is available"


def patch_main_js(path: Path) -> None:
    text = path.read_text(encoding="utf-8", errors="replace")
    if NEW in text and OLD not in text:
        print(f"Updater branding already applied in {path}")
        return
    if OLD not in text:
        print(f"WARNING: updater title string not found in {path}", file=sys.stderr)
        return
    count = text.count(OLD)
    path.write_text(text.replace(OLD, NEW), encoding="utf-8")
    print(f"Patched updater branding ({count} occurrence(s)) in {path}")


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: fix-webui-updater-branding.py <main.js>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"Missing main.js: {path}", file=sys.stderr)
        return 1
    patch_main_js(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
