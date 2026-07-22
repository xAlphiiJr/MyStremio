/**
 * @name Cast Overlay
 * @description Player cast bubble (audio-menu style) with photos from TMDB
 * @version 1.0.6
 * @author MyStremio
 * @category player
 */
/* jshint esversion: 11, browser: true, devel: true */

(function () {
  'use strict';

  const PLUGIN_VERSION = '1.0.6';
  const PLUGIN_REF = 'player/cast-overlay.plugin.js';
  const PLUGIN_ID = 'cast-overlay';
  const BTN_ID = 'mystremio-cast-overlay-btn';
  const OVERLAY_ID = 'mystremio-cast-overlay';
  const STYLE_ID = 'mystremio-cast-overlay-styles';
  const CONTRIBUTE_BTN_ID = 'tidb-contribute-btn';
  const OVERLAY_LOCK_CLASS = 'mystremio-cast-overlay-lock';
  const ICON_SIZE = '2.0rem';
  /** Series Cast on TMDB uses aggregate_credits; keep a generous list for the bubble. */
  const MAX_CAST = 40;
  const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w185';
  const GLASS_BG = 'rgba(42, 42, 46, 0.58)';
  const GLASS_BORDER = 'rgba(255, 255, 255, 0.14)';
  const GLASS_SHADOW = '0 8px 32px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.18)';

  let overlayOpen = false;
  let outsideHandler = null;
  let keyHandler = null;
  let ensureTimer = null;
  let layoutObserver = null;
  let uiWatcher = null;
  let chromeIdleWatcher = null;

  /**
   * @returns {boolean}
   */
  function isOverlayHidden() {
    const el = document.querySelector('[class*="player-container"]');
    if (!el) return false;
    for (const className of el.classList) {
      if (String(className).includes('overlayHidden')) return true;
    }
    return false;
  }
  let overlayTimer = null;
  let overlayObserver = null;
  let dismissGuardUntil = 0;
  let fetchGeneration = 0;
  const castCache = new Map();

  /**
   * @returns {boolean}
   */
  function isCastOverlayEnabled() {
    const helpers = window.StremioCustom?.helpers;
    if (!helpers?.isPluginEnabled) return false;
    return helpers.isPluginEnabled(PLUGIN_REF);
  }

  /**
   * @returns {object|null}
   */
  function getSettingsApi() {
    return window.StremioCustomAPI || window.StremioEnhancedAPI || null;
  }

  /**
   * @returns {boolean}
   */
  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  /**
   * Extracts an IMDb id from the current player route hash.
   * @returns {string|null}
   */
  function extractImdbFromRoute() {
    const match = (location.hash || location.href).match(/tt\d{7,8}/i);
    return match ? match[0].toLowerCase() : null;
  }

  /**
   * Resolves the TMDB API key from this plugin's own settings only.
   * @returns {Promise<string|null>}
   */
  async function getTmdbApiKey() {
    const api = getSettingsApi();
    if (!api?.getSetting) return null;

    try {
      const ownKey = await api.getSetting(PLUGIN_ID, 'tmdbApiKey');
      if (ownKey && String(ownKey).trim()) return String(ownKey).trim();
    } catch (_) {}

    return null;
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Fetches cast members for an IMDb id via TMDB find + credits endpoints.
   * @param {string} imdbId
   * @param {string} apiKey
   * @returns {Promise<Array<{name:string, character:string, photo:string|null}>>}
   */
  async function fetchCastFromTmdb(imdbId, apiKey) {
    const cacheKey = `${imdbId}:${apiKey.slice(0, 6)}`;
    if (castCache.has(cacheKey)) return castCache.get(cacheKey);

    const findResponse = await fetch(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id`
    );
    if (!findResponse.ok) throw new Error('TMDB find request failed');

    const findData = await findResponse.json();
    let tmdbId = null;
    let mediaType = 'movie';
    const prefersSeries = /tt\d{7,8}:\d+:\d+/i.test(location.hash || location.href);

    if (prefersSeries && findData.tv_results?.[0]) {
      tmdbId = findData.tv_results[0].id;
      mediaType = 'tv';
    } else if (findData.movie_results?.[0]) {
      tmdbId = findData.movie_results[0].id;
      mediaType = 'movie';
    } else if (findData.tv_results?.[0]) {
      tmdbId = findData.tv_results[0].id;
      mediaType = 'tv';
    }

    if (!tmdbId) throw new Error('No TMDB match for this title');

    // TV "Series Cast" lives in aggregate_credits; plain /credits is often tiny (3–5 people).
    const creditsPath =
      mediaType === 'tv'
        ? `https://api.themoviedb.org/3/tv/${tmdbId}/aggregate_credits?api_key=${encodeURIComponent(apiKey)}`
        : `https://api.themoviedb.org/3/movie/${tmdbId}/credits?api_key=${encodeURIComponent(apiKey)}`;

    const creditsResponse = await fetch(creditsPath);
    if (!creditsResponse.ok) throw new Error('TMDB credits request failed');

    const credits = await creditsResponse.json();
    const rawCast = Array.isArray(credits.cast) ? [...credits.cast] : [];
    if (mediaType === 'tv') {
      rawCast.sort(
        (a, b) =>
          Number(b.total_episode_count || b.roles?.[0]?.episode_count || 0) -
          Number(a.total_episode_count || a.roles?.[0]?.episode_count || 0)
      );
    }

    const cast = rawCast.slice(0, MAX_CAST).map((actor) => {
      const character =
        actor.character ||
        actor.roles?.[0]?.character ||
        (Array.isArray(actor.roles)
          ? actor.roles.map((role) => role.character).filter(Boolean).join(' / ')
          : '') ||
        '';
      return {
        name: actor.name || '',
        character,
        photo: actor.profile_path ? `${TMDB_IMAGE_BASE}${actor.profile_path}` : null,
      };
    });

    castCache.set(cacheKey, cast);
    return cast;
  }

  /**
   * @param {Event} event
   */
  function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  /**
   * @returns {Element|null}
   */
  function getButtonTemplate() {
    const container = document.querySelector(
      '[class*="player-container"] [class*="control-bar-buttons-container"]'
    );
    if (!container) return null;
    return container.querySelector('[class*="control-bar-button"]:not([class*="menu"])');
  }

  /**
   * @param {string} [className]
   * @returns {SVGSVGElement}
   */
  function buildCastIconSvg(className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute(
      'd',
      'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3.13a4 4 0 0 1 0 7.75M22 21v-2a4 4 0 0 0-3-3.87M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'
    );
    svg.appendChild(path);
    return svg;
  }

  /**
   * @param {Element} button
   */
  function replaceButtonIcon(button) {
    const iconWrap = button.querySelector('[class*="icon"]');
    const refSvg = button.querySelector('svg');
    const svgClass = refSvg?.getAttribute('class') || '';
    const svg = buildCastIconSvg(svgClass);

    if (iconWrap) {
      iconWrap.replaceChildren(svg);
      return;
    }
    if (refSvg) {
      refSvg.replaceWith(svg);
      return;
    }
    button.appendChild(svg);
  }

  /**
   * @param {Element|null} button
   * @returns {boolean}
   */
  function isStaleButton(button) {
    if (!button) return true;
    return !button.className.includes('control-bar-button');
  }

  function injectStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }

    style.textContent = `
      #${BTN_ID} {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        margin: 0 !important;
        padding: 0 !important;
        flex: none !important;
      }
      #${BTN_ID} [class*="button-container"] {
        display: none !important;
      }
      #${BTN_ID} [class*="icon"],
      #${BTN_ID} svg {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: ${ICON_SIZE} !important;
        height: ${ICON_SIZE} !important;
        min-width: ${ICON_SIZE} !important;
        min-height: ${ICON_SIZE} !important;
        margin: 0 !important;
        padding: 0 !important;
        line-height: 0 !important;
      }
      #${BTN_ID} svg {
        flex: none !important;
        fill: none !important;
        stroke: currentColor !important;
        pointer-events: none !important;
      }
      #${BTN_ID}.active {
        background: rgba(255, 255, 255, 0.12) !important;
      }
      #${OVERLAY_ID} {
        position: fixed;
        z-index: 2147483600;
        display: none;
        width: min(20.5rem, calc(100vw - 1.5rem));
        max-height: min(72vh, 40rem);
        /* Match native .menu-layer { right: 4rem; bottom: 7.5rem } */
        right: 4rem;
        left: auto;
        bottom: 7.5rem;
        top: auto;
        pointer-events: none;
        color: #fff;
        font-family: inherit;
      }
      #${OVERLAY_ID}.open {
        display: block;
      }
      #${OVERLAY_ID} .mystremio-cast-dialog {
        pointer-events: auto;
        width: 100%;
        max-height: inherit;
        display: flex;
        flex-direction: column;
        border-radius: 20px;
        border: 1px solid ${GLASS_BORDER};
        background: ${GLASS_BG};
        box-shadow: ${GLASS_SHADOW};
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        overflow: hidden;
      }
      #${OVERLAY_ID} .mystremio-cast-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.9rem 1rem 0.7rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        flex: none;
      }
      #${OVERLAY_ID} .mystremio-cast-title {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      #${OVERLAY_ID} .mystremio-cast-close {
        border: none;
        background: rgba(255, 255, 255, 0.08);
        color: rgba(255, 255, 255, 0.82);
        width: 1.85rem;
        height: 1.85rem;
        border-radius: 999px;
        cursor: pointer;
        font-size: 1.15rem;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #${OVERLAY_ID} .mystremio-cast-close:hover {
        background: rgba(255, 255, 255, 0.14);
        color: #fff;
      }
      #${OVERLAY_ID} .mystremio-cast-body {
        padding: 0.55rem 0.55rem 0.7rem;
        overflow: auto;
        flex: 1 1 auto;
        min-height: 0;
      }
      #${OVERLAY_ID} .mystremio-cast-status {
        padding: 1.6rem 1rem;
        text-align: center;
        color: rgba(255, 255, 255, 0.72);
        font-size: 0.9rem;
      }
      #${OVERLAY_ID} .mystremio-cast-status.error {
        color: #fca5a5;
      }
      #${OVERLAY_ID} .mystremio-cast-grid {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      #${OVERLAY_ID} .mystremio-cast-card {
        display: grid;
        grid-template-columns: 3.1rem minmax(0, 1fr);
        gap: 0.7rem;
        align-items: center;
        min-width: 0;
        padding: 0.55rem 0.6rem;
        border-radius: 12px;
        background: transparent;
      }
      #${OVERLAY_ID} .mystremio-cast-card:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      #${OVERLAY_ID} .mystremio-cast-photo-wrap {
        width: 3.1rem;
        height: 3.1rem;
        border-radius: 10px;
        overflow: hidden;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.08);
        flex: none;
      }
      #${OVERLAY_ID} .mystremio-cast-photo {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      #${OVERLAY_ID} .mystremio-cast-photo-placeholder {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: rgba(255, 255, 255, 0.28);
        font-size: 1.2rem;
      }
      #${OVERLAY_ID} .mystremio-cast-name {
        font-size: 0.9rem;
        font-weight: 600;
        line-height: 1.25;
      }
      #${OVERLAY_ID} .mystremio-cast-character {
        font-size: 0.74rem;
        line-height: 1.25;
        color: rgba(255, 255, 255, 0.58);
        margin-top: 0.12rem;
      }
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] {
        cursor: default !important;
      }
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="nav-bar-layer"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="control-bar-layer"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="menu-layer"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="side-drawer-button-layer"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="seek-bar-container"] {
        opacity: 1 !important;
        visibility: visible !important;
        pointer-events: auto !important;
      }
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] > [class*="layer-"]:not([class*="control"]):not([class*="nav-bar"]):not([class*="menu"]):not([class*="side-drawer"]):not([class*="background"]):not([class*="buffering"]),
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="video-container"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="seek-bar-container"] [class*="slider-container"] {
        pointer-events: none !important;
      }
    `;
  }

  /**
   * Native player menus use `.menu-layer { right: 4rem }` (2.5rem in narrow portrait).
   * @returns {string} CSS length for `right`
   */
  function getNativeMenuRightInsetCss() {
    const narrowPortrait =
      window.matchMedia('(orientation: portrait) and (max-width: 640px)').matches;
    return narrowPortrait ? '2.5rem' : '4rem';
  }

  /**
   * Anchors the cast bubble above the seek bar and right-aligns it like native menus.
   */
  function positionCastBubble() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay || !overlayOpen) return;

    const margin = 12;
    const seekBar = document.querySelector('[class*="player-container"] [class*="seek-bar-container"]');
    let bottom = 120;
    if (seekBar) {
      const seekRect = seekBar.getBoundingClientRect();
      bottom = Math.max(margin, window.innerHeight - seekRect.top + 10);
    }

    const topReserve = 4.5 * 16; // keep clear of top chrome
    const maxHeight = Math.max(180, window.innerHeight - bottom - topReserve);

    overlay.style.right = getNativeMenuRightInsetCss();
    overlay.style.left = 'auto';
    overlay.style.top = 'auto';
    overlay.style.bottom = `${bottom}px`;
    overlay.style.maxHeight = `${maxHeight}px`;
  }

  function lockPlayerOverlay() {
    document.documentElement.classList.add(OVERLAY_LOCK_CLASS);
    const playerContainer = document.querySelector('[class*="player-container"]');
    if (playerContainer) {
      playerContainer.classList.forEach((className) => {
        if (className.includes('overlayHidden')) {
          playerContainer.classList.remove(className);
        }
      });
    }
  }

  function unlockPlayerOverlay() {
    document.documentElement.classList.remove(OVERLAY_LOCK_CLASS);
    stopOverlayKeepAlive();
  }

  /**
   * Keeps cast overlay visible without a 350ms poll while the panel is open.
   */
  function stopOverlayKeepAlive() {
    if (overlayTimer) {
      window.clearInterval(overlayTimer);
      overlayTimer = null;
    }
    if (overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
    }
  }

  function startOverlayKeepAlive() {
    stopOverlayKeepAlive();
    if (!overlayOpen) return;
    lockPlayerOverlay();
    positionCastBubble();
    const playerContainer = document.querySelector('[class*="player-container"]');
    if (!playerContainer) return;
    overlayObserver = new MutationObserver(() => {
      if (!overlayOpen) {
        stopOverlayKeepAlive();
        return;
      }
      lockPlayerOverlay();
      positionCastBubble();
    });
    overlayObserver.observe(playerContainer, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  function armDismissGuard() {
    dismissGuardUntil = Date.now() + 500;
  }

  function isDismissGuardActive() {
    return Date.now() < dismissGuardUntil;
  }

  /**
   * @param {Array<{name:string, character:string, photo:string|null}>} cast
   * @returns {string}
   */
  function renderCastGridHtml(cast) {
    if (!cast.length) {
      return '<div class="mystremio-cast-status">No cast information found.</div>';
    }

    const cards = cast
      .map((member) => {
        const photoHtml = member.photo
          ? `<img class="mystremio-cast-photo" src="${escapeHtml(member.photo)}" alt="${escapeHtml(member.name)}" loading="lazy" />`
          : '<div class="mystremio-cast-photo-placeholder" aria-hidden="true">?</div>';

        return `
          <article class="mystremio-cast-card">
            <div class="mystremio-cast-photo-wrap">${photoHtml}</div>
            <div class="mystremio-cast-meta">
              <div class="mystremio-cast-name">${escapeHtml(member.name)}</div>
              <div class="mystremio-cast-character">${escapeHtml(member.character || '—')}</div>
            </div>
          </article>
        `;
      })
      .join('');

    return `<div class="mystremio-cast-grid">${cards}</div>`;
  }

  /**
   * Ensures the overlay root exists in the DOM.
   * @returns {HTMLElement}
   */
  function ensureOverlayRoot() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Cast');
    overlay.innerHTML = `
      <div class="mystremio-cast-dialog" data-mystremio-cast-dialog>
        <header class="mystremio-cast-header">
          <h2 class="mystremio-cast-title">Cast</h2>
          <button type="button" class="mystremio-cast-close" data-mystremio-cast-close aria-label="Close">×</button>
        </header>
        <div class="mystremio-cast-body" data-mystremio-cast-body>
          <div class="mystremio-cast-status">Loading cast…</div>
        </div>
      </div>
    `;

    overlay.querySelector('[data-mystremio-cast-close]')?.addEventListener('click', (event) => {
      stopEvent(event);
      closeOverlay();
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  /**
   * @param {string} html
   */
  function setOverlayBodyHtml(html) {
    const body = document.querySelector(`#${OVERLAY_ID} [data-mystremio-cast-body]`);
    if (body) body.innerHTML = html;
  }

  /**
   * Loads cast data and renders the overlay content.
   * @returns {Promise<void>}
   */
  async function loadOverlayContent() {
    const generation = ++fetchGeneration;
    setOverlayBodyHtml('<div class="mystremio-cast-status">Loading cast…</div>');

    const imdbId = extractImdbFromRoute();
    if (!imdbId) {
      setOverlayBodyHtml(
        '<div class="mystremio-cast-status error">Could not find an IMDb id in the player route.</div>'
      );
      return;
    }

    const apiKey = await getTmdbApiKey();
    if (!apiKey) {
      setOverlayBodyHtml(
        '<div class="mystremio-cast-status error">Add a TMDB API key in Settings → MyStremio → API Keys.</div>'
      );
      return;
    }

    try {
      const cast = await fetchCastFromTmdb(imdbId, apiKey);
      if (generation !== fetchGeneration || !overlayOpen) return;
      setOverlayBodyHtml(renderCastGridHtml(cast));
      positionCastBubble();
    } catch (error) {
      if (generation !== fetchGeneration || !overlayOpen) return;
      setOverlayBodyHtml(
        `<div class="mystremio-cast-status error">${escapeHtml(error.message || 'Failed to load cast.')}</div>`
      );
      positionCastBubble();
    }
  }

  function bindOverlayHandlers() {
    if (outsideHandler) return;

    outsideHandler = (event) => {
      if (!overlayOpen) return;
      const overlay = document.getElementById(OVERLAY_ID);
      const dialog = overlay?.querySelector('[data-mystremio-cast-dialog]');
      const button = document.getElementById(BTN_ID);
      const target = event.target;
      if (!(target instanceof Node) || !overlay || !dialog) return;
      if (button && button.contains(target)) {
        dismissGuardUntil = 0;
        return;
      }
      if (dialog.contains(target)) return;
      if (isDismissGuardActive()) {
        stopEvent(event);
        return;
      }

      // Block play/pause on the video surface; only close the cast bubble.
      armDismissGuard();
      stopEvent(event);
      closeOverlay();
    };

    keyHandler = (event) => {
      if (!overlayOpen) return;
      if (event.key === 'Escape') {
        stopEvent(event);
        closeOverlay();
      }
    };

    document.addEventListener('pointerdown', outsideHandler, true);
    document.addEventListener('mousedown', outsideHandler, true);
    document.addEventListener('click', outsideHandler, true);
    document.addEventListener('keydown', keyHandler);
  }

  function unbindOverlayHandlers() {
    if (outsideHandler) {
      document.removeEventListener('pointerdown', outsideHandler, true);
      document.removeEventListener('mousedown', outsideHandler, true);
      document.removeEventListener('click', outsideHandler, true);
      outsideHandler = null;
    }
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
  }

  function openOverlay() {
    if (!isCastOverlayEnabled()) return;

    injectStyles();
    ensureOverlayRoot();
    overlayOpen = true;
    fetchGeneration += 1;

    const overlay = document.getElementById(OVERLAY_ID);
    overlay?.classList.add('open');
    document.getElementById(BTN_ID)?.classList.add('active');
    lockPlayerOverlay();
    startOverlayKeepAlive();
    positionCastBubble();
    requestAnimationFrame(() => {
      if (overlayOpen) positionCastBubble();
    });
    bindOverlayHandlers();
    loadOverlayContent()
      .catch(() => {})
      .finally(() => {
        if (overlayOpen) positionCastBubble();
      });
  }

  function closeOverlay() {
    overlayOpen = false;
    fetchGeneration += 1;
    document.getElementById(OVERLAY_ID)?.classList.remove('open');
    document.getElementById(BTN_ID)?.classList.remove('active');
    unlockPlayerOverlay();
    unbindOverlayHandlers();
  }

  /**
   * @param {Element} button
   */
  function bindButtonHandler(button) {
    if (!button || button.dataset.mystremioCastOverlayBound === '1') return;
    button.dataset.mystremioCastOverlayBound = '1';

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (overlayOpen) closeOverlay();
      else openOverlay();
    });
  }

  function removeUi() {
    closeOverlay();
    document.getElementById(BTN_ID)?.remove();
    document.getElementById(OVERLAY_ID)?.remove();
  }

  /**
   * Places the Cast button in a stable slot: after Contribute (if present), else before menu.
   * @param {Element} button
   * @param {Element} container
   */
  function placeCastButton(button, container) {
    if (!button || !container) return;
    const menuButton = container.querySelector('[class*="control-bar-buttons-menu-button"]');
    const contribute = document.getElementById(CONTRIBUTE_BTN_ID);
    if (contribute && container.contains(contribute)) {
      if (button.previousElementSibling !== contribute) {
        container.insertBefore(button, contribute.nextSibling);
      }
      return;
    }
    if (menuButton && container.contains(menuButton)) {
      if (button.nextElementSibling !== menuButton) {
        container.insertBefore(button, menuButton);
      }
      return;
    }
    if (button.parentNode !== container) container.appendChild(button);
  }

  /**
   * @param {Element|null} button
   * @param {Element} container
   * @returns {boolean}
   */
  function isCastButtonPlaced(button, container) {
    if (!button || !container || !container.contains(button)) return false;
    const menuButton = container.querySelector('[class*="control-bar-buttons-menu-button"]');
    const contribute = document.getElementById(CONTRIBUTE_BTN_ID);
    if (contribute && container.contains(contribute)) {
      return button.previousElementSibling === contribute;
    }
    if (menuButton && container.contains(menuButton)) {
      return button.nextElementSibling === menuButton;
    }
    return true;
  }

  function ensureButton() {
    if (!isCastOverlayEnabled()) {
      removeUi();
      return;
    }

    if (!isPlayerRoute()) {
      removeUi();
      return;
    }

    injectStyles();

    const container = document.querySelector(
      '[class*="player-container"] [class*="control-bar-buttons-container"]'
    );
    if (!container) return;

    let button = document.getElementById(BTN_ID);
    if (button && isStaleButton(button)) {
      button.remove();
      button = null;
    }

    if (!button) {
      const template = getButtonTemplate();
      if (template) {
        button = template.cloneNode(true);
        button.classList.remove('disabled');
        button.removeAttribute('tabindex');
        button.querySelectorAll('[class*="button-container"]').forEach((el) => el.remove());
      } else {
        button = document.createElement('button');
        button.type = 'button';
      }

      button.id = BTN_ID;
      button.title = 'Cast';
      button.setAttribute('aria-label', 'Cast');
      replaceButtonIcon(button);
      placeCastButton(button, container);
    } else if (!isCastButtonPlaced(button, container)) {
      placeCastButton(button, container);
    }

    bindButtonHandler(button);
  }

  function ensureAll() {
    if (!isCastOverlayEnabled()) {
      removeUi();
      return;
    }
    ensureButton();
  }

  function scheduleEnsure() {
    if (ensureTimer) window.clearTimeout(ensureTimer);
    ensureTimer = window.setTimeout(() => {
      ensureTimer = null;
      ensureAll();
    }, 150);
  }

  function bindLayoutObserver() {
    if (layoutObserver || isOverlayHidden()) return;
    const target =
      document.querySelector('[class*="player-container"]') || document.documentElement;
    layoutObserver = new MutationObserver(() => {
      if (isOverlayHidden()) return;
      scheduleEnsure();
    });
    layoutObserver.observe(target, { childList: true, subtree: true });
  }

  function stopLayoutObserver() {
    if (layoutObserver) {
      layoutObserver.disconnect();
      layoutObserver = null;
    }
    if (ensureTimer) {
      window.clearTimeout(ensureTimer);
      ensureTimer = null;
    }
  }

  function syncLayoutWorkToChrome() {
    if (!isPlayerRoute() || !isCastOverlayEnabled()) {
      stopLayoutObserver();
      stopUiWatcher();
      return;
    }
    if (isOverlayHidden()) {
      stopLayoutObserver();
      return;
    }
    bindLayoutObserver();
    startUiWatcher();
    scheduleEnsure();
  }

  function bindChromeIdleWatcher() {
    if (chromeIdleWatcher || typeof MutationObserver === 'undefined') return;
    const target = document.querySelector('[class*="player-container"]');
    if (!target) return;
    chromeIdleWatcher = new MutationObserver(() => syncLayoutWorkToChrome());
    chromeIdleWatcher.observe(target, { attributes: true, attributeFilter: ['class'] });
  }

  function stopChromeIdleWatcher() {
    if (chromeIdleWatcher) {
      chromeIdleWatcher.disconnect();
      chromeIdleWatcher = null;
    }
  }

  function startUiWatcher() {
    if (uiWatcher || isOverlayHidden()) return;
    uiWatcher = window.setInterval(() => {
      if (!isCastOverlayEnabled()) {
        teardown();
        return;
      }
      if (!isPlayerRoute()) {
        stopUiWatcher();
        return;
      }
      if (isOverlayHidden()) return;
      ensureButton();
    }, 2500);
  }

  function stopUiWatcher() {
    if (!uiWatcher) return;
    window.clearInterval(uiWatcher);
    uiWatcher = null;
  }

  /**
   * Soft leave: stop watchers/UI without destroying bootstrap listeners.
   */
  function suspendRuntime() {
    closeOverlay();
    removeUi();
    unlockPlayerOverlay();
    stopUiWatcher();
    stopLayoutObserver();
    stopChromeIdleWatcher();
  }

  function teardown() {
    suspendRuntime();
    document.getElementById(STYLE_ID)?.remove();
    window.__stremioCastOverlayReady = false;
  }

  window.__stremioCastOverlayUnload = suspendRuntime;

  if (!isCastOverlayEnabled()) {
    teardown();
    return;
  }

  if (window.__stremioCastOverlayReady === PLUGIN_VERSION) return;
  window.__stremioCastOverlayReady = PLUGIN_VERSION;

  if (!window.__stremioCastOverlayBootstrapped) {
    window.__stremioCastOverlayBootstrapped = true;
    ensureAll();
    window.addEventListener('resize', () => {
      if (overlayOpen) positionCastBubble();
    });
    document.addEventListener('stremio-custom-playback-route', scheduleEnsure);
    document.addEventListener('stremio-custom-bootstrap-ready', scheduleEnsure);
    document.addEventListener('stremio-custom-route-change', () => {
      if (!isPlayerRoute()) {
        suspendRuntime();
        return;
      }
      if (overlayOpen) closeOverlay();
      bindChromeIdleWatcher();
      syncLayoutWorkToChrome();
      window.setTimeout(ensureAll, 300);
    });
    document.addEventListener('stremio-custom-playback-stopped', () => {
      suspendRuntime();
    });
    document.addEventListener('stremio-custom-stream-started', () => {
      bindChromeIdleWatcher();
      syncLayoutWorkToChrome();
    });
    bindChromeIdleWatcher();
    syncLayoutWorkToChrome();
  }

  console.info('[StremioCustom] Cast overlay plugin ready.');
})();
