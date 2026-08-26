#!/usr/bin/env python3
"""
Prepend a /meta/-only fetch filter to bundled stremio-web worker.js so
unselected metadata addons (especially Cinemeta) cannot paint first Ready.
Catalog and stream requests are left alone.
"""

from __future__ import annotations

import sys
from pathlib import Path

MARKER = "__mystremioMetadataMetaGateWorker"

PRELUDE = r"""/* mystremio-metadata-meta-gate-worker */
(function () {
  if (self.__mystremioMetadataMetaGateWorker) return;
  self.__mystremioMetadataMetaGateWorker = true;
  var CHANNEL = "mystremio-metadata-meta-gate";
  var explicit = false;
  var allowCinemeta = true;
  var transports = [];
  var synced = false;

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

  function isManifest(url) {
    return /\/manifest\.json(?:\?|$|#)/i.test(String(url || ""));
  }

  function isMeta(url) {
    return /\/metas?\//i.test(String(url || "")) && !isManifest(url);
  }

  function isCinemeta(url) {
    return /cinemeta\.strem\.io/i.test(String(url || ""));
  }

  function isKitsu(url) {
    return /kitsu/i.test(String(url || ""));
  }

  function matchesAllowed(url) {
    var target = String(url || "");
    for (var i = 0; i < transports.length; i++) {
      var base = transports[i];
      if (!base) continue;
      if (target === base) return true;
      if (target.indexOf(base + "/") === 0) return true;
    }
    return false;
  }

  function shouldBlock(url) {
    if (!isMeta(url)) return false;
    if (isKitsu(url)) return false;
    if (!synced) return isCinemeta(url);
    if (!explicit) return false;
    if (isCinemeta(url)) {
      if (allowCinemeta) return false;
      if (transports.length === 0) return false;
      return true;
    }
    if (matchesAllowed(url)) return false;
    return true;
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
      if (shouldBlock(url)) {
        return Promise.resolve(new Response('{"error":"mystremio-meta-gated"}', {
          status: 404,
          headers: { "Content-Type": "application/json" }
        }));
      }
      return originalFetch(input, init);
    };
  }

  try {
    var ch = new BroadcastChannel(CHANNEL);
    var syncAttempts = 0;
    ch.onmessage = function (ev) {
      var data = (ev && ev.data) || {};
      if (data.type === "sync") {
        explicit = Boolean(data.explicit);
        transports = [];
        var list = Array.isArray(data.transports) ? data.transports : [];
        for (var i = 0; i < list.length; i++) {
          var b = normalizeBase(list[i]);
          if (b) transports.push(b);
        }
        allowCinemeta = data.allowCinemeta !== false;
        if (explicit && transports.length === 0) allowCinemeta = true;
        synced = true;
      }
    };
    function requestSync() {
      try {
        ch.postMessage({ type: "request-sync" });
      } catch (_) {}
    }
    requestSync();
    var syncTimer = setInterval(function () {
      syncAttempts += 1;
      if (synced) {
        clearInterval(syncTimer);
        return;
      }
      if (syncAttempts > 20) {
        clearInterval(syncTimer);
        synced = true;
        explicit = false;
        return;
      }
      requestSync();
    }, 250);
  } catch (_) {}
})();
"""


def patch_worker(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    start = text.find("/* mystremio-metadata-meta-gate-worker */")
    if start >= 0:
        rest_at = text.find("/* mystremio-addon-soft-disable-worker */", start + 10)
        if rest_at < 0:
            rest_at = text.find("(()=>{", start + 10)
        if rest_at > start:
            next_text = PRELUDE.rstrip() + "\n" + text[rest_at:]
            if next_text != text:
                path.write_text(next_text, encoding="utf-8")
                print(f"Updated metadata meta-gate worker prelude in {path}")
                return True
        print(f"Metadata meta-gate worker patch already present in {path}")
        return False
    path.write_text(PRELUDE + "\n" + text, encoding="utf-8")
    print(f"Patched metadata meta-gate fetch filter into {path}")
    return True


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: patch-webui-metadata-meta-gate-worker.py <worker.js|webui-dir>", file=sys.stderr)
        return 2
    target = Path(sys.argv[1])
    if target.is_dir():
        workers = list(target.rglob("scripts/worker.js"))
        if not workers:
            print(f"No scripts/worker.js under {target}", file=sys.stderr)
            return 1
        for worker in workers:
            patch_worker(worker)
        return 0
    if not target.is_file():
        print(f"Missing worker.js: {target}", file=sys.stderr)
        return 1
    patch_worker(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
