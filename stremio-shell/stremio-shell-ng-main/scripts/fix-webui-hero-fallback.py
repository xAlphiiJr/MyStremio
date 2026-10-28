#!/usr/bin/env python3
"""Patch bundled React hero: no Breaking Bad flash before catalog titles load."""

from __future__ import annotations

import re
import sys
from pathlib import Path


PATCHES: list[tuple[str, str]] = [
    (
        "function T(){var e=(0,_.loadCachedTitles)();return(null==e?void 0:e.length)?e:[i({},r.FALLBACK_TITLES[0])]}",
        "function T(){var e=(0,_.loadCachedTitles)();return(null==e?void 0:e.length)?e:[]}",
    ),
    (
        "var U=null!==(a=null!==(t=I[O])&&void 0!==t?t:I[0])&&void 0!==a?a:r.FALLBACK_TITLES[0]",
        "var U=null!==(a=null!==(t=I[O])&&void 0!==t?t:I[0])&&void 0!==a?a:null",
    ),
    (
        "case 0:return t=(0,_.loadCachedTitles)(),a=null!==(o=null==t?void 0:t.length)&&void 0!==o?o:0,e.next=2,Promise.resolve(a>0?t:[i({},r.FALLBACK_TITLES[0])]);",
        "case 0:return t=(0,_.loadCachedTitles)(),a=null!==(o=null==t?void 0:t.length)&&void 0!==o?o:0,e.next=2,Promise.resolve(a>0?t:[]);",
    ),
    (
        ',h=(0,_.useCallback)(function(e){(0,S.navigateToTitle)(e.id,e.type)},[]),f=(P=[(p=r).year],p.duration&&"Unknown"!==p.duration&&P.push(p.duration),p.seasons&&"Unknown"!==p.seasons&&P.push(p.seasons),P);return',
        ',h=(0,_.useCallback)(function(e){(0,S.navigateToTitle)(e.id,e.type)},[]);if(!r)return _.default.createElement("div",{ref:m,key:D,className:A.default["hero-row"]},_.default.createElement("div",{className:(0,T.default)("mystremio-hero-slot",A.default["hero-slot"]),"data-state":"loading"},_.default.createElement("div",{className:(0,T.default)("mystremio-hero-slot-loader",A.default["hero-slot-loader"]),"aria-hidden":!0},_.default.createElement("div",{className:(0,T.default)("mystremio-hero-slot-spinner",A.default["hero-slot-spinner"])}))));var f=(P=[r.year],r.duration&&"Unknown"!==r.duration&&P.push(r.duration),r.seasons&&"Unknown"!==r.seasons&&P.push(r.seasons),P);return',
    ),
    (
        "preloadHeroImages=function(e){var t=function(e){return new Promise(function(t){if(e){var a=new Image",
        "preloadHeroImages=function(e){if(!e)return Promise.resolve({background:!1,logo:!1});var t=function(e){return new Promise(function(t){if(e){var a=new Image",
    ),
    (
        "B.current.length<=1&&A(r.FALLBACK_TITLES.map(function(e){return i({},e)}))",
        "B.current.length<=1&&A([])",
    ),
    (
        "case 4:return A(r.FALLBACK_TITLES.map(function(e){return i({},e)})),[4,H()];",
        "case 4:return A([]),[4,H()];",
    ),
    (
        "G=(0,n.useCallback)(function(e){e.forEach(function(e){(0,_.preloadHeroImages)(e)})},[])",
        "G=(0,n.useCallback)(function(e){var t=e&&e[0]?e[0]:e;(0,_.preloadHeroImages)(t)},[])",
    ),
    (
        "case 0:return t=(0,_.loadCachedTitles)(),a=null!==(o=null==t?void 0:t[0])&&void 0!==o?o:null,[4,(0,_.preloadHeroImages)(a)];case 1:return E.sent(),e?[2]:(c(!0),(null==t?void 0:t.length)?(A(t),G(t),(0,_.shouldRefreshCachedTitles)()?[4,H()]:[3,3]):[3,4]);",
        "case 0:return t=(0,_.loadCachedTitles)(),c(!0),(null==t?void 0:t.length)?(A(t),(0,_.preloadHeroImages)(t[0]),(0,_.shouldRefreshCachedTitles)()?[4,H()]:[2]):(A([]),[4,H()]);case 1:return E.sent(),e?[2]:[2];",
    ),
    (
        '"data-state":I?"ready":"loading"',
        '"data-state":I&&window.__mystremioFirstPosterReady?"ready":"loading"',
    ),
    (
        '!I&&_.default.createElement("div",{className:(0,T.default)("mystremio-hero-slot-loader"',
        '!(I&&window.__mystremioFirstPosterReady)&&_.default.createElement("div",{className:(0,T.default)("mystremio-hero-slot-loader"',
    ),
]

REGEX_PATCHES: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"\[i\(\{\},[^.]+\.FALLBACK_TITLES\[0\]\)\]"),
        "[]",
    ),
    (
        re.compile(
            r"Promise\.resolve\(a>0\?t:\[i\(\{\},[^.]+\.FALLBACK_TITLES\[0\]\)\]\)"
        ),
        "Promise.resolve(a>0?t:[])",
    ),
    (
        re.compile(r"(\?[^:]+:)r\.FALLBACK_TITLES\[0\](?=[,\]\)])"),
        r"\1null",
    ),
    (
        re.compile(
            r"A\([^)]+\.FALLBACK_TITLES\.map\(function\(e\)\{return i\(\{\},e\)\}\)\)"
        ),
        "A([])",
    ),
]


def patch_main_js(path: Path) -> None:
    text = path.read_text(encoding="utf-8", errors="replace")
    original = text

    for old, new in PATCHES:
        if old in text:
            text = text.replace(old, new)

    for pattern, replacement in REGEX_PATCHES:
        text = pattern.sub(replacement, text)

    if text == original:
        if (
            "FALLBACK_TITLES[0]" not in text
            and "if(!e)return Promise.resolve({background:!1,logo:!1})" in text
            and "window.__mystremioFirstPosterReady" in text
            and "e.forEach(function(e){(0,_.preloadHeroImages)(e)})" not in text
        ):
            print(f"Hero fallback patch already applied in {path}")
            return
        print(
            f"Warning: hero fallback patterns not found in {path}; "
            "bundle may use a different hero module layout"
        )
        return

    path.write_text(text, encoding="utf-8")
    print(f"Patched hero fallback loading behavior in {path}")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"Usage: {sys.argv[0]} <path-to-main.js>")
    patch_main_js(Path(sys.argv[1]))


if __name__ == "__main__":
    main()
