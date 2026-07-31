#!/usr/bin/env python3
"""
Patch bundled stremio-web main.js for MyStremio board row chevrons:
CatalogsWithExtra LoadNextPage + growing MetaRow preview reveal slice.
"""

from __future__ import annotations

import sys
from pathlib import Path


LOAD_RANGE_NEEDLE = (
    'a=i.useCallback(function(t){e.transport.dispatch({action:"CatalogsWithExtra",'
    'args:{action:"LoadRange",args:t}},"board")},[]);'
    'return[E({model:"board",action:t}),a]'
)

# Minimal hook (v1) already shipped in some builds — upgrade in place.
HOOK_V1 = (
    'i.useEffect(function(){window.__mystremioBoardLoadNextPage=function(n){'
    'e.transport.dispatch({action:"CatalogsWithExtra",args:{action:"LoadNextPage",args:n}},"board")};'
    'return function(){try{delete window.__mystremioBoardLoadNextPage}catch(_){}}},[e]);'
)

# Sync row filter without Continue Watching exclusion (v2).
SYNC_ROWS_FILTER_V2 = (
    'var rows=[].slice.call(board.querySelectorAll(\'[class*="meta-row-container"]\')).filter(function(r){'
    'return String(r.className||"").indexOf("placeholder")<0;'
    '});'
)

# Sync row filter excluding Continue Watching + placeholders (v3).
SYNC_ROWS_FILTER_V3 = (
    'var rows=[].slice.call(board.querySelectorAll(\'[class*="meta-row-container"]\')).filter(function(r){'
    'var cn=String(r.className||"");'
    'return cn.indexOf("placeholder")<0&&cn.indexOf("continue-watching-row")<0;'
    '});'
)

# Expanded hook: LoadNextPage + resolve catalog index + stamp data attributes.
HOOK_V2 = (
    'i.useEffect(function(){'
    'function mystremioCatalogLabel(c){'
    'if(!c)return"";'
    'var labels=[];'
    'if(typeof c.name==="string")labels.push(c.name);'
    'if(c.addon&&c.addon.manifest&&typeof c.addon.manifest.name==="string")labels.push(c.addon.manifest.name);'
    'if(c.request&&c.request.path){'
    'if(typeof c.request.path.id==="string")labels.push(c.request.path.id);'
    'if(typeof c.request.path.name==="string")labels.push(c.request.path.name);'
    '}'
    'if(Array.isArray(c)&&c[0]&&c[0].request&&c[0].request.path){'
    'if(typeof c[0].request.path.id==="string")labels.push(c[0].request.path.id);'
    'if(typeof c[0].request.path.name==="string")labels.push(c[0].request.path.name);'
    '}'
    'return labels;'
    '}'
    'function mystremioIsEmptyCatalog(c){'
    'return !!(c&&c.content&&c.content.type==="Err"&&c.content.content==="EmptyContent");'
    '}'
    'function mystremioIsRenderedMetaRow(c){'
    'if(!c||mystremioIsEmptyCatalog(c))return false;'
    'var t=c.content&&c.content.type;'
    'return t==="Ready"||t==="Err";'
    '}'
    'window.__mystremioBoardRequestRender=function(){'
    'mystremioBumpReveal(function(x){return x+1})'
    '};'
    'window.__mystremioBoardLoadNextPage=function(n){'
    'e.transport.dispatch({action:"CatalogsWithExtra",args:{action:"LoadNextPage",args:n}},"board")'
    '};'
    'window.__mystremioBoardResolveCatalogIndex=function(title){'
    'return e.transport.getState("board").then(function(state){'
    'var catalogs=state&&state.catalogs||[];'
    'var needle=String(title||"").trim().toLowerCase();'
    'if(!needle)return -1;'
    'var i,labels,j,label;'
    'for(i=0;i<catalogs.length;i++){'
    'if(mystremioIsEmptyCatalog(catalogs[i]))continue;'
    'labels=mystremioCatalogLabel(catalogs[i]);'
    'for(j=0;j<labels.length;j++){'
    'label=String(labels[j]||"").trim().toLowerCase();'
    'if(!label)continue;'
    'if(label===needle||needle.indexOf(label)>=0||label.indexOf(needle)>=0)return i;'
    '}'
    '}'
    'return -1;'
    '})'
    '};'
    'window.__mystremioBoardSyncCatalogIndices=function(){'
    'return e.transport.getState("board").then(function(state){'
    'var catalogs=state&&state.catalogs||[];'
    'var board=document.querySelector(\'[class*="board-container"]\');'
    'if(!board)return;'
    'var rows=[].slice.call(board.querySelectorAll(\'[class*="meta-row-container"]\')).filter(function(r){'
    'var cn=String(r.className||"");'
    'return cn.indexOf("placeholder")<0&&cn.indexOf("continue-watching-row")<0;'
    '});'
    'var rowIdx=0,i,row;'
    'for(i=0;i<catalogs.length;i++){'
    'if(!mystremioIsRenderedMetaRow(catalogs[i]))continue;'
    'row=rows[rowIdx++];'
    'if(row)row.setAttribute("data-mystremio-catalog-index",String(i));'
    '}'
    '})'
    '};'
    'return function(){'
    'try{delete window.__mystremioBoardLoadNextPage}catch(_){}'
    'try{delete window.__mystremioBoardResolveCatalogIndex}catch(_){}'
    'try{delete window.__mystremioBoardSyncCatalogIndices}catch(_){}'
    'try{delete window.__mystremioBoardRequestRender}catch(_){}'
    '}'
    '},[e,mystremioBumpReveal]);'
)

