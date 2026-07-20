/**
 * @name Hover Timestamps
 * @description Show a time tooltip when hovering the player seek bar
 * @version 1.0.0
 * @author MyStremio
 * @category player
 */
/* jshint esversion: 11, browser: true, devel: true */

(function () {
  'use strict';

  const PLUGIN_VERSION = '1.0.0';
  const STYLE_ID = 'stremio-hover-timestamps-styles';
  const TOOLTIP_ID = 'stremio-custom-seek-hover-time';
  const PLUGIN_REF = 'player/hover-timestamps.plugin.js';

  if (window.__stremioHoverTimestampsVersion !== PLUGIN_VERSION) {
    window.__stremioHoverTimestampsReady = false;
    document.getElementById(TOOLTIP_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
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
   * Removes tooltip DOM and styles.
   */
  function teardown() {
    document.getElementById(TOOLTIP_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    hoverBoundSlider = null;
  }

  window.__stremioHoverTimestampsUnload = teardown;

  if (!isPluginEnabled()) {
    teardown();
    return;
  }

  if (window.__stremioHoverTimestampsReady) return;
  window.__stremioHoverTimestampsReady = true;
  window.__stremioHoverTimestampsVersion = PLUGIN_VERSION;

  let loopTimer = null;
  let hoverBoundSlider = null;
  let cachedHoverDuration = 0;
  let mpvCurrentTime = 0;
  let mpvDuration = 0;
  let mpvHookInstalled = false;
  let coreDurationPollGen = 0;

  /**
   * @param {unknown} raw
   * @returns {unknown[]|null}
   */
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

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${TOOLTIP_ID} {
        position: fixed !important;
        z-index: 2147482000 !important;
        pointer-events: none !important;
        padding: 0.28rem 0.62rem !important;
        border-radius: 999px !important;
        background: rgba(30, 30, 30, 0.78) !important;
        color: #fff !important;
        font-size: 0.85rem !important;
        line-height: 1.1 !important;
        font-weight: 600 !important;
        border: 1px solid rgba(255, 255, 255, 0.12) !important;
        box-shadow:
          0 8px 24px rgba(0, 0, 0, 0.35),
          inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
        backdrop-filter: blur(14px) saturate(170%) !important;
        -webkit-backdrop-filter: blur(14px) saturate(170%) !important;
        transform: translate(-50%, -84%) !important;
        display: none;
        white-space: nowrap;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * @param {number} seconds
   * @returns {string}
   */
  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * @returns {HTMLElement}
   */
  function getHoverTooltip() {
    let el = document.getElementById(TOOLTIP_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TOOLTIP_ID;
      document.body.appendChild(el);
    }
    return el;
  }

  /**
   * @param {unknown} payload
   */
  function handleMpvPropChange(payload) {
    const change = Array.isArray(payload) ? payload[1] : payload;
    if (!change?.name) return;
    if (change.name === 'time-pos') {
      const seconds = Number(change.data);
      if (Number.isFinite(seconds) && seconds >= 0) mpvCurrentTime = seconds;
      return;
    }
    if (change.name === 'duration') {
      const seconds = Number(change.data);
      if (Number.isFinite(seconds) && seconds > 0) mpvDuration = seconds;
    }
  }

  function hookMpvMessages() {
    if (mpvHookInstalled) return;
    mpvHookInstalled = true;

    const onMessage = (raw) => {
      const payload = parseShellPayload(raw);
      if (payload) handleMpvPropChange(payload);
    };

    const transport = window.qt?.webChannelTransport;
    if (transport && !transport.__stremioHoverTimestampsHooked) {
      transport.__stremioHoverTimestampsHooked = true;
      const original = transport.onmessage;
      transport.onmessage = function (ev) {
        onMessage(ev?.data);
        if (typeof original === 'function') original.call(this, ev);
      };
    }

    if (window.chrome?.webview && !window.chrome.webview.__stremioHoverTimestampsHooked) {
      window.chrome.webview.__stremioHoverTimestampsHooked = true;
      window.chrome.webview.addEventListener('message', (ev) => onMessage(ev?.data));
    }
  }

  /**
   * @param {string} text
   * @returns {number|null}
   */
  function parseTimeLabel(text) {
    if (!text) return null;
    const cleaned = String(text).trim().replace(/^-/, '');
    const parts = cleaned.split(':').map((part) => Number(part));
    if (parts.some((part) => Number.isNaN(part))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return null;
  }

  /**
   * @returns {number|null}
   */
  function readTimeFromDom() {
    const labels = document.querySelectorAll('[class*="seek-bar-container"] [class*="label"]');
    for (const label of labels) {
      const text = label.textContent || '';
      if (!/^\d/.test(text.trim())) continue;
      const parsed = parseTimeLabel(text);
      if (parsed != null) return parsed;
    }
    return null;
  }

  /**
   * @returns {number|null}
   */
  function readDurationFromDom() {
    const labels = Array.from(document.querySelectorAll('[class*="seek-bar-container"] [class*="label"]'));
    const times = [];
    for (const label of labels) {
      const text = (label.textContent || '').trim();
      if (!text) continue;
      for (const part of text.split(/[/|]/)) {
        const parsed = parseTimeLabel(part.trim());
        if (parsed != null) times.push(parsed);
      }
    }
    if (times.length >= 2) return Math.max(...times);
    return null;
  }

  /**
   * @param {Element|null} element
   * @returns {number|null}
   */
  function readStyleWidthRatio(element) {
    if (!element) return null;
    const inline = element.getAttribute('style') || '';
    const inlineMatch = inline.match(/width:\s*([\d.]+)%/);
    if (inlineMatch) {
      const ratio = Number(inlineMatch[1]) / 100;
      if (Number.isFinite(ratio) && ratio > 0.004 && ratio < 0.996) return ratio;
    }
    try {
      const computed = window.getComputedStyle(element);
      const width = parseFloat(computed.width);
      const parent = element.parentElement;
      const parentWidth = parent ? parseFloat(window.getComputedStyle(parent).width) : NaN;
      if (Number.isFinite(width) && Number.isFinite(parentWidth) && parentWidth > 0) {
        const ratio = width / parentWidth;
        if (Number.isFinite(ratio) && ratio > 0.004 && ratio < 0.996) return ratio;
      }
    } catch (_) {}
    return null;
  }

  /**
   * @returns {number|null}
   */
  function inferDurationFromSeekThumb() {
    const trackBefore = document.querySelector(
      '[class*="seek-bar-container"] [class*="track-before"]'
    );
    const current = readTimeFromDom();
    if (!trackBefore || current == null || current <= 0) return null;
    const ratio = readStyleWidthRatio(trackBefore);
    if (ratio == null) return null;
    const duration = current / ratio;
    return Number.isFinite(duration) && duration > current ? duration : null;
  }

  /**
   * @param {number} duration
   */
  function rememberHoverDuration(duration) {
    const seconds = Number(duration);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    cachedHoverDuration = seconds;
  }

  /**
   * @returns {number}
   */
  function resolveHoverDuration() {
    const current =
      window.StremioCustomPlayback?.getCurrentTime?.() ?? mpvCurrentTime ?? readTimeFromDom() ?? 0;
    const apiDuration = window.StremioCustomPlayback?.getDuration?.();
    const hintDuration = Number(window.__stremioPlaybackDurationHint);
    const progressHint = Number(window.__stremioPlaybackProgressHint);
    const candidates = [
      apiDuration,
      mpvDuration,
      cachedHoverDuration,
      Number.isFinite(hintDuration) && hintDuration > 0 ? hintDuration : null,
      readDurationFromDom(),
      inferDurationFromSeekThumb(),
    ];
    for (const candidate of candidates) {
      const seconds = Number(candidate);
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
    }
    if (
      Number.isFinite(current) &&
      current > 0 &&
      Number.isFinite(progressHint) &&
      progressHint > 0.01 &&
      progressHint < 0.995
    ) {
      const estimated = current / progressHint;
      if (Number.isFinite(estimated) && estimated > current + 5) return estimated;
    }
    return 0;
  }

  function restoreStoredDurationHint() {
    const hintDuration = Number(window.__stremioPlaybackDurationHint);
    if (Number.isFinite(hintDuration) && hintDuration > 0) {
      rememberHoverDuration(hintDuration);
      return;
    }
    try {
      const raw = sessionStorage.getItem('stremio-cw-playback-hint');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || Date.now() - Number(parsed.at) > 120000) return;
      if (Number.isFinite(parsed.duration) && parsed.duration > 0) {
        window.__stremioPlaybackDurationHint = parsed.duration;
        rememberHoverDuration(parsed.duration);
      }
      if (Number.isFinite(parsed.progress) && parsed.progress > 0) {
        window.__stremioPlaybackProgressHint = parsed.progress;
      }
    } catch (_) {}
  }

  async function pollCoreDuration() {
    if (!isOnPlayerPage()) return;
    const gen = ++coreDurationPollGen;
    try {
      const getState = window.services?.core?.transport?.getState || window.core?.getState;
      if (!getState) return;
      const player = await getState('player');
      if (gen !== coreDurationPollGen) return;
      const meta = player?.meta || player?.item?.meta || {};
      const item = player?.item || {};
      const candidates = [
        player?.duration,
        item.duration,
        item.runtime,
        meta.duration,
        meta.runtime,
      ];
      for (const candidate of candidates) {
        const seconds = Number(candidate);
        if (Number.isFinite(seconds) && seconds > 0) {
          rememberHoverDuration(seconds);
          mpvDuration = seconds;
          return;
        }
      }
    } catch (_) {}
  }

  function scheduleCoreDurationPoll() {
    void pollCoreDuration();
    window.setTimeout(() => void pollCoreDuration(), 400);
    window.setTimeout(() => void pollCoreDuration(), 1200);
  }

  /**
   * @returns {boolean}
   */
  function isOnPlayerPage() {
    return /#\/player/.test(location.href);
  }

  /**
   * @returns {Element|null}
   */
  function getSeekSlider() {
    return (
      document.querySelector('[class*="seek-bar-container"] [class*="slider-container"]') || null
    );
  }

  /**
   * @param {Element|null} slider
   */
  function bindHoverPreview(slider) {
    if (!slider || slider === hoverBoundSlider) return;
    if (hoverBoundSlider) {
      document.getElementById(TOOLTIP_ID)?.style && (getHoverTooltip().style.display = 'none');
    }
    hoverBoundSlider = slider;
    const tooltip = getHoverTooltip();

    const hide = () => {
      tooltip.style.display = 'none';
    };

    const showAt = (event) => {
      if (!isPluginEnabled()) {
        teardown();
        return;
      }
      const rect = slider.getBoundingClientRect();
      if (rect.width <= 0) return hide();
      const duration = resolveHoverDuration();
      if (!Number.isFinite(duration) || duration <= 0) return hide();

      const x = Math.max(rect.left, Math.min(event.clientX, rect.right));
      const ratio = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
      const seconds = duration * ratio;

      tooltip.textContent = formatTime(seconds);
      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${rect.top}px`;
      tooltip.style.display = 'block';
    };

    slider.addEventListener('mouseenter', showAt);
    slider.addEventListener('mousemove', showAt);
    slider.addEventListener('mouseleave', hide);
    slider.addEventListener('pointerleave', hide);
  }

  function stopLoop() {
    if (loopTimer) window.clearInterval(loopTimer);
    loopTimer = null;
    document.getElementById(TOOLTIP_ID)?.style && (getHoverTooltip().style.display = 'none');
  }

  function tick() {
    if (!isPluginEnabled()) {
      teardown();
      stopLoop();
      return;
    }
    if (!isOnPlayerPage()) {
      stopLoop();
      return;
    }
    hookMpvMessages();
    injectStyles();
    bindHoverPreview(getSeekSlider());
  }

  function start() {
    if (!isPluginEnabled()) return;
    injectStyles();
    hookMpvMessages();
    restoreStoredDurationHint();
    scheduleCoreDurationPoll();
    tick();
    if (!loopTimer) loopTimer = window.setInterval(tick, 200);
  }

  injectStyles();
  hookMpvMessages();

  window.addEventListener('hashchange', () => {
    if (isOnPlayerPage()) {
      restoreStoredDurationHint();
      scheduleCoreDurationPoll();
      start();
    } else {
      stopLoop();
    }
  });
  document.addEventListener('stremio-custom-stream-started', () => {
    restoreStoredDurationHint();
    scheduleCoreDurationPoll();
  });
  document.addEventListener('stremio-custom-duration-hint', (event) => {
    rememberHoverDuration(event?.detail?.duration);
    const progress = Number(event?.detail?.progress);
    if (Number.isFinite(progress) && progress > 0) {
      window.__stremioPlaybackProgressHint = progress;
    }
  });
  document.addEventListener('stremio-custom-duration', (event) => {
    rememberHoverDuration(event?.detail?.duration);
  });
  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    if (isOnPlayerPage()) start();
  });
  if (isOnPlayerPage()) start();

  console.info('[StremioCustom] Hover timestamps plugin ready.');
})();
