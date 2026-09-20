(function () {
  'use strict';

  if (window.__stremioCustomLiquidGlassNav) return;
  window.__stremioCustomLiquidGlassNav = true;

  let fixTimer = null;
  let observer = null;
  let started = false;

  const NAV_FOCUS_STYLE_ID = 'stremio-custom-nav-focus-style';
  const NAV_TRANSITION_STYLE_ID = 'stremio-custom-nav-transition-style';
  const TRANSITION_HOST_ID = 'stremio-custom-nav-transition-host';
  const PERSISTENT_NAV_CLASS = 'mystremio-persistent-nav';

  function ensureTransitionStyles() {
    let style = document.getElementById(NAV_TRANSITION_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = NAV_TRANSITION_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = `
      #${TRANSITION_HOST_ID} {
        position: fixed;
        top: 0;
        left: 91px;
        z-index: 122;
        pointer-events: auto;
        height: var(--horizontal-nav-bar-size, 4.5rem);
        display: flex;
        align-items: center;
        flex-wrap: nowrap;
      }

      #${TRANSITION_HOST_ID}[hidden] {
        display: none !important;
      }

      #${TRANSITION_HOST_ID} [class*="vertical-nav-bar"],
      #${TRANSITION_HOST_ID} [class*="vertical-nav-bar-container"] {
        position: relative !important;
        left: auto !important;
        top: auto !important;
        display: flex !important;
        flex-direction: row !important;
        flex-wrap: nowrap !important;
        align-items: center !important;
        gap: 1rem !important;
        background: transparent !important;
        overflow: visible !important;
        width: auto !important;
        height: auto !important;
        padding: 1rem 1.25rem !important;
        visibility: visible !important;
        pointer-events: auto !important;
      }

      #${TRANSITION_HOST_ID} [class*="nav-tab-button-container"],
      #${TRANSITION_HOST_ID} [class*="nav-tab-button"] {
        display: flex !important;
        flex-direction: row !important;
        flex-wrap: nowrap !important;
        align-items: center !important;
        justify-content: center !important;
        width: auto !important;
        min-width: 0 !important;
        max-width: none !important;
        height: auto !important;
        min-height: 0 !important;
        padding: 7px 10px !important;
        white-space: nowrap !important;
        position: relative !important;
        background: rgba(70, 70, 70, 0.45) !important;
        border-radius: 999px !important;
        border: 1px solid rgba(255, 255, 255, 0.04) !important;
        box-shadow:
          0 10px 36px rgba(0, 0, 0, 0.28),
          0 2px 12px rgba(0, 0, 0, 0.12),
          inset 0 1px 0 rgba(255, 255, 255, 0.15),
          inset 0 -1px 0 rgba(0, 0, 0, 0.1) !important;
        visibility: visible !important;
        pointer-events: auto !important;
      }

      #${TRANSITION_HOST_ID} [class*="nav-tab-button-container"].selected,
      #${TRANSITION_HOST_ID} [class*="nav-tab-button"].selected {
        background: rgba(70, 70, 70, 0.55) !important;
        border: 2px solid rgba(255, 255, 255, 0.5) !important;
      }

      #${TRANSITION_HOST_ID} svg,
      #${TRANSITION_HOST_ID} [class*="icon"] {
        display: none !important;
      }

      #${TRANSITION_HOST_ID} .nav-label,
      #${TRANSITION_HOST_ID} [class*="label"] {
        display: inline !important;
        white-space: nowrap !important;
        overflow: visible !important;
        width: auto !important;
        max-width: none !important;
        font-weight: 600 !important;
        padding: 0 5px !important;
        color: var(--primary-accent-color, #fff) !important;
      }

      html.${PERSISTENT_NAV_CLASS} #app nav[class*="horizontal-nav-bar"] {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        z-index: 121 !important;
      }

      html.${PERSISTENT_NAV_CLASS} #app [class*="vertical-nav-bar"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }
    `;
  }

  function ensureNavFocusStyles() {
    if (document.getElementById(NAV_FOCUS_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = NAV_FOCUS_STYLE_ID;
    style.textContent = `
      #app [class*="nav-tab-button-container"],
      #app [class*="nav-tab-button"],
      #app [class*="horizontal-nav-bar"] a,
      #${TRANSITION_HOST_ID} [class*="nav-tab-button-container"],
      #${TRANSITION_HOST_ID} a {
        -webkit-tap-highlight-color: transparent !important;
      }

      #app [class*="nav-tab-button-container"]:focus,
      #app [class*="nav-tab-button-container"]:focus-visible,
      #app [class*="nav-tab-button"]:focus,
      #app [class*="nav-tab-button"]:focus-visible,
      #app [class*="horizontal-nav-bar"] a:focus,
      #app [class*="horizontal-nav-bar"] a:focus-visible,
      #${TRANSITION_HOST_ID} a:focus,
      #${TRANSITION_HOST_ID} a:focus-visible {
        outline: none !important;
        box-shadow: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function navigateToHash(href) {
    if (!href || href === '#') return;
    const target = href.startsWith('#') ? href : `#${href}`;
    if (location.hash === target) {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return;
    }
    location.hash = target;
  }

  function wireNavLinks(root) {
    if (!root) return;
    root.querySelectorAll('a[href^="#"]').forEach((link) => {
      if (link.dataset.scNavWired === '1') return;
      link.dataset.scNavWired = '1';
      link.style.pointerEvents = 'auto';
      link.style.cursor = 'pointer';
    });
  }

  function wireHostLinks(root) {
    if (!root) return;
    root.querySelectorAll('a[href^="#"]').forEach((link) => {
      if (link.dataset.scNavHostWired === '1') return;
      link.dataset.scNavHostWired = '1';
      link.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        navigateToHash(link.getAttribute('href'));
      }, true);
    });
  }

  function ensureNavClickable() {
    const roots = [
      document.getElementById(TRANSITION_HOST_ID),
      document.querySelector('[class*="horizontal-nav-bar"]'),
      document.querySelector('[class*="vertical-nav-bar"]'),
      document.querySelector('[class*="main-nav-bars-container"]'),
    ].filter(Boolean);
    roots.forEach(wireNavLinks);
  }

  function isDetailOrPlayerHash(hash) {
    const value = String(hash || location.hash || '');
    return /#\/(?:player|detail|metadetails)\b/i.test(value);
  }

  function isBoardFamilyHash(hash) {
    return !isDetailOrPlayerHash(hash);
  }

  function ensureTransitionHost() {
    let host = document.getElementById(TRANSITION_HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = TRANSITION_HOST_ID;
      document.body.appendChild(host);
    }
    return host;
  }

  function hidePersistentHost() {
    const host = document.getElementById(TRANSITION_HOST_ID);
    if (host) host.hidden = true;
    document.documentElement.classList.remove(PERSISTENT_NAV_CLASS);
  }

  function showPersistentHost() {
    const host = ensureTransitionHost();
    host.hidden = false;
    document.documentElement.classList.add(PERSISTENT_NAV_CLASS);
    return host;
  }

  function restyleTabLinks(root) {
    if (!root) return;
    root.querySelectorAll('a').forEach((link) => {
      if (link.closest('[class*="nav-menu-container"]')) return;
      link.querySelectorAll('svg, [class*="icon"]').forEach((node) => node.remove());
      const label = link.querySelector('div');
      if (label) label.className = 'nav-label';
    });
  }

  function tabSignature(root) {
    if (!root) return '';
    return Array.from(root.querySelectorAll('a[href^="#"]'))
      .filter((link) => !link.closest('[class*="nav-menu-container"]'))
      .map((link) => link.getAttribute('href') || '')
      .join('|');
  }

  function normalizeTabHash(href) {
    if (!href) return '';
    let value = href.startsWith('#') ? href : `#${href}`;
    if (value === '#' || value === '#/') return '#/';
    return value.replace(/\/$/, '') || '#/';
  }

  function hashMatchesTab(tabHref, locHash) {
    const tab = normalizeTabHash(tabHref);
    const loc = normalizeTabHash(locHash || location.hash || '#/');
    if (tab === loc) return true;
    if (tab === '#/' && (loc === '#/' || loc === '' || /^#\/?(?:\?|$)/.test(locHash || ''))) return true;
    return loc.startsWith(`${tab}/`) || loc.startsWith(`${tab}?`);
  }

  function applySelectedFromHash(root) {
    if (!root) return;
    const loc = location.hash || '#/';
    root.querySelectorAll('a[href^="#"]').forEach((link) => {
      if (link.closest('[class*="nav-menu-container"]')) return;
      const selected = hashMatchesTab(link.getAttribute('href'), loc);
      link.classList.toggle('selected', selected);
      const container = link.closest('[class*="nav-tab-button-container"]');
      if (container) container.classList.toggle('selected', selected);
    });
  }

  function findLiveTabSource() {
    const nodes = document.querySelectorAll('#app [class*="vertical-nav-bar"]');
    for (const node of nodes) {
      if (node.closest(`#${TRANSITION_HOST_ID}`)) continue;
      if (node.querySelector('a[href^="#"]')) return node;
    }
    return null;
  }

  function syncPersistentTabs() {
    if (!isBoardFamilyHash()) {
      hidePersistentHost();
      return;
    }

    const host = showPersistentHost();
    const source = findLiveTabSource();
    if (!source) {
      applySelectedFromHash(host);
      return;
    }

    const next = source.cloneNode(true);
    next.querySelectorAll('[class*="search-bar"], [class*="nav-menu-container"]').forEach((el) => el.remove());
    restyleTabLinks(next);
    applySelectedFromHash(next);

    const current = host.firstElementChild;
    if (current && tabSignature(current) === tabSignature(next)) {
      applySelectedFromHash(current);
      wireHostLinks(current);
      return;
    }

    wireHostLinks(next);
    host.replaceChildren(next);
  }

  function fixAllNavbars() {
    syncPersistentTabs();
    ensureNavClickable();
  }

  function scheduleFix() {
    if (fixTimer) clearTimeout(fixTimer);
    fixTimer = setTimeout(() => {
      fixTimer = null;
      fixAllNavbars();
    }, 80);
  }

  function findNavObserveRoot() {
    return document.querySelector('#app') || document.body;
  }

  function bindNavObserver() {
    if (!observer) {
      observer = new MutationObserver(() => {
        scheduleFix();
      });
    } else {
      observer.disconnect();
    }
    const root = findNavObserveRoot();
    if (root) {
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    }
  }

  function fixNavOnRouteChange() {
    bindNavObserver();
    requestAnimationFrame(() => {
      fixAllNavbars();
    });
    scheduleFix();
  }

  function start() {
    ensureTransitionStyles();
    ensureNavFocusStyles();
    fixAllNavbars();
    bindNavObserver();
    if (started) return;
    started = true;
    window.addEventListener('resize', scheduleFix, { passive: true });
    window.addEventListener('hashchange', fixNavOnRouteChange);
    window.addEventListener('hashchange', ensureNavClickable);
    document.addEventListener('stremio-custom-route-change', fixNavOnRouteChange);
  }

  function stop() {
    if (fixTimer) {
      clearTimeout(fixTimer);
      fixTimer = null;
    }
    hidePersistentHost();
    const host = document.getElementById(TRANSITION_HOST_ID);
    if (host) host.replaceChildren();
    observer?.disconnect();
    observer = null;
    started = false;
    window.removeEventListener('resize', scheduleFix);
    window.removeEventListener('hashchange', fixNavOnRouteChange);
    window.removeEventListener('hashchange', ensureNavClickable);
    document.removeEventListener('stremio-custom-route-change', fixNavOnRouteChange);
  }

  window.__stremioCustomLiquidGlassNavStart = start;
  window.__stremioCustomLiquidGlassNavStop = stop;
  window.__stremioLiquidGlassNavSuspend = function () {
    try {
      observer?.disconnect();
    } catch (_) {}
  };
  window.__stremioLiquidGlassNavResume = function () {
    if (!observer) {
      const theme = window.StremioCustom?.helpers?.getCurrentTheme?.() || '';
      if (theme === 'liquid-glass.theme.css') start();
      return;
    }
    bindNavObserver();
  };

  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    const theme = window.StremioCustom?.helpers?.getCurrentTheme?.() || '';
    if (theme === 'liquid-glass.theme.css') {
      start();
    }
  });
})();
