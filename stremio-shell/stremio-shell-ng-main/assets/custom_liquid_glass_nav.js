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
  const SEARCH_DOCKED_CLASS = 'mystremio-search-docked';

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
        z-index: 320;
        pointer-events: auto;
        height: var(--horizontal-nav-bar-size, 4.5rem);
        display: flex;
        align-items: center;
        flex-wrap: nowrap;
        /* stremio-web resets * to overflow:hidden, which cut the pill shadows into a hard-edged box. */
        overflow: visible;
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
        z-index: 300 !important;
      }

      html.${PERSISTENT_NAV_CLASS} #app [class*="vertical-nav-bar"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }

      /* Always-open page filter. Not a search-bar class, so the dock collapse rules leave it alone. */
      #mystremio-page-search {
        position: fixed;
        top: var(--mystremio-menu-mid, 2.25rem);
        left: calc(var(--mystremio-menu-right, 0px) + 1rem);
        transform: translateY(-50%);
        z-index: 10040;
        display: flex;
        align-items: center;
        gap: 8px;
        width: 16rem;
        max-width: min(420px, 46vw);
        height: 37px;
        margin: 0;
        padding: 0 10px 0 14px;
        box-sizing: border-box;
        border-radius: 999px;
        /* Opaque enough that poster titles scrolling under the nav cannot show through. */
        background: rgba(38, 38, 38, 0.94);
        border: 1px solid rgba(255, 255, 255, 0.04);
        box-shadow:
          0 10px 36px rgba(0, 0, 0, 0.28),
          0 2px 12px rgba(0, 0, 0, 0.12),
          inset 0 1px 0 rgba(255, 255, 255, 0.15),
          inset 0 -1px 0 rgba(0, 0, 0, 0.1);
        color: #fff;
      }
      #mystremio-page-search[hidden] { display: none !important; }
      #mystremio-page-search input {
        flex: 1 1 auto;
        width: 100%;
        min-width: 0;
        height: 100%;
        margin: 0;
        padding: 0;
        border: 0 !important;
        outline: none !important;
        box-shadow: none !important;
        background: transparent !important;
        color: #fff !important;
        font: inherit;
      }
      #mystremio-page-search input::placeholder { color: rgba(255, 255, 255, 0.55) !important; }
      #mystremio-page-search input[type="search"]::-webkit-search-cancel-button,
      #mystremio-page-search input[type="search"]::-webkit-search-decoration,
      #mystremio-page-search input[type="search"]::-webkit-search-results-button {
        -webkit-appearance: none;
        appearance: none;
        display: none;
      }
      #mystremio-page-search button {
        display: flex;
        flex: none;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        color: rgba(255, 255, 255, 0.72);
        cursor: pointer;
      }
      #mystremio-page-search button:hover { color: #fff; }
      #mystremio-page-search button[hidden] { display: none !important; }
      #mystremio-page-search span {
        display: flex;
        flex: none;
        color: rgba(255, 255, 255, 0.85);
      }
      #mystremio-page-search svg { display: block; width: 16px; height: 16px; }
      /* New posters have no hit mark yet, so a category switch cannot paint them over the filter. */
      html[data-mystremio-page-query] [class*="discover-container"] [class*="meta-items-container"] > [class*="meta-item"]:not([data-ms-page-hit]),
      html[data-mystremio-page-query] [class*="library-container"] [class*="meta-items-container"] > [class*="meta-item"]:not([data-ms-page-hit]) {
        display: none !important;
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

  function isTitleSearchHash(hash) {
    const value = String(hash || location.hash || '');
    if (/#\/search(?:\/|$|\?|#)/i.test(value)) return true;
    return value === '' || value === '#' || value === '#/' || /^#\/?(?:\?|$)/.test(value);
  }

  function ensureTransitionHost() {
    let host = document.getElementById(TRANSITION_HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = TRANSITION_HOST_ID;
      document.body.appendChild(host);
      new ResizeObserver(dockSearch).observe(host);
    }
    return host;
  }

  function hidePersistentHost() {
    const host = document.getElementById(TRANSITION_HOST_ID);
    if (host) host.hidden = true;
    document.documentElement.classList.remove(PERSISTENT_NAV_CLASS, SEARCH_DOCKED_CLASS);
  }

  function pageSearchKind(hash) {
    const value = String(hash || location.hash || '');
    if (/^#\/discover(?:\/|$|\?|#)/i.test(value)) return 'discover';
    if (/^#\/library(?:\/|$|\?|#)/i.test(value)) return 'library';
    return '';
  }

  function pageFilterMatches(title, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    return String(title || '').toLowerCase().includes(q);
  }

  function shouldPumpLibrary(count, lastCount, view, lastView, query) {
    if (!String(query || '').trim()) return false;
    if (view !== lastView) return true;
    return count !== lastCount;
  }

  function assertPageFilter() {
    const ok =
      pageFilterMatches('The Matrix', '') &&
      pageFilterMatches('The Matrix', '  mat ') &&
      !pageFilterMatches('The Matrix', 'alien') &&
      pageFilterMatches('Äon Flux', 'äon') &&
      !shouldPumpLibrary(10, 10, 'a', 'a', '') &&
      shouldPumpLibrary(20, 10, 'a', 'a', 'fast') &&
      !shouldPumpLibrary(20, 20, 'a', 'a', 'fast') &&
      shouldPumpLibrary(20, 20, 'z', 'a', 'fast');
    if (!ok) console.error('mystremio page search filter check failed');
  }

  function pageItemTitle(el) {
    const own = el.getAttribute('title');
    if (own) return own;
    const label = el.querySelector('[class*="title-label"]');
    return label ? label.textContent || '' : '';
  }

  let applyingPageFilter = false;
  let libraryPumpCount = -1;
  let libraryPumpView = '';

  function libraryViewKey() {
    const root = document.querySelector('[class*="library-container"]');
    const sort = root
      ? Array.from(root.querySelectorAll('[class*="chip-"][class*="active-"]'))
          .filter((chip) => chip.dataset.scCustomFolderTab !== '1')
          .map((chip) => (chip.textContent || '').trim())
          .join('|')
      : '';
    return `${location.hash}|${location.search}|${sort}`;
  }

  function pumpLibraryPages(query) {
    const grid = document.querySelector('[class*="library-container"] [class*="meta-items-container"]');
    if (!grid) return;
    const view = libraryViewKey();
    const count = Array.from(grid.children).filter((el) =>
      String(el.className || '').includes('meta-item')
    ).length;
    if (!shouldPumpLibrary(count, libraryPumpCount, view, libraryPumpView, query)) return;
    libraryPumpView = view;
    libraryPumpCount = count;
    // shortcut: reuse the grid's own scroll-to-load; one shot per page, stops when nothing new arrives
    const top = grid.scrollTop;
    const short = grid.scrollHeight <= grid.clientHeight + 400;
    if (short) grid.style.minHeight = `${grid.clientHeight + 800}px`;
    grid.scrollTop = 0;
    grid.dispatchEvent(new Event('scroll'));
    grid.scrollTop = grid.scrollHeight;
    grid.dispatchEvent(new Event('scroll'));
    if (short) grid.style.minHeight = '';
    grid.scrollTop = top;
  }

  function applyPageFilter(query) {
    if (applyingPageFilter) return;
    applyingPageFilter = true;
    try {
      const kind = pageSearchKind();
      const active = Boolean(kind && String(query || '').trim());
      document.documentElement.toggleAttribute('data-mystremio-page-query', active);
      document
        .querySelectorAll(
          '[class*="discover-container"] [class*="meta-items-container"] > [class*="meta-item"],' +
            '[class*="library-container"] [class*="meta-items-container"] > [class*="meta-item"]'
        )
        .forEach((el) => {
          const show = !active || pageFilterMatches(pageItemTitle(el), query);
          if (show) {
            if (el.dataset.msPageHit !== '1') el.dataset.msPageHit = '1';
          } else if (el.dataset.msPageHit) {
            delete el.dataset.msPageHit;
          }
          if (el.style.display && !el.classList.contains('sc-folder-hidden')) el.style.display = '';
        });
      if (kind === 'library') pumpLibraryPages(query);
    } finally {
      applyingPageFilter = false;
    }
  }

  function syncPageSearch() {
    let bar = document.getElementById('mystremio-page-search');
    if (!bar) {
      bar = document.createElement('form');
      bar.id = 'mystremio-page-search';
      bar.hidden = true;
      bar.setAttribute('role', 'search');
      bar.addEventListener('submit', (event) => event.preventDefault());
      const input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.enterKeyHint = 'search';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.hidden = true;
      clear.tabIndex = -1;
      clear.setAttribute('aria-label', 'Clear search');
      clear.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M6 6 L18 18 M18 6 L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
      clear.addEventListener('click', () => {
        input.value = '';
        clear.hidden = true;
        applyPageFilter('');
        input.focus();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') event.preventDefault();
      });
      input.addEventListener('input', () => {
        clear.hidden = input.value.length === 0;
        applyPageFilter(input.value);
      });
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML =
        '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16 L21 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      bar.append(input, clear, icon);
      document.body.appendChild(bar);
    }
    const input = bar.querySelector('input');
    const clear = bar.querySelector('button');
    const kind = pageSearchKind();
    if (!kind) {
      bar.hidden = true;
      return;
    }
    if (bar.dataset.kind !== kind) {
      bar.dataset.kind = kind;
      input.value = '';
      if (clear) clear.hidden = true;
      input.placeholder = kind === 'library' ? 'Search Library' : 'Search Discover';
      input.setAttribute('aria-label', input.placeholder);
    }
    bar.hidden = false;
    applyPageFilter(input.value);
  }

  /** Theme pins the nav search right after the last menu pill via these vars. */
  function dockSearch() {
    const host = document.getElementById(TRANSITION_HOST_ID);
    const last = host && !host.hidden ? host.firstElementChild?.lastElementChild : null;
    const root = document.documentElement;
    root.classList.toggle('mystremio-title-search', isTitleSearchHash());
    if (!last) {
      root.classList.remove(SEARCH_DOCKED_CLASS);
    } else {
      const rect = last.getBoundingClientRect();
      root.style.setProperty('--mystremio-menu-right', `${rect.right}px`);
      root.style.setProperty('--mystremio-menu-mid', `${rect.top + rect.height / 2}px`);
      root.classList.add(SEARCH_DOCKED_CLASS);
    }
    syncPageSearch();
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
    dockSearch();
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
        if (pageSearchKind()) {
          const input = document.querySelector('#mystremio-page-search input');
          applyPageFilter(input ? input.value : '');
        }
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
    assertPageFilter();
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
    document.getElementById('mystremio-page-search')?.remove();
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
