(function () {
  'use strict';

  /**
   * Quick-Select subtitle preference: apply once when tracks become available
   * on a new player session. Do not keep forcing `sid` after the user changes
   * the track in the native subtitles menu (that broke size/color customization).
   */

  if (window.__stremioCustomSubtitleSync) return;
  window.__stremioCustomSubtitleSync = true;

  const ACTIVE_SUBS_KEY = 'stremio-custom-active-subs';
  const FAV_SUBS_KEY = 'stremio-custom-fav-subs';
  const NONE_VALUE = 'none';
  const ISO2_TO_ISO3 = {
    de: 'ger',
    en: 'eng',
    ja: 'jpn',
    fr: 'fre',
    es: 'spa',
    it: 'ita',
    pt: 'por',
    ru: 'rus',
    ko: 'kor',
    zh: 'zho',
    ar: 'ara',
    nl: 'nld',
    pl: 'pol',
    tr: 'tur',
    cs: 'ces',
  };
  const CANONICAL_LANG = {
    de: 'ger',
    deu: 'ger',
    ger: 'ger',
    en: 'eng',
    eng: 'eng',
    cs: 'ces',
    cze: 'ces',
    ces: 'ces',
    fr: 'fre',
    fra: 'fre',
    fre: 'fre',
  };

  let shellMsgId = 9000;
  let trackListDebounce = null;
  let lastTrackList = null;
  /** True after we applied Quick Select once for the current player visit. */
  let appliedForSession = false;
  /** User changed tracks via UI / storage after our one-shot apply — stop overriding. */
  let userOverrideActive = false;
  /** Last real MPV subtitle style props from ShellVideo setProp (not localStorage). */
  const lastMpvStyles = {};
  let replayingMpvStyles = false;
  let replayStyleTimers = [];

  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  function normalizeLanguageCode(code) {
    if (!code || typeof code !== 'string') return '';
    const trimmed = code.trim().toLowerCase();
    if (!trimmed || trimmed === NONE_VALUE) return trimmed;
    return ISO2_TO_ISO3[trimmed] || trimmed;
  }

  function canonicalLanguage(code) {
    const normalized = normalizeLanguageCode(code);
    if (!normalized) return '';
    return CANONICAL_LANG[normalized] || normalized;
  }

  function languageMatches(trackLang, preferredLang) {
    const track = canonicalLanguage(trackLang);
    const preferred = canonicalLanguage(preferredLang);
    if (!track || !preferred) return false;
    if (track === preferred) return true;
    if (track.startsWith(preferred) || preferred.startsWith(track)) return true;
    if (track.slice(0, 2) === preferred.slice(0, 2)) return true;
    return false;
  }

  function readActiveSubsPreference() {
    try {
      return (localStorage.getItem(ACTIVE_SUBS_KEY) || '').trim().toLowerCase() || null;
    } catch {
      return null;
    }
  }

  function readFavoriteSubsList() {
    try {
      const raw = localStorage.getItem(FAV_SUBS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function reconcileStaleActiveSubsPreference() {
    const activeSubs = readActiveSubsPreference();
    if (!activeSubs || activeSubs === NONE_VALUE) return;

    const favorites = readFavoriteSubsList()
      .map((code) => canonicalLanguage(code))
      .filter((code) => code && code !== NONE_VALUE);

    if (favorites.includes(canonicalLanguage(activeSubs))) return;

    try {
      localStorage.removeItem(ACTIVE_SUBS_KEY);
      console.info('[StremioCustom] Removed invalid quick-select subtitle:', activeSubs);
    } catch (_) {}
  }

  function sendShellMpvSetProp(prop, value) {
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

  const SUBTITLE_STYLE_PROPS = new Set([
    'sub-ass-override',
    'sub-scale',
    'sub-pos',
    'sub-delay',
    'sub-color',
    'sub-back-color',
    'sub-border-color',
  ]);

  function parseShellWire(raw) {
    if (raw == null) return null;
    try {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!data || !Array.isArray(data.args)) return null;
      return data.args;
    } catch (_) {
      return null;
    }
  }

  function captureSubtitleStyleProp(prop, value) {
    if (!SUBTITLE_STYLE_PROPS.has(prop)) return;
    if (prop === 'sub-ass-override' && String(value).toLowerCase() === 'no') return;
    lastMpvStyles[prop] = value;
  }

  function replayCapturedSubtitleStyles() {
    if (!isPlayerRoute() || replayingMpvStyles) return;
    const entries = Object.entries(lastMpvStyles);
    if (!entries.length) return;
    replayingMpvStyles = true;
    try {
      for (const [prop, value] of entries) {
        sendShellMpvSetProp(prop, value);
      }
    } finally {
      replayingMpvStyles = false;
    }
  }

  function clearReplayStyleTimers() {
    for (const timer of replayStyleTimers) window.clearTimeout(timer);
    replayStyleTimers = [];
  }

  function scheduleReplayCapturedSubtitleStyles() {
    clearReplayStyleTimers();
    for (const delayMs of [0, 40, 200]) {
      replayStyleTimers.push(
        window.setTimeout(() => {
          replayCapturedSubtitleStyles();
        }, delayMs)
      );
    }
  }

  function onShellOutgoing(raw) {
    if (replayingMpvStyles) return;
    const args = parseShellWire(raw);
    if (!args || !args.length) return;
    if (args[0] === 'mpv-set-prop' && Array.isArray(args[1]) && args[1].length >= 2) {
      captureSubtitleStyleProp(String(args[1][0]), args[1][1]);
      return;
    }
    if (args[0] === 'mpv-command' && Array.isArray(args[1]) && args[1][0] === 'loadfile') {
      scheduleReplayCapturedSubtitleStyles();
    }
  }

  async function applyAssOverrideAndStyles() {
    replayCapturedSubtitleStyles();
  }

  async function readCoreSubtitleLanguage() {
    if (!window.core?.getState) return undefined;
    try {
      const ctx = await window.core.getState('ctx');
      return ctx?.profile?.settings?.subtitlesLanguage ?? null;
    } catch {
      return undefined;
    }
  }

  async function updateCoreSubtitleLanguage(subtitlesLanguage) {
    if (!window.core?.dispatch || !window.core?.getState) return false;
    try {
      const ctx = await window.core.getState('ctx');
      const settings = ctx?.profile?.settings;
      if (!settings) return false;
      const current = settings.subtitlesLanguage ?? null;
      if (current === subtitlesLanguage) return true;
      const fresh = await window.core.getState('ctx');
      const latest = fresh?.profile?.settings;
      if (!latest) return false;
      await window.core.dispatch({
        action: 'Ctx',
        args: {
          action: 'UpdateSettings',
          args: Object.assign({}, latest, { subtitlesLanguage }),
        },
      });
      return true;
    } catch (error) {
      console.warn('[StremioCustom] Subtitle setting sync failed:', error);
      return false;
    }
  }

  function findSubtitleTrack(tracks, preferredLang) {
    const subtitleTracks = tracks.filter((track) => track?.type === 'sub' && track.id != null);
    if (!subtitleTracks.length) return null;

    const exact = subtitleTracks.find((track) => languageMatches(track.lang, preferredLang));
    if (exact) return exact;

    return (
      subtitleTracks.find((track) => {
        const lang = canonicalLanguage(track.lang);
        const pref = canonicalLanguage(preferredLang);
        return lang && pref && (lang.includes(pref) || pref.includes(lang));
      }) || null
    );
  }

  async function resolveSubtitlePreference() {
    const activeSubs = readActiveSubsPreference();
    if (activeSubs === NONE_VALUE) {
      return { language: null, explicitOff: true };
    }
    if (activeSubs) {
      return { language: canonicalLanguage(activeSubs), explicitOff: false };
    }

    const coreSetting = await readCoreSubtitleLanguage();
    if (coreSetting) {
      return { language: canonicalLanguage(coreSetting), explicitOff: false };
    }
    return { language: null, explicitOff: false };
  }

  async function syncQuickSelectToCore() {
    if (isPlayerRoute()) return;
    reconcileStaleActiveSubsPreference();

    const activeSubs = readActiveSubsPreference();
    if (!activeSubs) return;

    const nextValue = activeSubs === NONE_VALUE ? null : canonicalLanguage(activeSubs);
    await updateCoreSubtitleLanguage(nextValue);
  }

  /**
   * Apply Quick Select once per player session when tracks arrive.
   * @param {Array} tracks
   */
  async function applySubtitlePreferenceOnce(tracks) {
    if (!isPlayerRoute() || !Array.isArray(tracks) || !tracks.length) return;
    if (appliedForSession || userOverrideActive) return;

    const preference = await resolveSubtitlePreference();
    appliedForSession = true;

    if (preference.explicitOff) {
      sendShellMpvSetProp('sid', 'no');
      console.info('[StremioCustom] Subtitles disabled once (None selected).');
      return;
    }

    if (!preference.language) {
      void applyAssOverrideAndStyles();
      return;
    }

    const expected = findSubtitleTrack(tracks, preference.language);
    if (!expected) {
      console.info(
        '[StremioCustom] No subtitle track for',
        preference.language,
        '- keeping current selection.'
      );
      void applyAssOverrideAndStyles();
      return;
    }

    const selectedSub = tracks.find((track) => track?.type === 'sub' && track.selected);
    if (
      selectedSub &&
      (selectedSub.id === expected.id || languageMatches(selectedSub.lang, preference.language))
    ) {
      void applyAssOverrideAndStyles();
      return;
    }

    sendShellMpvSetProp('sid', expected.id);
    void applyAssOverrideAndStyles();
    console.info(
      '[StremioCustom] Favorite subtitle applied once:',
      preference.language,
      'track',
      expected.id
    );
  }

  function onTrackListUpdate(change) {
    if (!isPlayerRoute()) return;
    const tracks = Array.isArray(change?.data) ? change.data : null;
    if (!tracks) return;

    lastTrackList = tracks;

    const selectedSub = tracks.some((track) => track?.type === 'sub' && track.selected);
    if (selectedSub) scheduleReplayCapturedSubtitleStyles();

    // After our one-shot apply, ignore further track-list churn so native menu wins.
    if (appliedForSession || userOverrideActive) return;

    if (trackListDebounce) clearTimeout(trackListDebounce);
    trackListDebounce = setTimeout(async () => {
      trackListDebounce = null;
      if (!isPlayerRoute() || !lastTrackList) return;
      await new Promise((resolve) => setTimeout(resolve, 400));
      await applySubtitlePreferenceOnce(lastTrackList);
    }, 300);
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

  function hookShellIncoming() {
    if (window.__stremioCustomSubtitleShellHook) return;
    window.__stremioCustomSubtitleShellHook = true;

    const handlePayload = (raw) => {
      try {
        const payload = parseShellPayload(raw);
        if (!payload) return;
        const change = payload[1];
        if (change?.name === 'track-list') {
          onTrackListUpdate(change);
        }
      } catch (_) {}
    };

    window.chrome?.webview?.addEventListener?.('message', (ev) => {
      handlePayload(ev?.data);
    });

    const transport = window.qt?.webChannelTransport;
    if (!transport || transport.__stremioCustomSubtitleOnMessageHooked) return;
    transport.__stremioCustomSubtitleOnMessageHooked = true;
    const original = transport.onmessage;
    transport.onmessage = function (ev) {
      try {
        handlePayload(ev?.data);
      } catch (_) {}
      if (typeof original === 'function') original.call(this, ev);
    };
  }

  /**
   * Reset session flags when entering/leaving the player.
   */
  function onRouteOrSessionChange() {
    hookShellIncoming();

    if (!isPlayerRoute()) {
      appliedForSession = false;
      userOverrideActive = false;
      lastTrackList = null;
      clearReplayStyleTimers();
      if (trackListDebounce) {
        clearTimeout(trackListDebounce);
        trackListDebounce = null;
      }
      syncQuickSelectToCore();
      return;
    }

    // New player visit — allow one Quick Select apply when tracks arrive.
    appliedForSession = false;
    userOverrideActive = false;
    lastTrackList = null;
  }

  window.__stremioCustomSubtitleSyncEnsure = onRouteOrSessionChange;
  window.__stremioCustomSubtitleSyncNow = syncQuickSelectToCore;

  window.addEventListener('storage', (event) => {
    if (event.key === ACTIVE_SUBS_KEY || event.key === FAV_SUBS_KEY) {
      // Settings changed outside the player — re-sync core; next player visit applies once.
      userOverrideActive = false;
      appliedForSession = false;
      if (!isPlayerRoute()) {
        syncQuickSelectToCore();
      } else if (lastTrackList) {
        // Explicit settings change while in player: allow one re-apply.
        appliedForSession = false;
        applySubtitlePreferenceOnce(lastTrackList);
      }
    }
  });

  // Native subtitle menu — stop forcing sid after the user picks a track.
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!isPlayerRoute()) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          '[class*="subtitles-menu"], [class*="subtitle-"], [class*="audio-track"], [class*="menu-container"]'
        )
      ) {
        userOverrideActive = true;
      }
    },
    true
  );

  document.addEventListener('stremio-custom-route-change', onRouteOrSessionChange);
  document.addEventListener('stremio-custom-stream-started', () => {
    // New stream in-player (e.g. binge): allow one Quick Select apply again.
    appliedForSession = false;
    userOverrideActive = false;
    lastTrackList = null;
    scheduleReplayCapturedSubtitleStyles();
  });
  document.addEventListener('stremio-custom-playback-stopped', onRouteOrSessionChange);
  document.addEventListener('stremio-custom-bootstrap-ready', onRouteOrSessionChange);
  document.addEventListener('stremio-shell-outgoing', (event) => {
    onShellOutgoing(event?.detail);
  });

  hookShellIncoming();
  onRouteOrSessionChange();

  console.info('[StremioCustom] Subtitle preference sync ready (one-shot + style replay).');
})();
