(function () {
  'use strict';

  if (window.self !== window.top) return;
  if (window.__stremioCustomHeroLoading) return;
  window.__stremioCustomHeroLoading = true;

  const STYLE_ID = 'mystremio-hero-loading-style';
  const FALLBACK_HERO_ID = 'tt0903747';
  const PLACEHOLDER_SRC = /stremio_symbol|anonymous\.png|placeholder/i;

  function isBoardRoute() {
    const hash = location.hash || '#/';
    return hash === '#/' || hash === '#/board' || /^#\/board(?:\/|$|\?|#)/.test(hash);
  }

  function isFallbackHeroContent(slot) {
    const imgs = slot.querySelectorAll('[class*="hero-container"] img[src], [class*="hero-image-stack"] img[src]');
    for (const img of imgs) {
      const src = img.getAttribute('src') || img.src || '';
      if (src && (src.includes(FALLBACK_HERO_ID) || /breaking[\s_-]?bad/i.test(src))) {
        return true;
      }
    }

    const titleNode = slot.querySelector('[class*="hero-title"], [class*="hero-overlay"] h1, [class*="hero-overlay"] h2');
    const title = String(titleNode?.textContent || '').trim();
    if (/^breaking bad$/i.test(title)) return true;

    return false;
  }

  function hasRealHeroImage(slot) {
    const img = slot.querySelector('[class*="hero-container"] img[src], [class*="hero-image-stack"] img[src]');
    const src = img?.getAttribute('src') || img?.src || '';
    if (!src || PLACEHOLDER_SRC.test(src)) return false;
    if (src.includes(FALLBACK_HERO_ID) || /breaking[\s_-]?bad/i.test(src)) return false;
    return true;
  }

  /**
   * Ensures the hero slot has a loader with a horizontal progress bar only.
   * @param {Element} slot
   */
  function ensureSlotLoader(slot) {
    let loader = slot.querySelector('[class*="hero-slot-loader"], .mystremio-hero-slot-loader');
    if (!loader) {
      loader = document.createElement('div');
      loader.className = 'mystremio-hero-slot-loader';
      loader.setAttribute('aria-hidden', 'true');
      slot.appendChild(loader);
    }

    let bar = loader.querySelector('.mystremio-hero-slot-progress, [class*="hero-slot-progress"], [class*="hero-slot-spinner"]');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'mystremio-hero-slot-progress';
      loader.appendChild(bar);
    } else {
      bar.classList.add('mystremio-hero-slot-progress');
    }
  }

  function setSlotLoading(slot) {
    ensureSlotLoader(slot);
    slot.dataset.state = 'loading';
  }

  function clearSlotLoading(slot) {
    if (slot.dataset.state !== 'loading') return;
    delete slot.dataset.state;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      [class*="hero-slot"][data-state="loading"] [class*="hero-container"],
      [class*="hero-slot"][data-state="loading"] [class*="hero-overlay"],
      [class*="hero-slot"][data-state="loading"] [class*="hero-image-stack"],
      [class*="hero-slot"][data-state="loading"] [class*="hero-controls"],
      [class*="hero-slot"][data-state="loading"] [class*="hero-indicators"] {
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }

      [class*="hero-slot"][data-state="loading"] [class*="hero-slot-loader"],
      [class*="hero-slot"][data-state="loading"] .mystremio-hero-slot-loader {
        display: flex !important;
        flex-direction: row !important;
        align-items: center !important;
        justify-content: center !important;
        position: absolute !important;
        inset: 0 !important;
        z-index: 5 !important;
        min-height: 18rem !important;
        width: 100% !important;
        opacity: 1 !important;
        visibility: visible !important;
        background: linear-gradient(135deg, #0c0c0c 0%, #1a1a1a 50%, #0c0c0c 100%) !important;
      }

      [class*="hero-slot"][data-state="loading"] [class*="hero-slot-loader"]::before,
      [class*="hero-slot"][data-state="loading"] [class*="hero-slot-loader"]::after,
      [class*="hero-slot"][data-state="loading"] .mystremio-hero-slot-loader::before,
      [class*="hero-slot"][data-state="loading"] .mystremio-hero-slot-loader::after {
        content: none !important;
        display: none !important;
        animation: none !important;
      }

      [class*="hero-slot"][data-state="loading"] .mystremio-hero-slot-progress,
      [class*="hero-slot"][data-state="loading"] [class*="hero-slot-progress"],
      [class*="hero-slot"][data-state="loading"] [class*="hero-slot-spinner"] {
        position: relative !important;
        width: min(320px, 70vw) !important;
        height: 4px !important;
        border: none !important;
        border-radius: 999px !important;
        background: rgba(255, 255, 255, 0.12) !important;
        overflow: hidden !important;
        flex: none !important;
        animation: none !important;
        transform: none !important;
      }

      [class*="hero-slot"][data-state="loading"] .mystremio-hero-slot-progress::after,
      [class*="hero-slot"][data-state="loading"] [class*="hero-slot-progress"]::after,
      [class*="hero-slot"][data-state="loading"] [class*="hero-slot-spinner"]::after {
        content: '' !important;
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: 40% !important;
        height: 100% !important;
        border-radius: inherit !important;
        background: linear-gradient(
          90deg,
          rgba(255, 255, 255, 0.2) 0%,
          rgba(255, 255, 255, 0.95) 50%,
          rgba(255, 255, 255, 0.2) 100%
        ) !important;
        animation: mystremio-hero-bar 1.15s ease-in-out infinite !important;
      }

      @keyframes mystremio-hero-bar {
        0% { transform: translateX(-120%); }
        100% { transform: translateX(280%); }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function markLoadingSlots() {
    if (!isBoardRoute()) return;
    document.querySelectorAll('[class*="hero-slot"]').forEach((slot) => {
      if (isFallbackHeroContent(slot)) {
        setSlotLoading(slot);
        return;
      }
      if (hasRealHeroImage(slot)) return;
      const hasHero = slot.querySelector('[class*="hero-container"], [class*="hero-image-stack"]');
      if (!hasHero) return;
      setSlotLoading(slot);
    });
  }

  function clearLoadingWhenReady() {
    document.querySelectorAll('[class*="hero-slot"][data-state="loading"]').forEach((slot) => {
      if (isFallbackHeroContent(slot)) return;
      if (!hasRealHeroImage(slot)) return;
      clearSlotLoading(slot);
    });
  }

  function tick() {
    if (!isBoardRoute()) return;
    ensureStyles();
    markLoadingSlots();
    clearLoadingWhenReady();
  }

  window.__stremioCustomHeroLoadingEnsure = tick;

  tick();
  window.addEventListener('hashchange', () => window.setTimeout(tick, 50));
  document.addEventListener('DOMContentLoaded', tick);
  window.addEventListener('load', tick);
  if (!window.__stremioCustomHeroLoadingInterval) {
    window.__stremioCustomHeroLoadingInterval = window.setInterval(tick, 400);
  }
})();
