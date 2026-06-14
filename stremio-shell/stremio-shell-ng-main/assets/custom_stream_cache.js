(function () {
  'use strict';

  if (window.__stremioCustomStreamCache) return;
  window.__stremioCustomStreamCache = true;

  const SERVER_BASE = 'http://127.0.0.1:11470';
  const INFO_HASH_RE = /^[0-9a-f]{40}$/i;
  const POLL_MS = 1000;

  let serverBase = SERVER_BASE;
  let serverBaseResolved = false;
  let streamContext = null;
  let cachedRatio = 0;
  let pollTimer = null;
  let fetchHooked = false;
  let discoverInFlight = null;

  function isOnPlayerPage() {
    return /#\/player/.test(location.href);
  }

  function isStreamingServerUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /:1147\d(?:\/|$|\?)/.test(url) || url.startsWith(serverBase) || url.startsWith(SERVER_BASE);
  }

  function parseStreamingUrl(url) {
    if (!isStreamingServerUrl(url)) return null;

    try {
      const parsed = new URL(url, location.href);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] === 'proxy') parts.shift();
      if (!parts.length || !INFO_HASH_RE.test(parts[0])) return null;

      const infoHash = parts[0].toLowerCase();
      if (parts.length < 2) return { infoHash, fileIndex: 0 };

      const rawIndex = parts[1];
      const numericIndex = Number(rawIndex);
      if (Number.isInteger(numericIndex) && numericIndex >= 0) {
        return { infoHash, fileIndex: numericIndex };
      }

      return {
        infoHash,
        fileIndex: null,
        fileName: decodeURIComponent(rawIndex),
      };
    } catch {
      return null;
    }
  }

  function contextsEqual(a, b) {
    if (!a || !b) return false;
    if (a.infoHash !== b.infoHash) return false;
    if (a.fileIndex != null && b.fileIndex != null) return a.fileIndex === b.fileIndex;
    if (a.fileName && b.fileName) return a.fileName === b.fileName;
    return a.fileIndex === b.fileIndex;
  }

  async function resolveServerBase() {
    if (serverBaseResolved) return serverBase;
    const candidates = [
      SERVER_BASE,
      'http://127.0.0.1:11471',
      'http://127.0.0.1:11472',
      'http://127.0.0.1:11473',
    ];
    for (const base of candidates) {
      try {
        const response = await fetch(`${base}/heartbeat`, { cache: 'no-store' });
        if (response.ok) {
          serverBase = base;
          serverBaseResolved = true;
          return serverBase;
        }
      } catch (_) {}
    }
    serverBaseResolved = true;
    return serverBase;
  }

  async function clearStreamCache() {
    const base = await resolveServerBase();
    let originalCacheSize = 2147483648;
    let scheduledDiskCleanup = false;

    try {
      const settingsRes = await fetch(`${base}/settings`, { cache: 'no-store' });
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        originalCacheSize = settingsData?.values?.cacheSize ?? originalCacheSize;
        if (settingsData?.baseUrl) serverBase = settingsData.baseUrl;
      }
    } catch (_) {}

    try {
      await fetch(`${base}/removeAll`, { cache: 'no-store' });
    } catch (_) {}

    try {
      await fetch(`${base}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cacheSize: 1 }),
      });
      scheduledDiskCleanup = true;
      window.setTimeout(async () => {
        try {
          await fetch(`${base}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cacheSize: originalCacheSize }),
          });
        } catch (_) {}
      }, 11000);
    } catch (_) {}

    streamContext = null;
    cachedRatio = 0;
    document.dispatchEvent(new CustomEvent('stremio-custom-cache-cleared'));
    return { scheduledDiskCleanup };
  }

  function setStreamContext(nextContext) {
    if (!nextContext?.infoHash) return;
    const changed = !contextsEqual(streamContext, nextContext);
    streamContext = nextContext;
    if (changed) {
      cachedRatio = 0;
      refreshProgress();
    }
  }

  function setStreamPath(path) {
    const ctx = parseStreamingUrl(path);
    if (ctx) setStreamContext(ctx);
  }

  function trySetStreamFromUrl(url) {
    const ctx = parseStreamingUrl(url);
    if (ctx) setStreamContext(ctx);
  }

  async function resolveFileIndex(infoHash, fileIndex, fileName) {
    if (Number.isInteger(fileIndex) && fileIndex >= 0) return fileIndex;
    if (!fileName) return 0;

    try {
      const response = await fetch(`${serverBase}/${infoHash}/stats.json`, { cache: 'no-store' });
      if (!response.ok) return 0;
      const stats = await response.json();
      const files = Array.isArray(stats?.files) ? stats.files : [];
      const idx = files.findIndex((file) => file?.name === fileName);
      return idx >= 0 ? idx : 0;
    } catch {
      return 0;
    }
  }

  async function discoverActiveStreamContext() {
    if (discoverInFlight) return discoverInFlight;

    discoverInFlight = (async () => {
      try {
        await resolveServerBase();
        const response = await fetch(`${serverBase}/stats.json`, { cache: 'no-store' });
        if (!response.ok) return null;

        const all = await response.json();
        let best = null;
        let bestScore = -1;

        for (const [infoHash, engineStats] of Object.entries(all || {})) {
          if (!INFO_HASH_RE.test(infoHash) || !Array.isArray(engineStats?.files)) continue;

          for (let idx = 0; idx < engineStats.files.length; idx += 1) {
            const fileRes = await fetch(`${serverBase}/${infoHash}/${idx}/stats.json`, { cache: 'no-store' });
            if (!fileRes.ok) continue;

            const fileStats = await fileRes.json();
            const progress = Number(fileStats?.streamProgress);
            if (!Number.isFinite(progress)) continue;

            const speed = Number(engineStats.downloadSpeed) || 0;
            const score = progress + (speed > 0 ? 0.001 : 0);
            if (score > bestScore) {
              bestScore = score;
              best = { infoHash: infoHash.toLowerCase(), fileIndex: idx };
            }
          }
        }

        return best;
      } catch {
        return null;
      } finally {
        discoverInFlight = null;
      }
    })();

    return discoverInFlight;
  }

  async function fetchStreamProgress() {
    if (!streamContext?.infoHash) return 0;

    const fileIndex = await resolveFileIndex(
      streamContext.infoHash,
      streamContext.fileIndex,
      streamContext.fileName
    );
    streamContext.fileIndex = fileIndex;

    const statsUrl = `${serverBase}/${streamContext.infoHash}/${fileIndex}/stats.json`;

    try {
      const response = await fetch(statsUrl, { cache: 'no-store' });
      if (!response.ok) return cachedRatio;

      const stats = await response.json();
      const progress = Number(stats?.streamProgress);
      if (!Number.isFinite(progress)) return cachedRatio;

      return Math.max(0, Math.min(1, progress));
    } catch {
      return cachedRatio;
    }
  }

  async function refreshProgress() {
    if (!isOnPlayerPage()) {
      cachedRatio = 0;
      return;
    }

    if (!streamContext?.infoHash) {
      const discovered = await discoverActiveStreamContext();
      if (discovered) setStreamContext(discovered);
    }

    cachedRatio = await fetchStreamProgress();
  }

  function startPolling() {
    if (pollTimer) return;
    refreshProgress();
    pollTimer = window.setInterval(refreshProgress, POLL_MS);
  }

  function stopPolling() {
    if (!pollTimer) return;
    window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function resetState() {
    stopPolling();
    streamContext = null;
    cachedRatio = 0;
  }

  function hookFetch() {
    if (fetchHooked || typeof window.fetch !== 'function') return;
    fetchHooked = true;

    const nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (url) trySetStreamFromUrl(url);
      } catch (_) {}

      return nativeFetch(input, init);
    };
  }

  function hookShellPathUpdates() {
    const handlePayload = (payload) => {
      const change = Array.isArray(payload?.args) && payload.args[0] === 'mpv-prop-change' ? payload.args[1] : null;
      if (change?.name === 'path' && typeof change.data === 'string') {
        setStreamPath(change.data);
      }
    };

    if (window.chrome?.webview && !window.chrome.webview.__stremioCustomStreamCacheHooked) {
      window.chrome.webview.__stremioCustomStreamCacheHooked = true;
      window.chrome.webview.addEventListener('message', (ev) => {
        try {
          const raw = ev?.data;
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          handlePayload(data);
        } catch (_) {}
      });
    }

    const transport = window.qt?.webChannelTransport;
    if (!transport || transport.__stremioCustomStreamCacheHooked) return;
    transport.__stremioCustomStreamCacheHooked = true;
    const original = transport.onmessage;
    transport.onmessage = function (ev) {
      try {
        const raw = ev?.data;
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        handlePayload(data);
      } catch (_) {}
      if (typeof original === 'function') original.call(this, ev);
    };
  }

  function ensureActive() {
    hookFetch();
    hookShellPathUpdates();
    if (!isOnPlayerPage()) {
      resetState();
      return;
    }
    startPolling();
  }

  window.StremioCustomStreamCache = {
    getCachedRatio: () => cachedRatio,
    setStreamPath,
    trySetStreamFromUrl,
    refreshProgress,
    getStreamContext: () => (streamContext ? { ...streamContext } : null),
    clearStreamCache,
    getServerBase: () => serverBase,
  };

  window.addEventListener('hashchange', () => {
    setTimeout(ensureActive, 200);
  });

  hookFetch();
  resolveServerBase().catch(() => {});
  ensureActive();
  console.info('[StremioCustom] Server stream cache indicator ready.');
})();
