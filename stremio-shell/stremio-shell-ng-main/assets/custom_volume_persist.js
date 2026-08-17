(function () {
  'use strict';

  if (window.__stremioCustomVolumePersist) return;
  window.__stremioCustomVolumePersist = true;

  const VOLUME_KEY = 'stremio-custom-player-volume';
  const MUTED_KEY = 'stremio-custom-player-muted';
  const SHELL_SIGNAL = 1;
  const SHELL_INVOKE = 6;

  const store = {
    level: null,
    muted: null,
    hydrated: false,
  };

  let diskSaveTimer = null;
  let userGestureUntil = 0;

  function clampLevel(value) {
    const level = Number(value);
    if (!Number.isFinite(level)) return null;
    return Math.min(200, Math.max(0, Math.round(level)));
  }

  function normalizeMute(value) {
    if (value === true || value === 'yes' || value === 'on') return true;
    if (value === false || value === 'no' || value === 'off') return false;
    return null;
  }

  function readLocalLevel() {
    try {
      const raw = localStorage.getItem(VOLUME_KEY);
      if (raw == null || raw === '') return null;
      return clampLevel(raw);
    } catch (_) {
      return null;
    }
  }

  function readLocalMuted() {
    try {
      const raw = localStorage.getItem(MUTED_KEY);
      if (raw == null) return null;
      return raw === 'true';
    } catch (_) {
      return null;
    }
  }

  function writeLocal(level, muted) {
    try {
      if (level != null) localStorage.setItem(VOLUME_KEY, String(level));
      if (muted != null) localStorage.setItem(MUTED_KEY, muted ? 'true' : 'false');
    } catch (_) {}
  }

  function hasStoredVolume() {
    return store.level != null || store.muted != null;
  }

  function shouldApplyDefaults() {
    return hasStoredVolume() && !isUserVolumeGesture();
  }

  function markUserVolumeGesture() {
    userGestureUntil = Date.now() + 1200;
  }

  function isUserVolumeGesture() {
    return Date.now() < userGestureUntil;
  }

  function commitVolume(level, muted) {
    let changed = false;

    if (level != null) {
      const nextLevel = clampLevel(level);
      if (nextLevel != null && nextLevel !== store.level) {
        store.level = nextLevel;
        changed = true;
      }
    }

    if (muted != null) {
      const nextMuted = Boolean(muted);
      if (nextMuted !== store.muted) {
        store.muted = nextMuted;
        changed = true;
      }
    }

    if (!changed) return;

    writeLocal(store.level, store.muted);
    document.dispatchEvent(new CustomEvent('stremio-custom-volume-changed'));
    scheduleDiskSave();
  }

  function scheduleDiskSave() {
    if (diskSaveTimer) window.clearTimeout(diskSaveTimer);
    diskSaveTimer = window.setTimeout(() => {
      diskSaveTimer = null;
      const api = window.StremioCustomAPI;
      if (!api?.savePlayerVolume) return;
      api
        .savePlayerVolume({
          level: store.level,
          muted: store.muted,
        })
        .catch(() => {});
    }, 180);
  }

  async function hydrateFromDisk() {
    const api = window.StremioCustomAPI;
    const localLevel = readLocalLevel();
    const localMuted = readLocalMuted();
    let diskLevel = null;
    let diskMuted = null;

    if (api?.getPlayerVolume) {
      try {
        const disk = await api.getPlayerVolume();
        if (typeof disk?.level === 'number' && Number.isFinite(disk.level)) {
          diskLevel = clampLevel(disk.level);
        }
        if (typeof disk?.muted === 'boolean') diskMuted = disk.muted;
      } catch (_) {}
    }

    store.level = localLevel != null ? localLevel : diskLevel;
    store.muted = localMuted != null ? localMuted : diskMuted;
    writeLocal(store.level, store.muted);
    store.hydrated = true;
  }

  function parseShellWire(raw) {
    if (raw == null) return null;
    try {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!data || !Array.isArray(data.args)) return null;
      return {
        data,
        args: data.args,
        stringMode: typeof raw === 'string',
      };
    } catch (_) {
      return null;
    }
  }

  function serializeShellWire(parsed) {
    if (!parsed) return null;
    return parsed.stringMode ? JSON.stringify(parsed.data) : parsed.data;
  }

  let applyStoredVolumeOnce = true;

  /**
   * Persist live volume/mute. Only rewrite an outgoing volume set when MPV has
   * not yet received the stored default this session (loadfile/bootstrap).
   * @param {unknown[]} pair
   * @returns {unknown[]}
   */
  function rewriteMpvSetPropPair(pair) {
    if (!Array.isArray(pair) || pair.length < 2) return pair;

    if (pair[0] === 'mute') {
      const muted = normalizeMute(pair[1]);
      if (muted != null) {
        markUserVolumeGesture();
        commitVolume(null, muted);
      }
      return pair;
    }

    if (pair[0] === 'volume') {
      const level = clampLevel(pair[1]);
      if (level != null) {
        if (isUserVolumeGesture()) {
          applyStoredVolumeOnce = false;
          commitVolume(level, null);
          return pair;
        }
        commitVolume(level, null);
      }
      if (applyStoredVolumeOnce && shouldApplyDefaults() && store.level != null) {
        applyStoredVolumeOnce = false;
        return ['volume', store.level];
      }
      return pair;
    }

    return pair;
  }

  function rewriteShellOutgoing(raw) {
    const parsed = parseShellWire(raw);
    if (!parsed) return raw;

    const args = parsed.args;
    if (args[0] === 'mpv-set-prop' && Array.isArray(args[1])) {
      args[1] = rewriteMpvSetPropPair(args[1]);
      return serializeShellWire(parsed);
    }

    return raw;
  }

  function rewriteShellIncoming(raw) {
    // MPV is source of truth during playback — never rewrite live volume/mute.
    return raw;
  }

  /**
   * Persists mute/volume from any outgoing set-prop (gesture optional for mute).
   * @param {unknown} raw
   */
  function captureFromShellOutgoing(raw) {
    const parsed = parseShellWire(raw);
    if (!parsed) return;

    const args = parsed.args;
    if (args[0] !== 'mpv-set-prop' || !Array.isArray(args[1])) return;

    const [prop, value] = args[1];
    if (prop === 'mute') {
      const muted = normalizeMute(value);
      if (muted != null) {
        markUserVolumeGesture();
        commitVolume(null, muted);
      }
      return;
    }
    if (prop === 'volume') {
      const level = clampLevel(value);
      if (level != null) commitVolume(level, null);
    }
  }

  function readVolumeFromDomSlider() {
    const sliders = document.querySelectorAll('[class*="volume-slider"] [role="slider"]');
    for (const slider of sliders) {
      const value = Number(slider.getAttribute('aria-valuenow'));
      if (Number.isFinite(value)) return clampLevel(value);
    }
    return null;
  }

  function readMutedFromDom() {
    const indicator = document.querySelector('[class*="volume-change-indicator"]');
    if (!indicator) return null;
    const icon = indicator.querySelector('[class*="volume-icon"]');
    if (!icon) return null;
    const label = String(icon.getAttribute('aria-label') || icon.getAttribute('title') || '').toLowerCase();
    if (!label) return null;
    if (label.includes('unmute') || (label.includes('stumm') && label.includes('aufheben'))) return true;
    if (label.includes('mute') || label.includes('stumm')) return false;
    return null;
  }

  function isCastOverlayWheelTarget(target) {
    return Boolean(
      target?.closest?.('#mystremio-cast-overlay, [data-mystremio-cast-dialog]')
    );
  }

  function bindVolumeUiWatch() {
    if (window.__stremioCustomVolumeUiBound) return;
    window.__stremioCustomVolumeUiBound = true;

    const VOLUME_UI_SELECTOR =
      '[class*="volume-change-indicator"], [class*="volume-slider"], [class*="volume-button"], [class*="control-bar-button"][title*="Mute" i], [class*="control-bar-button"][title*="Unmute" i], [class*="control-bar-button"][title*="Stumm" i], [class*="control-bar-button"][aria-label*="Mute" i], [class*="control-bar-button"][aria-label*="Unmute" i], [class*="control-bar-button"][aria-label*="Stumm" i]';

    const onUserGesture = () => {
      markUserVolumeGesture();
    };

    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!event.target?.closest?.(VOLUME_UI_SELECTOR)) return;
        markUserVolumeGesture();
      },
      true
    );

    document.addEventListener(
      'pointerup',
      (event) => {
        if (!event.target?.closest?.(VOLUME_UI_SELECTOR)) return;
        onUserGesture();
      },
      true
    );

    document.addEventListener(
      'click',
      (event) => {
        if (!event.target?.closest?.(VOLUME_UI_SELECTOR)) return;
        onUserGesture();
      },
      true
    );

    document.addEventListener(
      'wheel',
      (event) => {
        if (isCastOverlayWheelTarget(event.target)) return;
        if (!event.target?.closest?.('[class*="player-container"]')) return;
        onUserGesture();
      },
      { capture: true, passive: true }
    );

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'm' && event.key !== 'M') {
        return;
      }
      if (!/#\/player/.test(location.hash || '')) return;
      onUserGesture();
    });
  }

  function installShellRewriters() {
    window.__stremioRewriteShellOutgoing = rewriteShellOutgoing;
    window.__stremioRewriteShellIncoming = rewriteShellIncoming;
  }

  async function ensureVolumePersist() {
    installShellRewriters();
    bindVolumeUiWatch();
    if (!store.hydrated) await hydrateFromDisk();
  }

  window.StremioCustomVolume = {
    get: () => ({ level: store.level, muted: store.muted }),
    hydrate: hydrateFromDisk,
    commit: (level, muted) => {
      markUserVolumeGesture();
      commitVolume(level, muted);
    },
  };

  window.__stremioCustomVolumePersistEnsure = ensureVolumePersist;

  document.addEventListener('stremio-shell-outgoing', (event) => {
    captureFromShellOutgoing(event?.detail);
  });
  document.addEventListener('stremio-custom-stream-started', () => {
    applyStoredVolumeOnce = true;
  });
  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    hydrateFromDisk().finally(ensureVolumePersist);
  });

  store.level = readLocalLevel();
  store.muted = readLocalMuted();
  installShellRewriters();

  if (document.readyState !== 'loading') {
    ensureVolumePersist();
  } else {
    window.addEventListener('DOMContentLoaded', ensureVolumePersist);
  }
})();
