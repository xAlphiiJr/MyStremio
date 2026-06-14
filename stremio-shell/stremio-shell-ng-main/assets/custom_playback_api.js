(function () {
  'use strict';

  if (window.__stremioCustomPlaybackApi) return;
  window.__stremioCustomPlaybackApi = true;

  const VIDEO_ATTR = 'data-stremio-custom-shell-video';
  let shellMsgId = 12000;
  let shimVideo = null;
  let shimState = {
    currentTime: 0,
    duration: NaN,
    seeking: false,
    metadataLoaded: false,
  };
  let lastMpvTimeAt = 0;
  let lastSeekTarget = null;
  let lastSeekAt = 0;
  let mpvCacheAheadSec = 0;
  let pollTimer = null;
  let hookInstalled = false;

  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  function sendMpvSetProp(prop, value) {
    if (!window.chrome?.webview?.postMessage) return false;
    try {
      shellMsgId += 1;
      window.chrome.webview.postMessage(
        JSON.stringify({
          id: shellMsgId,
          args: ['mpv-set-prop', [prop, value]],
        })
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  function sendMpvCommand(args) {
    if (!window.chrome?.webview?.postMessage || !Array.isArray(args) || !args.length) return false;
    try {
      shellMsgId += 1;
      window.chrome.webview.postMessage(
        JSON.stringify({
          id: shellMsgId,
          args: ['mpv-command', args],
        })
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  function sendMpvObserve(prop) {
    if (!window.chrome?.webview?.postMessage) return false;
    try {
      shellMsgId += 1;
      window.chrome.webview.postMessage(
        JSON.stringify({
          id: shellMsgId,
          args: ['mpv-observe-prop', prop],
        })
      );
      return true;
    } catch (_) {
      return false;
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
    if (times.length >= 2) {
      return Math.max(...times);
    }
    return null;
  }

  function dispatchVideoEvent(name) {
    if (!shimVideo) return;
    try {
      shimVideo.dispatchEvent(new Event(name));
    } catch (_) {}
  }

  function getBufferedEndSec() {
    const current = shimState.currentTime;
    if (mpvCacheAheadSec > 0 && Number.isFinite(current) && current >= 0) {
      const duration = shimState.duration || readDurationFromDom();
      const end = current + mpvCacheAheadSec;
      if (duration && Number.isFinite(duration) && duration > 0) {
        return Math.min(end, duration);
      }
      return end;
    }
    return current;
  }

  function getBufferedRatio() {
    const duration = shimState.duration || readDurationFromDom();
    const current = shimState.currentTime;
    if (!duration || !Number.isFinite(duration) || duration <= 0) return 0;
    if (!Number.isFinite(current) || current < 0) return 0;
    const ahead = Math.max(0, getBufferedEndSec() - current);
    if (ahead <= 0) return 0;
    return Math.max(0, Math.min(1, ahead / duration));
  }

  function getBufferStartRatio() {
    const duration = shimState.duration || readDurationFromDom();
    const current = shimState.currentTime;
    if (!duration || !Number.isFinite(duration) || duration <= 0) return 0;
    if (!Number.isFinite(current) || current < 0) return 0;
    return Math.max(0, Math.min(1, current / duration));
  }

  function createBufferedRanges() {
    const current = shimState.currentTime;
    const end = getBufferedEndSec();
    if (end <= current) {
      return { length: 0, start() { return 0; }, end() { return 0; } };
    }
    return {
      length: 1,
      start(index) {
        return index === 0 ? current : 0;
      },
      end(index) {
        return index === 0 ? end : 0;
      },
    };
  }

  function updateDuration(nextDuration) {
    if (!Number.isFinite(nextDuration) || nextDuration <= 0) return;
    const changed = !Number.isFinite(shimState.duration) || Math.abs(shimState.duration - nextDuration) > 0.5;
    shimState.duration = nextDuration;
    if (changed && !shimState.metadataLoaded) {
      shimState.metadataLoaded = true;
      dispatchVideoEvent('loadedmetadata');
    }
    if (changed && getPreloadMode() === 'full') applyPreloadSettings();
  }

  function updateCurrentTime(nextTime, source) {
    if (!Number.isFinite(nextTime) || nextTime < 0) return;
    const prev = shimState.currentTime;
    if (Math.abs(prev - nextTime) < 0.08 && source !== 'user-seek') return;

    shimState.currentTime = nextTime;
    if (source === 'mpv') {
      lastMpvTimeAt = Date.now();
    }

    if (Math.abs(prev - nextTime) >= 0.2 || source === 'user-seek') {
      dispatchVideoEvent('timeupdate');
    }
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

  function handleMpvPropChange(payload) {
    const change = Array.isArray(payload) ? payload[1] : payload;
    if (!change?.name) return;

    if (change.name === 'time-pos') {
      if (shimState.seeking) return;
      const seconds = Number(change.data);
      if (Number.isFinite(seconds)) {
        updateCurrentTime(seconds, 'mpv');
      }
      return;
    }

    if (change.name === 'duration') {
      const seconds = Number(change.data);
      if (Number.isFinite(seconds)) updateDuration(seconds);
      return;
    }

    if (change.name === 'demuxer-cache-time') {
      const seconds = Number(change.data);
      if (Number.isFinite(seconds) && seconds >= 0) {
        mpvCacheAheadSec = seconds;
        dispatchVideoEvent('progress');
      }
      return;
    }

    if (change.name === 'path') {
      const streamPath = typeof change.data === 'string' ? change.data : '';
      if (streamPath) window.StremioCustomStreamCache?.setStreamPath?.(streamPath);
    }
  }

  function hookShellMessages() {
    if (hookInstalled) return;
    hookInstalled = true;

    const transport = window.qt?.webChannelTransport;
    if (transport && !transport.__stremioCustomPlaybackHooked) {
      transport.__stremioCustomPlaybackHooked = true;
      const original = transport.onmessage;
      transport.onmessage = function (ev) {
        const payload = parseShellPayload(ev?.data);
        if (payload) handleMpvPropChange(payload);
        if (typeof original === 'function') original.call(this, ev);
      };
    }

    if (window.chrome?.webview && !window.chrome.webview.__stremioCustomPlaybackHooked) {
      window.chrome.webview.__stremioCustomPlaybackHooked = true;
      window.chrome.webview.addEventListener('message', (ev) => {
        const payload = parseShellPayload(ev?.data);
        if (payload) handleMpvPropChange(payload);
      });
    }
  }

  function getVideoContainer() {
    return (
      document.querySelector('[class*="player-container"] [class*="video-container"] [class*="video"]') ||
      document.querySelector('[class*="player-container"] [class*="video-container"]')
    );
  }

  function pauseShellPlayback() {
    if (!window.chrome?.webview?.postMessage) return;
    try {
      shellMsgId += 1;
      window.chrome.webview.postMessage(
        JSON.stringify({
          id: shellMsgId,
          args: ['mpv-set-prop', ['pause', true]],
        })
      );
    } catch (_) {}
  }

  function setupVideoShim(video) {
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get() {
        return shimState.currentTime;
      },
      set(value) {
        const seconds = Number(value);
        if (!Number.isFinite(seconds)) return;
        if (
          lastSeekTarget != null &&
          Math.abs(lastSeekTarget - seconds) < 0.5 &&
          Date.now() - lastSeekAt < 1500
        ) {
          return;
        }

        lastSeekTarget = seconds;
        lastSeekAt = Date.now();
        shimState.seeking = true;
        updateCurrentTime(seconds, 'user-seek');
        sendMpvSetProp('time-pos', seconds);

        window.setTimeout(() => {
          shimState.seeking = false;
        }, 1200);
      },
    });

    Object.defineProperty(video, 'duration', {
      configurable: true,
      get() {
        return shimState.duration;
      },
      set(value) {
        const seconds = Number(value);
        if (Number.isFinite(seconds)) {
          shimState.duration = seconds;
        }
      },
    });

    video.pause = () => {
      pauseShellPlayback();
    };
    video.play = () => Promise.resolve();

    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() {
        return createBufferedRanges();
      },
    });
  }

  function ensureShellVideo() {
    const container = getVideoContainer();
    if (!container) return null;

    let video = container.querySelector(`video[${VIDEO_ATTR}]`);
    if (!video) {
      video = document.createElement('video');
      video.setAttribute(VIDEO_ATTR, '1');
      video.setAttribute('playsinline', 'true');
      video.setAttribute('preload', 'metadata');
      video.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;opacity:0;pointer-events:none;z-index:0;';
      setupVideoShim(video);
      container.appendChild(video);
      if (Number.isFinite(shimState.duration) && shimState.duration > 0) {
        dispatchVideoEvent('loadedmetadata');
      }
    }

    shimVideo = video;
    return video;
  }

  function requestMpvObservations() {
    sendMpvObserve('time-pos');
    sendMpvObserve('duration');
    sendMpvObserve('demuxer-cache-time');
    sendMpvObserve('path');
    applyPreloadSettings();
  }

  function getPreloadMode() {
    const PRELOAD_KEY = 'stremio-custom-preload-secs';
    try {
      const raw = localStorage.getItem(PRELOAD_KEY);
      if (raw === 'full') return 'full';
      const stored = Number(raw);
      if (Number.isFinite(stored) && stored >= 30) return stored;
    } catch (_) {}
    return 120;
  }

  function resolvePreloadSecs() {
    const mode = getPreloadMode();
    if (mode === 'full') {
      const duration = shimState.duration || readDurationFromDom();
      if (Number.isFinite(duration) && duration > 0) return Math.ceil(duration);
      return 86400;
    }
    return Math.min(600, mode);
  }

  function applyPreloadSettings() {
    const isFull = getPreloadMode() === 'full';
    const secs = resolvePreloadSecs();
    sendMpvSetProp('cache-secs', secs);
    sendMpvSetProp('demuxer-readahead-secs', secs);
    if (isFull) {
      sendMpvSetProp('demuxer-max-bytes', '8GiB');
    } else if (secs >= 300) {
      sendMpvSetProp('demuxer-max-bytes', '1GiB');
    }
    return secs;
  }

  function pollDomFallback() {
    if (!isPlayerRoute() || shimState.seeking) return;

    ensureShellVideo();

    if (Date.now() - lastMpvTimeAt >= 2500) {
      const domTime = readTimeFromDom();
      if (domTime != null) {
        updateCurrentTime(domTime, 'dom');
      }
    }

    const domDuration = readDurationFromDom();
    if (domDuration != null) {
      updateDuration(domDuration);
    }

    if (mpvCacheAheadSec <= 0 && shimState.currentTime > 0) {
      sendMpvObserve('demuxer-cache-time');
    }

    dispatchVideoEvent('progress');
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = window.setInterval(pollDomFallback, 1000);
  }

  function stopPolling() {
    if (!pollTimer) return;
    window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function resetPlaybackState() {
    shimState.currentTime = 0;
    shimState.duration = NaN;
    shimState.seeking = false;
    shimState.metadataLoaded = false;
    lastMpvTimeAt = 0;
    lastSeekTarget = null;
    lastSeekAt = 0;
    mpvCacheAheadSec = 0;
    shimVideo = null;
  }

  function ensurePlaybackApi() {
    if (!isPlayerRoute()) {
      if (!window.__stremioCustomPipMode) {
        pauseShellPlayback();
        stopPolling();
        resetPlaybackState();
        document.querySelector(`video[${VIDEO_ATTR}]`)?.remove();
      }
      return;
    }

    hookShellMessages();
    ensureShellVideo();
    requestMpvObservations();
    startPolling();
  }

  window.StremioCustomPlayback = {
    getVideo: () => ensureShellVideo(),
    getCurrentTime: () => shimState.currentTime,
    getDuration: () => shimState.duration,
    getBufferedEnd: () => getBufferedEndSec(),
    getBufferedRatio: () => getBufferedRatio(),
    getBufferStartRatio: () => getBufferStartRatio(),
    getCacheAheadSec: () => mpvCacheAheadSec,
    applyPreloadSettings,
    seekTo: (seconds) => {
      const video = ensureShellVideo();
      if (video) video.currentTime = Number(seconds);
    },
    isShellPlayback: () => Boolean(window.chrome?.webview?.postMessage),
  };

  window.__stremioCustomPlaybackEnsure = ensurePlaybackApi;

  window.addEventListener('storage', (event) => {
    if (event.key === 'stremio-custom-preload-secs') applyPreloadSettings();
  });
  document.addEventListener('stremio-custom-preload-changed', applyPreloadSettings);

  let preloadApplyTimer = null;
  function schedulePreloadApply() {
    if (!isPlayerRoute()) return;
    applyPreloadSettings();
    if (preloadApplyTimer) return;
    let attempts = 0;
    preloadApplyTimer = window.setInterval(() => {
      if (!isPlayerRoute()) {
        window.clearInterval(preloadApplyTimer);
        preloadApplyTimer = null;
        return;
      }
      applyPreloadSettings();
      attempts += 1;
      if (attempts >= 8) {
        window.clearInterval(preloadApplyTimer);
        preloadApplyTimer = null;
      }
    }, 1500);
  }

  const originalEnsure = ensurePlaybackApi;
  function ensurePlaybackApiWithPreload() {
    originalEnsure();
    if (isPlayerRoute()) schedulePreloadApply();
  }

  window.addEventListener('hashchange', ensurePlaybackApiWithPreload);
  document.addEventListener('stremio-custom-playback-route', ensurePlaybackApiWithPreload);
  document.addEventListener('stremio-custom-bootstrap-ready', ensurePlaybackApiWithPreload);

  if (document.readyState !== 'loading') {
    ensurePlaybackApiWithPreload();
  } else {
    window.addEventListener('DOMContentLoaded', ensurePlaybackApiWithPreload);
  }
})();