LOAD_RANGE_REPLACEMENT = (
    'a=i.useCallback(function(t){e.transport.dispatch({action:"CatalogsWithExtra",'
    'args:{action:"LoadRange",args:t}},"board")},[]);'
    'var mystremioRevealState=i.useState(0),mystremioBumpReveal=mystremioRevealState[1];'
    + HOOK_V2
    + 'return[E({model:"board",action:t}),a]'
)

# Prior shipped hook without RequestRender / useState — upgrade in place.
HOOK_V2_LEGACY_PREFIX = (
    'a=i.useCallback(function(t){e.transport.dispatch({action:"CatalogsWithExtra",'
    'args:{action:"LoadRange",args:t}},"board")},[]);'
    'i.useEffect(function(){'
    'function mystremioCatalogLabel'
)
HOOK_V2_LEGACY_CLEANUP = (
    'return function(){'
    'try{delete window.__mystremioBoardLoadNextPage}catch(_){}'
    'try{delete window.__mystremioBoardResolveCatalogIndex}catch(_){}'
    'try{delete window.__mystremioBoardSyncCatalogIndices}catch(_){}'
    '}'
    '},[e]);'
)

# Ensure HOOK_V2 / LOAD_RANGE_REPLACEMENT are single strings (not tuples).
assert isinstance(HOOK_V2, str)
assert isinstance(LOAD_RANGE_REPLACEMENT, str)

# Stock preview slice → growing reveal driven by window.__mystremioBoardReveal[index].
SLICE_NEEDLE = ".slice(0,I.CATALOG_PREVIEW_SIZE)"
SLICE_REPLACEMENT = (
    ".slice(0,(window.__mystremioBoardReveal&&window.__mystremioBoardReveal"
    "[mystremioCatalogIndex])||I.CATALOG_PREVIEW_SIZE)"
)
# When a previous build removed the slice entirely, re-insert the reveal form.
SLICE_REMOVED_NEEDLE = (
    'meta-items-container"]},_.isValidElementType(n)?N.map(function(e,t){'
    "return r.createElement(n,E(E({},e)"
)
SLICE_REMOVED_REPLACEMENT = (
    'meta-items-container"]},_.isValidElementType(n)?N.slice(0,(window.__mystremioBoardReveal'
    "&&window.__mystremioBoardReveal[mystremioCatalogIndex])||10).map(function(e,t){"
    "return r.createElement(n,E(E({},e)"
)
REVEAL_SLICE_MARKER = (
    "window.__mystremioBoardReveal&&window.__mystremioBoardReveal[mystremioCatalogIndex]"
)

PLACEHOLDER_NEEDLE = "Array(Math.max(0,I.CATALOG_PREVIEW_SIZE-N.length))"
PLACEHOLDER_REPLACEMENT = "Array(Math.max(0,N.length?0:8))"

# Board Ready MetaRow — stamp Core catalog index.
BOARD_READY_NEEDLE = (
    'case"Ready":return E.createElement(c,{key:a,className:n(D["board-row"],'
    'D["board-row-".concat(t.content.content[0].posterShape)],"animation-fade-in"),'
    'catalog:t,itemComponent:R});'
)
BOARD_READY_REPLACEMENT = (
    'case"Ready":return E.createElement(c,{key:a,className:n(D["board-row"],'
    'D["board-row-".concat(t.content.content[0].posterShape)],"animation-fade-in"),'
    'catalog:t,itemComponent:R,mystremioCatalogIndex:a});'
)

