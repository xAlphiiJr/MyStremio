(function () {
  'use strict';

  if (window.__stremioCustomDeepLink) return;
  window.__stremioCustomDeepLink = true;

  const STREMIO_PROTOCOL = 'stremio://';

  function decodeRepeatedly(value, maxPasses) {
    let current = String(value || '');
    for (let i = 0; i < maxPasses; i += 1) {
      try {
        const next = decodeURIComponent(current);
        if (next === current) break;
        current = next;
      } catch (_) {
        break;
      }
    }
    return current;
  }

  function toAddonInstallHash(url) {
    const trimmed = String(url || '').trim();
    if (!trimmed) return null;

    if (trimmed.startsWith(STREMIO_PROTOCOL)) {
      const rest = trimmed.slice(STREMIO_PROTOCOL.length);
      if (!rest) return '#/addons';

      if (rest.startsWith('/')) {
        const route = rest.replace(/^\/+/, '');
        if (route.startsWith('addons')) {
          return `#/${route}`;
        }
        return `#/${route}`;
      }

      const manifestUrl = decodeRepeatedly(`https://${rest}`, 3);
      if (/^https?:\/\//i.test(manifestUrl)) {
        return `#/addons?addon=${encodeURIComponent(manifestUrl)}`;
      }
    }

    if (/^https?:\/\//i.test(trimmed) && /manifest\.json/i.test(trimmed)) {
      return `#/addons?addon=${encodeURIComponent(trimmed)}`;
    }

    return null;
  }

  function navigateFromDeepLink(url) {
    const hash = toAddonInstallHash(url);
    if (!hash) return false;

    const current = location.hash || '';
    if (current === hash) {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return true;
    }

    location.hash = hash;
    console.info('[StremioCustom] Deep link navigation:', hash);
    return true;
  }

  function parseOpenMediaPayload(raw) {
    if (raw == null) return null;
    try {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!data) return null;

      if (Array.isArray(data) && data[0] === 'open-media' && data[1]) {
        return String(data[1]);
      }
      if (Array.isArray(data.args) && data.args[0] === 'open-media' && data.args[1]) {
        return String(data.args[1]);
      }
      if (data.type === 1 && Array.isArray(data.args) && data.args[0] === 'open-media' && data.args[1]) {
        return String(data.args[1]);
      }
    } catch (_) {}
    return null;
  }

  function hookShellIncoming() {
    if (window.__stremioCustomDeepLinkShellHook) return;
    window.__stremioCustomDeepLinkShellHook = true;

    const handlePayload = (raw) => {
      const url = parseOpenMediaPayload(raw);
      if (!url) return;
      navigateFromDeepLink(url);
    };

    window.chrome?.webview?.addEventListener?.('message', (ev) => {
      handlePayload(ev?.data);
    });

    const transport = window.qt?.webChannelTransport;
    if (!transport || transport.__stremioCustomDeepLinkOnMessageHooked) return;
    transport.__stremioCustomDeepLinkOnMessageHooked = true;
    const original = transport.onmessage;
    transport.onmessage = function (ev) {
      try {
        handlePayload(ev?.data);
      } catch (_) {}
      if (typeof original === 'function') original.call(this, ev);
    };
  }

  function hookLaunchArguments() {
    try {
      const params = new URLSearchParams(location.search);
      const streamingServer = params.get('streamingServer');
      if (streamingServer) return;

      const hashAddon = /[?&]addon=([^&]+)/.exec(location.hash || '');
      if (hashAddon?.[1]) return;
    } catch (_) {}
  }

  hookShellIncoming();
  hookLaunchArguments();

  window.StremioCustomDeepLink = {
    navigateFromDeepLink,
    toAddonInstallHash,
  };

  console.info('[StremioCustom] Deep link handler ready.');
})();
