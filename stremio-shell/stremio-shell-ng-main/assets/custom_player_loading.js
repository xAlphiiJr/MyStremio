(function () {
  'use strict';

  /**
   * MyStremio Player Session — single authority for player load + MPV visibility.
   *
   * Stremio native layers (poster + pulsing logo) are used while loading.
   * When MPV is ready we punch a transparent viewport hole and hide those layers.
   * Does NOT block ShellVideo loaded/buffering signals.
   */

  if (window.__stremioCustomPlayerSession) return;
  window.__stremioCustomPlayerSession = true;

  const STYLE_ID = 'stremio-custom-player-session-style';
  const SESSION_CLASS = 'mystremio-player-session';
  const MPV_VISIBLE_CLASS = 'mystremio-mpv-visible';
  const APP_LOADING_MASK_ID = 'stremio-custom-app-loading-mask';
  const APP_LOADING_STYLE_ID = 'stremio-custom-app-loading-style';
  const TOP_SEAM_FIX_STYLE_ID = 'stremio-custom-top-seam-fix';

  const Phase = { IDLE: 'idle', LOADING: 'loading', VIDEO: 'video' };

  const READY_TIME_SEC = 0.35;
  const MAX_LOAD_MS = 20000;
  const VIEWPORT_PUNCH_MS = [0, 120, 350];
  const VIEWPORT_MAINTAIN_MS = 5000;

  let phase = Phase.IDLE;
  let sessionId = 0;
  let loadStartedAt = 0;
  let pendingSession = false;
  let maxTimer = null;
  let viewportTimers = [];
  let pollTimer = null;
  let lastViewportMaintainAt = 0;
  let brandObserver = null;

  let artwork = { background: null, logo: null, imdbId: null };

  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  function shouldEnterPlayerSession() {
    if (!isPlayerRoute()) return false;
    if (typeof window.__stremioCustomIsColdStartPlayerBlocked === 'function') {
      return !window.__stremioCustomIsColdStartPlayerBlocked();
    }
    return true;
  }

  function extractImdbId(value) {
    if (!value || typeof value !== 'string') return null;
    const match = value.match(/tt\d{7,8}/i);
    return match ? match[0] : null;
  }

  function metahubFromId(id) {
    const imdbId = extractImdbId(id);
    if (!imdbId) return null;
    return {
      background: `https://images.metahub.space/background/large/${imdbId}/img`,
      logo: `https://images.metahub.space/logo/medium/${imdbId}/img`,
    };
  }

  function isUsableImageSrc(src) {
    return Boolean(src && typeof src === 'string' && !/^data:,?$/.test(src));
  }

  function isStremioDefaultLogo(src) {
    return Boolean(src && /stremio_symbol|\/logo\.png/i.test(src));
  }

  function enrichArtwork(background, logo, idHint) {
    const hub = metahubFromId(idHint || background || '');
    let bg = background || null;
    let lg = logo || null;
    if (hub) {
      bg = hub.background;
      if (!lg || isStremioDefaultLogo(lg)) lg = hub.logo;
    }
    if (!isUsableImageSrc(bg) && !isUsableImageSrc(lg)) return null;
    return {
      background: bg,
      logo: lg,
      imdbId: extractImdbId(idHint || '') || extractImdbId(bg || '') || null,
    };
  }

  function resolveBackgroundUrl() {
    return metahubFromId(artwork.imdbId || artwork.background)?.background || artwork.background;
  }

  function resolveLogoUrl() {
    return metahubFromId(artwork.imdbId || artwork.background)?.logo || artwork.logo;
  }

  function injectSessionStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html.${SESSION_CLASS}.${MPV_VISIBLE_CLASS} [class*="player-container"] {
        background: transparent !important;
        background-color: transparent !important;
      }
      html.${SESSION_CLASS}.${MPV_VISIBLE_CLASS} [class*="player-container"] [class*="video-container"],
      html.${SESSION_CLASS}.${MPV_VISIBLE_CLASS} [class*="player-container"] [class*="rendering"],
      html.${SESSION_CLASS}.${MPV_VISIBLE_CLASS} [class*="player-container"] [class*="shell-video"],
      html.${SESSION_CLASS}.${MPV_VISIBLE_CLASS} [class*="player-container"] > [class*="layer-"]:not([class*="background"]):not([class*="buffering"]):not([class*="control"]):not([class*="nav-bar"]):not([class*="menu"]):not([class*="info"]):not([class*="side-drawer"]) {
        background: transparent !important;
        background-color: transparent !important;
      }
      html.${SESSION_CLASS}.${MPV_VISIBLE_CLASS} [class*="player-container"] [class*="background-layer"],
      html.${SESSION_CLASS}.${MPV_VISIBLE_CLASS} [class*="player-container"] [class*="buffering-layer"] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
      html.${SESSION_CLASS}:not(.${MPV_VISIBLE_CLASS}) [class*="player-container"] [class*="buffering-layer"] img[src*="stremio_symbol"],
      html.${SESSION_CLASS}:not(.${MPV_VISIBLE_CLASS}) [class*="player-container"] [class*="buffering-layer"] img[src*="/logo.png"] {
        display: none !important;
      }
      html.${SESSION_CLASS}:not(.${MPV_VISIBLE_CLASS}) [class*="player-container"] [class*="buffering-layer"] [class*="logo"],
      html.${SESSION_CLASS}:not(.${MPV_VISIBLE_CLASS}) [class*="player-container"] [class*="buffering-layer"] img[class*="logo"] {
        max-width: 15rem !important;
        max-height: 15rem !important;
      }
      html.${SESSION_CLASS}:not(.${MPV_VISIBLE_CLASS}) [class*="player-container"] [class*="background-layer"] [class*="image"] {
        object-fit: cover !important;
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
        position: fixed; inset: 0; z-index: 119;
        background: rgb(20, 20, 20); opacity: 0; display: none;
        pointer-events: none; transition: opacity 120ms ease;
      }
      #${APP_LOADING_MASK_ID}.content-only { top: var(--horizontal-nav-bar-size, 5.5rem); }
      #${APP_LOADING_MASK_ID}.visible { display: block; opacity: 1; }
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
      html, body, #app,
      [class*="hero-container"], [class*="hero-slot"],
      [class*="main-nav-bars-container"], [class*="nav-content-container"],
      #app nav[class*="horizontal-nav-bar"] {
        border-top: 0 !important; margin-top: 0 !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  let appMaskTimer = null;
  function showAppLoadingMask(ms = 220, options = {}) {
    const mask = ensureAppLoadingMask();
    if (!mask) return;
    mask.classList.toggle('content-only', Boolean(options.contentOnly));
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

  function hideAppLoadingMask() {
    const mask = document.getElementById(APP_LOADING_MASK_ID);
    if (!mask) return;
    if (appMaskTimer) {
      clearTimeout(appMaskTimer);
      appMaskTimer = null;
    }
    mask.classList.remove('visible');
    mask.style.display = 'none';
    mask.style.opacity = '0';
    mask.style.pointerEvents = 'none';
  }

  window.__stremioCustomHideAppLoadingMask = hideAppLoadingMask;

  function showBootLoadingMaskUntilReady() {
    // Native splash covers cold start; avoid a second full-screen mask that can get stuck.
    hideAppLoadingMask();
  }

  function playerRoot() {
    return document.querySelector('[class*="player-container"]');
  }

  function shellVideoLoaded() {
    const root = playerRoot();
    if (!root) return false;
    return !root.querySelector('[class*="background-layer"]');
  }

  function applySeriesBranding() {
    if (phase !== Phase.LOADING || !isPlayerRoute()) return;
    const root = playerRoot();
    if (!root) return;

    const bgUrl = resolveBackgroundUrl();
    if (isUsableImageSrc(bgUrl)) {
      const poster = root.querySelector('[class*="background-layer"] img');
      if (poster && poster.getAttribute('src') !== bgUrl) poster.setAttribute('src', bgUrl);
    }

    const logoUrl = resolveLogoUrl();
    if (isUsableImageSrc(logoUrl)) {
      for (const logo of root.querySelectorAll('[class*="buffering-layer"] img')) {
        const src = logo.getAttribute('src') || '';
        if (isStremioDefaultLogo(src) || !isUsableImageSrc(src)) {
          logo.setAttribute('src', logoUrl);
          logo.style.display = '';
        }
      }
    }
  }

  function mergeArtwork(patch) {
    if (!patch || typeof patch !== 'object') return false;
    const enriched = enrichArtwork(
      patch.background || artwork.background,
      patch.logo || artwork.logo,
      patch.id || patch.imdb_id || patch.imdbId || artwork.imdbId
    );
    if (!enriched) return false;
    artwork = { ...artwork, ...enriched };
    applySeriesBranding();
    return true;
  }

  function clearViewportTimers() {
    for (const id of viewportTimers) window.clearTimeout(id);
    viewportTimers = [];
  }

  function punchMpvViewport() {
    window.__stremioCustomPlayerTransparencyEnsure?.();
    window.StremioCustomPlayback?.refreshMpvViewport?.();

    const root = playerRoot();
    if (!root) return;

    root.style.backgroundColor = 'transparent';
    const transparentSelectors = [
      '[class*="video-container"]',
      '[class*="rendering"]',
      '[class*="shell-video"]',
    ];
    for (const sel of transparentSelectors) {
      for (const el of root.querySelectorAll(sel)) {
        el.style.backgroundColor = 'transparent';
      }
    }
  }

  function maintainMpvViewport() {
    const now = Date.now();
    if (now - lastViewportMaintainAt < VIEWPORT_MAINTAIN_MS) return;
    lastViewportMaintainAt = now;
    punchMpvViewport();
  }

  function scheduleViewportPunch() {
    clearViewportTimers();
    for (const delay of VIEWPORT_PUNCH_MS) {
      viewportTimers.push(window.setTimeout(punchMpvViewport, delay));
    }
  }

  function setPhase(next) {
    phase = next;
    const html = document.documentElement;
    html.classList.toggle(SESSION_CLASS, next !== Phase.IDLE);
    html.classList.toggle(MPV_VISIBLE_CLASS, next === Phase.VIDEO);

    if (next === Phase.VIDEO) {
      stopBrandObserver();
      scheduleViewportPunch();
    } else if (next === Phase.LOADING) {
      html.classList.remove(MPV_VISIBLE_CLASS);
      applySeriesBranding();
      startBrandObserver();
      punchMpvViewport();
    } else {
      html.classList.remove(MPV_VISIBLE_CLASS);
      stopBrandObserver();
      clearViewportTimers();
    }
  }

  function mpvReadyForVideo() {
    const snap = window.StremioCustomPlayback?.getMpvSnapshot?.();
    if (!snap?.hasStream) return false;
    if (snap.buffering) return false;
    if (!snap.timeFresh) return false;
    if (snap.position < READY_TIME_SEC) return false;
    return true;
  }

  function checkReady() {
    if (phase !== Phase.LOADING) return;
    if (mpvReadyForVideo()) {
      setPhase(Phase.VIDEO);
      window.StremioCustomPlayback?.nudgePlayback?.();
      scheduleViewportPunch();
      return true;
    }
    return false;
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = window.setInterval(() => {
      if (phase === Phase.LOADING) checkReady();
      else if (phase === Phase.VIDEO) maintainMpvViewport();
    }, 250);
  }

  function stopPoll() {
    if (!pollTimer) return;
    window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function startBrandObserver() {
    if (brandObserver) return;
    const root = playerRoot();
    if (!root) return;
    brandObserver = new MutationObserver(() => {
      if (phase === Phase.LOADING) applySeriesBranding();
      if (phase === Phase.LOADING && shellVideoLoaded()) checkReady();
    });
    brandObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class'] });
  }

  function stopBrandObserver() {
    if (!brandObserver) return;
    brandObserver.disconnect();
    brandObserver = null;
  }

  function clearMaxTimer() {
    if (maxTimer) {
      window.clearTimeout(maxTimer);
      maxTimer = null;
    }
  }

  function beginSession() {
    if (!isPlayerRoute()) {
      pendingSession = true;
      return;
    }

    pendingSession = false;

    if (phase === Phase.VIDEO) {
      scheduleViewportPunch();
      return;
    }

    sessionId += 1;
    loadStartedAt = Date.now();
    clearMaxTimer();

    injectSessionStyles();
    setPhase(Phase.LOADING);
    startPoll();

    applySeriesBranding();
    window.StremioCustomPlayback?.onPlayerSessionStart?.();

    maxTimer = window.setTimeout(() => {
      if (phase === Phase.LOADING) {
        setPhase(Phase.VIDEO);
        window.StremioCustomPlayback?.nudgePlayback?.();
        scheduleViewportPunch();
      }
    }, MAX_LOAD_MS);
  }

  function endSession() {
    clearMaxTimer();
    stopPoll();
    setPhase(Phase.IDLE);
    pendingSession = false;
    artwork = { background: null, logo: null, imdbId: null };
    window.StremioCustomPlayback?.onPlayerSessionEnd?.();
  }

  function onStreamStarted() {
    beginSession();
  }

  function onPlayerEnter() {
    if (pendingSession || phase === Phase.IDLE) {
      beginSession();
      return;
    }
    if (phase === Phase.VIDEO) scheduleViewportPunch();
    else punchMpvViewport();
  }

  function onPlayerLeave(options = {}) {
    const hadActiveSession = phase !== Phase.IDLE || pendingSession;
    endSession();
    if (!options.silent && hadActiveSession) {
      showAppLoadingMask(190, { contentOnly: true });
    } else {
      hideAppLoadingMask();
    }
  }

  window.StremioCustomPlayerSplash = { cacheArtwork: mergeArtwork };

  window.__stremioCustomPlayerLoadingEnsure = () => {
    if (shouldEnterPlayerSession()) onPlayerEnter();
    else onPlayerLeave({ silent: true });
  };

  window.addEventListener('hashchange', () => {
    if (!isPlayerRoute()) onPlayerLeave();
    else onPlayerEnter();
  });

  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    if (shouldEnterPlayerSession()) onPlayerEnter();
  });
  document.addEventListener('stremio-custom-stream-started', onStreamStarted);
  document.addEventListener('stremio-custom-mpv-time', () => {
    if (phase === Phase.LOADING) checkReady();
  });
  document.addEventListener('stremio-custom-player-artwork', (e) => mergeArtwork(e?.detail));

  injectSessionStyles();
  ensureTopSeamFix();
  showBootLoadingMaskUntilReady();
  if (shouldEnterPlayerSession()) onPlayerEnter();

  console.info('[StremioCustom] Player session manager ready.');
})();
