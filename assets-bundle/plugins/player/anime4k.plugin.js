/**
 * @name Anime4K
 * @description Upscale anime with Anime4K GLSL shaders (mpv gpu-next). Configure mode under Settings > MyStremio.
 * @version 1.0.1
 * @author MyStremio
 * @category player
 */
/* jshint esversion: 11, browser: true, devel: true */

(function () {
  'use strict';

  const PLUGIN_ID = 'anime4k';
  const PLUGIN_REF = 'player/anime4k.plugin.js';
  const LOG_PREFIX = '[Anime4K]';
  const MODE_SETTING = 'mode';
  const STYLE_ID = 'mystremio-anime4k-settings-style';
  const CHIPS_ID = 'mystremio-anime4k-mode-chips';

  /** @type {Record<string, string[]>} Mode → relative shader filenames (HQ high-end chains). */
  const MODE_SHADERS = {
    Off: [],
    A: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_VL.glsl',
      'Anime4K_Upscale_CNN_x2_VL.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ],
    B: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_Soft_VL.glsl',
      'Anime4K_Upscale_CNN_x2_VL.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ],
    C: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Upscale_Denoise_CNN_x2_VL.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ],
    'A+A': [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_VL.glsl',
      'Anime4K_Upscale_CNN_x2_VL.glsl',
      'Anime4K_Restore_CNN_M.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ],
    'B+B': [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_Soft_VL.glsl',
      'Anime4K_Upscale_CNN_x2_VL.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Restore_CNN_Soft_M.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
    ],
    'C+A': [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Upscale_Denoise_CNN_x2_VL.glsl',
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

  let shellMsgId = 16000;
  let settingsReady = null;
  let mode = 'A';
  let shadersDir = '';
  let applyTimer = null;
  let suspended = false;
  let settingsObserver = null;

  /**
   * @returns {boolean}
   */
  function isPluginEnabled() {
    const helpers = window.StremioCustom?.helpers;
    if (!helpers?.isPluginEnabled) return true;
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
    return 'A';
  }

  /**
   * Styles for in-flow mode chips (avoids MultiselectMenu clipping in the plugin bubble).
   */
  function ensureSettingsStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      [data-anime4k-settings="1"] [class*="multiselect"],
      [data-anime4k-settings="1"] input[class*="plugin-setting-input"] {
        display: none !important;
      }
      #${CHIPS_ID} {
        display: flex;
        flex-wrap: wrap;
        gap: 0.55rem;
        width: 100%;
        margin-top: 0.15rem;
      }
      #${CHIPS_ID} button {
        border: var(--focus-outline-size, 2px) solid transparent;
        border-radius: 2.75rem;
        padding: 0.55rem 1.1rem;
        color: var(--primary-foreground-color);
        background: var(--overlay-color);
        cursor: pointer;
        font-size: 0.9rem;
        font-weight: 600;
        line-height: 1.2;
      }
      #${CHIPS_ID} button.is-active {
        background: rgba(255, 255, 255, 0.28);
        border-color: rgba(255, 255, 255, 0.35);
      }
      #${CHIPS_ID} button:hover {
        background: rgba(255, 255, 255, 0.2);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
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
        shadersDir = bundled.replace(/[\\/]+plugins[\\/]*$/i, '').replace(/[\\/]+$/, '') + '\\shaders';
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
      .map((name) => {
        const joined = `${dir}\\${name}`.replace(/\//g, '\\');
        return joined;
      })
      .join(';');
  }

  /**
   * Apply or clear Anime4K shaders based on plugin + settings state.
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
    const files = MODE_SHADERS[mode] || [];
    const chain = buildShaderChain(files, dir);
    sendMpvSetProp('glsl-shaders', chain);
    console.info(`${LOG_PREFIX} Applied mode ${mode} (${files.length} shaders).`);
  }

  /**
   * Debounced apply so rapid settings toggles do not spam mpv.
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
   * Persist mode and refresh chips + shaders.
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
   * Mark the active chip button.
   */
  function refreshChipActiveState() {
    document.querySelectorAll(`#${CHIPS_ID} button`).forEach((btn) => {
      const value = btn.getAttribute('data-mode');
      btn.classList.toggle('is-active', value === mode);
    });
  }

  /**
   * @param {Element} panel
   * @returns {boolean}
   */
  function isAnime4kSettingsPanel(panel) {
    if (!(panel instanceof Element)) return false;
    const block = panel.closest('[class*="plugin-block"]') || panel.parentElement;
    if (!block) return false;
    const title = block.querySelector('[class*="plugin-name"], [class*="plugin-title"], h3, strong');
    const text = String(title?.textContent || block.textContent || '');
    return /Anime4K/i.test(text);
  }

  /**
   * Replace clipped MultiselectMenu / input with in-flow mode chips.
   *
   * @param {Element} panel
   */
  function ensureModeChips(panel) {
    if (!(panel instanceof Element) || !isAnime4kSettingsPanel(panel)) return;
    panel.setAttribute('data-anime4k-settings', '1');

    let chips = panel.querySelector(`#${CHIPS_ID}`);
    if (!chips) {
      chips = document.createElement('div');
      chips.id = CHIPS_ID;
      chips.setAttribute('role', 'group');
      chips.setAttribute('aria-label', 'Anime4K mode');

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

      const stacked =
        panel.querySelector('[class*="plugin-setting-row-stacked"]') ||
        panel.querySelector('[class*="plugin-setting-row"]') ||
        panel;
      stacked.appendChild(chips);
    }

    refreshChipActiveState();
  }

  /**
   * Scan open plugin settings panels for Anime4K.
   */
  function scanSettingsPanels() {
    ensureSettingsStyle();
    document.querySelectorAll('[class*="plugin-settings"]').forEach((panel) => {
      ensureModeChips(panel);
    });
  }

  /**
   * Watch Settings page for Anime4K gear panel open/close.
   */
  function startSettingsObserver() {
    if (settingsObserver) return;
    settingsObserver = new MutationObserver(() => {
      if (typeof window.stremioCustomSuspendBackground === 'function' &&
        window.stremioCustomSuspendBackground()) {
        return;
      }
      scanSettingsPanels();
    });
    settingsObserver.observe(document.body, { childList: true, subtree: true });
    scanSettingsPanels();
  }

  /**
   * Register schema and load persisted settings.
   * Mode uses a hidden input slot; chips are injected in-flow (no dropdown clipping).
   *
   * @returns {Promise<void>}
   */
  async function initializeSettings() {
    const api = getSettingsApi();
    if (!api?.registerSettings || !api?.getSetting) return;

    ensureSettingsStyle();

    try {
      await api.clearRegisteredSettings?.(PLUGIN_ID);
    } catch (_) {}

    try {
      await api.registerSettings(PLUGIN_ID, [
        {
          key: MODE_SETTING,
          type: 'input',
          label: 'Mode',
          description:
            'Off disables shaders. A ≈ 1080p, B ≈ 720p, C ≈ 480p. A+A / B+B / C+A are heavier. Use the plugin toggle above for on/off.',
          defaultValue: 'A',
        },
      ]);
      window.__anime4kSettingsRegistered = true;
      if (api.onSettingsSaved) {
        api.onSettingsSaved(PLUGIN_ID, () => {
          loadSettings().then(() => {
            refreshChipActiveState();
            scheduleApply();
          }).catch(() => {});
        });
      }
    } catch (err) {
      const message = err && err.message ? String(err.message) : '';
      if (message.includes('settings schema registered')) {
        window.__anime4kSettingsRegistered = true;
      } else {
        console.warn(`${LOG_PREFIX} Failed to register settings:`, err);
      }
    }

    await loadSettings();
    startSettingsObserver();
  }

  /**
   * @returns {Promise<void>}
   */
  async function loadSettings() {
    const api = getSettingsApi();
    if (!api?.getSetting) return;
    try {
      mode = normalizeMode(await api.getSetting(PLUGIN_ID, MODE_SETTING));
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to load settings:`, error);
    }
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
  }

  /**
   * Resume after returning to the player route.
   */
  function resume() {
    suspended = false;
    scheduleApply();
  }

  function onRouteChange() {
    if (isPlayerRoute()) {
      resume();
    } else {
      suspend();
    }
  }

  settingsReady = initializeSettings().then(() => {
    onRouteChange();
  });

  document.addEventListener('stremio-custom-route-change', onRouteChange);
  window.addEventListener('hashchange', onRouteChange);
  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    settingsReady = initializeSettings().then(() => scheduleApply());
  });

  window.__stremioAnime4kSuspend = suspend;
  window.__stremioAnime4kResume = resume;
  window.__stremioAnime4kApply = () => scheduleApply();

  console.info(`${LOG_PREFIX} Plugin loaded.`);
})();
