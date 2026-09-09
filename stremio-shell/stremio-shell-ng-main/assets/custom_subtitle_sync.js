(function () {
  'use strict';

  /**
   * Subtitle language: Quick Select on first apply, then persist the actually
   * selected language across in-player episode changes. Retry until MPV matches.
   */

  if (window.__stremioCustomSubtitleSync) return;
  window.__stremioCustomSubtitleSync = true;

  const ACTIVE_SUBS_KEY = 'stremio-custom-active-subs';
  const FAV_SUBS_KEY = 'stremio-custom-fav-subs';
  const SESSION_SUBS_KEY = 'stremio-custom-session-subs-lang';
  const NONE_VALUE = 'none';
  const MAX_APPLY_ATTEMPTS = 10;
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
  /** @type {{ language: string|null, explicitOff: boolean }|null} */
  let visitDesired = null;
  let menuPickPending = false;
  let applyAttempts = 0;
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

  function readSessionSubsLang() {
    try {
      return (localStorage.getItem(SESSION_SUBS_KEY) || '').trim().toLowerCase() || null;
    } catch {
      return null;
    }
  }

  function writeSessionSubsLang(value) {
    try {
      if (!value) {
        localStorage.removeItem(SESSION_SUBS_KEY);
        return;
      }
      localStorage.setItem(SESSION_SUBS_KEY, String(value));
    } catch (_) {}
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
      applyAttempts = 0;
      scheduleReplayCapturedSubtitleStyles();
      if (lastTrackList) scheduleApply(lastTrackList);
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

  function selectedSubtitleTrack(tracks) {
    return tracks.find((track) => track?.type === 'sub' && track.selected) || null;
  }

  function persistDesired(desired) {
    if (!desired) return;
    if (desired.explicitOff) {
      writeSessionSubsLang(NONE_VALUE);
      return;
    }
    if (desired.language) writeSessionSubsLang(desired.language);
  }

  async function resolveFreshDesired() {
    const activeSubs = readActiveSubsPreference();
    if (activeSubs === NONE_VALUE) {
      return { language: null, explicitOff: true };
    }
    if (activeSubs) {
      return { language: canonicalLanguage(activeSubs), explicitOff: false };
    }

    const session = readSessionSubsLang();
    if (session === NONE_VALUE) {
      return { language: null, explicitOff: true };
    }
    if (session) {
      return { language: canonicalLanguage(session), explicitOff: false };
    }

    const coreSetting = await readCoreSubtitleLanguage();
    if (coreSetting) {
      return { language: canonicalLanguage(coreSetting), explicitOff: false };
    }
    return { language: null, explicitOff: false };
  }

  async function ensureVisitDesired() {
    if (visitDesired) return visitDesired;
    visitDesired = await resolveFreshDesired();
    return visitDesired;
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
   * Apply the visit's desired subtitle language until the selected track matches.
   * @param {Array} tracks
   */
  async function applyVisitDesired(tracks) {
    if (!isPlayerRoute() || !Array.isArray(tracks) || !tracks.length) return;

    const desired = await ensureVisitDesired();

    if (desired.explicitOff) {
      const selected = selectedSubtitleTrack(tracks);
      if (selected) sendShellMpvSetProp('sid', 'no');
      persistDesired(desired);
      void applyAssOverrideAndStyles();
      return;
    }

    if (!desired.language) {
      void applyAssOverrideAndStyles();
      return;
    }

    const expected = findSubtitleTrack(tracks, desired.language);
    if (!expected) {
      console.info(
        '[StremioCustom] No subtitle track for',
        desired.language,
        '- keeping current selection.'
      );
      void applyAssOverrideAndStyles();
      return;
    }

    const selectedSub = selectedSubtitleTrack(tracks);
    if (
      selectedSub &&
      (selectedSub.id === expected.id || languageMatches(selectedSub.lang, desired.language))
    ) {
      persistDesired(desired);
      applyAttempts = 0;
      void applyAssOverrideAndStyles();
      return;
    }

    if (applyAttempts >= MAX_APPLY_ATTEMPTS) {
      void applyAssOverrideAndStyles();
      return;
    }

    applyAttempts += 1;
    sendShellMpvSetProp('sid', expected.id);
    persistDesired(desired);
    void applyAssOverrideAndStyles();
    console.info(
      '[StremioCustom] Subtitle language applied:',
      desired.language,
      'track',
      expected.id,
      'attempt',
      applyAttempts
    );
  }

  function scheduleApply(tracks) {
    if (trackListDebounce) clearTimeout(trackListDebounce);
    trackListDebounce = setTimeout(async () => {
      trackListDebounce = null;
      if (!isPlayerRoute()) return;
      const list = tracks || lastTrackList;
      if (!list) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
      await applyVisitDesired(lastTrackList || list);
    }, 250);
  }

  function onTrackListUpdate(change) {
    if (!isPlayerRoute()) return;
    const tracks = Array.isArray(change?.data) ? change.data : null;
    if (!tracks) return;

    lastTrackList = tracks;

    const selectedSub = selectedSubtitleTrack(tracks);
    if (selectedSub) scheduleReplayCapturedSubtitleStyles();

    if (menuPickPending) {
      menuPickPending = false;
      if (selectedSub) {
        const lang = canonicalLanguage(selectedSub.lang);
        visitDesired = lang
          ? { language: lang, explicitOff: false }
          : { language: null, explicitOff: false };
      } else {
        visitDesired = { language: null, explicitOff: true };
      }
      persistDesired(visitDesired);
      applyAttempts = 0;
      void applyAssOverrideAndStyles();
      return;
    }

    scheduleApply(tracks);
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
   * Reset visit state when entering/leaving the player. Session language stays.
   */
  function onRouteOrSessionChange() {
    hookShellIncoming();

    if (!isPlayerRoute()) {
      visitDesired = null;
      menuPickPending = false;
      applyAttempts = 0;
      lastTrackList = null;
      clearReplayStyleTimers();
      if (trackListDebounce) {
        clearTimeout(trackListDebounce);
        trackListDebounce = null;
      }
      syncQuickSelectToCore();
      return;
    }

    applyAttempts = 0;
    if (lastTrackList) scheduleApply(lastTrackList);
  }

  function onStreamStarted() {
    applyAttempts = 0;
    scheduleReplayCapturedSubtitleStyles();
    if (lastTrackList) scheduleApply(lastTrackList);
  }

  window.__stremioCustomSubtitleSyncEnsure = onRouteOrSessionChange;
  window.__stremioCustomSubtitleSyncNow = syncQuickSelectToCore;

  window.addEventListener('storage', (event) => {
    if (event.key === ACTIVE_SUBS_KEY || event.key === FAV_SUBS_KEY) {
      visitDesired = null;
      applyAttempts = 0;
      if (!isPlayerRoute()) {
        syncQuickSelectToCore();
      } else if (lastTrackList) {
        scheduleApply(lastTrackList);
      }
    }
  });

  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!isPlayerRoute()) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[class*="subtitles-menu"] [class*="language-option"]')) {
        menuPickPending = true;
      }
    },
    true
  );

  document.addEventListener('stremio-custom-route-change', onRouteOrSessionChange);
  document.addEventListener('stremio-custom-stream-started', onStreamStarted);
  document.addEventListener('stremio-custom-playback-stopped', onRouteOrSessionChange);
  document.addEventListener('stremio-custom-bootstrap-ready', onRouteOrSessionChange);
  document.addEventListener('stremio-shell-outgoing', (event) => {
    onShellOutgoing(event?.detail);
  });

  hookShellIncoming();
  onRouteOrSessionChange();

  console.info('[StremioCustom] Subtitle preference sync ready (persist + retry).');
})();
