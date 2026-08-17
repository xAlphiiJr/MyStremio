#!/usr/bin/env python3
"""Keep native subtitle size/offset/color across ShellVideo loadfile.

Official ShellVideo only restores speed/aid after loadfile. React does not
re-send unchanged subtitle props, so MPV falls back to defaults until the
user clicks Size/Offset (which is a raw setProp).

This patch:
1. Uses sub-ass-override=force so size, offset, and colors apply to ASS.
2. Remembers the last ShellVideo subtitle setProp values.
3. Replays them after loadfile and after sid changes — same send path as a click.
"""

from __future__ import annotations

import sys
from pathlib import Path

OVERRIDE_MARKER = "__mystremioSubAssScale"
REPLAY_MARKER = "__mystremioSubReplay"

OLD_OVERRIDE_NO = 'var o=i.assSubtitlesStyling?"strip":"no"'
OLD_OVERRIDE_SCALE = (
    'var o=i.assSubtitlesStyling?"strip":"scale"/*' + OVERRIDE_MARKER + "*/"
)
NEW_OVERRIDE = (
    'var o=i.assSubtitlesStyling?"strip":"force"/*' + OVERRIDE_MARKER + "*/"
)

OLD_LASTSUB_INIT = "r=.0066,_="
NEW_LASTSUB_INIT = "r=.0066,mystremioLastSub={},_="

OLD_SETPROP = (
    'case"subtitlesSize":a.send("mpv-set-prop",[_[e],t*r]);'
    'break;case"subtitlesDelay":a.send("mpv-set-prop",[_[e],t]);'
    'break;case"subtitlesOffset":a.send("mpv-set-prop",[_[e],100-t]);'
    'break;case"subtitlesTextColor":case"subtitlesBackgroundColor":'
    'case"subtitlesOutlineColor":var o=t.replace(/^#(\\w{6})(\\w{2})$/,"#$2$1");'
    'a.send("mpv-set-prop",[_[e],o]);'
)
NEW_SETPROP = (
    'case"subtitlesSize":mystremioLastSub.scale=t*r,a.send("mpv-set-prop",[_[e],t*r]);'
    'break;case"subtitlesDelay":mystremioLastSub.delay=t,a.send("mpv-set-prop",[_[e],t]);'
    'break;case"subtitlesOffset":mystremioLastSub.pos=100-t,a.send("mpv-set-prop",[_[e],100-t]);'
    'break;case"subtitlesTextColor":case"subtitlesBackgroundColor":'
    'case"subtitlesOutlineColor":var o=t.replace(/^#(\\w{6})(\\w{2})$/,"#$2$1");'
    "mystremioLastSub[_[e]]=o,a.send(\"mpv-set-prop\",[_[e],o]);"
)

REPLAY = (
    "null!=mystremioLastSub.scale&&a.send(\"mpv-set-prop\",[\"sub-scale\",mystremioLastSub.scale]),"
    "null!=mystremioLastSub.pos&&a.send(\"mpv-set-prop\",[\"sub-pos\",mystremioLastSub.pos]),"
    "null!=mystremioLastSub.delay&&a.send(\"mpv-set-prop\",[\"sub-delay\",mystremioLastSub.delay]),"
    "mystremioLastSub[\"sub-color\"]&&a.send(\"mpv-set-prop\",[\"sub-color\",mystremioLastSub[\"sub-color\"]]),"
    "mystremioLastSub[\"sub-back-color\"]&&a.send(\"mpv-set-prop\",[\"sub-back-color\",mystremioLastSub[\"sub-back-color\"]]),"
    "mystremioLastSub[\"sub-border-color\"]&&a.send(\"mpv-set-prop\",[\"sub-border-color\",mystremioLastSub[\"sub-border-color\"]]),"
    "/*" + REPLAY_MARKER + "*/"
)

OLD_LOAD_SPEED = 'a.send("mpv-set-prop",["speed",s.speed]),s.aid&&'
NEW_LOAD_SPEED = 'a.send("mpv-set-prop",["speed",s.speed]),' + REPLAY + "s.aid&&"

OLD_SID = (
    'case"selectedSubtitlesTrackId":null!==O&&(t?(i=t.slice(9),'
    'a.send("mpv-set-prop",["sid",i]),A.emit("subtitlesTrackLoaded",t)):'
    '(a.send("mpv-set-prop",["sid","no"]),s.sid=null)),D("selectedSubtitlesTrackId");'
)
NEW_SID = (
    'case"selectedSubtitlesTrackId":null!==O&&(t?(i=t.slice(9),'
    'a.send("mpv-set-prop",["sid",i]),' + REPLAY + 'A.emit("subtitlesTrackLoaded",t)):'
    '(a.send("mpv-set-prop",["sid","no"]),s.sid=null)),D("selectedSubtitlesTrackId");'
)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label} needle count={count} (expected 1)")
    return text.replace(old, new, 1)


def patch_main(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if REPLAY_MARKER in text and "mystremioLastSub" in text and NEW_OVERRIDE in text:
        print(f"Subtitle loadfile replay patch already present in {path}")
        return False

    if NEW_OVERRIDE not in text:
        if OLD_OVERRIDE_SCALE in text:
            text = replace_once(text, OLD_OVERRIDE_SCALE, NEW_OVERRIDE, "sub-ass-override scale")
        else:
            text = replace_once(text, OLD_OVERRIDE_NO, NEW_OVERRIDE, "sub-ass-override no")

    if "mystremioLastSub={}" not in text:
        text = replace_once(text, OLD_LASTSUB_INIT, NEW_LASTSUB_INIT, "last-sub init")

    if "mystremioLastSub.scale=t*r" not in text:
        text = replace_once(text, OLD_SETPROP, NEW_SETPROP, "subtitle setProp cache")

    if REPLAY_MARKER not in text or OLD_LOAD_SPEED in text:
        if OLD_LOAD_SPEED in text:
            text = replace_once(text, OLD_LOAD_SPEED, NEW_LOAD_SPEED, "loadfile subtitle replay")

    if OLD_SID in text:
        text = replace_once(text, OLD_SID, NEW_SID, "sid subtitle replay")

    if REPLAY_MARKER not in text or "mystremioLastSub.scale=t*r" not in text:
        raise RuntimeError("subtitle replay patch did not land completely")

    path.write_text(text, encoding="utf-8")
    print(f"Patched ShellVideo subtitle replay on load/sid in {path}")
    return True


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: patch-webui-sub-ass-scale.py <main.js>", file=sys.stderr)
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
