(function () {
  'use strict';

  /**
   * Startup / route guard for stale #/player without a live MPV stream.
   *
   * - Cold boot: redirect restored #/player → #/ until bootstrap-ready.
   * - After ready: do NOT redirect (user may be opening the player); keep opaque
   *   until a live stream allows transparency.
   * - Warm resume: callers force-redirect dead player sessions.
   * - Never re-create the boot seal after dismiss (permanent black screen).
   */

  if (window.self !== window.top) return;
  if (window.__stremioCustomStartupGuard) return;
  window.__stremioCustomStartupGuard = true;

  const OPAQUE_STYLE_ID = 'stremio-custom-startup-opaque';
  const PLAYER_ROUTE = /#\/player(?:\/|$|\?|#)/;
  const BOARD_HASH = '#/';
  const ROUTE_WATCH_MS = 250;

  let streamSessionAllowed = false;
  let routeWatchTimer = null;

  function isPlayerRoute() {
    return PLAYER_ROUTE.test(location.hash || '');
  }

  function hasLiveStream() {
    try {
      return Boolean(window.StremioCustomPlayback?.getMpvSnapshot?.()?.hasStream);
    } catch (_) {
      return false;
    }
  }

  function isStalePlayerRoute() {
    return isPlayerRoute() && !streamSessionAllowed && !hasLiveStream();
  }

  function boardUrl() {
    return `${location.pathname || '/index.html'}${location.search || ''}${BOARD_HASH}`;
  }

  function ensureOpaqueFallback() {
    if (isPlayerRoute() && (streamSessionAllowed || hasLiveStream())) return;
    let style = document.getElementById(OPAQUE_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = OPAQUE_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = `
      html, html body, body, #root, #root > div, #app, #app > div {
        background-color: rgb(20, 20, 20) !important;
        background: rgb(20, 20, 20) !important;
      }
    `;
  }

  function clearOpaqueFallback() {
    document.getElementById(OPAQUE_STYLE_ID)?.remove();
  }

  /**
   * @param {string} reason
   * @param {{ force?: boolean }} [opts]
   */
  function redirectStalePlayerRoute(reason, opts) {
    const force = Boolean(opts && opts.force);
    if (!isStalePlayerRoute()) return false;
    // After bootstrap-ready, only warm-resume (force) may steal the route —
    // otherwise intentional play navigations get bounced back to board.
    if (!force && window.__stremioCustomBootstrapReady) return false;

    const target = boardUrl();
    if (`${location.pathname}${location.search}${location.hash}` === target) return false;
    console.info(`[StremioCustom] ${reason} — redirecting to board`);
    history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    try {
      document.dispatchEvent(new CustomEvent('stremio-custom-route-change'));
    } catch (_) {
      /* ignore */
    }
    ensureOpaqueFallback();
    return true;
  }

  function allowPlayerSession(source) {
    if (streamSessionAllowed) return;
    streamSessionAllowed = true;
    stopRouteWatch();
    clearOpaqueFallback();
    console.info(`[StremioCustom] Player session allowed (${source})`);
    window.__stremioCustomPlayerTransparencyEnsure?.();
    window.__stremioCustomPlayerLoadingEnsure?.();
  }

  function stopRouteWatch() {
    if (routeWatchTimer) {
      clearInterval(routeWatchTimer);
      routeWatchTimer = null;
    }
  }

  function startRouteWatch() {
    if (routeWatchTimer) return;
    routeWatchTimer = window.setInterval(() => {
      if (window.__stremioCustomBootstrapReady) {
        stopRouteWatch();
        return;
      }
      redirectStalePlayerRoute('Stale player route without live stream');
    }, ROUTE_WATCH_MS);
  }

  function onStreamActivity() {
    if (!isPlayerRoute()) return;
    allowPlayerSession('stream-activity');
  }

  /** Blocks treating #/player as real playback until a live stream exists. */
  window.__stremioCustomIsColdStartPlayerBlocked = function () {
    return isStalePlayerRoute();
  };

  window.__stremioCustomStartupGuardEnsure = function () {
    if (window.__stremioCustomBootstrapReady) return;
    ensureOpaqueFallback();
  };

  window.__stremioCustomDismissStartupOverlays = function () {
    clearOpaqueFallback();
    stopRouteWatch();
    try {
      window.__stremioCustomRemoveBootSeal?.();
    } catch (_) {
      /* ignore */
    }
    const mask = document.getElementById('stremio-custom-app-loading-mask');
    if (mask) {
      mask.classList.remove('visible');
      mask.style.display = 'none';
      mask.style.opacity = '0';
      mask.style.pointerEvents = 'none';
    }
  };

  window.__stremioCustomRedirectStalePlayer = function (reason) {
    return redirectStalePlayerRoute(reason || 'Forced stale player redirect', { force: true });
  };

  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    window.__stremioCustomBootstrapReady = true;
    window.__stremioCustomDismissStartupOverlays?.();
  });

  ensureOpaqueFallback();
  redirectStalePlayerRoute('Player route without live stream');
  startRouteWatch();

  document.addEventListener('stremio-custom-stream-started', () => onStreamActivity(), { passive: true });
  document.addEventListener(
    'stremio-custom-mpv-time',
    () => {
      if (isPlayerRoute()) onStreamActivity();
    },
    { passive: true }
  );

  window.addEventListener('hashchange', () => {
    if (!window.__stremioCustomBootstrapReady) {
      if (isStalePlayerRoute()) {
        ensureOpaqueFallback();
        redirectStalePlayerRoute('Player route without live stream');
      } else if (!isPlayerRoute()) {
        ensureOpaqueFallback();
      }
      return;
    }
    // After ready: opaque until live stream; never bounce intentional play.
    if (isStalePlayerRoute()) {
      ensureOpaqueFallback();
      return;
    }
    if (streamSessionAllowed || hasLiveStream()) {
      clearOpaqueFallback();
    }
  });

  console.info('[StremioCustom] Startup guard ready.');
})();
