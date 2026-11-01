/**
 * @name Seek Preview
 * @description Show a nearby frame when hovering the player seek bar
 * @version 1.0.7
 * @author MyStremio
 * @category player
 */
/* jshint esversion: 11, browser: true, devel: true */

(function () {
  'use strict';

  const PLUGIN_VERSION = '1.0.7';
  const PLUGIN_REF = 'player/seek-preview.plugin.js';
  const STYLE_ID = 'stremio-seek-preview-styles';
  const CARD_ID = 'stremio-seek-preview-card';
  const TIME_ID = 'stremio-seek-preview-time';
  const FAST_POLL_MS = 200;
  const SLOW_POLL_MS = 2000;
  const DEBOUNCE_MS = 180;
  const FRAME_CACHE_MAX = 24;

  if (window.__stremioSeekPreviewVersion !== PLUGIN_VERSION) {
    window.__stremioSeekPreviewReady = false;
    document.getElementById(CARD_ID)?.remove();
    document.getElementById(TIME_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
  }

  function isPluginEnabled() {
    const helpers = window.StremioCustom?.helpers;
    if (!helpers?.isPluginEnabled) return false;
    return helpers.isPluginEnabled(PLUGIN_REF);
  }

  function teardown() {
    document.getElementById(CARD_ID)?.remove();
    document.getElementById(TIME_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    if (hoverTimer) window.clearTimeout(hoverTimer);
    hoverTimer = null;
    hoverBoundSlider = null;
  }

  window.__stremioSeekPreviewUnload = function () {
    try {
      if (typeof stopLoop === 'function') stopLoop();
    } catch (_) {}
    teardown();
    window.__stremioSeekPreviewReady = false;
    window.__stremioSeekPreviewVersion = '';
  };

  if (!isPluginEnabled()) {
    window.__stremioSeekPreviewUnload();
    return;
  }

  if (window.__stremioSeekPreviewReady) return;
  window.__stremioSeekPreviewReady = true;
  window.__stremioSeekPreviewVersion = PLUGIN_VERSION;

  let loopTimer = null;
  let loopIntervalMs = 0;
  let hoverBoundSlider = null;
  let hoverTimer = null;
  let durationSec = 0;
  let streamPath = '';
  let requestGen = 0;
  let inflightKey = '';
  /** @type {Map<string, {w:number,h:number,rgb:string}>} */
  const frames = new Map();

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${TIME_ID} {
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
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        transform: translate(-50%, -84%) !important;
        display: none;
        white-space: nowrap;
      }
      #${CARD_ID} {
        position: fixed !important;
        z-index: 2147482001 !important;
        pointer-events: none !important;
        width: 192px;
        height: 108px;
        margin: 0 !important;
        padding: 0 !important;
        border: 1px solid rgba(255, 255, 255, 0.18) !important;
        background: rgba(20, 20, 20, 0.92) !important;
        transform: translate(-50%, calc(-100% - 2.15rem)) !important;
        display: none;
        border-radius: 6px;
        overflow: hidden;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      }
      #${CARD_ID} canvas {
        display: block;
        width: 192px;
        height: 108px;
      }
      #${CARD_ID} .stremio-seek-preview-spin {
        display: none;
        position: absolute;
        left: 50%;
        top: 50%;
        width: 18px;
        height: 18px;
        margin: -9px 0 0 -9px;
        border: 2px solid rgba(255, 255, 255, 0.28);
        border-top-color: #fff;
        border-radius: 50%;
        animation: stremio-seek-preview-spin 0.7s linear infinite;
      }
      #${CARD_ID}.is-loading .stremio-seek-preview-spin { display: block; }
      @keyframes stremio-seek-preview-spin { to { transform: rotate(360deg); } }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function rememberDuration(value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) durationSec = seconds;
  }

  function currentPath() {
    if (streamPath) return streamPath;
    const stored = window.__stremioStreamPath;
    if (typeof stored === 'string' && stored) streamPath = stored;
    return streamPath;
  }

  function previewAllowed(path) {
    return Boolean(String(path || '').trim());
  }

  function bucketOf(seconds) {
    return Math.floor(Math.max(0, seconds) / 3);
  }

  function frameKey(path, bucket) {
    return `${path}\n${bucket}`;
  }

  function rememberFrame(key, frame) {
    if (frames.has(key)) frames.delete(key);
    frames.set(key, frame);
    while (frames.size > FRAME_CACHE_MAX) {
      const oldest = frames.keys().next().value;
      frames.delete(oldest);
    }
  }

  function getTime() {
    let time = document.getElementById(TIME_ID);
    if (!time) {
      time = document.createElement('div');
      time.id = TIME_ID;
      document.body.appendChild(time);
    }
    return time;
  }

  function getCard() {
    let card = document.getElementById(CARD_ID);
    if (!card) {
      card = document.createElement('div');
      card.id = CARD_ID;
      const canvas = document.createElement('canvas');
      canvas.width = 192;
      canvas.height = 108;
      const spin = document.createElement('div');
      spin.className = 'stremio-seek-preview-spin';
      card.appendChild(canvas);
      card.appendChild(spin);
      document.body.appendChild(card);
    }
    return card;
  }

  function placeAt(x, top) {
    const time = getTime();
    const card = getCard();
    time.style.left = `${x}px`;
    time.style.top = `${top}px`;
    card.style.left = `${x}px`;
    card.style.top = `${top}px`;
  }

  function paintFrame(frame) {
    const card = getCard();
    const canvas = card.querySelector('canvas');
    if (!canvas || !frame?.rgb) return;
    const binary = atob(frame.rgb);
    const rgb = new Uint8ClampedArray(binary.length);
    for (let i = 0; i < binary.length; i += 1) rgb[i] = binary.charCodeAt(i);
    const image = new ImageData(frame.w, frame.h);
    for (let src = 0, dst = 0; src + 2 < rgb.length; src += 3, dst += 4) {
      image.data[dst] = rgb[src];
      image.data[dst + 1] = rgb[src + 1];
      image.data[dst + 2] = rgb[src + 2];
      image.data[dst + 3] = 255;
    }
    canvas.getContext('2d')?.putImageData(image, 0, 0);
    card.classList.remove('is-loading');
    card.style.display = 'block';
  }

  function showLoading() {
    const card = getCard();
    card.classList.add('is-loading');
    card.style.display = 'block';
  }

  function hideFrame() {
    const card = document.getElementById(CARD_ID);
    if (!card) return;
    card.classList.remove('is-loading');
    card.style.display = 'none';
  }

  function isOnPlayerPage() {
    return /#\/player/.test(location.href);
  }

  function getSeekSlider() {
    return document.querySelector('[class*="seek-bar-container"] [class*="slider-container"]') || null;
  }

  function bufferEnd(current) {
    const reported = Number(window.StremioCustomPlayback?.getCacheAheadSec?.() || 0);
    if (!(reported > 0)) return current;
    // Same reading as the white bar: seconds ahead of the playhead.
    return current + Math.min(reported, 30);
  }

  function inBuffer(seconds) {
    const current = Number(window.StremioCustomPlayback?.getCurrentTime?.());
    if (!Number.isFinite(current)) return false;
    return seconds >= current && seconds <= bufferEnd(current);
  }

  function requestFrame(path, seconds, bucket, local) {
    const key = frameKey(path, bucket);
    if (inflightKey === key) return;
    inflightKey = key;
    const gen = ++requestGen;
    const api = window.StremioCustom?.api;
    if (!api?.seekPreview) {
      inflightKey = '';
      return;
    }
    const finish = () => {
      if (inflightKey === key) inflightKey = '';
    };
    api.seekPreview(path, seconds, local).then((result) => {
      finish();
      if (gen !== requestGen) return;
      if (!result?.rgb) return;
      rememberFrame(key, result);
      const time = document.getElementById(TIME_ID);
      if (!time || time.style.display === 'none') return;
      if (time.dataset.bucket !== String(bucket)) return;
      paintFrame(result);
    }).catch(() => {
      finish();
      if (gen !== requestGen) return;
      const time = document.getElementById(TIME_ID);
      if (!time || time.dataset.bucket !== String(bucket)) return;
      hideFrame();
    });
  }

  function bindHoverPreview(slider) {
    if (!slider || slider === hoverBoundSlider) return;
    hoverBoundSlider = slider;

    const hide = () => {
      requestGen += 1;
      inflightKey = '';
      const time = document.getElementById(TIME_ID);
      if (time) time.style.display = 'none';
      hideFrame();
      if (hoverTimer) window.clearTimeout(hoverTimer);
    };

    const showAt = (event) => {
      if (!isPluginEnabled()) {
        teardown();
        return;
      }
      const rect = slider.getBoundingClientRect();
      if (rect.width <= 0 || !(durationSec > 0)) {
        hide();
        return;
      }
      const x = Math.max(rect.left, Math.min(event.clientX, rect.right));
      const ratio = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
      const seconds = durationSec * ratio;
      const bucket = bucketOf(seconds);
      const time = getTime();
      time.textContent = formatTime(seconds);
      placeAt(x, rect.top);
      time.style.display = 'block';
      time.dataset.bucket = String(bucket);

      const path = currentPath();
      const cached = frames.get(frameKey(path, bucket));
      if (cached) {
        if (hoverTimer) window.clearTimeout(hoverTimer);
        paintFrame(cached);
        return;
      }
      if (!previewAllowed(path)) {
        hideFrame();
        return;
      }
      const buffered = inBuffer(seconds);
      if (!buffered) showLoading();
      if (hoverTimer) window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => {
        if (time.dataset.bucket !== String(bucket) || time.style.display === 'none') return;
        requestFrame(path, seconds, bucket, buffered);
      }, DEBOUNCE_MS);
    };

    slider.addEventListener('mouseenter', showAt);
    slider.addEventListener('mousemove', showAt);
    slider.addEventListener('mouseleave', hide);
    slider.addEventListener('pointerleave', hide);
  }

  function stopLoop() {
    if (loopTimer) window.clearInterval(loopTimer);
    loopTimer = null;
    loopIntervalMs = 0;
    const time = document.getElementById(TIME_ID);
    if (time) time.style.display = 'none';
    hideFrame();
  }

  function ensureLoop(ms) {
    if (loopTimer && loopIntervalMs === ms) return;
    if (loopTimer) window.clearInterval(loopTimer);
    loopIntervalMs = ms;
    loopTimer = window.setInterval(tick, ms);
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
    injectStyles();
    const slider = getSeekSlider();
    bindHoverPreview(slider);
    ensureLoop(hoverBoundSlider && hoverBoundSlider === slider ? SLOW_POLL_MS : FAST_POLL_MS);
  }

  function start() {
    if (!isPluginEnabled()) return;
    injectStyles();
    rememberDuration(window.__stremioPlaybackDurationHint);
    tick();
    if (!loopTimer) ensureLoop(FAST_POLL_MS);
  }

  document.addEventListener('stremio-custom-route-change', () => {
    if (isOnPlayerPage()) start();
    else stopLoop();
  });
  document.addEventListener('stremio-custom-playback-stopped', () => {
    streamPath = '';
    frames.clear();
    stopLoop();
  });
  document.addEventListener('stremio-custom-stream-started', (event) => {
    const next = String(event?.detail?.path || '');
    if (next !== streamPath) {
      streamPath = next;
      frames.clear();
    }
    if (isOnPlayerPage()) start();
  });
  document.addEventListener('stremio-custom-duration-hint', (event) => {
    rememberDuration(event?.detail?.duration);
  });
  document.addEventListener('stremio-custom-duration', (event) => {
    rememberDuration(event?.detail?.duration);
  });
  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    if (isOnPlayerPage()) start();
  });
  if (isOnPlayerPage()) start();
})();
