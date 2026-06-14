(function () {
  'use strict';

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
  let lastAppliedTrackId = null;
  let disableAttempts = 0;
  let lastDisableSignature = '';

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
      await window.core.dispatch({
        action: 'Ctx',
        args: {
          action: 'UpdateSettings',
          args: Object.assign({}, settings, { subtitlesLanguage }),
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

  function buildTrackSignature(tracks) {
    return tracks
      .map((track) => `${track?.type || ''}:${track?.id ?? ''}:${track?.selected ? 1 : 0}:${track?.lang || ''}`)
      .join('|');
  }

  async function disableSubtitlesIfNeeded(tracks) {
    const selectedSub = tracks.find((track) => track?.type === 'sub' && track.selected);
    if (!selectedSub) return;
    if (disableAttempts >= 8) return;

    const signature = buildTrackSignature(tracks);
    if (signature === lastDisableSignature && disableAttempts > 0) return;

    lastDisableSignature = signature;
    disableAttempts += 1;
    lastAppliedTrackId = null;
    sendShellMpvSetProp('sid', 'no');
    console.info('[StremioCustom] Subtitles disabled (None selected).');
  }

  async function applySubtitlePreferenceAfterTracks(tracks) {
    if (!isPlayerRoute() || !Array.isArray(tracks) || !tracks.length) return;

    const preference = await resolveSubtitlePreference();

    if (preference.explicitOff) {
      await disableSubtitlesIfNeeded(tracks);
      return;
    }

    disableAttempts = 0;
    lastDisableSignature = '';

    if (!preference.language) return;

    const expected = findSubtitleTrack(tracks, preference.language);
    if (!expected) {
      console.info(
        '[StremioCustom] No subtitle track for',
        preference.language,
        '- keeping current selection.'
      );
      return;
    }

    const selectedSub = tracks.find((track) => track?.type === 'sub' && track.selected);
    if (
      selectedSub &&
      (selectedSub.id === expected.id || languageMatches(selectedSub.lang, preference.language))
    ) {
      lastAppliedTrackId = expected.id;
      return;
    }

    if (lastAppliedTrackId === expected.id) return;

    lastAppliedTrackId = expected.id;
    sendShellMpvSetProp('sid', expected.id);
    console.info(
      '[StremioCustom] Favorite subtitle applied/corrected:',
      preference.language,
      'track',
      expected.id
    );
  }

  async function applyFavoriteSubtitlesAfterTracks(tracks) {
    await applySubtitlePreferenceAfterTracks(tracks);
  }

  async function syncSubtitleTracks() {
    if (!isPlayerRoute()) return;

    if (readActiveSubsPreference() === NONE_VALUE) {
      sendShellMpvSetProp('sid', 'no');
    }

    if (lastTrackList?.length) {
      await applySubtitlePreferenceAfterTracks(lastTrackList);
    }
  }

  function onTrackListUpdate(change) {
    if (!isPlayerRoute()) return;
    const tracks = Array.isArray(change?.data) ? change.data : null;
    if (!tracks) return;

    lastTrackList = tracks;
    lastAppliedTrackId = null;

    if (trackListDebounce) clearTimeout(trackListDebounce);
    trackListDebounce = setTimeout(async () => {
      trackListDebounce = null;
      if (!isPlayerRoute() || !lastTrackList) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
      await applySubtitlePreferenceAfterTracks(lastTrackList);
    }, 350);
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

  let syncTimer = null;
  let syncAttempts = 0;

  function scheduleSubtitleSync() {
    hookShellIncoming();

    if (!isPlayerRoute()) {
      syncAttempts = 0;
      lastTrackList = null;
      lastAppliedTrackId = null;
      disableAttempts = 0;
      lastDisableSignature = '';
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
      syncQuickSelectToCore();
      return;
    }

    syncSubtitleTracks();

    if (syncTimer) return;
    syncAttempts = 0;
    syncTimer = setInterval(() => {
      if (!isPlayerRoute()) {
        clearInterval(syncTimer);
        syncTimer = null;
        syncAttempts = 0;
        return;
      }
      syncAttempts += 1;
      syncSubtitleTracks();
      if (syncAttempts >= 25) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
    }, 1200);
  }

  window.__stremioCustomSubtitleSyncEnsure = scheduleSubtitleSync;
  window.__stremioCustomSubtitleSyncNow = syncQuickSelectToCore;

  window.addEventListener('storage', (event) => {
    if (event.key === ACTIVE_SUBS_KEY || event.key === FAV_SUBS_KEY) {
      lastAppliedTrackId = null;
      disableAttempts = 0;
      lastDisableSignature = '';
      if (!isPlayerRoute()) {
        syncQuickSelectToCore();
      } else if (lastTrackList) {
        applySubtitlePreferenceAfterTracks(lastTrackList);
      }
    }
  });

  window.addEventListener('hashchange', () => {
    lastTrackList = null;
    lastAppliedTrackId = null;
    disableAttempts = 0;
    lastDisableSignature = '';
    setTimeout(scheduleSubtitleSync, 50);
    setTimeout(scheduleSubtitleSync, 1500);
    setTimeout(scheduleSubtitleSync, 4000);
  });

  document.addEventListener('stremio-custom-bootstrap-ready', scheduleSubtitleSync);
  hookShellIncoming();

  if (isPlayerRoute()) scheduleSubtitleSync();
  else syncQuickSelectToCore();

  console.info('[StremioCustom] Subtitle preference sync ready.');
})();
