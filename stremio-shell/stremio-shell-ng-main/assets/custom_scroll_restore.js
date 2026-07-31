(function () {
  'use strict';

  if (window.__stremioCustomScrollRestore) return;
  window.__stremioCustomScrollRestore = true;

  const SCROLL_TOP_KEY = 'stremio-custom-board-scroll-top';
  const RESET_TOP_KEY = 'stremio-custom-board-reset-top-on-return';
  const LEFT_VIA_NAV_KEY = 'stremio-custom-board-left-via-nav';

  const RESTORE_WINDOW_MS = 5000;
  const HERO_LAYOUT_GRACE_MS = 2500;

  let savedScrollTop = 0;
  let boardMountAt = 0;
  let hadInAppNavigation = false;
  let lastHash = location.hash;
  let restoreUntil = 0;
  let userOverrodeRestore = false;
  let programmaticScroll = false;
  let restoreMode = null; // null | 'position' | 'top'
  let pendingTimers = [];
  let hashWatchTimer = null;
  /** @type {MutationObserver|null} */
  let boardRestoreObserver = null;
  /** @type {Element|null} */
  let boardRestoreObservedEl = null;

  function isBoardHash(hash) {
    const h = hash || '';
    if (!h || h === '#/' || h === '#') return true;
    if (h.includes('/board')) return true;
    if (/^#\/?\?/.test(h)) return true;
    return false;
  }

  function isBoardRoute() {
    return isBoardHash(location.hash);
  }

  function getRoutePath(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    const stripped = raw.startsWith('/') ? raw.slice(1) : raw;
    const pathOnly = stripped.split('?')[0];
    if (!pathOnly || pathOnly.includes('=')) return '';
    return pathOnly;
  }

  function isDetailOrPlayerHash(hash) {
    const path = getRoutePath(hash);
    return path.startsWith('detail/') || path.startsWith('player');
  }

  function isOtherAppRoute(hash) {
    if (isBoardHash(hash) || isDetailOrPlayerHash(hash)) return false;
    const path = getRoutePath(hash);
    return path.length > 0;
  }

  function getBoardScrollEl() {
    const board = document.querySelector('[class*="board-container"]');
    if (!board) return null;

    const candidates = board.querySelectorAll('[class*="board-content"]');
    for (const el of candidates) {
      const overflowY = window.getComputedStyle(el).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        return el;
      }
    }

    return board.querySelector('[class*="board-content-container"] [class*="board-content"]')
      || document.querySelector('[class*="board-content"]');
  }

  function clearPendingTimers() {
    for (const id of pendingTimers) {
      clearTimeout(id);
    }
    pendingTimers = [];
  }

  function scheduleLater(fn, delay) {
    const id = setTimeout(fn, delay);
    pendingTimers.push(id);
    return id;
  }

  function clearSavedPosition() {
    savedScrollTop = 0;
    try {
      sessionStorage.setItem(SCROLL_TOP_KEY, '0');
    } catch (_) {}
  }

  function shouldResetToTopOnReturn() {
    try {
      return sessionStorage.getItem(RESET_TOP_KEY) === 'true';
    } catch {
      return false;
    }
  }

  function setResetToTopOnReturn(enabled) {
    try {
      if (enabled) {
        sessionStorage.setItem(RESET_TOP_KEY, 'true');
      } else {
        sessionStorage.removeItem(RESET_TOP_KEY);
      }
    } catch (_) {}
  }

  function scrollBoardToTop() {
    const el = getBoardScrollEl();
    if (el) setScrollTop(el, 0);
    const routeContent = document.querySelector('[class*="route-content"]');
    if (routeContent && routeContent !== el) setScrollTop(routeContent, 0);
    window.scrollTo(0, 0);
  }

  function persistScroll(el) {
    if (!el) return;
    savedScrollTop = Math.max(0, Math.round(el.scrollTop));
    try {
      sessionStorage.setItem(SCROLL_TOP_KEY, String(savedScrollTop));
    } catch (_) {}
  }

  function loadPersistedScroll() {
    try {
      const value = Number(sessionStorage.getItem(SCROLL_TOP_KEY));
      savedScrollTop = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    } catch (_) {
      savedScrollTop = 0;
    }
  }

  function captureScroll() {
    if (!isBoardRoute()) return;
    persistScroll(getBoardScrollEl());
  }

  function setScrollTop(el, nextTop) {
    programmaticScroll = true;
    el.scrollTop = Math.max(0, Math.round(nextTop));
    requestAnimationFrame(() => {
      programmaticScroll = false;
    });
  }

  function applyScrollTop(el) {
    if (!el || userOverrodeRestore) return;
    setScrollTop(el, savedScrollTop);
  }

  function isRestoreSessionActive() {
    return restoreMode !== null && Date.now() <= restoreUntil && !userOverrodeRestore;
  }

  function cancelRestore() {
    userOverrodeRestore = true;
    restoreMode = null;
    restoreUntil = 0;
    clearPendingTimers();
    disconnectBoardRestoreObserver();
  }

  function hasSavedPosition() {
    return savedScrollTop > 0;
  }

  function applyActiveRestore(el) {
    if (!el || !isRestoreSessionActive()) return;
    if (restoreMode === 'top') {
      scrollBoardToTop();
      return;
    }
    applyScrollTop(el);
  }

  function restoreScroll(attempt) {
    if (!isBoardRoute() || !isRestoreSessionActive()) return;
    if (Date.now() > restoreUntil && attempt > 12) return;

    const el = getBoardScrollEl();
    if (!el) {
      if (attempt < 80 && isRestoreSessionActive()) {
        scheduleLater(() => restoreScroll(attempt + 1), 40 + attempt * 12);
      }
      return;
    }

    applyActiveRestore(el);

    requestAnimationFrame(() => {
      if (!isRestoreSessionActive()) return;
      applyActiveRestore(el);
      if (attempt < 40 && Date.now() <= restoreUntil) {
        scheduleLater(() => restoreScroll(attempt + 1), 50 + attempt * 35);
      }
    });
  }

  /**
   * Stop listening for restore mutations once the restore window ends.
   */
  function disconnectBoardRestoreObserver() {
    if (boardRestoreObserver) {
      try {
        boardRestoreObserver.disconnect();
      } catch (_) {
        /* ignore */
      }
      boardRestoreObserver = null;
    }
    if (boardRestoreObservedEl) {
      try {
        delete boardRestoreObservedEl.__stremioCustomScrollObserved;
      } catch (_) {
        boardRestoreObservedEl.__stremioCustomScrollObserved = false;
      }
      boardRestoreObservedEl = null;
    }
  }

  function beginRestoreSession(mode) {
    clearPendingTimers();
    userOverrodeRestore = false;
    restoreMode = mode;
    restoreUntil = Date.now() + RESTORE_WINDOW_MS;
    ensureBoardObserver();

    scheduleLater(() => {
      restoreMode = null;
      restoreUntil = 0;
      disconnectBoardRestoreObserver();
    }, RESTORE_WINDOW_MS + 200);
  }

  function scheduleScrollToTop() {
    beginRestoreSession('top');
    const delays = [0, 50, 120, 250, 400, 700, 1100, 1600, 2200, 3000];
    for (const delay of delays) {
      scheduleLater(() => {
        if (!isRestoreSessionActive() || restoreMode !== 'top') return;
        scrollBoardToTop();
      }, delay);
    }
    restoreScroll(0);
  }

  function scheduleRestore() {
    if (shouldResetToTopOnReturn()) {
      setResetToTopOnReturn(false);
      clearSavedPosition();
      scheduleScrollToTop();
      return;
    }

    if (!hasSavedPosition()) {
      cancelRestore();
      return;
    }

    beginRestoreSession('position');
    restoreScroll(0);
    scheduleLater(() => restoreScroll(12), 350);
    scheduleLater(() => restoreScroll(24), 900);
    scheduleLater(() => restoreScroll(32), 1800);
  }

  function ensureBoardObserver() {
    if (!isRestoreSessionActive()) return;
    const el = getBoardScrollEl();
    if (!el) return;
    ensureHeroGutterObserver();
    if (boardRestoreObservedEl === el && boardRestoreObserver) return;

    disconnectBoardRestoreObserver();
    el.__stremioCustomScrollObserved = true;
    boardRestoreObservedEl = el;
    boardRestoreObserver = new MutationObserver(() => {
      if (!isRestoreSessionActive()) return;
      const currentEl = getBoardScrollEl();
      if (!currentEl) return;
      applyActiveRestore(currentEl);
    });
    boardRestoreObserver.observe(el, { childList: true, subtree: true });
  }

  function onUserScrollIntent() {
    if (!isBoardRoute() || programmaticScroll) return;
    cancelRestore();
  }

  function clearStaleBoardSessionFlags() {
    clearSavedPosition();
    setResetToTopOnReturn(false);
    try {
      sessionStorage.removeItem(LEFT_VIA_NAV_KEY);
    } catch (_) {}
  }

  const HERO_GUTTER_STYLE_ID = 'mystremio-board-hero-gutter-style';
  let heroGutterObserver = null;

  /**
   * @param {Element} scrollEl
   * @returns {number}
   */
  function measureScrollbarGutter(scrollEl) {
    return Math.max(0, scrollEl.offsetWidth - scrollEl.clientWidth);
  }

  /**
   * Full-bleed hero: zero board-content padding (no 100vw, no negative margins).
   * Row padding restores the former 1rem inset for catalog rows only.
   */
  function applyBoardHeroGutterFix() {
    const boardScroll = getBoardScrollEl();
    const hero =
      boardScroll?.querySelector('[class*="hero-slot"]')
      || document.querySelector('#app [class*="board-content"] [class*="hero-slot"]');

    if (!boardScroll || !hero) {
      document.getElementById(HERO_GUTTER_STYLE_ID)?.remove();
      return;
    }

    let style = document.getElementById(HERO_GUTTER_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = HERO_GUTTER_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }

    style.textContent = `
      #app [class*="board-container"] [class*="board-content"]:has([class*="hero-slot"]) {
        padding-left: 0 !important;
        padding-right: 0 !important;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
      }
      #app [class*="board-content"] [class*="hero-slot"] {
        left: 0 !important;
        right: auto !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        width: 100% !important;
        max-width: none !important;
        background-color: transparent !important;
      }
      #app [class*="board-content"] [class*="hero-slot"] [class*="hero-container"] {
        width: 100% !important;
      }
      #app [class*="board-container"] [class*="board-content"]:has([class*="hero-slot"])
        [class*="meta-row-container"],
      #app [class*="board-container"] [class*="board-content"]:has([class*="hero-slot"])
        [class*="continue-watching-row"],
      #app [class*="board-container"] [class*="board-content"]:has([class*="hero-slot"])
        [class*="board-row"] {
        padding-left: 1rem;
        padding-right: 1rem;
        box-sizing: border-box;
      }
      #app [class*="board-content"]::-webkit-scrollbar {
        width: 6px !important;
        background: transparent !important;
      }
      #app [class*="board-content"]::-webkit-scrollbar-thumb {
        background-color: rgba(255, 255, 255, 0.18);
        border-radius: 6px;
      }
      #app [class*="board-content"]::-webkit-scrollbar-track,
      #app [class*="board-content"]::-webkit-scrollbar-track-piece,
      #app [class*="board-content"]::-webkit-scrollbar-corner {
        background: transparent !important;
      }
    `;
  }

  function ensureHeroGutterObserver() {
    applyBoardHeroGutterFix();
    const boardScroll = getBoardScrollEl();
    if (!boardScroll) return;

    if (!heroGutterObserver) {
      heroGutterObserver = new ResizeObserver(() => applyBoardHeroGutterFix());
      heroGutterObserver.observe(boardScroll);
      window.addEventListener('resize', applyBoardHeroGutterFix);
    }
  }

  function enterBoardRoute(fromDetailOrPlayer) {
    boardMountAt = Date.now();

    if (fromDetailOrPlayer) {
      loadPersistedScroll();
      ensureHeroGutterObserver();
      scheduleRestore();
      return;
    }

    clearStaleBoardSessionFlags();
    cancelRestore();
    ensureHeroGutterObserver();
    scrollBoardToTop();
  }

  function onRouteChange() {
    const prevHash = lastHash;
    const nextHash = location.hash;
    const fromDetailOrPlayer = hadInAppNavigation && isDetailOrPlayerHash(prevHash);

    if (isBoardHash(prevHash) && !shouldResetToTopOnReturn()) {
      if (isDetailOrPlayerHash(nextHash)) {
        hadInAppNavigation = true;
        captureScroll();
      } else if (isOtherAppRoute(nextHash)) {
        try {
          sessionStorage.setItem(LEFT_VIA_NAV_KEY, 'true');
        } catch (_) {}
      }
    }

    lastHash = nextHash;

    if (isBoardRoute()) {
      try {
        if (!fromDetailOrPlayer && sessionStorage.getItem(LEFT_VIA_NAV_KEY) === 'true') {
          sessionStorage.removeItem(LEFT_VIA_NAV_KEY);
          setResetToTopOnReturn(true);
          clearSavedPosition();
        }
      } catch (_) {}

      enterBoardRoute(fromDetailOrPlayer);
    } else {
      cancelRestore();
    }
  }

  document.addEventListener('wheel', onUserScrollIntent, { capture: true, passive: true });
  document.addEventListener('touchmove', onUserScrollIntent, { capture: true, passive: true });
  document.addEventListener('keydown', (event) => {
    if (!isBoardRoute()) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      onUserScrollIntent();
    }
  });

  document.addEventListener(
    'scroll',
    (event) => {
      if (!isBoardRoute()) return;
      const target = event.target;
      if (!target || !String(target.className || '').includes('board-content')) return;
      if (!programmaticScroll && !isRestoreSessionActive()) {
        persistScroll(target);
      }
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    'click',
    (event) => {
      if (!isBoardRoute()) return;

      const heroAction = event.target?.closest?.('.hero-overlay-button-watch, .hero-overlay-button');
      if (heroAction) {
        setResetToTopOnReturn(false);
        captureScroll();
        return;
      }

      const metaItem = event.target?.closest?.('[class*="meta-item"]');
      if (!metaItem) return;

      setResetToTopOnReturn(false);
      captureScroll();
    },
    true
  );

  window.addEventListener('hashchange', onRouteChange);
  document.addEventListener('stremio-custom-route-change', onRouteChange);
  window.addEventListener('popstate', onRouteChange);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && isBoardRoute()) {
      loadPersistedScroll();
      ensureHeroGutterObserver();
      scheduleRestore();
    }
  });

  document.addEventListener('stremio-custom-hero-layout-changed', () => {
    ensureHeroGutterObserver();
    if (!isBoardRoute() || !isRestoreSessionActive()) return;
    if (Date.now() - boardMountAt < HERO_LAYOUT_GRACE_MS) return;
    const el = getBoardScrollEl();
    if (!el) return;
    applyActiveRestore(el);
  });

  // Route bus covers HashRouter pushState; keep a slow safety poll only as backup.
  hashWatchTimer = window.setInterval(() => {
    if (location.hash !== lastHash) {
      onRouteChange();
    }
  }, 2000);

  if (isBoardRoute()) {
    enterBoardRoute(false);
  }

})();
