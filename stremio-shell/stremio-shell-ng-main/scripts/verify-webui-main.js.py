"""Fail the build if bundled main.js contains known corruption markers."""
from __future__ import annotations

import re
import sys
from pathlib import Path


def verify_main_js(main_js: Path) -> None:
    data = main_js.read_bytes()
    if b"??????" in data:
        raise RuntimeError(
            f"{main_js} contains corrupted placeholder bytes in a regex literal"
        )
    if not re.search(rb"/\^\(\\w\+\)\$/", data):
        raise RuntimeError(f"{main_js} does not look like a valid stremio-web bundle")

    if not re.search(rb"if\(!r\)return", data):
        raise RuntimeError(f"{main_js} is missing DynamicHero null guard patch")
    if b"FALLBACK_TITLES[0]" in data:
        raise RuntimeError(f"{main_js} still references FALLBACK_TITLES[0]")
    if b"FALLBACK_TITLES.map" in data:
        raise RuntimeError(f"{main_js} still contains FALLBACK_TITLES.map")

    for match in re.finditer(rb"/[^/\n]{0,60}WEBVTT[^/\n]{0,60}/", data):
        snippet = match.group(0)
        if b"??????" in snippet:
            raise RuntimeError(
                f"{main_js} has invalid WEBVTT regex literal: {snippet[:80]!r}"
            )


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: verify-webui-main.js.py <main.js>", file=sys.stderr)
        return 2

    main_js = Path(sys.argv[1])
    if not main_js.is_file():
        raise RuntimeError(f"Missing {main_js}")

    verify_main_js(main_js)
    print(f"Verified {main_js}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
