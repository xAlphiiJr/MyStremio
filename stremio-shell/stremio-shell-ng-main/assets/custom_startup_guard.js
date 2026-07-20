(function () {
  'use strict';

  /**
   * Cold-start guard for stale persisted routes and transparent-shell black screens.
   *
   * Stremio may restore #/player from WebView2 storage without an active MPV stream.
   * The shell WebView is transparent on that route, which looks like a black screen.
   */

  if (window.self !== window.top) return;
  if (window.__stremioCustomStartupGuard) return;
  window.__stremioCustomStartupGuard = true;

  const OPAQUE_STYLE_ID = 'stremio-custom-startup-opaque';
  const PLAYER_ROUTE = /#\/player(?:\/|$|\?|#)/;
  const BOARD_HASH = '#/board';
  const COLD_START_MS = 8000;
  const ROUTE_WATCH_MS = 250;

  const coldStartEndsAt = Date.now() + COLD_START_MS;
  let streamSessionAllowed = false;
  let routeWatchTimer = null;

  function isPlayerRoute() {
    return PLAYER_ROUTE.test(location.hash || '');
  }

  function isColdStartActive() {
    return Date.now() < coldStartEndsAt && !streamSessionAllowed;
  }

  function boardUrl() {
    return `${location.pathname || '/index.html'}${location.search || ''}${BOARD_HASH}`;
  }

  function ensureOpaqueFallback() {
    if (isPlayerRoute() && streamSessionAllowed) return;
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

  function redirectStalePlayerRoute(reason) {
    if (!isPlayerRoute() || streamSessionAllowed) return false;
    const target = boardUrl();
    if (`${location.pathname}${location.search}${location.hash}` === target) return false;
    console.info(`[StremioCustom] ${reason} — redirecting to board`);
    history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
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
      if (!isColdStartActive()) {
        stopRouteWatch();
        return;
      }
      redirectStalePlayerRoute('Stale player route during cold start');
    }, ROUTE_WATCH_MS);
  }

  function onStreamActivity() {
    if (!isPlayerRoute()) return;
    allowPlayerSession('stream-activity');
  }

  window.__stremioCustomIsColdStartPlayerBlocked = function () {
    return isPlayerRoute() && isColdStartActive();
  };

  window.__stremioCustomStartupGuardEnsure = function () {
    if (window.__stremioCustomBootstrapReady) return;
    ensureOpaqueFallback();
  };

  window.__stremioCustomDismissStartupOverlays = function () {
    clearOpaqueFallback();
    stopRouteWatch();
    const mask = document.getElementById('stremio-custom-app-loading-mask');
    if (mask) {
      mask.classList.remove('visible');
      mask.style.display = 'none';
      mask.style.opacity = '0';
      mask.style.pointerEvents = 'none';
    }
  };

  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    window.__stremioCustomBootstrapReady = true;
    window.__stremioCustomDismissStartupOverlays?.();
  });

  ensureOpaqueFallback();
  redirectStalePlayerRoute('Cold start player route without stream');
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
    if (window.__stremioCustomBootstrapReady) return;
    if (!isPlayerRoute()) {
      ensureOpaqueFallback();
      return;
    }
    if (isColdStartActive()) {
      ensureOpaqueFallback();
      redirectStalePlayerRoute('Player route blocked during cold start');
      return;
    }
    clearOpaqueFallback();
  });

  window.setTimeout(() => {
    stopRouteWatch();
    if (!window.__stremioCustomBootstrapReady && !isPlayerRoute()) ensureOpaqueFallback();
  }, COLD_START_MS + 50);

  console.info('[StremioCustom] Startup guard ready.');
})();
