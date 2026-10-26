"""Repair mojibake in bundled UI language labels inside main.js.

The iso-639 table in the Stremio web bundle was stored as UTF-8 bytes read as
Windows-1252. Native names such as Hindi and Russian then render as garbage.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

# Windows-1252 bytes 0x80-0x9F that are not the same code point.
# The five undefined bytes stay as U+0081, U+008D, U+008F, U+0090, U+009D.
CP1252_EXTRA = {
    0x20AC: 0x80,
    0x201A: 0x82,
    0x0192: 0x83,
    0x201E: 0x84,
    0x2026: 0x85,
    0x2020: 0x86,
    0x2021: 0x87,
    0x02C6: 0x88,
    0x2030: 0x89,
    0x0160: 0x8A,
    0x2039: 0x8B,
    0x0152: 0x8C,
    0x017D: 0x8E,
    0x2018: 0x91,
    0x2019: 0x92,
    0x201C: 0x93,
    0x201D: 0x94,
    0x2022: 0x95,
    0x2013: 0x96,
    0x2014: 0x97,
    0x02DC: 0x98,
    0x2122: 0x99,
    0x0161: 0x9A,
    0x203A: 0x9B,
    0x0153: 0x9C,
    0x017E: 0x9E,
    0x0178: 0x9F,
}


def recover(value: str) -> str | None:
    raw = bytearray()
    for ch in value:
        code = ord(ch)
        if code in CP1252_EXTRA:
            raw.append(CP1252_EXTRA[code])
        elif code <= 0xFF:
            raw.append(code)
        else:
            return None
    try:
        fixed = raw.decode("utf-8")
    except UnicodeError:
        return None
    if fixed == value or '"' in fixed or "\\" in fixed:
        return None
    return fixed


def _corrupt(value: str) -> str:
    inverse = {byte: code for code, byte in CP1252_EXTRA.items()}
    return "".join(chr(inverse.get(byte, byte)) for byte in value.encode("utf-8"))


def self_check() -> None:
    assert recover(_corrupt("Русский")) == "Русский"
    assert recover(_corrupt("हिन्दी")) == "हिन्दी"
    assert recover(_corrupt("Azərbaycanca")) == "Azərbaycanca"
    assert recover("Français") is None
    assert recover("Čeština") is None
    assert recover("Español") is None


def repair_main_js(path: Path) -> int:
    self_check()
    text = path.read_text(encoding="utf-8")
    changes = 0

    def repl(match: re.Match[str]) -> str:
        nonlocal changes
        fixed = recover(match.group(2))
        if not fixed:
            return match.group(0)
        changes += 1
        return f"{match.group(1)}{fixed}{match.group(3)}"

    fixed_text = re.sub(r'(local:")([^"\\]*(?:\\.[^"\\]*)*)(")', repl, text)
    fixed_text = re.sub(r'(name:")([^"\\]*(?:\\.[^"\\]*)*)(")', repl, fixed_text)
    if changes:
        path.write_bytes(fixed_text.encode("utf-8"))
    return changes


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
