(function () {
  'use strict';

  /**
   * Prevents Back from returning to an abandoned `#/player` URL after
   * next-episode lands on detail streams (no live MPV stream → transparent black).
   *
   * Same stream click => same `#/player` hash as abandoned. Distinguish by
   * navigation source + recent user play intent:
   * - pushState / recent click toward streams or /player => allow
   * - popstate / replaceState restore without play intent => bounce
   *
   * Does not gate player transparency.
   */

  if (window.self !== window.top) return;
  if (window.__stremioCustomDeadPlayerNav) return;
  window.__stremioCustomDeadPlayerNav = true;

  const PLAYER_ROUTE = /#\/player(?:\/|$|\?|#)/;
  const DETAIL_ROUTE = /#\/(?:detail|metadetails)(?:\/|$|\?|#)/;
  const PLAYER_HREF = /(?:^|#|\/)player\//i;
  const PLAY_INTENT_MS = 2500;

  let lastHash = location.hash || '';
  /** @type {string} Player hash abandoned when navigating to detail streams. */
  let abandonedPlayerHash = '';
  /** True after player → detail until cleared by play intent or stream start. */
  let abandonedPlayerActive = false;
  /** Skip arming abandon when our own redirect causes player → detail. */
  let suppressNextAbandonMark = false;
  /** Timestamp until which a user play click is assumed. */
  let playIntentUntil = 0;

  function isPlayerHash(hash) {
    return PLAYER_ROUTE.test(hash || '');
  }

  function isDetailHash(hash) {
    return DETAIL_ROUTE.test(hash || '');
  }

  function hasPlayIntent() {
    return Date.now() < playIntentUntil;
  }

  /**
   * @param {string} [reason]
   */
  function markPlayIntent(reason) {
    playIntentUntil = Date.now() + PLAY_INTENT_MS;
    clearAbandoned(reason || 'play intent');
  }

  /**
   * Normalize hash for comparison (decodeURIComponent, strip trailing slash).
   * @param {string} hash
   * @returns {string}
   */
  function normalizeHash(hash) {
    let value = String(hash || '');
    try {
      value = decodeURIComponent(value);
    } catch (_) {}
    return value.replace(/\/+$/, '').toLowerCase();
  }

  function boardUrl() {
    return `${location.pathname || '/index.html'}${location.search || ''}#/board`;
  }

  /**
   * Clear abandoned-player marking so a real stream open is never bounced.
   * @param {string} [reason]
   */
  function clearAbandoned(reason) {
    if (!abandonedPlayerActive && !abandonedPlayerHash && !suppressNextAbandonMark) return;
    abandonedPlayerHash = '';
    abandonedPlayerActive = false;
    if (reason) {
      console.info(`[StremioCustom] Cleared abandoned player mark (${reason})`);
    }
  }

  /**
   * Build a detail streams URL from a player hash when possible.
   * Player route: /player/:stream/.../:type?/:id?/:videoId?
   * @param {string} hash
   * @returns {string|null}
   */
  function detailHashFromPlayerHash(hash) {
    const match = String(hash || '').match(
      /\/(movie|series)\/([^/?#]+)(?:\/([^/?#]+))?\/?(?:[?#]|$)/i
    );
    if (!match) return null;
    const type = match[1].toLowerCase();
    let id = match[2];
    let videoId = match[3] || '';
    try {
      id = decodeURIComponent(id);
    } catch (_) {}
    try {
      videoId = videoId ? decodeURIComponent(videoId) : '';
    } catch (_) {}
    if (!id) return null;

    if (videoId) {
      return `#/detail/${type}/${id}/${videoId}`;
    }

    const colonParts = id.split(':');
    if (type === 'series' && colonParts.length >= 3 && /^tt\d+/i.test(colonParts[0])) {
      return `#/detail/${type}/${colonParts[0]}/${id}`;
    }
    return `#/detail/${type}/${id}`;
  }

  /**
   * Replace a dead player route with detail streams or board.
   * @param {string} reason
   * @returns {boolean}
   */
  function redirectAwayFromDeadPlayer(reason) {
    const sourceHash = location.hash || abandonedPlayerHash || '';
    const detailHash = detailHashFromPlayerHash(sourceHash);
    const target = detailHash
      ? `${location.pathname || '/index.html'}${location.search || ''}${detailHash}`
      : boardUrl();
    const current = `${location.pathname}${location.search}${location.hash}`;
    if (current === target) {
      abandonedPlayerHash = '';
      abandonedPlayerActive = false;
      return false;
    }
    console.info(
      `[StremioCustom] ${reason} — replacing dead player with ${target.split('#').slice(1).join('#') || target}`
    );
    abandonedPlayerHash = '';
    abandonedPlayerActive = false;
    lastHash = target.includes('#') ? `#${target.split('#').slice(1).join('#')}` : '';
    suppressNextAbandonMark = true;
    history.replaceState(null, '', target);
    return true;
  }

  /**
   * Handle SPA hash transitions from the route-change bus.
   * @param {string} prev
   * @param {string} next
   * @param {string} [source]
   */
  function onRouteChange(prev, next, source) {
    lastHash = next;

    // Player → detail (typical next-episode without ready stream).
    if (isPlayerHash(prev) && isDetailHash(next)) {
      if (suppressNextAbandonMark) {
        suppressNextAbandonMark = false;
        abandonedPlayerHash = '';
        abandonedPlayerActive = false;
        return;
      }
      abandonedPlayerHash = prev;
      abandonedPlayerActive = true;
      return;
    }

    // Player → anywhere else (board, etc.): clear abandoned marker.
    if (isPlayerHash(prev) && !isPlayerHash(next)) {
      abandonedPlayerHash = '';
      abandonedPlayerActive = false;
      suppressNextAbandonMark = false;
      return;
    }

    if (!isPlayerHash(next) || !abandonedPlayerActive || !abandonedPlayerHash) {
      return;
    }

    // Intentional play: stream click uses pushState and/or a recent play intent.
    if (source === 'pushState' || hasPlayIntent()) {
      clearAbandoned(source === 'pushState' ? 'pushState into player' : 'play intent into player');
      return;
    }

    // History Back / originPath replace restoring the exact abandoned URL.
    if (
      (source === 'popstate' || source === 'replaceState' || source === 'hashchange') &&
      normalizeHash(next) === normalizeHash(abandonedPlayerHash)
    ) {
      redirectAwayFromDeadPlayer('Back to abandoned player route');
    }
  }

  /**
   * Mark play intent when the user interacts with stream UI or a player link.
   * @param {Event} event
   */
  function onPointerTowardPlayer(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // Nav back must not look like play intent.
    if (target.closest('[class*="back-button"]')) return;

    const withHref = target.closest('a[href], [href]');
    const href = withHref?.getAttribute?.('href') || '';
    if (PLAYER_HREF.test(href)) {
      markPlayIntent('player link');
      return;
    }

    if (
      target.closest(
        '[class*="streams-list"], [class*="stream-container"], [class*="stream-"], [class*="streams-"]'
      )
    ) {
      markPlayIntent('streams list');
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

  document.addEventListener('pointerdown', onPointerTowardPlayer, true);
  document.addEventListener('click', onPointerTowardPlayer, true);

  document.addEventListener(
    'stremio-custom-stream-started',
    () => {
      clearAbandoned('stream-started');
      playIntentUntil = 0;
    },
    { passive: true }
  );

  console.info('[StremioCustom] Dead-player nav guard ready.');
})();
