#!/usr/bin/env python3
"""Add Ultimate 240s preload option next to existing Quick Settings preload choices."""

from __future__ import annotations

import sys
from pathlib import Path

MARKER = "__mystremioPreload240"


def patch_main(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"Preload 240s patch already present in {path}")
        return False

    old = (
        '{value:"120",label:"Extreme (120s)"},{value:"full",label:"Full (entire stream)"}'
    )
    new = (
        '{value:"120",label:"Extreme (120s)"},'
        '{value:"240",label:"Ultimate (240s)"}/*' + MARKER + '*/,'
        '{value:"full",label:"Full (entire stream)"}'
    )
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Preload 240s needle count={count} (expected 1)")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"Patched Ultimate 240s preload option in {path}")
    return True


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: patch-webui-preload-240.py <main.js>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"Missing main.js: {path}", file=sys.stderr)
        return 1
    try:
        patch_main(path)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
