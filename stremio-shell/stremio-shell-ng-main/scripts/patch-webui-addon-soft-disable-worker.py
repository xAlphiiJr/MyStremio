#!/usr/bin/env python3
"""
Prepend a fetch filter to bundled stremio-web worker.js so soft-disabled
addon catalog/stream/meta requests are blocked where core actually fetches.
"""

from __future__ import annotations

import sys
from pathlib import Path

MARKER = "__mystremioAddonSoftDisableWorker"

PRELUDE = r"""/* mystremio-addon-soft-disable-worker */
(function () {
  if (self.__mystremioAddonSoftDisableWorker) return;
  self.__mystremioAddonSoftDisableWorker = true;
  var CHANNEL = "mystremio-disabled-addons";
  var bases = [];

  function normalizeBase(url) {
    var raw = String(url || "").trim();
    if (!raw) return "";
    try {
      var u = new URL(raw, self.location && self.location.href);
      u.hash = "";
      u.search = "";
      var path = u.pathname.replace(/\/manifest\.json$/i, "");
      if (!path) path = "/";
      u.pathname = path.replace(/\/+$/, "") || "/";
      var href = u.href;
      if (href.endsWith("/") && u.pathname !== "/") href = href.replace(/\/+$/, "");
      return href;
    } catch (_) {
      return raw.replace(/\/manifest\.json(?:\?.*)?$/i, "").replace(/\/+$/, "");
    }
  }

  function matchesDisabled(href) {
    var target = String(href || "");
    if (!target) return false;
    for (var i = 0; i < bases.length; i++) {
      var base = bases[i];
      if (!base) continue;
      if (target === base) return true;
      if (target.indexOf(base + "/") === 0) return true;
    }
    return false;
  }

  function shouldBlock(url) {
    try {
      var u = new URL(String(url || ""), self.location && self.location.href);
      if (/\/manifest\.json$/i.test(u.pathname)) return false;
      if (!matchesDisabled(u.href)) return false;
      return /\/(catalog|stream|meta|subtitle|subtitles|addon_catalog)\//i.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  function emptyResponse() {
    return new Response(
      JSON.stringify({ metas: [], streams: [], meta: null, subtitles: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  if (typeof self.fetch === "function") {
    var originalFetch = self.fetch.bind(self);
    self.fetch = function (input, init) {
      var url =
        typeof input === "string"
          ? input
          : input && typeof input === "object" && "url" in input
            ? String(input.url)
            : String(input || "");
      if (shouldBlock(url)) return Promise.resolve(emptyResponse());
      return originalFetch(input, init);
    };
  }

  try {
    var ch = new BroadcastChannel(CHANNEL);
    var synced = false;
    var syncAttempts = 0;
    ch.onmessage = function (ev) {
      var data = (ev && ev.data) || {};
      if (data.type === "sync" && Array.isArray(data.urls)) {
        bases = [];
        for (var i = 0; i < data.urls.length; i++) {
          var b = normalizeBase(data.urls[i]);
          if (b) bases.push(b);
        }
        synced = true;
      }
    };
    function requestSync() {
      try {
        ch.postMessage({ type: "request-sync" });
      } catch (_) {}
    }
    requestSync();
    // Retry briefly so early core fetches see the disabled list after main hydrates.
    var syncTimer = setInterval(function () {
      syncAttempts += 1;
      if (synced || syncAttempts > 20) {
        clearInterval(syncTimer);
        return;
      }
      requestSync();
    }, 250);
  } catch (_) {}
})();
"""


def patch_worker(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"Addon soft-disable worker patch already present in {path}")
        return False
    path.write_text(PRELUDE + "\n" + text, encoding="utf-8")
    print(f"Patched addon soft-disable fetch filter into {path}")
    return True


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: patch-webui-addon-soft-disable-worker.py <worker.js|webui-dir>", file=sys.stderr)
        return 2
    target = Path(sys.argv[1])
    if target.is_dir():
        workers = list(target.rglob("scripts/worker.js"))
        if not workers:
            print(f"No scripts/worker.js under {target}", file=sys.stderr)
            return 1
        changed = False
        for worker in workers:
            changed = patch_worker(worker) or changed
        return 0
    if not target.is_file():
        print(f"Missing worker.js: {target}", file=sys.stderr)
        return 1
    patch_worker(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
