(function () {
  'use strict';

  if (window.__stremioCustomPlayerLoading) return;
  window.__stremioCustomPlayerLoading = true;

  const STYLE_ID = 'stremio-custom-player-loading-style';
  const APP_LOADING_STYLE_ID = 'stremio-custom-app-loading-style';
  const APP_LOADING_MASK_ID = 'stremio-custom-app-loading-mask';
  const TOP_SEAM_FIX_STYLE_ID = 'stremio-custom-top-seam-fix';

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

  function injectAppLoadingStyles() {
    if (document.getElementById(APP_LOADING_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = APP_LOADING_STYLE_ID;
    style.textContent = `
      #${APP_LOADING_MASK_ID} {
        position: fixed;
        inset: 0;
        z-index: 119;
        background: rgb(20, 20, 20);
        opacity: 0;
        display: none;
        pointer-events: none;
        transition: opacity 120ms ease;
      }
      #${APP_LOADING_MASK_ID}.visible {
        display: block;
        opacity: 1;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureAppLoadingMask() {
    injectAppLoadingStyles();
    let mask = document.getElementById(APP_LOADING_MASK_ID);
    if (!mask) {
      mask = document.createElement('div');
      mask.id = APP_LOADING_MASK_ID;
      document.body.appendChild(mask);
    }
    return mask;
  }

  function ensureTopSeamFix() {
    if (document.getElementById(TOP_SEAM_FIX_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = TOP_SEAM_FIX_STYLE_ID;
    style.textContent = `
      .hero-container,
      [class*="hero-container"] {
        border-top: 0 !important;
      }
      .main-nav-bars-container-wNjS5 .nav-content-container-zl9hQ,
      [class*="main-nav-bars-container"] [class*="nav-content-container"] {
        border-top: 0 !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  let appMaskTimer = null;
  function showAppLoadingMask(ms = 220) {
    const mask = ensureAppLoadingMask();
    if (!mask) return;
    mask.style.display = 'block';
    mask.classList.add('visible');
    if (appMaskTimer) clearTimeout(appMaskTimer);
    appMaskTimer = setTimeout(() => {
      mask.classList.remove('visible');
      setTimeout(() => {
        if (!mask.classList.contains('visible')) mask.style.display = 'none';
      }, 140);
    }, ms);
  }

  function showBootLoadingMaskUntilReady() {
    if (!document.body) return;
    showAppLoadingMask(1400);
    const hideWhenReady = () => {
      setTimeout(() => {
        const mask = document.getElementById(APP_LOADING_MASK_ID);
        if (mask) mask.classList.remove('visible');
      }, 60);
    };
    document.addEventListener('stremio-custom-bootstrap-ready', hideWhenReady, { once: true });
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
    window.__stremioCustomPlayerLoadingTimer = window.setInterval(syncPlayerLoadingState, 450);
  }

  function stopWatcher() {
    if (!window.__stremioCustomPlayerLoadingTimer) return;
    window.clearInterval(window.__stremioCustomPlayerLoadingTimer);
    window.__stremioCustomPlayerLoadingTimer = null;
  }

  window.__stremioCustomPlayerLoadingEnsure = syncPlayerLoadingState;

  window.addEventListener('hashchange', () => {
    showAppLoadingMask(isPlayerRoute() ? 340 : 190);
    if (isPlayerRoute()) startWatcher();
    else stopWatcher();
    syncPlayerLoadingState();
  });

  document.addEventListener('stremio-custom-bootstrap-ready', syncPlayerLoadingState);

  if (isPlayerRoute()) startWatcher();
  else injectStyles();
  ensureTopSeamFix();
  showBootLoadingMaskUntilReady();

  console.info('[StremioCustom] Player loading backdrop ready.');
})();
