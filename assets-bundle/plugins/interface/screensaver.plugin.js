/**
 * @name Screensaver
 * @description After a set idle time, shows a fullscreen slideshow of the Dynamic Hero titles. Any input closes it.
 * @version 1.0.0
 * @author MyStremio
 * @category interface
 */
/* jshint esversion: 11, browser: true, devel: true */

(function () {
  'use strict';

  if (window.__stremioScreensaverReady) return;
  window.__stremioScreensaverReady = true;

  const PLUGIN_ID = 'screensaver';
  const PLUGIN_REF = 'interface/screensaver.plugin.js';
  const ROOT_ID = 'mystremio-screensaver';
  const STYLE_ID = 'mystremio-screensaver-styles';
  const HERO_CACHE_KEY = 'mystremio_hero_titles_v1'; // written by the Dynamic Hero
  const SLIDE_MS = 8000; // same rotation as the hero
  const FADE_MS = 350;
  const INPUT_EVENTS = ['click', 'pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];

  let idleMs = 5 * 60000;
  let idleTimer = null;
  let slideTimer = null;
  let root = null;
  let shownAt = 0;
  let titles = [];
  let swallowClick = false;
  let index = 0;

  function api() {
    return window.StremioCustomAPI || window.StremioEnhancedAPI || null;
  }

  function isEnabled() {
    const helpers = window.StremioCustom?.helpers;
    return Boolean(helpers?.isPluginEnabled?.(PLUGIN_REF));
  }

  async function loadIdleTime() {
    try {
      const value = await api()?.getSetting?.(PLUGIN_ID, 'minutes');
      const minutes = Number(value);
      if (Number.isFinite(minutes) && minutes > 0) idleMs = minutes * 60000;
    } catch (_) {}
  }

  function readTitles() {
    try {
      const list = JSON.parse(localStorage.getItem(HERO_CACHE_KEY) || '[]');
      return Array.isArray(list) ? list.filter((t) => t && t.background) : [];
    } catch (_) {
      return [];
    }
  }

  function canStart() {
    if (!isEnabled() || document.hidden) return false;
    return !isPlaying();
  }

  function isPlaying() {
    // MPV renders natively, so the player route asks the playback API instead of <video>.
    if (/^#\/player(\/|$|\?)/.test(location.hash)) {
      return !window.StremioCustomPlayback?.getMpvSnapshot?.()?.paused;
    }
    return Array.from(document.querySelectorAll('video')).some((v) => !v.paused);
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // Fonts and spacing come from the theme's .hero-overlay-* rules, so slides match the hero banner.
    style.textContent = `
#${ROOT_ID} { position: fixed; inset: 0; z-index: 100000; background: #141414; cursor: none; overflow: hidden; }
#${ROOT_ID} .ss-slide { position: absolute; inset: 0; transition: opacity ${FADE_MS}ms ease-in-out; }
#${ROOT_ID} .ss-slide.ss-fading { opacity: 0; }
#${ROOT_ID} .ss-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 18%; }
#${ROOT_ID} .ss-slide::after { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(to top, rgb(20,20,20) 0%, rgba(20,20,20,.72) 14%, rgba(20,20,20,.26) 36%, rgba(20,20,20,0) 68%),
              linear-gradient(to right, rgba(0,0,0,.48) 0%, rgba(0,0,0,.18) 22%, rgba(0,0,0,0) 58%); }
#${ROOT_ID} .hero-overlay { position: absolute; left: 0; right: 0; bottom: 0; z-index: 1; padding: 0 2rem 3rem; box-sizing: border-box; color: #fff; }
#${ROOT_ID} .hero-overlay-image { display: block; max-width: 420px; max-height: 25vh; object-fit: contain; object-position: left bottom; }
#${ROOT_ID} .hero-overlay-description { max-width: 500px; }
#${ROOT_ID} .hero-overlay-info { display: flex; gap: 15px; align-items: center; }
#${ROOT_ID} .hero-overlay-info p { margin: 0; }
`;
    document.head.appendChild(style);
  }

  function renderSlide(slide, title) {
    const details = [title.year];
    if (title.duration && title.duration !== 'Unknown') details.push(title.duration);
    if (title.seasons && title.seasons !== 'Unknown') details.push(title.seasons);
    if (title.rating && title.rating !== 'na') details.push(`★ ${title.rating}/10`);

    const image = document.createElement('img');
    image.className = 'ss-image';
    image.src = title.background;
    image.alt = '';

    const overlay = document.createElement('div');
    overlay.className = 'hero-overlay';
    if (title.logo) {
      const logo = document.createElement('img');
      logo.className = 'hero-overlay-image';
      logo.src = title.logo;
      logo.alt = title.title || '';
      overlay.appendChild(logo);
    }
    const plot = document.createElement('p');
    plot.className = 'hero-overlay-description';
    plot.textContent = title.description || '';
    const info = document.createElement('div');
    info.className = 'hero-overlay-info';
    details.filter(Boolean).forEach((text) => {
      const p = document.createElement('p');
      p.textContent = String(text);
      info.appendChild(p);
    });
    overlay.append(plot, info);
    slide.replaceChildren(image, overlay);
  }

  function nextSlide() {
    const slide = root?.firstElementChild;
    if (!slide) return;
    if (isPlaying()) return stop(); // playback resumed without input, e.g. a media key or remote
    index = (index + 1) % titles.length;
    new Image().src = titles[(index + 1) % titles.length].background; // preload the one after
    slide.classList.add('ss-fading');
    setTimeout(() => {
      if (!root) return;
      renderSlide(slide, titles[index]);
      slide.classList.remove('ss-fading');
    }, FADE_MS);
  }

  function start() {
    if (root || !canStart()) return;
    titles = readTitles();
    if (!titles.length) return;
    ensureStyles();
    index = Math.floor(Math.random() * titles.length);
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('aria-hidden', 'true');
    const slide = document.createElement('div');
    slide.className = 'ss-slide';
    renderSlide(slide, titles[index]);
    root.appendChild(slide);
    document.body.appendChild(root);
    shownAt = Date.now();
    if (titles.length > 1) slideTimer = setInterval(nextSlide, SLIDE_MS);
  }

  function stop() {
    clearInterval(slideTimer);
    slideTimer = null;
    root?.remove();
    root = null;
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(start, idleMs);
  }

  function onInput(event) {
    if (event.type === 'click') {
      if (swallowClick) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      swallowClick = false;
      return;
    }
    if (root) {
      // Ignore the synthetic pointermove WebView fires when the overlay appears under the cursor.
      if (event.type === 'pointermove' && Date.now() - shownAt < 1000) return;
      // The input that wakes the app must not also click or type into the page below.
      if (event.type !== 'pointermove') {
        event.preventDefault();
        event.stopImmediatePropagation();
        swallowClick = event.type === 'pointerdown';
      }
      stop();
    }
    resetIdle();
  }

  function init() {
    INPUT_EVENTS.forEach((type) => window.addEventListener(type, onInput, { capture: true, passive: false }));
    window.addEventListener('hashchange', () => { stop(); resetIdle(); });
    api()?.onSettingsSaved?.(PLUGIN_ID, () => loadIdleTime().then(resetIdle));
    loadIdleTime().then(resetIdle);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
