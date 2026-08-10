#!/usr/bin/env python3
"""
Patch bundled stremio-web main.js so Quick Settings is a native Settings
section: SECTIONS.QUICK, Menu button, scroll-spy ref, and QuickSettings ref.
"""

from __future__ import annotations

import sys
from pathlib import Path

MARKER = "__mystremioQuickSection"

OLD_SECTIONS = (
    't.SECTIONS={GENERAL:"general",PLAYER:"player",INTERFACE:"interface",'
    'STREAMING:"streaming",SHORTCUTS:"shortcuts",MYSTREMIO:"mystremio"}'
)
NEW_SECTIONS = (
    't.SECTIONS={GENERAL:"general",QUICK:"quick"/*__mystremioQuickSection*/,'
    'PLAYER:"player",INTERFACE:"interface",STREAMING:"streaming",'
    'SHORTCUTS:"shortcuts",MYSTREMIO:"mystremio"}'
)

# Menu uses undeclared temps for className objects; q must be in that var list.
OLD_MENU_VARS = (
    "t.default=function(e){var t,a,i,o,E,n,r=e.selected,"
    "u=e.streamingServer,O=e.onSelect"
)
NEW_MENU_VARS = (
    "t.default=function(e){var t,a,i,o,E,n,q,r=e.selected,"
    "u=e.streamingServer,O=e.onSelect"
)

# Insert Quick Settings nav button after General, before Interface.
OLD_MENU = (
    'title:d("SETTINGS_NAV_GENERAL"),"data-section":I.SECTIONS.GENERAL,onClick:O},'
    'd("SETTINGS_NAV_GENERAL")),_.default.createElement(l.Button,{className:(0,T.default)'
    "(A.default.button,(a={},a[A.default.selected]=r===I.SECTIONS.INTERFACE,a)),"
    'title:d("INTERFACE"),"data-section":I.SECTIONS.INTERFACE,onClick:O},d("INTERFACE"))'
)
NEW_MENU = (
    'title:d("SETTINGS_NAV_GENERAL"),"data-section":I.SECTIONS.GENERAL,onClick:O},'
    'd("SETTINGS_NAV_GENERAL")),_.default.createElement(l.Button,{className:(0,T.default)'
    "(A.default.button,(q={},q[A.default.selected]=r===I.SECTIONS.QUICK,q)),"
    'title:"Quick Settings","data-section":I.SECTIONS.QUICK,onClick:O},"Quick Settings"),'
    "_.default.createElement(l.Button,{className:(0,T.default)"
    "(A.default.button,(a={},a[A.default.selected]=r===I.SECTIONS.INTERFACE,a)),"
    'title:d("INTERFACE"),"data-section":I.SECTIONS.INTERFACE,onClick:O},d("INTERFACE"))'
)

OLD_REFS = (
    "o=(0,_.useRef)(null),E=(0,_.useRef)(null),n=(0,_.useRef)(null),"
    "r=(0,_.useRef)(null),C=(0,_.useRef)(null),p=(0,_.useRef)(null),P=(0,_.useRef)(null),"
    "h=(0,_.useMemo)(function(){return[{ref:E,id:I.SECTIONS.GENERAL},"
    "{ref:n,id:I.SECTIONS.INTERFACE},{ref:r,id:I.SECTIONS.PLAYER},"
    "{ref:C,id:I.SECTIONS.STREAMING},{ref:p,id:I.SECTIONS.MYSTREMIO},"
    "{ref:P,id:I.SECTIONS.SHORTCUTS}]},[])"
)
NEW_REFS = (
    "o=(0,_.useRef)(null),E=(0,_.useRef)(null),w=(0,_.useRef)(null),"
    "n=(0,_.useRef)(null),r=(0,_.useRef)(null),C=(0,_.useRef)(null),"
    "p=(0,_.useRef)(null),P=(0,_.useRef)(null),"
    "h=(0,_.useMemo)(function(){return[{ref:E,id:I.SECTIONS.GENERAL},"
    "{ref:w,id:I.SECTIONS.QUICK},{ref:n,id:I.SECTIONS.INTERFACE},"
    "{ref:r,id:I.SECTIONS.PLAYER},{ref:C,id:I.SECTIONS.STREAMING},"
    "{ref:p,id:I.SECTIONS.MYSTREMIO},{ref:P,id:I.SECTIONS.SHORTCUTS}]},[])"
)

OLD_RENDER = (
    "_.default.createElement(u.default,{ref:E,profile:t}),"
    "_.default.createElement(O.default,null),"
    "_.default.createElement(d.default,{ref:n,profile:t})"
)
NEW_RENDER = (
    "_.default.createElement(u.default,{ref:E,profile:t}),"
    "_.default.createElement(O.default,{ref:w}),"
    "_.default.createElement(d.default,{ref:n,profile:t})"
)


def _replace_once(text: str, label: str, old: str, new: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label} needle count={count} (expected 1)")
    return text.replace(old, new, 1)


def repair_menu_var(text: str) -> tuple[str, bool]:
    """Declare Menu className temp `q` (fixes black screen on Settings)."""
    if NEW_MENU_VARS in text:
        return text, False
    if OLD_MENU_VARS not in text:
        if 'SECTIONS.QUICK' in text and '(q={},q[A.default.selected]' in text:
            raise RuntimeError(
                "Quick Settings menu uses q but Menu var list could not be patched"
            )
        return text, False
    return _replace_once(text, "Menu var q", OLD_MENU_VARS, NEW_MENU_VARS), True


def patch_main(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    changed = False

    if MARKER in text:
        text, repaired = repair_menu_var(text)
        if repaired:
            path.write_text(text, encoding="utf-8")
            print(f"Repaired Menu var q for Quick Settings in {path}")
            return True
        print(f"Quick Settings section patch already present in {path}")
        return False

    text = _replace_once(text, "SECTIONS", OLD_SECTIONS, NEW_SECTIONS)
    text = _replace_once(text, "Menu var q", OLD_MENU_VARS, NEW_MENU_VARS)
    text = _replace_once(text, "Menu", OLD_MENU, NEW_MENU)
    text = _replace_once(text, "refs/sections", OLD_REFS, NEW_REFS)
    text = _replace_once(text, "QuickSettings render", OLD_RENDER, NEW_RENDER)
    changed = True

    path.write_text(text, encoding="utf-8")
    print(f"Patched Quick Settings native section in {path}")
    return changed


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "Usage: fix-webui-settings-quick-section.py <main.js>",
            file=sys.stderr,
        )
        return 2
    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"Missing main.js: {path}", file=sys.stderr)
        return 1
    try:
        patch_main(path)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
