(function () {
  'use strict';

  if (window.self !== window.top) return;
  if (window.__stremioCustomHeroLoading) return;
  window.__stremioCustomHeroLoading = true;

  const STYLE_ID = 'mystremio-hero-loading-style';
  const FALLBACK_HERO_ID = 'tt0903747';
  const PLACEHOLDER_SRC = /stremio_symbol|anonymous\.png|placeholder/i;

  function isBoardHash(hash) {
    const h = hash || '';
    if (!h || h === '#/' || h === '#') return true;
    if (h.includes('/board')) return true;
    // Shell home is #/?streamingServerUrl=..., not #/.
    return /^#\/?\?/.test(h);
  }

  function isBoardRoute() {
    return isBoardHash(location.hash);
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

      /* Beats the hashed main.css overlap rule, including a stale service-worker copy. */
      #app [class*="board-container"] [class*="board-content"] .hero-row-MReGl + [class*="continue-watching-row"],
      #app [class*="board-container"] [class*="board-content"] [class*="hero-row"] + [class*="continue-watching-row"] {
        margin-top: calc(-1 * var(--mystremio-hero-cw-h, 0px)) !important;
        opacity: calc(1 - var(--mystremio-cw-reveal, 0)) !important;
        transition: opacity 0.35s ease;
      }
      #app [class*="board-content"].mystremio-cw-collapsed .hero-row-MReGl + [class*="continue-watching-row"],
      #app [class*="board-content"].mystremio-cw-collapsed [class*="hero-row"] + [class*="continue-watching-row"],
      #app [class*="board-content"].mystremio-cw-collapsed [class*="continue-watching-row"] {
        height: var(--mystremio-hero-cw-h, 0px) !important;
        min-height: var(--mystremio-hero-cw-h, 0px) !important;
        overflow: hidden !important;
        pointer-events: none !important;
      }
      #app [class*="board-content"].mystremio-cw-collapsed [class*="continue-watching-row"] > * {
        display: none !important;
      }
      #app [class*="board-content"] .hero-container-fUAsb,
      #app [class*="board-content"] [class*="hero-container"] {
        padding-bottom: calc(var(--mystremio-hero-cw-h, 0px) * (1 - var(--mystremio-cw-reveal, 0))) !important;
        transition: padding-bottom 0.35s ease;
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
    if (!isBoardRoute()) {
      stopHeroInterval();
      return;
    }
    ensureHeroInterval();
    ensureStyles();
    markLoadingSlots();
    clearLoadingWhenReady();
  }

  /**
   * Stops the board hero poll while off the board route.
   */
  function stopHeroInterval() {
    if (!window.__stremioCustomHeroLoadingInterval) return;
    window.clearInterval(window.__stremioCustomHeroLoadingInterval);
    window.__stremioCustomHeroLoadingInterval = null;
  }

  /**
   * Starts the hero poll only while the board is active.
   */
  function ensureHeroInterval() {
    if (window.__stremioCustomHeroLoadingInterval) return;
    window.__stremioCustomHeroLoadingInterval = window.setInterval(tick, 400);
  }

  window.__stremioCustomHeroLoadingEnsure = tick;

  let cwReveal = 0;

  function cwFactors(reveal) {
    const shown = 1 - reveal;
    return { margin: 1, pad: shown, opacity: shown };
  }

  /** Scroll down while the hero is open puts it back; jitter and scroll-up do not. */
  function cwRevealAfterScroll(reveal, delta) {
    return reveal >= 1 && delta > 4 ? 0 : reveal;
  }

  function boardScroller() {
    const board = document.querySelector('[class*="board-container"]');
    if (!board) return null;
    for (const el of board.querySelectorAll('[class*="board-content"]')) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return el;
    }
    return null;
  }

  function continueRow(scroller) {
    const hero = scroller.querySelector('[class*="hero-row"]');
    const next = hero && hero.nextElementSibling;
    if (!next || !/continue-watching-row/.test(next.className)) return null;
    return next;
  }

  function applyCwReveal(scroller) {
    if (!scroller) return;
    scroller.classList.toggle('mystremio-cw-collapsed', cwReveal >= 1);
    if (cwReveal > 0) scroller.style.setProperty('--mystremio-cw-reveal', String(cwReveal));
    else scroller.style.removeProperty('--mystremio-cw-reveal');
  }

  function paintCwToggle(btn) {
    const hidden = cwReveal >= 1;
    btn.classList.toggle('is-collapsed', hidden);
    btn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    btn.setAttribute('aria-label', hidden ? 'Show continue watching' : 'Hide continue watching');
  }

  function ensureCwToggle() {
    const scroller = boardScroller();
    if (!scroller) return;
    const row = continueRow(scroller);
    const indicators = scroller.querySelector('[class*="hero-indicators"]');
    if (!row) {
      indicators?.querySelector(':scope > .mystremio-cw-toggle')?.remove();
      if (cwReveal) {
        cwReveal = 0;
        applyCwReveal(scroller);
      }
      return;
    }
    if (!indicators) return;
    let btn = indicators.querySelector(':scope > .mystremio-cw-toggle');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mystremio-cw-toggle';
      const mark = document.createElement('span');
      mark.setAttribute('aria-hidden', 'true');
      btn.appendChild(mark);
      indicators.insertBefore(btn, indicators.firstChild);
    }
    paintCwToggle(btn);
    row.toggleAttribute('aria-hidden', cwReveal >= 1);
    watchCwHost();
  }

  if (!isBoardHash('#/?streamingServerUrl=http%3A%2F%2F127.0.0.1%3A11470%2F')) throw new Error('shell board hash');
  if (isBoardHash('#/player/x')) throw new Error('player is not the board');
  if (cwFactors(0).pad !== 1 || cwFactors(0).opacity !== 1 || cwFactors(0).margin !== 1) throw new Error('cw stays over the hero');
  if (cwFactors(1).pad !== 0 || cwFactors(1).opacity !== 0) throw new Error('cw toggle hides');
  if (cwRevealAfterScroll(1, 5) !== 0) throw new Error('scroll down restores cw');
  if (cwRevealAfterScroll(1, 4) !== 1 || cwRevealAfterScroll(1, -8) !== 1) throw new Error('scroll jitter keeps hero');
  if (cwRevealAfterScroll(0, 20) !== 0) throw new Error('shown cw stays');

  let cwScrollTop = 0;
  let cwScrollIgnore = false;

  // shortcut: two frames after the arrow, so the padding shift is not a scroll-down. Drop when toggle no longer changes scrollHeight.
  function armCwScroll() {
    cwScrollIgnore = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const live = boardScroller();
      cwScrollTop = live ? live.scrollTop : 0;
      cwScrollIgnore = false;
    }));
  }

  document.addEventListener('click', (event) => {
    const btn = event.target?.closest?.('.mystremio-cw-toggle');
    if (!btn || !isBoardRoute()) return;
    event.preventDefault();
    event.stopPropagation();
    cwReveal = cwReveal >= 1 ? 0 : 1;
    applyCwReveal(boardScroller());
    ensureCwToggle();
    armCwScroll();
  }, true);

  document.addEventListener('scroll', (event) => {
    const el = event.target;
    if (!el || el === document || !String(el.className || '').includes('board-content')) return;
    const delta = el.scrollTop - cwScrollTop;
    cwScrollTop = el.scrollTop;
    if (cwScrollIgnore || cwReveal < 1 || !isBoardRoute()) return;
    if (cwRevealAfterScroll(cwReveal, delta) === cwReveal) return;
    cwReveal = 0;
    applyCwReveal(el);
    ensureCwToggle();
  }, true);

  document.addEventListener('stremio-custom-route-change', () => {
    if (isBoardRoute()) return;
    cwReveal = 0;
    applyCwReveal(boardScroller());
  });

  const heroTick = tick;
  tick = function cwTick() {
    heroTick();
    if (!isBoardRoute()) return;
    applyCwReveal(boardScroller());
    ensureCwToggle();
  };

  let cwWatch = null;
  const cwObserver = new MutationObserver(() => {
    if (!isBoardRoute()) return;
    ensureCwToggle();
  });

  function watchCwHost() {
    const scroller = boardScroller();
    const host = scroller?.querySelector('[class*="hero-slot"]') || scroller;
    if (!host || cwWatch === host) return;
    cwObserver.disconnect();
    cwObserver.observe(host, { childList: true, subtree: true });
    cwWatch = host;
  }
  window.__stremioCustomHeroLoadingEnsure = tick;

  tick();
  document.addEventListener('stremio-custom-route-change', () => window.setTimeout(tick, 50));
  document.addEventListener('DOMContentLoaded', tick);
  window.addEventListener('load', tick);
  if (isBoardRoute()) ensureHeroInterval();
})();
