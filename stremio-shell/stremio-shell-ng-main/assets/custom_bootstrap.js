(function () {
  // ContentLoading injects into every WebView frame; only the top frame may own bootstrap IPC.
  if (window.self !== window.top) return;
  if (window.__stremioCustomBootstrap) return;
  window.__stremioCustomBootstrap = true;

  const PLUGIN_EXT = '.plugin.js';
  const pending = new Map();
  let requestId = 1;
  const settingsCallbacks = new Map();
  let appliedThemeName = null;
  let pathsCache = null;

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs] Default 15s; use shorter for cold-boot critical path.
   */
  function invoke(method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = requestId++;
      pending.set(id, { resolve, reject });
      try {
        window.chrome.webview.postMessage(
          JSON.stringify({ stremioCustom: true, id, method, params: params || {} })
        );
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
      const ms = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 15000;
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Custom API timeout: ${method}`));
        }
      }, ms);
    });
  }

  window.__stremioCustomDeliverApiMessage = function (data) {
    if (!data || !data.stremioCustom) return;
    if (data.event === 'on-settings-saved' && data.pluginBaseName) {
      (settingsCallbacks.get(data.pluginBaseName) || []).forEach((cb) => {
        try {
          cb(data.payload);
        } catch (error) {
          console.error('[StremioCustom] settings callback failed', error);
        }
      });
      if (data.id != null && pending.has(data.id)) {
        const entry = pending.get(data.id);
        pending.delete(data.id);
        entry.resolve(data.result ?? true);
      }
      return;
    }
    if (data.event === 'on-api-key-saved') {
      const pluginBases = Array.isArray(data.pluginBaseNames) ? data.pluginBaseNames : [];
      pluginBases.forEach((pluginBaseName) => {
        const callbacks = settingsCallbacks.get(pluginBaseName) || [];
        if (!callbacks.length) return;
        // Deliver overlayed plugin config so listeners get real key fields (tmdbApiKey, …).
        const notify = (payload) => {
          callbacks.forEach((cb) => {
            try {
              cb(payload);
            } catch (error) {
              console.error('[StremioCustom] api-key settings callback failed', error);
            }
          });
        };
        if (typeof api?.getPluginConfig === 'function') {
          api
            .getPluginConfig(pluginBaseName)
            .then((config) => notify(config && typeof config === 'object' ? config : { apiKeyServiceId: data.serviceId, value: data.payload }))
            .catch(() => notify({ apiKeyServiceId: data.serviceId, value: data.payload }));
        } else {
          notify({ apiKeyServiceId: data.serviceId, value: data.payload });
        }
      });
      try {
        document.dispatchEvent(
          new CustomEvent('mystremio-api-keys-changed', {
            detail: { serviceId: data.serviceId, value: data.payload, pluginBaseNames: pluginBases },
          })
        );
      } catch (_) {}
      if (data.id != null && pending.has(data.id)) {
        const entry = pending.get(data.id);
        pending.delete(data.id);
        entry.resolve(data.result ?? true);
      }
      return;
    }
    if (data.id == null) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(String(data.error)));
    else entry.resolve(data.result);
  };

  function maybeHandleWindowResumedMessage(data) {
    try {
      const args = Array.isArray(data?.args) ? data.args : null;
      if (!args || args[0] !== 'mystremio-window-resumed') return false;
      if (typeof window.__stremioCustomOnWindowResumed === 'function') {
        window.__stremioCustomOnWindowResumed('shell-rpc');
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function hookShellMessages() {
    if (window.__stremioCustomShellMessagesHooked) return;
    window.__stremioCustomShellMessagesHooked = true;
    if (window.chrome?.webview) {
      window.chrome.webview.addEventListener('message', (ev) => {
        try {
          const raw = ev?.data;
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (data?.stremioCustom) {
            window.__stremioCustomDeliverApiMessage(data);
            return;
          }
          maybeHandleWindowResumedMessage(data);
        } catch (_) {}
      });
    }
    const transport = window.qt?.webChannelTransport;
    if (!transport) return;
    const original = transport.onmessage;
    transport.onmessage = function (ev) {
      try {
        const raw = ev?.data;
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (data?.stremioCustom) {
          window.__stremioCustomDeliverApiMessage(data);
          return;
        }
        if (maybeHandleWindowResumedMessage(data)) return;
      } catch (_) {}
      if (typeof original === 'function') original.call(this, ev);
    };
  }

  const api = {
    getSetting: (pluginBaseName, key) => invoke('get-plugin-setting', { pluginBaseName, key }),
    saveSetting: (pluginBaseName, key, value) =>
      invoke('save-plugin-setting', { pluginBaseName, key, value }),
    getPluginConfig: (pluginBaseName) => invoke('get-plugin-config', { pluginBaseName }),
    registerSettings: (pluginBaseName, schema) =>
      invoke('register-plugin-settings', { pluginBaseName, schema }),
    getRegisteredSettings: (pluginBaseName) =>
      invoke('get-registered-settings', { pluginBaseName }),
    clearRegisteredSettings: (pluginBaseName) =>
      invoke('clear-registered-settings', { pluginBaseName }),
    onSettingsSaved: (pluginBaseName, callback) => {
      if (!settingsCallbacks.has(pluginBaseName)) settingsCallbacks.set(pluginBaseName, []);
      settingsCallbacks.get(pluginBaseName).push(callback);
      return () => {
        settingsCallbacks.set(
          pluginBaseName,
          (settingsCallbacks.get(pluginBaseName) || []).filter((cb) => cb !== callback)
        );
      };
    },
    getPaths: async () => {
      if (!pathsCache) pathsCache = await invoke('get-paths');
      return pathsCache;
    },
    openFolder: (folderPath) => invoke('open-folder', { path: folderPath }),
    listPlugins: () => invoke('list-plugins'),
    listThemes: () => invoke('list-themes'),
    readTheme: (fileName) => invoke('read-theme', { fileName }),
    readPlugin: (fileRef) => invoke('read-plugin', { fileRef }),
    getMetadata: (path) => invoke('get-metadata', { path }),
    getUserPreferences: () => invoke('get-user-preferences'),
    saveUserPreferences: (preferences) => invoke('save-user-preferences', preferences),
    getAutoskipSettings: () => invoke('get-autoskip-settings'),
    saveAutoskipSettings: (settings) => invoke('save-autoskip-settings', settings),
    getPlayerVolume: () => invoke('get-player-volume'),
    savePlayerVolume: (settings) => invoke('save-player-volume', settings),
    openExternalUrl: (url) => invoke('open-external-url', { url }),
    listApiKeyServices: () => invoke('list-api-key-services'),
    getApiKey: (serviceId) => invoke('get-api-key', { serviceId }),
    setApiKey: (serviceId, value) => invoke('set-api-key', { serviceId, value }),
    getPluginApiKeyStatus: (pluginBaseName) =>
      invoke('get-plugin-api-key-status', { pluginBaseName }),
    invoke,
    info: (pluginBaseName, message) => console.info(`[${pluginBaseName}]`, message),
    warn: (pluginBaseName, message) => console.warn(`[${pluginBaseName}]`, message),
    error: (pluginBaseName, message) => console.error(`[${pluginBaseName}]`, message),
  };

  window.StremioCustomAPI = api;
  window.StremioEnhancedAPI = api;

  function readAuthProfileSnapshot() {
    try {
      const raw = localStorage.getItem('profile');
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      return parsed?.auth?.key ? raw : '';
    } catch (_) {
      return '';
    }
  }

  function restoreAuthProfileFromDisk(authProfile) {
    if (typeof authProfile !== 'string' || !authProfile.trim()) return false;
    try {
      const parsed = JSON.parse(authProfile);
      if (!parsed?.auth?.key) return false;
      const existing = localStorage.getItem('profile');
      if (existing) {
        const current = JSON.parse(existing);
        if (current?.auth?.key) return false;
      }
      localStorage.setItem('profile', authProfile);
      document.dispatchEvent(new CustomEvent('stremio-custom-auth-restored'));
      return true;
    } catch (_) {
      return false;
    }
  }

  let authProfileSyncTimer = null;
  let lastPersistedAuthProfile = '';

  function scheduleAuthProfilePersistence() {
    const sync = () => {
      const snapshot = readAuthProfileSnapshot();
      if (!snapshot || snapshot === lastPersistedAuthProfile) return;
      lastPersistedAuthProfile = snapshot;
      persistUserPreferences();
    };

    window.addEventListener('storage', sync);
    window.setTimeout(sync, 2500);
    window.setTimeout(sync, 10000);
    if (authProfileSyncTimer) window.clearInterval(authProfileSyncTimer);
    authProfileSyncTimer = window.setInterval(sync, 30000);
  }

  document.addEventListener('stremio-custom-volume-changed', () => {
    persistUserPreferences();
  });

  function persistUserPreferences() {
    const authProfile = readAuthProfileSnapshot();
    if (authProfile) lastPersistedAuthProfile = authProfile;
    api.saveUserPreferences({
      enabledPlugins: getEnabledPlugins(),
      currentTheme: LIQUID_GLASS_THEME,
      autoskip: getAutoskipPreferences(),
      metadataAddon: getMetadataAddon(),
      language: getLanguagePreferences(),
      preload: getPreloadPreference(),
      volume: getVolumePreferences(),
      discordPresence: getDiscordPresencePreferences(),
      library: getLibraryPreferences(),
      authProfile,
      uiScale: getUiScalePreference(),
      onboarding: {
        tmdbNoticeShown: localStorage.getItem(TMDB_NOTICE_KEY) === 'true',
        defaultsApplied: localStorage.getItem(DEFAULTS_APPLIED_KEY) === 'true',
      },
    }).catch(() => {});
  }

  const AUTOSKIP_KEYS = {
    intro: 'stremio-custom-autoskip-intro',
    credits: 'stremio-custom-autoskip-credits',
    recap: 'stremio-custom-autoskip-recap',
    preview: 'stremio-custom-autoskip-preview',
  };

  const LIQUID_GLASS_THEME = 'liquid-glass.theme.css';
  const HORIZONTAL_NAV_PLUGIN = 'interface/horizontal-navigation.plugin.js';
  const METADATA_ADDON_KEY = 'stremio-custom-metadata-addon';
  const PRELOAD_SECS_KEY = 'stremio-custom-preload-secs';
  const UI_SCALE_PERCENT_KEY = 'stremio-custom-ui-scale-percent';
  const VOLUME_KEYS = {
    level: 'stremio-custom-player-volume',
    muted: 'stremio-custom-player-muted',
  };
  const DISCORD_KEYS = {
    enabled: 'stremio-custom-discord-rp-enabled',
    showPaused: 'stremio-custom-discord-rp-show-paused',
    showMenu: 'stremio-custom-discord-rp-show-menu',
  };
  const LIBRARY_KEYS = {
    folders: 'stremio-custom-library-folders',
    activeFolder: 'stremio-custom-library-active-folder',
  };
  const LANGUAGE_KEYS = {
    favAudio: 'stremio-custom-fav-audio',
    activeAudio: 'stremio-custom-active-audio',
    favSubs: 'stremio-custom-fav-subs',
    activeSubs: 'stremio-custom-active-subs',
  };
  const TMDB_NOTICE_KEY = 'stremio-custom-tmdb-notice-shown-v211d';
  const DEFAULTS_APPLIED_KEY = 'stremio-custom-defaults-applied-v211a';
  const NATIVE_PLAYER_FEATURES_MIGRATED_KEY = 'stremio-custom-migrate-brightness-hover-v1';
  const BRIGHTNESS_TO_PICTURE_MIGRATED_KEY = 'stremio-custom-migrate-brightness-to-picture-v1';
  const ANIME4K_PLUGIN_MIGRATED_KEY = 'stremio-custom-migrate-anime4k-v1';
  const DEFAULT_DISABLED_PLUGIN_PATTERNS = [
    /slash[-_ ]?to[-_ ]?search/i,
    /anime4k/i,
  ];
  const DYNAMIC_HERO_PLUGIN = 'interface/hero-div.plugin.js';
  const DYNAMIC_HERO_ENABLED_KEY = 'mystremio_dynamic_hero_enabled_v1';
  const DYNAMIC_HERO_METADATA = {
    name: 'Dynamic Hero',
    version: '26.2.0',
    author: 'Fxy6969; adapted by MyStremio',
    description: 'Rotating hero banner on the board with featured titles.',
    category: 'interface',
  };

  function isHeroPluginRef(fileRef) {
    const normalized = String(fileRef || '').replace(/\\/g, '/');
    const baseName = normalized.split('/').pop() || '';
    return /hero[-_]?div\.plugin\.js$/i.test(normalized) || /hero[-_]?div\.plugin\.js$/i.test(baseName);
  }

  function cleanupLegacyScrollbarDom() {
    document.getElementById('stremio-custom-scrollbar-track')?.remove();
    document.getElementById('stremio-custom-scrollbar-style')?.remove();
    document.getElementById('stremio-custom-scrollbar-fix')?.remove();
    for (const el of document.querySelectorAll('.stremio-custom-scroll-host')) {
      el.classList.remove('stremio-custom-scroll-host');
    }
  }

  function cleanupLegacyHeroDom() {
    if (window.__MYSTREMIO_REACT_HERO__) {
      document.getElementById('mystremio-hero-layout-styles')?.remove();
      if (window.heroObserver) {
        try {
          window.heroObserver.disconnect();
        } catch (_) {}
        delete window.heroObserver;
      }
      return;
    }

    document.querySelectorAll('.mystremio-hero-slot').forEach((node) => node.remove());
    document.getElementById('mystremio-hero-layout-styles')?.remove();
    if (window.heroObserver) {
      try {
        window.heroObserver.disconnect();
      } catch (_) {}
      delete window.heroObserver;
    }
    delete window.__MYSTREMIO_REACT_HERO__;
    document.dispatchEvent(new CustomEvent('stremio-custom-hero-layout-changed'));
  }

  function isDynamicHeroEnabled() {
    return localStorage.getItem(DYNAMIC_HERO_ENABLED_KEY) !== '0';
  }

  function syncDynamicHeroEnabledFlag(plugins = getEnabledPlugins()) {
    if (!isDynamicHeroEnabled()) {
      cleanupLegacyHeroDom();
      return false;
    }
    return true;
  }

  api.listPlugins = async () => {
    const plugins = await invoke('list-plugins');
    if (!Array.isArray(plugins)) return plugins;
    if (plugins.some((ref) => isHeroPluginRef(ref))) return plugins;
    return [...plugins, DYNAMIC_HERO_PLUGIN];
  };

  api.getMetadata = async (path) => {
    if (isHeroPluginRef(path)) return DYNAMIC_HERO_METADATA;
    return invoke('get-metadata', { path });
  };
  let autoskipCache = { intro: false, credits: false, recap: false, preview: false };
  let autoskipReady = false;
  let autoskipReadyPromise = null;

  function getAutoskipPreferences() {
    return { ...autoskipCache };
  }

  function applyAutoskipPreferences(prefs) {
    if (!prefs || typeof prefs !== 'object') return;
    for (const [id, key] of Object.entries(AUTOSKIP_KEYS)) {
      if (typeof prefs[id] === 'boolean') {
        autoskipCache[id] = prefs[id];
        localStorage.setItem(key, String(prefs[id]));
      }
    }
  }

  async function loadAutoskipSettings() {
    try {
      const disk = await api.getAutoskipSettings();
      const local = {};
      for (const [id, key] of Object.entries(AUTOSKIP_KEYS)) {
        try {
          local[id] = localStorage.getItem(key) === 'true';
        } catch {
          local[id] = false;
        }
      }
      const merged = mergeAutoskipPreferences(disk, local);
      applyAutoskipPreferences(merged);
      await api.saveAutoskipSettings(merged);
    } catch (_) {
      for (const [id, key] of Object.entries(AUTOSKIP_KEYS)) {
        try {
          autoskipCache[id] = localStorage.getItem(key) === 'true';
        } catch {
          autoskipCache[id] = false;
        }
      }
      await api.saveAutoskipSettings(getAutoskipPreferences()).catch(() => {});
    }
    autoskipReady = true;
    refreshAutoskipToggles();
    document.dispatchEvent(new CustomEvent('stremio-custom-autoskip-ready'));
  }

  function ensureAutoskipReady() {
    if (autoskipReady) return Promise.resolve(getAutoskipPreferences());
    if (!autoskipReadyPromise) {
      autoskipReadyPromise = loadAutoskipSettings().then(() => getAutoskipPreferences());
    }
    return autoskipReadyPromise;
  }

  async function setAutoskipEnabled(id, enabled) {
    const key = AUTOSKIP_KEYS[id];
    if (!key) return;
    const next = Boolean(enabled);
    autoskipCache[id] = next;
    localStorage.setItem(key, String(next));
    refreshAutoskipToggles();
    try {
      await api.saveAutoskipSettings(getAutoskipPreferences());
    } catch (_) {}
    persistUserPreferences();
  }

  function getMetadataAddon() {
    try {
      return localStorage.getItem(METADATA_ADDON_KEY) || '';
    } catch {
      return '';
    }
  }

  function setMetadataAddon(value) {
    const next = String(value || '');
    try {
      localStorage.setItem(METADATA_ADDON_KEY, next);
    } catch (_) {}
    persistUserPreferences();
    document.dispatchEvent(new CustomEvent('stremio-custom-metadata-addon-changed', { detail: { value: next } }));
  }

  function readJsonList(key) {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function getLanguagePreferences() {
    return {
      favAudio: readJsonList(LANGUAGE_KEYS.favAudio),
      activeAudio: localStorage.getItem(LANGUAGE_KEYS.activeAudio) || '',
      favSubs: readJsonList(LANGUAGE_KEYS.favSubs),
      activeSubs: localStorage.getItem(LANGUAGE_KEYS.activeSubs) || '',
    };
  }

  function applyLanguagePreferences(prefs) {
    if (!prefs || typeof prefs !== 'object') return;
    if (Array.isArray(prefs.favAudio)) {
      localStorage.setItem(LANGUAGE_KEYS.favAudio, JSON.stringify(prefs.favAudio));
    }
    if (Array.isArray(prefs.favSubs)) {
      localStorage.setItem(LANGUAGE_KEYS.favSubs, JSON.stringify(prefs.favSubs));
    }
    if (typeof prefs.activeAudio === 'string') {
      if (prefs.activeAudio) localStorage.setItem(LANGUAGE_KEYS.activeAudio, prefs.activeAudio);
      else localStorage.removeItem(LANGUAGE_KEYS.activeAudio);
    }
    if (typeof prefs.activeSubs === 'string') {
      if (prefs.activeSubs) localStorage.setItem(LANGUAGE_KEYS.activeSubs, prefs.activeSubs);
      else localStorage.removeItem(LANGUAGE_KEYS.activeSubs);
    }
  }

  function getPreloadPreference() {
    const value = localStorage.getItem(PRELOAD_SECS_KEY);
    return value ? String(value) : '10';
  }

  function applyPreloadPreference(value) {
    if (value == null) return;
    const normalized = String(value).trim();
    if (!normalized) return;
    localStorage.setItem(PRELOAD_SECS_KEY, normalized);
  }

  function normalizeUiScalePercent(value) {
    const options = [75, 100, 125, 150, 175, 200];
    const num = Number(value);
    if (!Number.isFinite(num)) return 100;
    let closest = 100;
    let bestDelta = Infinity;
    for (const option of options) {
      const delta = Math.abs(option - num);
      if (delta < bestDelta) {
        bestDelta = delta;
        closest = option;
      }
    }
    return closest;
  }

  function getUiScalePreference() {
    try {
      const raw = localStorage.getItem(UI_SCALE_PERCENT_KEY);
      if (raw == null || raw === '') return 100;
      return normalizeUiScalePercent(raw);
    } catch (_) {
      return 100;
    }
  }

  function applyUiScalePreference(percent) {
    const normalized = normalizeUiScalePercent(percent);
    localStorage.setItem(UI_SCALE_PERCENT_KEY, String(normalized));
    return normalized;
  }

  function getVolumePreferences() {
    const fromModule = window.StremioCustomVolume?.get?.();
    if (fromModule && (fromModule.level != null || fromModule.muted != null)) {
      return {
        level: fromModule.level,
        muted: fromModule.muted,
      };
    }

    let level = null;
    let muted = null;
    try {
      const levelRaw = localStorage.getItem(VOLUME_KEYS.level);
      if (levelRaw != null && levelRaw !== '') {
        const parsed = Number(levelRaw);
        if (Number.isFinite(parsed)) {
          level = Math.min(100, Math.max(0, Math.round(parsed)));
        }
      }
      const mutedRaw = localStorage.getItem(VOLUME_KEYS.muted);
      if (mutedRaw != null) muted = mutedRaw === 'true';
    } catch (_) {}
    return { level, muted };
  }

  function mergeVolumePreferences(diskVolume, localVolume) {
    const localLevel =
      typeof localVolume?.level === 'number' && Number.isFinite(localVolume.level)
        ? localVolume.level
        : null;
    const localMuted = typeof localVolume?.muted === 'boolean' ? localVolume.muted : null;
    const diskLevel =
      typeof diskVolume?.level === 'number' && Number.isFinite(diskVolume.level)
        ? diskVolume.level
        : null;
    const diskMuted = typeof diskVolume?.muted === 'boolean' ? diskVolume.muted : null;

    return {
      level: localLevel != null ? localLevel : diskLevel,
      muted: localMuted != null ? localMuted : diskMuted,
    };
  }

  function applyVolumePreferences(prefs) {
    if (!prefs || typeof prefs !== 'object') return;
    if (typeof prefs.level === 'number' && Number.isFinite(prefs.level)) {
      localStorage.setItem(
        VOLUME_KEYS.level,
        String(Math.min(100, Math.max(0, Math.round(prefs.level))))
      );
    }
    if (typeof prefs.muted === 'boolean') {
      localStorage.setItem(VOLUME_KEYS.muted, prefs.muted ? 'true' : 'false');
    }
  }

  function getDiscordPresencePreferences() {
    const readBool = (key, fallback) => {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return raw === 'true';
    };
    return {
      enabled: readBool(DISCORD_KEYS.enabled, false),
      showPaused: readBool(DISCORD_KEYS.showPaused, true),
      showMenu: readBool(DISCORD_KEYS.showMenu, true),
    };
  }

  function applyDiscordPresencePreferences(prefs) {
    if (!prefs || typeof prefs !== 'object') return;
    if (typeof prefs.enabled === 'boolean') {
      localStorage.setItem(DISCORD_KEYS.enabled, prefs.enabled ? 'true' : 'false');
    }
    if (typeof prefs.showPaused === 'boolean') {
      localStorage.setItem(DISCORD_KEYS.showPaused, prefs.showPaused ? 'true' : 'false');
    }
    if (typeof prefs.showMenu === 'boolean') {
      localStorage.setItem(DISCORD_KEYS.showMenu, prefs.showMenu ? 'true' : 'false');
    }
  }

  function getLibraryPreferences() {
    let foldersRaw = '[]';
    try {
      foldersRaw = localStorage.getItem(LIBRARY_KEYS.folders) || '[]';
    } catch (_) {}
    return {
      foldersRaw,
      activeFolderId: localStorage.getItem(LIBRARY_KEYS.activeFolder) || '',
    };
  }

  function applyLibraryPreferences(prefs) {
    if (!prefs || typeof prefs !== 'object') return;
    if (typeof prefs.foldersRaw === 'string') {
      const normalized = prefs.foldersRaw.trim();
      if (normalized && normalized !== '[]') {
        localStorage.setItem(LIBRARY_KEYS.folders, normalized);
      } else if (localStorage.getItem(LIBRARY_KEYS.folders) == null) {
        localStorage.setItem(LIBRARY_KEYS.folders, '[]');
      }
    }
    if (typeof prefs.activeFolderId === 'string') {
      if (prefs.activeFolderId) localStorage.setItem(LIBRARY_KEYS.activeFolder, prefs.activeFolderId);
      else localStorage.removeItem(LIBRARY_KEYS.activeFolder);
    }
  }

  function getEnabledPlugins() {
    try {
      return JSON.parse(localStorage.getItem('enabledPlugins') || '[]');
    } catch {
      return [];
    }
  }

  function setEnabledPlugins(plugins) {
    localStorage.setItem('enabledPlugins', JSON.stringify(plugins));
    const heroInList = isPluginEnabled(DYNAMIC_HERO_PLUGIN, plugins);
    const defaultsApplied = localStorage.getItem(DEFAULTS_APPLIED_KEY) === 'true';
    if (heroInList) {
      localStorage.setItem(DYNAMIC_HERO_ENABLED_KEY, '1');
    } else if (defaultsApplied || plugins.some((ref) => !isHeroPluginRef(ref))) {
      localStorage.setItem(DYNAMIC_HERO_ENABLED_KEY, '0');
    }
    syncDynamicHeroEnabledFlag(plugins);
    document.dispatchEvent(
      new CustomEvent('stremio-custom-enabled-plugins-changed', {
        detail: { enabledPlugins: plugins },
      })
    );
    persistUserPreferences();
  }

  function getCurrentTheme() {
    return localStorage.getItem('currentTheme') || '';
  }

  function setCurrentTheme(theme) {
    localStorage.setItem('currentTheme', LIQUID_GLASS_THEME);
    persistUserPreferences();
  }

  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  function isOnSettingsPage() {
    return /#\/settings/.test(location.href);
  }

  function queryFirstMatching(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }
    return null;
  }

  function waitForElement(selector, timeout = 15000, predicate = null) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const element = document.querySelector(selector);
        if (element && (!predicate || predicate(element))) return element;
        return null;
      };
      const existing = check();
      if (existing) {
        resolve(existing);
        return;
      }
      const observer = new MutationObserver(() => {
        const element = check();
        if (element) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(element);
        }
      });
      const root = document.body || document.documentElement;
      if (!root) {
        reject(new Error(`Element not found: ${selector}`));
        return;
      }
      observer.observe(root, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element not found: ${selector}`));
      }, timeout);
    });
  }

  function waitForSettingsContainer(timeout = 20000) {
    return waitForElement(
      '[class*="sections-container"]',
      timeout,
      (element) => element.closest('[class*="settings-content"]') !== null
    );
  }

  const CUSTOM_SETTINGS_SECTION_IDS = new Set([
    'stremio-custom',
    'stremio-custom-lang-quick-section',
  ]);

  function isNativeSettingsSection(section) {
    return Boolean(section?.id && !CUSTOM_SETTINGS_SECTION_IDS.has(section.id));
  }

  function getSettingsSectionsContainer() {
    return document.querySelector('[class*="settings-content"] [class*="sections-container"]');
  }

  function getNativeSettingsSections() {
    const container = getSettingsSectionsContainer();
    if (!container) return [];
    return Array.from(container.querySelectorAll(':scope > [class*="section-"]')).filter(
      isNativeSettingsSection
    );
  }

  function removeLegacyQuickSettingsSection() {
    document.getElementById('stremio-custom-general-category')?.remove();
    document.getElementById('stremio-custom-quick-category')?.remove();
  }

  function isPluginEnabled(fileRef, enabledPlugins = getEnabledPlugins()) {
    const normalized = String(fileRef || '').replace(/\\/g, '/');
    const baseName = normalized.split('/').pop();
    return enabledPlugins.some((enabledRef) => {
      const enabled = String(enabledRef || '').replace(/\\/g, '/');
      return enabled === normalized || enabled.split('/').pop() === baseName;
    });
  }

  async function disablePlugin(fileRef) {
    if (isHeroPluginRef(fileRef)) {
      const next = getEnabledPlugins().filter((ref) => !isHeroPluginRef(ref));
      setEnabledPlugins(next);
      return;
    }
    const next = getEnabledPlugins().filter((ref) => !isPluginEnabled(fileRef, [ref]));
    setEnabledPlugins(next);
    await unloadPluginResolved(fileRef);
    await ensurePluginsLoadedForRoute();
  }

  async function enablePlugin(fileRef) {
    const enabled = getEnabledPlugins();
    const resolved = await resolvePluginRef(fileRef);
    if (!resolved) return false;
    if (isHeroPluginRef(resolved)) {
      if (!isPluginEnabled(resolved, enabled)) {
        setEnabledPlugins([...enabled, resolved]);
      } else {
        localStorage.setItem(DYNAMIC_HERO_ENABLED_KEY, '1');
        syncDynamicHeroEnabledFlag([...enabled, resolved]);
        persistUserPreferences();
        document.dispatchEvent(
          new CustomEvent('stremio-custom-enabled-plugins-changed', {
            detail: { enabledPlugins: [...enabled, resolved] },
          })
        );
      }
      return true;
    }
    if (!isPluginEnabled(resolved, enabled)) {
      setEnabledPlugins([...enabled, resolved]);
    }
    await loadPlugin(fileRef);
    await ensurePluginsLoadedForRoute();
    return true;
  }

  function mergeAutoskipPreferences(diskAutoskip, localAutoskip) {
    const ids = ['intro', 'credits', 'recap', 'preview'];
    const merged = {};
    for (const id of ids) {
      if (diskAutoskip && typeof diskAutoskip[id] === 'boolean') {
        merged[id] = diskAutoskip[id];
      } else {
        merged[id] = Boolean(localAutoskip?.[id]);
      }
    }
    return merged;
  }

  async function hydrateUserPreferences() {
    try {
      const preferences = await api.getUserPreferences();
      const diskPlugins = Array.isArray(preferences?.enabledPlugins) ? preferences.enabledPlugins : [];
      const diskTheme = typeof preferences?.currentTheme === 'string' ? preferences.currentTheme : '';
      const diskMetadataAddon =
        typeof preferences?.metadataAddon === 'string' ? preferences.metadataAddon : '';
      const diskLanguage = preferences?.language;
      const diskPreload = preferences?.preload;
      const diskUiScale = preferences?.uiScale;
      const diskVolume = preferences?.volume;
      const diskPlayerVolume = await api.getPlayerVolume().catch(() => null);
      const diskVolumeMerged = mergeVolumePreferences(diskVolume, diskPlayerVolume);
      const diskDiscordPresence = preferences?.discordPresence;
      const diskLibrary = preferences?.library;
      const diskOnboarding = preferences?.onboarding;
      const diskAuthProfile =
        typeof preferences?.authProfile === 'string' ? preferences.authProfile : '';
      const hasLocalDiscordPrefs =
        localStorage.getItem(DISCORD_KEYS.enabled) != null ||
        localStorage.getItem(DISCORD_KEYS.showPaused) != null ||
        localStorage.getItem(DISCORD_KEYS.showMenu) != null;
      const localPlugins = getEnabledPlugins();
      const localTheme = getCurrentTheme();
      const hasDiskState = diskPlugins.length > 0 || diskTheme.length > 0;
      const hasLocalState = localPlugins.length > 0 || localTheme.length > 0;

      if (hasDiskState) {
        localStorage.setItem('enabledPlugins', JSON.stringify(diskPlugins));
        localStorage.setItem('currentTheme', LIQUID_GLASS_THEME);
        localStorage.setItem(METADATA_ADDON_KEY, diskMetadataAddon);
      } else if (hasLocalState) {
        localStorage.setItem('enabledPlugins', JSON.stringify(localPlugins));
        localStorage.setItem('currentTheme', LIQUID_GLASS_THEME);
      } else {
        localStorage.setItem('enabledPlugins', '[]');
        localStorage.setItem('currentTheme', LIQUID_GLASS_THEME);
      }
      if (diskLanguage && typeof diskLanguage === 'object') {
        applyLanguagePreferences(diskLanguage);
      }
      if (diskPreload !== undefined && diskPreload !== null) {
        applyPreloadPreference(diskPreload);
      }
      if (diskUiScale !== undefined && diskUiScale !== null) {
        applyUiScalePreference(diskUiScale);
      }

      const mergedVolume = mergeVolumePreferences(diskVolumeMerged, getVolumePreferences());
      if (mergedVolume.level != null || mergedVolume.muted != null) {
        applyVolumePreferences(mergedVolume);
      }
      if (!hasLocalDiscordPrefs && diskDiscordPresence && typeof diskDiscordPresence === 'object') {
        applyDiscordPresencePreferences(diskDiscordPresence);
      }
      if (diskLibrary && typeof diskLibrary === 'object') {
        applyLibraryPreferences(diskLibrary);
      }
      if (diskOnboarding && typeof diskOnboarding === 'object') {
        if (diskOnboarding.tmdbNoticeShown === true) localStorage.setItem(TMDB_NOTICE_KEY, 'true');
        if (diskOnboarding.defaultsApplied === true) localStorage.setItem(DEFAULTS_APPLIED_KEY, 'true');
      }
      restoreAuthProfileFromDisk(diskAuthProfile);

      await loadAutoskipSettings();

      const authProfile = readAuthProfileSnapshot();
      if (authProfile) lastPersistedAuthProfile = authProfile;
      await api.saveUserPreferences({
        enabledPlugins: getEnabledPlugins(),
        currentTheme: LIQUID_GLASS_THEME,
        autoskip: getAutoskipPreferences(),
        metadataAddon: getMetadataAddon(),
        language: getLanguagePreferences(),
        preload: getPreloadPreference(),
        volume: getVolumePreferences(),
        discordPresence: getDiscordPresencePreferences(),
        library: getLibraryPreferences(),
        authProfile,
        uiScale: getUiScalePreference(),
        onboarding: {
          tmdbNoticeShown: localStorage.getItem(TMDB_NOTICE_KEY) === 'true',
          defaultsApplied: localStorage.getItem(DEFAULTS_APPLIED_KEY) === 'true',
        },
      }).catch(() => {});
    } catch (error) {
      console.error('[StremioCustom] hydrateUserPreferences failed:', error);
      await loadAutoskipSettings().catch((autoskipError) => {
        console.error('[StremioCustom] loadAutoskipSettings fallback failed:', autoskipError);
      });
    }
  }

  function refreshAutoskipToggles() {
    const containers = document.querySelectorAll('.stremio-custom-autoskip-toggles, .stremio-custom-autoskip-dropdown');
    if (!containers.length) return;

    for (const container of containers) {
      const dropdown = container.closest('.stremio-custom-autoskip-dropdown') || container;
      window.StremioCustomAutoskip?.updateAutoskipSummary?.(dropdown);

      for (const [id] of Object.entries(AUTOSKIP_KEYS)) {
        const toggle =
          container.querySelector(`[data-autoskip-id="${id}"]`) ||
          container.querySelector(`[data-autoskip-id='${id}']`);
        if (!toggle) continue;
        const on = Boolean(autoskipCache[id]);
        toggle.classList.remove('checked');
        if (on) toggle.classList.add('checked');
        toggle.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    }
  }

  const PLAYER_FIX_STYLE_ID = 'stremio-custom-player-fix';

  const PLAYER_ROUTE_CLASS = 'stremio-custom-player-route';

  const PLAYER_TRANSPARENCY_CSS = `
    html.${PLAYER_ROUTE_CLASS},
    html.${PLAYER_ROUTE_CLASS} body,
    html.${PLAYER_ROUTE_CLASS} #root,
    html.${PLAYER_ROUTE_CLASS} #root > div,
    html.${PLAYER_ROUTE_CLASS} #app,
    html.${PLAYER_ROUTE_CLASS} #app > div {
      background: transparent !important;
      background-color: transparent !important;
    }
    html.${PLAYER_ROUTE_CLASS} [class*="player-container"] {
      background: transparent !important;
      background-color: transparent !important;
    }
    html.${PLAYER_ROUTE_CLASS} [class*="player-container"] > [class*="layer-"]:first-child,
    html.${PLAYER_ROUTE_CLASS} [class*="player-container"] [class*="video-container"],
    html.${PLAYER_ROUTE_CLASS} [class*="player-container"] [class*="video-container"] [class*="video"],
    html.${PLAYER_ROUTE_CLASS} [class*="player-container"] [class*="rendering"],
    html.${PLAYER_ROUTE_CLASS} [class*="player-container"] [class*="shell-video"] {
      background: transparent !important;
      background-color: transparent !important;
    }
    html.${PLAYER_ROUTE_CLASS} [class*="player-container"] > [class*="layer-"]:not([class*="menu"]):not([class*="control"]):not([class*="info"]):not([class*="side-drawer"]):not([class*="indicator"]):not([class*="nav-bar"]):not([class*="background"]):not([class*="buffering"]) {
      background: transparent !important;
      background-color: transparent !important;
    }
    html.${PLAYER_ROUTE_CLASS} [class*="player-container"] [class*="control-bar-button"]:has(> svg path[d^="M91.54"]) {
      display: none !important;
    }
  `;

  const OPAQUE_UI_STYLE_ID = 'stremio-custom-opaque-ui';

  const OPAQUE_UI_CSS = `
    html, html body, body, #root, #root > div {
      background-color: rgb(20, 20, 20) !important;
      background: rgb(20, 20, 20) !important;
    }
  `;

  function hasLivePlaybackStream() {
    try {
      return Boolean(window.StremioCustomPlayback?.getMpvSnapshot?.()?.hasStream);
    } catch (_) {
      return false;
    }
  }

  function ensureOpaqueShellBackground() {
    if (
      typeof window.__stremioCustomIsColdStartPlayerBlocked === 'function' &&
      window.__stremioCustomIsColdStartPlayerBlocked()
    ) {
      window.__stremioCustomStartupGuardEnsure?.();
      return;
    }
    // Opaque until MPV is actually shown (VIDEO phase). Punching transparency while
    // still on the loading poster leaves white edges — worse in fullscreen.
    const mpvVisible = document.documentElement.classList.contains('mystremio-mpv-visible');
    if (isPlayerRoute() && hasLivePlaybackStream() && mpvVisible) {
      document.getElementById(OPAQUE_UI_STYLE_ID)?.remove();
      return;
    }
    let style = document.getElementById(OPAQUE_UI_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = OPAQUE_UI_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = OPAQUE_UI_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensurePlayerTransparencyFix() {
    const html = document.documentElement;
    if (
      typeof window.__stremioCustomIsColdStartPlayerBlocked === 'function' &&
      window.__stremioCustomIsColdStartPlayerBlocked()
    ) {
      ensureOpaqueShellBackground();
      document.getElementById(PLAYER_FIX_STYLE_ID)?.remove();
      html.classList.remove(PLAYER_ROUTE_CLASS);
      return;
    }
    ensureOpaqueShellBackground();
    const mpvVisible = html.classList.contains('mystremio-mpv-visible');
    const livePlayer = isPlayerRoute() && hasLivePlaybackStream() && mpvVisible;
    if (!livePlayer) {
      document.getElementById(PLAYER_FIX_STYLE_ID)?.remove();
      html.classList.remove(PLAYER_ROUTE_CLASS);
      return;
    }
    html.classList.add(PLAYER_ROUTE_CLASS);
    let style = document.getElementById(PLAYER_FIX_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = PLAYER_FIX_STYLE_ID;
    }
    style.textContent = PLAYER_TRANSPARENCY_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  window.__stremioCustomPlayerTransparencyEnsure = ensurePlayerTransparencyFix;

  async function syncLiquidGlassNavigation(themeFileName) {
    window.__stremioCustomLiquidGlassNavStart?.();
  }

  async function applyTheme(themeFileName) {
    const targetTheme = LIQUID_GLASS_THEME;
    if (appliedThemeName === targetTheme && document.getElementById('stremio-custom-active-theme')) {
      ensurePlayerGlassStyles();
      ensurePlayerTransparencyFix();
      return true;
    }
    document.getElementById('stremio-custom-active-theme')?.remove();
    appliedThemeName = targetTheme;
    const css = await invoke('read-theme', { fileName: targetTheme }, 4000).catch((error) => {
      console.warn('[StremioCustom] Theme read failed:', error);
      return null;
    });
    if (!css) {
      console.warn('[StremioCustom] Theme not found:', targetTheme);
      return false;
    }
    const playerCss = window.__stremioCustomPlayerGlassCss || '';
    const style = document.createElement('style');
    style.id = 'stremio-custom-active-theme';
    style.textContent = css + (playerCss ? `\n/* Stremio Custom player */\n${playerCss}` : '');
    (document.head || document.documentElement).appendChild(style);
    await syncLiquidGlassNavigation(targetTheme);
    ensurePlayerGlassStyles();
    ensurePlayerTransparencyFix();
    return true;
  }

  function ensurePlayerGlassStyles() {
    document.getElementById('stremio-custom-player-glass')?.remove();
    if (typeof window.__stremioCustomPlayerGlassEnsure === 'function') {
      window.__stremioCustomPlayerGlassEnsure();
    }
    ensurePlayerTransparencyFix();
  }

  async function ensureThemeApplied() {
    const current = LIQUID_GLASS_THEME;
    const hasThemeStyle = document.getElementById('stremio-custom-active-theme');
    if (hasThemeStyle && appliedThemeName === current) {
      ensurePlayerGlassStyles();
      return true;
    }
    const result = await applyTheme(current);
    ensurePlayerGlassStyles();
    return result;
  }

  function toScriptId(fileRef) {
    return String(fileRef).replace(/[\\/]/g, '__');
  }

  /** @type {string[]|null} */
  let pluginsInventoryCache = null;
  let pluginsInventoryCacheAt = 0;

  async function listPluginsCached(force = false) {
    const now = Date.now();
    if (!force && pluginsInventoryCache && now - pluginsInventoryCacheAt < 8000) {
      return pluginsInventoryCache;
    }
    const plugins = await api.listPlugins();
    pluginsInventoryCache = Array.isArray(plugins) ? plugins : [];
    pluginsInventoryCacheAt = now;
    return pluginsInventoryCache;
  }

  async function resolvePluginRef(fileRef) {
    const normalized = String(fileRef || '').replace(/\\/g, '/');
    if (!normalized) return null;
    if (isHeroPluginRef(normalized)) return DYNAMIC_HERO_PLUGIN;
    const plugins = await listPluginsCached();
    if (plugins.includes(normalized)) return normalized;
    const baseName = normalized.split('/').pop();
    return plugins.find((p) => p.split('/').pop() === baseName) || null;
  }

  async function migrateEnabledPlugins() {
    const enabled = getEnabledPlugins();
    if (!enabled.length) return enabled;

    let plugins = [];
    try {
      plugins = await listPluginsCached();
    } catch (error) {
      console.warn('[StremioCustom] listPlugins failed during migrate; keeping enabled list', error);
      return enabled;
    }
    // Never wipe the enabled list when the disk inventory is briefly empty/unavailable.
    if (!Array.isArray(plugins) || !plugins.length) return enabled;

    // Non-destructive: keep unresolved refs (partial inventory must not shrink disk).
    // Persist only when a path was rewritten to a known inventory entry.
    const migrated = [];
    let renamed = false;
    for (const fileRef of enabled) {
      const normalized = String(fileRef || '').replace(/\\/g, '/');
      if (!normalized) continue;
      if (isHeroPluginRef(normalized)) {
        if (normalized !== DYNAMIC_HERO_PLUGIN) renamed = true;
        migrated.push(DYNAMIC_HERO_PLUGIN);
        continue;
      }
      if (plugins.includes(normalized)) {
        migrated.push(normalized);
        continue;
      }
      const baseName = normalized.split('/').pop();
      const resolved = plugins.find((p) => p.split('/').pop() === baseName) || null;
      if (resolved) {
        if (resolved !== normalized) renamed = true;
        migrated.push(resolved);
      } else {
        migrated.push(normalized);
      }
    }
    if (renamed && JSON.stringify(migrated) !== JSON.stringify(enabled)) {
      setEnabledPlugins(migrated);
    }
    return migrated;
  }

  function stripUnsafePluginPreamble(content) {
    return String(content || '').replace(
      /^(?:[\t ]*@(?:name|description|version|author|category|credits)\s[^\n]*\n)+/,
      ''
    );
  }

  function injectPluginScript(resolved, rawContent) {
    const scriptId = toScriptId(resolved);
    if (document.getElementById(scriptId)) return true;
    const content = stripUnsafePluginPreamble(rawContent);
    const pluginBaseName = resolved.split('/').pop().replace(PLUGIN_EXT, '');
    const scopedScript = `(function(){const StremioEnhancedAPI={logger:{info:(m)=>window.StremioEnhancedAPI?.info('${pluginBaseName}',m),warn:(m)=>window.StremioEnhancedAPI?.warn('${pluginBaseName}',m),error:(m)=>window.StremioEnhancedAPI?.error('${pluginBaseName}',m)},getSetting:(k)=>window.StremioEnhancedAPI?.getSetting('${pluginBaseName}',k),saveSetting:(k,v)=>window.StremioEnhancedAPI?.saveSetting('${pluginBaseName}',k,v),registerSettings:(s)=>window.StremioEnhancedAPI?.registerSettings('${pluginBaseName}',s),onSettingsSaved:(cb)=>window.StremioEnhancedAPI?.onSettingsSaved('${pluginBaseName}',cb),showAlert:async(t,ti,m)=>{window.alert(ti+'\\n\\n'+m);return 0},showPrompt:async(ti,m,d)=>window.prompt(ti+'\\n\\n'+m,d||'')};try{${content}}catch(err){console.error('[StremioCustom] Plugin crashed: ${resolved}',err);}})();`;
    const script = document.createElement('script');
    script.id = scriptId;
    script.textContent = scopedScript;
    (document.head || document.body || document.documentElement).appendChild(script);
    return true;
  }

  async function loadPlugin(fileRef) {
    const resolved = await resolvePluginRef(fileRef);
    if (!resolved) return false;
    if (isHeroPluginRef(resolved)) return true;
    if (document.getElementById(toScriptId(resolved))) return true;
    const rawContent = await api.readPlugin(resolved);
    if (!rawContent) return false;
    return injectPluginScript(resolved, rawContent);
  }

  /**
   * Cold-boot first-paint load: try canonical paths directly (no list-plugins roundtrip).
   * @param {string} fileRef
   * @returns {Promise<boolean>}
   */
  async function loadPluginDirect(fileRef) {
    const normalized = normalizePluginRef(fileRef);
    if (!normalized) return false;
    if (isHeroPluginRef(normalized)) return true;
    if (document.getElementById(toScriptId(normalized))) return true;
    try {
      const raw = await invoke('read-plugin', { fileRef: normalized }, 4000);
      if (raw) return injectPluginScript(normalized, raw);
    } catch (error) {
      console.warn('[StremioCustom] Direct plugin read failed:', normalized, error);
    }
    return loadPlugin(normalized);
  }

  function unloadPlugin(fileRef) {
    const normalized = String(fileRef || '').replace(/\\/g, '/');
    if (!normalized) return false;
    const baseName = normalized.split('/').pop();
    if (isHeroPluginRef(normalized)) {
      cleanupLegacyHeroDom();
    }
    if (/seek[-_ ]?buttons/i.test(normalized) || /seek[-_ ]?buttons/i.test(baseName || '')) {
      window.__stremioSeekButtonsUnload?.();
    }
    if (/brightness/i.test(normalized) || /brightness/i.test(baseName || '') ||
        /picture/i.test(normalized) || /picture/i.test(baseName || '')) {
      window.__stremioPictureUnload?.();
      window.__stremioBrightnessUnload?.();
    }
    if (/hover[-_ ]?timestamps/i.test(normalized) || /hover[-_ ]?timestamps/i.test(baseName || '')) {
      window.__stremioHoverTimestampsUnload?.();
    }
    if (/cast[-_ ]?overlay/i.test(normalized) || /cast[-_ ]?overlay/i.test(baseName || '')) {
      window.__stremioCastOverlayUnload?.();
    }
    if (/anime4k/i.test(normalized) || /anime4k/i.test(baseName || '')) {
      window.__stremioAnime4kUnload?.() || window.__stremioAnime4kSuspend?.();
    }
    if (/stream[-_ ]?ui/i.test(normalized) || /stream[-_ ]?ui/i.test(baseName || '')) {
      window.__stremioStreamUiUnload?.();
    }
    if (/meta[-_ ]?hover/i.test(normalized) || /meta[-_ ]?hover/i.test(baseName || '')) {
      window.__stremioMetaHoverUnload?.();
    }
    if (/context[-_ ]?menu/i.test(normalized) || /context[-_ ]?menu/i.test(baseName || '')) {
      window.__stremioContextMenuUnload?.();
    }
    if (/data[-_ ]?enrichment/i.test(normalized) || /data[-_ ]?enrichment/i.test(baseName || '')) {
      window.__stremioDataEnrichmentUnload?.();
    }
    if (/detail[-_ ]?slogan/i.test(normalized) || /detail[-_ ]?slogan/i.test(baseName || '')) {
      window.__stremioDetailSloganUnload?.();
    }
    if (/enhanced[-_ ]?covers/i.test(normalized) || /enhanced[-_ ]?covers/i.test(baseName || '')) {
      window.__stremioEnhancedCoversUnload?.();
    }
    if (/enhanced[-_ ]?titlebar/i.test(normalized) || /enhanced[-_ ]?title[-_ ]?bar/i.test(normalized) ||
        /enhanced[-_ ]?titlebar/i.test(baseName || '') || /enhanced[-_ ]?title[-_ ]?bar/i.test(baseName || '')) {
      window.__stremioEnhancedTitlebarUnload?.();
    }
    if (/slash[-_ ]?to[-_ ]?search/i.test(normalized) || /SlashToSearch/i.test(baseName || '')) {
      window.__stremioSlashToSearchUnload?.();
    }
    if (/tidb/i.test(normalized) || /tidb/i.test(baseName || '') || /intro[-_ ]?skip/i.test(normalized)) {
      window.__stremioTidbUnload?.() || window.__stremioTidbSuspend?.();
    }
    let removed = false;
    const direct = document.getElementById(toScriptId(normalized));
    if (direct) {
      direct.remove();
      removed = true;
    }
    if (baseName) {
      const suffix = `__${baseName.replace(/\\/g, '__')}`;
      document.querySelectorAll('script[id]').forEach((node) => {
        if (node.id.endsWith(suffix)) {
          node.remove();
          removed = true;
        }
      });
    }
    return removed;
  }

  async function unloadPluginResolved(fileRef) {
    const resolved = await resolvePluginRef(fileRef);
    if (!resolved) return unloadPlugin(fileRef);
    return unloadPlugin(resolved);
  }

  const PLAYBACK_KEEP_PLUGINS = new Set([
    'interface/context-menu-fix.plugin.js',
    'interface/enhanced-titlebar.plugin.js',
    'player/tidb.plugin.js',
    'player/seek-buttons.plugin.js',
    'player/hover-timestamps.plugin.js',
    'player/picture.plugin.js',
    'player/cast-overlay.plugin.js',
    'player/anime4k.plugin.js',
  ]);

  /** Board chrome visible on first paint — load before splash/UI ready. */
  const BOARD_FIRST_PAINT_PLUGINS = new Set([
    'interface/hero-div.plugin.js',
    'interface/enhanced-covers.plugin.js',
    'interface/enhanced-titlebar.plugin.js',
    'interface/context-menu-fix.plugin.js',
    'metadata/meta-hover-panel.plugin.js',
  ]);

  const IDLE_DURING_PLAYBACK_PREFIXES = [
    'interface/',
    'metadata/',
    'addons/',
  ];

  function normalizePluginRef(pluginRef) {
    return String(pluginRef || '').replace(/\\/g, '/');
  }

  function pluginBaseName(pluginRef) {
    return normalizePluginRef(pluginRef).split('/').pop() || '';
  }

  function isIdleDuringPlayback(pluginRef) {
    const normalized = normalizePluginRef(pluginRef);
    if (PLAYBACK_KEEP_PLUGINS.has(normalized)) return false;
    if ([...PLAYBACK_KEEP_PLUGINS].some((ref) => pluginBaseName(ref) === pluginBaseName(normalized))) {
      return false;
    }
    return IDLE_DURING_PLAYBACK_PREFIXES.some(
      (prefix) => normalized === prefix || normalized.startsWith(prefix)
    );
  }

  function isBoardFirstPaintPlugin(pluginRef) {
    const normalized = normalizePluginRef(pluginRef);
    if (isHeroPluginRef(normalized)) return true;
    if (BOARD_FIRST_PAINT_PLUGINS.has(normalized)) return true;
    const base = pluginBaseName(normalized);
    return [...BOARD_FIRST_PAINT_PLUGINS].some((ref) => pluginBaseName(ref) === base);
  }

  /**
   * @param {string[]} enabled
   * @param {'firstPaint'|'fullBoard'|'playback'} mode
   * @returns {string[]}
   */
  function filterPluginsForPhase(enabled, mode) {
    if (mode === 'playback') {
      return enabled.filter((pluginRef) => !isIdleDuringPlayback(pluginRef));
    }
    if (mode === 'firstPaint') {
      return enabled.filter((pluginRef) => isBoardFirstPaintPlugin(pluginRef));
    }
    return enabled;
  }

  function filterPluginsForRoute(enabled, playbackActive = effectivePlaybackActive()) {
    return filterPluginsForPhase(enabled, playbackActive ? 'playback' : 'fullBoard');
  }

  /**
   * True only for a real player session. Transient cold-start #/player (before
   * bootstrap-ready / while startup-guard blocks) must keep board plugins.
   * @returns {boolean}
   */
  function effectivePlaybackActive() {
    if (!isPlayerRoute()) return false;
    try {
      if (
        typeof window.__stremioCustomIsColdStartPlayerBlocked === 'function' &&
        window.__stremioCustomIsColdStartPlayerBlocked()
      ) {
        return false;
      }
    } catch (_) {
      /* ignore */
    }
    if (!window.__stremioCustomBootstrapReady) return false;
    return true;
  }

  /**
   * @param {'firstPaint'|'fullBoard'|'playback'} [mode]
   */
  async function ensurePluginsLoadedForRoute(mode) {
    const enabled = await migrateEnabledPlugins();
    const resolvedMode =
      mode || (effectivePlaybackActive() ? 'playback' : 'fullBoard');
    const targetPlugins = filterPluginsForPhase(enabled, resolvedMode);

    // firstPaint: only load critical board plugins — never unload deferred ones.
    // playback: unload board/detail idle plugins.
    // fullBoard: load all enabled (no unload of enabled set).
    if (resolvedMode === 'playback') {
      const toUnload = enabled.filter(
        (pluginRef) => !targetPlugins.includes(pluginRef) && isIdleDuringPlayback(pluginRef)
      );
      await Promise.all(
        toUnload.map((pluginRef) =>
          unloadPluginResolved(pluginRef).catch((error) => {
            console.warn('[StremioCustom] unload failed:', pluginRef, error);
          })
        )
      );
    }

    await Promise.all(targetPlugins.map((pluginRef) => loadPlugin(pluginRef)));
  }

  /**
   * @param {string} fileRef
   * @returns {Promise<boolean>}
   */
  async function isPluginScriptPresent(fileRef) {
    const resolved = (await resolvePluginRef(fileRef)) || normalizePluginRef(fileRef);
    if (!resolved) return false;
    if (isHeroPluginRef(resolved)) return true;
    if (document.getElementById(toScriptId(resolved))) return true;
    const baseName = resolved.split('/').pop();
    if (!baseName) return false;
    const suffix = `__${baseName.replace(/\\/g, '__')}`;
    const scripts = document.querySelectorAll('script[id]');
    for (let i = 0; i < scripts.length; i++) {
      if (scripts[i].id.endsWith(suffix)) return true;
    }
    return false;
  }

  /**
   * @param {string[]} refs
   * @returns {Promise<string[]>}
   */
  async function listMissingPluginScripts(refs) {
    const flags = await Promise.all(refs.map((ref) => isPluginScriptPresent(ref)));
    return refs.filter((_, i) => !flags[i]);
  }

  /**
   * Load phase plugins and re-inject any that are still missing.
   * @param {'firstPaint'|'fullBoard'|'playback'} [mode]
   * @param {number} [maxAttempts]
   * @returns {Promise<boolean>}
   */
  async function ensurePluginsLoadedWithRetry(mode = 'firstPaint', maxAttempts = 2) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await ensurePluginsLoadedForRoute(mode);
      if (effectivePlaybackActive()) return true;
      const enabled = await migrateEnabledPlugins();
      const target = filterPluginsForPhase(enabled, mode);
      const missing = await listMissingPluginScripts(target);
      if (!missing.length) return true;
      console.warn(
        '[StremioCustom] Missing plugin scripts after load, retry',
        attempt + 1,
        missing
      );
      await Promise.all(
        missing.map((ref) =>
          unloadPluginResolved(ref).catch(() => {
            /* ignore */
          })
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
    const enabled = await migrateEnabledPlugins();
    const stillMissing = await listMissingPluginScripts(filterPluginsForPhase(enabled, mode));
    if (stillMissing.length) {
      console.error('[StremioCustom] Plugins still missing after retries:', stillMissing);
      return false;
    }
    return true;
  }

  /** Load deferred board/detail/player plugins after UI reveal. */
  function scheduleDeferredPluginLoad() {
    const run = () => {
      if (effectivePlaybackActive()) return;
      ensurePluginsLoadedForRoute('fullBoard').catch((error) => {
        console.warn('[StremioCustom] Deferred plugin load failed:', error);
      });
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => run(), { timeout: 1500 });
    } else {
      setTimeout(run, 0);
    }
  }

  /**
   * Fast first-paint: heal enabled list from LS only, load canonical plugin paths.
   * No list-plugins / migrate IPC on the critical path.
   */
  async function loadFirstPaintPluginsFast() {
    const enabled = getEnabledPlugins();
    const next = [...enabled];
    let changed = false;
    for (const ref of BOARD_FIRST_PAINT_PLUGINS) {
      if (!isPluginEnabled(ref, next)) {
        next.push(ref);
        changed = true;
      }
    }
    if (changed) setEnabledPlugins(next);
    // Warm inventory cache in background for later resolve/migrate.
    listPluginsCached().catch(() => {});
    await Promise.all([...BOARD_FIRST_PAINT_PLUGINS].map((ref) => loadPluginDirect(ref)));
  }

  /**
   * Idempotent UI reveal — used by happy path and soft deadline recovery.
   * @param {string} reason
   */
  function markUiReady(reason) {
    if (window.__stremioCustomUiReadyNotified) return;
    window.__stremioCustomUiReadyNotified = true;
    window.__stremioCustomBootstrapReady = true;
    document.dispatchEvent(new CustomEvent('stremio-custom-bootstrap-ready'));
    try {
      window.__stremioCustomDismissStartupOverlays?.();
    } catch (_) {
      /* ignore */
    }
    try {
      window.__stremioCustomHideAppLoadingMask?.();
    } catch (_) {
      /* ignore */
    }
    notifyShellUiReady();
    window.__stremioCustomScheduleShellAppReadyFallback?.();
    console.info('[StremioCustom] UI ready:', reason || 'ok');
  }

  /**
   * Warm resume from tray / second-instance focus — no splash, no bootstrap re-run.
   * @param {string} [source]
   */
  async function onWindowResumed(source) {
    // Cold boot still under splash: do not strip the boot seal.
    if (!window.__stremioCustomBootstrapReady) {
      if (isPlayerRoute() && !hasLivePlaybackStream()) {
        settleBoardRouteBeforePlugins();
      }
      return;
    }

    try {
      window.__stremioCustomDismissStartupOverlays?.();
    } catch (_) {
      /* ignore */
    }
    try {
      window.__stremioCustomRemoveBootSeal?.();
    } catch (_) {
      /* ignore */
    }

    // Dead #/player without MPV stream → board (warm resume only; force redirect).
    if (isPlayerRoute() && !hasLivePlaybackStream()) {
      if (typeof window.__stremioCustomRedirectStalePlayer === 'function') {
        window.__stremioCustomRedirectStalePlayer('Warm resume stale player');
      } else {
        settleBoardRouteBeforePlugins();
      }
      console.info('[StremioCustom] Warm resume: stale player → board', source || '');
    }

    ensurePlayerTransparencyFix();

    try {
      if (effectivePlaybackActive()) {
        await ensurePluginsLoadedForRoute('playback');
      } else {
        await ensurePluginsLoadedForRoute('firstPaint');
        scheduleDeferredPluginLoad();
      }
    } catch (error) {
      console.warn('[StremioCustom] Warm resume plugin ensure failed:', error);
    }
  }

  window.__stremioCustomOnWindowResumed = onWindowResumed;

  function injectPlaybackGuard() {
    if (document.getElementById('stremio-custom-playback-guard')) return;
    const script = document.createElement('script');
    script.id = 'stremio-custom-playback-guard';
    script.textContent = `(function(){function isPlaybackRoute(){return /#\\/player/.test(location.hash||'');}function emit(){document.dispatchEvent(new CustomEvent('stremio-custom-playback-route',{detail:{active:isPlaybackRoute()}}));}window.stremioCustomIsPlaybackRoute=isPlaybackRoute;window.stremioCustomSuspendBackground=function(){return isPlaybackRoute();};document.addEventListener('stremio-custom-route-change',emit);})();`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  let lastPlaybackActive = null;
  let routeSyncGen = 0;
  /** @type {Promise<void>|null} */
  let routeSyncInFlight = null;

  /**
   * Stops player-only plugin timers/observers/locks while off the player route.
   * Do NOT include StreamUI / Meta-Hover here — those must stay alive on detail/board.
   * Soft-suspend for those plugins is self-managed via their own route listeners.
   */
  function suspendPlayerPluginRuntime() {
    const hooks = [
      '__stremioSeekButtonsUnload',
      '__stremioPictureUnload',
      '__stremioBrightnessUnload',
      '__stremioCastOverlayUnload',
      '__stremioHoverTimestampsUnload',
      '__stremioTidbSuspend',
      '__stremioAnime4kSuspend',
    ];
    for (const name of hooks) {
      try {
        const fn = window[name];
        if (typeof fn === 'function') fn();
      } catch (error) {
        console.warn('[StremioCustom] Player plugin suspend failed:', name, error);
      }
    }
    document.documentElement.classList.remove(
      'mystremio-brightness-overlay-lock',
      'mystremio-picture-overlay-lock',
      'mystremio-cast-overlay-lock',
      'tidb-contribute-overlay-lock'
    );
  }

  /**
   * Serialize route plugin sync; ignore stale generations so a late player-unload
   * cannot strip board plugins after a cold-start redirect to #/board.
   * @returns {Promise<void>}
   */
  async function syncPluginsToRoute() {
    const playbackActive = effectivePlaybackActive();
    if (playbackActive === lastPlaybackActive) return;

    const gen = ++routeSyncGen;
    const run = (async () => {
      try {
        const enabled = await migrateEnabledPlugins();
        if (gen !== routeSyncGen) return;

        // Re-read after await — hash may have flipped during cold-start redirect.
        const activeNow = effectivePlaybackActive();
        if (activeNow) {
          for (const pluginRef of enabled) {
            if (gen !== routeSyncGen) return;
            if (isIdleDuringPlayback(pluginRef)) await unloadPluginResolved(pluginRef);
          }
        } else {
          suspendPlayerPluginRuntime();
          if (gen !== routeSyncGen) return;
          await ensurePluginsLoadedForRoute();
        }
        if (gen !== routeSyncGen) return;
        lastPlaybackActive = activeNow;
      } catch (error) {
        console.warn('[StremioCustom] syncPluginsToRoute failed:', error);
      }
    })();

    routeSyncInFlight = run;
    try {
      await run;
    } finally {
      if (routeSyncInFlight === run) routeSyncInFlight = null;
    }
  }

  async function ensureDefaultPluginsEnabled() {
    const all = await api.listPlugins();
    if (!Array.isArray(all) || !all.length) return;

    const enabled = await migrateEnabledPlugins();
    const defaultsApplied = localStorage.getItem(DEFAULTS_APPLIED_KEY) === 'true';
    const next = [...enabled];
    let changed = false;

    // Self-heal: always re-add missing board-first-paint plugins (even after defaultsApplied).
    for (const ref of BOARD_FIRST_PAINT_PLUGINS) {
      const resolved =
        (await resolvePluginRef(ref)) ||
        all.find((p) => pluginBaseName(p) === pluginBaseName(ref)) ||
        ref;
      if (!isPluginEnabled(resolved, next)) {
        next.push(normalizePluginRef(resolved));
        changed = true;
      }
    }

    // Full default enable only on first apply or wiped list.
    if (!defaultsApplied || enabled.length === 0) {
      for (const ref of all) {
        const normalized = String(ref || '').replace(/\\/g, '/');
        const baseName = normalized.split('/').pop() || '';
        const skip = DEFAULT_DISABLED_PLUGIN_PATTERNS.some(
          (pattern) => pattern.test(normalized) || pattern.test(baseName)
        );
        if (skip) continue;
        if (!isPluginEnabled(ref, next)) {
          next.push(normalized);
          changed = true;
        }
      }
    }

    if (changed) {
      setEnabledPlugins(next);
      // Do not load plugins here — cold boot loads firstPaint, then deferred fullBoard.
    }
    localStorage.setItem(DEFAULTS_APPLIED_KEY, 'true');
    if (changed || !defaultsApplied) persistUserPreferences();
  }

  /**
   * One-shot: enable picture + hover-timestamps for existing users who already
   * had defaults applied (those features were previously always-on natives).
   * @returns {Promise<void>}
   */
  async function migrateNativePlayerFeaturesToPlugins() {
    if (localStorage.getItem(NATIVE_PLAYER_FEATURES_MIGRATED_KEY) === 'true') return;
    const refs = ['player/picture.plugin.js', 'player/hover-timestamps.plugin.js'];
    const enabled = await migrateEnabledPlugins();
    const next = [...enabled];
    let changed = false;
    for (const ref of refs) {
      const resolved = (await resolvePluginRef(ref)) || ref;
      if (!isPluginEnabled(resolved, next)) {
        next.push(resolved);
        changed = true;
      }
    }
    if (changed) {
      setEnabledPlugins(next);
    }
    localStorage.setItem(NATIVE_PLAYER_FEATURES_MIGRATED_KEY, 'true');
    persistUserPreferences();
  }

  /**
   * One-shot: rewrite enabledPlugins from brightness.plugin.js → picture.plugin.js.
   * @returns {Promise<void>}
   */
  async function migrateBrightnessToPicturePlugin() {
    if (localStorage.getItem(BRIGHTNESS_TO_PICTURE_MIGRATED_KEY) === 'true') return;
    const enabled = await migrateEnabledPlugins();
    const next = [];
    let changed = false;
    let hadBrightness = false;
    for (const ref of enabled) {
      const normalized = String(ref || '').replace(/\\/g, '/');
      if (/brightness\.plugin\.js$/i.test(normalized)) {
        hadBrightness = true;
        changed = true;
        continue;
      }
      next.push(ref);
    }
    if (hadBrightness) {
      const pictureRef =
        (await resolvePluginRef('player/picture.plugin.js')) || 'player/picture.plugin.js';
      if (!isPluginEnabled(pictureRef, next)) {
        next.push(pictureRef);
        changed = true;
      }
    }
    if (changed) {
      setEnabledPlugins(next);
    }
    localStorage.setItem(BRIGHTNESS_TO_PICTURE_MIGRATED_KEY, 'true');
    persistUserPreferences();
  }

  /**
   * One-shot: mark Anime4K migration complete without force-enabling.
   * Existing installs that already have the plugin in enabledPlugins keep it;
   * new installs stay opt-in via DEFAULT_DISABLED_PLUGIN_PATTERNS.
   * @returns {Promise<void>}
   */
  async function migrateAnime4kPluginEnabled() {
    if (localStorage.getItem(ANIME4K_PLUGIN_MIGRATED_KEY) === 'true') return;
    localStorage.setItem(ANIME4K_PLUGIN_MIGRATED_KEY, 'true');
    persistUserPreferences();
  }

  async function maybeShowTmdbFirstRunNotice() {
    try {
      const config = await api.getPluginConfig('data-enrichment');
      const tmdb = String(config?.tmdbApiKey || '').trim();
      const hasTmdb = /^[a-f0-9]{16,}$/i.test(tmdb);
      if (hasTmdb) {
        localStorage.setItem(TMDB_NOTICE_KEY, 'true');
        persistUserPreferences();
        return;
      }
    } catch (_) {}
    if (document.getElementById('stremio-custom-tmdb-notice')) return;
    if (!document.getElementById('stremio-custom-native-toast-style')) {
      const style = document.createElement('style');
      style.id = 'stremio-custom-native-toast-style';
      style.textContent = `
        .stremio-custom-native-toast {
          position: fixed;
          top: 20px;
          right: 20px;
          z-index: 300010;
          max-width: min(28rem, 84vw);
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 10px;
          color: var(--primary-foreground-color, #f4f4f4);
          background: rgba(22, 22, 22, 0.95);
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.42);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          transform: translateY(-6px);
          opacity: 0;
          transition: transform 120ms ease, opacity 120ms ease;
        }
        .stremio-custom-native-toast.show {
          transform: translateY(0);
          opacity: 1;
        }
        .stremio-custom-native-toast-icon {
          width: 18px;
          height: 18px;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: rgba(42, 144, 95, 0.95);
          color: #eafff3;
          font-size: 12px;
          flex: none;
          margin-top: 1px;
        }
        .stremio-custom-native-toast-message {
          font-size: 12px;
          line-height: 1.36;
          flex: 1;
          min-width: 0;
          color: var(--primary-foreground-color, #f4f4f4);
        }
        .stremio-custom-native-toast-close {
          all: unset;
          cursor: pointer;
          color: rgba(255, 255, 255, 0.78);
          font-size: 14px;
          line-height: 1;
          flex: none;
          padding-left: 4px;
        }
        .stremio-custom-native-toast-close:hover {
          color: rgba(255, 255, 255, 1);
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
    const notice = document.createElement('div');
    notice.id = 'stremio-custom-tmdb-notice';
    notice.className = 'stremio-custom-native-toast';
    notice.innerHTML = `
      <span class="stremio-custom-native-toast-icon">&#10003;</span>
      <div class="stremio-custom-native-toast-message">
        Data Enrichment needs a TMDB API key. Add it in Settings > MyStremio > API Keys.
      </div>
      <button type="button" class="stremio-custom-native-toast-close" aria-label="Close">&#10005;</button>
    `;
    const closeBtn = notice.querySelector('.stremio-custom-native-toast-close');
    closeBtn?.addEventListener('click', () => notice.remove());
    document.body.appendChild(notice);
    requestAnimationFrame(() => notice.classList.add('show'));
    setTimeout(() => notice.remove(), 9000);
    try {
      localStorage.removeItem(TMDB_NOTICE_KEY);
    } catch (_) {}
    persistUserPreferences();
  }

  window.StremioCustomAutoskip = {
    ...(window.StremioCustomAutoskip || {}),
    isEnabled(id) {
      return Boolean(autoskipCache[id]);
    },
    ensureReady: ensureAutoskipReady,
  };

  window.StremioCustom = {
    api,
    helpers: {
      waitForElement,
      waitForSettingsContainer,
      isOnSettingsPage,
      getEnabledPlugins,
      setEnabledPlugins,
      getCurrentTheme,
      setCurrentTheme,
      queryFirstMatching,
      isPluginEnabled,
      isDynamicHeroEnabled,
      enablePlugin,
      disablePlugin,
      hydrateUserPreferences,
      getAutoskipPreferences,
      setAutoskipEnabled,
      refreshAutoskipToggles,
      ensureAutoskipReady,
      getMetadataAddon,
      setMetadataAddon,
      getLibraryPreferences,
      applyLibraryPreferences,
      getUiScalePreference,
      applyUiScalePreference,
      isNativeSettingsSection,
      getSettingsSectionsContainer,
      getNativeSettingsSections,
      removeLegacyQuickSettingsSection,
      persistUserPreferences,
    },
    plugins: {
      loadPlugin,
      unloadPlugin: unloadPluginResolved,
      resolvePluginRef,
      migrateEnabledPlugins,
      ensurePluginsLoadedForRoute,
      filterPluginsForRoute,
    },
    theme: { applyTheme, ensureThemeApplied },
  };

  const pluginApi = { loadPlugin, unloadPlugin: unloadPluginResolved };

  function safeRun(label, fn) {
    try {
      fn();
    } catch (error) {
      console.error(`[StremioCustom] ${label} failed:`, error);
    }
  }

  /**
   * Ensure we are on #/board before any plugin load/unload work.
   * Prevents the BAD cold-start path (stale #/player → unload race).
   */
  function settleBoardRouteBeforePlugins() {
    // Route only — never re-create the boot seal (splash safety may already
    // have retired it; recreating caused permanent black screens).
    const hash = location.hash || '';
    if (!/#\/player(?:\/|$|\?|#)/.test(hash)) return;
    const target =
      (location.pathname || '/index.html') + (location.search || '') + '#/board';
    try {
      history.replaceState(null, '', target);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      document.dispatchEvent(new CustomEvent('stremio-custom-route-change'));
      console.info('[StremioCustom] Forced #/board (stale player route)');
    } catch (_) {
      /* ignore */
    }
  }

  function notifyShellUiReady() {
    try {
      const payload = JSON.stringify({ id: Date.now(), args: ['mystremio-ui-ready'] });
      if (window.chrome?.webview?.postMessage) {
        window.chrome.webview.postMessage(payload);
      } else if (window.qt?.webChannelTransport?.send) {
        window.qt.webChannelTransport.send(payload);
      }
    } catch (error) {
      console.warn('[StremioCustom] mystremio-ui-ready notify failed:', error);
    }
  }

  async function bootstrap() {
    hookShellMessages();
    injectPlaybackGuard();
    settleBoardRouteBeforePlugins();

    // Soft deadline: never leave the user on splash longer than ~2.5s.
    // Hydrate/migrations used to block for up to 15s IPC timeouts.
    const revealDeadline = setTimeout(() => {
      markUiReady('deadline-2.5s');
      scheduleDeferredPluginLoad();
    }, 2500);

    try {
      if (localStorage.getItem(DYNAMIC_HERO_ENABLED_KEY) === null) {
        localStorage.setItem(DYNAMIC_HERO_ENABLED_KEY, '1');
      }
      invoke('apply-ui-scale', {}, 3000).catch(() => {});

      // Critical path only: theme + board-first-paint (no hydrate/listPlugins gate).
      await Promise.all([
        ensureThemeApplied().catch((error) => {
          console.warn('[StremioCustom] Theme apply failed on critical path:', error);
        }),
        loadFirstPaintPluginsFast().catch((error) => {
          console.warn('[StremioCustom] First-paint plugins failed:', error);
        }),
      ]);
      settleBoardRouteBeforePlugins();
      lastPlaybackActive = effectivePlaybackActive();

      clearTimeout(revealDeadline);
      markUiReady('theme+firstPaint');
      scheduleDeferredPluginLoad();

      // Non-critical: hydrate, migrations, deferred full board — after UI is up.
      await hydrateUserPreferences().catch((error) => {
        console.warn('[StremioCustom] hydrate after reveal failed:', error);
      });
      await ensureDefaultPluginsEnabled().catch((error) => {
        console.warn('[StremioCustom] ensureDefaultPlugins after reveal failed:', error);
      });
      await Promise.all([
        migrateNativePlayerFeaturesToPlugins(),
        migrateBrightnessToPicturePlugin(),
        migrateAnime4kPluginEnabled(),
      ]);
      syncDynamicHeroEnabledFlag();
      scheduleAuthProfilePersistence();
      // Ensure any healed first-paint / deferred plugins are present.
      scheduleDeferredPluginLoad();

      pathsCache = await api.getPaths().catch((error) => {
        console.warn('[StremioCustom] getPaths failed:', error);
        return null;
      });
      window.__stremioLanguageNames = await invoke('read-language-names').catch((error) => {
        console.warn('[StremioCustom] read-language-names failed:', error);
        return {};
      });

      safeRun('settingsWatcher', () => window.StremioCustomSettings?.startSettingsWatcher?.(pluginApi));
      ensurePlayerGlassStyles();
      ensurePlayerTransparencyFix();
      if (typeof window.__stremioCustomPlaybackEnsure === 'function') {
        window.__stremioCustomPlaybackEnsure();
      }
      if (typeof window.__stremioCustomVolumePersistEnsure === 'function') {
        window.__stremioCustomVolumePersistEnsure();
      }
      if (typeof window.__stremioCustomSubtitleSyncEnsure === 'function') {
        window.__stremioCustomSubtitleSyncEnsure();
      }
      maybeShowTmdbFirstRunNotice();
      setTimeout(() => {
        if (isOnSettingsPage()) {
          safeRun('settingsCheck', () => window.StremioCustomSettings?.checkSettings?.(pluginApi));
          safeRun('uiScaleSettings', () => window.StremioCustomUiScale?.scheduleSettingsCheck?.());
        }
      }, 500);
      setTimeout(() => {
        if (isOnSettingsPage()) {
          safeRun('settingsCheck', () => window.StremioCustomSettings?.checkSettings?.(pluginApi));
          safeRun('uiScaleSettings', () => window.StremioCustomUiScale?.scheduleSettingsCheck?.());
        }
      }, 2500);
    } catch (error) {
      clearTimeout(revealDeadline);
      markUiReady('bootstrap-error');
      scheduleDeferredPluginLoad();
      throw error;
    }
  }

  let bootstrapStarted = false;
  async function runBootstrapOnce() {
    if (bootstrapStarted) return;
    bootstrapStarted = true;
    cleanupLegacyScrollbarDom();
    try {
      await bootstrap();
    } catch (error) {
      console.error('[StremioCustom] Bootstrap failed:', error);
      bootstrapStarted = false;
      markUiReady('bootstrap-catch');
      try {
        window.__stremioCustomRemoveBootSeal?.();
      } catch (_) {
        /* ignore */
      }
    }
  }

  window.runBootstrapOnce = runBootstrapOnce;

  window.addEventListener('DOMContentLoaded', () => runBootstrapOnce());
  window.addEventListener('load', () => runBootstrapOnce());
  if (document.readyState !== 'loading') {
    runBootstrapOnce();
  }
  /**
   * Keep shell transparency / theme in sync with HashRouter navigations.
   * Prefer stremio-custom-route-change (covers pushState + hashchange); do not
   * also bind native hashchange or handlers run twice.
   */
  let routeWasPlayer = isPlayerRoute();

  function onShellRouteChange() {
    ensurePlayerTransparencyFix();
    const onPlayer = isPlayerRoute();
    // Only tear down player-plugin runtime when leaving the player — not on every
    // board/detail hop (StreamUI / seek/brightness must stay usable on re-entry).
    if (routeWasPlayer && !onPlayer) {
      suspendPlayerPluginRuntime();
    }
    routeWasPlayer = onPlayer;
    if (isOnSettingsPage()) {
      setTimeout(() => {
        safeRun('settingsCheck', () => window.StremioCustomSettings?.checkSettings?.({
          loadPlugin,
          unloadPlugin,
        }));
        safeRun('uiScaleSettings', () => window.StremioCustomUiScale?.scheduleSettingsCheck?.());
      }, 400);
    }
    if (isPlayerRoute()) {
      const current = getCurrentTheme();
      if (current && current !== 'Default') {
        applyTheme(current).finally(() => {
          ensurePlayerGlassStyles();
          ensurePlayerTransparencyFix();
          window.__stremioCustomPlaybackEnsure?.();
          window.__stremioCustomSubtitleSyncEnsure?.();
        });
      } else {
        ensurePlayerGlassStyles();
        ensurePlayerTransparencyFix();
        window.__stremioCustomPlaybackEnsure?.();
        window.__stremioCustomSubtitleSyncEnsure?.();
      }
    } else {
      ensureThemeApplied();
    }
    syncPluginsToRoute();
  }

  document.addEventListener('stremio-custom-route-change', onShellRouteChange);
  document.addEventListener('stremio-custom-stream-started', () => {
    ensurePlayerTransparencyFix();
    // Stream makes effectivePlaybackActive true — load player plugins now.
    syncPluginsToRoute();
  });
  document.addEventListener('stremio-custom-playback-stopped', () => {
    ensurePlayerTransparencyFix();
    suspendPlayerPluginRuntime();
    routeWasPlayer = false;
  });
  document.addEventListener('stremio-custom-playback-route', (event) => {
    if (event?.detail?.active) {
      ensurePlayerTransparencyFix();
      window.__stremioCustomPlaybackEnsure?.();
    }
    syncPluginsToRoute();
  });
  let maintenanceTimer = null;
  function scheduleMaintenance() {
    if (maintenanceTimer || isPlayerRoute()) return;
    maintenanceTimer = setTimeout(async () => {
      maintenanceTimer = null;
      if (isPlayerRoute()) return;
      await ensureThemeApplied();
      await ensurePluginsLoadedForRoute();
    }, 1200);
  }

  document.addEventListener('stremio-custom-route-change', scheduleMaintenance);
  setInterval(() => {
    if (typeof window.stremioCustomSuspendBackground === 'function' && window.stremioCustomSuspendBackground()) {
      return;
    }
    if (!isPlayerRoute()) scheduleMaintenance();
  }, 30000);

  console.info('[StremioCustom] Bootstrap loaded');
})();
