(function () {
  'use strict';

  /**
   * Soft-disable Stremio addons without uninstalling.
   * Persists transport bases and filters page + worker fetches.
   * Toggles live in the own addon manager, not on stock cards.
   */
  if (window.self !== window.top) return;
  if (window.__stremioCustomAddonSoftDisable) return;
  window.__stremioCustomAddonSoftDisable = true;

  const LS_KEY = 'stremio-custom-disabled-addon-urls';
  const CHANNEL_NAME = 'mystremio-disabled-addons';
  const TOGGLE_CLASS = 'mystremio-addon-soft-toggle';
  const ROW_DISABLED_CLASS = 'mystremio-addon-soft-disabled';

  let injectTimer = null;
  /** @type {BroadcastChannel|null} */
  let channel = null;
  /** @type {string[]|null} */
  let cachedDisabled = null;

  function normalizeTransportBase(url) {
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

  function normalizeList(urls) {
    return [
      ...new Set(
        (Array.isArray(urls) ? urls : [])
          .map((u) => normalizeTransportBase(u))
          .filter(Boolean)
      ),
    ];
  }

  function loadDisabled() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const next = normalizeList(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(next)) {
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(next));
        } catch (_) {}
      }
      return next;
    } catch (_) {
      return [];
    }
  }

  function readDisabled() {
    if (cachedDisabled) return cachedDisabled;
    cachedDisabled = loadDisabled();
    return cachedDisabled;
  }

  function broadcastDisabled(urls) {
    try {
      if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage({ type: 'sync', urls: normalizeList(urls) });
    } catch (_) {}
  }

  function writeDisabled(urls) {
    const next = normalizeList(urls);
    cachedDisabled = next;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next));
    } catch (_) {}
    broadcastDisabled(next);
    try {
      window.StremioCustom?.helpers?.persistUserPreferences?.();
    } catch (_) {}
    try {
      document.dispatchEvent(
        new CustomEvent('stremio-custom-disabled-addons-changed', { detail: { urls: next } })
      );
    } catch (_) {}
    return next;
  }

  function isDisabledUrl(url) {
    const target = normalizeTransportBase(url) || String(url || '').trim();
    if (!target) return false;
    return readDisabled().some((base) => target === base || target.startsWith(base + '/'));
  }

  function setDisabled(url, disabled) {
    const base = normalizeTransportBase(url);
    if (!base) return readDisabled();
    const set = new Set(readDisabled());
    if (disabled) set.add(base);
    else set.delete(base);
    return writeDisabled([...set]);
  }

  function matchesDisabledTransport(href) {
    const target = String(href || '');
    if (!target) return false;
    return readDisabled().some((base) => {
      if (!base) return false;
      return target === base || target.startsWith(base + '/');
    });
  }

  function shouldBlockRequest(url) {
    try {
      const u = new URL(String(url || ''), location.href);
      return matchesDisabledTransport(u.href);
    } catch (_) {
      return matchesDisabledTransport(String(url || ''));
    }
  }

  function isManifestRequest(url) {
    return /\/manifest\.json(?:\?|$|#)/i.test(String(url || ''));
  }

  function isAddonResourceRequest(url) {
    return /\/(?:stream|catalog|meta|subtitle)s?\//i.test(String(url || ''));
  }

  function emptyAddonResourceBody(url) {
    const target = String(url || '');
    if (/\/(?:stream)s?\//i.test(target)) return '{"streams":[]}';
    if (/\/(?:catalog)s?\//i.test(target)) return '{"metas":[]}';
    if (/\/(?:meta)s?\//i.test(target)) return '{"meta":null}';
    if (/\/(?:subtitle)s?\//i.test(target)) return '{"subtitles":[]}';
    return '{}';
  }

  function emptyAddonResourceResponse(url) {
    return Promise.resolve(
      new Response(emptyAddonResourceBody(url), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }

  function rejectDisabledFetch() {
    return Promise.reject(new TypeError('Failed to fetch'));
  }

  function handleDisabledRequest(url) {
    if (isAddonResourceRequest(url) && !isManifestRequest(url)) {
      return emptyAddonResourceResponse(url);
    }
    return rejectDisabledFetch();
  }

  function installNetworkFilter() {
    if (window.__mystremioAddonFetchFiltered) return;
    window.__mystremioAddonFetchFiltered = true;

    const originalFetch = window.fetch?.bind(window);
    if (typeof originalFetch === 'function') {
      window.fetch = function (input, init) {
        const url =
          typeof input === 'string'
            ? input
            : input && typeof input === 'object' && 'url' in input
              ? String(input.url)
              : String(input || '');
        if (shouldBlockRequest(url)) {
          return handleDisabledRequest(url);
        }
        return originalFetch(input, init);
      };
    }

    const XHR = window.XMLHttpRequest;
    if (!XHR || XHR.__mystremioAddonPatched) return;
    const proto = XHR.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    proto.open = function (method, url, ...rest) {
      this.__mystremioAddonUrl = String(url || '');
      return originalOpen.call(this, method, url, ...rest);
    };
    proto.send = function (...args) {
      if (shouldBlockRequest(this.__mystremioAddonUrl)) {
        const url = this.__mystremioAddonUrl;
        const self = this;
        if (isAddonResourceRequest(url) && !isManifestRequest(url)) {
          const body = emptyAddonResourceBody(url);
          Object.defineProperty(this, 'readyState', { configurable: true, get: () => 4 });
          Object.defineProperty(this, 'status', { configurable: true, get: () => 200 });
          Object.defineProperty(this, 'responseText', { configurable: true, get: () => body });
          Object.defineProperty(this, 'response', { configurable: true, get: () => body });
          queueMicrotask(() => {
            self.dispatchEvent(new Event('readystatechange'));
            self.dispatchEvent(new Event('load'));
            self.dispatchEvent(new Event('loadend'));
          });
          return;
        }
        Object.defineProperty(this, 'readyState', { configurable: true, get: () => 4 });
        Object.defineProperty(this, 'status', { configurable: true, get: () => 0 });
        queueMicrotask(() => {
          self.dispatchEvent(new Event('error'));
          self.dispatchEvent(new Event('loadend'));
        });
        return;
      }
      return originalSend.apply(this, args);
    };
    XHR.__mystremioAddonPatched = true;
  }

  function installBroadcastBridge() {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (ev) => {
        const data = ev?.data || {};
        if (data.type === 'request-sync') {
          broadcastDisabled(readDisabled());
        }
      };
      broadcastDisabled(readDisabled());
    } catch (_) {}
  }

  function stripAllToggles() {
    document.querySelectorAll(`.${TOGGLE_CLASS}`).forEach((el) => {
      if (el.closest('#mystremio-addon-manager')) return;
      el.remove();
    });
    document.querySelectorAll(`.${ROW_DISABLED_CLASS}`).forEach((el) => {
      if (el.closest('#mystremio-addon-manager')) return;
      el.classList.remove(ROW_DISABLED_CLASS);
    });
  }

  function scheduleInject() {
    if (injectTimer) clearTimeout(injectTimer);
    injectTimer = setTimeout(() => {
      injectTimer = null;
      stripAllToggles();
    }, 80);
  }

  window.__stremioCustomAddonSoftDisableEnsure = scheduleInject;
  window.StremioCustomAddonSoftDisable = {
    getDisabledAddonUrls: readDisabled,
    setDisabledAddonUrl: setDisabled,
    isDisabledUrl,
    normalizeTransportBase,
    scheduleInject,
    broadcastDisabled: () => broadcastDisabled(readDisabled()),
  };

  installNetworkFilter();
  installBroadcastBridge();
  window.addEventListener('hashchange', scheduleInject);
  window.addEventListener('popstate', scheduleInject);
  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    broadcastDisabled(readDisabled());
    scheduleInject();
  });
  document.addEventListener('stremio-custom-disabled-addons-changed', () => {
    cachedDisabled = null;
    broadcastDisabled(readDisabled());
    stripAllToggles();
  });

  broadcastDisabled(readDisabled());
  scheduleInject();

  console.info('[StremioCustom] Addon soft-disable ready.');
})();
