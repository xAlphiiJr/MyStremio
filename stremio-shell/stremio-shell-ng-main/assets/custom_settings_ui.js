(function () {
  if (!window.StremioCustomAPI || !window.StremioCustom?.helpers) {
    console.error('[StremioCustom] Settings UI aborted: bootstrap missing');
    return;
  }

const api = window.StremioCustomAPI;
const path = {
  basename: (filePath, ext = '') => {
    const base = String(filePath).split(/[/\\]/).pop() || '';
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
  },
};
const FILE_EXTENSIONS = {
  PLUGIN: '.plugin.js',
  THEME: '.theme.css',
  PLUGIN_CONFIG: '.plugin.json',
  PLUGIN_SCHEMA: '.plugin.schema.json',
};
let PLUGINS_PATH = '';
let THEMES_PATH = '';
const {
  waitForSettingsContainer,
  isOnSettingsPage,
  getEnabledPlugins,
  setEnabledPlugins,
  getCurrentTheme,
  setCurrentTheme,
  getLibraryPreferences,
  applyLibraryPreferences,
  queryFirstMatching,
  isPluginEnabled,
  removeLegacyQuickSettingsSection,
  persistUserPreferences,
} = window.StremioCustom.helpers;
const { listPlugins: listPluginsFromApi, resolvePluginRef, loadPlugin, unloadPlugin } = window.StremioCustom.plugins;
const { applyTheme } = window.StremioCustom.theme;
const { tryInjectPlayerLanguageSettings, isLanguageUiComplete } = window.StremioCustomFavoriteLanguages;

function tryInjectAutoskipSettings(classes) {
  return window.StremioCustomAutoskip?.tryInjectAutoskipSettings?.(classes);
}

async function listPlugins() {
  return api.listPlugins();
}

async function listThemes() {
  return api.listThemes();
}

async function extractMetadata(filePath) {
  const relative = String(filePath).replace(/\\/g, '/').split('/').pop();
  return api.getMetadata(relative);
}

function isCustomSettingsComplete() {
  return (
    isLanguageUiComplete() &&
    Boolean(document.getElementById('stremio-custom-autoskip')) &&
    Boolean(document.getElementById('stremio-custom-fav-audio-quick')) &&
    Boolean(document.getElementById('stremio-custom-fav-subs-quick')) &&
    Boolean(document.getElementById(LIBRARY_BACKUP_CATEGORY_ID)) &&
    Boolean(document.getElementById(DISCORD_CATEGORY_ID))
  );
}

const SECTION_ID = 'stremio-custom';
const PRELOAD_CATEGORY_ID = 'stremio-custom-preload-category';
const LIBRARY_BACKUP_CATEGORY_ID = 'stremio-custom-library-backup-category';
const DISCORD_CATEGORY_ID = 'stremio-custom-discord-category';
const THEMES_CATEGORY_ID = 'stremio-custom-themes';
const THEMES_FOLDER_ID = 'stremio-custom-theme-list';
const PLUGINS_CATEGORY_ID = 'stremio-custom-plugins';
const STREAMING_RESTART_ID = 'stremio-custom-streaming-restart';
const PLUGIN_FOLDERS_STORAGE_KEY = 'stremio-custom-plugin-folders';
const PLUGIN_CATEGORY_ORDER = [
  { id: 'player', label: 'Player' },
  { id: 'interface', label: 'Interface' },
  { id: 'metadata', label: 'Metadata' },
  { id: 'addons', label: 'Addons' },
  { id: 'utilities', label: 'Utilities' },
];
const CUSTOM_NAV_SECTIONS = [{ id: SECTION_ID, label: 'MyStremio' }];
const SETTINGS_STYLE_ID = 'stremio-custom-settings-style';
const SETTINGS_UI_VERSION = '42';
const DISCORD_FOLDER_ID = 'stremio-custom-discord-folder';

function favoriteSelectPlaceholder() {
  return 'Select…';
}

function createNativeDropdownCaret() {
  const caret = document.createElement('span');
  caret.className = 'stremio-custom-native-caret';
  caret.setAttribute('aria-hidden', 'true');
  return caret;
}

function positionNativeDropdownPanel(dropdown) {
  const trigger = dropdown.querySelector('.stremio-custom-native-dropdown-trigger');
  const panel = dropdown.querySelector('.stremio-custom-native-dropdown-panel');
  if (!trigger || !panel) return;
  const rect = trigger.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    closeNativeDropdown(dropdown);
    return;
  }
  panel.style.position = 'fixed';
  panel.style.top = `${Math.max(rect.bottom + 2, 8)}px`;
  panel.style.left = `${rect.left}px`;
  panel.style.width = `${Math.max(rect.width, 280)}px`;
  panel.style.zIndex = '100000';
  if (panel.classList.contains('stremio-custom-plugin-panel')) {
    panel.style.maxHeight = 'none';
    panel.style.overflowY = 'visible';
  }
}

function closeNativeDropdown(dropdown) {
  if (!dropdown) return;
  dropdown.classList.remove('active');
  const panel = dropdown.querySelector('.stremio-custom-native-dropdown-panel');
  const trigger = dropdown.querySelector('.stremio-custom-native-dropdown-trigger');
  if (panel) panel.hidden = true;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function closeAllNativeDropdowns(except) {
  document.querySelectorAll('.stremio-custom-native-dropdown.active').forEach((dropdown) => {
    if (dropdown !== except) closeNativeDropdown(dropdown);
  });
}

function openNativeDropdown(dropdown) {
  if (!dropdown) return;
  const trigger = dropdown.querySelector('.stremio-custom-native-dropdown-trigger');
  const panel = dropdown.querySelector('.stremio-custom-native-dropdown-panel');
  if (!trigger || !panel) return;

  const rect = trigger.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1 || rect.top < 1) return;

  closeAllNativeDropdowns(dropdown);
  dropdown.classList.add('active');
  panel.hidden = false;
  positionNativeDropdownPanel(dropdown);
  trigger.setAttribute('aria-expanded', 'true');
}

function ensureNativeDropdownGlobalHandlers() {
  if (window.__stremioCustomNativeDropdownHandlers) return;
  window.__stremioCustomNativeDropdownHandlers = true;
  document.addEventListener(
    'click',
    (event) => {
      if (event.target.closest('.stremio-custom-native-dropdown')) return;
      closeAllNativeDropdowns();
    },
    true
  );
  window.addEventListener('resize', () => {
    document.querySelectorAll('.stremio-custom-native-dropdown.active').forEach((dropdown) => {
      positionNativeDropdownPanel(dropdown);
    });
  });
  window.addEventListener(
    'scroll',
    () => {
      document.querySelectorAll('.stremio-custom-native-dropdown.active').forEach((dropdown) => {
        positionNativeDropdownPanel(dropdown);
      });
    },
    true
  );
  window.addEventListener('hashchange', () => {
    if (!/#\/settings/.test(location.hash || '')) {
      closeAllNativeDropdowns();
    }
  });
}

function createNativeDropdownShell(folderId, title, summaryText) {
  ensureNativeDropdownGlobalHandlers();
  const dropdown = document.createElement('div');
  dropdown.className = 'stremio-custom-native-dropdown stremio-custom-plugin-folder';
  dropdown.dataset.categoryId = folderId;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'stremio-custom-native-dropdown-trigger';
  trigger.setAttribute('aria-expanded', 'false');

  const value = document.createElement('span');
  value.className = 'stremio-custom-native-dropdown-value';
  value.textContent = summaryText || title;

  trigger.append(value, createNativeDropdownCaret());

  const panel = document.createElement('div');
  panel.className = 'stremio-custom-native-dropdown-panel';
  panel.hidden = true;

  dropdown.append(trigger, panel);
  return { dropdown, trigger, panel, value };
}

function wireNativeDropdown(dropdown, folderId, isInitiallyOpen) {
  const trigger = dropdown.querySelector('.stremio-custom-native-dropdown-trigger');
  if (!trigger) return;

  if (isInitiallyOpen) {
    dropdown.dataset.prefersExpanded = '1';
  }

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const open = dropdown.classList.contains('active');
    if (open) {
      closeNativeDropdown(dropdown);
      const nextExpanded = getExpandedPluginFolders().filter((id) => id !== folderId);
      setExpandedPluginFolders(nextExpanded);
      return;
    }
    openNativeDropdown(dropdown);
    const nextExpanded = getExpandedPluginFolders().filter((id) => id !== folderId);
    nextExpanded.push(folderId);
    setExpandedPluginFolders(nextExpanded);
  });
}
const CLEAR_STREAM_CACHE_BTN_ID = 'stremio-custom-clear-stream-cache-btn';
const EXPORT_LIBRARY_BTN_ID = 'stremio-custom-export-library-btn';
const IMPORT_LIBRARY_BTN_ID = 'stremio-custom-import-library-btn';
const PRELOAD_SECS_KEY = 'stremio-custom-preload-secs';

let injectionInProgress = false;

