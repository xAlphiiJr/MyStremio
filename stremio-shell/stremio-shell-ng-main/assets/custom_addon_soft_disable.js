(function () {
  'use strict';

  /**
   * Soft-disable Stremio addons without uninstalling.
   * Persists transport bases, glass switches on #/addons, filters page + worker fetches.
   */
  if (window.self !== window.top) return;
  if (window.__stremioCustomAddonSoftDisable) return;
  window.__stremioCustomAddonSoftDisable = true;

  const LS_KEY = 'stremio-custom-disabled-addon-urls';
  const CHANNEL_NAME = 'mystremio-disabled-addons';
  const STYLE_ID = 'stremio-custom-addon-soft-disable-style';
  const TOGGLE_CLASS = 'mystremio-addon-soft-toggle';
  const ROW_DISABLED_CLASS = 'mystremio-addon-soft-disabled';

  let injectTimer = null;
  let retryTimer = null;
  /** @type {BroadcastChannel|null} */
  let channel = null;
  /** @type {Map<string, object>|null} */
  let addonCache = null;

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

  function readDisabled() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const next = normalizeList(parsed);
      // Migrate legacy manifest URLs → bases once.
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

  function broadcastDisabled(urls) {
    try {
      if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage({ type: 'sync', urls: normalizeList(urls) });
    } catch (_) {}
  }

  function writeDisabled(urls) {
    const next = normalizeList(urls);
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

  function isResourcePath(pathname) {
    return /\/(catalog|stream|meta|subtitle|subtitles|addon_catalog)\//i.test(pathname || '');
  }

  function shouldBlockRequest(url) {
    try {
      const u = new URL(String(url || ''), location.href);
      if (/\/manifest\.json$/i.test(u.pathname)) return false;
      if (!matchesDisabledTransport(u.href)) return false;
      return isResourcePath(u.pathname);
    } catch (_) {
      return false;
    }
  }

  function emptyResourceResponse() {
    return new Response(
      JSON.stringify({ metas: [], streams: [], meta: null, subtitles: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
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
          return Promise.resolve(emptyResourceResponse());
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
        const body = JSON.stringify({ metas: [], streams: [], meta: null, subtitles: [] });
        Object.defineProperty(this, 'readyState', { configurable: true, get: () => 4 });
        Object.defineProperty(this, 'status', { configurable: true, get: () => 200 });
        Object.defineProperty(this, 'responseText', { configurable: true, get: () => body });
        Object.defineProperty(this, 'response', { configurable: true, get: () => body });
        const self = this;
        queueMicrotask(() => {
          self.dispatchEvent(new Event('readystatechange'));
          self.dispatchEvent(new Event('load'));
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

  async function loadAddonIndex() {
    try {
      const core = window.core || window.services?.core?.transport;
      if (!core?.getState) return null;
      const ctx = await core.getState('ctx');
      const addons = ctx?.profile?.addons || ctx?.addons || [];
      const map = new Map();
      for (const addon of addons) {
        const transportUrl =
          addon?.transportUrl || addon?.transport_url || addon?.manifestUrl || '';
        const name = addon?.manifest?.name || addon?.name || '';
        const base = normalizeTransportBase(transportUrl);
        if (!base) continue;
        const entry = { transportUrl: base, name: String(name) };
        map.set(base, entry);
        if (name) map.set(String(name).toLowerCase(), entry);
      }
      addonCache = map;
      return map;
    } catch (_) {
      return null;
    }
  }

  function getReactFiber(el) {
    if (!(el instanceof Element)) return null;
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        return el[key];
      }
    }
    return null;
  }

  function resolveFromFiber(row) {
    let fiber = getReactFiber(row);
    let depth = 0;
    while (fiber && depth < 50) {
      const props = fiber.memoizedProps || fiber.pendingProps || {};
      const addon = props?.dataset?.addon || props?.addon;
      const transportUrl =
        addon?.transportUrl || addon?.transport_url || addon?.manifestUrl || '';
      if (transportUrl) {
        return {
          transportUrl: normalizeTransportBase(transportUrl),
          name: String(addon?.manifest?.name || addon?.name || ''),
        };
      }
      fiber = fiber.return;
      depth += 1;
    }
    // Also probe nested children that may own the fiber.
    const child = row.querySelector?.('[class*="addon-container"], [class*="info-container"]');
    if (child && child !== row) {
      fiber = getReactFiber(child);
      depth = 0;
      while (fiber && depth < 50) {
        const props = fiber.memoizedProps || fiber.pendingProps || {};
        const addon = props?.dataset?.addon || props?.addon;
        const transportUrl =
          addon?.transportUrl || addon?.transport_url || addon?.manifestUrl || '';
        if (transportUrl) {
          return {
            transportUrl: normalizeTransportBase(transportUrl),
            name: String(addon?.manifest?.name || addon?.name || ''),
          };
        }
        fiber = fiber.return;
        depth += 1;
      }
    }
    return null;
  }

  function isPlaceholderRow(row) {
    const cn = String(row?.className || '');
    if (/placeholder/i.test(cn)) return true;
    const nameEl =
      row.querySelector('[class*="name-container"]') ||
      row.querySelector('[class*="addon-name"]');
    return !(nameEl?.textContent || '').trim();
  }

  function resolveRowTransport(row) {
    if (!(row instanceof Element) || isPlaceholderRow(row)) return null;

    const fromFiber = resolveFromFiber(row);
    if (fromFiber?.transportUrl) return fromFiber;

    const nameEl =
      row.querySelector('[class*="name-container"]') ||
      row.querySelector('[class*="addon-name"]');
    const name = (nameEl?.textContent || '').trim().toLowerCase();
    if (addonCache && name && addonCache.has(name)) {
      return addonCache.get(name);
    }
    if (addonCache && name) {
      for (const value of addonCache.values()) {
        if (value.name && value.name.toLowerCase() === name) return value;
      }
    }

    const link = row.querySelector('a[href*="manifest.json"]');
    const href = link?.getAttribute('href') || '';
    if (href) {
      const base = normalizeTransportBase(href);
      if (base) return { transportUrl: base, name };
    }
    return null;
  }

  function ensureStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = `
      .${TOGGLE_CLASS} {
        --mystremio-soft-switch-track: rgba(70, 70, 70, 0.22);
        --mystremio-soft-switch-on: rgba(61, 220, 132, 0.45);
        position: relative;
        display: inline-flex;
        align-items: center;
        flex: 0 0 auto;
        width: 2.75rem;
        height: 1.55rem;
        margin-left: 0.4rem;
        padding: 0;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: var(--mystremio-soft-switch-track);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
        backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
        -webkit-backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
        cursor: pointer;
        vertical-align: middle;
        transition: background 0.18s ease, border-color 0.18s ease;
      }
      .${TOGGLE_CLASS}:hover {
        background: rgba(90, 90, 90, 0.3);
        border-color: rgba(255, 255, 255, 0.18);
      }
      .${TOGGLE_CLASS}[aria-checked="true"] {
        background: var(--mystremio-soft-switch-on);
        border-color: rgba(61, 220, 132, 0.35);
      }
      .${TOGGLE_CLASS}[aria-checked="true"]:hover {
        background: rgba(61, 220, 132, 0.55);
      }
      .${TOGGLE_CLASS} .mystremio-addon-soft-knob {
        position: absolute;
        top: 50%;
        left: 0.18rem;
        width: 1.15rem;
        height: 1.15rem;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        transform: translateY(-50%);
        transition: transform 0.18s ease;
        pointer-events: none;
      }
      .${TOGGLE_CLASS}[aria-checked="true"] .mystremio-addon-soft-knob {
        transform: translate(1.1rem, -50%);
      }
      [class*="addon-container"].${ROW_DISABLED_CLASS},
      [class*="addon-"].${ROW_DISABLED_CLASS} {
        opacity: 0.55;
      }
    `;
  }

  function isAddonsPage() {
    return /#\/addons(?:[/?#]|$)/.test(location.hash || '');
  }

  function findActionButtons(row) {
    return (
      row.querySelector('[class*="action-buttons-container"]') ||
      row.querySelector('[class*="buttons-container"]') ||
      null
    );
  }

  function paintToggle(toggle, row, transportUrl) {
    const disabled = isDisabledUrl(transportUrl);
    toggle.setAttribute('aria-checked', disabled ? 'false' : 'true');
    toggle.setAttribute('aria-pressed', disabled ? 'false' : 'true');
    toggle.title = disabled
      ? 'Enable addon (stays installed)'
      : 'Disable addon without uninstalling';
    toggle.dataset.transportUrl = transportUrl;
    row.classList.toggle(ROW_DISABLED_CLASS, disabled);
  }

  function injectRowToggle(row) {
    if (!(row instanceof Element) || isPlaceholderRow(row)) return;

    const actions = findActionButtons(row);
    if (!actions) return;

    const existing = row.querySelector(`.${TOGGLE_CLASS}`);
    const storedUrl = existing?.dataset?.transportUrl || '';
    const info = storedUrl
      ? { transportUrl: normalizeTransportBase(storedUrl) }
      : resolveRowTransport(row);
    if (!info?.transportUrl) return;

    let toggle = existing;
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = TOGGLE_CLASS;
      toggle.setAttribute('role', 'switch');
      toggle.innerHTML = '<span class="mystremio-addon-soft-knob" aria-hidden="true"></span>';
      toggle.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const url = normalizeTransportBase(toggle.dataset.transportUrl || info.transportUrl);
        const nextDisabled = toggle.getAttribute('aria-checked') !== 'false';
        setDisabled(url, nextDisabled);
        paintToggle(toggle, row, url);
      });
      actions.appendChild(toggle);
    } else if (!actions.contains(toggle)) {
      actions.appendChild(toggle);
    }

    paintToggle(toggle, row, info.transportUrl);
  }

  function injectToggles() {
    if (!isAddonsPage()) return false;
    ensureStyles();
    const rows = document.querySelectorAll(
      '[class*="addons-list-container"] [class*="addon-container"], [class*="addons-container"] [class*="addon-container"]'
    );
    if (!rows.length) return false;
    rows.forEach((row) => injectRowToggle(row));
    return true;
  }

  function scheduleInject() {
    if (injectTimer) clearTimeout(injectTimer);
    injectTimer = setTimeout(async () => {
      injectTimer = null;
      if (!isAddonsPage()) {
        if (retryTimer) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
        return;
      }
      await loadAddonIndex();
      if (!injectToggles() && !retryTimer) {
        let attempts = 0;
        retryTimer = setInterval(async () => {
          if (!isAddonsPage() || attempts > 40) {
            clearInterval(retryTimer);
            retryTimer = null;
            return;
          }
          await loadAddonIndex();
          if (injectToggles()) {
            clearInterval(retryTimer);
            retryTimer = null;
          }
          attempts += 1;
        }, 250);
      }
    }, 120);
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
    broadcastDisabled(readDisabled());
    if (isAddonsPage()) injectToggles();
  });

  const observer = new MutationObserver(scheduleInject);
  const boot = () => {
    const root = document.body || document.documentElement;
    if (!root) {
      setTimeout(boot, 200);
      return;
    }
    observer.observe(root, { childList: true, subtree: true });
    broadcastDisabled(readDisabled());
    scheduleInject();
  };
  boot();

  console.info('[StremioCustom] Addon soft-disable ready.');
})();
