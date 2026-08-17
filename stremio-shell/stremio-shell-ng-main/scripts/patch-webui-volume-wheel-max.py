#!/usr/bin/env python3
"""Raise bundled player wheel volume cap from 100 to 200 (slider is 0–200)."""

from __future__ import annotations

import sys
from pathlib import Path

MARKER = "__mystremioVolumeWheelMax"


def patch_main(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"Volume wheel max patch already present in {path}")
        return False

    old = (
        "t>0?_a(Math.max(Ue.state.volume-5,0)):Ue.state.volume<100&&_a(Math.min(Ue.state.volume+5,100))"
    )
    new = (
        "t>0?_a(Math.max(Ue.state.volume-5,0)):Ue.state.volume<200&&_a(Math.min(Ue.state.volume+5,200))"
        "/*" + MARKER + "*/"
    )
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Volume wheel needle count={count} (expected 1)")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"Patched volume wheel max in {path}")
    return True


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: patch-webui-volume-wheel-max.py <main.js>", file=sys.stderr)
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
