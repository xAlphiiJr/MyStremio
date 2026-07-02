"""Repair mojibake in bundled UI language labels inside main.js."""
from __future__ import annotations

import re
import sys
from pathlib import Path

MOJIBAKE_MARKERS = (
    "×",
    "Ã",
    "â",
    "ä",
    "å",
    "ç",
    "è",
    "é",
    "ö",
    "ü",
    "ð",
    "Ð",
    "Ñ",
    "Ò",
    "Ø",
    "Ù",
    "à",
    "á",
    "ã",
    "ê",
    "ë",
    "ì",
    "í",
    "î",
    "ï",
    "ñ",
    "ò",
    "ó",
    "ô",
    "õ",
    "ù",
    "ú",
    "û",
    "ý",
    "ÿ",
)


def looks_mojibake(value: str) -> bool:
    if not value or value.isascii():
        return False
    if any(ch in value for ch in MOJIBAKE_MARKERS):
        return True
    if re.search(r"[\u0080-\u00ff]{2,}", value) and not re.search(
        r"[\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0900-\u097f\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]",
        value,
    ):
        return True
    return False


def fix_mojibake(value: str) -> str:
    for encoding in ("latin-1", "cp1252"):
        try:
            fixed = value.encode(encoding).decode("utf-8")
            if fixed and fixed != value:
                return fixed
        except UnicodeError:
            continue
    return value


def repair_main_js(path: Path) -> int:
    text = path.read_text(encoding="utf-8")
    changes: list[tuple[str, str]] = []

    def repl(match: re.Match[str]) -> str:
        prefix, value, suffix = match.group(1), match.group(2), match.group(3)
        if not looks_mojibake(value):
            return match.group(0)
        fixed = fix_mojibake(value)
        if fixed == value:
            return match.group(0)
        changes.append((value, fixed))
        return f"{prefix}{fixed}{suffix}"

    fixed_text = re.sub(r'(local:")([^"\\]*(?:\\.[^"\\]*)*)(")', repl, text)
    if changes:
        path.write_bytes(fixed_text.encode("utf-8"))
    return len(changes)


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: fix-webui-language-mojibake.py <path-to-main.js>", file=sys.stderr)
        return 2

    target = Path(sys.argv[1])
    if not target.is_file():
        print(f"Missing file: {target}", file=sys.stderr)
        return 1

    count = repair_main_js(target)
    print(f"Fixed {count} language label(s) in {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