function ensureSettingsStyles() {
  if (document.getElementById(SETTINGS_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = SETTINGS_STYLE_ID;
  style.textContent = `
    .stremio-custom-settings-block > [class*="label-"] {
      flex: none;
      align-self: stretch;
      font-size: 1.8rem;
      line-height: 3.4rem;
      margin-bottom: 2rem;
      color: var(--primary-foreground-color);
    }

    .stremio-custom-settings-block [data-sc-meta] {
      opacity: 0.65;
      font-size: 0.85em;
      margin-top: 0.15em;
      line-height: 1.35;
    }

    .stremio-custom-settings-block [data-sc-version] {
      opacity: 0.45;
      font-size: 0.78em;
      margin-top: 0.1em;
    }

    .stremio-custom-settings-block .stremio-custom-plugin-folder {
      margin-bottom: 0.65rem;
    }

    .stremio-custom-settings-block .stremio-custom-native-dropdown {
      position: relative;
      width: 100%;
      border-radius: 2.75rem;
      background: var(--overlay-color, rgba(255, 255, 255, 0.08));
    }

    .stremio-custom-settings-block .stremio-custom-native-dropdown-trigger {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      height: 3rem;
      min-height: 3rem;
      max-height: 3rem;
      padding: 0.75rem 1.5rem;
      margin: 0;
      border-radius: 2.75rem;
      cursor: pointer;
      user-select: none;
      box-sizing: border-box;
      border: none;
      background: transparent;
      box-shadow: none;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      color: var(--primary-foreground-color);
      font: inherit;
    }

    .stremio-custom-settings-block .stremio-custom-native-dropdown-trigger:hover,
    .stremio-custom-settings-block .stremio-custom-native-dropdown.active .stremio-custom-native-dropdown-trigger {
      background: transparent;
      border: none;
      box-shadow: none;
    }

    .stremio-custom-settings-block .stremio-custom-native-dropdown-trigger:focus-visible {
      outline: var(--focus-outline-size) solid var(--primary-foreground-color);
      outline-offset: 2px;
    }

    .stremio-custom-settings-block .stremio-custom-native-dropdown-value {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: left;
      font-size: 1rem;
      line-height: 1.5rem;
      font-weight: 400;
      color: var(--primary-foreground-color);
    }

    .stremio-custom-settings-block .stremio-custom-native-dropdown-panel {
      display: block;
      padding: 0.2rem 0;
      background: var(--modal-background-color, rgba(30, 30, 30, 0.92));
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: var(--border-radius, 12px);
      box-shadow:
        0 8px 32px rgba(0, 0, 0, 0.5),
        0 4px 16px rgba(0, 0, 0, 0.3),
        inset 0 1px 0 rgba(255, 255, 255, 0.1);
      backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
      -webkit-backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
      max-height: 21rem;
      overflow-y: auto;
    }

    .stremio-custom-settings-block .stremio-custom-native-dropdown-panel .stremio-custom-plugin-entry {
      padding: 0.15rem 0.5rem;
      margin: 0;
    }

    .stremio-custom-settings-block .stremio-custom-native-dropdown-panel .stremio-custom-plugin-entry > [class*="option-"] {
      margin: 0 !important;
      padding-top: 0.35rem !important;
      padding-bottom: 0.35rem !important;
      display: flex !important;
      flex-direction: row !important;
      align-items: flex-start !important;
      width: 100% !important;
      min-width: 0 !important;
    }

    .stremio-custom-settings-block .stremio-custom-native-dropdown-panel [class*="content-"] {
      flex: none !important;
      display: flex !important;
      align-items: center !important;
      justify-content: flex-end !important;
      min-width: 4.5rem !important;
    }

    .stremio-custom-settings-block .stremio-custom-native-dropdown-panel [class*="toggle-container"] {
      flex-shrink: 0 !important;
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: auto !important;
    }

    .stremio-custom-settings-block .stremio-custom-native-dropdown-panel.stremio-custom-plugin-panel {
      max-height: none !important;
      overflow-y: visible !important;
    }

    .stremio-custom-settings-block .stremio-custom-autoskip-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.9rem;
      padding: 0.62rem 1rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .stremio-custom-settings-block .stremio-custom-autoskip-row:last-child {
      border-bottom: 0;
    }

    .stremio-custom-settings-block .stremio-custom-autoskip-copy {
      display: flex;
      flex-direction: column;
      gap: 0.16rem;
      min-width: 0;
      flex: 1;
    }

    .stremio-custom-settings-block .stremio-custom-autoskip-label {
      font-size: 0.96em;
      line-height: 1.35;
      color: var(--primary-foreground-color);
    }

    .stremio-custom-settings-block .stremio-custom-autoskip-hint {
      font-size: 0.82em;
      line-height: 1.35;
      color: var(--primary-foreground-color);
      opacity: 0.62;
    }

    .stremio-custom-settings-block .stremio-custom-autoskip-row [class*="toggle-container"] {
      flex-shrink: 0;
      margin-top: 0.08rem;
    }

    .stremio-custom-settings-block .stremio-custom-native-caret {
      display: block;
      width: 0;
      height: 0;
      margin-left: 1rem;
      flex: none;
      border: 6px solid transparent;
      border-top-color: rgba(255, 255, 255, 0.45);
      border-bottom: 0;
      transition: none;
    }

    .stremio-custom-settings-block .stremio-custom-native-dropdown.active .stremio-custom-native-caret,
    .stremio-custom-settings-block .stremio-custom-lang-picker.active .stremio-custom-native-caret,
    .stremio-custom-settings-block .stremio-custom-themed-select.active .stremio-custom-native-caret,
    .stremio-custom-settings-block .stremio-custom-autoskip-dropdown.active .stremio-custom-native-caret {
      transform: scaleY(-1);
    }

    .stremio-custom-settings-block .stremio-custom-native-dropdown-panel[hidden] {
      display: none !important;
    }

    .stremio-custom-settings-block .stremio-custom-folder-header {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      min-height: 2.45rem;
      padding: 0.42rem 0.9rem;
      margin-bottom: 0;
      border-radius: 999px;
      cursor: pointer;
      user-select: none;
      box-sizing: border-box;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.06);
      backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
      -webkit-backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
      box-shadow:
        0 8px 24px rgba(0, 0, 0, 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
      transition: background 0.2s ease, border-color 0.2s ease;
    }

    .stremio-custom-settings-block .stremio-custom-folder-header:hover {
      background: rgba(255, 255, 255, 0.09);
      border-color: rgba(255, 255, 255, 0.12);
    }

    .stremio-custom-settings-block .stremio-custom-folder-header:focus-visible {
      outline: var(--focus-outline-size) solid var(--primary-foreground-color);
      outline-offset: 2px;
    }

    .stremio-custom-settings-block .stremio-custom-folder-label {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 0.95rem;
      line-height: 1.5rem;
      font-weight: 600;
      color: var(--primary-foreground-color);
      letter-spacing: 0.02em;
    }

    .stremio-custom-settings-block .stremio-custom-folder-caret {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: 1.2rem;
      height: 1.2rem;
      margin-left: 1rem;
      opacity: 0.55;
      color: var(--primary-foreground-color);
    }

    .stremio-custom-settings-block .stremio-custom-folder-body {
      padding: 0.5rem 0 0 0.35rem;
    }

    .stremio-custom-settings-block .stremio-custom-folder-body[hidden] {
      display: none;
    }

    .stremio-custom-settings-block .stremio-custom-full-width-option {
      flex-direction: column !important;
      align-items: stretch !important;
    }

    .stremio-custom-settings-block .stremio-custom-full-width-option > [class*="heading-"],
    .stremio-custom-settings-block .stremio-custom-full-width-option > [class*="content-"] {
      width: 100% !important;
      max-width: 100% !important;
      flex: 1 1 auto !important;
    }

    .stremio-custom-settings-block .stremio-custom-section-hint,
    .stremio-custom-settings-block .stremio-custom-category-hint {
      opacity: 0.55;
      font-size: 0.82rem;
      line-height: 1.5;
      font-weight: 400;
      letter-spacing: 0.01em;
      padding: 0.15rem 0 1rem;
      color: var(--primary-foreground-color);
    }

    .stremio-custom-settings-block .stremio-custom-preload-option {
      flex-direction: column !important;
      align-items: stretch !important;
      gap: 0.85rem !important;
    }

    .stremio-custom-settings-block .stremio-custom-preload-option > [class*="heading-"],
    .stremio-custom-settings-block .stremio-custom-preload-option > [class*="content-"] {
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      flex: 1 1 auto !important;
    }

    .stremio-custom-settings-block .stremio-custom-preload-option > [class*="content-"] {
      display: flex !important;
      flex-direction: column !important;
      align-items: flex-start !important;
      justify-content: flex-start !important;
      text-align: left !important;
    }

    .stremio-custom-settings-block .stremio-custom-preload-controls {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      align-self: flex-start;
      gap: 1rem;
      width: 100%;
      max-width: 18rem;
      margin-left: 0;
      margin-right: auto;
    }

    .stremio-custom-settings-block .stremio-custom-preload-copy {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      min-width: 0;
      flex: 1 1 auto;
    }

    .stremio-custom-settings-block .stremio-custom-preload-description {
      opacity: 0.55;
      font-size: 0.82rem;
      line-height: 1.45;
      font-weight: 400;
      color: var(--primary-foreground-color);
      max-width: 34rem;
    }

    .stremio-custom-settings-block .stremio-custom-preload-actions {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
      width: 100%;
      max-width: 18rem;
      padding-top: 0.85rem;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    .stremio-custom-settings-block .stremio-custom-clear-stream-cache-btn {
      width: 100%;
      min-height: 2.45rem;
      padding: 0.45rem 1rem;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(70, 70, 70, 0.22);
      color: var(--primary-foreground-color);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      box-shadow:
        0 8px 32px rgba(0, 0, 0, 0.2),
        inset 0 1px 0 rgba(255, 255, 255, 0.12);
      backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
      -webkit-backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
      transition: background 0.15s ease, border-color 0.15s ease;
    }

    .stremio-custom-settings-block .stremio-custom-clear-stream-cache-btn:hover:not(:disabled) {
      background: rgba(90, 90, 90, 0.28);
      border-color: rgba(255, 255, 255, 0.14);
    }

    .stremio-custom-settings-block .stremio-custom-clear-stream-cache-btn:disabled {
      opacity: 0.55;
      cursor: default;
    }

    .stremio-custom-settings-block .stremio-custom-stream-cache-hint {
      opacity: 0.5;
      font-size: 0.78rem;
      line-height: 1.45;
      color: var(--primary-foreground-color);
      max-width: none;
      white-space: normal;
      word-break: normal;
    }

    .stremio-custom-themed-select {
      position: relative;
      width: 100%;
      max-width: 18rem;
      flex: none;
      border-radius: 2.75rem;
      background: var(--overlay-color, rgba(255, 255, 255, 0.08));
    }

    .stremio-custom-themed-select-trigger {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      min-height: 3rem;
      height: 3rem;
      padding: 0.75rem 1.5rem;
      border-radius: 2.75rem;
      border: none;
      background: transparent;
      color: var(--primary-foreground-color);
      font: inherit;
      text-align: left;
      cursor: pointer;
      box-shadow: none;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      box-sizing: border-box;
    }

    .stremio-custom-themed-select-trigger:hover,
    .stremio-custom-themed-select.active .stremio-custom-themed-select-trigger {
      background: transparent;
      border: none;
    }

    .stremio-custom-themed-select-value {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: left;
    }

    .stremio-custom-themed-select-menu {
      position: fixed;
      z-index: 2147482000;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(30, 30, 30, 0.94);
      box-shadow:
        0 16px 40px rgba(0, 0, 0, 0.45),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
      backdrop-filter: var(--backdrop-filter, blur(24px) saturate(180%));
      -webkit-backdrop-filter: var(--backdrop-filter, blur(24px) saturate(180%));
      padding: 0.35rem;
      overflow: hidden;
      min-width: 12rem;
    }

    .stremio-custom-themed-select-menu[hidden] {
      display: none !important;
    }

    .stremio-custom-themed-select-option {
      display: block;
      width: 100%;
      padding: 0.55rem 0.8rem;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--primary-foreground-color);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .stremio-custom-themed-select-option:hover,
    .stremio-custom-themed-select-option.selected {
      background: rgba(255, 255, 255, 0.1);
    }

    .stremio-custom-settings-block .stremio-custom-glass-select {
      position: relative;
      width: min(100%, 16rem);
    }

    .stremio-custom-settings-block .stremio-custom-glass-select-trigger {
      width: 100%;
      min-height: 2.45rem;
      padding: 0.45rem 0.9rem;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(70, 70, 70, 0.22);
      color: var(--primary-foreground-color);
      font: inherit;
      text-align: left;
      cursor: pointer;
      box-shadow:
        0 8px 32px rgba(0, 0, 0, 0.2),
        inset 0 1px 0 rgba(255, 255, 255, 0.12);
      backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
      -webkit-backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
    }

    .stremio-custom-settings-block .stremio-custom-glass-select.active .stremio-custom-glass-select-trigger,
    .stremio-custom-settings-block .stremio-custom-glass-select-trigger:hover {
      background: rgba(90, 90, 90, 0.28);
      border-color: rgba(255, 255, 255, 0.14);
    }

    .stremio-custom-settings-block .stremio-custom-glass-select-dropdown {
      position: absolute;
      top: calc(100% + 0.35rem);
      left: 0;
      right: 0;
      z-index: 40;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(30, 30, 30, 0.88);
      box-shadow:
        0 16px 40px rgba(0, 0, 0, 0.45),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
      backdrop-filter: var(--backdrop-filter, blur(24px) saturate(180%));
      -webkit-backdrop-filter: var(--backdrop-filter, blur(24px) saturate(180%));
      padding: 0.35rem;
      overflow: hidden;
    }

    .stremio-custom-settings-block .stremio-custom-glass-select-dropdown[hidden] {
      display: none;
    }

    .stremio-custom-settings-block .stremio-custom-glass-select-option {
      display: block;
      width: 100%;
      padding: 0.55rem 0.8rem;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--primary-foreground-color);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .stremio-custom-settings-block .stremio-custom-glass-select-option:hover,
    .stremio-custom-settings-block .stremio-custom-glass-select-option.selected {
      background: rgba(255, 255, 255, 0.1);
    }

    .stremio-custom-settings-block .stremio-custom-native-select {
      width: min(100%, 16rem);
      min-height: 2.45rem;
      padding: 0.45rem 2rem 0.45rem 0.9rem;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(70, 70, 70, 0.22);
      color: var(--primary-foreground-color);
      font: inherit;
      cursor: pointer;
      appearance: auto;
      -webkit-appearance: menulist;
      box-shadow:
        0 8px 32px rgba(0, 0, 0, 0.2),
        inset 0 1px 0 rgba(255, 255, 255, 0.12);
      backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
      -webkit-backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
      pointer-events: auto;
      position: relative;
      z-index: 5;
    }

    .stremio-custom-settings-block .stremio-custom-native-select:hover,
    .stremio-custom-settings-block .stremio-custom-native-select:focus {
      background: rgba(90, 90, 90, 0.28);
      border-color: rgba(255, 255, 255, 0.14);
      outline: none;
    }

    [class*="settings-content"] [class*="menu-"] [data-section^="stremio-custom"] {
      pointer-events: auto !important;
      cursor: pointer !important;
    }

    [class*="settings-content"] .stremio-custom-hint {
      opacity: 0.65;
      font-size: 0.85em;
      line-height: 1.45;
      padding: 0.35rem 1rem 0.85rem;
      color: var(--primary-foreground-color);
    }

    .stremio-custom-settings-block .stremio-custom-plugin-entry {
      margin-bottom: 0.15rem;
    }

    .stremio-custom-settings-block .stremio-custom-plugin-controls {
      display: flex;
      align-items: center;
      gap: 0.65rem;
    }

    .stremio-custom-settings-block .stremio-custom-plugin-settings-gear {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2rem;
      height: 2rem;
      padding: 0;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--primary-foreground-color);
      opacity: 0.55;
      cursor: pointer;
      transition: opacity 0.15s ease, background 0.15s ease;
    }

    .stremio-custom-settings-block .stremio-custom-plugin-settings-gear:hover,
    .stremio-custom-settings-block .stremio-custom-plugin-settings-gear.active {
      opacity: 1;
      background: rgba(255, 255, 255, 0.08);
    }

    .stremio-custom-settings-block .stremio-custom-plugin-settings-gear svg {
      width: 1.1rem;
      height: 1.1rem;
      fill: currentColor;
    }

    .stremio-custom-settings-block .stremio-custom-plugin-settings {
      padding: 0.15rem 1rem 0.65rem 1.25rem;
      margin: 0 0 0.35rem 0.75rem;
      border-left: 2px solid rgba(255, 255, 255, 0.08);
    }

    .stremio-custom-settings-block .stremio-custom-plugin-settings[hidden] {
      display: none;
    }

    .stremio-custom-settings-block .stremio-custom-setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.4rem 0;
    }

    .stremio-custom-settings-block .stremio-custom-setting-label {
      flex: 1;
      min-width: 0;
      font-size: 0.92em;
      line-height: 1.35;
      color: var(--primary-foreground-color);
    }

    .stremio-custom-settings-block .stremio-custom-setting-hint {
      opacity: 0.6;
      font-size: 0.82em;
      line-height: 1.4;
      margin-top: 0.15rem;
    }

    .stremio-custom-settings-block .stremio-custom-setting-control {
      flex-shrink: 0;
    }

    .stremio-custom-settings-block .stremio-custom-setting-input,
    .stremio-custom-settings-block .stremio-custom-setting-select {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      color: var(--primary-foreground-color);
      padding: 0.35rem 0.55rem;
      min-width: 10rem;
      font: inherit;
    }

    .stremio-custom-settings-block .stremio-custom-setting-input:focus,
    .stremio-custom-settings-block .stremio-custom-setting-select:focus {
      outline: 1px solid var(--primary-accent-color, #7f5af0);
      border-color: var(--primary-accent-color, #7f5af0);
    }

    .stremio-custom-settings-block .stremio-custom-setting-select {
      appearance: auto;
      -webkit-appearance: menulist;
      color-scheme: dark;
      background-color: rgba(56, 56, 56, 0.95);
      color: #f4f4f4;
    }

    .stremio-custom-settings-block .stremio-custom-setting-select option {
      background-color: #2d2d2d;
      color: #f4f4f4;
    }
  `;
  document.head.appendChild(style);
}

function createOptionLabel(metadata, fallbackName) {
  const label = document.createElement('div');

  const title = document.createElement('div');
  title.textContent = metadata.name || fallbackName;
  label.appendChild(title);

  if (metadata.description) {
    const description = document.createElement('div');
    description.dataset.scMeta = 'true';
    description.textContent = metadata.description;
    label.appendChild(description);
  }

  if (metadata.version || metadata.author) {
    const version = document.createElement('div');
    version.dataset.scVersion = 'true';
    version.textContent = [metadata.version ? `v${metadata.version}` : null, metadata.author]
      .filter(Boolean)
      .join(' · ');
    label.appendChild(version);
  }

  return label;
}

function normalizeToggleClass(className) {
  return String(className || '')
    .split(/\s+/)
    .filter((part) => part && part !== 'checked')
    .join(' ');
}

function getStremioClasses() {
  const section = queryFirstMatching([
    '[class*="sections-container"] > [class*="section-"]',
    '[class*="section-"]',
  ]);
  const category = document.querySelector('[class*="category-"]');
  const categoryLabel = category?.querySelector('[class*="label-"]');
  const categoryHeading = category?.querySelector('[class*="heading-"]');
  const categoryIcon = category?.querySelector('[class*="icon-"]');
  const option = document.querySelector('[class*="option-"]');
  const optionContent = option?.querySelector('[class*="content-"]');
  const optionHeading = option?.querySelector('[class*="heading-"]');
  const optionLabel = option?.querySelector('[class*="label-"]');
  const button = document.querySelector('[class*="button-container-"], [class*="button-"]');
  const menuButton = document.querySelector('[class*="settings-content"] [class*="menu-"] [class*="button-"]');
  const toggle = document.querySelector('[class*="toggle-container"]');
  const toggleInner = toggle?.querySelector('[class*="toggle-"]');

  return {
    section: section?.className || '',
    label: section?.querySelector('[class*="label-"]')?.className || '',
    category: category?.className || '',
    categoryLabel: categoryLabel?.className || '',
    categoryHeading: categoryHeading?.className || '',
    categoryIcon: categoryIcon?.className || '',
    option: option?.className || '',
    optionContent: optionContent?.className || '',
    optionHeading: optionHeading?.className || '',
    optionLabel: optionLabel?.className || '',
    button: button?.className || '',
    menuButton: menuButton?.className || '',
    toggle: normalizeToggleClass(toggle?.className || ''),
    toggleInner: toggleInner?.className || '',
  };
}

function findReferenceSettingsSection() {
  const sections = document.querySelectorAll('[class*="sections-container"] > [class*="section-"]');
  for (const section of sections) {
    const label = section.querySelector(':scope > [class*="label-"]')?.textContent?.trim() || '';
    if (/player|wiedergabe|shortcut|tastenk|keyboard|general|allgemein/i.test(label)) {
      return section;
    }
  }
  return sections[0] || null;
}

function createSection(sectionId, title, classes) {
  const referenceSection = findReferenceSettingsSection();
  const section = document.createElement('div');
  section.id = sectionId;
  section.className = [referenceSection?.className || classes.section || '', 'stremio-custom-settings-block']
    .filter(Boolean)
    .join(' ');

  const referenceLabel = referenceSection?.querySelector(':scope > [class*="label-"]');
  const titleEl = referenceLabel ? referenceLabel.cloneNode(false) : document.createElement('div');
  if (!referenceLabel && classes.label) titleEl.className = classes.label;
  titleEl.textContent = title;
  section.appendChild(titleEl);

  return section;
}

function getPluginCategory(pluginFile, metadata) {
  if (metadata?.category) {
    return metadata.category.toLowerCase();
  }

  const folder = pluginFile.includes('/') ? pluginFile.split('/')[0] : '';
  return folder || 'utilities';
}

function getExpandedPluginFolders() {
  try {
    const stored = localStorage.getItem(PLUGIN_FOLDERS_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function setExpandedPluginFolders(folderIds) {
  localStorage.setItem(PLUGIN_FOLDERS_STORAGE_KEY, JSON.stringify(folderIds));
}

function getPluginBaseName(pluginFile) {
  return path.basename(pluginFile, FILE_EXTENSIONS.PLUGIN);
}

function getExpandedPluginSettings() {
  try {
    const stored = localStorage.getItem(PLUGIN_SETTINGS_EXPANDED_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function setPluginSettingsExpanded(pluginBaseName, expanded) {
  const next = getExpandedPluginSettings().filter((name) => name !== pluginBaseName);
  if (expanded) {
    next.push(pluginBaseName);
  }
  localStorage.setItem(PLUGIN_SETTINGS_EXPANDED_KEY, JSON.stringify(next));
}

function createPluginSettingsGear(pluginBaseName, panel) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'stremio-custom-plugin-settings-gear';
  button.title = 'Plugin settings';
  button.setAttribute('aria-label', 'Plugin settings');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97 0-.33-.03-.66-.07-1l2.11-1.63a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.03 7.03 0 0 0-1.73-1l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65c-.62.25-1.21.6-1.73 1l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64L4.57 11c-.04.34-.07.67-.07 1 0 .33.03.65.07.97l-2.11 1.66a.5.5 0 0 0-.12.64l2 3.46c.13.22.39.3.6.22l2.49-1.01c.52.48 1.11.85 1.73 1.01l.38 2.65c.05.24.24.41.5.41h4c.26 0 .45-.17.5-.42l.38-2.65c.62-.26 1.21-.63 1.73-1.01l2.49 1.01c.22.08.47 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.66Z"/></svg>';

  const flushPanelInputs = async () => {
    const rows = panel.querySelectorAll('.stremio-custom-setting-row');
    for (const row of rows) {
      const key = row.dataset.settingKey;
      const input = row.querySelector('.stremio-custom-setting-input');
      if (!key || !input) continue;
      const persist = input._stremioPersistInput;
      if (typeof persist === 'function') {
        await persist();
      } else {
        await savePluginSetting(pluginBaseName, key, input.value);
      }
    }
  };

  const isExpanded = getExpandedPluginSettings().includes(pluginBaseName);
  panel.hidden = !isExpanded;
  button.classList.toggle('active', isExpanded);
  button.setAttribute('aria-expanded', String(isExpanded));

  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const nextExpanded = panel.hidden;
    if (!nextExpanded) {
      await flushPanelInputs();
    }
    panel.hidden = !nextExpanded;
    button.classList.toggle('active', nextExpanded);
    button.setAttribute('aria-expanded', String(nextExpanded));
    setPluginSettingsExpanded(pluginBaseName, nextExpanded);
  });

  return button;
}

async function fetchPluginSchema(pluginBaseName) {
  const schema = await api.getRegisteredSettings(pluginBaseName);
  return Array.isArray(schema) && schema.length > 0 ? schema : null;
}

function resolvePluginSettingValue(config, field) {
  const stored = config?.[field.key];
  if (stored !== undefined && stored !== null) {
    return stored;
  }
  if (field.defaultValue !== undefined) {
    return field.defaultValue;
  }
  if (field.type === 'toggle') {
    return false;
  }
  return '';
}

async function fetchPluginConfig(pluginBaseName) {
  return api.getPluginConfig(pluginBaseName);
}

async function savePluginSetting(pluginBaseName, key, value) {
  await api.saveSetting(pluginBaseName, key, value);
}

function createPluginSettingField(pluginBaseName, field, classes, config) {
  const row = document.createElement('div');
  row.className = 'stremio-custom-setting-row';
  row.dataset.settingKey = field.key;

  const labelWrap = document.createElement('div');
  labelWrap.className = 'stremio-custom-setting-label';

  const labelText = document.createElement('div');
  labelText.textContent = field.label || field.key;
  labelWrap.appendChild(labelText);

  const fieldDescription = String(field.description || '');
  const lowerDescription = fieldDescription.toLowerCase();
  const links = [];
  if (pluginBaseName === 'data-enrichment' && lowerDescription.includes('themoviedb.org')) {
    links.push({ label: 'Open TMDB API page', url: 'https://www.themoviedb.org/settings/api' });
  }
  if (
    pluginBaseName === 'data-enrichment' &&
    (field.key === 'rpdbApiKey' ||
      lowerDescription.includes('ratingposterdb.com') ||
      lowerDescription.includes('rpdb'))
  ) {
    links.push({ label: 'Open RPDB API page', url: 'https://ratingposterdb.com' });
  }
  if (
    (pluginBaseName === 'tidb' && lowerDescription.includes('theintrodb.org')) ||
    (pluginBaseName === 'tidb' && field.key === 'tidb_api_key')
  ) {
    links.push({ label: 'Open TheIntroDB API page', url: 'https://theintrodb.org' });
  }

  if (fieldDescription || links.length) {
    const hint = document.createElement('div');
    hint.className = 'stremio-custom-setting-hint';
    hint.textContent = fieldDescription;
    if (links.length) {
      if (fieldDescription) hint.appendChild(document.createTextNode(' '));
      links.forEach((link, index) => {
        if (index > 0) hint.appendChild(document.createTextNode(' · '));
        const anchor = document.createElement('a');
        anchor.href = '#';
        anchor.textContent = link.label;
        anchor.style.color = 'var(--primary-accent-color, #7f5af0)';
        anchor.style.textDecoration = 'underline';
        anchor.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          api.openExternalUrl(link.url);
        });
        hint.appendChild(anchor);
      });
    }
    labelWrap.appendChild(hint);
  }

  row.appendChild(labelWrap);

  const control = document.createElement('div');
  control.className = 'stremio-custom-setting-control';

  const currentValue = resolvePluginSettingValue(config, field);

  if (field.type === 'toggle') {
    const toggle = createToggle(Boolean(currentValue), classes);
    toggle.addEventListener('click', async () => {
      const next = !toggle.classList.contains('checked');
      toggle.classList.toggle('checked', next);
      await savePluginSetting(pluginBaseName, field.key, next);
    });
    control.appendChild(toggle);
  } else if (field.type === 'input') {
    const input = document.createElement('input');
    input.type = field.inputType || 'text';
    input.className = 'stremio-custom-setting-input';
    input.value = currentValue ?? '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (field.placeholder) {
      input.placeholder = field.placeholder;
    }
    let lastPersisted = String(currentValue ?? '');
    const persistInput = async () => {
      const next = input.value;
      if (next === lastPersisted) return;
      await savePluginSetting(pluginBaseName, field.key, next);
      lastPersisted = next;
    };
    input._stremioPersistInput = persistInput;
    let inputTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => {
        persistInput();
      }, 350);
    });
    input.addEventListener('change', persistInput);
    control.appendChild(input);
  } else if (field.type === 'select' && Array.isArray(field.options)) {
    const select = document.createElement('select');
    select.className = 'stremio-custom-setting-select';
    for (const optionDef of field.options) {
      const option = document.createElement('option');
      option.value = optionDef.value;
      option.textContent = optionDef.label || optionDef.value;
      option.selected = String(optionDef.value) === String(currentValue);
      select.appendChild(option);
    }
    select.addEventListener('change', async () => {
      await savePluginSetting(pluginBaseName, field.key, select.value);
    });
    control.appendChild(select);
  }

  row.appendChild(control);
  return row;
}

