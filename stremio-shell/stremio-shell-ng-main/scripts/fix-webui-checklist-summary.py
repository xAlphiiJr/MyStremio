#!/usr/bin/env python3
"""
Patch MyStremio ChecklistDropdown / ToggleDropdown summaries so long
multi-select labels stay within a fixed budget and append ", +n".
"""

from __future__ import annotations

import sys
from pathlib import Path

MARKER = "__mystremioTruncateLabelList"

OLD = 'return e.length?e.join(", "):a'
NEW = (
    "return e.length?function(l,z){/*__mystremioTruncateLabelList*/"
    "for(var o=[],i=0;i<l.length;i++){"
    "var r=l.length-i-1,c=o.concat([l[i]]),"
    't=r>0?c.join(", ")+", +"+r:c.join(", ");'
    "if(t.length>28&&o.length)"
    'return o.join(", ")+", +"+(l.length-o.length);'
    "o.push(l[i])}"
    'return o.join(", ")}(e,a):a'
)


def patch_main(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"Checklist summary patch already present in {path}")
        return False
    count = text.count(OLD)
    if count < 1:
        raise RuntimeError(f"Summary join needle not found in {path}")
    text = text.replace(OLD, NEW)
    path.write_text(text, encoding="utf-8")
    print(f"Patched {count} checklist/toggle summary join(s) in {path}")
    return True


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: fix-webui-checklist-summary.py <main.js>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"Missing main.js: {path}", file=sys.stderr)
        return 1
    patch_main(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
