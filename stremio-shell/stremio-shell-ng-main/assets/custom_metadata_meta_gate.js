/**
 * When the user picked explicit metadata sources, block /meta/ fetches
 * from every other addon (especially Cinemeta). Catalogs and streams stay.
 */
(function () {
  'use strict';

  if (window.self !== window.top) return;
  if (window.__stremioCustomMetadataMetaGate) return;
  window.__stremioCustomMetadataMetaGate = true;

  const LS_KEY = 'stremio-custom-metadata-addon';
  const CHANNEL_NAME = 'mystremio-metadata-meta-gate';

  /** @type {BroadcastChannel|null} */
  let channel = null;
  /** @type {{ explicit: boolean, allowCinemeta: boolean, transports: string[] }|null} */
  let cachedSelection = null;

  function normalizeTransportBase(url) {
    const helper = window.StremioCustomAddonSoftDisable?.normalizeTransportBase;
    if (typeof helper === 'function') return helper(url) || '';
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
      const u = new URL(raw, location.href);
      u.hash = '';
      u.search = '';
      let path = u.pathname.replace(/\/manifest\.json$/i, '');
      if (!path) path = '/';
      u.pathname = path.replace(/\/+$/, '') || '/';
      let href = u.href;
      if (href.endsWith('/') && u.pathname !== '/') href = href.replace(/\/+$/, '');
      return href;
    } catch (_) {
      return raw.replace(/\/manifest\.json(?:\?.*)?$/i, '').replace(/\/+$/, '');
    }
  }

  function parseMetadataAddonList(raw) {
    const text = String(raw || '').trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return parsed
            .map((item) => String(item ?? '').trim())
            .filter((item, index, list) => list.indexOf(item) === index);
        }
      } catch (_) {}
    }
    return [text];
  }

  function loadSelection() {
    let raw = '';
    try {
      raw = window.StremioCustom?.helpers?.getMetadataAddon?.() || localStorage.getItem(LS_KEY) || '';
    } catch (_) {
      raw = '';
    }
    const values = parseMetadataAddonList(raw);
    return {
      explicit: Boolean(String(raw || '').trim()),
      allowCinemeta: !values.length || values.some((item) => item === ''),
      transports: values
        .filter(Boolean)
        .map((item) => normalizeTransportBase(item))
        .filter(Boolean),
    };
  }

  function readSelection() {
    if (cachedSelection) return cachedSelection;
    cachedSelection = loadSelection();
    return cachedSelection;
  }

  function invalidateSelection() {
    cachedSelection = null;
  }

  function isCinemetaUrl(url) {
    return /cinemeta\.strem\.io/i.test(String(url || ''));
  }

  function isKitsuUrl(url) {
    return /kitsu/i.test(String(url || ''));
  }

  function isManifestRequest(url) {
    return /\/manifest\.json(?:\?|$|#)/i.test(String(url || ''));
  }

  function isMetaRequest(url) {
    return /\/metas?\//i.test(String(url || '')) && !isManifestRequest(url);
  }

  function matchesAllowedTransport(url, transports) {
    const target = String(url || '');
    return transports.some((base) => {
      if (!base) return false;
      return target === base || target.startsWith(`${base}/`);
    });
  }

  const CINEMETA_META_BASE = 'https://v3-cinemeta.strem.io';

  function normalizeMetaType(type) {
    const kind = String(type || '').trim().toLowerCase();
    if (kind === 'tv' || kind === 'show' || kind === 'anime') return 'series';
    if (kind === 'film') return 'movie';
    return kind || 'movie';
  }

  /**
   * Addon `/meta/{type}/{id}.json` URLs in chip order.
   * Cinemeta is included only when it is allowed (not explicit, or chip selected).
   * @param {string} type
   * @param {string} id
   * @returns {string[]}
   */
  function metaRequestUrls(type, id) {
    const kind = normalizeMetaType(type);
    const rawId = String(id || '').trim();
    if (!rawId) return [];
    const selection = readSelection();
    const urls = [];
    const seen = new Set();
    const pushBase = (base) => {
      const normalized = normalizeTransportBase(base);
      if (!normalized) return;
      const url = `${normalized}/meta/${kind}/${encodeURIComponent(rawId)}.json`;
      if (seen.has(url)) return;
      seen.add(url);
      urls.push(url);
    };
    for (const transport of selection.transports) {
      pushBase(transport);
    }
    if (!selection.explicit || selection.allowCinemeta) {
      pushBase(CINEMETA_META_BASE);
    }
    return urls;
  }

  function shouldBlockMeta(url) {
    const selection = readSelection();
    if (!selection.explicit) return false;
    if (!isMetaRequest(url)) return false;
    if (isKitsuUrl(url)) return false;
    if (isCinemetaUrl(url)) {
      if (selection.allowCinemeta) return false;
      if (selection.explicit && selection.transports.length === 0) return false;
      return true;
    }
    if (matchesAllowedTransport(url, selection.transports)) return false;
    return true;
  }

  function blockedMetaResponse() {
    return Promise.resolve(
      new Response('{"error":"mystremio-meta-gated"}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }

  function snapshot() {
    invalidateSelection();
    const selection = readSelection();
    return {
      type: 'sync',
      explicit: selection.explicit,
      allowCinemeta: selection.allowCinemeta,
      transports: selection.transports,
    };
  }

  function broadcastSelection() {
    const payload = snapshot();
    try {
      if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage(payload);
    } catch (_) {}
    return payload;
  }

  function installNetworkFilter() {
    if (window.__mystremioMetadataMetaFetchFiltered) return;
    window.__mystremioMetadataMetaFetchFiltered = true;

    const originalFetch = window.fetch?.bind(window);
    if (typeof originalFetch === 'function') {
      window.fetch = function (input, init) {
        const url =
          typeof input === 'string'
            ? input
            : input && typeof input === 'object' && 'url' in input
              ? String(input.url)
              : String(input || '');
        if (shouldBlockMeta(url)) return blockedMetaResponse();
        return originalFetch(input, init);
      };
    }

    const XHR = window.XMLHttpRequest;
    if (!XHR || XHR.__mystremioMetadataMetaPatched) return;
    const proto = XHR.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    proto.open = function (method, url, ...rest) {
      this.__mystremioMetadataMetaUrl = String(url || '');
      return originalOpen.call(this, method, url, ...rest);
    };
    proto.send = function (...args) {
      if (shouldBlockMeta(this.__mystremioMetadataMetaUrl)) {
        const self = this;
        const body = '{"error":"mystremio-meta-gated"}';
        Object.defineProperty(this, 'readyState', { configurable: true, get: () => 4 });
        Object.defineProperty(this, 'status', { configurable: true, get: () => 404 });
        Object.defineProperty(this, 'responseText', { configurable: true, get: () => body });
        Object.defineProperty(this, 'response', { configurable: true, get: () => body });
        queueMicrotask(() => {
          self.dispatchEvent(new Event('readystatechange'));
          self.dispatchEvent(new Event('load'));
          self.dispatchEvent(new Event('loadend'));
        });
        return;
      }
      return originalSend.apply(this, args);
    };
    XHR.__mystremioMetadataMetaPatched = true;
  }

  function installBroadcastBridge() {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (ev) => {
        const data = ev?.data || {};
        if (data.type === 'request-sync') broadcastSelection();
      };
      broadcastSelection();
    } catch (_) {}
  }

  window.__stremioCustomMetadataMetaGateEnsure = broadcastSelection;
  window.StremioCustomMetadataMetaGate = {
    shouldBlockMeta,
    broadcastSelection,
    metaRequestUrls,
  };

  installNetworkFilter();
  installBroadcastBridge();
  document.addEventListener('stremio-custom-metadata-addon-changed', () => {
    invalidateSelection();
    broadcastSelection();
  });
  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    invalidateSelection();
    broadcastSelection();
  });
  broadcastSelection();
})();
