/**
 * Episode-list watched pills only. Marks use MetaDetails.MarkVideoAsWatched
 * with the Core video (id + released) from meta_details — never href or
 * parsed date text. Cover overlay and context-menu actions are not used.
 */
(function () {
  'use strict';

  if (window.self !== window.top) return;
  if (window.__stremioCustomMarkWatched) return;
  window.__stremioCustomMarkWatched = true;

  const STYLE_ID = 'mystremio-mark-watched-style';
  const GHOST_CLASS = 'mystremio-mark-watched';
  const EYE_SVG =
    '<svg class="mystremio-mw-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 5c-5 0-9.27 3.11-11 7 1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>';

  /** @type {MutationObserver|null} */
  let videosObserver = null;
  let scanScheduled = false;
  let bindTries = 0;
  /** @type {number|null} */
  let scanInterval = null;
  const SCAN_MS = 200;

  /**
   * @returns {string}
   */
  function getUiLanguage() {
    try {
      const htmlLang = String(document.documentElement.lang || '').toLowerCase();
      if (htmlLang.startsWith('de')) return 'de';
    } catch (_) {}
    return 'en';
  }

  /**
   * @param {string} en
   * @param {string} de
   * @returns {string}
   */
  function t(en, de) {
    return getUiLanguage() === 'de' ? de : en;
  }

  function getCore() {
    return window.core || window.services?.core?.transport || null;
  }

  /**
   * @param {string} model
   * @returns {Promise<object|null>}
   */
  async function getState(model) {
    const core = getCore();
    if (!core?.getState) return null;
    try {
      return await core.getState(model);
    } catch (_) {
      return null;
    }
  }

  /**
   * @param {object} payload
   * @returns {Promise<boolean>}
   */
  async function dispatch(payload) {
    const core = getCore();
    if (!core?.dispatch) return false;
    try {
      await core.dispatch(payload);
      return true;
    } catch (err) {
      console.warn('[MyStremio] mark-watched dispatch failed', err);
      return false;
    }
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * @returns {boolean}
   */
  function isDetailRoute() {
    return /#\/(?:detail|metadetails|meta)\//i.test(location.hash || '');
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${GHOST_CLASS}{
        display:flex;align-items:center;gap:6px;flex:none;
        height:100%;max-height:1.6rem;padding:4px 10px;border-radius:999px;
        background:rgba(255,255,255,.12);
        border:1px solid rgba(255,255,255,.18);
        color:rgba(255,255,255,.9);cursor:pointer;font:inherit;
        letter-spacing:.3px;text-transform:uppercase;
        box-shadow:0 2px 8px rgba(0,0,0,.25);
      }
      .${GHOST_CLASS}:hover{
        background:rgba(255,255,255,.18);
        border-color:rgba(255,220,100,.45);
      }
      .${GHOST_CLASS} .mystremio-mw-icon{width:14px;height:14px;flex:none}
      .${GHOST_CLASS} .mystremio-mw-label{font-size:12px;font-weight:600;white-space:nowrap}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * @param {object|null} node
   * @returns {boolean}
   */
  function isLoadingNode(node) {
    if (!node || typeof node !== 'object') return false;
    const type = String(node.type || '').toLowerCase();
    if (type === 'loading') return true;
    if (node.metaItem) return isLoadingNode(node.metaItem);
    if (node.content && !Array.isArray(node.content)) return isLoadingNode(node.content);
    return false;
  }

  /**
   * @param {object|null} node
   * @returns {object[]}
   */
  function videosFromMetaState(node) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node.videos)) return node.videos;
    if (node.metaItem) {
      const nested = videosFromMetaState(node.metaItem);
      if (nested.length) return nested;
    }
    const content = node.content;
    if (content && typeof content === 'object') {
      if (Array.isArray(content.videos)) return content.videos;
      if (Array.isArray(content.content?.videos)) return content.content.videos;
      const deeper = videosFromMetaState(content);
      if (deeper.length) return deeper;
    }
    return [];
  }

  /**
   * @param {boolean} [retry]
   * @returns {Promise<object[]>}
   */
  async function loadMetaVideos(retry = true) {
    const state = (await getState('meta_details')) || (await getState('metaDetails'));
    if (retry && (isLoadingNode(state) || videosFromMetaState(state).length === 0)) {
      await sleep(220);
      const again = (await getState('meta_details')) || (await getState('metaDetails'));
      return videosFromMetaState(again);
    }
    return videosFromMetaState(state);
  }

  /**
   * @param {Element} row
   * @returns {number|null}
   */
  function episodeNumberFromRow(row) {
    const title =
      row.querySelector('[class*="title-container"], [class*="video-title"]')?.textContent || '';
    const match = String(title).trim().match(/^(\d+)\s*[.:]/);
    if (!match) return null;
    const num = Number(match[1]);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  /**
   * @returns {number|null}
   */
  function selectedSeason() {
    const scopes = document.querySelectorAll(
      '[class*="videos-list"], [class*="series-content"], [class*="seasons"]'
    );
    for (const scope of scopes) {
      const nodes = scope.querySelectorAll(
        'button, [class*="label"], [class*="selected"], [class*="select"]'
      );
      for (const el of nodes) {
        const match = String(el.textContent || '').match(/(?:season|staffel)\s*(\d+)/i);
        if (!match) continue;
        const num = Number(match[1]);
        if (Number.isFinite(num) && num > 0) return num;
      }
    }
    return null;
  }

  /**
   * @param {object[]} videos
   * @param {number} episode
   * @returns {number|null}
   */
  function inferSeason(videos, episode) {
    const fromUi = selectedSeason();
    if (fromUi) return fromUi;
    const matches = videos.filter((video) => Number(video?.episode) === episode);
    const seasons = [
      ...new Set(matches.map((video) => Number(video?.season)).filter((n) => n > 0)),
    ];
    if (seasons.length === 1) return seasons[0];
    return null;
  }

  /**
   * @param {object} video
   * @returns {{ id: string, released?: string }}
   */
  function coreVideoArgs(video) {
    const args = { id: String(video.id) };
    if (video.released != null && video.released !== '') {
      args.released = video.released;
    }
    return args;
  }

  /**
   * @param {Element} row
   * @returns {Promise<object|null>}
   */
  async function resolveCoreVideo(row) {
    const episode = episodeNumberFromRow(row);
    if (!episode) return null;
    let videos = await loadMetaVideos(true);
    if (!videos.length) {
      await sleep(280);
      videos = await loadMetaVideos(false);
    }
    if (!videos.length) return null;
    const season = inferSeason(videos, episode);
    const hit = videos.find((video) => {
      if (Number(video?.episode) !== episode) return false;
      if (season == null) return true;
      return Number(video?.season) === season;
    });
    return hit?.id ? hit : null;
  }

  /**
   * @param {object} video
   * @param {boolean} nextWatched
   * @returns {Promise<boolean>}
   */
  async function markEpisode(video, nextWatched) {
    if (!video?.id) return false;
    return dispatch({
      action: 'MetaDetails',
      args: {
        action: 'MarkVideoAsWatched',
        args: [coreVideoArgs(video), nextWatched],
      },
    });
  }

  /**
   * @param {Element} row
   * @returns {boolean}
   */
  function hasNativeWatchedPill(row) {
    return Boolean(
      row.querySelector('[class*="watched-container"]:not([class*="upcoming-watched"])')
    );
  }

  /**
   * @param {Element} row
   */
  function ensureGhostPill(row) {
    if (hasNativeWatchedPill(row)) {
      row.querySelector(`.${GHOST_CLASS}`)?.remove();
      return;
    }
    if (row.querySelector(`.${GHOST_CLASS}`)) return;
    const host =
      row.querySelector('[class*="upcoming-watched-container"]') ||
      row.querySelector('[class*="flex-row-container"]');
    if (!host) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = GHOST_CLASS;
    button.setAttribute('aria-label', t('Mark as watched', 'Als gesehen markieren'));
    button.innerHTML = `${EYE_SVG}<span class="mystremio-mw-label">${t('Watched', 'Gesehen')}</span>`;
    host.appendChild(button);
  }

  function scanEpisodeRows() {
    if (!isDetailRoute()) return;
    ensureStyles();
    document.querySelectorAll('[class*="video-container"]').forEach((row) => {
      if (row.closest('[class*="player"]')) return;
      if (!row.querySelector('[class*="title-container"], [class*="video-title"]')) return;
      ensureGhostPill(row);
    });
  }

  function scheduleEpisodeScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scanEpisodeRows();
    });
  }

  function stopScanInterval() {
    if (scanInterval == null) return;
    window.clearInterval(scanInterval);
    scanInterval = null;
  }

  function startScanInterval() {
    if (scanInterval != null) return;
    scanInterval = window.setInterval(() => {
      if (!isDetailRoute()) {
        stopScanInterval();
        return;
      }
      scanEpisodeRows();
    }, SCAN_MS);
  }

  function bindVideosObserver() {
    if (videosObserver) {
      videosObserver.disconnect();
      videosObserver = null;
    }
    if (!isDetailRoute()) {
      bindTries = 0;
      stopScanInterval();
      return;
    }
    const list =
      document.querySelector('[class*="videos-container"]') ||
      document.querySelector('[class*="videos-list"]') ||
      document.querySelector('[class*="series-content"]');
    if (!list) {
      if (bindTries < 16) {
        bindTries += 1;
        window.setTimeout(bindVideosObserver, 150);
      }
      startScanInterval();
      scheduleEpisodeScan();
      return;
    }
    bindTries = 0;
    videosObserver = new MutationObserver(() => scheduleEpisodeScan());
    videosObserver.observe(list, { childList: true, subtree: true });
    startScanInterval();
    scheduleEpisodeScan();
  }

  /**
   * @param {MouseEvent} event
   */
  function onClickCapture(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!isDetailRoute()) return;

    const ghost = target.closest(`.${GHOST_CLASS}`);
    if (ghost) {
      const row = ghost.closest('[class*="video-container"]');
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (!row) return;
      resolveCoreVideo(row).then((video) => {
        if (video) markEpisode(video, true).then(() => scheduleEpisodeScan());
      });
      return;
    }

    const nativePill = target.closest(
      '[class*="watched-container"]:not([class*="upcoming-watched"])'
    );
    if (nativePill && !nativePill.classList.contains(GHOST_CLASS)) {
      const row = nativePill.closest('[class*="video-container"]');
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      resolveCoreVideo(row).then((video) => {
        if (video) markEpisode(video, false).then(() => scheduleEpisodeScan());
      });
    }
  }

  function onRouteChange() {
    if (!isDetailRoute()) {
      stopScanInterval();
      if (videosObserver) {
        videosObserver.disconnect();
        videosObserver = null;
      }
      bindTries = 0;
      return;
    }
    bindVideosObserver();
    startScanInterval();
    scheduleEpisodeScan();
  }

  window.__stremioCustomMarkWatchedEnsure = onRouteChange;

  ensureStyles();
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('stremio-custom-route-change', onRouteChange);
  document.addEventListener('DOMContentLoaded', onRouteChange);
  window.addEventListener('load', onRouteChange);
  onRouteChange();
})();
