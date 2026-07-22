/**
 * @name Brightness
 * @description Adjust player video brightness via MPV
 * @version 1.0.0
 * @author MyStremio
 * @category player
 */
/* jshint esversion: 11, browser: true, devel: true */

(function () {
  'use strict';

  const PLUGIN_VERSION = '1.0.0';
  const PLUGIN_REF = 'player/brightness.plugin.js';

  /**
   * @returns {boolean}
   */
  function isBrightnessEnabled() {
    const helpers = window.StremioCustom?.helpers;
    if (!helpers?.isPluginEnabled) return false;
    return helpers.isPluginEnabled(PLUGIN_REF);
  }

  const BTN_ID = 'mystremio-brightness-btn';
  const PANEL_ID = 'mystremio-brightness-panel';
  const STYLE_ID = 'mystremio-brightness-styles';
  const SEEK_GROUP_ID = 'stremio-seek-buttons-group';
  const OVERLAY_LOCK_CLASS = 'mystremio-brightness-overlay-lock';
  const STORAGE_KEY = 'stremio-custom-player-brightness';
  const ICON_SIZE = '2.0rem';
  const DEFAULT_PERCENT = 100;
  const PANEL_VERSION = '8';
  const SLIDER_ACTIVE_CLASS = 'mystremio-brightness-slider-active';
  const MAX_BRIGHTNESS_DROP = 50;

  let shellMsgId = 14000;
  let panelOpen = false;
  let outsideHandler = null;
  let keyHandler = null;
  let overlayTimer = null;
  let overlayObserver = null;
  let dismissGuardUntil = 0;
  let ensureTimer = null;
  let lastAppliedPercent = null;
  let layoutObserver = null;

  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  function clampPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return DEFAULT_PERCENT;
    return Math.min(100, Math.max(0, Math.round(num)));
  }

  function readStoredPercent() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw == null || raw === '') return DEFAULT_PERCENT;
      return clampPercent(raw);
    } catch (_) {
      return DEFAULT_PERCENT;
    }
  }

  function writeStoredPercent(percent) {
    try {
      localStorage.setItem(STORAGE_KEY, String(clampPercent(percent)));
    } catch (_) {}
  }

  function percentToMpvBrightness(percent) {
    const t = clampPercent(percent) / 100;
    return -MAX_BRIGHTNESS_DROP * (1 - t);
  }

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

  function applyBrightness(percent) {
    sendMpvSetProp('brightness', percentToMpvBrightness(percent));
  }

  function resetMpvTone() {
    sendMpvSetProp('gamma', 1);
    sendMpvSetProp('brightness', 0);
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

  function stopBubble(event) {
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

  function updateSliderFill(slider, percent) {
    if (!slider) return;
    slider.style.setProperty('--brightness-pct', `${clampPercent(percent)}%`);
  }

  function stopSliderBubble(event) {
    event.stopPropagation();
  }

  function bindNativeSlider(slider) {
    if (!slider || slider.dataset.mystremioBrightnessBound === '1') return;
    slider.dataset.mystremioBrightnessBound = '1';

    updateSliderFill(slider, slider.value);

    slider.addEventListener('input', (event) => {
      stopSliderBubble(event);
      updateSliderFill(event.target, event.target.value);
      setBrightness(event.target.value, true);
    });
    slider.addEventListener('pointerdown', stopSliderBubble);
    slider.addEventListener('pointerup', stopSliderBubble);
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
        width: min(13.5rem, calc(100vw - 2rem));
        padding: 0.6rem 0.7rem 0.65rem;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(36, 36, 40, 0.94);
        backdrop-filter: blur(18px) saturate(160%);
        -webkit-backdrop-filter: blur(18px) saturate(160%);
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.08);
        color: #fff;
        font-family: inherit;
        font-size: 0.78rem;
        line-height: 1.2;
        display: none;
        pointer-events: auto;
        overflow: visible;
      }
      #${PANEL_ID}.open {
        display: block;
      }
      #${PANEL_ID} .mystremio-brightness-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        margin-bottom: 0.45rem;
      }
      #${PANEL_ID} .mystremio-brightness-header-left {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        min-width: 0;
        flex: 1;
      }
      #${PANEL_ID} .mystremio-brightness-title {
        font-size: 0.82rem;
        font-weight: 600;
        letter-spacing: 0.01em;
        line-height: 1.2;
        white-space: nowrap;
      }
      #${PANEL_ID} .mystremio-brightness-value {
        font-size: 0.75rem;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        color: rgba(255, 255, 255, 0.68);
        line-height: 1.2;
        white-space: nowrap;
      }
      #${PANEL_ID} .mystremio-brightness-close {
        border: none;
        background: transparent;
        color: rgba(255, 255, 255, 0.55);
        font-size: 1rem;
        line-height: 1;
        cursor: pointer;
        padding: 0;
        margin: 0;
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
      #${PANEL_ID} .mystremio-brightness-slider-wrap {
        display: flex;
        align-items: center;
        width: 100%;
        min-height: 1.35rem;
        padding: 0.35rem 0;
        overflow: visible;
      }
      #${PANEL_ID} [data-mystremio-brightness-slider] {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: 1.35rem;
        margin: 0;
        background: transparent;
        cursor: pointer;
        touch-action: none;
        overflow: visible;
        --brightness-pct: 100%;
      }
      #${PANEL_ID} [data-mystremio-brightness-slider]::-webkit-slider-runnable-track {
        height: 0.28rem;
        border-radius: 999px;
        background: linear-gradient(
          to right,
          rgba(255, 255, 255, 0.92) 0%,
          rgba(255, 255, 255, 0.92) var(--brightness-pct, 100%),
          rgba(255, 255, 255, 0.2) var(--brightness-pct, 100%),
          rgba(255, 255, 255, 0.2) 100%
        );
      }
      #${PANEL_ID} [data-mystremio-brightness-slider]::-moz-range-track {
        height: 0.28rem;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.2);
        border: none;
      }
      #${PANEL_ID} [data-mystremio-brightness-slider]::-moz-range-progress {
        height: 0.28rem;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.92);
      }
      #${PANEL_ID} [data-mystremio-brightness-slider]::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 0.72rem;
        height: 0.72rem;
        margin-top: calc((0.28rem - 0.72rem) / 2);
        border-radius: 50%;
        background: #fff;
        border: none;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
        transition: box-shadow 150ms ease;
      }
      #${PANEL_ID} [data-mystremio-brightness-slider]:hover::-webkit-slider-thumb,
      #${PANEL_ID} [data-mystremio-brightness-slider]:active::-webkit-slider-thumb {
        box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.22), 0 1px 4px rgba(0, 0, 0, 0.35);
      }
      #${PANEL_ID} [data-mystremio-brightness-slider]::-moz-range-thumb {
        width: 0.72rem;
        height: 0.72rem;
        border-radius: 50%;
        background: #fff;
        border: none;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
        transition: box-shadow 150ms ease;
      }
      #${PANEL_ID} [data-mystremio-brightness-slider]:hover::-moz-range-thumb,
      #${PANEL_ID} [data-mystremio-brightness-slider]:active::-moz-range-thumb {
        box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.22), 0 1px 4px rgba(0, 0, 0, 0.35);
      }
      html.${SLIDER_ACTIVE_CLASS} {
        cursor: grabbing !important;
      }
      html.${SLIDER_ACTIVE_CLASS} body {
        pointer-events: none !important;
      }
      html.${SLIDER_ACTIVE_CLASS} #${PANEL_ID},
      html.${SLIDER_ACTIVE_CLASS} #${PANEL_ID} * {
        pointer-events: auto !important;
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

  function getPanelFields() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return null;
    return {
      panel,
      slider: panel.querySelector('[data-mystremio-brightness-slider]'),
      value: panel.querySelector('[data-mystremio-brightness-value]'),
    };
  }

  function updatePanelValue(percent) {
    const fields = getPanelFields();
    if (!fields) return;
    const clamped = clampPercent(percent);
    if (fields.slider) {
      fields.slider.value = String(clamped);
      updateSliderFill(fields.slider, clamped);
    }
    if (fields.value) fields.value.textContent = `${clamped}%`;
  }

  function setBrightness(percent, persist) {
    const clamped = clampPercent(percent);
    if (persist) writeStoredPercent(clamped);
    updatePanelValue(clamped);
    applyBrightness(clamped);
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel && panel.dataset.mystremioBrightnessVersion !== PANEL_VERSION) {
      panel.remove();
      panel = null;
    }
    if (panel) {
      bindNativeSlider(panel.querySelector('[data-mystremio-brightness-slider]'));
      return panel;
    }

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.dataset.mystremioBrightnessVersion = PANEL_VERSION;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Brightness');
    panel.innerHTML = `
      <div class="mystremio-brightness-header">
        <div class="mystremio-brightness-header-left">
          <span class="mystremio-brightness-title">Brightness</span>
          <span class="mystremio-brightness-value" data-mystremio-brightness-value>${DEFAULT_PERCENT}%</span>
        </div>
        <button type="button" class="mystremio-brightness-close" data-mystremio-brightness-close aria-label="Close">×</button>
      </div>
      <div class="mystremio-brightness-slider-wrap">
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value="${DEFAULT_PERCENT}"
          data-mystremio-brightness-slider
          aria-label="Brightness"
        />
      </div>
    `;

    panel.querySelector('[data-mystremio-brightness-close]')?.addEventListener('click', (event) => {
      stopEvent(event);
      closePanel();
    });
    bindNativeSlider(panel.querySelector('[data-mystremio-brightness-slider]'));
    document.body.appendChild(panel);
    updatePanelValue(readStoredPercent());
    return panel;
  }

  function positionPanel() {
    const panel = document.getElementById(PANEL_ID);
    const button = document.getElementById(BTN_ID);
    if (!panel || !button) return;

    const panelWidth = panel.offsetWidth || 256;
    const panelHeight = panel.offsetHeight || 140;
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
      if (top >= margin) {
        panel.style.top = `${top}px`;
        panel.style.bottom = 'auto';
      } else {
        panel.style.top = `${margin}px`;
        panel.style.bottom = 'auto';
      }
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

  /**
   * Keeps overlayVisible while the brightness panel is open without a 350ms poll.
   * Reacts to player-container class churn (Stremio overlayHidden) via MutationObserver.
   */
  function stopOverlayKeepAlive() {
    if (overlayTimer) {
      window.clearInterval(overlayTimer);
      overlayTimer = null;
    }
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

    if (isOtherControlBarTarget(event.target)) {
      closePanel();
      return;
    }

    if (isInteractivePlayerChrome(event.target)) {
      closePanel();
      return;
    }

    armDismissGuard();
    stopEvent(event);
    closePanel();
  }

  function bindPanelHandlers() {
    if (outsideHandler) return;

    outsideHandler = (event) => {
      handleOutsidePointer(event);
    };

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
    const panel = document.getElementById(PANEL_ID);
    panel?.classList.add('open');
    document.getElementById(BTN_ID)?.classList.add('active');
    lockPlayerOverlay();
    startOverlayKeepAlive();
    positionPanel();
    bindPanelHandlers();
    updatePanelValue(readStoredPercent());
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
    if (!isBrightnessEnabled()) {
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
      button.title = 'Brightness';
      button.setAttribute('aria-label', 'Brightness');
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
    if (!isBrightnessEnabled()) {
      removeUi();
      return;
    }

    ensureButton();
    if (!isPlayerRoute()) return;
    const percent = readStoredPercent();
    if (percent !== lastAppliedPercent) {
      lastAppliedPercent = percent;
      setBrightness(percent, false);
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
    if (layoutObserver) return;
    const target =
      document.querySelector('[class*="player-container"]') || document.documentElement;
    layoutObserver = new MutationObserver(() => scheduleEnsure());
    layoutObserver.observe(target, { childList: true, subtree: true });
  }


  function teardownDisabled() {
    removeUi();
    document.getElementById(STYLE_ID)?.remove();
    if (typeof resetMpvTone === 'function') {
      resetMpvTone();
    } else {
      sendMpvSetProp('gamma', 1);
      sendMpvSetProp('brightness', 0);
    }
    if (layoutObserver) {
      layoutObserver.disconnect();
      layoutObserver = null;
    }
    if (ensureTimer) {
      window.clearTimeout(ensureTimer);
      ensureTimer = null;
    }
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
    if (layoutObserver) {
      layoutObserver.disconnect();
      layoutObserver = null;
    }
    if (ensureTimer) {
      window.clearTimeout(ensureTimer);
      ensureTimer = null;
    }
    document.documentElement.classList.remove(OVERLAY_LOCK_CLASS);
    document.documentElement.classList.remove(SLIDER_ACTIVE_CLASS);
  }

  window.__stremioBrightnessUnload = function () {
    suspendRuntime();
  };

  if (!isBrightnessEnabled()) {
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
      scheduleEnsure();
      bindLayoutObserver();
      window.setTimeout(ensureAll, 300);
      window.setTimeout(ensureAll, 1200);
    });
    document.addEventListener('stremio-custom-playback-stopped', () => {
      suspendRuntime();
    });
    document.addEventListener('stremio-custom-stream-started', () => {
      window.setTimeout(() => {
        resetMpvTone();
        setBrightness(readStoredPercent(), false);
      }, 120);
      scheduleEnsure();
      bindLayoutObserver();
    });
    window.addEventListener('resize', () => {
      if (panelOpen) positionPanel();
    });

    bindLayoutObserver();

    let ticks = 0;
    const timer = setInterval(() => {
      if (!isPlayerRoute()) {
        if (ticks > 3) clearInterval(timer);
        return;
      }
      if (needsLayoutEnsure()) ensureAll();
      ticks += 1;
      if (ticks >= 12) clearInterval(timer);
    }, 1000);
  }

  console.info('[StremioCustom] Brightness plugin ready.');
})();
