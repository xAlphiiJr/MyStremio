"""Embed original Stremio language JSON into bundled main.js."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def js_single_quoted_string(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )


def replace_json_parse_module(text: str, module_id: str, payload) -> tuple[str, bool]:
    json_text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    replacement = (
        f'{module_id}(e){{"use strict";e.exports=JSON.parse(\'{js_single_quoted_string(json_text)}\')}}'
    )
    pattern = re.compile(
        rf"{re.escape(module_id)}\(e\)\{{\"use strict\";e\.exports=JSON\.parse\('.*?'\)\}}"
    )
    new_text, count = pattern.subn(replacement, text, count=1)
    return new_text, count == 1


def repair_main_js(
    main_js: Path,
    interface_languages_path: Path,
    language_names_path: Path,
) -> None:
    text = main_js.read_text(encoding="utf-8")
    interface_languages = json.loads(interface_languages_path.read_text(encoding="utf-8"))
    language_names = json.loads(language_names_path.read_text(encoding="utf-8"))

    text, ok_interface = replace_json_parse_module(text, "96859", interface_languages)
    if not ok_interface:
        raise RuntimeError("Failed to replace interfaceLanguages module (96859)")

    text, ok_names = replace_json_parse_module(text, "293", language_names)
    if not ok_names:
        raise RuntimeError("Failed to replace languageNames module (293)")

    main_js.write_bytes(text.encode("utf-8"))
    print(
        f"Embedded original language data in {main_js} "
        f"({len(interface_languages)} interface languages, {len(language_names)} language names)"
    )


def main() -> int:
    if len(sys.argv) not in (2, 4):
        print(
            "Usage: fix-webui-language-embeds.py <main.js> "
            "[interfaceLanguages.json languageNames.json]",
            file=sys.stderr,
        )
        return 2

    main_js = Path(sys.argv[1])
    if not main_js.is_file():
        print(f"Missing file: {main_js}", file=sys.stderr)
        return 1

    assets = main_js.parents[3] / "assets"
    interface_languages_path = (
        Path(sys.argv[2]) if len(sys.argv) >= 3 else assets / "interfaceLanguages.json"
    )
    language_names_path = (
        Path(sys.argv[3]) if len(sys.argv) == 4 else assets / "languageNames.json"
    )

    for path in (interface_languages_path, language_names_path):
        if not path.is_file():
            print(f"Missing language source: {path}", file=sys.stderr)
            return 1

    repair_main_js(main_js, interface_languages_path, language_names_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
