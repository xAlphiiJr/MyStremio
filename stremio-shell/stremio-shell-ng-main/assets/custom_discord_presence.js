(function () {
  'use strict';

  if (window.__stremioCustomDiscordPresence) return;
  window.__stremioCustomDiscordPresence = true;

  const ENABLED_KEY = 'stremio-custom-discord-rp-enabled';
  const SHOW_PAUSED_KEY = 'stremio-custom-discord-rp-show-paused';
  const SHOW_MENU_KEY = 'stremio-custom-discord-rp-show-menu';
  let lastPayload = '';
  let pollTimer = null;
  let lastRoute = '';

  function isEnabled() {
    try {
      return localStorage.getItem(ENABLED_KEY) === 'true';
    } catch {
      return false;
    }
  }

  function readBool(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      if (value == null) return fallback;
      return value === 'true';
    } catch {
      return fallback;
    }
  }

  /**
   * Current app hash route without query/hash fragments.
   * @returns {string}
   */
  function getRoute() {
    const raw = (location.hash || '#/').replace(/^#/, '') || '/';
    return raw.split('?')[0].split('#')[0] || '/';
  }

  function isPlayerRoute() {
    return /^\/player/.test(getRoute());
  }

  function readPlayerTitleFromDom() {
    const selectors = [
      '[class*="title-bar-container"] [class*="title"]',
      '[class*="player-container"] [class*="title"]',
      '[class*="control-bar"] [class*="title"]',
      '[class*="nav-bar-container"] h2',
    ];
    for (const selector of selectors) {
      const text = document.querySelector(selector)?.textContent?.trim();
      if (text) return text;
    }
    return '';
  }

  /**
   * Discord accepts an https URL as the large image. Asset names and http
   * links fall back to the app icon.
   * @param {unknown} value
   * @returns {string}
   */
  function httpsImage(value) {
    if (typeof value !== 'string') return '';
    const url = value.trim();
    if (!url.startsWith('https://') || url.length > 256 || /\s/.test(url)) return '';
    return url;
  }

  /**
   * Portrait poster on Metahub. Same host the rest of MyStremio already uses.
   * @param {unknown} value
   * @returns {string}
   */
  function metahubPoster(value) {
    const match = String(value || '').match(/tt\d{7,8}/i);
    if (!match) return '';
    return `https://images.metahub.space/poster/medium/${match[0]}/img`;
  }

  /**
   * Stremio wraps meta in `{ type, content }` until the fields are on the object.
   * @param {unknown} node
   * @returns {object|null}
   */
  function readyContent(node) {
    let current = node;
    for (let i = 0; i < 4 && current && typeof current === 'object'; i += 1) {
      if (
        typeof current.poster === 'string' ||
        typeof current.name === 'string' ||
        typeof current.title === 'string'
      ) {
        return current;
      }
      if (current.content && typeof current.content === 'object' && !Array.isArray(current.content)) {
        current = current.content;
        continue;
      }
      break;
    }
    return null;
  }

  /**
   * @param {object} player
   * @param {object|null} meta
   * @param {string} route
   * @returns {string}
   */
  function posterFor(player, meta, route) {
    const library = readyContent(player?.libraryItem) || readyContent(player?.library_item);
    const selectedId =
      player?.selected?.metaRequest?.path?.id ||
      player?.selected?.meta_request?.path?.id ||
      '';
    return (
      httpsImage(meta?.poster) ||
      httpsImage(library?.poster) ||
      metahubPoster(meta?.id) ||
      metahubPoster(selectedId) ||
      metahubPoster(route)
    );
  }

  async function readPlayerFromCore() {
    if (!window.core?.getState) return null;
    try {
      const player = await window.core.getState('player');
      if (!player) return null;

      const meta =
        readyContent(player.metaItem) ||
        readyContent(player.meta_item) ||
        player.meta ||
        player.selected?.meta ||
        player.item?.meta;
      const title = meta?.name || meta?.title || '';
      const poster = posterFor(player, meta, '');
      if (!title && !poster) return null;

      let subtitle = '';
      const type = meta?.type;
      const season = player.seriesInfo?.season ?? player.season ?? meta?.season;
      const episode = player.seriesInfo?.episode ?? player.episode ?? meta?.episode;
      const episodeTitle =
        player.seriesInfo?.episodeTitle ||
        player.episodeTitle ||
        meta?.episodeTitle ||
        '';

      if (type === 'series' && (season != null || episode != null)) {
        subtitle = `S${season || '?'}E${episode || '?'}`;
        if (episodeTitle) subtitle += ` - ${episodeTitle}`;
      } else if (meta?.year) {
        subtitle = String(meta.year);
      }

      return { title, subtitle, type, poster };
    } catch (_) {
      return null;
    }
  }

  function readCurrentTime() {
    const labels = document.querySelectorAll('[class*="seek-bar-container"] [class*="label"]');
    for (const label of labels) {
      const text = (label.textContent || '').trim();
      if (/^\d/.test(text) && !text.startsWith('-')) {
        return text;
      }
    }
    return '';
  }

  function readDuration() {
    const labels = Array.from(
      document.querySelectorAll('[class*="seek-bar-container"] [class*="label"]')
    );
    const times = labels
      .map((label) => (label.textContent || '').trim())
      .filter((text) => /^\d/.test(text));
    if (times.length >= 2) return times[times.length - 1];
    return '';
  }

  function isPaused() {
    const controlBar =
      document.querySelector('[class*="control-bar"]') ||
      document.querySelector('[class*="player-container"]');
    if (!controlBar) return false;

    const playBtn = controlBar.querySelector(
      '[class*="button-container"][title*="Play"], [class*="button-container"][title*="play"], [class*="button-container"][aria-label*="Play"], [class*="button-container"][aria-label*="play"]'
    );
    if (playBtn) return true;

    const pauseBtn = controlBar.querySelector(
      '[class*="button-container"][title*="Pause"], [class*="button-container"][title*="pause"], [class*="button-container"][aria-label*="Pause"], [class*="button-container"][aria-label*="pause"]'
    );
    return !pauseBtn;
  }

  /**
   * Friendly Discord label for the current hash route.
   * Strips query strings so values like `/library?sort=lastwatched` or
   * `/?streamingServerUrl=...` never leak into Rich Presence.
   * @param {string} route
   * @returns {string}
   */
  function routeLabel(route) {
    const path = String(route || '/')
      .split('?')[0]
      .split('#')[0]
      .trim() || '/';
    if (path === '/' || path === '' || path.startsWith('/board')) return 'Board';

    const segment = path.split('/').filter(Boolean)[0] || '';
    if (!segment || segment.includes('=') || segment.startsWith('streaming')) {
      return 'Board';
    }

    const known = {
      library: 'Library',
      discover: 'Discover',
      settings: 'Settings',
      addons: 'Addons',
      search: 'Search',
      calendar: 'Calendar',
      player: 'Player',
      intro: 'Login',
    };
    const key = segment.toLowerCase();
    if (known[key]) return known[key];
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  async function buildPayload() {
    const route = getRoute();
    const showMenu = readBool(SHOW_MENU_KEY, true);
    const showPaused = readBool(SHOW_PAUSED_KEY, true);

    if (isPlayerRoute()) {
      const core = await readPlayerFromCore();
      const title = core?.title || readPlayerTitleFromDom() || 'Watching';
      const subtitle = core?.subtitle || '';
      const currentTime = readCurrentTime();
      const duration = readDuration();
      const paused = isPaused();
      const poster = core?.poster || posterFor({}, null, route);

      return {
        state: 'player',
        title,
        subtitle,
        currentTime,
        duration,
        paused: paused && showPaused,
        poster,
        route,
      };
    }

    if (!showMenu) {
      return { state: 'idle', route };
    }

    const label = routeLabel(route);
    return {
      state: 'menu',
      title: `Browsing ${label}`,
      subtitle: 'MyStremio',
      route,
    };
  }

  async function sendPresence(payload) {
    if (!window.StremioCustomAPI?.invoke) return;
    const serialized = JSON.stringify(payload);
    if (serialized === lastPayload) return;
    lastPayload = serialized;
    try {
      await window.StremioCustomAPI.invoke('update-discord-presence', payload);
    } catch (error) {
      console.warn('[StremioCustom] Discord presence update failed:', error);
      lastPayload = '';
    }
  }

  async function clearPresence() {
    lastPayload = '';
    if (!window.StremioCustomAPI?.invoke) return;
    try {
      await window.StremioCustomAPI.invoke('clear-discord-presence', {});
    } catch (_) {}
  }

  async function tick() {
    if (!isEnabled()) {
      if (lastPayload) await clearPresence();
      return;
    }
    await sendPresence(await buildPayload());
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = window.setInterval(tick, 3000);
    tick();
  }

  function stopPolling() {
    if (!pollTimer) return;
    window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function onRouteChange() {
    const route = getRoute();
    if (route === lastRoute) return;
    lastRoute = route;
    lastPayload = '';
    tick();
  }

  document.addEventListener('stremio-custom-route-change', onRouteChange);
  document.addEventListener('stremio-custom-playback-stopped', () => {
    lastPayload = '';
    tick();
  });
  window.addEventListener('storage', (event) => {
    if (
      event.key === ENABLED_KEY ||
      event.key === SHOW_PAUSED_KEY ||
      event.key === SHOW_MENU_KEY
    ) {
      lastPayload = '';
      tick();
    }
  });

  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    lastRoute = getRoute();
    if (isEnabled()) startPolling();
  });

  window.StremioCustomDiscordPresence = {
    isEnabled,
    startPolling,
    stopPolling,
    tick,
    clearPresence,
    KEYS: {
      ENABLED: ENABLED_KEY,
      SHOW_PAUSED: SHOW_PAUSED_KEY,
      SHOW_MENU: SHOW_MENU_KEY,
    },
  };

  if (document.readyState !== 'loading') {
    if (isEnabled()) startPolling();
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      if (isEnabled()) startPolling();
    });
  }

  console.info('[StremioCustom] Discord presence bridge ready.');
})();
