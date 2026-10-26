#!/usr/bin/env python3
"""Point Watch Now at Quick Play and add the two Quick Settings rows."""

from __future__ import annotations

import sys
from pathlib import Path

MARKER = "__mystremioQuickPlay"


def replace_once(text: str, label: str, old: str, new: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label} needle count={count} (expected 1)")
    return text.replace(old, new, 1)


def patch_main(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if MARKER in text and "Quick Play resolution" in text:
        print(f"Quick Play patch already present in {path}")
        return False

    text = replace_once(
        text,
        "resolve call",
        "msHeroResolvePlayer(title,cancelled,function(info)",
        "(window.StremioCustomQuickPlay&&window.StremioCustomQuickPlay.resolve||msHeroResolvePlayer)(title,cancelled,function(info)/*"
        + MARKER
        + "*/",
    )
    text = replace_once(
        text,
        "result handler",
        'msSetInfo(result?{label:result.reasons.length?"No stream with the selected settings, playing the closest":result.addon?"Playing via "+result.addon:"Starting playback",file:result.file,criteria:result.criteria,reasons:result.reasons.length?result.reasons:["Matches all your preferences"]}:{label:"No playable stream found, opening details"});setTimeout(function(){if(msStop.current)return;if(!result){if(cancelled())return;msSetWatch(null);return h(title)}',
        'if(!result||result.miss||!result.hash){msSetInfo({label:(result&&result.label)||"No stream with the selected settings is available",criteria:result&&result.criteria,reasons:(result&&result.reasons)||[]});setTimeout(function(){cancelled()||msSetWatch(null)},(result&&result.hold)||4e3);return}msSetInfo({label:result.label||(result.addon?"Playing via "+result.addon:"Starting playback"),file:result.file,criteria:result.criteria,reasons:result.reasons&&result.reasons.length?result.reasons:["Matches all your preferences"]});setTimeout(function(){if(msStop.current||cancelled())return;',
    )
    text = replace_once(
        text,
        "hold",
        "window.location.hash=result.hash},result?result.hold:1500)",
        "window.location.hash=result.hash},result.hold||600)",
    )
    text = replace_once(
        text,
        "quick play state",
        "h=(0,s.useState)({intro:!1,credits:!1,recap:!1}),f=h[0],B=h[1],",
        "h=(0,s.useState)({intro:!1,credits:!1,recap:!1}),f=h[0],B=h[1],"
        'qpRs=(0,s.useState)(function(){return window.StremioCustomQuickPlay?window.StremioCustomQuickPlay.readIds("resolution"):["1080p"]}),qpRes=qpRs[0],qpSetRes=qpRs[1],'
        'qpQs=(0,s.useState)(function(){return window.StremioCustomQuickPlay?window.StremioCustomQuickPlay.readIds("quality"):[]}),qpQual=qpQs[0],qpSetQual=qpQs[1],',
    )
    rows = (
        's.default.createElement(A.Option,{label:"Quick Play resolution"},s.default.createElement(O.default,{items:(window.StremioCustomQuickPlay?window.StremioCustomQuickPlay.RESOLUTIONS:[]).map(function(e){return{id:e.id,label:e.label,checked:qpRes.indexOf(e.id)>=0}}),emptyLabel:"Any",onToggle:function(e,t){qpSetRes(function(a){var n=t?a.indexOf(e)<0?a.concat([e]):a:a.filter(function(i){return i!==e});window.StremioCustomQuickPlay&&window.StremioCustomQuickPlay.writeIds("resolution",n);return n})}})),'
        's.default.createElement(A.Option,{label:"Quick Play quality"},s.default.createElement(O.default,{items:(window.StremioCustomQuickPlay?window.StremioCustomQuickPlay.QUALITIES:[]).map(function(e){return{id:e.id,label:e.label,checked:qpQual.indexOf(e.id)>=0}}),emptyLabel:"Any",onToggle:function(e,t){qpSetQual(function(a){var n=t?a.indexOf(e)<0?a.concat([e]):a:a.filter(function(i){return i!==e});window.StremioCustomQuickPlay&&window.StremioCustomQuickPlay.writeIds("quality",n);return n})}})),'
    )
    text = replace_once(
        text,
        "quick play rows",
        's.default.createElement(A.Option,{label:"Autoskip"}',
        rows + 's.default.createElement(A.Option,{label:"Autoskip"}',
    )
    path.write_text(text, encoding="utf-8")
    print(f"Patched Quick Play into {path}")
    return True


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: patch-webui-quick-play.py <main.js>", file=sys.stderr)
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