BOARD_ERR_NEEDLE = (
    'case"Err":return"EmptyContent"!==t.content.content?E.createElement(c,{key:a,'
    'className:n(D["board-row"],"animation-fade-in"),catalog:t,message:t.content.content}):null;'
)
BOARD_ERR_REPLACEMENT = (
    'case"Err":return"EmptyContent"!==t.content.content?E.createElement(c,{key:a,'
    'className:n(D["board-row"],"animation-fade-in"),catalog:t,message:t.content.content,'
    'mystremioCatalogIndex:a}):null;'
)

# MetaRow props + root data attribute for Core catalog index.
METAROW_PROPS_NEEDLE = (
    'd=function(e){var t=e.className,a=e.title,i=e.catalog,o=e.message,n=e.itemComponent,'
    'T=e.notifications,u=A(),'
)
METAROW_PROPS_REPLACEMENT = (
    'd=function(e){var t=e.className,a=e.title,i=e.catalog,o=e.message,n=e.itemComponent,'
    'T=e.notifications,mystremioCatalogIndex=e.mystremioCatalogIndex,u=A(),'
)

METAROW_ROOT_NEEDLE = 'return r.createElement("div",{className:S(t,O["meta-row-container"])},'
METAROW_ROOT_REPLACEMENT = (
    'return r.createElement("div",{className:S(t,O["meta-row-container"]),'
    '"data-mystremio-catalog-index":"number"==typeof mystremioCatalogIndex?'
    'String(mystremioCatalogIndex):void 0},'
)


