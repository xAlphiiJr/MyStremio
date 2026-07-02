"""Update service-worker precache revision for main.js after language embed patch."""
from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path


def md5_hex(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def patch_service_worker(service_worker: Path, main_js: Path) -> None:
    revision = md5_hex(main_js)
    text = service_worker.read_text(encoding="utf-8")
    pattern = re.compile(
        r'(\{url:"eb5752673c6ac87e7137a6c3cca21a6980028cf9/scripts/main\.js",revision:")[^"]+("\})'
    )
    if revision in text and f'scripts/main.js",revision:"{revision}"' in text:
        print(f"main.js service-worker revision already {revision}")
        return

    updated, count = pattern.subn(r"\g<1>" + revision + r"\g<2>", text, count=1)
    if count != 1:
        raise RuntimeError("Failed to update main.js revision in service-worker.js")

    main_entry = (
        '{url:"eb5752673c6ac87e7137a6c3cca21a6980028cf9/scripts/main.js",'
        f'revision:"{revision}"}}'
    )
    if main_entry not in updated:
        raise RuntimeError("service-worker.js patch produced invalid main.js precache entry")

    service_worker.write_text(updated, encoding="utf-8")
    print(f"Updated main.js service-worker revision to {revision}")


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: patch-webui-sw-revision.py <webui-dir> <main.js>", file=sys.stderr)
        return 2

    webui_dir = Path(sys.argv[1])
    main_js = Path(sys.argv[2])
    service_worker = webui_dir / "service-worker.js"
    if not service_worker.is_file():
        raise RuntimeError(f"Missing {service_worker}")
    if not main_js.is_file():
        raise RuntimeError(f"Missing {main_js}")

    patch_service_worker(service_worker, main_js)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