async function createPluginSettingsPanel(pluginBaseName, schema, classes) {
  const panel = document.createElement('div');
  panel.className = 'stremio-custom-plugin-settings';
  const config = await fetchPluginConfig(pluginBaseName);

  for (const field of schema) {
    panel.appendChild(createPluginSettingField(pluginBaseName, field, classes, config));
  }

  return panel;
}

async function createPluginCategoryFolder(categoryId, title, entries, enabledPlugins, classes, onToggle) {
  const expandedFolders = getExpandedPluginFolders();
  const isExpanded = expandedFolders.includes(categoryId);
  const enabledCount = entries.filter(({ pluginFile }) =>
    isPluginEnabled(pluginFile, enabledPlugins)
  ).length;
  const summary =
    enabledCount === entries.length
      ? `${title} (${enabledCount}/${entries.length})`
      : `${title} (${enabledCount}/${entries.length})`;

  const { dropdown, panel } = createNativeDropdownShell(categoryId, title, summary);
  panel.classList.add('stremio-custom-plugin-panel');

  for (const { pluginFile, metadata } of entries) {
    const isEnabled = isPluginEnabled(pluginFile, enabledPlugins);
    const pluginBaseName = getPluginBaseName(pluginFile);
    const schema = await fetchPluginSchema(pluginBaseName);
    panel.appendChild(await createPluginOption(pluginFile, metadata, isEnabled, classes, onToggle, schema));
  }

  wireNativeDropdown(dropdown, categoryId, isExpanded);
  return dropdown;
}

