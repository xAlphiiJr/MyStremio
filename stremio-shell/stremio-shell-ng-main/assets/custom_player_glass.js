(function () {
  'use strict';

  const STYLE_ID = 'stremio-custom-player-glass';

  const PLAYER_GLASS_BG = 'rgba(42, 42, 46, 0.58)';
  const PLAYER_GLASS_BORDER = 'rgba(255, 255, 255, 0.14)';
  const PLAYER_GLASS_SHADOW =
    '0 8px 32px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.18)';

  const GLASS_CSS = `
    :root {
      --primary-accent-color: #ffffff !important;
      --primary-foreground-color: #ffffff !important;
      --overlay-color: rgba(255, 255, 255, 0.22) !important;
      --modal-background-color: rgba(70, 70, 70, 0.72) !important;
      --backdrop-filter: blur(20px) saturate(180%) !important;
      --stremio-player-glass-bg: ${PLAYER_GLASS_BG};
      --stremio-player-glass-border: ${PLAYER_GLASS_BORDER};
    }

    html body [class*="player-container"] [class*="control-bar-layer"]::before,
    html body [class*="player-container"] [class*="nav-bar-layer"]::before {
      display: none !important;
    }

    html body [class*="player-container"] [class*="control-bar-container"] [class*="control-bar-buttons-container"] {
      align-items: center !important;
      display: flex !important;
      flex-direction: row !important;
      gap: 0.25rem !important;
      background: ${PLAYER_GLASS_BG} !important;
      border-radius: 20px !important;
      box-shadow: ${PLAYER_GLASS_SHADOW} !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      border: 1px solid ${PLAYER_GLASS_BORDER} !important;
      margin-bottom: 10px !important;
      min-height: 52px !important;
      padding: 0 0.4rem !important;
    }

    html body [class*="player-container"] [class*="control-bar-button"]:hover:not(.disabled) {
      background: rgba(255, 255, 255, 0.12) !important;
    }

    html body [class*="player-container"] [class*="slider-container"] [class*="track"] {
      background-color: rgba(255, 255, 255, 0.28) !important;
      background-image: none !important;
      opacity: 1 !important;
      border-radius: 999px !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }

    html body [class*="player-container"] [class*="seek-bar-container"] [class*="slider-container"] [class*="track"]:not([class*="track-before"]):not([class*="track-after"]) {
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }

    html body [class*="player-container"] [class*="slider-container"] [class*="track-after"],
    html body [class*="player-container"] [class*="slider-container"] [class*="thumb"] {
      background-color: #ffffff !important;
      background-image: none !important;
    }

    html body [class*="player-container"] [class*="slider-container"] [class*="track-before"] {
      background-color: rgba(255, 255, 255, 0.45) !important;
      opacity: 1 !important;
    }

    html body [class*="player-container"] [class*="menu-layer"],
    html body [class*="player-container"] [class*="side-drawer-button-layer"],
    html body [class*="player-container"] [class*="nav-menu-container"],
    html body [class*="player-container"] [class*="menu-container"][class*="menu-direction"] {
      background: var(--stremio-player-glass-bg, ${PLAYER_GLASS_BG}) !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      border: 1px solid var(--stremio-player-glass-border, ${PLAYER_GLASS_BORDER}) !important;
      box-shadow: ${PLAYER_GLASS_SHADOW} !important;
    }

    html body [class*="player-container"] [class*="menu-layer"],
    html body [class*="player-container"] [class*="side-drawer-button-layer"] {
      border-radius: 20px !important;
    }

    html body [class*="player-container"] [class*="nav-menu-container"] {
      border-radius: 16px !important;
    }

    html.stremio-custom-player-route .context-menu-portal [class*="nav-menu-container"],
    html.stremio-custom-player-route .context-menu-portal [class*="menu-container"][class*="menu-direction"] {
      background: var(--stremio-player-glass-bg, ${PLAYER_GLASS_BG}) !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      border: 1px solid var(--stremio-player-glass-border, ${PLAYER_GLASS_BORDER}) !important;
      box-shadow: ${PLAYER_GLASS_SHADOW} !important;
    }
  `;

  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  function hasTheme() {
    try {
      const theme = localStorage.getItem('currentTheme') || '';
      if (theme && theme !== 'Default') return true;
    } catch (_) {}
    return Boolean(document.getElementById('stremio-custom-active-theme'));
  }

  function ensurePlayerGlassStyles() {
    if (!isPlayerRoute() || !hasTheme()) {
      document.getElementById(STYLE_ID)?.remove();
      return;
    }
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = GLASS_CSS;
    if (typeof window.__stremioCustomPlayerTransparencyEnsure === 'function') {
      window.__stremioCustomPlayerTransparencyEnsure();
    }
  }

  document.getElementById('mystremio-player-window-chrome')?.remove();

  window.__stremioCustomPlayerGlassEnsure = ensurePlayerGlassStyles;
  window.__stremioCustomPlayerGlassCss = GLASS_CSS;

  if (!window.__stremioCustomPlayerGlassBootstrapped) {
    window.__stremioCustomPlayerGlassBootstrapped = true;
    ensurePlayerGlassStyles();
    document.addEventListener('stremio-custom-route-change', () => {
      ensurePlayerGlassStyles();
      setTimeout(ensurePlayerGlassStyles, 300);
      setTimeout(ensurePlayerGlassStyles, 1500);
    });
    document.addEventListener('stremio-custom-bootstrap-ready', ensurePlayerGlassStyles);
    let ticks = 0;
    const timer = setInterval(() => {
      if (!isPlayerRoute()) {
        if (ticks > 3) clearInterval(timer);
        return;
      }
      ticks += 1;
      ensurePlayerGlassStyles();
      if (ticks >= 45) clearInterval(timer);
    }, 2000);
  }

  console.info('[StremioCustom] Player glass module ready.');
})();
