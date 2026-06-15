(function () {
  if (window.__stremioCustomBootstrap) return;
  window.__stremioCustomBootstrap = true;

  const PLUGIN_EXT = '.plugin.js';
  const pending = new Map();
  let requestId = 1;
  const settingsCallbacks = new Map();
  let appliedThemeName = null;
  let pathsCache = null;

  function invoke(method, params) {
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
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Custom API timeout: ${method}`));
        }
      }, 15000);
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
      return;
    }
    if (data.id == null) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(String(data.error)));
    else entry.resolve(data.result);
  };

  function hookShellMessages() {
    if (!window.chrome?.webview) return;
    window.chrome.webview.addEventListener('message', (ev) => {
      try {
        const raw = ev?.data;
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (data?.stremioCustom) window.__stremioCustomDeliverApiMessage(data);
      } catch (_) {}
    });
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
    fetchRegistry: () => invoke('fetch-registry'),
    findInstalledRegistryItem: (payload) => invoke('find-installed-registry-item', payload),
    installRegistryItem: (payload) => invoke('install-registry-item', payload),
    uninstallRegistryItem: (payload) => invoke('uninstall-registry-item', payload),
    openExternalUrl: (url) => invoke('open-external-url', { url }),
    invoke,
    _invokePip: () => Promise.resolve(false),
    togglePlayerPiP: () => Promise.resolve(window.__stremioCustomPipToggle?.() ?? false),
    enterPlayerPiP: () => Promise.resolve(window.__stremioCustomPipEnter?.() ?? false),
    exitPlayerPiP: () => Promise.resolve(window.__stremioCustomPipExit?.() ?? false),
    isPlayerPiPActive: () => Boolean(window.__stremioCustomPipMode),
    info: (pluginBaseName, message) => console.info(`[${pluginBaseName}]`, message),
    warn: (pluginBaseName, message) => console.warn(`[${pluginBaseName}]`, message),
    error: (pluginBaseName, message) => console.error(`[${pluginBaseName}]`, message),
  };

  window.StremioCustomAPI = api;
  window.StremioEnhancedAPI = api;

  function persistUserPreferences() {
    api.saveUserPreferences({
      enabledPlugins: getEnabledPlugins(),
      currentTheme: getCurrentTheme(),
      autoskip: getAutoskipPreferences(),
      metadataAddon: getMetadataAddon(),
      language: getLanguagePreferences(),
      preload: getPreloadPreference(),
      discordPresence: getDiscordPresencePreferences(),
      library: getLibraryPreferences(),
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
  };

  const LIQUID_GLASS_THEME = 'liquid-glass.theme.css';
  const HORIZONTAL_NAV_PLUGIN = 'interface/horizontal-navigation.plugin.js';
  const METADATA_ADDON_KEY = 'stremio-custom-metadata-addon';
  const PRELOAD_SECS_KEY = 'stremio-custom-preload-secs';
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
  const DEFAULT_PLUGIN_PATTERNS = [
    /context[-_ ]?menu[-_ ]?fix/i,
    /enhanced[-_ ]?covers/i,
    /enhanced[-_ ]?title(?:bar)?/i,
    /dynamic[-_ ]?hero/i,
    /hero[-_ ]?div/i,
    /data[-_ ]?enrichment/i,
    /meta[-_ ]?hover/i,
  ];

  let autoskipCache = { intro: false, credits: false, recap: false };
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
    return value ? String(value) : '120';
  }

  function applyPreloadPreference(value) {
    if (value == null) return;
    const normalized = String(value).trim();
    if (!normalized) return;
    localStorage.setItem(PRELOAD_SECS_KEY, normalized);
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

  function removeHorizontalNavPluginFromEnabled() {
    const enabled = getEnabledPlugins();
    const next = enabled.filter((pluginRef) => !String(pluginRef || '').includes('horizontal-navigation'));
    if (next.length === enabled.length) return;
    setEnabledPlugins(next);
    unloadPlugin(HORIZONTAL_NAV_PLUGIN);
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
    persistUserPreferences();
  }

  function getCurrentTheme() {
    return localStorage.getItem('currentTheme') || '';
  }

  function setCurrentTheme(theme) {
    localStorage.setItem('currentTheme', theme || '');
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

  function mergeAutoskipPreferences(diskAutoskip, localAutoskip) {
    const ids = ['intro', 'credits', 'recap'];
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
      const diskDiscordPresence = preferences?.discordPresence;
      const diskLibrary = preferences?.library;
      const diskOnboarding = preferences?.onboarding;
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
        localStorage.setItem('currentTheme', diskTheme);
        localStorage.setItem(METADATA_ADDON_KEY, diskMetadataAddon);
      } else if (hasLocalState) {
        localStorage.setItem('enabledPlugins', JSON.stringify(localPlugins));
        localStorage.setItem('currentTheme', localTheme);
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

      await loadAutoskipSettings();

      await api.saveUserPreferences({
        enabledPlugins: getEnabledPlugins(),
        currentTheme: getCurrentTheme(),
        autoskip: getAutoskipPreferences(),
        metadataAddon: getMetadataAddon(),
        language: getLanguagePreferences(),
        preload: getPreloadPreference(),
        discordPresence: getDiscordPresencePreferences(),
        library: getLibraryPreferences(),
        onboarding: {
          tmdbNoticeShown: localStorage.getItem(TMDB_NOTICE_KEY) === 'true',
          defaultsApplied: localStorage.getItem(DEFAULTS_APPLIED_KEY) === 'true',
        },
      }).catch(() => {});
    } catch (_) {
      await loadAutoskipSettings().catch(() => {});
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
    html.${PLAYER_ROUTE_CLASS} #root > div {
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
    html.${PLAYER_ROUTE_CLASS} [class*="player-container"] [class*="background-layer"],
    html.${PLAYER_ROUTE_CLASS} [class*="player-container"] [class*="background-layer"] [class*="image"] {
      pointer-events: none !important;
    }
    html.${PLAYER_ROUTE_CLASS} [class*="player-container"] [class*="buffering-layer"] {
      background: transparent !important;
      background-color: transparent !important;
    }
    html.${PLAYER_ROUTE_CLASS} [class*="player-container"] > [class*="layer-"]:not([class*="menu"]):not([class*="control"]):not([class*="info"]):not([class*="side-drawer"]):not([class*="indicator"]):not([class*="nav-bar"]) {
      background: transparent !important;
      background-color: transparent !important;
    }
  `;

  const OPAQUE_UI_STYLE_ID = 'stremio-custom-opaque-ui';

  const OPAQUE_UI_CSS = `
    html, html body, body, #root, #root > div {
      background-color: rgb(20, 20, 20) !important;
      background: rgb(20, 20, 20) !important;
    }
  `;

  function ensureOpaqueShellBackground() {
    if (isPlayerRoute()) {
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
    ensureOpaqueShellBackground();
    if (!isPlayerRoute()) {
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
    removeHorizontalNavPluginFromEnabled();
    if (themeFileName === LIQUID_GLASS_THEME) {
      window.__stremioCustomLiquidGlassNavStart?.();
      return;
    }
    window.__stremioCustomLiquidGlassNavStop?.();
    unloadPlugin(HORIZONTAL_NAV_PLUGIN);
  }

  async function applyTheme(themeFileName) {
    const targetTheme = themeFileName || '';
    if (appliedThemeName === targetTheme && document.getElementById('stremio-custom-active-theme')) {
      ensurePlayerGlassStyles();
      ensurePlayerTransparencyFix();
      return true;
    }
    document.getElementById('stremio-custom-active-theme')?.remove();
    appliedThemeName = targetTheme;
    if (!targetTheme || targetTheme === 'Default') {
      await syncLiquidGlassNavigation('');
      ensurePlayerGlassStyles();
      return true;
    }
    const css = await api.readTheme(targetTheme);
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
    const current = getCurrentTheme();
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

  async function resolvePluginRef(fileRef) {
    const normalized = String(fileRef || '').replace(/\\/g, '/');
    if (!normalized) return null;
    const plugins = await api.listPlugins();
    if (plugins.includes(normalized)) return normalized;
    const baseName = normalized.split('/').pop();
    return plugins.find((p) => p.split('/').pop() === baseName) || null;
  }

  async function migrateEnabledPlugins() {
    const enabled = getEnabledPlugins();
    const migrated = [];
    for (const fileRef of enabled) {
      const resolved = await resolvePluginRef(fileRef);
      if (resolved) migrated.push(resolved);
    }
    if (JSON.stringify(migrated) !== JSON.stringify(enabled)) setEnabledPlugins(migrated);
    return migrated;
  }

  function stripUnsafePluginPreamble(content) {
    return String(content || '').replace(
      /^(?:[\t ]*@(?:name|description|version|author|category|credits)\s[^\n]*\n)+/,
      ''
    );
  }

  async function loadPlugin(fileRef) {
    const resolved = await resolvePluginRef(fileRef);
    if (!resolved) return false;
    const scriptId = toScriptId(resolved);
    if (document.getElementById(scriptId)) return true;
    const rawContent = await api.readPlugin(resolved);
    if (!rawContent) return false;
    const content = stripUnsafePluginPreamble(rawContent);
    const pluginBaseName = resolved.split('/').pop().replace(PLUGIN_EXT, '');
    const scopedScript = `(function(){const StremioEnhancedAPI={logger:{info:(m)=>window.StremioEnhancedAPI?.info('${pluginBaseName}',m),warn:(m)=>window.StremioEnhancedAPI?.warn('${pluginBaseName}',m),error:(m)=>window.StremioEnhancedAPI?.error('${pluginBaseName}',m)},getSetting:(k)=>window.StremioEnhancedAPI?.getSetting('${pluginBaseName}',k),saveSetting:(k,v)=>window.StremioEnhancedAPI?.saveSetting('${pluginBaseName}',k,v),registerSettings:(s)=>window.StremioEnhancedAPI?.registerSettings('${pluginBaseName}',s),onSettingsSaved:(cb)=>window.StremioEnhancedAPI?.onSettingsSaved('${pluginBaseName}',cb),showAlert:async(t,ti,m)=>{window.alert(ti+'\\n\\n'+m);return 0},showPrompt:async(ti,m,d)=>window.prompt(ti+'\\n\\n'+m,d||'')};try{${content}}catch(err){console.error('[StremioCustom] Plugin crashed: ${resolved}',err);}})();`;
    const script = document.createElement('script');
    script.id = scriptId;
    script.textContent = scopedScript;
    (document.head || document.body || document.documentElement).appendChild(script);
    return true;
  }

  function unloadPlugin(fileRef) {
    document.getElementById(toScriptId(fileRef))?.remove();
  }

  const PLAYBACK_KEEP_PLUGINS = new Set([
    'interface/context-menu-fix.plugin.js',
    'interface/enhanced-titlebar.plugin.js',
    'player/tidb.plugin.js',
    'player/enhanced-player.plugin.js',
    'player/picture-in-picture.plugin.js',
  ]);

  const IDLE_DURING_PLAYBACK_PREFIXES = [
    'interface/',
    'metadata/',
    'addons/',
    'utilities/',
    'player/stream-ui.plugin.js',
    'player/filter-streams.plugin.js',
    'player/stream-quality-picker.plugin.js',
  ];

  function isIdleDuringPlayback(pluginRef) {
    const normalized = String(pluginRef || '').replace(/\\/g, '/');
    if (PLAYBACK_KEEP_PLUGINS.has(normalized)) return false;
    return IDLE_DURING_PLAYBACK_PREFIXES.some(
      (prefix) => normalized === prefix || normalized.startsWith(prefix)
    );
  }

  function filterPluginsForRoute(enabled, playbackActive = isPlayerRoute()) {
    if (!playbackActive) return enabled;
    return enabled.filter((pluginRef) => !isIdleDuringPlayback(pluginRef));
  }

  async function ensurePluginsLoadedForRoute() {
    const enabled = await migrateEnabledPlugins();
    const targetPlugins = filterPluginsForRoute(enabled);
    for (const pluginRef of enabled) {
      if (!targetPlugins.includes(pluginRef)) unloadPlugin(pluginRef);
    }
    for (const pluginRef of targetPlugins) {
      await loadPlugin(pluginRef);
    }
  }

  function injectPlaybackGuard() {
    if (document.getElementById('stremio-custom-playback-guard')) return;
    const script = document.createElement('script');
    script.id = 'stremio-custom-playback-guard';
    script.textContent = `(function(){function isPlaybackRoute(){return /#\\/player/.test(location.hash||'');}window.stremioCustomIsPlaybackRoute=isPlaybackRoute;window.stremioCustomSuspendBackground=function(){return isPlaybackRoute();};window.addEventListener('hashchange',function(){document.dispatchEvent(new CustomEvent('stremio-custom-playback-route',{detail:{active:isPlaybackRoute()}}));});})();`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  let lastPlaybackActive = null;
  async function syncPluginsToRoute() {
    const playbackActive = isPlayerRoute();
    if (playbackActive === lastPlaybackActive) return;
    lastPlaybackActive = playbackActive;
    const enabled = await migrateEnabledPlugins();
    if (playbackActive) {
      for (const pluginRef of enabled) {
        if (isIdleDuringPlayback(pluginRef)) unloadPlugin(pluginRef);
      }
    } else {
      await ensurePluginsLoadedForRoute();
    }
  }

  async function ensureDefaultPluginsEnabled() {
    const all = await api.listPlugins();
    if (!Array.isArray(all) || !all.length) return;
    const enabled = await migrateEnabledPlugins();
    const next = new Set(enabled);
    let changed = false;
    for (const pattern of DEFAULT_PLUGIN_PATTERNS) {
      const match = all.find((ref) => pattern.test(String(ref || '')));
      if (match && !next.has(match)) {
        next.add(match);
        changed = true;
      }
    }
    const merged = Array.from(next);
    if (changed || merged.length !== enabled.length) {
      setEnabledPlugins(merged);
      await ensurePluginsLoadedForRoute();
    }
    localStorage.setItem(DEFAULTS_APPLIED_KEY, 'true');
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
        Data Enrichment needs a TMDB API key. Add it in Settings > MyStremio > Plugins > Data Enrichment.
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

  function installNavigationShield() {
    return;
    const SHIELD_ID = 'stremio-custom-nav-shield';
    let hideTimer = null;
    const ensure = () => {
      let shield = document.getElementById(SHIELD_ID);
      if (shield) return shield;
      shield = document.createElement('div');
      shield.id = SHIELD_ID;
      shield.style.cssText =
        'position:fixed;inset:0;z-index:120;opacity:0;display:none;pointer-events:none;' +
        'transition:opacity 120ms ease;background:rgb(20,20,20);';
      document.body.appendChild(shield);
      return shield;
    };
    const showBrief = (ms = 220) => {
      const shield = ensure();
      if (!shield) return;
      shield.style.display = 'block';
      shield.style.opacity = '1';
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        shield.style.opacity = '0';
        setTimeout(() => {
          if (shield.style.opacity === '0') shield.style.display = 'none';
        }, 140);
      }, ms);
    };
    const watchRoute = () => {
      showBrief(180);
      if (/#\/player/.test(location.hash || '')) {
        showBrief(320);
      }
    };
    if (document.body) showBrief(420);
    window.addEventListener('hashchange', watchRoute);
    document.addEventListener('stremio-custom-bootstrap-ready', () => showBrief(120));
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
      hydrateUserPreferences,
      getAutoskipPreferences,
      setAutoskipEnabled,
      refreshAutoskipToggles,
      ensureAutoskipReady,
      getMetadataAddon,
      setMetadataAddon,
      isNativeSettingsSection,
      getSettingsSectionsContainer,
      getNativeSettingsSections,
      removeLegacyQuickSettingsSection,
      persistUserPreferences,
    },
    plugins: {
      loadPlugin,
      unloadPlugin,
      resolvePluginRef,
      migrateEnabledPlugins,
      ensurePluginsLoadedForRoute,
      filterPluginsForRoute,
    },
    theme: { applyTheme, ensureThemeApplied },
  };

  const pluginApi = { loadPlugin, unloadPlugin };

  function safeRun(label, fn) {
    try {
      fn();
    } catch (error) {
      console.error(`[StremioCustom] ${label} failed:`, error);
    }
  }

  async function bootstrap() {
    hookShellMessages();
    injectPlaybackGuard();
    installNavigationShield();
    await hydrateUserPreferences();
    await ensureDefaultPluginsEnabled();
    removeHorizontalNavPluginFromEnabled();
    pathsCache = await api.getPaths();
    window.__stremioLanguageNames = await invoke('read-language-names');
    await ensureThemeApplied();
    await ensurePluginsLoadedForRoute();
    safeRun('removePlayerLanguageBars', () => window.StremioCustomFavoriteLanguages?.removePlayerLanguageBars?.());
    safeRun('favoriteLanguages', () => window.StremioCustomFavoriteLanguages?.injectFavoriteHeartsRuntime?.());
    safeRun('settingsWatcher', () => window.StremioCustomSettings?.startSettingsWatcher?.(pluginApi));
    ensurePlayerGlassStyles();
    ensurePlayerTransparencyFix();
    if (typeof window.__stremioCustomPlaybackEnsure === 'function') {
      window.__stremioCustomPlaybackEnsure();
    }
    if (typeof window.__stremioCustomSubtitleSyncEnsure === 'function') {
      window.__stremioCustomSubtitleSyncEnsure();
    }
    maybeShowTmdbFirstRunNotice();
    document.dispatchEvent(new CustomEvent('stremio-custom-bootstrap-ready'));
    setTimeout(() => {
      if (isOnSettingsPage()) {
        safeRun('settingsCheck', () => window.StremioCustomSettings?.checkSettings?.(pluginApi));
      }
    }, 500);
    setTimeout(() => {
      if (isOnSettingsPage()) {
        safeRun('settingsCheck', () => window.StremioCustomSettings?.checkSettings?.(pluginApi));
      }
    }, 2500);
  }

  let bootstrapStarted = false;
  async function runBootstrapOnce() {
    if (bootstrapStarted) return;
    bootstrapStarted = true;
    try {
      await bootstrap();
    } catch (error) {
      console.error('[StremioCustom] Bootstrap failed:', error);
      bootstrapStarted = false;
    }
  }

  window.runBootstrapOnce = runBootstrapOnce;

  window.addEventListener('DOMContentLoaded', () => runBootstrapOnce());
  window.addEventListener('load', () => runBootstrapOnce());
  if (document.readyState !== 'loading') {
    runBootstrapOnce();
  }
  window.addEventListener('hashchange', () => {
    ensurePlayerTransparencyFix();
    if (isOnSettingsPage()) {
      setTimeout(() => {
        safeRun('settingsCheck', () => window.StremioCustomSettings?.checkSettings?.({
          loadPlugin,
          unloadPlugin,
        }));
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

  window.addEventListener('hashchange', scheduleMaintenance);
  setInterval(() => {
    if (typeof window.stremioCustomSuspendBackground === 'function' && window.stremioCustomSuspendBackground()) {
      return;
    }
    if (!isPlayerRoute()) scheduleMaintenance();
  }, 30000);

  console.info('[StremioCustom] Bootstrap loaded');
})();