def patch_file(path: Path) -> int:
    text = path.read_text(encoding="utf-8", errors="strict")
    original = text
    changed = 0

    if "window.__mystremioBoardSyncCatalogIndices" in text:
        print(f"Board catalog index sync hook already present in {path}")
    elif HOOK_V1 in text:
        text = text.replace(HOOK_V1, HOOK_V2, 1)
        changed += 1
        print(f"Upgraded Board LoadNextPage hook to v2 in {path}")
    elif LOAD_RANGE_NEEDLE in text:
        text = text.replace(LOAD_RANGE_NEEDLE, LOAD_RANGE_REPLACEMENT, 1)
        changed += 1
        print(f"Patched Board LoadNextPage hook (v2) in {path}")
    elif "window.__mystremioBoardLoadNextPage" in text:
        print(
            f"WARNING: Board LoadNextPage present but v2 upgrade needle not found in {path}",
            file=sys.stderr,
        )
    else:
        print(f"WARNING: Board LoadRange needle not found in {path}", file=sys.stderr)

    if SYNC_ROWS_FILTER_V2 in text:
        text = text.replace(SYNC_ROWS_FILTER_V2, SYNC_ROWS_FILTER_V3, 1)
        changed += 1
        print(f"Upgraded SyncCatalogIndices to exclude Continue Watching in {path}")
    elif SYNC_ROWS_FILTER_V3 in text:
        print(f"SyncCatalogIndices Continue Watching filter already present in {path}")
    elif "window.__mystremioBoardSyncCatalogIndices" in text:
        print(
            f"WARNING: SyncCatalogIndices present but row filter needle not found in {path}",
            file=sys.stderr,
        )

    if REVEAL_SLICE_MARKER in text:
        print(f"MetaRow reveal slice already present in {path}")
    elif SLICE_NEEDLE in text:
        text = text.replace(SLICE_NEEDLE, SLICE_REPLACEMENT, 1)
        changed += 1
        print(f"Patched MetaRow preview slice to growing reveal in {path}")
    elif SLICE_REMOVED_NEEDLE in text:
        text = text.replace(SLICE_REMOVED_NEEDLE, SLICE_REMOVED_REPLACEMENT, 1)
        changed += 1
        print(f"Re-inserted MetaRow reveal slice in {path}")
    else:
        print(f"WARNING: MetaRow slice needle not found in {path}", file=sys.stderr)

    if "window.__mystremioBoardRequestRender" in text and "mystremioBumpReveal" in text:
        print(f"Board RequestRender hook already present in {path}")
    elif HOOK_V2_LEGACY_PREFIX in text:
        text = text.replace(
            HOOK_V2_LEGACY_PREFIX,
            (
                'a=i.useCallback(function(t){e.transport.dispatch({action:"CatalogsWithExtra",'
                'args:{action:"LoadRange",args:t}},"board")},[]);'
                "var mystremioRevealState=i.useState(0),mystremioBumpReveal=mystremioRevealState[1];"
                "i.useEffect(function(){"
                "window.__mystremioBoardRequestRender=function(){"
                "mystremioBumpReveal(function(x){return x+1})"
                "};"
                "function mystremioCatalogLabel"
            ),
            1,
        )
        changed += 1
        print(f"Upgraded Board hook with RequestRender useState in {path}")
        if HOOK_V2_LEGACY_CLEANUP in text:
            text = text.replace(
                HOOK_V2_LEGACY_CLEANUP,
                (
                    "return function(){"
                    "try{delete window.__mystremioBoardLoadNextPage}catch(_){}"
                    "try{delete window.__mystremioBoardResolveCatalogIndex}catch(_){}"
                    "try{delete window.__mystremioBoardSyncCatalogIndices}catch(_){}"
                    "try{delete window.__mystremioBoardRequestRender}catch(_){}"
                    "}"
                    "},[e,mystremioBumpReveal]);"
                ),
                1,
            )
            changed += 1
            print(f"Updated Board hook cleanup/deps for RequestRender in {path}")

    if PLACEHOLDER_NEEDLE in text:
        text = text.replace(PLACEHOLDER_NEEDLE, PLACEHOLDER_REPLACEMENT, 1)
        changed += 1
        print(f"Patched MetaRow placeholders in {path}")
    elif PLACEHOLDER_REPLACEMENT in text:
        print(f"MetaRow placeholders already patched in {path}")
    else:
        print(f"WARNING: MetaRow placeholder needle not found in {path}", file=sys.stderr)

    if BOARD_READY_NEEDLE in text:
        text = text.replace(BOARD_READY_NEEDLE, BOARD_READY_REPLACEMENT, 1)
        changed += 1
        print(f"Stamped mystremioCatalogIndex on Board Ready MetaRow in {path}")
    elif "mystremioCatalogIndex:a" in text and 'case"Ready"' in text:
        print(f"Board Ready mystremioCatalogIndex already present in {path}")
    else:
        print(f"WARNING: Board Ready MetaRow needle not found in {path}", file=sys.stderr)

    if BOARD_ERR_NEEDLE in text:
        text = text.replace(BOARD_ERR_NEEDLE, BOARD_ERR_REPLACEMENT, 1)
        changed += 1
        print(f"Stamped mystremioCatalogIndex on Board Err MetaRow in {path}")
    elif 'message:t.content.content,mystremioCatalogIndex:a' in text:
        print(f"Board Err mystremioCatalogIndex already present in {path}")
    else:
        print(f"WARNING: Board Err MetaRow needle not found in {path}", file=sys.stderr)

    if METAROW_PROPS_NEEDLE in text:
        text = text.replace(METAROW_PROPS_NEEDLE, METAROW_PROPS_REPLACEMENT, 1)
        changed += 1
        print(f"Patched MetaRow props for mystremioCatalogIndex in {path}")
    elif "mystremioCatalogIndex=e.mystremioCatalogIndex" in text:
        print(f"MetaRow mystremioCatalogIndex prop already present in {path}")
    else:
        print(f"WARNING: MetaRow props needle not found in {path}", file=sys.stderr)

    if METAROW_ROOT_NEEDLE in text:
        text = text.replace(METAROW_ROOT_NEEDLE, METAROW_ROOT_REPLACEMENT, 1)
        changed += 1
        print(f"Patched MetaRow root data-mystremio-catalog-index in {path}")
    elif '"data-mystremio-catalog-index":"number"==typeof mystremioCatalogIndex' in text:
        print(f"MetaRow root catalog index attribute already present in {path}")
    else:
        print(f"WARNING: MetaRow root needle not found in {path}", file=sys.stderr)

    if text != original:
        path.write_text(text, encoding="utf-8", newline="")
    return 0 if changed or (
        text == original
        and "window.__mystremioBoardSyncCatalogIndices" in text
        and "mystremioCatalogIndex:a" in text
        and SYNC_ROWS_FILTER_V3 in text
    ) else 1


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("Usage: fix-webui-board-catalog-pages.py <main.js>", file=sys.stderr)
        return 2
    path = Path(argv[1])
    if not path.is_file():
        print(f"File not found: {path}", file=sys.stderr)
        return 2
    return patch_file(path)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
