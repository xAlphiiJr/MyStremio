(function () {
  'use strict';

  if (window.__stremioCustomAudioSync) return;
  window.__stremioCustomAudioSync = true;

  const ACTIVE_AUDIO_KEY = 'stremio-custom-active-audio';
  const FAV_AUDIO_KEY = 'stremio-custom-fav-audio';
  const ISO2_TO_ISO3 = {
    de: 'ger',
    en: 'eng',
    ja: 'jpn',
    fr: 'fra',
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
    cs: 'cze',
  };

  let shellMsgId = 8000;
  let trackListDebounce = null;
  let lastTrackList = null;
  let lastAppliedTrackId = null;
  let applyAttempts = 0;

  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  function normalizeLanguageCode(code) {
    if (!code || typeof code !== 'string') return '';
    const trimmed = code.trim().toLowerCase();
    if (!trimmed) return '';
    return ISO2_TO_ISO3[trimmed] || trimmed;
  }

  function languageMatches(trackLang, preferredLang) {
    const track = normalizeLanguageCode(trackLang);
    const preferred = normalizeLanguageCode(preferredLang);
    if (!track || !preferred) return false;
    if (track === preferred) return true;
    if (track.startsWith(preferred) || preferred.startsWith(track)) return true;
    if (track.slice(0, 2) === preferred.slice(0, 2)) return true;
    return false;
  }

  function readJsonList(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function readActiveAudioPreference() {
    try {
      const active = normalizeLanguageCode(localStorage.getItem(ACTIVE_AUDIO_KEY));
      if (active) return active;
      const favorites = readJsonList(FAV_AUDIO_KEY)
        .map(normalizeLanguageCode)
        .filter(Boolean);
      return favorites[0] || null;
    } catch {
      return null;
    }
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

  async function updateCoreSetting(audioLanguage) {
    if (!window.core?.dispatch || !window.core?.getState) return false;
    try {
      const ctx = await window.core.getState('ctx');
      const settings = ctx?.profile?.settings;
      if (!settings) return false;
      if (settings.audioLanguage === audioLanguage) return true;
      await window.core.dispatch({
        action: 'Ctx',
        args: {
          action: 'UpdateSettings',
          args: Object.assign({}, settings, { audioLanguage }),
        },
      });
      return true;
    } catch (error) {
      console.warn('[StremioCustom] Audio setting sync failed:', error);
      return false;
    }
  }

  async function readCoreAudioSetting() {
    if (!window.core?.getState) return undefined;
    try {
      const ctx = await window.core.getState('ctx');
      return ctx?.profile?.settings?.audioLanguage ?? null;
    } catch {
      return undefined;
    }
  }

  function findAudioTrack(tracks, preferredLang) {
    const audioTracks = tracks.filter((track) => track?.type === 'audio' && track.id != null);
    if (!audioTracks.length) return null;

    const exact = audioTracks.find((track) => languageMatches(track.lang, preferredLang));
    if (exact) return exact;

    return (
      audioTracks.find((track) => {
        const lang = normalizeLanguageCode(track.lang);
        const pref = normalizeLanguageCode(preferredLang);
        return lang && pref && (lang.includes(pref) || pref.includes(lang));
      }) || null
    );
  }

  async function resolveAudioPreference() {
    const activeAudio = readActiveAudioPreference();
    if (activeAudio) {
      return { language: activeAudio };
    }
    const coreSetting = await readCoreAudioSetting();
    if (coreSetting) {
      return { language: normalizeLanguageCode(coreSetting) };
    }
    return { language: null };
  }

  async function applyFavoriteAudioAfterTracks(tracks) {
    if (!isPlayerRoute() || !Array.isArray(tracks) || !tracks.length) return;

    const preference = await resolveAudioPreference();
    if (!preference.language) return;

    await updateCoreSetting(preference.language);

    const expected = findAudioTrack(tracks, preference.language);
    if (!expected) {
      console.info(
        '[StremioCustom] No embedded audio track for',
        preference.language,
        '- keeping current track.'
      );
      return;
    }

    const selectedAudio = tracks.find((track) => track?.type === 'audio' && track.selected);
    if (
      selectedAudio &&
      (selectedAudio.id === expected.id || languageMatches(selectedAudio.lang, preference.language))
    ) {
      lastAppliedTrackId = expected.id;
      return;
    }

    if (lastAppliedTrackId === expected.id) return;

    lastAppliedTrackId = expected.id;
    sendShellMpvSetProp('aid', expected.id);
    console.info(
      '[StremioCustom] Favorite audio applied/corrected:',
      preference.language,
      'track',
      expected.id
    );
  }

  async function syncAudioPreference() {
    if (!isPlayerRoute()) return;

    const preference = await resolveAudioPreference();
    if (!preference.language) return;

    await updateCoreSetting(preference.language);

    if (lastTrackList?.length) {
      await applyFavoriteAudioAfterTracks(lastTrackList);
    }
  }

  function onTrackListUpdate(change) {
    if (!isPlayerRoute()) return;
    const tracks = Array.isArray(change?.data) ? change.data : null;
    if (!tracks) return;

    lastTrackList = tracks;
    lastAppliedTrackId = null;
    applyAttempts = 0;

    if (trackListDebounce) clearTimeout(trackListDebounce);
    trackListDebounce = setTimeout(async () => {
      trackListDebounce = null;
      if (!isPlayerRoute() || !lastTrackList) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
      await applyFavoriteAudioAfterTracks(lastTrackList);
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
    if (window.__stremioCustomAudioShellHook) return;
    window.__stremioCustomAudioShellHook = true;

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
    if (!transport || transport.__stremioCustomAudioOnMessageHooked) return;
    transport.__stremioCustomAudioOnMessageHooked = true;
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

  function scheduleAudioSync() {
    hookShellIncoming();
    if (!isPlayerRoute()) {
      syncAttempts = 0;
      lastTrackList = null;
      lastAppliedTrackId = null;
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
      return;
    }

    syncAudioPreference();

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
      syncAudioPreference();
      if (syncAttempts >= 25) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
    }, 1200);
  }

  window.addEventListener('storage', (event) => {
    if (
      event.key === ACTIVE_AUDIO_KEY ||
      event.key === FAV_AUDIO_KEY ||
      event.key === 'audioLanguage'
    ) {
      lastAppliedTrackId = null;
      if (lastTrackList) applyFavoriteAudioAfterTracks(lastTrackList);
    }
  });

  window.__stremioCustomAudioSyncEnsure = scheduleAudioSync;

  window.addEventListener('hashchange', () => {
    lastTrackList = null;
    lastAppliedTrackId = null;
    setTimeout(scheduleAudioSync, 50);
    setTimeout(scheduleAudioSync, 1500);
    setTimeout(scheduleAudioSync, 4000);
  });

  document.addEventListener('stremio-custom-bootstrap-ready', scheduleAudioSync);
  hookShellIncoming();

  if (isPlayerRoute()) scheduleAudioSync();
  console.info('[StremioCustom] Audio preference sync ready.');
})();