function createThemeListFolder(folderId, title, themeEntries, currentTheme, classes, onSelect) {
  const expandedFolders = getExpandedPluginFolders();
  const isExpanded = expandedFolders.includes(folderId);
  const activeTheme =
    themeEntries.find(({ fileName }) =>
      fileName === 'Default'
        ? !currentTheme || currentTheme === 'Default'
        : currentTheme === fileName
    )?.metadata?.name || currentTheme || 'Default';

  const { dropdown, panel } = createNativeDropdownShell(folderId, title, activeTheme);

  for (const { fileName, metadata } of themeEntries) {
    const isActive =
      fileName === 'Default'
        ? !currentTheme || currentTheme === 'Default'
        : currentTheme === fileName;
    const wrapper = document.createElement('div');
    wrapper.className = 'stremio-custom-plugin-entry';
    wrapper.appendChild(createThemeOption(fileName, metadata, isActive, classes, onSelect));
    panel.appendChild(wrapper);
  }

  wireNativeDropdown(dropdown, folderId, isExpanded);
  return dropdown;
}

function createCategory(id, title, classes, withIcon = false) {
  const category = document.createElement('div');
  category.id = id;
  if (classes.category) category.className = classes.category;

  const heading = document.createElement('div');
  if (classes.categoryHeading) heading.className = classes.categoryHeading;

  if (withIcon) {
    const sampleIcon = document.querySelector('[class*="category-"] [class*="icon-"]');
    if (sampleIcon) {
      heading.appendChild(sampleIcon.cloneNode(true));
    }
  }

  const label = document.createElement('div');
  if (classes.categoryLabel) label.className = classes.categoryLabel;
  label.textContent = title;
  heading.appendChild(label);
  category.appendChild(heading);

  return category;
}

