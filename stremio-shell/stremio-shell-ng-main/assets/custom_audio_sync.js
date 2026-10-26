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
  // Bibliographic (ger), terminological (deu) and ISO-639-1 (de) are one language.
  const LANG_CANON = {
    ger: 'de', deu: 'de', de: 'de', german: 'de', deutsch: 'de',
    eng: 'en', en: 'en', english: 'en',
    jpn: 'ja', ja: 'ja', japanese: 'ja',
    fra: 'fr', fre: 'fr', fr: 'fr', french: 'fr',
    spa: 'es', es: 'es', spanish: 'es',
    ita: 'it', it: 'it', italian: 'it',
    por: 'pt', pt: 'pt', portuguese: 'pt',
    rus: 'ru', ru: 'ru', russian: 'ru',
    kor: 'ko', ko: 'ko', korean: 'ko',
    zho: 'zh', chi: 'zh', zh: 'zh', chinese: 'zh',
    ara: 'ar', ar: 'ar', arabic: 'ar',
    nld: 'nl', dut: 'nl', nl: 'nl', dutch: 'nl',
    pol: 'pl', pl: 'pl', polish: 'pl',
    tur: 'tr', tr: 'tr', turkish: 'tr',
    ces: 'cs', cze: 'cs', cs: 'cs', czech: 'cs',
  };

  let shellMsgId = 8000;
  let trackListDebounce = null;
  let lastTrackList = null;
  let lastAppliedTrackId = null;

  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  function canonicalLang(code) {
    if (!code || typeof code !== 'string') return '';
    const base = code.trim().toLowerCase().replace('_', '-').split('-')[0];
    if (!base || base === 'none' || base === 'und') return '';
    return LANG_CANON[base] || LANG_CANON[ISO2_TO_ISO3[base]] || base;
  }

  function languageMatches(trackLang, preferredLang) {
    const track = canonicalLang(trackLang);
    const preferred = canonicalLang(preferredLang);
    return Boolean(track && preferred && track === preferred);
  }

  function readJsonList(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function pushLang(order, code) {
    const canon = canonicalLang(code);
    if (!canon || order.some((item) => item.canon === canon)) return;
    order.push({ code: String(code).trim().toLowerCase(), canon });
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

  function findAudioTrack(tracks, order) {
    const audioTracks = tracks.filter((track) => track?.type === 'audio' && track.id != null);
    for (const pref of order) {
      const hit = audioTracks.find((track) => languageMatches(track.lang || track.language, pref.canon));
      if (hit) return { track: hit, pref };
    }
    return null;
  }

  async function resolveAudioOrder() {
    // Same order as Quick Play: quick-select, otherwise the profile default, then favorites.
    const order = [];
    try {
      const active = localStorage.getItem(ACTIVE_AUDIO_KEY);
      if (active && active !== 'none') pushLang(order, active);
    } catch (_) {}
    if (!order.length) pushLang(order, await readCoreAudioSetting());
    try {
      readJsonList(FAV_AUDIO_KEY).forEach((code) => pushLang(order, code));
    } catch (_) {}
    return order;
  }

  async function applyFavoriteAudioAfterTracks(tracks) {
    if (!isPlayerRoute() || !Array.isArray(tracks) || !tracks.length) return;

    const order = await resolveAudioOrder();
    if (!order.length) return;

    const found = findAudioTrack(tracks, order);
    if (!found) {
      console.info(
        '[StremioCustom] No embedded audio track for',
        order.map((item) => item.code).join(', '),
        '- keeping current track.'
      );
      return;
    }

    if (found.pref === order[0]) await updateCoreSetting(found.pref.code);

    const selectedAudio = tracks.find((track) => track?.type === 'audio' && track.selected);
    if (
      selectedAudio &&
      (selectedAudio.id === found.track.id || languageMatches(selectedAudio.lang, found.pref.canon))
    ) {
      lastAppliedTrackId = found.track.id;
      return;
    }

    lastAppliedTrackId = found.track.id;
    // mpv aid is an int. A JSON number arrives as f64 and is rejected; the shell sends a string.
    sendShellMpvSetProp('aid', String(found.track.id));
    console.info(
      '[StremioCustom] Audio track applied:',
      found.pref.code,
      'track',
      found.track.id,
      found.track.lang || ''
    );
  }

  async function syncAudioPreference() {
    if (!isPlayerRoute()) return;
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

    if (trackListDebounce) clearTimeout(trackListDebounce);
    trackListDebounce = setTimeout(async () => {
      trackListDebounce = null;
      if (!isPlayerRoute() || !lastTrackList) return;
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

  document.addEventListener('stremio-custom-route-change', () => {
    lastTrackList = null;
    lastAppliedTrackId = null;
    setTimeout(scheduleAudioSync, 50);
    setTimeout(scheduleAudioSync, 1500);
    setTimeout(scheduleAudioSync, 4000);
  });
  document.addEventListener('stremio-custom-playback-stopped', scheduleAudioSync);

  document.addEventListener('stremio-custom-bootstrap-ready', scheduleAudioSync);
  hookShellIncoming();

  if (canonicalLang('deu') !== 'de' || canonicalLang('ger') !== 'de' || canonicalLang('eng') === 'de') {
    console.warn('[StremioCustom] audio language map is wrong');
  }

  if (isPlayerRoute()) scheduleAudioSync();
  console.info('[StremioCustom] Audio preference sync ready.');
})();
