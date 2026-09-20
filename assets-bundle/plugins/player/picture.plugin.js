/**
 * @name Picture Settings
 * @description Player picture controls: Dim plus Contrast / Brightness / Gamma / Saturation
 * @version 2.5.1
 * @author MyStremio
 * @category player
 */
/* jshint esversion: 11, browser: true, devel: true */

(function () {
  'use strict';

  const PLUGIN_VERSION = '2.5.1';
  const PLUGIN_REF = 'player/picture.plugin.js';
  const LEGACY_PLUGIN_REF = 'player/brightness.plugin.js';
  const RESET_ICON_PATHS = [
    'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8',
    'M3 3v5h5',
  ];

  /**
   * @returns {boolean}
   */
  function isPictureEnabled() {
    const helpers = window.StremioCustom?.helpers;
    if (!helpers?.isPluginEnabled) return false;
    return (
      helpers.isPluginEnabled(PLUGIN_REF) ||
      helpers.isPluginEnabled(LEGACY_PLUGIN_REF)
    );
  }

  const BTN_ID = 'mystremio-brightness-btn';
  const PANEL_ID = 'mystremio-brightness-panel';
  const STYLE_ID = 'mystremio-brightness-styles';
  const SEEK_GROUP_ID = 'stremio-seek-buttons-group';
  const OVERLAY_LOCK_CLASS = 'mystremio-brightness-overlay-lock';
  const STORAGE_KEY = 'stremio-custom-player-brightness-eq';
  const LEGACY_STORAGE_KEY = 'stremio-custom-player-brightness';
  const DIM_SHADER_MIGRATED_KEY = 'stremio-custom-migrate-dim-shader-v1';
  const DIM_SHADER_FILE = 'mystremio-dim.glsl';
  const DIM_SHADER_PARAM = 'mystremio_dim';
  const DIM_SHADER_OPTS_KEY = `mystremio-dim/${DIM_SHADER_PARAM}`;
  const ICON_SIZE = '2.0rem';
  const PANEL_VERSION = '11';
  const SLIDER_ACTIVE_CLASS = 'mystremio-brightness-slider-active';

  /**
   * @typedef {object} EqState
   * @property {number} dim Master dim 0–100 (100 = no dim)
   * @property {number} contrast Absolute mpv contrast (−100…100), 0 neutral
   * @property {number} brightness Absolute mpv brightness (−100…100), 0 neutral
   * @property {number} gamma Absolute mpv gamma (−100…100), 0 neutral
   * @property {number} saturation Absolute mpv saturation (−100…100), 0 neutral
   * @property {boolean} brightnessManual Fine Brightness was moved by the user
   * @property {boolean} contrastManual Fine Contrast was moved by the user
   * @property {boolean} gammaManual Fine Gamma was moved by the user
   * @property {boolean} saturationManual Fine Saturation was moved by the user
   */

  /** @type {EqState} */
  const DEFAULT_STATE = {
    dim: 100,
    contrast: 0,
    brightness: 0,
    gamma: 0,
    saturation: 0,
    brightnessManual: false,
    contrastManual: false,
    gammaManual: false,
    saturationManual: false,
  };

  let shellMsgId = 14000;
  let panelOpen = false;
  let outsideHandler = null;
  let keyHandler = null;
  let overlayObserver = null;
  let dismissGuardUntil = 0;
  let ensureTimer = null;
  let layoutObserver = null;
  let chromeIdleWatcher = null;

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
  /** @type {EqState} */
  let state = { ...DEFAULT_STATE };
  let lastAppliedSig = '';
  let shadersDir = '';

  /**
   * @param {unknown} value
   * @param {number} min
   * @param {number} max
   * @param {number} fallback
   * @returns {number}
   */
  function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
  }

  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  /**
   * Fine EQ knobs only. Dim is a separate linear GLSL multiply.
   *
   * @param {EqState} s
   * @returns {{ brightness: number, contrast: number, gamma: number, saturation: number }}
   */
  function resolveMpvProps(s) {
    return {
      brightness: s.brightness,
      contrast: s.contrast,
      gamma: s.gamma,
      saturation: s.saturation,
    };
  }

  /**
   * One-shot: previous Dim wrote brightness/contrast/gamma via the night curve.
   * After the shader migration, zero those unless the user moved a fine slider.
   *
   * @param {EqState} s
   * @returns {EqState}
   */
  function migrateDimOffEq(s) {
    try {
      if (localStorage.getItem(DIM_SHADER_MIGRATED_KEY) === '1') return s;
    } catch (_) {
      return s;
    }
    const next = { ...s };
    if (!next.brightnessManual) next.brightness = 0;
    if (!next.contrastManual) next.contrast = 0;
    if (!next.gammaManual) next.gamma = 0;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeState(next)));
      localStorage.setItem(DIM_SHADER_MIGRATED_KEY, '1');
    } catch (_) {}
    return next;
  }

  /**
   * @param {unknown} raw
   * @returns {EqState}
   */
  function normalizeState(raw) {
    if (raw == null || typeof raw !== 'object') return { ...DEFAULT_STATE };
    const obj = /** @type {Record<string, unknown>} */ (raw);
    return {
      dim: clampInt(obj.dim, 0, 100, DEFAULT_STATE.dim),
      contrast: clampInt(obj.contrast, -100, 100, 0),
      brightness: clampInt(obj.brightness, -100, 100, 0),
      gamma: clampInt(obj.gamma, -100, 100, 0),
      saturation: clampInt(obj.saturation, -100, 100, 0),
      brightnessManual: Boolean(obj.brightnessManual),
      contrastManual: Boolean(obj.contrastManual),
      gammaManual: Boolean(obj.gammaManual),
      saturationManual: Boolean(obj.saturationManual),
    };
  }

  /**
   * Loads EQ state from localStorage (migrates legacy single-percent key).
   *
   * @returns {EqState}
   */
  function readStoredState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return migrateDimOffEq(normalizeState(JSON.parse(raw)));
    } catch (_) {}
    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy != null && legacy !== '') {
        const dim = clampInt(legacy, 0, 100, 100);
        return migrateDimOffEq(normalizeState({ ...DEFAULT_STATE, dim }));
      }
    } catch (_) {}
    return migrateDimOffEq({ ...DEFAULT_STATE });
  }

  /**
   * @param {EqState} next
   */
  function writeStoredState(next) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeState(next)));
    } catch (_) {}
  }

  /**
   * @param {string} prop
   * @param {number|string|boolean} value
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
   * Keep softsubs out of the picture pipeline (video-only tone via lavfi eq).
   */
  function ensureSubtitlesUnblended() {
    sendMpvSetProp('blend-subtitles', 'no');
  }

  /**
   * Maps absolute mpv-style EQ (−100…100) to lavfi `eq` filter params.
   * Applied as a named video filter so ASS/OSD softsubs are not dimmed.
   *
   * @param {{ brightness: number, contrast: number, gamma: number, saturation: number }} props
   * @returns {string}
   */
  function buildVideoEqFilter(props) {
    const b = props.brightness / 100;
    const c = Math.max(0.01, 1 + props.contrast / 100);
    const g = Math.max(0.1, 1 + props.gamma / 100);
    const sat = Math.max(0, 1 + props.saturation / 100);
    return `@mystremio-pic:eq=brightness=${b}:contrast=${c}:gamma=${g}:saturation=${sat}`;
  }

  /**
   * Fine EQ via video-only `vf`. Dim is a linear GLSL multiply (phone brightness).
   *
   * @param {EqState} [s]
   */
  function applyTone(s) {
    const next = s || state;
    ensureSubtitlesUnblended();
    sendMpvSetProp('brightness', 0);
    sendMpvSetProp('contrast', 0);
    sendMpvSetProp('gamma', 0);
    sendMpvSetProp('saturation', 0);
    const props = resolveMpvProps(next);
    const neutral =
      props.brightness === 0 &&
      props.contrast === 0 &&
      props.gamma === 0 &&
      props.saturation === 0;
    sendMpvSetProp('vf', neutral ? '' : buildVideoEqFilter(props));
    applyDimShader(next.dim);
  }

  function ensureGlslComposer() {
    const prev = window.StremioCustomGlsl;
    window.StremioCustomGlsl = {
      layers: {
        dim: prev?.layers?.dim || [],
        anime4k: prev?.layers?.anime4k || [],
      },
      apply() {
        const files = [...(this.layers.dim || []), ...(this.layers.anime4k || [])].filter(Boolean);
        sendMpvSetProp('glsl-shaders', files.join(';'));
      },
    };
    return window.StremioCustomGlsl;
  }

  async function resolveShadersDir() {
    if (shadersDir) return shadersDir;
    const api = window.StremioCustomAPI || window.StremioEnhancedAPI;
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
   * mpv `--glsl-shader-opts` is `basename/param=value` (gpu-next / libplacebo).
   *
   * @param {number} factor 0–1
   * @returns {string}
   */
  function dimShaderOpts(factor) {
    return `${DIM_SHADER_OPTS_KEY}=${factor.toFixed(4)}`;
  }

  /**
   * Attach dim hook then set PARAM. Opts before the shader never apply.
   *
   * @param {string} dir
   * @param {number} factor 0–1
   */
  function attachDimShader(dir, factor) {
    const composer = ensureGlslComposer();
    composer.layers.dim = [`${dir}\\${DIM_SHADER_FILE}`.replace(/\//g, '\\')];
    composer.apply();
    sendMpvSetProp('glsl-shader-opts', dimShaderOpts(factor));
  }

  /**
   * @param {number} dim 0–100 (100 = no dim)
   */
  function applyDimShader(dim) {
    const composer = ensureGlslComposer();
    const factor = Math.max(0, Math.min(1, clampInt(dim, 0, 100, 100) / 100));
    if (factor >= 0.999) {
      composer.layers.dim = [];
      composer.apply();
      sendMpvSetProp('glsl-shader-opts', '');
      return;
    }
    if (shadersDir) {
      attachDimShader(shadersDir, factor);
      return;
    }
    resolveShadersDir().then((dir) => {
      if (!dir) {
        console.warn('[StremioCustom] shadersPath unavailable; cannot apply dim shader.');
        composer.layers.dim = [];
        composer.apply();
        sendMpvSetProp('glsl-shader-opts', '');
        return;
      }
      attachDimShader(dir, factor);
    });
  }

  /**
   * Resets video tone to neutral.
   */
  function resetMpvTone() {
    ensureSubtitlesUnblended();
    sendMpvSetProp('brightness', 0);
    sendMpvSetProp('contrast', 0);
    sendMpvSetProp('gamma', 0);
    sendMpvSetProp('saturation', 0);
    sendMpvSetProp('vf', '');
    const composer = ensureGlslComposer();
    composer.layers.dim = [];
    composer.apply();
    sendMpvSetProp('glsl-shader-opts', '');
    lastAppliedSig = '';
  }

  function isDismissGuardActive() {
    return Date.now() < dismissGuardUntil;
  }

  function armDismissGuard() {
    dismissGuardUntil = Date.now() + 500;
  }

  function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function isInteractivePlayerChrome(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest(
        `[id="${PANEL_ID}"], [id="${BTN_ID}"], [class*="nav-bar"], [class*="menu-layer"], [class*="side-drawer-button-layer"]`
      )
    );
  }

  function isOtherControlBarTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target.closest(`#${BTN_ID}`) || target.closest(`#${PANEL_ID}`)) return false;
    return Boolean(
      target.closest(
        `[class*="player-container"] [class*="control-bar-button"], [class*="player-container"] [class*="volume-slider"], [class*="player-container"] #${SEEK_GROUP_ID}`
      )
    );
  }

  function isBrightnessButtonTarget(target) {
    return target instanceof Element && Boolean(target.closest(`#${BTN_ID}`));
  }

  /**
   * @param {HTMLElement} button
   */
  function bindButtonHandler(button) {
    if (!button || button.dataset.mystremioBrightnessBound === '1') return;
    button.dataset.mystremioBrightnessBound = '1';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismissGuardUntil = 0;
      togglePanel();
    });
  }

  /**
   * @param {HTMLInputElement|null} slider
   * @param {number} percent 0–100 fill
   */
  function updateSliderFill(slider, percent) {
    if (!slider) return;
    const pct = clampInt(percent, 0, 100, 50);
    slider.style.setProperty('--eq-pct', `${pct}%`);
  }

  /**
   * Maps a bipolar (−100…100) slider value to a 0–100 track fill percent.
   *
   * @param {number} value
   * @returns {number}
   */
  function bipolarFill(value) {
    return clampInt(((clampInt(value, -100, 100, 0) + 100) / 200) * 100, 0, 100, 50);
  }

  function stopSliderBubble(event) {
    event.stopPropagation();
  }

  /**
   * @param {HTMLElement} panel
   */
  function bindPanelControls(panel) {
    if (!panel || panel.dataset.mystremioBrightnessControls === '1') return;
    panel.dataset.mystremioBrightnessControls = '1';

    panel.querySelectorAll('[data-eq-key]').forEach((slider) => {
      if (!(slider instanceof HTMLInputElement)) return;
      slider.addEventListener('input', (event) => {
        stopSliderBubble(event);
        const key = slider.getAttribute('data-eq-key');
        if (!key) return;
        onSliderInput(key, slider.value);
      });
      slider.addEventListener('pointerdown', stopSliderBubble);
      slider.addEventListener('pointerup', stopSliderBubble);
    });

    panel.querySelector('[data-mystremio-brightness-reset]')?.addEventListener('click', (event) => {
      stopEvent(event);
      resetAll(true);
    });
    panel.querySelectorAll('[data-eq-reset]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        stopEvent(event);
        const key = btn.getAttribute('data-eq-reset');
        if (key) resetOne(key, true);
      });
    });
    panel.querySelector('[data-mystremio-brightness-close]')?.addEventListener('click', (event) => {
      stopEvent(event);
      closePanel();
    });
  }

  /**
   * @param {EqState} s
   * @returns {string}
   */
  function toneSignature(s) {
    const props = resolveMpvProps(s);
    return JSON.stringify({ dim: s.dim, ...props });
  }

  /**
   * Handles slider input for master dim and fine EQ controls.
   *
   * @param {string} key
   * @param {string|number} rawValue
   */
  function onSliderInput(key, rawValue) {
    if (key === 'dim') {
      state.dim = clampInt(rawValue, 0, 100, 100);
      persistAndApply();
      syncPanelFromState();
      return;
    }
    const value = clampInt(rawValue, -100, 100, 0);
    if (key === 'brightness') {
      state.brightness = value;
      state.brightnessManual = true;
    } else if (key === 'contrast') {
      state.contrast = value;
      state.contrastManual = true;
    } else if (key === 'gamma') {
      state.gamma = value;
      state.gammaManual = true;
    } else if (key === 'saturation') {
      state.saturation = value;
      state.saturationManual = true;
    } else {
      return;
    }
    persistAndApply();
    syncPanelFromState();
  }

  function resetIconHtml() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${RESET_ICON_PATHS[0]}"></path><path d="${RESET_ICON_PATHS[1]}"></path></svg>`;
  }

  function eqResetButton(key, label) {
    return `<button type="button" class="mystremio-eq-reset" data-eq-reset="${key}" aria-label="Reset ${label}">${resetIconHtml()}</button>`;
  }

  function persistAndApply() {
    state = normalizeState(state);
    writeStoredState(state);
    applyTone(state);
    lastAppliedSig = toneSignature(state);
  }

  /**
   * @param {string} key
   * @param {boolean} persist
   */
  function resetOne(key, persist) {
    if (key === 'dim') {
      state.dim = DEFAULT_STATE.dim;
    } else if (key === 'contrast' || key === 'brightness' || key === 'gamma' || key === 'saturation') {
      state[key] = DEFAULT_STATE[key];
      state[`${key}Manual`] = false;
    } else {
      return;
    }
    if (persist) writeStoredState(state);
    applyTone(state);
    lastAppliedSig = toneSignature(state);
    syncPanelFromState();
  }

  /**
   * @param {boolean} persist
   */
  function resetAll(persist) {
    state = { ...DEFAULT_STATE };
    if (persist) writeStoredState(state);
    resetMpvTone();
    lastAppliedSig = toneSignature(state);
    syncPanelFromState();
  }

  function findLeftBarInsertPoint() {
    const controlBar = document.querySelector('[class*="player-container"] [class*="control-bar-container"]');
    if (!controlBar) return null;

    const seekGroup = document.getElementById(SEEK_GROUP_ID);
    if (seekGroup?.parentNode) {
      return { parent: seekGroup.parentNode, before: seekGroup };
    }

    const volumeRoot =
      controlBar.querySelector('[class*="control-bar-volume"]') ||
      controlBar.querySelector('[class*="volume-change-indicator"]')?.closest('[class*="control-bar"]') ||
      controlBar.querySelector('[class*="volume-slider"]')?.closest('[class*="volume"]') ||
      controlBar.querySelector('[class*="volume-slider"]')?.parentElement;

    if (!volumeRoot?.parentNode) return null;
    return { parent: volumeRoot.parentNode, after: volumeRoot };
  }

  function isButtonCorrectlyPlaced(button) {
    const insertPoint = findLeftBarInsertPoint();
    if (!button || !insertPoint) return true;
    if (insertPoint.before) {
      return (
        button.parentNode === insertPoint.parent &&
        button.nextElementSibling === insertPoint.before
      );
    }
    if (insertPoint.after) {
      return (
        button.parentNode === insertPoint.parent &&
        button.previousElementSibling === insertPoint.after
      );
    }
    return false;
  }

  function placeLeftBarButton(button, insertPoint) {
    if (!button || !insertPoint) return false;
    if (isButtonCorrectlyPlaced(button)) return true;
    if (insertPoint.before) {
      insertPoint.parent.insertBefore(button, insertPoint.before);
      return true;
    }
    if (insertPoint.after) {
      insertPoint.parent.insertBefore(button, insertPoint.after.nextSibling);
      return true;
    }
    return false;
  }

  function getButtonTemplate() {
    const container = document.querySelector(
      '[class*="player-container"] [class*="control-bar-buttons-container"]'
    );
    if (!container) return null;
    return container.querySelector('[class*="control-bar-button"]:not([class*="menu"])');
  }

  function buildBrightnessIconSvg(className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);

    const sun = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    sun.setAttribute('cx', '12');
    sun.setAttribute('cy', '12');
    sun.setAttribute('r', '4');
    svg.appendChild(sun);

    const rays = [
      'M12 2v2',
      'M12 20v2',
      'M4.93 4.93l1.41 1.41',
      'M17.66 17.66l1.41 1.41',
      'M2 12h2',
      'M20 12h2',
      'M4.93 19.07l1.41-1.41',
      'M17.66 6.34l1.41-1.41',
    ];
    for (const d of rays) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  function replaceButtonIcon(button) {
    const iconWrap = button.querySelector('[class*="icon"]');
    const refSvg = button.querySelector('svg');
    const svgClass = refSvg?.getAttribute('class') || '';
    const svg = buildBrightnessIconSvg(svgClass);

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

  function isStaleButton(button) {
    if (!button) return true;
    return !button.className.includes('control-bar-button');
  }

  function injectStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
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
        width: min(15.5rem, calc(100vw - 2rem));
        padding: 0.65rem 0.75rem 0.7rem;
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
        overflow: visible;
      }
      #${PANEL_ID}.open { display: block; }
      #${PANEL_ID} .mystremio-brightness-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        margin-bottom: 0.5rem;
      }
      #${PANEL_ID} .mystremio-brightness-title {
        font-size: 0.82rem;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      #${PANEL_ID} .mystremio-brightness-header-actions {
        display: flex;
        align-items: center;
        gap: 0.35rem;
      }
      #${PANEL_ID} .mystremio-brightness-reset,
      #${PANEL_ID} .mystremio-eq-reset {
        border: none;
        background: transparent;
        color: rgba(255, 255, 255, 0.62);
        cursor: pointer;
        padding: 0;
        border-radius: 6px;
        width: 1.15rem;
        height: 1.15rem;
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #${PANEL_ID} .mystremio-brightness-reset svg,
      #${PANEL_ID} .mystremio-eq-reset svg {
        width: 0.92rem;
        height: 0.92rem;
        display: block;
        pointer-events: none;
      }
      #${PANEL_ID} .mystremio-brightness-reset:hover,
      #${PANEL_ID} .mystremio-eq-reset:hover {
        background: rgba(255, 255, 255, 0.12);
        color: rgba(255, 255, 255, 0.95);
      }
      #${PANEL_ID} .mystremio-brightness-close {
        border: none;
        background: transparent;
        color: rgba(255, 255, 255, 0.55);
        font-size: 1rem;
        line-height: 1;
        cursor: pointer;
        width: 1.2rem;
        height: 1.2rem;
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
      }
      #${PANEL_ID} .mystremio-brightness-close:hover {
        background: rgba(255, 255, 255, 0.08);
        color: rgba(255, 255, 255, 0.9);
      }
      #${PANEL_ID} .mystremio-eq-row {
        display: grid;
        grid-template-columns: 4.4rem 1fr 2.1rem 1.15rem;
        align-items: center;
        gap: 0.4rem;
        min-height: 1.55rem;
        margin-top: 0.28rem;
      }
      #${PANEL_ID} .mystremio-eq-row.is-master {
        margin-top: 0.1rem;
        margin-bottom: 0.2rem;
        padding-bottom: 0.35rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      #${PANEL_ID} .mystremio-eq-label {
        font-size: 0.72rem;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.78);
        white-space: nowrap;
      }
      #${PANEL_ID} .mystremio-eq-value {
        font-size: 0.7rem;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        color: rgba(255, 255, 255, 0.62);
        text-align: right;
        white-space: nowrap;
      }
      #${PANEL_ID} [data-eq-key] {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: 1.35rem;
        margin: 0;
        background: transparent;
        cursor: pointer;
        touch-action: none;
        overflow: visible;
        --eq-pct: 50%;
      }
      #${PANEL_ID} [data-eq-key]::-webkit-slider-runnable-track {
        height: 0.28rem;
        border-radius: 999px;
        background: linear-gradient(
          to right,
          rgba(255, 255, 255, 0.92) 0%,
          rgba(255, 255, 255, 0.92) var(--eq-pct, 50%),
          rgba(255, 255, 255, 0.2) var(--eq-pct, 50%),
          rgba(255, 255, 255, 0.2) 100%
        );
      }
      #${PANEL_ID} [data-eq-key]::-moz-range-track {
        height: 0.28rem;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.2);
        border: none;
      }
      #${PANEL_ID} [data-eq-key]::-moz-range-progress {
        height: 0.28rem;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.92);
      }
      #${PANEL_ID} [data-eq-key]::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 0.72rem;
        height: 0.72rem;
        margin-top: calc((0.28rem - 0.72rem) / 2);
        border-radius: 50%;
        background: #fff;
        border: none;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
      }
      #${PANEL_ID} [data-eq-key]::-moz-range-thumb {
        width: 0.72rem;
        height: 0.72rem;
        border-radius: 50%;
        background: #fff;
        border: none;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
      }
      html.${SLIDER_ACTIVE_CLASS} {
        cursor: grabbing !important;
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
   * Syncs panel slider values/labels from in-memory state.
   */
  function syncPanelFromState() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const rows = [
      { key: 'dim', value: state.dim, label: `${state.dim}%`, fill: state.dim },
      {
        key: 'contrast',
        value: state.contrast,
        label: String(state.contrast),
        fill: bipolarFill(state.contrast),
      },
      {
        key: 'brightness',
        value: state.brightness,
        label: String(state.brightness),
        fill: bipolarFill(state.brightness),
      },
      {
        key: 'gamma',
        value: state.gamma,
        label: String(state.gamma),
        fill: bipolarFill(state.gamma),
      },
      {
        key: 'saturation',
        value: state.saturation,
        label: String(state.saturation),
        fill: bipolarFill(state.saturation),
      },
    ];

    for (const row of rows) {
      const slider = panel.querySelector(`[data-eq-key="${row.key}"]`);
      const valueEl = panel.querySelector(`[data-eq-value="${row.key}"]`);
      if (slider instanceof HTMLInputElement) {
        slider.value = String(row.value);
        updateSliderFill(slider, row.fill);
      }
      if (valueEl) valueEl.textContent = row.label;
    }
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel && panel.dataset.mystremioBrightnessVersion !== PANEL_VERSION) {
      panel.remove();
      panel = null;
    }
    if (panel) {
      bindPanelControls(panel);
      syncPanelFromState();
      return panel;
    }

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.dataset.mystremioBrightnessVersion = PANEL_VERSION;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Picture Settings');
    panel.innerHTML = `
      <div class="mystremio-brightness-header">
        <span class="mystremio-brightness-title">Picture Settings</span>
        <div class="mystremio-brightness-header-actions">
          <button type="button" class="mystremio-brightness-reset" data-mystremio-brightness-reset aria-label="Reset all">${resetIconHtml()}</button>
          <button type="button" class="mystremio-brightness-close" data-mystremio-brightness-close aria-label="Close">×</button>
        </div>
      </div>
      <div class="mystremio-eq-row is-master">
        <span class="mystremio-eq-label">Dim</span>
        <input type="range" min="0" max="100" step="1" value="100" data-eq-key="dim" aria-label="Dim" />
        <span class="mystremio-eq-value" data-eq-value="dim">100%</span>
        ${eqResetButton('dim', 'Dim')}
      </div>
      <div class="mystremio-eq-row">
        <span class="mystremio-eq-label">Contrast</span>
        <input type="range" min="-100" max="100" step="1" value="0" data-eq-key="contrast" aria-label="Contrast" />
        <span class="mystremio-eq-value" data-eq-value="contrast">0</span>
        ${eqResetButton('contrast', 'Contrast')}
      </div>
      <div class="mystremio-eq-row">
        <span class="mystremio-eq-label">Brightness</span>
        <input type="range" min="-100" max="100" step="1" value="0" data-eq-key="brightness" aria-label="Brightness" />
        <span class="mystremio-eq-value" data-eq-value="brightness">0</span>
        ${eqResetButton('brightness', 'Brightness')}
      </div>
      <div class="mystremio-eq-row">
        <span class="mystremio-eq-label">Gamma</span>
        <input type="range" min="-100" max="100" step="1" value="0" data-eq-key="gamma" aria-label="Gamma" />
        <span class="mystremio-eq-value" data-eq-value="gamma">0</span>
        ${eqResetButton('gamma', 'Gamma')}
      </div>
      <div class="mystremio-eq-row">
        <span class="mystremio-eq-label">Saturation</span>
        <input type="range" min="-100" max="100" step="1" value="0" data-eq-key="saturation" aria-label="Saturation" />
        <span class="mystremio-eq-value" data-eq-value="saturation">0</span>
        ${eqResetButton('saturation', 'Saturation')}
      </div>
    `;

    document.body.appendChild(panel);
    bindPanelControls(panel);
    syncPanelFromState();
    return panel;
  }

  function positionPanel() {
    const panel = document.getElementById(PANEL_ID);
    const button = document.getElementById(BTN_ID);
    if (!panel || !button) return;

    const panelWidth = panel.offsetWidth || 248;
    const panelHeight = panel.offsetHeight || 220;
    const margin = 14;
    const seekBar = document.querySelector('[class*="player-container"] [class*="seek-bar-container"]');
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
    stopOverlayKeepAlive();
  }

  function stopOverlayKeepAlive() {
    if (overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
    }
  }

  function startOverlayKeepAlive() {
    stopOverlayKeepAlive();
    if (!panelOpen) return;
    lockPlayerOverlay();
    positionPanel();
    const playerContainer = document.querySelector('[class*="player-container"]');
    if (!playerContainer) return;
    overlayObserver = new MutationObserver(() => {
      if (!panelOpen) {
        stopOverlayKeepAlive();
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
    if (isBrightnessButtonTarget(event.target)) {
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
    syncPanelFromState();
  }

  function closePanel() {
    panelOpen = false;
    document.getElementById(PANEL_ID)?.classList.remove('open');
    document.getElementById(BTN_ID)?.classList.remove('active');
    unlockPlayerOverlay();
    unbindPanelHandlers();
  }

  function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
  }

  function ensureButton() {
    if (!isPictureEnabled()) {
      removeUi();
      return;
    }

    if (!isPlayerRoute()) {
      removeUi();
      return;
    }

    injectStyles();
    const insertPoint = findLeftBarInsertPoint();
    if (!insertPoint) return;

    let button = document.getElementById(BTN_ID);
    if (button && (!button.isConnected || !insertPoint.parent.contains(button))) {
      button.remove();
      button = null;
    }
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
      }
      button.id = BTN_ID;
      button.title = 'Picture Settings';
      button.setAttribute('aria-label', 'Picture Settings');
      replaceButtonIcon(button);
      placeLeftBarButton(button, insertPoint);
    } else if (!isButtonCorrectlyPlaced(button)) {
      placeLeftBarButton(button, insertPoint);
    }

    bindButtonHandler(button);
    ensurePanel();
    if (panelOpen) positionPanel();
  }

  function removeUi() {
    closePanel();
    document.getElementById(BTN_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
  }

  function ensureAll() {
    if (!isPictureEnabled()) {
      removeUi();
      return;
    }

    ensureButton();
    if (!isPlayerRoute()) return;
    const sig = toneSignature(state);
    if (sig !== lastAppliedSig) {
      lastAppliedSig = sig;
      applyTone(state);
    }
  }

  window.__stremioCustomPlayerBrightnessEnsure = ensureAll;

  function needsLayoutEnsure() {
    if (!isPlayerRoute()) return false;
    const button = document.getElementById(BTN_ID);
    if (!button) return true;
    if (!isButtonCorrectlyPlaced(button)) return true;
    return button.dataset.mystremioBrightnessBound !== '1';
  }

  function scheduleEnsure() {
    if (!needsLayoutEnsure()) return;
    if (ensureTimer) window.clearTimeout(ensureTimer);
    ensureTimer = window.setTimeout(() => {
      ensureTimer = null;
      ensureAll();
    }, 150);
  }

  function bindLayoutObserver() {
    if (layoutObserver || isOverlayHidden()) return;
    const target =
      document.querySelector('[class*="player-container"]') || document.documentElement;
    layoutObserver = new MutationObserver(() => {
      if (isOverlayHidden()) return;
      scheduleEnsure();
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
  }

  function syncLayoutWorkToChrome() {
    if (!isPlayerRoute() || !isPictureEnabled()) {
      stopLayoutObserver();
      return;
    }
    if (isOverlayHidden()) {
      stopLayoutObserver();
      return;
    }
    bindLayoutObserver();
    scheduleEnsure();
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

  function teardownDisabled() {
    removeUi();
    document.getElementById(STYLE_ID)?.remove();
    resetMpvTone();
    stopLayoutObserver();
    stopChromeIdleWatcher();
    stopOverlayKeepAlive();
    document.documentElement.classList.remove(OVERLAY_LOCK_CLASS);
    document.documentElement.classList.remove(SLIDER_ACTIVE_CLASS);
    window.__stremioBrightnessPluginReady = false;
  }

  /**
   * Soft leave: stop timers/observers/UI without destroying the plugin bootstrap.
   */
  function suspendRuntime() {
    closePanel();
    removeUi();
    stopOverlayKeepAlive();
    stopLayoutObserver();
    stopChromeIdleWatcher();
    document.documentElement.classList.remove(OVERLAY_LOCK_CLASS);
    document.documentElement.classList.remove(SLIDER_ACTIVE_CLASS);
  }

  function unloadPicture() {
    teardownDisabled();
  }

  window.__stremioPictureUnload = unloadPicture;
  /** @deprecated Legacy alias for bootstrap unload hooks. */
  window.__stremioBrightnessUnload = unloadPicture;

  state = readStoredState();

  if (!isPictureEnabled()) {
    teardownDisabled();
    return;
  }

  if (window.__stremioBrightnessPluginReady === PLUGIN_VERSION) return;
  window.__stremioBrightnessPluginReady = PLUGIN_VERSION;

  if (!window.__stremioBrightnessBootstrapped) {
    window.__stremioBrightnessBootstrapped = true;
    ensureAll();
    document.addEventListener('stremio-custom-playback-route', scheduleEnsure);
    document.addEventListener('stremio-custom-bootstrap-ready', scheduleEnsure);
    document.addEventListener('stremio-custom-route-change', () => {
      if (!isPlayerRoute()) {
        suspendRuntime();
        return;
      }
      bindChromeIdleWatcher();
      syncLayoutWorkToChrome();
      window.setTimeout(ensureAll, 300);
      window.setTimeout(ensureAll, 1200);
    });
    document.addEventListener('stremio-custom-playback-stopped', () => {
      suspendRuntime();
    });
    document.addEventListener('stremio-custom-stream-started', () => {
      window.setTimeout(() => {
        state = readStoredState();
        applyTone(state);
        lastAppliedSig = toneSignature(state);
        syncPanelFromState();
      }, 120);
      bindChromeIdleWatcher();
      syncLayoutWorkToChrome();
    });
    window.addEventListener('resize', () => {
      if (panelOpen) positionPanel();
    });

    bindChromeIdleWatcher();
    syncLayoutWorkToChrome();

    let ticks = 0;
    const timer = setInterval(() => {
      if (!isPlayerRoute()) {
        if (ticks > 3) clearInterval(timer);
        return;
      }
      if (isOverlayHidden()) return;
      if (needsLayoutEnsure()) ensureAll();
      ticks += 1;
      if (ticks >= 12) clearInterval(timer);
    }, 1000);
  }

  console.info('[StremioCustom] Picture Settings plugin ready.');
})();
