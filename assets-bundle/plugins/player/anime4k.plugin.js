/**
 * @name Anime4K
 * @description Upscale anime with Anime4K GLSL shaders (mpv gpu-next). Mode via player control-bar button.
 * @version 1.3.0
 * @author bloc97; adapted by MyStremio
 * @credit Shaders by bloc97/Anime4K (https://github.com/bloc97/Anime4K)
 * @category player
 */
/* jshint esversion: 11, browser: true, devel: true */

(function () {
  'use strict';

  const PLUGIN_VERSION = '1.3.0';
  const PLUGIN_ID = 'anime4k';
  const PLUGIN_REF = 'player/anime4k.plugin.js';
  const LOG_PREFIX = '[Anime4K]';

  if (window.__stremioAnime4kPluginReady === PLUGIN_VERSION) return;

  const MODE_SETTING = 'mode';
  const QUALITY_SETTING = 'quality';
  const DEFAULT_QUALITY = 'L';
  const BTN_ID = 'mystremio-anime4k-btn';
  const PANEL_ID = 'mystremio-anime4k-panel';
  const PLAYER_STYLE_ID = 'mystremio-anime4k-player-styles';
  const PLAYER_CHIPS_ID = 'mystremio-anime4k-player-chips';
  const OVERLAY_LOCK_CLASS = 'mystremio-anime4k-overlay-lock';
  const CONTRIBUTE_BTN_ID = 'tidb-contribute-btn';
  const CAST_BTN_ID = 'mystremio-cast-overlay-btn';
  const ICON_SIZE = '2.0rem';
  const PANEL_VERSION = '2';

  /**
   * Mode → relative shader filenames (CNN quality suffixes rewritten at apply time).
   * @type {Record<string, string[]>}
   */
  const MODE_SHADERS = {
    Off: [],
    A: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_L.glsl',
      'Anime4K_Upscale_CNN_x2_L.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ],
    B: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_Soft_L.glsl',
      'Anime4K_Upscale_CNN_x2_L.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ],
    C: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Upscale_Denoise_CNN_x2_L.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ],
    'A+A': [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_L.glsl',
      'Anime4K_Upscale_CNN_x2_L.glsl',
      'Anime4K_Restore_CNN_M.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ],
    'B+B': [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_Soft_L.glsl',
      'Anime4K_Upscale_CNN_x2_L.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Restore_CNN_Soft_M.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ],
    'C+A': [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Upscale_Denoise_CNN_x2_L.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Restore_CNN_M.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ],
  };

  const MODE_OPTIONS = Object.keys(MODE_SHADERS).map((value) => ({
    value,
    label: value === 'Off' ? 'Off' : value,
  }));

  /** @type {{ value: string, label: string }[]} */
  const QUALITY_OPTIONS = [
    { value: 'S', label: 'S (fastest)' },
    { value: 'M', label: 'M' },
    { value: 'L', label: 'L (default)' },
    { value: 'VL', label: 'VL' },
    { value: 'UL', label: 'UL (heaviest)' },
  ];

  const QUALITY_VALUES = new Set(QUALITY_OPTIONS.map((entry) => entry.value));

  let shellMsgId = 16000;
  let mode = 'Off';
  let quality = DEFAULT_QUALITY;
  let shadersDir = '';
  let applyTimer = null;
  let suspended = false;
  let panelOpen = false;
  let outsideHandler = null;
  let keyHandler = null;
  let ensureTimer = null;
  let layoutObserver = null;
  let overlayObserver = null;
  let chromeIdleWatcher = null;
  let dismissGuardUntil = 0;
  let retryTimer = null;

  /**
   * @returns {boolean}
   */
  function isOverlayHidden() {
    const el = document.querySelector('[class*="player-container"]');
    if (!el) return false;
    for (const className of el.classList) {
      if (String(className).includes('overlayHidden')) return true;
    }
    return false;
  }

  /**
   * @returns {boolean}
   */
  function isPluginEnabled() {
    const helpers = window.StremioCustom?.helpers;
    if (!helpers?.isPluginEnabled) return false;
    return helpers.isPluginEnabled(PLUGIN_REF);
  }

  /**
   * @returns {boolean}
   */
  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  /**
   * @returns {object|null}
   */
  function getSettingsApi() {
    return window.StremioCustomAPI || window.StremioEnhancedAPI || null;
  }

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function normalizeMode(value) {
    const raw = String(value == null ? '' : value).trim();
    if (Object.prototype.hasOwnProperty.call(MODE_SHADERS, raw)) return raw;
    return 'Off';
  }

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function normalizeQuality(value) {
    const raw = String(value == null ? '' : value)
      .trim()
      .toUpperCase();
    if (QUALITY_VALUES.has(raw)) return raw;
    return DEFAULT_QUALITY;
  }

  /**
   * Rewrite CNN quality suffixes (_S/_M/_L/_VL/_UL) to the selected quality.
   *
   * @param {string} modeKey
   * @param {string} qualityKey
   * @returns {string[]}
   */
  function shadersForMode(modeKey, qualityKey) {
    const files = MODE_SHADERS[modeKey] || [];
    const q = normalizeQuality(qualityKey);
    return files.map((name) => name.replace(/_(S|M|VL|UL|L)\.glsl$/i, `_${q}.glsl`));
  }

  /**
   * @param {string} prop
   * @param {string|number|boolean} value
   * @returns {boolean}
   */
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

  /**
   * Resolve the absolute shaders directory next to the shell executable.
   *
   * @returns {Promise<string>}
   */
  async function resolveShadersDir() {
    if (shadersDir) return shadersDir;
    const api = getSettingsApi();
    try {
      const paths = await api?.getPaths?.();
      const fromPaths = String(paths?.shadersPath || '').trim();
      if (fromPaths) {
        shadersDir = fromPaths.replace(/[\\/]+$/, '');
        return shadersDir;
      }
    } catch (_) {}
    try {
      const bundled = String((await api?.getPaths?.())?.bundledPluginsPath || '');
      if (bundled) {
        shadersDir =
          bundled.replace(/[\\/]+plugins[\\/]*$/i, '').replace(/[\\/]+$/, '') + '\\shaders';
        return shadersDir;
      }
    } catch (_) {}
    return '';
  }

  /**
   * Build an mpv `glsl-shaders` path list for Windows (`;` separators).
   *
   * @param {string[]} files
   * @param {string} dir
   * @returns {string}
   */
  function buildShaderChain(files, dir) {
    if (!files.length || !dir) return '';
    return files
      .map((name) => `${dir}\\${name}`.replace(/\//g, '\\'))
      .join(';');
  }

  /**
   * Apply or clear Anime4K shaders based on plugin + mode state.
   *
   * @returns {Promise<void>}
   */
  async function applyShaders() {
    if (suspended) return;
    const active = isPluginEnabled() && mode !== 'Off';
    if (!active) {
      sendMpvSetProp('glsl-shaders', '');
      return;
    }
    const dir = await resolveShadersDir();
    if (!dir) {
      console.warn(`${LOG_PREFIX} shadersPath unavailable; cannot apply Anime4K.`);
      sendMpvSetProp('glsl-shaders', '');
      return;
    }
    const files = shadersForMode(mode, quality);
    const chain = buildShaderChain(files, dir);
    sendMpvSetProp('glsl-shaders', chain);
    console.info(`${LOG_PREFIX} Applied mode ${mode} / quality ${quality} (${files.length} shaders).`);
  }

  /**
   * Debounced apply so rapid mode toggles do not spam mpv.
   */
  function scheduleApply() {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applyTimer = null;
      applyShaders().catch((error) => {
        console.warn(`${LOG_PREFIX} apply failed:`, error);
      });
    }, 80);
  }

  /**
   * Persist mode and refresh player chips + shaders.
   *
   * @param {string} nextMode
   * @returns {Promise<void>}
   */
  async function setMode(nextMode) {
    mode = normalizeMode(nextMode);
    const api = getSettingsApi();
    try {
      await api?.saveSetting?.(PLUGIN_ID, MODE_SETTING, mode);
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to save mode:`, error);
    }
    refreshChipActiveState();
    scheduleApply();
  }

  /**
   * Mark the active player-panel chip buttons.
   * Control-bar button uses `active` only while the panel is open (Picture parity).
   */
  function refreshChipActiveState() {
    document.querySelectorAll(`#${PLAYER_CHIPS_ID} button`).forEach((btn) => {
      const value = btn.getAttribute('data-mode');
      btn.classList.toggle('is-active', value === mode);
    });
    const playerBtn = document.getElementById(BTN_ID);
    if (playerBtn) {
      playerBtn.classList.toggle('active', panelOpen);
      playerBtn.title = mode === 'Off' ? 'Anime4K (Off)' : `Anime4K (${mode})`;
    }
  }

  /**
   * Register Shader quality select in Settings → Plugins gear panel.
   *
   * @returns {Promise<void>}
   */
  async function registerSettingsUi() {
    const api = getSettingsApi();
    document.getElementById('mystremio-anime4k-settings-style')?.remove();
    document.getElementById('mystremio-anime4k-mode-chips')?.remove();
    if (!api?.registerSettings || window.__stremioAnime4kSettingsRegistered) return;

    const schema = [
      {
        key: QUALITY_SETTING,
        type: 'select',
        label: 'Shader quality',
        description:
          'CNN model size used by Anime4K modes. Higher is sharper but heavier on the GPU.',
        defaultValue: DEFAULT_QUALITY,
        options: QUALITY_OPTIONS,
      },
    ];

    try {
      await api.registerSettings(PLUGIN_ID, schema);
      window.__stremioAnime4kSettingsRegistered = true;
    } catch (error) {
      const message = error && error.message ? String(error.message) : '';
      if (message.includes('settings schema registered')) {
        window.__stremioAnime4kSettingsRegistered = true;
        return;
      }
      console.warn(`${LOG_PREFIX} Failed to register settings:`, error);
    }
  }

  /**
   * Reload quality when saved from Settings → Plugins.
   */
  function wireSettingsListener() {
    const api = getSettingsApi();
    if (!api?.onSettingsSaved || window.__stremioAnime4kSettingsWired) return;
    window.__stremioAnime4kSettingsWired = true;
    api.onSettingsSaved(PLUGIN_ID, async (payload) => {
      if (payload && typeof payload === 'object' && payload[QUALITY_SETTING] != null) {
        quality = normalizeQuality(payload[QUALITY_SETTING]);
      } else {
        await loadSettings();
      }
      scheduleApply();
    });
  }

  /**
   * Load persisted mode + quality from plugin settings storage.
   *
   * @returns {Promise<void>}
   */
  async function loadSettings() {
    const api = getSettingsApi();
    if (!api?.getSetting) return;
    try {
      mode = normalizeMode(await api.getSetting(PLUGIN_ID, MODE_SETTING));
      quality = normalizeQuality(await api.getSetting(PLUGIN_ID, QUALITY_SETTING));
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to load settings:`, error);
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async function initialize() {
    await registerSettingsUi();
    wireSettingsListener();
    await loadSettings();
  }

  function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  /**
   * Injects styles for the player control-bar button and mode panel.
   */
  function injectPlayerStyles() {
    let style = document.getElementById(PLAYER_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = PLAYER_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = `
      #${BTN_ID} {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        margin: 0 !important;
        padding: 0 !important;
        flex: none !important;
        position: relative !important;
        z-index: 2 !important;
        pointer-events: auto !important;
      }
      #${BTN_ID} [class*="button-container"] {
        display: none !important;
      }
      #${BTN_ID} [class*="icon"],
      #${BTN_ID} svg {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: ${ICON_SIZE} !important;
        height: ${ICON_SIZE} !important;
        min-width: ${ICON_SIZE} !important;
        min-height: ${ICON_SIZE} !important;
        margin: 0 !important;
        padding: 0 !important;
        line-height: 0 !important;
      }
      #${BTN_ID} svg {
        flex: none !important;
        fill: none !important;
        stroke: currentColor !important;
        pointer-events: none !important;
      }
      #${BTN_ID}.active {
        background: rgba(255, 255, 255, 0.12) !important;
      }
      #${PANEL_ID} {
        position: fixed;
        z-index: 2147483000;
        width: min(16.5rem, calc(100vw - 2rem));
        padding: 0.65rem 0.75rem 0.75rem;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(42, 42, 46, 0.58);
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.18);
        color: #fff;
        font-family: inherit;
        font-size: 0.78rem;
        line-height: 1.2;
        display: none;
        pointer-events: auto;
      }
      #${PANEL_ID}.open { display: block; }
      #${PANEL_ID} .mystremio-anime4k-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        margin-bottom: 0.55rem;
      }
      #${PANEL_ID} .mystremio-anime4k-title {
        font-size: 0.82rem;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      #${PANEL_ID} .mystremio-anime4k-close {
        border: none;
        background: transparent;
        color: rgba(255, 255, 255, 0.55);
        font-size: 1rem;
        line-height: 1;
        cursor: pointer;
        width: 1.2rem;
        height: 1.2rem;
        border-radius: 6px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #${PANEL_ID} .mystremio-anime4k-close:hover {
        background: rgba(255, 255, 255, 0.08);
        color: rgba(255, 255, 255, 0.9);
      }
      #${PLAYER_CHIPS_ID} {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
      }
      #${PLAYER_CHIPS_ID} button {
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 999px;
        padding: 0.35rem 0.7rem;
        color: rgba(255, 255, 255, 0.88);
        background: rgba(255, 255, 255, 0.08);
        cursor: pointer;
        font-size: 0.75rem;
        font-weight: 600;
        line-height: 1.2;
      }
      #${PLAYER_CHIPS_ID} button.is-active {
        background: rgba(255, 255, 255, 0.28);
        border-color: rgba(255, 255, 255, 0.4);
      }
      #${PLAYER_CHIPS_ID} button:hover {
        background: rgba(255, 255, 255, 0.18);
      }
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] {
        cursor: default !important;
      }
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="nav-bar-layer"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="control-bar-layer"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="menu-layer"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="side-drawer-button-layer"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="seek-bar-container"] {
        opacity: 1 !important;
        visibility: visible !important;
        pointer-events: auto !important;
      }
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] > [class*="layer-"]:not([class*="control"]):not([class*="nav-bar"]):not([class*="menu"]):not([class*="side-drawer"]):not([class*="background"]):not([class*="buffering"]),
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="video-container"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="seek-bar-container"] [class*="slider-container"] {
        pointer-events: none !important;
      }
    `;
  }

  /**
   * @param {string} [className]
   * @returns {SVGElement}
   */
  function buildAnime4kIconSvg(className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    const paths = ['M4 7h16', 'M4 12h10', 'M4 17h7', 'M16 12l4-2.5V14.5L16 12z'];
    for (const d of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  /**
   * @param {Element} button
   */
  function replaceButtonIcon(button) {
    const iconWrap = button.querySelector('[class*="icon"]');
    const refSvg = button.querySelector('svg');
    const svgClass = refSvg?.getAttribute('class') || '';
    const svg = buildAnime4kIconSvg(svgClass);
    if (iconWrap) {
      iconWrap.replaceChildren(svg);
      return;
    }
    if (refSvg) {
      refSvg.replaceWith(svg);
      return;
    }
    button.appendChild(svg);
  }

  /**
   * @returns {Element|null}
   */
  function getButtonTemplate() {
    const container = document.querySelector(
      '[class*="player-container"] [class*="control-bar-buttons-container"]'
    );
    if (!container) return null;
    return container.querySelector('[class*="control-bar-button"]:not([class*="menu"])');
  }

  /**
   * Places the Anime4K button before the menu (after Cast/Contribute when present).
   *
   * @param {Element} button
   * @param {Element} container
   */
  function placeAnime4kButton(button, container) {
    if (!button || !container) return;
    const menuButton = container.querySelector('[class*="control-bar-buttons-menu-button"]');
    const cast = document.getElementById(CAST_BTN_ID);
    const contribute = document.getElementById(CONTRIBUTE_BTN_ID);
    const after =
      (cast && container.contains(cast) && cast) ||
      (contribute && container.contains(contribute) && contribute) ||
      null;
    if (after) {
      if (button.previousElementSibling !== after) {
        container.insertBefore(button, after.nextSibling);
      }
      return;
    }
    if (menuButton && container.contains(menuButton)) {
      if (button.nextElementSibling !== menuButton) {
        container.insertBefore(button, menuButton);
      }
      return;
    }
    if (button.parentNode !== container) container.appendChild(button);
  }

  /**
   * @param {Element|null} button
   * @param {Element} container
   * @returns {boolean}
   */
  function isAnime4kButtonPlaced(button, container) {
    if (!button || !container || !container.contains(button)) return false;
    const menuButton = container.querySelector('[class*="control-bar-buttons-menu-button"]');
    const cast = document.getElementById(CAST_BTN_ID);
    const contribute = document.getElementById(CONTRIBUTE_BTN_ID);
    if (cast && container.contains(cast)) return button.previousElementSibling === cast;
    if (contribute && container.contains(contribute)) {
      return button.previousElementSibling === contribute;
    }
    if (menuButton && container.contains(menuButton)) {
      return button.nextElementSibling === menuButton;
    }
    return true;
  }

  /**
   * @param {Element|null} button
   * @returns {boolean}
   */
  function isStaleButton(button) {
    if (!button) return true;
    return !String(button.className || '').includes('control-bar-button');
  }

  /**
   * @param {HTMLElement} button
   */
  function bindButtonHandler(button) {
    if (!button || button.dataset.mystremioAnime4kBound === '1') return;
    button.dataset.mystremioAnime4kBound = '1';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismissGuardUntil = 0;
      togglePanel();
    });
  }

  /**
   * @returns {HTMLElement}
   */
  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel && panel.dataset.mystremioAnime4kVersion !== PANEL_VERSION) {
      panel.remove();
      panel = null;
    }
    if (panel) {
      refreshChipActiveState();
      return panel;
    }

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.dataset.mystremioAnime4kVersion = PANEL_VERSION;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Anime4K');
    panel.innerHTML = `
      <div class="mystremio-anime4k-header">
        <span class="mystremio-anime4k-title">Anime4K</span>
        <button type="button" class="mystremio-anime4k-close" data-mystremio-anime4k-close aria-label="Close">×</button>
      </div>
      <div id="${PLAYER_CHIPS_ID}" role="group" aria-label="Anime4K mode"></div>
    `;
    const chips = panel.querySelector(`#${PLAYER_CHIPS_ID}`);
    for (const option of MODE_OPTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = option.label;
      btn.setAttribute('data-mode', option.value);
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setMode(option.value).catch(() => {});
      });
      chips.appendChild(btn);
    }
    panel.querySelector('[data-mystremio-anime4k-close]')?.addEventListener('click', (event) => {
      stopEvent(event);
      closePanel();
    });
    document.body.appendChild(panel);
    refreshChipActiveState();
    return panel;
  }

  function positionPanel() {
    const panel = document.getElementById(PANEL_ID);
    const button = document.getElementById(BTN_ID);
    if (!panel || !button) return;
    const panelWidth = panel.offsetWidth || 264;
    const panelHeight = panel.offsetHeight || 160;
    const margin = 14;
    const seekBar = document.querySelector(
      '[class*="player-container"] [class*="seek-bar-container"]'
    );
    const rect = button.getBoundingClientRect();
    const left = Math.min(
      Math.max(margin, rect.left + rect.width / 2 - panelWidth / 2),
      window.innerWidth - panelWidth - margin
    );
    panel.style.left = `${left}px`;
    panel.style.right = 'auto';
    if (seekBar) {
      const seekRect = seekBar.getBoundingClientRect();
      const top = seekRect.top - panelHeight - margin;
      panel.style.top = `${top >= margin ? top : margin}px`;
      panel.style.bottom = 'auto';
    } else {
      panel.style.top = 'auto';
      panel.style.bottom = `${margin + 120}px`;
    }
  }

  function lockPlayerOverlay() {
    document.documentElement.classList.add(OVERLAY_LOCK_CLASS);
    const playerContainer = document.querySelector('[class*="player-container"]');
    if (playerContainer) {
      playerContainer.classList.forEach((className) => {
        if (className.includes('overlayHidden')) {
          playerContainer.classList.remove(className);
        }
      });
    }
  }

  function unlockPlayerOverlay() {
    document.documentElement.classList.remove(OVERLAY_LOCK_CLASS);
    if (overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
    }
  }

  function startOverlayKeepAlive() {
    unlockPlayerOverlay();
    if (!panelOpen) return;
    lockPlayerOverlay();
    positionPanel();
    const playerContainer = document.querySelector('[class*="player-container"]');
    if (!playerContainer) return;
    overlayObserver = new MutationObserver(() => {
      if (!panelOpen) {
        unlockPlayerOverlay();
        return;
      }
      lockPlayerOverlay();
      positionPanel();
    });
    overlayObserver.observe(playerContainer, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  function isDismissGuardActive() {
    return Date.now() < dismissGuardUntil;
  }

  function armDismissGuard() {
    dismissGuardUntil = Date.now() + 500;
  }

  /**
   * @param {EventTarget|null} target
   * @returns {boolean}
   */
  function isAnime4kButtonTarget(target) {
    return target instanceof Element && Boolean(target.closest(`#${BTN_ID}`));
  }

  /**
   * @param {EventTarget|null} target
   * @returns {boolean}
   */
  function isInteractivePlayerChrome(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest(
        `[id="${PANEL_ID}"], [id="${BTN_ID}"], [class*="nav-bar"], [class*="menu-layer"], [class*="side-drawer-button-layer"]`
      )
    );
  }

  /**
   * @param {EventTarget|null} target
   * @returns {boolean}
   */
  function isOtherControlBarTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target.closest(`#${BTN_ID}`) || target.closest(`#${PANEL_ID}`)) return false;
    return Boolean(
      target.closest(
        `[class*="player-container"] [class*="control-bar-button"], [class*="player-container"] [class*="volume-slider"]`
      )
    );
  }

  function isOutsidePointer(event) {
    const panel = document.getElementById(PANEL_ID);
    const button = document.getElementById(BTN_ID);
    if (!panelOpen || !panel) return false;
    const target = event.target;
    if (!(target instanceof Node)) return false;
    if (panel.contains(target) || (button && button.contains(target))) return false;
    return true;
  }

  function handleOutsidePointer(event) {
    if (isAnime4kButtonTarget(event.target)) {
      dismissGuardUntil = 0;
      return;
    }
    if (isDismissGuardActive()) {
      stopEvent(event);
      return;
    }
    if (!isOutsidePointer(event)) return;

    if (isOtherControlBarTarget(event.target) || isInteractivePlayerChrome(event.target)) {
      closePanel();
      return;
    }

    armDismissGuard();
    stopEvent(event);
    closePanel();
  }

  function bindPanelHandlers() {
    if (outsideHandler) return;
    outsideHandler = (event) => handleOutsidePointer(event);
    document.addEventListener('pointerdown', outsideHandler, true);
    document.addEventListener('mousedown', outsideHandler, true);
    document.addEventListener('click', outsideHandler, true);
    keyHandler = (event) => {
      if (!panelOpen) return;
      if (event.key === 'Escape') {
        stopEvent(event);
        closePanel();
      }
    };
    document.addEventListener('keydown', keyHandler);
  }

  function unbindPanelHandlers() {
    if (outsideHandler) {
      document.removeEventListener('pointerdown', outsideHandler, true);
      document.removeEventListener('mousedown', outsideHandler, true);
      document.removeEventListener('click', outsideHandler, true);
      outsideHandler = null;
    }
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
  }

  function openPanel() {
    ensurePanel();
    panelOpen = true;
    document.getElementById(PANEL_ID)?.classList.add('open');
    document.getElementById(BTN_ID)?.classList.add('active');
    lockPlayerOverlay();
    startOverlayKeepAlive();
    positionPanel();
    bindPanelHandlers();
    refreshChipActiveState();
  }

  function closePanel() {
    panelOpen = false;
    document.getElementById(PANEL_ID)?.classList.remove('open');
    document.getElementById(BTN_ID)?.classList.remove('active');
    refreshChipActiveState();
    unlockPlayerOverlay();
    unbindPanelHandlers();
  }

  function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
  }

  function removePlayerUi() {
    closePanel();
    document.getElementById(BTN_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
  }

  /**
   * Mounts the enable-gated Anime4K control-bar button on the player route.
   */
  function ensureButton() {
    if (!isPluginEnabled() || !isPlayerRoute()) {
      removePlayerUi();
      return;
    }

    injectPlayerStyles();
    const container = document.querySelector(
      '[class*="player-container"] [class*="control-bar-buttons-container"]'
    );
    if (!container) return;

    let button = document.getElementById(BTN_ID);
    if (button && isStaleButton(button)) {
      button.remove();
      button = null;
    }

    if (!button) {
      const template = getButtonTemplate();
      if (template) {
        button = template.cloneNode(true);
        button.classList.remove('disabled');
        button.removeAttribute('tabindex');
        button.querySelectorAll('[class*="button-container"]').forEach((el) => el.remove());
      } else {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'control-bar-button';
      }
      button.id = BTN_ID;
      button.title = 'Anime4K';
      button.setAttribute('aria-label', 'Anime4K');
      replaceButtonIcon(button);
      placeAnime4kButton(button, container);
    } else if (!isAnime4kButtonPlaced(button, container)) {
      placeAnime4kButton(button, container);
    }

    bindButtonHandler(button);
    ensurePanel();
    refreshChipActiveState();
    if (panelOpen) positionPanel();
  }

  /**
   * @returns {boolean}
   */
  function needsLayoutEnsure() {
    if (!isPluginEnabled() || !isPlayerRoute()) return false;
    const button = document.getElementById(BTN_ID);
    if (!button) return true;
    const container = document.querySelector(
      '[class*="player-container"] [class*="control-bar-buttons-container"]'
    );
    if (!container || !container.contains(button)) return true;
    if (!isAnime4kButtonPlaced(button, container)) return true;
    return button.dataset.mystremioAnime4kBound !== '1';
  }

  function scheduleEnsure() {
    if (ensureTimer) window.clearTimeout(ensureTimer);
    ensureTimer = window.setTimeout(() => {
      ensureTimer = null;
      ensureButton();
    }, 150);
  }

  function bindLayoutObserver() {
    if (layoutObserver || isOverlayHidden()) return;
    const target =
      document.querySelector('[class*="player-container"]') || document.documentElement;
    layoutObserver = new MutationObserver(() => {
      if (isOverlayHidden()) return;
      if (needsLayoutEnsure()) scheduleEnsure();
    });
    layoutObserver.observe(target, { childList: true, subtree: true });
  }

  function stopLayoutObserver() {
    if (layoutObserver) {
      layoutObserver.disconnect();
      layoutObserver = null;
    }
    if (ensureTimer) {
      window.clearTimeout(ensureTimer);
      ensureTimer = null;
    }
    if (retryTimer) {
      window.clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  /**
   * Pause expensive layout work while player chrome is auto-hidden.
   */
  function syncLayoutWorkToChrome() {
    if (!isPlayerRoute() || !isPluginEnabled() || suspended) {
      stopLayoutObserver();
      return;
    }
    if (isOverlayHidden()) {
      stopLayoutObserver();
      return;
    }
    bindLayoutObserver();
    if (needsLayoutEnsure()) scheduleEnsure();
  }

  function bindChromeIdleWatcher() {
    if (chromeIdleWatcher || typeof MutationObserver === 'undefined') return;
    const target = document.querySelector('[class*="player-container"]');
    if (!target) return;
    chromeIdleWatcher = new MutationObserver(() => syncLayoutWorkToChrome());
    chromeIdleWatcher.observe(target, { attributes: true, attributeFilter: ['class'] });
  }

  function stopChromeIdleWatcher() {
    if (chromeIdleWatcher) {
      chromeIdleWatcher.disconnect();
      chromeIdleWatcher = null;
    }
  }

  /**
   * Short retry loop while on the player route (control bar mounts late).
   */
  function startRetryLoop() {
    if (retryTimer || isOverlayHidden()) return;
    let ticks = 0;
    retryTimer = window.setInterval(() => {
      if (!isPlayerRoute() || !isPluginEnabled()) {
        window.clearInterval(retryTimer);
        retryTimer = null;
        return;
      }
      if (isOverlayHidden()) return;
      if (needsLayoutEnsure()) ensureButton();
      ticks += 1;
      if (ticks >= 20) {
        window.clearInterval(retryTimer);
        retryTimer = null;
      }
    }, 500);
  }

  /**
   * Soft-suspend when leaving the player (clear shaders so non-player UI is unaffected).
   */
  function suspend() {
    suspended = true;
    if (applyTimer) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }
    sendMpvSetProp('glsl-shaders', '');
    removePlayerUi();
    stopLayoutObserver();
    stopChromeIdleWatcher();
  }

  /**
   * Hard unload for live disable — clears Ready gate.
   */
  function hardUnload() {
    suspend();
    document.removeEventListener('stremio-custom-route-change', onRouteChange);
    document.removeEventListener('stremio-custom-playback-route', resume);
    window.removeEventListener('hashchange', onRouteChange);
    try {
      delete window.__stremioAnime4kPluginReady;
    } catch (_) {
      window.__stremioAnime4kPluginReady = '';
    }
  }

  /**
   * Resume after returning to the player route.
   */
  function resume() {
    suspended = false;
    scheduleApply();
    if (isPluginEnabled()) {
      bindChromeIdleWatcher();
      scheduleEnsure();
      syncLayoutWorkToChrome();
      startRetryLoop();
    } else {
      removePlayerUi();
    }
  }

  function onRouteChange() {
    if (isPlayerRoute()) {
      resume();
    } else {
      suspend();
    }
  }

  initialize().then(() => {
    onRouteChange();
  });

  document.addEventListener('stremio-custom-route-change', onRouteChange);
  document.addEventListener('stremio-custom-playback-route', resume);
  window.addEventListener('hashchange', onRouteChange);
  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    initialize().then(() => {
      scheduleApply();
      scheduleEnsure();
      if (isPlayerRoute()) {
        bindChromeIdleWatcher();
        syncLayoutWorkToChrome();
        startRetryLoop();
      }
    });
  });
  document.addEventListener('stremio-custom-stream-started', () => {
    scheduleApply();
    scheduleEnsure();
    bindChromeIdleWatcher();
    syncLayoutWorkToChrome();
    startRetryLoop();
  });
  document.addEventListener('stremio-custom-playback-stopped', () => {
    removePlayerUi();
  });
  window.addEventListener('resize', () => {
    if (panelOpen) positionPanel();
  });

  window.__stremioAnime4kSuspend = suspend;
  window.__stremioAnime4kUnload = hardUnload;
  window.__stremioAnime4kResume = resume;
  window.__stremioAnime4kApply = () => scheduleApply();
  window.__stremioAnime4kEnsure = ensureButton;

  window.__stremioAnime4kPluginReady = PLUGIN_VERSION;
  scheduleEnsure();
  if (isPlayerRoute()) {
    bindChromeIdleWatcher();
    syncLayoutWorkToChrome();
    startRetryLoop();
  }

  console.info(`${LOG_PREFIX} Plugin loaded.`);
})();
