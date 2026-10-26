#!/usr/bin/env python3
"""Pick the profile audio language over a remembered track id.

Stremio restores streamState.audioTrack first, so a file whose default
track is English stays on English. ger/deu/de also failed the exact compare.
"""

from __future__ import annotations

import sys
from pathlib import Path

MARKER = "__mystremioAudioLang"

OLD = (
    'i=null!=a?a:(o=Ue.state.audioTracks,E=ge.audioLanguage,o.find(function(e){var t;return e.lang===E||(null===(t=d.where("1",e.lang))||void 0===t?void 0:t[2])===E}));i&&i.id&&(Ue.setAudioTrack(i.id),Yt.current=!0)}var o,E}'
)
NEW = (
    'o=Ue.state.audioTracks,E=ge.audioLanguage,c=function(n){n=String(n||"").toLowerCase().split("-")[0];return{ger:"de",deu:"de",de:"de",eng:"en",en:"en",fra:"fr",fre:"fr",fr:"fr",jpn:"ja",ja:"ja",spa:"es",es:"es",ita:"it",it:"it",por:"pt",pt:"pt",rus:"ru",ru:"ru",kor:"ko",ko:"ko",zho:"zh",chi:"zh",zh:"zh",ara:"ar",ar:"ar",nld:"nl",dut:"nl",nl:"nl",pol:"pl",pl:"pl",tur:"tr",tr:"tr",ces:"cs",cze:"cs",cs:"cs"}[n]||n},n=E&&o&&o.find(function(e){var t;return c(e.lang)===c(E)||e.lang===E||(null===(t=d.where("1",e.lang))||void 0===t?void 0:t[2])===E}),i=n||a;i&&i.id&&(Ue.setAudioTrack(i.id),Yt.current=!0)}/*'
    + MARKER
    + '*/var o,E,c,n}'
)


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: patch-webui-audio-lang.py <main.js>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"Audio language patch already present in {path}")
        return 0
    count = text.count(OLD)
    if count != 1:
        print(f"audio language needle count={count} (expected 1)", file=sys.stderr)
        return 1
    path.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    print(f"Patched default audio language selection in {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
