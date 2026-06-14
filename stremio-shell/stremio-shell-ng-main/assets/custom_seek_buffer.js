(function () {
  'use strict';

  if (window.__stremioCustomSeekBuffer) return;
  window.__stremioCustomSeekBuffer = true;

  const STYLE_ID = 'stremio-custom-seek-buffer-styles';

  let rafId = null;
  let mpvHookInstalled = false;
  let cacheAheadSec = 0;
  let mpvCurrentTime = 0;
  let mpvDuration = 0;
  let lastCurrentTime = 0;
  let estimatedAheadSec = 0;
  let lastAdvanceAt = 0;

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

      [class*="seek-bar-container"] [class*="slider-container"] [class*="track-after"] {
        z-index: 3 !important;
      }

      [class*="seek-bar-container"] [class*="slider-container"] [class*="thumb"] {
        z-index: 4 !important;
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
    const times = labels
      .map((label) => parseTimeLabel(label.textContent || ''))
      .filter((value) => value != null);
    if (times.length >= 2) return Math.max(...times);
    return null;
  }

  function isOnPlayerPage() {
    return /#\/player/.test(location.href);
  }

  function getSeekSlider() {
    return (
      document.querySelector('[class*="seek-bar-container"] [class*="slider-container"]') || null
    );
  }

  function getTrackBefore(slider) {
    return slider?.querySelector('[class*="track-before"]') || null;
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
      if (Number.isFinite(stored) && stored >= 30) return Math.min(600, stored);
    } catch (_) {}
    return 120;
  }

  function updateEstimatedAhead(current) {
    const configuredMax = getConfiguredPreloadMax();
    const now = Date.now();
    if (Number.isFinite(current) && current > lastCurrentTime + 0.05 && now - lastAdvanceAt < 2500) {
      estimatedAheadSec = Math.min(configuredMax, estimatedAheadSec + (current - lastCurrentTime) * 2.5);
    }
    if (Math.abs(current - lastCurrentTime) > 3) {
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

    return { current, duration, ahead };
  }

  function updateBufferBar() {
    const slider = getSeekSlider();
    const trackBefore = getTrackBefore(slider);
    if (!slider || !trackBefore) return;

    const { current, duration, ahead } = getPlaybackSnapshot();
    if (!duration || !Number.isFinite(duration) || duration <= 0) {
      trackBefore.style.display = 'none';
      return;
    }

    const startRatio = Math.max(0, Math.min(1, current / duration));
    const widthRatio = Math.max(0, Math.min(1 - startRatio, ahead / duration));
    const visible = widthRatio > 0.001 || ahead > 0.25;

    trackBefore.style.marginLeft = `calc(100% * ${startRatio})`;
    trackBefore.style.width = visible ? `calc(100% * ${widthRatio})` : '0px';
    trackBefore.style.display = visible ? 'block' : 'none';
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    cacheAheadSec = 0;
    estimatedAheadSec = 0;
  }

  function tick() {
    if (!isOnPlayerPage()) {
      stopLoop();
      return;
    }
    hookMpvMessages();
    updateBufferBar();
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    injectStyles();
    hookMpvMessages();
    if (!rafId) tick();
  }

  injectStyles();
  hookMpvMessages();
  document.getElementById('stremio-custom-seek-hover-preview')?.remove();
  document.getElementById('stremio-custom-seek-hover-time')?.remove();

  window.addEventListener('hashchange', () => {
    setTimeout(() => (isOnPlayerPage() ? start() : stopLoop()), 200);
  });
  document.addEventListener('stremio-custom-cache-cleared', () => {
    cacheAheadSec = 0;
    estimatedAheadSec = 0;
  });
  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    if (isOnPlayerPage()) start();
  });
  if (isOnPlayerPage()) start();
  console.info('[StremioCustom] Seek buffer (MPV ahead cache) active.');
})();
