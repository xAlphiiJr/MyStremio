(function () {
  'use strict';

  /**
   * Prevents Back from returning to an abandoned `#/player` URL after
   * next-episode lands on detail streams (no live MPV stream → transparent black).
   *
   * Listens to stremio-custom-route-change (HashRouter push/replace), not only
   * native hashchange. Does not gate player transparency.
   */

  if (window.self !== window.top) return;
  if (window.__stremioCustomDeadPlayerNav) return;
  window.__stremioCustomDeadPlayerNav = true;

  const PLAYER_ROUTE = /#\/player(?:\/|$|\?|#)/;
  const DETAIL_ROUTE = /#\/(?:detail|metadetails)(?:\/|$|\?|#)/;

  let lastHash = location.hash || '';
  /** @type {string} Player hash abandoned when navigating to detail streams. */
  let abandonedPlayerHash = '';
  /** True after player → detail until a real stream starts or we leave the dead-player flow. */
  let abandonedPlayerActive = false;
  let streamStartedThisVisit = false;

  function isPlayerHash(hash) {
    return PLAYER_ROUTE.test(hash || '');
  }

  function isDetailHash(hash) {
    return DETAIL_ROUTE.test(hash || '');
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
   * Build a detail streams URL from a player hash when possible.
   * @param {string} hash
   * @returns {string|null}
   */
  function detailHashFromPlayerHash(hash) {
    const match = String(hash || '').match(/\/player\/.+\/(movie|series)\/([^/?#]+)/i);
    if (!match) return null;
    const type = match[1].toLowerCase();
    let id = match[2];
    try {
      id = decodeURIComponent(id);
    } catch (_) {}
    if (!id) return null;

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
    history.replaceState(null, '', target);
    return true;
  }

  /**
   * Handle SPA hash transitions from the route-change bus.
   * @param {string} prev
   * @param {string} next
   */
  function onRouteChange(prev, next) {
    lastHash = next;

    // Player → detail (typical next-episode without ready stream).
    if (isPlayerHash(prev) && isDetailHash(next)) {
      abandonedPlayerHash = prev;
      abandonedPlayerActive = true;
      streamStartedThisVisit = false;
      return;
    }

    // Player → anywhere else (board, etc.): clear abandoned marker.
    if (isPlayerHash(prev) && !isPlayerHash(next)) {
      abandonedPlayerHash = '';
      abandonedPlayerActive = false;
      streamStartedThisVisit = false;
      return;
    }

    // Re-entered player after abandoning for detail, without a new stream.
    if (isPlayerHash(next) && abandonedPlayerActive && !streamStartedThisVisit) {
      const sameAbandoned =
        abandonedPlayerHash && normalizeHash(next) === normalizeHash(abandonedPlayerHash);
      // Any dead re-entry while abandoned is unsafe (originPath may differ slightly).
      if (sameAbandoned || abandonedPlayerActive) {
        redirectAwayFromDeadPlayer('Back to abandoned player route');
      }
    }
  }

  document.addEventListener(
    'stremio-custom-route-change',
    (event) => {
      const prev = event?.detail?.prev ?? lastHash;
      const next = event?.detail?.next ?? location.hash ?? '';
      onRouteChange(prev, next);
    },
    true
  );

  // Fallback if the route-change bus is missing for any reason.
  window.addEventListener(
    'hashchange',
    () => {
      const prev = lastHash;
      const next = location.hash || '';
      if (prev === next) return;
      onRouteChange(prev, next);
    },
    true
  );

  document.addEventListener(
    'stremio-custom-stream-started',
    () => {
      streamStartedThisVisit = true;
      abandonedPlayerHash = '';
      abandonedPlayerActive = false;
    },
    { passive: true }
  );

  console.info('[StremioCustom] Dead-player nav guard ready.');
})();
