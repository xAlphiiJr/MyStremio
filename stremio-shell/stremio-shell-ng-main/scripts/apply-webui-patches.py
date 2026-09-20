#!/usr/bin/env python3
"""Apply and verify MyStremio web UI patches from patches.json."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPTS_DIR.parent
MANIFEST_PATH = SCRIPTS_DIR / "patches.json"


def discover_hashed_dir(webui_dir: Path) -> Path:
    matches = [
        child
        for child in webui_dir.iterdir()
        if child.is_dir() and (child / "scripts" / "main.js").is_file()
    ]
    if len(matches) != 1:
        names = [m.name for m in matches]
        raise RuntimeError(f"Expected one hashed webui bundle under {webui_dir}, found {names}")
    return matches[0]


def resolve_paths(webui_dir: Path) -> dict[str, str]:
    hashed = discover_hashed_dir(webui_dir)
    return {
        "webui": str(webui_dir),
        "mainJs": str(hashed / "scripts" / "main.js"),
        "workerJs": str(hashed / "scripts" / "worker.js"),
        "indexHtml": str(webui_dir / "index.html"),
        "preboot": str(PROJECT_ROOT / "assets" / "custom_preboot.js"),
        "interfaceLanguages": str(PROJECT_ROOT / "assets" / "interfaceLanguages.json"),
        "languageNames": str(PROJECT_ROOT / "assets" / "languageNames.json"),
    }


def generate_preboot(paths: dict[str, str]) -> None:
    src = Path(paths["preboot"])
    dst = Path(paths["webui"]) / "mystremio-preboot.js"
    if not src.is_file():
        raise RuntimeError(f"Missing preboot source {src}")
    dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"Generated {dst} from {src}")


def expand(value: str, paths: dict[str, str]) -> str:
    for key, replacement in paths.items():
        value = value.replace("${" + key + "}", replacement)
    if "${" in value:
        raise RuntimeError(f"Unresolved placeholder in {value!r}")
    return value


def verify_entry(entry: dict, paths: dict[str, str]) -> None:
    spec = entry.get("verify")
    if not spec:
        return
    target = Path(expand(spec["file"], paths))
    if not target.is_file():
        raise RuntimeError(f"{entry['id']}: missing verify file {target}")
    text = target.read_text(encoding="utf-8", errors="replace")
    for needle in spec.get("mustContain") or []:
        if needle not in text:
            raise RuntimeError(f"{entry['id']}: missing marker {needle!r} in {target}")
    for needle in spec.get("mustNotContain") or []:
        if needle in text:
            raise RuntimeError(f"{entry['id']}: forbidden marker {needle!r} still in {target}")


def run_patch(entry: dict, paths: dict[str, str], python_exe: str) -> None:
    script = SCRIPTS_DIR / entry["script"]
    if not script.is_file():
        raise RuntimeError(f"{entry['id']}: missing script {script}")
    args = [python_exe, str(script), *[expand(arg, paths) for arg in entry.get("args") or []]]
    completed = subprocess.run(args, check=False)
    if completed.returncode != 0:
        raise RuntimeError(
            f"{entry['id']}: {script.name} exited {completed.returncode}"
        )


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(
            f"Usage: {argv[0]} <webui-dir> [--verify-only]",
            file=sys.stderr,
        )
        return 2

    webui_dir = Path(argv[1]).resolve()
    verify_only = "--verify-only" in argv[2:]
    if not webui_dir.is_dir():
        raise RuntimeError(f"Missing web UI directory: {webui_dir}")
    if not MANIFEST_PATH.is_file():
        raise RuntimeError(f"Missing patch manifest: {MANIFEST_PATH}")

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    patches = manifest.get("patches") or []
    paths = resolve_paths(webui_dir)
    python_exe = sys.executable
    generate_preboot(paths)

    if not verify_only:
        for entry in patches:
            print(f"Applying {entry['id']}...")
            run_patch(entry, paths, python_exe)
            verify_entry(entry, paths)
            print(f"Verified {entry['id']}")
    else:
        for entry in patches:
            if entry.get("verify"):
                verify_entry(entry, paths)
            elif str(entry.get("id", "")).startswith("verify-"):
                run_patch(entry, paths, python_exe)
            print(f"Verified {entry['id']}")

    print(f"{'Verified' if verify_only else 'Applied'} {len(patches)} web UI patches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
