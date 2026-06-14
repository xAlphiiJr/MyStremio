(function () {
  'use strict';

  if (window.__stremioCustomPlayerLoading) return;
  window.__stremioCustomPlayerLoading = true;

  const STYLE_ID = 'stremio-custom-player-loading-style';

  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html.stremio-custom-player-route [class*="player-container"] [class*="buffering-layer"] img[src*="stremio_symbol"],
      html.stremio-custom-player-route [class*="player-container"] [class*="buffering-layer"] img[src*="stremio-logo"],
      html.stremio-custom-player-route [class*="player-container"] [class*="buffering-layer"] svg {
        display: none !important;
        opacity: 0 !important;
        visibility: hidden !important;
      }

      html.stremio-custom-player-route.stremio-custom-player-buffering [class*="player-container"] [class*="buffering-layer"] [class*="logo"] {
        opacity: 1 !important;
        visibility: visible !important;
        display: block !important;
      }

      html.stremio-custom-player-route.stremio-custom-player-buffering [class*="player-container"] [class*="buffering-layer"] [class*="logo"] img:not([src*="stremio_symbol"]):not([src*="stremio-logo"]) {
        opacity: 1 !important;
        visibility: visible !important;
        display: block !important;
        max-width: min(42vw, 22rem) !important;
        max-height: min(28vh, 14rem) !important;
        width: auto !important;
        height: auto !important;
      }

      html.stremio-custom-player-route.stremio-custom-player-buffering [class*="player-container"] [class*="background-layer"],
      html.stremio-custom-player-route.stremio-custom-player-buffering [class*="player-container"] [class*="background-layer"] [class*="image"] {
        opacity: 1 !important;
        visibility: visible !important;
      }

      html.stremio-custom-player-route.stremio-custom-player-playing [class*="player-container"] [class*="background-layer"],
      html.stremio-custom-player-route.stremio-custom-player-playing [class*="player-container"] [class*="background-layer"] [class*="image"] {
        opacity: 0 !important;
        visibility: hidden !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function isBufferingVisible(layer) {
    if (!layer) return false;
    const style = window.getComputedStyle(layer);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
      return false;
    }
    return layer.offsetWidth > 0 && layer.offsetHeight > 0;
  }

  function syncPlayerLoadingState() {
    injectStyles();
    const html = document.documentElement;
    if (!isPlayerRoute()) {
      html.classList.remove('stremio-custom-player-buffering', 'stremio-custom-player-playing');
      return;
    }

    const bufferingLayer = document.querySelector('[class*="player-container"] [class*="buffering-layer"]');
    const buffering = isBufferingVisible(bufferingLayer);

    html.classList.toggle('stremio-custom-player-buffering', buffering);
    html.classList.toggle('stremio-custom-player-playing', !buffering);
  }

  function startWatcher() {
    syncPlayerLoadingState();
    if (window.__stremioCustomPlayerLoadingTimer) return;
    window.__stremioCustomPlayerLoadingTimer = window.setInterval(syncPlayerLoadingState, 250);
  }

  function stopWatcher() {
    if (!window.__stremioCustomPlayerLoadingTimer) return;
    window.clearInterval(window.__stremioCustomPlayerLoadingTimer);
    window.__stremioCustomPlayerLoadingTimer = null;
  }

  window.__stremioCustomPlayerLoadingEnsure = syncPlayerLoadingState;

  window.addEventListener('hashchange', () => {
    if (isPlayerRoute()) startWatcher();
    else stopWatcher();
    syncPlayerLoadingState();
  });

  document.addEventListener('stremio-custom-bootstrap-ready', syncPlayerLoadingState);

  if (isPlayerRoute()) startWatcher();
  else injectStyles();

  console.info('[StremioCustom] Player loading backdrop ready.');
})();
