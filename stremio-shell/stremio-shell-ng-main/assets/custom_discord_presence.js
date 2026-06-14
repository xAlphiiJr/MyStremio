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

  function getRoute() {
    return (location.hash || '#/').replace(/^#/, '') || '/';
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

  async function readPlayerFromCore() {
    if (!window.core?.getState) return null;
    try {
      const player = await window.core.getState('player');
      if (!player) return null;

      const meta = player.meta || player.selected?.meta || player.item?.meta;
      const title = meta?.name || meta?.title || '';
      if (!title) return null;

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

      return { title, subtitle, type };
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

  function routeLabel(route) {
    if (route === '/' || route.startsWith('/board')) return 'Board';
    const segment = route.split('/').filter(Boolean)[0] || 'Stremio';
    return segment.charAt(0).toUpperCase() + segment.slice(1);
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

      return {
        state: 'player',
        title,
        subtitle,
        currentTime,
        duration,
        paused: paused && showPaused,
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

  window.addEventListener('hashchange', onRouteChange);
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
