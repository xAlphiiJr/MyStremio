(function () {
  'use strict';

  /**
   * 1) Detail/MetaDetails Back always goes to board (`#/` — HashRouter Board path).
   * 2) History restores into a dead `#/player` bounce to board.
   * Navigates via replaceState + PopStateEvent so HashRouter unmounts MetaDetails.
   * Never `#/board` — that hits path:"*" NotFound.
   */

  if (window.self !== window.top) return;
  if (window.__stremioCustomDeadPlayerNav) return;
  window.__stremioCustomDeadPlayerNav = true;

  const PLAYER_ROUTE = /#\/player(?:\/|$|\?|#)/;
  const DETAIL_ROUTE = /#\/(?:detail|metadetails)(?:\/|$|\?|#)/;
  const PLAYER_HREF = /(?:^|#|\/)player\//i;
  const PLAY_INTENT_MS = 2500;

  let lastHash = location.hash || '';
  let playIntentUntil = 0;
  let suppressSelfRedirect = false;

  function isPlayerHash(hash) {
    return PLAYER_ROUTE.test(hash || '');
  }

  function isDetailHash(hash) {
    return DETAIL_ROUTE.test(hash || '');
  }

  /**
   * Board route in Stremio HashRouter is `path: "/"` → `#/`.
   * @param {string} hash
   * @returns {boolean}
   */
  function isBoardHash(hash) {
    const h = hash || '';
    return h === '' || h === '#' || h === '#/' || /^#\/\?/.test(h);
  }

  function hasPlayIntent() {
    return Date.now() < playIntentUntil;
  }

  function markPlayIntent() {
    playIntentUntil = Date.now() + PLAY_INTENT_MS;
  }

  function hasLiveStream() {
    try {
      return Boolean(window.StremioCustomPlayback?.getMpvSnapshot?.()?.hasStream);
    } catch (_) {
      return false;
    }
  }

  /**
   * @returns {string}
   */
  function boardUrl() {
    return `${location.pathname || '/index.html'}${location.search || ''}#/`;
  }

  /**
   * Navigate to board in a HashRouter-compatible way (replace, not push).
   * @param {string} reason
   * @returns {boolean}
   */
  function goToBoard(reason) {
    if (isBoardHash(location.hash || '')) return false;

    const target = boardUrl();
    const prev = history.state;
    const idx = prev && typeof prev.idx === 'number' ? prev.idx : 0;
    const state = {
      usr: null,
      key: Math.random().toString(36).slice(2, 10),
      idx,
    };

    console.info(`[StremioCustom] ${reason} — replaceState+#/ + popstate`);
    lastHash = '#/';
    suppressSelfRedirect = true;
    history.replaceState(state, '', target);
    try {
      window.dispatchEvent(new PopStateEvent('popstate', { state }));
    } catch (_) {
      const ev = document.createEvent('Event');
      ev.initEvent('popstate', true, true);
      window.dispatchEvent(ev);
    }
    return true;
  }

  /**
   * @param {string} reason
   * @returns {boolean}
   */
  function redirectAwayFromDeadPlayer(reason) {
    return goToBoard(reason);
  }

  /**
   * Capture MetaDetails nav-bar Back only — not season/streams dropdown backs.
   * @param {Event} event
   */
  function onDetailBackClick(event) {
    if (!isDetailHash(location.hash || '')) return;
    const target = event.target;
    if (!(target instanceof Element)) return;

    const back = target.closest(
      'nav[class*="horizontal-nav-bar"] [class*="back-button"], ' +
        '[class*="meta-details"] [class*="back-button"], ' +
        '[class*="metadetails"] [class*="back-button"], ' +
        '[class*="nav-bar-back-button"]'
    );
    if (!back) return;
    if (back.closest('[class*="menu-container"], [class*="modal"], [role="dialog"], [class*="dropdown"]')) {
      return;
    }
    if (back.closest('[class*="streams-list"], [class*="season"], [class*="video-"]')) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
    goToBoard('Detail back → board');
  }

  /**
   * @param {string} prev
   * @param {string} next
   * @param {string} source
   */
  function onRouteChange(prev, next, source) {
    if (suppressSelfRedirect) {
      suppressSelfRedirect = false;
      lastHash = next;
      return;
    }

    lastHash = next;

    if (!isPlayerHash(next)) return;
    if (isPlayerHash(prev)) return;
    if (source === 'pushState' || hasPlayIntent()) return;
    if (hasLiveStream()) return;

    if (source === 'popstate' || source === 'replaceState' || source === 'hashchange') {
      window.setTimeout(() => {
        if (!isPlayerHash(location.hash || '')) return;
        if (hasPlayIntent() || hasLiveStream()) return;
        redirectAwayFromDeadPlayer('History restore to dead player route');
      }, 80);
    }
  }

  /**
   * @param {Event} event
   */
  function onPointerTowardPlayer(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[class*="back-button"]')) return;

    const withHref = target.closest('a[href], [href]');
    const href = withHref?.getAttribute?.('href') || '';
    if (PLAYER_HREF.test(href)) {
      markPlayIntent();
      return;
    }

    if (
      target.closest(
        '[class*="streams-list"], [class*="stream-container"], [class*="stream-"], [class*="streams-"]'
      )
    ) {
      markPlayIntent();
    }
  }

  document.addEventListener(
    'stremio-custom-route-change',
    (event) => {
      const prev = event?.detail?.prev ?? lastHash;
      const next = event?.detail?.next ?? location.hash ?? '';
      const source = event?.detail?.source || '';
      onRouteChange(prev, next, source);
    },
    true
  );

  document.addEventListener('click', onDetailBackClick, true);
  document.addEventListener('pointerdown', onPointerTowardPlayer, true);
  document.addEventListener('click', onPointerTowardPlayer, true);

  document.addEventListener(
    'stremio-custom-stream-started',
    () => {
      playIntentUntil = 0;
    },
    { passive: true }
  );

  console.info('[StremioCustom] Dead-player / detail-back nav guard ready (#/).');
})();
