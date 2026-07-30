"""
Remap wasm-bindgen hashed export names in webui worker.js to match a newly
built stremio_core_web_bg.wasm, and install that wasm into webui/binaries.
"""
from __future__ import annotations

import hashlib
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEBUI_HASH = "eb5752673c6ac87e7137a6c3cca21a6980028cf9"
WORKER = ROOT / "webui" / WEBUI_HASH / "scripts" / "worker.js"
DEST_WASM = ROOT / "webui" / WEBUI_HASH / "binaries" / "stremio_core_web_bg.wasm"


def collect_hashed(text: str) -> dict[str, list[str]]:
    """Map symbol stem (without 16-hex suffix) -> full hashed names."""
    by_stem: dict[str, list[str]] = defaultdict(list)
    for m in re.finditer(
        r"(?:__wbg_[A-Za-z0-9_]+|[A-Za-z0-9_]*wasm_bindgen[A-Za-z0-9_]*|"
        r"[A-Za-z0-9_]*__wbindgen[A-Za-z0-9_]*)",
        text,
    ):
        s = m.group(0)
        hm = re.search(r"([a-f0-9]{16})$", s)
        if not hm:
            continue
        stem = s[:-16]
        if s not in by_stem[stem]:
            by_stem[stem].append(s)
    return by_stem


def invoke_arity(text: str) -> dict[str, int]:
    """Map each closures-invoke symbol to its call-site argument count."""
    result: dict[str, int] = {}
    for m in re.finditer(
        r"(wasm_bindgen__convert__closures_{2,8}invoke__h[a-f0-9]{16})\(([^)]*)\)",
        text,
    ):
        inv = m.group(1)
        args = [a.strip() for a in m.group(2).split(",") if a.strip()]
        result[inv] = max(result.get(inv, 0), len(args))
    return result


def build_mapping(old_js: str, new_js: str) -> dict[str, str]:
    old_by = collect_hashed(old_js)
    new_by = collect_hashed(new_js)
    mapping: dict[str, str] = {}

    only_old = set(old_by) - set(new_by)
    only_new = set(new_by) - set(old_by)
    if only_old or only_new:
        raise RuntimeError(
            f"Hashed stem mismatch only_old={sorted(only_old)[:10]} "
            f"only_new={sorted(only_new)[:10]}"
        )

    for stem, old_names in old_by.items():
        new_names = new_by[stem]
        if len(old_names) == 1 and len(new_names) == 1:
            if old_names[0] != new_names[0]:
                mapping[old_names[0]] = new_names[0]
            continue
        if set(old_names) == set(new_names):
            continue
        if "invoke__h" not in stem:
            if set(old_names) != set(new_names):
                raise RuntimeError(f"Unexpected multi-stem change: {stem}")
            continue

    # Map invoke exports by arity (2/3/4-arg closures).
    old_arity = invoke_arity(old_js)
    new_arity = invoke_arity(new_js)
    new_by_arity: dict[int, list[str]] = defaultdict(list)
    for inv, arity in new_arity.items():
        new_by_arity[arity].append(inv)

    for old_inv, arity in old_arity.items():
        candidates = sorted(set(new_by_arity.get(arity, [])))
        if len(candidates) != 1:
            raise RuntimeError(
                f"Cannot map invoke {old_inv} arity={arity}: {candidates}"
            )
        new_inv = candidates[0]
        if old_inv != new_inv:
            mapping[old_inv] = new_inv

    # Sanity: mapping values must be unique
    values = list(mapping.values())
    if len(values) != len(set(values)):
        raise RuntimeError(f"Non-unique remap targets: {mapping}")

    return mapping


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(
            "Usage: remap-wasm-bindgen-hashes.py <new-stremio_core_web.js> "
            "[<new-stremio_core_web_bg.wasm>]",
            file=sys.stderr,
        )
        return 2

    new_js_path = Path(argv[1])
    new_wasm_path = (
        Path(argv[2])
        if len(argv) > 2
        else new_js_path.with_name("stremio_core_web_bg.wasm")
    )
    if not new_js_path.is_file():
        raise SystemExit(f"Missing {new_js_path}")
    if not new_wasm_path.is_file():
        raise SystemExit(f"Missing {new_wasm_path}")
    if not WORKER.is_file():
        raise SystemExit(f"Missing {WORKER}")

    old_js = WORKER.read_text(encoding="utf-8", errors="strict")
    new_js = new_js_path.read_text(encoding="utf-8", errors="strict")
    mapping = build_mapping(old_js, new_js)
    print(f"Remapping {len(mapping)} hashed symbol(s)")
    for old, new in sorted(mapping.items()):
        print(f"  {old} -> {new}")

    patched = old_js
    for old, new in sorted(mapping.items(), key=lambda kv: -len(kv[0])):
        if old not in patched:
            raise RuntimeError(f"Old symbol not found in worker.js: {old}")
        patched = patched.replace(old, new)

    for new in mapping.values():
        if new not in patched:
            raise RuntimeError(f"New symbol missing after patch: {new}")
    if "hb881961d1559463a" in patched:
        raise RuntimeError("Old crash symbol still present in worker.js")

    WORKER.write_text(patched, encoding="utf-8", newline="")
    DEST_WASM.write_bytes(new_wasm_path.read_bytes())
    md5 = hashlib.md5(DEST_WASM.read_bytes()).hexdigest()
    print(f"Wrote {WORKER}")
    print(f"Wrote {DEST_WASM} md5={md5}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
