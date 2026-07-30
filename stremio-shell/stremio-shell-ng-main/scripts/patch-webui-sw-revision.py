"""Update service-worker precache revisions for main.js and core WASM."""
from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

WEBUI_HASH = "eb5752673c6ac87e7137a6c3cca21a6980028cf9"


def md5_hex(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def _patch_entry(text: str, relative_url: str, revision: str, label: str) -> str:
    """
    Replace the precache revision for a given relative URL.

    @param text - service-worker.js contents
    @param relative_url - precache url path (no leading slash)
    @param revision - md5 hex of the file
    @param label - human label for log messages
    @returns updated text
    """
    escaped = re.escape(relative_url)
    pattern = re.compile(rf'(\{{url:"{escaped}",revision:")[^"]+("\}})')
    entry = f'{{url:"{relative_url}",revision:"{revision}"}}'
    if entry in text:
        print(f"{label} service-worker revision already {revision}")
        return text

    updated, count = pattern.subn(r"\g<1>" + revision + r"\g<2>", text, count=1)
    if count != 1:
        raise RuntimeError(f"Failed to update {label} revision in service-worker.js")
    if entry not in updated:
        raise RuntimeError(
            f"service-worker.js patch produced invalid {label} precache entry"
        )
    print(f"Updated {label} service-worker revision to {revision}")
    return updated


def patch_service_worker(service_worker: Path, main_js: Path) -> None:
    text = service_worker.read_text(encoding="utf-8")
    text = _patch_entry(
        text,
        f"{WEBUI_HASH}/scripts/main.js",
        md5_hex(main_js),
        "main.js",
    )

    wasm = (
        service_worker.parent
        / WEBUI_HASH
        / "binaries"
        / "stremio_core_web_bg.wasm"
    )
    if wasm.is_file():
        text = _patch_entry(
            text,
            f"{WEBUI_HASH}/binaries/stremio_core_web_bg.wasm",
            md5_hex(wasm),
            "core wasm",
        )
    else:
        print(f"WARNING: missing wasm at {wasm}; skipped wasm revision update")

    worker = service_worker.parent / WEBUI_HASH / "scripts" / "worker.js"
    if worker.is_file():
        text = _patch_entry(
            text,
            f"{WEBUI_HASH}/scripts/worker.js",
            md5_hex(worker),
            "worker.js",
        )
    else:
        print(f"WARNING: missing worker at {worker}; skipped worker revision update")

    service_worker.write_text(text, encoding="utf-8")


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