function createExternalUrlButton(label, url, classes) {
  const option = document.createElement('div');
  if (classes.option) option.className = classes.option;

  const content = document.createElement('div');
  if (classes.optionContent) content.className = classes.optionContent;

  const button = document.createElement('div');
  button.className = [classes.button, 'button'].filter(Boolean).join(' ');
  button.tabIndex = 0;
  button.textContent = label;
  button.addEventListener('click', () => api.openExternalUrl(url));
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      api.openExternalUrl(url);
    }
  });

  content.appendChild(button);
  option.appendChild(content);
  return option;
}

function createFolderButton(label, folderPath, classes) {
  const option = document.createElement('div');
  if (classes.option) option.className = classes.option;

  const content = document.createElement('div');
  if (classes.optionContent) content.className = classes.optionContent;

  const button = document.createElement('div');
  button.className = [classes.button, 'button'].filter(Boolean).join(' ');
  button.tabIndex = 0;
  button.textContent = label;
  button.addEventListener('click', () => api.openFolder(folderPath));

  content.appendChild(button);
  option.appendChild(content);
  return option;
}

function getToggleTemplate() {
  return (
    document.querySelector('#stremio-custom [class*="toggle-container"]') ||
    document.querySelector('[class*="settings-content"] [class*="toggle-container"]') ||
    document.querySelector('[class*="toggle-container"]')
  );
}

function setToggleChecked(toggle, checked) {
  if (!toggle) return;
  const on = Boolean(checked);
  toggle.classList.remove('checked');
  if (on) toggle.classList.add('checked');
  toggle.setAttribute('aria-checked', on ? 'true' : 'false');
}

function createToggle(checked, classes) {
  const template = getToggleTemplate();
  if (template) {
    const toggle = template.cloneNode(true);
    toggle.removeAttribute('name');
    setToggleChecked(toggle, checked);
    toggle.tabIndex = 0;
    return toggle;
  }

  const toggle = document.createElement('div');
  toggle.className = [classes.toggle, checked ? 'checked' : ''].filter(Boolean).join(' ');
  toggle.tabIndex = 0;

  const inner = document.createElement('div');
  if (classes.toggleInner) inner.className = classes.toggleInner;
  toggle.appendChild(inner);

  return toggle;
}

async function createPluginOption(fileName, metadata, enabled, classes, onToggle, schema) {
  const wrapper = document.createElement('div');
  wrapper.className = 'stremio-custom-plugin-entry';

  const option = document.createElement('div');
  if (classes.option) option.className = classes.option;
  option.setAttribute('name', `${fileName}-box`);
  option.dataset.pluginName = fileName;

  const heading = document.createElement('div');
  if (classes.optionHeading) heading.className = classes.optionHeading;

  const label = document.createElement('div');
  if (classes.optionLabel) label.className = classes.optionLabel;
  label.appendChild(createOptionLabel(metadata, fileName));
  heading.appendChild(label);

  const content = document.createElement('div');
  if (classes.optionContent) content.className = classes.optionContent;

  const controls = document.createElement('div');
  controls.className = 'stremio-custom-plugin-controls';

  const toggle = createToggle(enabled, classes);
  toggle.classList.add('plugin');
  toggle.setAttribute('name', fileName);
  toggle.addEventListener('click', () => onToggle(fileName, toggle));

  const pluginBaseName = getPluginBaseName(fileName);
  let settingsPanel = null;

  if (schema?.length) {
    settingsPanel = await createPluginSettingsPanel(pluginBaseName, schema, classes);
    controls.appendChild(createPluginSettingsGear(pluginBaseName, settingsPanel));
  }

  controls.appendChild(toggle);
  content.appendChild(controls);
  option.append(heading, content);
  wrapper.appendChild(option);

  if (settingsPanel) {
    wrapper.appendChild(settingsPanel);
  }

  return wrapper;
}

function createThemeOption(fileName, metadata, active, classes, onSelect) {
  const option = document.createElement('div');
  if (classes.option) option.className = classes.option;
  option.setAttribute('name', `${fileName}-box`);
  option.dataset.themeName = fileName;

  const heading = document.createElement('div');
  if (classes.optionHeading) heading.className = classes.optionHeading;

  const label = document.createElement('div');
  if (classes.optionLabel) label.className = classes.optionLabel;
  label.appendChild(createOptionLabel(metadata, fileName));
  heading.appendChild(label);

  const content = document.createElement('div');
  if (classes.optionContent) content.className = classes.optionContent;

  const toggle = createToggle(active, classes);
  toggle.classList.add('theme');
  toggle.setAttribute('name', fileName);
  toggle.addEventListener('click', () => onSelect(fileName));

  content.appendChild(toggle);
  option.append(heading, content);
  return option;
}

function updateThemeToggles(themesCategory, activeFileName) {
  themesCategory.querySelectorAll('[data-theme-name]').forEach((option) => {
    const themeName = option.dataset.themeName;
    const isActive =
      themeName === activeFileName ||
      (themeName === 'Default' && (activeFileName === 'Default' || !activeFileName));
    const toggle = option.querySelector('[class*="toggle-container"]');
    if (toggle) toggle.classList.toggle('checked', isActive);
  });
}

function findShortcutsSection(sectionsContainer) {
  const sections = sectionsContainer.querySelectorAll(':scope > [class*="section-"]');
  for (const section of sections) {
    const label = section.querySelector(':scope > [class*="label-"]')?.textContent?.trim() || '';
    if (/shortcut|tastenkürzel|tastenk|keyboard/i.test(label)) {
      return section;
    }
  }
  return null;
}

function findStreamingSection(sectionsContainer) {
  const sections = sectionsContainer.querySelectorAll(':scope > [class*="section-"]');
  for (const section of sections) {
    const label = section.querySelector(':scope > [class*="label-"]')?.textContent?.trim() || '';
    if (/^streaming$/i.test(label) || /streamen/i.test(label)) {
      return section;
    }
  }
  return null;
}

function getSelectedNavClass(menu) {
  return Array.from(menu.querySelectorAll('[class*="button-"]'))
    .flatMap((item) => Array.from(item.classList))
    .find((className) => className.startsWith('selected-'));
}

function findSettingsNavButton(menu, pattern) {
  return Array.from(menu.querySelectorAll('[class*="button-"]')).find((item) =>
    pattern.test(item.textContent || item.title || item.dataset.section || '')
  );
}

function createSettingsNavButton(menu, classes, sectionId, label) {
  const sample = menu.querySelector('[class*="button-"]:not([data-section^="stremio-custom"])');
  const button = sample ? sample.cloneNode(false) : document.createElement('div');
  if (!sample && classes.menuButton) button.className = classes.menuButton;
  const selectedClass = getSelectedNavClass(menu);
  if (selectedClass) button.classList.remove(selectedClass);
  button.textContent = label;
  button.title = label;
  button.dataset.section = sectionId;
  button.setAttribute('data-section', sectionId);
  button.tabIndex = 0;

  const scrollToSection = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const section = document.getElementById(sectionId);
    const container = section?.closest('[class*="sections-container"]');
    if (!section || !container) return;

    container.scrollTo({
      top: section.offsetTop - container.offsetTop,
      behavior: 'smooth',
    });

    const selectedClass = getSelectedNavClass(menu);
    if (selectedClass) {
      menu.querySelectorAll('[class*="button-"]').forEach((item) => item.classList.remove(selectedClass));
      button.classList.add(selectedClass);
    }
  };

  button.addEventListener('click', scrollToSection);
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      scrollToSection(event);
    }
  });

  return button;
}

function setupNavigationScrollSync(menu, selectedClass) {
  const container = document.querySelector('[class*="sections-container"]');
  if (!container || !selectedClass) return;

  if (container.dataset.scNavScrollSync === '1') return;
  container.dataset.scNavScrollSync = '1';

  const updateActiveNav = () => {
    const scrollMarker = container.scrollTop + 80;
    let activeId = null;

    for (const { id } of CUSTOM_NAV_SECTIONS) {
      const section = document.getElementById(id);
      if (!section) continue;
      const sectionTop = section.offsetTop - container.offsetTop;
      const sectionBottom = sectionTop + section.offsetHeight;
      if (scrollMarker >= sectionTop && scrollMarker < sectionBottom) {
        activeId = id;
        break;
      }
    }

    menu.querySelectorAll('[class*="button-"]').forEach((item) => {
      const isCustom = item.dataset.section?.startsWith('stremio-custom');
      if (!isCustom) return;
      item.classList.toggle(selectedClass, Boolean(activeId) && item.dataset.section === activeId);
    });
  };

  container.addEventListener('scroll', updateActiveNav, { passive: true });
}

