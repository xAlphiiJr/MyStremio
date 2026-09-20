#!/usr/bin/env python3
"""Inject custom_preboot.js into webui/index.html before bundled main.js."""

from __future__ import annotations

import re
import sys
from pathlib import Path

PREBOOT_TAG = '<script src="mystremio-preboot.js"></script>'
MAIN_SCRIPT_RE = re.compile(
    r'<script src="[0-9a-f]+/scripts/main\.js">',
    re.IGNORECASE,
)


def patch_index_html(index_html: Path, preboot_js: Path) -> None:
    if not preboot_js.is_file():
        raise RuntimeError(f"Missing preboot asset at {preboot_js}")

    html = index_html.read_text(encoding="utf-8")
    if PREBOOT_TAG in html:
        print(f"Preboot script tag already present in {index_html}")
    else:
        match = MAIN_SCRIPT_RE.search(html)
        if not match:
            raise RuntimeError(f"Could not find main.js script tag in {index_html}")
        html = html.replace(match.group(0), f"{PREBOOT_TAG}{match.group(0)}", 1)
        index_html.write_text(html, encoding="utf-8")
        print(f"Inserted preboot script tag into {index_html}")

    target = index_html.parent / "mystremio-preboot.js"
    target.write_text(preboot_js.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"Copied preboot script to {target}")


def main() -> int:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <webui-dir> <custom_preboot.js>", file=sys.stderr)
        return 2

    webui_dir = Path(sys.argv[1])
    preboot_src = Path(sys.argv[2])
    patch_index_html(webui_dir / "index.html", preboot_src)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
