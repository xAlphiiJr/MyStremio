#!/usr/bin/env python3
"""
Patch bundled stremio-web main.js: in Settings > General, add native links
"MyStremio on GitHub" and "Update now" right after "Source code". "Update now"
asks the shell to update immediately (no updater banner).
"""

from __future__ import annotations

import sys
from pathlib import Path

MARKER = "__mystremioAboutUpdate"
REPO_URL = "https://github.com/xAlphiiJr/MyStremio"

# General section hooks: c is usePlatform(), T is React.
OLD_HOOKS = "c=(0,I.usePlatform)(),m=(0,I.useToast)(),"
NEW_HOOKS = (
    "c=(0,I.usePlatform)(),m=(0,I.useToast)(),"
    '__msUpd=(0,T.useState)("")/*' + MARKER + "*/,"
    "__msEff=(0,T.useEffect)(function(){"
    'var f=function(s){__msUpd[1](String(s||""))};'
    'c.shell.on("mystremio-update-status",f);'
    'return function(){c.shell.off("mystremio-update-status",f)}},[]),'
)

OLD_LINKS = (
    'T.default.createElement(A.Link,{label:N("SETTINGS_SOURCE_CODE"),'
    'href:"https://github.com/stremio/stremio-web/tree/".concat('
)
NEW_LINKS = (
    'T.default.createElement(A.Link,{label:"MyStremio on GitHub",href:"' + REPO_URL + '"}),'
    "T.default.createElement(A.Link,{label:({"
    'checking:"Checking for updates...",'
    'installing:"Installing update...",'
    'latest:"Up to date (check again)",'
    'error:"Update failed (try again)"'
    '})[__msUpd[0]]||"Update now",'
    "onClick:function(){"
    'if("checking"===__msUpd[0]||"installing"===__msUpd[0])return;'
    '__msUpd[1]("checking");c.shell.send("mystremio-update-now")}}),'
    + OLD_LINKS
)


def _replace_once(text: str, label: str, old: str, new: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label} needle count={count} (expected 1)")
    return text.replace(old, new, 1)


def patch_main(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"About/Update patch already present in {path}")
        return False
    text = _replace_once(text, "hooks", OLD_HOOKS, NEW_HOOKS)
    text = _replace_once(text, "links", OLD_LINKS, NEW_LINKS)
    path.write_text(text, encoding="utf-8")
    print(f"Patched GitHub/Update links into Settings > General in {path}")
    return True


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: patch-webui-about-update.py <main.js>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"Missing main.js: {path}", file=sys.stderr)
        return 1
    patch_main(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