function injectNavigation(classes) {
  const menu = document.querySelector('[class*="settings-content"] [class*="menu-"]');
  if (!menu) return false;

  menu.querySelectorAll('[data-section^="stremio-custom"]').forEach((button) => button.remove());

  const insertRef =
    findSettingsNavButton(menu, /shortcut|tastenkürzel|tastenk|keyboard/i) ||
    menu.querySelector('[class*="spacing"]');

  const buttons = CUSTOM_NAV_SECTIONS.map(({ id, label }) => {
    if (!document.getElementById(id)) return null;
    return createSettingsNavButton(menu, classes, id, label);
  }).filter(Boolean);

  for (const button of buttons) {
    if (insertRef) {
      menu.insertBefore(button, insertRef);
    } else {
      menu.appendChild(button);
    }
  }

  setupNavigationScrollSync(menu, getSelectedNavClass(menu));
  return buttons.length > 0;
}

function ensureSettingsUiVersion() {
  const section = document.getElementById(SECTION_ID);
  if (section && section.dataset.uiVersion !== SETTINGS_UI_VERSION) {
    section.remove();
  }

  if (document.getElementById(SECTION_ID)) return;

  document.getElementById('stremio-custom-preload')?.remove();
  document.getElementById('stremio-custom-stream-cache-option')?.remove();
  document.getElementById('stremio-custom-addon-block-section')?.remove();
  document.getElementById('stremio-custom-addon-block-category')?.remove();
  document
    .querySelectorAll('[data-section^="stremio-custom"]')
    .forEach((button) => button.remove());
  const container = document.querySelector('[class*="sections-container"]');
  if (container) delete container.dataset.scNavScrollSync;
}

function removeLegacyCustomStreamingCategory() {
  document.getElementById('stremio-custom-streaming')?.remove();
}

function injectStreamingRestartOption(classes) {
  if (document.getElementById(STREAMING_RESTART_ID)) return true;

  const sectionsContainer = document.querySelector('[class*="sections-container"]');
  const streamingSection = findStreamingSection(sectionsContainer);
  if (!streamingSection || !classes.option) return false;

  const wrapper = document.createElement('div');
  wrapper.id = STREAMING_RESTART_ID;

  const option = document.createElement('div');
  if (classes.option) option.className = classes.option;

  const heading = document.createElement('div');
  if (classes.optionHeading) heading.className = classes.optionHeading;

  const label = document.createElement('div');
  if (classes.optionLabel) label.className = classes.optionLabel;
  label.textContent = 'Restart streaming server';
  heading.appendChild(label);

  const content = document.createElement('div');
  if (classes.optionContent) content.className = classes.optionContent;

  const button = document.createElement('div');
  button.className = [classes.button, 'button'].filter(Boolean).join(' ');
  button.tabIndex = 0;
  button.textContent = 'Restart';
  button.addEventListener('click', async () => {
    button.textContent = 'Restarting…';
    button.textContent = 'Restart not available in shell build';
  });

  content.appendChild(button);
  option.append(heading, content);
  wrapper.appendChild(option);

  const hint = document.createElement('div');
  hint.className = 'stremio-custom-hint';
  hint.textContent =
    'Startet den gebündelten Stremio Service mit FFmpeg neu (FFMPEG_BIN / FFPROBE_BIN).';
  wrapper.appendChild(hint);

  streamingSection.appendChild(wrapper);
  return true;
}

function showReloadHint(category, message) {
  let hint = category.querySelector('[data-reload-hint]');
  if (!hint) {
    hint = document.createElement('div');
    hint.dataset.reloadHint = 'true';
    hint.style.cssText = 'padding: 0.75rem 1rem; color: #ffb347; font-size: 0.9em;';
    category.appendChild(hint);
  }

  hint.innerHTML = `${message} <a href="#" style="color: var(--primary-accent-color); font-weight: 600;">Reload (Ctrl+R)</a>.`;
  hint.querySelector('a')?.addEventListener('click', (event) => {
    event.preventDefault();
    location.reload();
  });
}

let glassSelectCloseHandlerInstalled = false;

function createGlassSelect({ id, options, currentValue, onChange }) {
  const wrap = document.createElement('div');
  wrap.className = 'stremio-custom-glass-select';
  if (id) wrap.id = id;

  const selected =
    options.find((option) => String(option.value) === String(currentValue)) || options[0] || null;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'stremio-custom-glass-select-trigger';
  trigger.textContent = selected?.label || 'Select…';

  const dropdown = document.createElement('div');
  dropdown.className = 'stremio-custom-glass-select-dropdown';
  dropdown.hidden = true;

  const close = () => {
    dropdown.hidden = true;
    wrap.classList.remove('active');
  };

  for (const option of options) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'stremio-custom-glass-select-option';
    if (String(option.value) === String(currentValue)) item.classList.add('selected');
    item.textContent = option.label;
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      trigger.textContent = option.label;
      dropdown.querySelectorAll('.stremio-custom-glass-select-option.selected').forEach((el) => {
        el.classList.remove('selected');
      });
      item.classList.add('selected');
      close();
      onChange(option);
    });
    dropdown.appendChild(item);
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = dropdown.hidden;
    document.querySelectorAll('.stremio-custom-glass-select.active').forEach((picker) => {
      if (picker === wrap) return;
      picker.classList.remove('active');
      const panel = picker.querySelector('.stremio-custom-glass-select-dropdown');
      if (panel) panel.hidden = true;
    });
    dropdown.hidden = !willOpen;
    wrap.classList.toggle('active', willOpen);
  });

  if (!glassSelectCloseHandlerInstalled) {
    glassSelectCloseHandlerInstalled = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('.stremio-custom-glass-select.active').forEach((picker) => {
        picker.classList.remove('active');
        const panel = picker.querySelector('.stremio-custom-glass-select-dropdown');
        if (panel) panel.hidden = true;
      });
    });
  }

  wrap.append(trigger, dropdown);
  return wrap;
}

