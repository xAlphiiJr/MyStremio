(function () {
  'use strict';

  if (window.__stremioCustomSeekBuffer) return;
  window.__stremioCustomSeekBuffer = true;

  const STYLE_ID = 'stremio-custom-seek-buffer-styles';

  const FAST_POLL_MS = 200;
  const SLOW_POLL_MS = 2000;

  let loopTimer = null;
  let loopIntervalMs = 0;
  let mpvHookInstalled = false;
  let cacheAheadSec = 0;
  let mpvCurrentTime = 0;
  let mpvDuration = 0;
  let lastCurrentTime = 0;
  let estimatedAheadSec = 0;
  let lastAdvanceAt = 0;
  let coreDurationPollGen = 0;
  let chromeWatcher = null;

  /**
   * @returns {boolean} True when player chrome is auto-hidden.
   */
  function isOverlayHidden() {
    const el = document.querySelector('[class*="player-container"]');
    if (!el) return false;
    for (const className of el.classList) {
      if (String(className).includes('overlayHidden')) return true;
    }
    return false;
  }

  /**
   * @returns {boolean}
   */
  function isSeekBarVisible() {
    if (isOverlayHidden()) return false;
    const slider = getSeekSlider();
    if (!slider) return false;
    const rect = slider.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function parseShellPayload(raw) {
    if (raw == null) return null;
    try {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!data) return null;
      if (Array.isArray(data) && data[0] === 'mpv-prop-change') return data;
      if (Array.isArray(data.args) && data.args[0] === 'mpv-prop-change') return data.args;
      if (data.type === 1 && Array.isArray(data.args) && data.args[0] === 'mpv-prop-change') {
        return data.args;
      }
    } catch (_) {}
    return null;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      [class*="seek-bar-container"] [class*="slider-container"] {
        position: relative !important;
        min-height: var(--track-size, 0.45rem) !important;
      }

      [class*="seek-bar-container"] [class*="slider-container"] > [class*="layer"] {
        position: absolute !important;
        top: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        left: 0 !important;
        display: flex !important;
        align-items: center !important;
        pointer-events: none !important;
      }

      [class*="seek-bar-container"] [class*="slider-container"] [class*="track"]:not([class*="track-before"]):not([class*="track-after"]) {
        flex: 1 1 auto !important;
        width: 100% !important;
        height: var(--track-size, 0.45rem) !important;
        margin: 0 !important;
        opacity: 0.22 !important;
        background-color: rgba(255, 255, 255, 0.22) !important;
      }

      [class*="seek-bar-container"] [class*="slider-container"] [class*="track-before"] {
        display: block !important;
        flex: none !important;
        height: var(--track-size, 0.45rem) !important;
        margin-left: 0 !important;
        border-radius: 999px !important;
        background-color: rgba(255, 255, 255, 0.48) !important;
        opacity: 1 !important;
        z-index: 2 !important;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12) !important;
        transition: width 0.12s linear, margin-left 0.12s linear !important;
      }

      html.stremio-custom-seeking [class*="seek-bar-container"] [class*="slider-container"] [class*="track-before"],
      html.stremio-custom-seeking .stremio-custom-preload-segment {
        transition: none !important;
      }

      [class*="seek-bar-container"] [class*="slider-container"] [class*="track-after"] {
        z-index: 3 !important;
      }

      [class*="seek-bar-container"] [class*="slider-container"] [class*="thumb"] {
        z-index: 4 !important;
      }

      .stremio-custom-preload-segment {
        position: absolute !important;
        top: 50% !important;
        left: 0 !important;
        height: var(--track-size, 0.45rem) !important;
        border-radius: 999px !important;
        transform: translateY(-50%) !important;
        display: none !important;
        pointer-events: none !important;
        background-color: rgba(255, 255, 255, 0.48) !important;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12) !important;
        transition: width 0.12s linear !important;
        z-index: 3 !important;
      }

      html.stremio-custom-seeking .stremio-custom-preload-segment {
        transition: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function handleMpvPropChange(payload) {
    const change = Array.isArray(payload) ? payload[1] : payload;
    if (!change?.name) return;

    if (change.name === 'demuxer-cache-time') {
      const seconds = Number(change.data);
      if (Number.isFinite(seconds) && seconds >= 0) cacheAheadSec = seconds;
      return;
    }

    if (change.name === 'time-pos') {
      const seconds = Number(change.data);
      if (Number.isFinite(seconds) && seconds >= 0) mpvCurrentTime = seconds;
      return;
    }

    if (change.name === 'duration') {
      const seconds = Number(change.data);
      if (Number.isFinite(seconds) && seconds > 0) mpvDuration = seconds;
    }
  }

  function hookMpvMessages() {
    if (mpvHookInstalled) return;
    mpvHookInstalled = true;

    const onMessage = (raw) => {
      const payload = parseShellPayload(raw);
      if (payload) handleMpvPropChange(payload);
    };

    const transport = window.qt?.webChannelTransport;
    if (transport && !transport.__stremioCustomSeekBufferHooked) {
      transport.__stremioCustomSeekBufferHooked = true;
      const original = transport.onmessage;
      transport.onmessage = function (ev) {
        onMessage(ev?.data);
        if (typeof original === 'function') original.call(this, ev);
      };
    }

    if (window.chrome?.webview && !window.chrome.webview.__stremioCustomSeekBufferHooked) {
      window.chrome.webview.__stremioCustomSeekBufferHooked = true;
      window.chrome.webview.addEventListener('message', (ev) => onMessage(ev?.data));
    }
  }

  function parseTimeLabel(text) {
    if (!text) return null;
    const cleaned = String(text).trim().replace(/^-/, '');
    const parts = cleaned.split(':').map((part) => Number(part));
    if (parts.some((part) => Number.isNaN(part))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return null;
  }

  function readTimeFromDom() {
    const labels = document.querySelectorAll('[class*="seek-bar-container"] [class*="label"]');
    for (const label of labels) {
      const text = label.textContent || '';
      if (!/^\d/.test(text.trim())) continue;
      const parsed = parseTimeLabel(text);
      if (parsed != null) return parsed;
    }
    return null;
  }

  function readDurationFromDom() {
    const labels = Array.from(document.querySelectorAll('[class*="seek-bar-container"] [class*="label"]'));
    const times = [];
    for (const label of labels) {
      const text = (label.textContent || '').trim();
      if (!text) continue;
      for (const part of text.split(/[/|]/)) {
        const parsed = parseTimeLabel(part.trim());
        if (parsed != null) times.push(parsed);
      }
    }
    if (times.length >= 2) return Math.max(...times);
    return null;
  }

  /**
   * Remembers a duration hint for the buffer bar (no hover tooltip).
   * @param {number} duration
   */
  function rememberDuration(duration) {
    const seconds = Number(duration);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    mpvDuration = seconds;
  }

  function restoreStoredDurationHint() {
    const hintDuration = Number(window.__stremioPlaybackDurationHint);
    if (Number.isFinite(hintDuration) && hintDuration > 0) {
      rememberDuration(hintDuration);
      return;
    }
    try {
      const raw = sessionStorage.getItem('stremio-cw-playback-hint');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || Date.now() - Number(parsed.at) > 120000) return;
      if (Number.isFinite(parsed.duration) && parsed.duration > 0) {
        window.__stremioPlaybackDurationHint = parsed.duration;
        rememberDuration(parsed.duration);
      }
      if (Number.isFinite(parsed.progress) && parsed.progress > 0) {
        window.__stremioPlaybackProgressHint = parsed.progress;
      }
    } catch (_) {}
  }

  async function pollCoreDuration() {
    if (!isOnPlayerPage()) return;
    const gen = ++coreDurationPollGen;
    try {
      const getState =
        window.services?.core?.transport?.getState ||
        window.core?.getState;
      if (!getState) return;
      const player = await getState('player');
      if (gen !== coreDurationPollGen) return;
      const meta = player?.meta || player?.item?.meta || {};
      const item = player?.item || {};
      const candidates = [
        player?.duration,
        item.duration,
        item.runtime,
        meta.duration,
        meta.runtime,
      ];
      for (const candidate of candidates) {
        const seconds = Number(candidate);
        if (Number.isFinite(seconds) && seconds > 0) {
          rememberDuration(seconds);
          return;
        }
      }
    } catch (_) {}
  }

  function scheduleCoreDurationPoll() {
    void pollCoreDuration();
    window.setTimeout(() => void pollCoreDuration(), 400);
    window.setTimeout(() => void pollCoreDuration(), 1200);
  }

  function isOnPlayerPage() {
    return /#\/player/.test(location.href);
  }

  function getSeekSlider() {
    return (
      document.querySelector('[class*="seek-bar-container"] [class*="slider-container"]') || null
    );
  }

  function getPreloadSegment(slider) {
    if (!slider) return null;
    let segment = slider.querySelector('.stremio-custom-preload-segment');
    if (segment) return segment;
    segment = document.createElement('div');
    segment.className = 'stremio-custom-preload-segment';
    slider.appendChild(segment);
    return segment;
  }

  function getConfiguredPreloadMax() {
    try {
      const raw = localStorage.getItem('stremio-custom-preload-secs');
      if (raw === 'full') {
        const duration =
          mpvDuration ||
          readDurationFromDom() ||
          window.StremioCustomPlayback?.getDuration?.();
        if (Number.isFinite(duration) && duration > 0) return duration;
        return 86400;
      }
      const stored = Number(raw);
      if (Number.isFinite(stored) && stored >= 10) return Math.min(600, stored);
    } catch (_) {}
    return 10;
  }

  function updateEstimatedAhead(current) {
    const configuredMax = getConfiguredPreloadMax();
    const now = Date.now();
    if (Number.isFinite(current) && current > lastCurrentTime + 0.05 && now - lastAdvanceAt < 2500) {
      estimatedAheadSec = Math.min(configuredMax, estimatedAheadSec + (current - lastCurrentTime) * 2.5);
    }
    if (current - lastCurrentTime > 3) {
      estimatedAheadSec = 0;
    }
    if (cacheAheadSec > 0) {
      estimatedAheadSec = cacheAheadSec;
    }
    lastCurrentTime = current;
    lastAdvanceAt = now;
  }

  function getPlaybackSnapshot() {
    const api = window.StremioCustomPlayback;
    const current = api?.getCurrentTime?.() ?? mpvCurrentTime ?? readTimeFromDom() ?? 0;
    const duration = api?.getDuration?.() ?? mpvDuration ?? readDurationFromDom() ?? 0;

    updateEstimatedAhead(current);

    const ahead = Math.max(
      cacheAheadSec || 0,
      api?.getCacheAheadSec?.() || 0,
      estimatedAheadSec || 0
    );
    const streamRatio = window.StremioCustomStreamCache?.getCachedRatio?.() || 0;
    const ratioAhead =
      Number.isFinite(streamRatio) && streamRatio > 0 && Number.isFinite(duration) && duration > 0
        ? Math.max(0, streamRatio * duration - current)
        : 0;

    return { current, duration, ahead: Math.max(ahead, ratioAhead) };
  }

  function updateBufferBar() {
    const slider = getSeekSlider();
    const preloadSegment = getPreloadSegment(slider);
    if (!slider || !preloadSegment) return;

    const { current, duration, ahead } = getPlaybackSnapshot();
    if (!duration || !Number.isFinite(duration) || duration <= 0) {
      preloadSegment.style.display = 'none';
      return;
    }

    const startRatio = Math.max(0, Math.min(1, current / duration));
    const widthRatio = Math.max(0, Math.min(1 - startRatio, ahead / duration));
    const visible = widthRatio > 0.001 || ahead > 0.25;

    preloadSegment.style.left = `calc(100% * ${startRatio})`;
    preloadSegment.style.width = visible ? `calc(100% * ${widthRatio})` : '0px';
    preloadSegment.style.display = visible ? 'block' : 'none';
  }

  function stopLoop() {
    if (loopTimer) window.clearInterval(loopTimer);
    loopTimer = null;
    loopIntervalMs = 0;
    cacheAheadSec = 0;
    estimatedAheadSec = 0;
  }

  /**
   * @param {number} ms
   */
  function ensureLoop(ms) {
    if (loopTimer && loopIntervalMs === ms) return;
    if (loopTimer) window.clearInterval(loopTimer);
    loopIntervalMs = ms;
    loopTimer = window.setInterval(tick, ms);
  }

  function bindChromeWatcher() {
    if (chromeWatcher || typeof MutationObserver === 'undefined') return;
    const target = document.querySelector('[class*="player-container"]');
    if (!target) return;
    chromeWatcher = new MutationObserver(() => {
      if (!isOnPlayerPage()) return;
      ensureLoop(isSeekBarVisible() ? FAST_POLL_MS : SLOW_POLL_MS);
      if (isSeekBarVisible()) updateBufferBar();
    });
    chromeWatcher.observe(target, { attributes: true, attributeFilter: ['class'] });
  }

  function stopChromeWatcher() {
    if (chromeWatcher) {
      chromeWatcher.disconnect();
      chromeWatcher = null;
    }
  }

  function tick() {
    if (!isOnPlayerPage()) {
      stopLoop();
      stopChromeWatcher();
      return;
    }
    hookMpvMessages();
    bindChromeWatcher();
    const visible = isSeekBarVisible();
    if (visible) updateBufferBar();
    ensureLoop(visible ? FAST_POLL_MS : SLOW_POLL_MS);
  }

  function start() {
    injectStyles();
    hookMpvMessages();
    restoreStoredDurationHint();
    scheduleCoreDurationPoll();
    bindChromeWatcher();
    tick();
    if (!loopTimer) ensureLoop(FAST_POLL_MS);
  }

  injectStyles();
  hookMpvMessages();
  document.getElementById('stremio-custom-seek-hover-preview')?.remove();

  document.addEventListener('stremio-custom-route-change', () => {
    if (isOnPlayerPage()) {
      restoreStoredDurationHint();
      scheduleCoreDurationPoll();
      start();
    } else {
      stopLoop();
      stopChromeWatcher();
    }
  });
  document.addEventListener('stremio-custom-playback-stopped', () => {
    stopLoop();
    stopChromeWatcher();
  });
  document.addEventListener('stremio-custom-cache-cleared', () => {
    cacheAheadSec = 0;
    estimatedAheadSec = 0;
  });
  document.addEventListener('stremio-custom-stream-started', () => {
    restoreStoredDurationHint();
    scheduleCoreDurationPoll();
    if (isOnPlayerPage()) start();
  });
  document.addEventListener('stremio-custom-duration-hint', (event) => {
    rememberDuration(event?.detail?.duration);
    const progress = Number(event?.detail?.progress);
    if (Number.isFinite(progress) && progress > 0) {
      window.__stremioPlaybackProgressHint = progress;
    }
  });
  document.addEventListener('stremio-custom-duration', (event) => {
    rememberDuration(event?.detail?.duration);
  });
  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    if (isOnPlayerPage()) start();
  });
  if (isOnPlayerPage()) start();
  console.info('[StremioCustom] Seek buffer (MPV ahead cache) active.');
})();
