/**
 * @name Picture in Picture
 * @description Opens the stream in a small always-on-top window.
 * @version 1.1.0
 * @author MyStremio
 * @category player
 */
/* jshint esversion: 11, browser: true, devel: true */

(function () {
  'use strict';

  const PLUGIN_VERSION = '1.1.0';
  const PLUGIN_REF = 'player/pip.plugin.js';
  const BTN_ID = 'mystremio-pip-btn';
  const STYLE_ID = 'mystremio-pip-style';
  const PIP_CLASS = 'mystremio-pip';

  if (window.__stremioPipPluginReady === PLUGIN_VERSION) return;

  let active = Boolean(window.__stremioCustomPipMode);
  let busy = false;
  let ensureTries = 0;
  let layoutObserver = null;

  function isPluginEnabled() {
    const helpers = window.StremioCustom?.helpers;
    if (!helpers?.isPluginEnabled) return false;
    return helpers.isPluginEnabled(PLUGIN_REF);
  }

  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BTN_ID} svg {
        width: 2rem;
        height: 2rem;
        fill: none;
        stroke: currentColor;
      }
      html.${PIP_CLASS}.mystremio-player-session.mystremio-mpv-visible [class*="player-container"],
      html.${PIP_CLASS}.mystremio-player-session.mystremio-mpv-visible [class*="player-container"] [class*="video-container"],
      html.${PIP_CLASS}.mystremio-player-session.mystremio-mpv-visible [class*="player-container"] [class*="rendering"],
      html.${PIP_CLASS}.mystremio-player-session.mystremio-mpv-visible [class*="player-container"] [class*="shell-video"],
      html.${PIP_CLASS}.stremio-custom-player-route [class*="player-container"],
      html.${PIP_CLASS}.stremio-custom-player-route [class*="player-container"] [class*="video-container"],
      html.${PIP_CLASS}.stremio-custom-player-route [class*="player-container"] [class*="video-container"] [class*="video"],
      html.${PIP_CLASS}.stremio-custom-player-route [class*="player-container"] [class*="rendering"],
      html.${PIP_CLASS}.stremio-custom-player-route [class*="player-container"] [class*="shell-video"] {
        background: #000 !important;
        background-color: #000 !important;
      }
    `;
    document.head.appendChild(style);
  }

  function applyActive(on) {
    active = Boolean(on);
    window.__stremioCustomPipMode = active;
    document.documentElement.classList.toggle(PIP_CLASS, active);
    const button = document.getElementById(BTN_ID);
    if (button) button.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (!active) window.__stremioCustomRepunchMpvViewport?.();
  }

  function stopPlayback() {
    try {
      window.chrome?.webview?.postMessage(
        JSON.stringify({ id: 91001, args: ['mpv-command', ['stop']] })
      );
    } catch (_) {}
    document.dispatchEvent(new CustomEvent('stremio-custom-playback-stopped'));
  }

  async function toggle() {
    if (busy) return;
    busy = true;
    try {
      const on = await window.StremioCustomAPI.invoke('toggle-player-pip');
      applyActive(on);
      if (!on && !isPlayerRoute()) stopPlayback();
    } catch (error) {
      console.warn('[PiP]', error);
    } finally {
      busy = false;
    }
  }

  function buildIcon(svgClass) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (svgClass) svg.setAttribute('class', svgClass);
    ['M4 6.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z', 'M13 12.5h6.5V17H13z'].forEach(
      (d) => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
      }
    );
    return svg;
  }

  function replaceIcon(button) {
    const iconWrap = button.querySelector('[class*="icon"]');
    const refSvg = button.querySelector('svg');
    const svg = buildIcon(refSvg?.getAttribute('class') || '');
    if (iconWrap) iconWrap.replaceChildren(svg);
    else if (refSvg) refSvg.replaceWith(svg);
    else button.appendChild(svg);
  }

  function makeButton() {
    const template = document.querySelector(
      '[class*="player-container"] [class*="control-bar-buttons-container"] [class*="control-bar-button"]:not([class*="menu"])'
    );
    const button = template ? template.cloneNode(true) : document.createElement('button');
    if (template) {
      button.classList.remove('disabled');
      button.removeAttribute('tabindex');
      button.querySelectorAll('[class*="button-container"]').forEach((el) => el.remove());
    } else {
      button.type = 'button';
      button.className = 'control-bar-button';
    }
    button.id = BTN_ID;
    button.title = 'Picture in Picture';
    button.setAttribute('aria-label', 'Picture in Picture');
    replaceIcon(button);
    button.addEventListener('pointerdown', (event) => {
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    return button;
  }

  function removeButton() {
    document.getElementById(BTN_ID)?.remove();
  }

  function ensureButton() {
    if (!isPluginEnabled() || !isPlayerRoute()) {
      removeButton();
      return;
    }
    injectStyles();
    const container = document.querySelector(
      '[class*="player-container"] [class*="control-bar-buttons-container"]'
    );
    if (!container) return;
    let button = document.getElementById(BTN_ID);
    if (button && !container.contains(button)) {
      button.remove();
      button = null;
    }
    if (!button) {
      button = makeButton();
      container.appendChild(button);
      window.__stremioCustomLayoutPlayerButtons?.();
    }
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function scheduleEnsure() {
    ensureButton();
    if (!isPlayerRoute() || document.getElementById(BTN_ID) || ensureTries > 30) return;
    ensureTries += 1;
    window.setTimeout(scheduleEnsure, 200);
  }

  function onRoute() {
    ensureTries = 0;
    if (isPlayerRoute()) scheduleEnsure();
    else removeButton();
  }

  function bindLayoutObserver() {
    if (layoutObserver) return;
    layoutObserver = new MutationObserver(() => {
      if (!isPlayerRoute()) return;
      const container = document.querySelector(
        '[class*="player-container"] [class*="control-bar-buttons-container"]'
      );
      const button = document.getElementById(BTN_ID);
      if (!container || (button && container.contains(button))) return;
      ensureButton();
    });
    layoutObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function suspend() {
    removeButton();
  }

  function unload() {
    const wasOn = Boolean(active || window.__stremioCustomPipMode);
    const left = !isPlayerRoute();
    suspend();
    document.getElementById(STYLE_ID)?.remove();
    document.documentElement.classList.remove(PIP_CLASS);
    document.removeEventListener('stremio-custom-route-change', onRoute);
    document.removeEventListener('stremio-custom-bootstrap-ready', onRoute);
    if (layoutObserver) {
      layoutObserver.disconnect();
      layoutObserver = null;
    }
    window.__stremioPipOnClosed = undefined;
    window.__stremioPipSuspend = undefined;
    window.__stremioPipUnload = undefined;
    window.__stremioPipPluginReady = '';
    active = false;
    window.__stremioCustomPipMode = false;
    if (!wasOn) return;
    const done = window.StremioCustomAPI?.invoke('toggle-player-pip');
    if (done && typeof done.finally === 'function') {
      done.finally(() => {
        if (left) stopPlayback();
        else window.__stremioCustomRepunchMpvViewport?.();
      });
    }
  }

  window.__stremioPipOnClosed = function () {
    applyActive(false);
    if (!isPlayerRoute()) stopPlayback();
  };
  window.__stremioPipSuspend = suspend;
  window.__stremioPipUnload = unload;
  window.__stremioPipPluginReady = PLUGIN_VERSION;

  if (active) document.documentElement.classList.add(PIP_CLASS);
  document.addEventListener('stremio-custom-route-change', onRoute);
  document.addEventListener('stremio-custom-bootstrap-ready', onRoute);
  bindLayoutObserver();
  onRoute();
})();