function createThemedSelect({ id, options, currentValue, onChange }) {
  const wrap = document.createElement('div');
  wrap.className = 'stremio-custom-themed-select';
  if (id) wrap.id = id;

  const selected =
    options.find((option) => String(option.value) === String(currentValue)) || options[0] || null;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'stremio-custom-themed-select-trigger';
  trigger.setAttribute('aria-expanded', 'false');

  const valueLabel = document.createElement('span');
  valueLabel.className = 'stremio-custom-themed-select-value';
  valueLabel.textContent = selected?.label || 'Select…';

  trigger.append(valueLabel, createNativeDropdownCaret());

  const menu = document.createElement('div');
  menu.className = 'stremio-custom-themed-select-menu';
  menu.hidden = true;

  const positionMenu = () => {
    const rect = trigger.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.width = `${Math.max(rect.width, 192)}px`;
  };

  const close = () => {
    menu.hidden = true;
    wrap.classList.remove('active');
    if (menu.parentElement === document.body) {
      document.body.removeChild(menu);
    }
  };

  const open = () => {
    document.querySelectorAll('.stremio-custom-themed-select.active').forEach((picker) => {
      if (picker === wrap) return;
      picker.classList.remove('active');
      const panel = picker._selectMenu;
      if (panel) panel.hidden = true;
    });
    if (!menu.parentElement) document.body.appendChild(menu);
    positionMenu();
    menu.hidden = false;
    wrap.classList.add('active');
  };

  for (const option of options) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'stremio-custom-themed-select-option';
    if (String(option.value) === String(currentValue)) item.classList.add('selected');
    item.textContent = option.label;
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      valueLabel.textContent = option.label;
      menu.querySelectorAll('.stremio-custom-themed-select-option.selected').forEach((el) => {
        el.classList.remove('selected');
      });
      item.classList.add('selected');
      close();
      onChange(option);
    });
    menu.appendChild(item);
  }

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (menu.hidden) open();
    else close();
  });

  if (!window.__stremioCustomThemedSelectClose) {
    window.__stremioCustomThemedSelectClose = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('.stremio-custom-themed-select.active').forEach((picker) => {
        picker.classList.remove('active');
        const panel = picker._selectMenu;
        if (panel) {
          panel.hidden = true;
          if (panel.parentElement === document.body) document.body.removeChild(panel);
        }
      });
    });
    window.addEventListener('resize', () => {
      document.querySelectorAll('.stremio-custom-themed-select.active').forEach((picker) => {
        const panel = picker._selectMenu;
        const triggerEl = picker.querySelector('.stremio-custom-themed-select-trigger');
        if (!panel || panel.hidden || !triggerEl) return;
        const rect = triggerEl.getBoundingClientRect();
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.bottom + 6}px`;
        panel.style.width = `${Math.max(rect.width, 192)}px`;
      });
    });
  }

  wrap._selectMenu = menu;
  wrap.appendChild(trigger);
  return wrap;
}

function createLocalToggleOption(id, title, description, storageKey, classes, onChange) {
  const option = document.createElement('div');
  if (classes.option) option.className = classes.option;
  option.id = id;

  const heading = document.createElement('div');
  if (classes.optionHeading) heading.className = classes.optionHeading;

  const label = document.createElement('div');
  if (classes.optionLabel) label.className = classes.optionLabel;
  label.textContent = title;
  heading.appendChild(label);

  if (description) {
    const hint = document.createElement('div');
    hint.className = 'stremio-custom-section-hint';
    hint.textContent = description;
    heading.appendChild(hint);
  }

  const content = document.createElement('div');
  if (classes.optionContent) content.className = classes.optionContent;

  let enabled = false;
  try {
    enabled = localStorage.getItem(storageKey) === 'true';
  } catch (_) {}

  const toggle = createToggle(enabled, classes);
  toggle.addEventListener('click', () => {
    enabled = !enabled;
    try {
      localStorage.setItem(storageKey, enabled ? 'true' : 'false');
    } catch (_) {}
    toggle.classList.toggle('checked', enabled);
    onChange?.(enabled);
    persistUserPreferences?.();
  });

  content.appendChild(toggle);
  option.append(heading, content);
  return option;
}

function getDiscordSummary() {
  const keys = window.StremioCustomDiscordPresence?.KEYS || {
    ENABLED: 'stremio-custom-discord-rp-enabled',
    SHOW_PAUSED: 'stremio-custom-discord-rp-show-paused',
    SHOW_MENU: 'stremio-custom-discord-rp-show-menu',
  };
  let enabled = false;
  let paused = false;
  let menu = false;
  try {
    enabled = localStorage.getItem(keys.ENABLED) === 'true';
    paused = localStorage.getItem(keys.SHOW_PAUSED) === 'true';
    menu = localStorage.getItem(keys.SHOW_MENU) === 'true';
  } catch (_) {}
  if (!enabled) return 'Off';
  const parts = [];
  if (paused) parts.push('Paused');
  if (menu) parts.push('Browsing');
  return parts.length ? `On · ${parts.join(' · ')}` : 'On';
}

function updateDiscordDropdownSummary(dropdown) {
  const value = dropdown?.querySelector('.stremio-custom-native-dropdown-value');
  if (value) value.textContent = getDiscordSummary();
}

function createPanelToggleEntry(id, title, description, storageKey, classes, onChange) {
  const wrapper = document.createElement('div');
  wrapper.className = 'stremio-custom-plugin-entry';

  const option = document.createElement('div');
  if (classes.option) option.className = classes.option;
  option.id = id;

  const heading = document.createElement('div');
  if (classes.optionHeading) heading.className = classes.optionHeading;

  const label = document.createElement('div');
  if (classes.optionLabel) label.className = classes.optionLabel;
  label.appendChild(
    createOptionLabel(
      { name: title, description, version: '', author: '' },
      title
    )
  );
  heading.appendChild(label);

  const content = document.createElement('div');
  if (classes.optionContent) content.className = classes.optionContent;

  let enabled = false;
  try {
    enabled = localStorage.getItem(storageKey) === 'true';
  } catch (_) {}

  const toggle = createToggle(enabled, classes);
  toggle.addEventListener('click', () => {
    enabled = !enabled;
    try {
      localStorage.setItem(storageKey, enabled ? 'true' : 'false');
    } catch (_) {}
    toggle.classList.toggle('checked', enabled);
    onChange?.(enabled);
    persistUserPreferences?.();
  });

  content.appendChild(toggle);
  option.append(heading, content);
  wrapper.appendChild(option);
  return wrapper;
}

function createDiscordPresenceCategory(classes) {
  const category = createCategory(DISCORD_CATEGORY_ID, 'Discord Rich Presence', classes, true);
  const expandedFolders = getExpandedPluginFolders();
  const isExpanded = expandedFolders.includes(DISCORD_FOLDER_ID);
  const { dropdown, panel } = createNativeDropdownShell(
    DISCORD_FOLDER_ID,
    'Discord Rich Presence',
    getDiscordSummary()
  );

  const keys = window.StremioCustomDiscordPresence?.KEYS || {
    ENABLED: 'stremio-custom-discord-rp-enabled',
    SHOW_PAUSED: 'stremio-custom-discord-rp-show-paused',
    SHOW_MENU: 'stremio-custom-discord-rp-show-menu',
  };

  const refreshSummary = () => updateDiscordDropdownSummary(dropdown);

  panel.appendChild(
    createPanelToggleEntry(
      'stremio-custom-discord-enabled',
      'Enable Discord Rich Presence',
      'Shows what you are watching in Discord. Requires Discord Desktop to be running.',
      keys.ENABLED,
      classes,
      (enabled) => {
        if (enabled) window.StremioCustomDiscordPresence?.startPolling?.();
        else window.StremioCustomDiscordPresence?.clearPresence?.();
        refreshSummary();
      }
    )
  );

  panel.appendChild(
    createPanelToggleEntry(
      'stremio-custom-discord-paused',
      'Show paused state',
      'Display when playback is paused.',
      keys.SHOW_PAUSED,
      classes,
      refreshSummary
    )
  );

  panel.appendChild(
    createPanelToggleEntry(
      'stremio-custom-discord-menu',
      'Show browsing state',
      'Display activity while browsing menus outside the player.',
      keys.SHOW_MENU,
      classes,
      refreshSummary
    )
  );

  wireNativeDropdown(dropdown, DISCORD_FOLDER_ID, isExpanded);
  category.appendChild(dropdown);
  return category;
}

function createPreloadOption(classes) {
  const option = document.createElement('div');
  if (classes.option) {
    option.className = `${classes.option} stremio-custom-full-width-option stremio-custom-preload-option`;
  }
  option.id = 'stremio-custom-preload-option';

  const heading = document.createElement('div');
  if (classes.optionHeading) heading.className = classes.optionHeading;

  const copy = document.createElement('div');
  copy.className = 'stremio-custom-preload-copy';

  const label = document.createElement('div');
  if (classes.optionLabel) label.className = classes.optionLabel;
  label.textContent = 'Buffer ahead';
  copy.appendChild(label);

  const description = document.createElement('div');
  description.className = 'stremio-custom-preload-description';
  description.textContent =
    'How many seconds MPV buffers ahead of the playhead. Full buffers the entire stream (uses more RAM and disk cache).';
  copy.appendChild(description);
  heading.appendChild(copy);

  const content = document.createElement('div');
  if (classes.optionContent) content.className = classes.optionContent;

  const controls = document.createElement('div');
  controls.className = 'stremio-custom-preload-controls';

  const options = [
    { value: '60', label: 'Standard (60s)' },
    { value: '120', label: 'Extended (120s)' },
    { value: '180', label: 'Extreme (180s)' },
    { value: '600', label: 'Maximum (600s)' },
    { value: 'full', label: 'Full (entire stream)' },
  ];
  let current = '120';
  try {
    current = localStorage.getItem(PRELOAD_SECS_KEY) || '120';
  } catch (_) {}

  const picker = createThemedSelect({
    id: 'stremio-custom-preload-picker',
    options,
    currentValue: current,
    onChange: (entry) => {
      try {
        localStorage.setItem(PRELOAD_SECS_KEY, entry.value);
      } catch (_) {}
      window.StremioCustomPlayback?.applyPreloadSettings?.();
      document.dispatchEvent(new CustomEvent('stremio-custom-preload-changed', { detail: entry }));
      persistUserPreferences?.();
    },
  });

  const actions = document.createElement('div');
  actions.className = 'stremio-custom-preload-actions';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.id = CLEAR_STREAM_CACHE_BTN_ID;
  clearBtn.className = 'stremio-custom-clear-stream-cache-btn';
  clearBtn.textContent = 'Clear stream cache';
  clearBtn.addEventListener('click', async () => {
    if (clearBtn.disabled) return;
    clearBtn.disabled = true;
    clearBtn.textContent = 'Clearing…';
    try {
      await window.StremioCustomStreamCache?.clearStreamCache?.();
      clearBtn.textContent = 'Stream cache cleared';
      window.setTimeout(() => {
        clearBtn.textContent = 'Clear stream cache';
        clearBtn.disabled = false;
      }, 1800);
    } catch (_) {
      clearBtn.textContent = 'Clear failed';
      window.setTimeout(() => {
        clearBtn.textContent = 'Clear stream cache';
        clearBtn.disabled = false;
      }, 1800);
    }
  });

  const clearHint = document.createElement('div');
  clearHint.className = 'stremio-custom-stream-cache-hint';
  clearHint.textContent =
    'Clears Stremio streaming server cache (torrent data on disk). Does not affect MPV buffer.';

  actions.append(clearBtn, clearHint);
  controls.append(picker, actions);
  content.appendChild(controls);
  option.append(heading, content);
  return option;
}

function normalizeLibraryFolders(foldersRaw) {
  let parsed = [];
  try {
    const value = typeof foldersRaw === 'string' ? JSON.parse(foldersRaw) : foldersRaw;
    parsed = Array.isArray(value) ? value : [];
  } catch (_) {
    parsed = [];
  }

  return parsed
    .map((folder) => {
      const id = String(folder?.id || '').trim();
      const name = String(folder?.name || '').trim();
      if (!id || !name) return null;
      const items = Array.isArray(folder?.items)
        ? folder.items.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      return { id, name, items };
    })
    .filter(Boolean);
}

function buildLibraryBackupPayload() {
  const library = getLibraryPreferences?.() || {
    foldersRaw: localStorage.getItem('stremio-custom-library-folders') || '[]',
    activeFolderId: localStorage.getItem('stremio-custom-library-active-folder') || '',
  };
  const folders = normalizeLibraryFolders(library.foldersRaw);
  const activeFolderId = folders.some((folder) => folder.id === library.activeFolderId)
    ? library.activeFolderId
    : '';
  return {
    type: 'mystremio-library-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    library: {
      foldersRaw: JSON.stringify(folders),
      activeFolderId,
    },
  };
}

function parseImportedLibraryPayload(rawText) {
  const parsed = JSON.parse(rawText);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON backup');
  const source = parsed.library && typeof parsed.library === 'object' ? parsed.library : parsed;
  const folders = normalizeLibraryFolders(source.foldersRaw ?? source.folders ?? source);
  if (!folders.length && parsed.type !== 'mystremio-library-backup') {
    throw new Error('No library data found');
  }
  const activeFolderId = folders.some((folder) => folder.id === source.activeFolderId)
    ? source.activeFolderId
    : '';
  return {
    foldersRaw: JSON.stringify(folders),
    activeFolderId,
  };
}

function createLibraryBackupOption(classes) {
  const option = document.createElement('div');
  if (classes.option) {
    option.className = `${classes.option} stremio-custom-full-width-option stremio-custom-preload-option`;
  }
  option.id = 'stremio-custom-library-backup-option';

  const heading = document.createElement('div');
  if (classes.optionHeading) heading.className = classes.optionHeading;

  const copy = document.createElement('div');
  copy.className = 'stremio-custom-preload-copy';

  const label = document.createElement('div');
  if (classes.optionLabel) label.className = classes.optionLabel;
  label.textContent = 'Library backup';
  copy.appendChild(label);

  const description = document.createElement('div');
  description.className = 'stremio-custom-preload-description';
  description.textContent =
    'Export and import your custom library folders as JSON for reliable migration across devices.';
  copy.appendChild(description);
  heading.appendChild(copy);

  const content = document.createElement('div');
  if (classes.optionContent) content.className = classes.optionContent;

  const controls = document.createElement('div');
  controls.className = 'stremio-custom-preload-controls';

  const actions = document.createElement('div');
  actions.className = 'stremio-custom-preload-actions';

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.id = EXPORT_LIBRARY_BTN_ID;
  exportBtn.className = 'stremio-custom-clear-stream-cache-btn';
  exportBtn.textContent = 'Export library JSON';
  exportBtn.addEventListener('click', () => {
    try {
      const payload = buildLibraryBackupPayload();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      link.href = url;
      link.download = `mystremio-library-${stamp}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      exportBtn.textContent = 'Exported';
      window.setTimeout(() => {
        exportBtn.textContent = 'Export library JSON';
      }, 1400);
    } catch (_) {
      exportBtn.textContent = 'Export failed';
      window.setTimeout(() => {
        exportBtn.textContent = 'Export library JSON';
      }, 1600);
    }
  });

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.id = IMPORT_LIBRARY_BTN_ID;
  importBtn.className = 'stremio-custom-clear-stream-cache-btn';
  importBtn.textContent = 'Import library JSON';
  importBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = parseImportedLibraryPayload(String(reader.result || ''));
          applyLibraryPreferences?.(parsed);
          persistUserPreferences?.();
          window.dispatchEvent(new CustomEvent('stremio-custom-library-imported'));
          importBtn.textContent = 'Imported';
        } catch (_) {
          importBtn.textContent = 'Import failed';
        } finally {
          window.setTimeout(() => {
            importBtn.textContent = 'Import library JSON';
            importBtn.disabled = false;
          }, 1800);
        }
      };
      reader.onerror = () => {
        importBtn.textContent = 'Import failed';
        window.setTimeout(() => {
          importBtn.textContent = 'Import library JSON';
          importBtn.disabled = false;
        }, 1800);
      };
      reader.readAsText(file);
    });
    input.click();
  });

  const hint = document.createElement('div');
  hint.className = 'stremio-custom-stream-cache-hint';
  hint.textContent = 'Import overwrites current custom folders. Export first to keep a rollback copy.';

  actions.append(exportBtn, importBtn, hint);
  controls.append(actions);
  content.appendChild(controls);
  option.append(heading, content);
  return option;
}

