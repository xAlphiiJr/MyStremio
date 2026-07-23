(function () {
  'use strict';

  if (window.__stremioCustomPlaybackApi) return;
  window.__stremioCustomPlaybackApi = true;

  const VIDEO_ATTR = 'data-stremio-custom-shell-video';
  const STARTUP_CACHE_SECS = 12;
  const RS = {
    NOTHING: 0,
    METADATA: 1,
    CURRENT: 2,
    FUTURE: 3,
    ENOUGH: 4,
  };
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
  let mpvCacheAheadReported = false;
  let mpvPause = false;
  let mpvPausedForCache = false;
  let currentStreamPath = '';
  let preloadBoostApplied = false;
  let recoveryMutedUntil = 0;
  let streamStartedAt = 0;
  let sessionNudgeGen = 0;
  let pollTimer = null;
  let hookInstalled = false;
  let autoPlaySuppressCount = 0;
  let startupBaselineTime = null;
  let playbackAdvanced = false;
  let startupRecoveryCount = 0;
  /** Throttle heavy time-pos fan-out (~5 Hz) while keeping heartbeat every tick. */
  const TIME_POS_HEAVY_MS = 200;
  let lastHeavyTimePosAt = 0;
  let pendingHeavyTimePos = null;
  let pendingHeavyTimePosTimer = null;
  /**
   * Playback owner states (logical):
   * idle | loading | playing | paused | leaving
   * Leave always pause→grace→stop; new path / re-entry cancels leave and unpauses.
   */
  /** Cancels a pending leave-stop when re-entering player / new loadfile arrives. */
  let leaveTeardownGen = 0;
  let leaveStopPending = false;
  /** Grace before hard stop so next-episode loadfile is not killed mid-transition. */
  const LEAVE_STOP_GRACE_MS = 280;
  const STARTUP_RECOVERY_MAX = 5;
  const STARTUP_RECOVERY_WINDOW_MS = 45000;
  const shimmedVideos = new WeakSet();

  function isAutoPlaySuppressed() {
    return autoPlaySuppressCount > 0;
  }

  function suppressAutoPlay() {
    autoPlaySuppressCount += 1;
  }

  function releaseAutoPlay() {
    autoPlaySuppressCount = Math.max(0, autoPlaySuppressCount - 1);
  }

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

  function resolveCurrentTime() {
    const domTime = readTimeFromDom();
    const mpvFresh = lastMpvTimeAt > 0 && Date.now() - lastMpvTimeAt < 4000;
    const shimTime = Number.isFinite(shimState.currentTime) ? shimState.currentTime : 0;

    if (mpvFresh) {
      if (domTime != null && domTime > shimTime + 1.5) {
        return domTime;
      }
      return shimTime;
    }

    if (domTime != null) return domTime;
    return shimTime;
  }

  function resolveDuration() {
    const domDuration = readDurationFromDom();
    const shimDuration = shimState.duration;
    const hintDuration = Number(window.__stremioPlaybackDurationHint);
    const progressHint = Number(window.__stremioPlaybackProgressHint);
    const current = resolveCurrentTime();
    if (Number.isFinite(shimDuration) && shimDuration > 0) {
      if (domDuration != null && domDuration > shimDuration + 1) {
        return domDuration;
      }
      return shimDuration;
    }
    if (domDuration != null && domDuration > 0) return domDuration;
    if (Number.isFinite(hintDuration) && hintDuration > 0) return hintDuration;
    if (
      Number.isFinite(progressHint) &&
      progressHint > 0.01 &&
      progressHint < 0.995 &&
      Number.isFinite(current) &&
      current > 0
    ) {
      const estimated = current / progressHint;
      if (Number.isFinite(estimated) && estimated > current + 5) return estimated;
    }
    return shimDuration;
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

  function extractDurationFromCorePlayer(player) {
    if (!player || typeof player !== 'object') return null;
    const meta = player.meta || player.item?.meta || {};
    const item = player.item || {};
    const candidates = [
      player.duration,
      item.duration,
      item.runtime,
      meta.duration,
      meta.runtime,
      player.seriesInfo?.episode?.runtime,
      player.seriesInfo?.episode?.duration,
    ];
    for (const candidate of candidates) {
      const seconds = Number(candidate);
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
    }
    return null;
  }

  async function pollCorePlayerDuration() {
    if (!isPlayerRoute()) return;
    try {
      const getState =
        window.services?.core?.transport?.getState ||
        window.core?.getState;
      if (!getState) return;
      const player = await getState('player');
      const seconds = extractDurationFromCorePlayer(player);
      if (seconds != null) updateDuration(seconds);
    } catch (_) {}
  }

  function getManagedVideos() {
    const videos = [];
    const seen = new Set();
    const selectors = [
      '[class*="player-container"] [class*="video-container"] video',
      '[class*="player-container"] [class*="rendering"] video',
      '[class*="player-container"] video',
    ];
    for (const selector of selectors) {
      for (const video of document.querySelectorAll(selector)) {
        if (seen.has(video)) continue;
        seen.add(video);
        videos.push(video);
      }
    }
    return videos;
  }

  function applyReadyStateShim(video) {
    if (!video || shimmedVideos.has(video)) return;
    shimmedVideos.add(video);

    let readyStateValue = RS.NOTHING;
    const dispatched = Object.create(null);

    Object.defineProperty(video, 'readyState', {
      configurable: true,
      get() {
        return readyStateValue;
      },
    });

    video.__stremioSetReadyState = (next, eventNames) => {
      const prev = readyStateValue;
      readyStateValue = next;
      if (!Array.isArray(eventNames)) return;
      for (const name of eventNames) {
        const key = `${name}:${next}`;
        if (dispatched[key]) continue;
        if (next < prev && name !== 'timeupdate' && name !== 'progress') continue;
        try {
          video.dispatchEvent(new Event(name));
          dispatched[key] = true;
        } catch (_) {}
      }
    };

    video.__stremioResetReadyState = () => {
      readyStateValue = RS.NOTHING;
      Object.keys(dispatched).forEach((key) => {
        delete dispatched[key];
      });
    };
  }

  function isVideoGateOpen() {
    return true;
  }

  function closeVideoGate() {}

  function openVideoGate() {}

  function getMpvSnapshot() {
    return {
      hasStream: Boolean(currentStreamPath),
      position: shimState.currentTime,
      duration: resolveDuration(),
      timeFresh: lastMpvTimeAt > 0 && Date.now() - lastMpvTimeAt < 4000,
      buffering: mpvPausedForCache,
      cacheAhead: mpvCacheAheadSec,
      cacheObserved: mpvCacheAheadReported,
      playbackAdvanced,
      startupAge: streamStartedAt > 0 ? Date.now() - streamStartedAt : 0,
    };
  }

  function resetStartupPlaybackTracking() {
    startupBaselineTime = null;
    playbackAdvanced = false;
    startupRecoveryCount = 0;
  }

  function noteMpvTimeProgress(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    if (startupBaselineTime == null) {
      startupBaselineTime = seconds;
      return;
    }
    if (seconds > startupBaselineTime + 0.12) {
      playbackAdvanced = true;
    }
  }

  /**
   * Applies DOM/shell fan-out for time-pos. Throttled to ~5 Hz unless forced
   * (pause/seek/end) so frame-rate mpv ticks do not saturate WebView2.
   * @param {number} seconds
   * @param {boolean} force
   */
  function flushHeavyTimePos(seconds, force) {
    if (!Number.isFinite(seconds)) return;
    const now = Date.now();
    const due = force || now - lastHeavyTimePosAt >= TIME_POS_HEAVY_MS;
    if (!due) {
      pendingHeavyTimePos = seconds;
      if (!pendingHeavyTimePosTimer) {
        pendingHeavyTimePosTimer = window.setTimeout(() => {
          pendingHeavyTimePosTimer = null;
          const next = pendingHeavyTimePos;
          pendingHeavyTimePos = null;
          if (Number.isFinite(next)) flushHeavyTimePos(next, true);
        }, TIME_POS_HEAVY_MS);
      }
      return;
    }
    if (pendingHeavyTimePosTimer) {
      window.clearTimeout(pendingHeavyTimePosTimer);
      pendingHeavyTimePosTimer = null;
    }
    pendingHeavyTimePos = null;
    lastHeavyTimePosAt = now;
    updateCurrentTime(seconds, 'mpv');
    maybeBoostPreload();
    syncShellVideoState();
    document.dispatchEvent(
      new CustomEvent('stremio-custom-mpv-time', {
        detail: { time: seconds },
      })
    );
  }

  function syncShellVideoState() {
    if (!isPlayerRoute()) return;
    const video = ensureShellVideo();
    if (!video) return;
    applyReadyStateShim(video);
  }

  function dispatchVideoEvent(name) {
    const video = ensureShellVideo();
    if (!video) return;
    applyReadyStateShim(video);
    try {
      video.dispatchEvent(new Event(name));
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
    if (changed && getPreloadMode() === 'full') maybeBoostPreload();
    syncShellVideoState();
    if (changed) {
      document.dispatchEvent(
        new CustomEvent('stremio-custom-duration', {
          detail: { duration: nextDuration },
        })
      );
    }
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
    syncShellVideoState();
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

    if (change.name === 'track-list' && Array.isArray(change.data)) {
      change.data =
        window.__stremioSanitizeTrackList?.(change.data) ?? change.data;
    }

    if (change.name === 'time-pos') {
      if (shimState.seeking) return;
      const seconds = Number(change.data);
      if (Number.isFinite(seconds)) {
        // Always mark MPV as alive on time-pos, even at 0:00 (delta filter in
        // updateCurrentTime would otherwise leave lastMpvTimeAt at 0 and trigger
        // false-positive recovery seeks that flip the play/pause UI).
        lastMpvTimeAt = Date.now();
        noteMpvTimeProgress(seconds);
        flushHeavyTimePos(seconds, false);
      }
      return;
    }

    if (change.name === 'duration') {
      const seconds = Number(change.data);
      if (Number.isFinite(seconds)) {
        const hadDuration = Number.isFinite(shimState.duration) && shimState.duration > 0;
        updateDuration(seconds);
        syncShellVideoState();
      }
      return;
    }

    if (change.name === 'demuxer-cache-time') {
      const seconds = Number(change.data);
      if (Number.isFinite(seconds) && seconds >= 0) {
        mpvCacheAheadSec = seconds;
        mpvCacheAheadReported = true;
        dispatchVideoEvent('progress');
        maybeBoostPreload();
        syncShellVideoState();
      }
      return;
    }

    if (change.name === 'pause') {
      mpvPause = Boolean(change.data);
      if (mpvPause && Number.isFinite(shimState.currentTime)) {
        flushHeavyTimePos(shimState.currentTime, true);
      }
      return;
    }

    if (change.name === 'paused-for-cache') {
      const wasBuffering = mpvPausedForCache;
      mpvPausedForCache = Boolean(change.data);
      maybeBoostPreload();
      return;
    }

    if (change.name === 'path') {
      const streamPath = typeof change.data === 'string' ? change.data : '';
      if (streamPath) {
        window.StremioCustomStreamCache?.setStreamPath?.(streamPath);
        onStreamPathChanged(streamPath);
      }
    }
  }

  function uiShowsPlaying() {
    const pauseBtn = document.querySelector(
      '[class*="player-container"] [class*="control-bar"] [title*="Pause"],' +
        '[class*="player-container"] [class*="control-bar"] [aria-label*="Pause"],' +
        '[class*="player-container"] [class*="control-bar"] [title*="pause"],' +
        '[class*="player-container"] [class*="control-bar"] [aria-label*="pause"]'
    );
    return Boolean(pauseBtn);
  }

  function applyStoredDurationHint() {
    const hintDuration = Number(window.__stremioPlaybackDurationHint);
    if (Number.isFinite(hintDuration) && hintDuration > 0) {
      updateDuration(hintDuration);
      return;
    }
    try {
      const raw = sessionStorage.getItem('stremio-cw-playback-hint');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || Date.now() - Number(parsed.at) > 120000) return;
      if (Number.isFinite(parsed.duration) && parsed.duration > 0) {
        window.__stremioPlaybackDurationHint = parsed.duration;
        updateDuration(parsed.duration);
      }
      if (Number.isFinite(parsed.progress) && parsed.progress > 0) {
        window.__stremioPlaybackProgressHint = parsed.progress;
      }
    } catch (_) {}
  }

  function onStreamPathChanged(streamPath) {
    if (!streamPath || streamPath === currentStreamPath) return;
    // New load cancels any pending leave-stop (next episode / quick re-entry).
    leaveStopPending = false;
    leaveTeardownGen += 1;
    currentStreamPath = streamPath;
    streamStartedAt = Date.now();
    preloadBoostApplied = false;
    recoveryMutedUntil = 0;
    lastMpvTimeAt = 0;
    mpvCacheAheadSec = 0;
    mpvCacheAheadReported = false;
    resetStartupPlaybackTracking();
    shimState.currentTime = 0;
    shimState.duration = NaN;
    shimState.seeking = false;
    shimState.metadataLoaded = false;
    applyStoredDurationHint();
    document.dispatchEvent(
      new CustomEvent('stremio-custom-stream-started', {
        detail: { path: streamPath },
      })
    );
    window.__stremioCustomPlayerTransparencyEnsure?.();
    // Path often arrives after early session nudges; clear leave-pause residue and re-nudge.
    playShellPlayback();
    scheduleSessionNudge();
  }

  function nudgePlaybackAtCurrentTime() {
    if (isAutoPlaySuppressed()) return false;
    let resumeAt = shimState.currentTime || readTimeFromDom() || 0;
    if (resumeAt < 0.05) resumeAt = 0.01;
    playShellPlayback();
    sendMpvSetProp('time-pos', resumeAt);
    return true;
  }

  function scheduleSessionNudge() {
    sessionNudgeGen += 1;
    const gen = sessionNudgeGen;
    window.setTimeout(() => {
      if (gen !== sessionNudgeGen || !isPlayerRoute() || !currentStreamPath) return;
      playShellPlayback();
    }, 350);
    window.setTimeout(() => {
      if (gen !== sessionNudgeGen || !isPlayerRoute() || !currentStreamPath) return;
      playShellPlayback();
    }, 950);
  }

  function refreshMpvViewport() {
    if (!isPlayerRoute()) return;
    window.__stremioCustomPlayerTransparencyEnsure?.();
    if (isAutoPlaySuppressed()) return;
    // Only recover unintended startup pauses while the UI still shows playback as active.
    if (mpvPause && uiShowsPlaying() && Date.now() - streamStartedAt < 20000) {
      playShellPlayback();
    }
  }

  function runStartupPlaybackRecovery() {
    if (!isPlayerRoute() || !currentStreamPath) return;
    if (isAutoPlaySuppressed()) return;
    if (mpvPausedForCache) return;
    if (playbackAdvanced) return;
    if (Date.now() < recoveryMutedUntil) return;
    if (startupRecoveryCount >= STARTUP_RECOVERY_MAX) return;

    const age = Date.now() - streamStartedAt;
    if (age < 1500 || age > STARTUP_RECOVERY_WINDOW_MS) return;

    const userPaused = mpvPause && !uiShowsPlaying();
    if (userPaused) return;
    if (lastMpvTimeAt <= 0 || lastMpvTimeAt < streamStartedAt) return;

    const current = shimState.currentTime;
    const baseline = startupBaselineTime;
    const staleMs = Date.now() - lastMpvTimeAt;
    const stuckOnFrame =
      baseline != null &&
      Number.isFinite(current) &&
      Math.abs(current - baseline) < 0.2 &&
      age >= 2000;
    const timePosStale = staleMs >= 2500 && age >= 2500;

    if (!stuckOnFrame && !timePosStale) return;

    startupRecoveryCount += 1;
    recoveryMutedUntil = Date.now() + 1200;
    nudgePlaybackAtCurrentTime();
  }

  function onPlayerSessionStart() {
    leaveStopPending = false;
    leaveTeardownGen += 1;
    hookShellMessages();
    ensureShellVideo();
    requestMpvObservations();
    startPolling();
    // Clear pause residue from a prior leave so the first loadfile is not born paused.
    playShellPlayback();
    scheduleSessionNudge();
    applyStoredDurationHint();
    void pollCorePlayerDuration();
    window.__stremioCustomPlayerTransparencyEnsure?.();
  }

  /**
   * Industry-standard leave: pause immediately, then stop after a short grace
   * (ShellVideo unload → mpv stop). Grace protects next-episode transitions.
   * After stop, clear MPV pause so the next loadfile is not stuck on frame 0.
   */
  function teardownPlaybackOnLeave() {
    if (window.__stremioCustomPipMode) return;

    stopPolling();
    document.querySelector(`video[${VIDEO_ATTR}]`)?.remove();

    if (!currentStreamPath) {
      resetPlaybackState();
      window.__stremioCustomPlayerTransparencyEnsure?.();
      return;
    }

    pauseShellPlayback();
    if (leaveStopPending) return;

    leaveStopPending = true;
    const gen = ++leaveTeardownGen;

    window.setTimeout(() => {
      leaveStopPending = false;
      if (gen !== leaveTeardownGen) return;
      if (isPlayerRoute()) return;
      if (window.__stremioCustomPipMode) return;

      sendMpvCommand(['stop']);
      // MPV pause often survives stop; clear it for the next idle→loadfile cycle.
      sendMpvSetProp('pause', false);
      mpvPause = false;
      resetPlaybackState();
      document.dispatchEvent(new CustomEvent('stremio-custom-playback-stopped'));
      window.__stremioCustomPlayerTransparencyEnsure?.();
    }, LEAVE_STOP_GRACE_MS);
  }

  function onPlayerSessionEnd() {
    sessionNudgeGen += 1;
    teardownPlaybackOnLeave();
  }

  function runPlaybackRecovery() {
    if (!isPlayerRoute() || !currentStreamPath) return;
    if (isAutoPlaySuppressed()) return;
    if (Date.now() < recoveryMutedUntil) return;
    if (mpvPausedForCache) return;
    if (Date.now() - streamStartedAt < 5000) return;

    const duration = shimState.duration || readDurationFromDom();
    if (!duration || !Number.isFinite(duration) || duration <= 0) return;

    const userPaused = mpvPause && !uiShowsPlaying();
    if (userPaused) return;

    const timeStale = lastMpvTimeAt > 0 && Date.now() - lastMpvTimeAt > 2500;
    if (!timeStale) return;

    const resumeAt = shimState.currentTime || readTimeFromDom() || 0;
    if (mpvPause) {
      playShellPlayback();
      recoveryMutedUntil = Date.now() + 1500;
      return;
    }

    playShellPlayback();
    recoveryMutedUntil = Date.now() + 2000;
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
      mpvPause = true;
    } catch (_) {}
  }

  function playShellPlayback() {
    if (isAutoPlaySuppressed()) return;
    if (!sendMpvSetProp('pause', false)) return;
    mpvPause = false;
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
    video.play = () => {
      playShellPlayback();
      return Promise.resolve();
    };

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
    sendMpvObserve('pause');
    sendMpvObserve('paused-for-cache');
  }

  function maybeBoostPreload() {
    if (preloadBoostApplied || !isPlayerRoute()) return;
    if (Date.now() - streamStartedAt < 45000) return;

    const targetSecs = resolvePreloadSecs();
    const wantsFull = getPreloadMode() === 'full';
    if (!wantsFull && targetSecs <= STARTUP_CACHE_SECS) {
      preloadBoostApplied = true;
      return;
    }

    const timeMoving =
      shimState.currentTime > 0.15 && Date.now() - lastMpvTimeAt < 4000;
    if (!timeMoving) return;

    applyPreloadSettings();
  }

  function getPreloadMode() {
    const PRELOAD_KEY = 'stremio-custom-preload-secs';
    try {
      const raw = localStorage.getItem(PRELOAD_KEY);
      if (raw === 'full') return 'full';
      const stored = Number(raw);
      if (Number.isFinite(stored) && stored >= 10) return stored;
    } catch (_) {}
    return 10;
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
    if (!isFull && secs <= STARTUP_CACHE_SECS) {
      preloadBoostApplied = true;
      return secs;
    }

    sendMpvSetProp('cache-secs', secs);
    sendMpvSetProp('demuxer-readahead-secs', secs);
    if (isFull) {
      sendMpvSetProp('demuxer-max-bytes', '8GiB');
    } else if (secs >= 300) {
      sendMpvSetProp('demuxer-max-bytes', '1GiB');
    } else if (secs > STARTUP_CACHE_SECS) {
      sendMpvSetProp('demuxer-max-bytes', '500MiB');
    }
    preloadBoostApplied = true;
    return secs;
  }

  function pollDomFallback() {
    if (!isPlayerRoute() || shimState.seeking) return;

    ensureShellVideo();

    const mpvFresh = lastMpvTimeAt > 0 && Date.now() - lastMpvTimeAt < 2500;
    // Healthy live playback: skip DOM reads / recovery; keep light sync only.
    if (
      mpvFresh &&
      playbackAdvanced &&
      Number.isFinite(shimState.duration) &&
      shimState.duration > 0 &&
      !mpvPausedForCache
    ) {
      maybeBoostPreload();
      dispatchVideoEvent('progress');
      syncShellVideoState();
      return;
    }

    const domTime = readTimeFromDom();
    if (domTime != null) {
      if (!mpvFresh || domTime > shimState.currentTime + 1.5) {
        updateCurrentTime(domTime, 'dom');
      }
    }

    const domDuration = readDurationFromDom();
    if (domDuration != null) {
      updateDuration(domDuration);
    }

    if (!Number.isFinite(shimState.duration) || shimState.duration <= 0) {
      void pollCorePlayerDuration();
    }

    if (mpvCacheAheadSec <= 0 && shimState.currentTime > 0) {
      sendMpvObserve('demuxer-cache-time');
    }

    maybeBoostPreload();
    dispatchVideoEvent('progress');
    syncShellVideoState();
    runStartupPlaybackRecovery();
    runPlaybackRecovery();
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
    mpvCacheAheadReported = false;
    mpvPause = false;
    mpvPausedForCache = false;
    currentStreamPath = '';
    preloadBoostApplied = false;
    recoveryMutedUntil = 0;
    streamStartedAt = 0;
    shimVideo = null;
    resetStartupPlaybackTracking();
  }

  function ensurePlaybackApi() {
    if (!isPlayerRoute()) {
      teardownPlaybackOnLeave();
      return;
    }

    // Dead / ghost `#/player` without a stream path: keep leave-stop running,
    // stay opaque, and do not resume playback. Hooks stay ready for a later loadfile.
    if (!currentStreamPath) {
      hookShellMessages();
      window.__stremioCustomPlayerTransparencyEnsure?.();
      return;
    }

    const wasLeaving = leaveStopPending;
    leaveStopPending = false;
    leaveTeardownGen += 1;
    hookShellMessages();
    ensureShellVideo();
    requestMpvObservations();
    startPolling();
    syncShellVideoState();
    // Only clear pause residue when we cancelled an in-flight leave-stop.
    if (wasLeaving) playShellPlayback();
    window.__stremioCustomPlayerTransparencyEnsure?.();
  }

  window.StremioCustomPlayback = {
    getVideo: () => ensureShellVideo(),
    getCurrentTime: () => resolveCurrentTime(),
    getDuration: () => resolveDuration(),
    getBufferedEnd: () => getBufferedEndSec(),
    getBufferedRatio: () => getBufferedRatio(),
    getBufferStartRatio: () => getBufferStartRatio(),
    getCacheAheadSec: () => mpvCacheAheadSec,
    applyPreloadSettings,
    isVideoGateOpen,
    openVideoGate,
    closeVideoGate,
    getMpvSnapshot,
    refreshMpvViewport,
    suppressAutoPlay,
    releaseAutoPlay,
    isAutoPlaySuppressed,
    onPlayerSessionStart,
    onPlayerSessionEnd,
    stopPlayback: teardownPlaybackOnLeave,
    nudgePlayback: () => playShellPlayback(),
    isPresentationReady: isVideoGateOpen,
    seekTo: (seconds) => {
      const video = ensureShellVideo();
      if (video) video.currentTime = Number(seconds);
    },
    isShellPlayback: () => Boolean(window.chrome?.webview?.postMessage),
  };

  window.__stremioCustomPlaybackEnsure = ensurePlaybackApi;

  window.addEventListener('storage', (event) => {
    if (event.key === 'stremio-custom-preload-secs') {
      preloadBoostApplied = false;
      applyPreloadSettings();
    }
  });
  document.addEventListener('stremio-custom-preload-changed', () => {
    preloadBoostApplied = false;
    applyPreloadSettings();
  });

  document.addEventListener('stremio-custom-route-change', ensurePlaybackApi);
  document.addEventListener('stremio-custom-playback-route', ensurePlaybackApi);
  document.addEventListener('stremio-custom-bootstrap-ready', ensurePlaybackApi);
  document.addEventListener('stremio-custom-stream-started', () => {
    applyStoredDurationHint();
    void pollCorePlayerDuration();
  });
  document.addEventListener('stremio-custom-duration-hint', (event) => {
    const duration = Number(event?.detail?.duration);
    if (Number.isFinite(duration) && duration > 0) updateDuration(duration);
    const progress = Number(event?.detail?.progress);
    if (Number.isFinite(progress) && progress > 0) {
      window.__stremioPlaybackProgressHint = progress;
    }
  });

  if (document.readyState !== 'loading') {
    ensurePlaybackApi();
  } else {
    window.addEventListener('DOMContentLoaded', ensurePlaybackApi);
  }
})();