async function buildSettingsSection(pluginApi) {
  if (
    document.getElementById(SECTION_ID) &&
    document.getElementById(PRELOAD_CATEGORY_ID) &&
    document.getElementById(LIBRARY_BACKUP_CATEGORY_ID) &&
    document.getElementById(CLEAR_STREAM_CACHE_BTN_ID)
  ) {
    return true;
  }

  const paths = await api.getPaths();
  PLUGINS_PATH = paths?.pluginsPath || '';
  THEMES_PATH = paths?.themesPath || '';

  const sectionsContainer = document.querySelector('[class*="sections-container"]');
  if (!sectionsContainer || !sectionsContainer.closest('[class*="settings-content"]')) {
    return false;
  }

  const classes = getStremioClasses();
  if (!classes.section || !classes.category || !classes.option) {
    console.warn('[StremioCustom] Could not detect Stremio settings classes yet.');
    return false;
  }

  ensureSettingsStyles();

  const section = createSection(SECTION_ID, 'Custom', classes);
  section.dataset.uiVersion = SETTINGS_UI_VERSION;
  const themesCategory = createCategory(THEMES_CATEGORY_ID, 'Themes', classes, true);
  const pluginsCategory = createCategory(PLUGINS_CATEGORY_ID, 'Plugins', classes, true);
  let currentTheme = getCurrentTheme();
  const enabledPlugins = getEnabledPlugins();

  const selectTheme = (fileName) => {
    currentTheme = fileName === 'Default' ? '' : fileName;
    setCurrentTheme(currentTheme);
    applyTheme(currentTheme);
    updateThemeToggles(themesCategory, fileName);
  };

  const themeEntries = [
    {
      fileName: 'Default',
      metadata: {
        name: 'Default',
        description: 'Original Stremio interface without custom CSS',
        version: '',
        author: '',
      },
    },
  ];

  const themeFiles = await listThemes();
  if (!themeFiles.length) {
    console.warn('[StremioCustom] No themes found in', THEMES_PATH);
  }

  for (const themeFile of themeFiles) {
    const metadata = await extractMetadata(themeFile);
    if (!metadata) continue;
    themeEntries.push({ fileName: themeFile, metadata });
  }

  themesCategory.appendChild(
    createThemeListFolder(
      THEMES_FOLDER_ID,
      'Installed themes',
      themeEntries,
      currentTheme,
      classes,
      selectTheme
    )
  );

  themesCategory.appendChild(createFolderButton('Open themes folder', THEMES_PATH, classes));

  const togglePlugin = (fileName, toggle) => {
    const enabled = getEnabledPlugins();
    const isEnabled = enabled.includes(fileName);

    if (isEnabled) {
      setEnabledPlugins(enabled.filter((name) => name !== fileName));
      toggle.classList.remove('checked');
      pluginApi.unloadPlugin(fileName);
      showReloadHint(pluginsCategory, 'Plugin disabled — reload the app (Ctrl+R).');
    } else {
      enabled.push(fileName);
      setEnabledPlugins(enabled);
      toggle.classList.add('checked');
      pluginApi.loadPlugin(fileName);
      showReloadHint(
        pluginsCategory,
        'Plugin enabled — reload the app (Ctrl+R) for full effect.'
      );
    }
  };

  const pluginsByCategory = {};
  const pluginFiles = await listPlugins();
  if (!pluginFiles.length) {
    console.warn('[StremioCustom] No plugins found in', PLUGINS_PATH);
  }

  for (const pluginFile of pluginFiles) {
    const metadata = await extractMetadata(pluginFile);
    if (!metadata) continue;

    const category = getPluginCategory(pluginFile, metadata);
    if (!pluginsByCategory[category]) {
      pluginsByCategory[category] = [];
    }
    pluginsByCategory[category].push({ pluginFile, metadata });
  }

  for (const { id, label } of PLUGIN_CATEGORY_ORDER) {
    const entries = pluginsByCategory[id];
    if (!entries?.length) continue;

    pluginsCategory.appendChild(
      await createPluginCategoryFolder(id, label, entries, enabledPlugins, classes, togglePlugin)
    );
  }

  pluginsCategory.appendChild(createFolderButton('Open plugins folder', PLUGINS_PATH, classes));

  const preloadCategory = createCategory(PRELOAD_CATEGORY_ID, 'Preload', classes, true);
  preloadCategory.appendChild(createPreloadOption(classes));

  const libraryBackupCategory = createCategory(LIBRARY_BACKUP_CATEGORY_ID, 'Library', classes, true);
  libraryBackupCategory.appendChild(createLibraryBackupOption(classes));

  const discordCategory = createDiscordPresenceCategory(classes);

  section.append(themesCategory, pluginsCategory, preloadCategory, libraryBackupCategory, discordCategory);

  const shortcutsSection = findShortcutsSection(sectionsContainer);
  if (shortcutsSection) {
    sectionsContainer.insertBefore(section, shortcutsSection);
  } else {
    sectionsContainer.appendChild(section);
  }

  injectNavigation(classes);
  closeAllNativeDropdowns();

  console.info('[StremioCustom] Settings UI injected into Stremio settings.');
  return true;
}

function ensurePlayerLanguageSettings(classes) {
  tryInjectPlayerLanguageSettings(classes);
}

async function checkSettings(pluginApi) {
  if (!isOnSettingsPage()) return;

  removeLegacyQuickSettingsSection();

  const classes = getStremioClasses();
  ensurePlayerLanguageSettings(classes);
  tryInjectAutoskipSettings(classes);

  if (injectionInProgress) return;

  injectionInProgress = true;

  try {
    await waitForSettingsContainer(20000);
    ensureSettingsUiVersion();

    if (
      !document.getElementById(SECTION_ID) ||
      !document.getElementById(PRELOAD_CATEGORY_ID) ||
      !document.getElementById(LIBRARY_BACKUP_CATEGORY_ID) ||
      !document.getElementById(CLEAR_STREAM_CACHE_BTN_ID)
    ) {
      const success = await buildSettingsSection(pluginApi);
      if (!success) {
        console.warn('[StremioCustom] Settings container found, but UI build failed. Retrying...');
      }
    } else {
      removeLegacyCustomStreamingCategory();
      injectNavigation(getStremioClasses());
    }

    ensurePlayerLanguageSettings(getStremioClasses());
    tryInjectAutoskipSettings(getStremioClasses());
    window.StremioCustom?.helpers?.refreshAutoskipToggles?.();
  } catch (error) {
    console.warn('[StremioCustom] Settings UI could not be injected:', error.message);
  } finally {
    injectionInProgress = false;
  }
}

let watcherStarted = false;
let settingsCheckTimer = null;

function startSettingsWatcher(pluginApi) {
  if (watcherStarted) return;
  watcherStarted = true;

  const scheduleCheck = () => {
    if (typeof window.stremioCustomSuspendBackground === 'function' && window.stremioCustomSuspendBackground()) {
      return;
    }
    if (!isOnSettingsPage()) return;
    if (settingsCheckTimer) return;
    settingsCheckTimer = setTimeout(() => {
      settingsCheckTimer = null;
      checkSettings(pluginApi);
    }, 300);
  };

  window.addEventListener('hashchange', scheduleCheck);

  const observer = new MutationObserver(() => {
    if (typeof window.stremioCustomSuspendBackground === 'function' && window.stremioCustomSuspendBackground()) {
      return;
    }
    if (!isOnSettingsPage()) return;
    if (
      !document.getElementById(SECTION_ID) ||
      !document.getElementById(PRELOAD_CATEGORY_ID) ||
      !document.getElementById(LIBRARY_BACKUP_CATEGORY_ID) ||
      !document.getElementById(CLEAR_STREAM_CACHE_BTN_ID) ||
      !isCustomSettingsComplete()
    ) {
      scheduleCheck();
    }
  });

  const observeTarget = () => {
    const root = document.body || document.documentElement;
    if (!root) {
      setTimeout(observeTarget, 100);
      return;
    }
    observer.observe(root, { childList: true, subtree: true });
  };
  observeTarget();

  const poll = setInterval(() => {
    if (typeof window.stremioCustomSuspendBackground === 'function' && window.stremioCustomSuspendBackground()) {
      return;
    }
    if (!isOnSettingsPage()) return;
    if (!document.getElementById(SECTION_ID) || !isCustomSettingsComplete()) {
      scheduleCheck();
    }
  }, 1500);

  window.addEventListener('beforeunload', () => {
    observer.disconnect();
    clearInterval(poll);
  });
}

window.StremioCustomSettings = { checkSettings, startSettingsWatcher };
})();
