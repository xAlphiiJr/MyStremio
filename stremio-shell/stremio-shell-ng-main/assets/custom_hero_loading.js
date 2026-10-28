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

  function firstRealPoster() {
    const imgs = document.querySelectorAll('[class*="board-content"] img[class*="poster-image"]');
    for (const img of imgs) {
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (src && !PLACEHOLDER_SRC.test(src)) return img;
    }
    return null;
  }

  function firstPosterReady() {
    const img = firstRealPoster();
    return Boolean(img && img.complete && img.naturalWidth > 0);
  }

  // shortcut: a board with no poster slot and no catalog row; a slow addon keeps the bar
  function nothingToWaitFor() {
    const board = document.querySelector('[class*="board-content"]');
    if (!board || board.children.length < 2) return false;
    return !board.querySelector('img[class*="poster-image"], [class*="placeholder"], [class*="meta-row-container"], [class*="continue-watching-row"]');
  }

  function posterGateOpen() {
    return firstPosterReady() || nothingToWaitFor();
  }

  function prioritizeFirstPoster() {
    if (window.__mystremioFirstPosterReady) return;
    const imgs = document.querySelectorAll('[class*="board-content"] img[class*="poster-image"]');
    let first = null;
    for (const img of imgs) {
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (!src || PLACEHOLDER_SRC.test(src)) continue;
      if (!first) {
        first = img;
        if (img.fetchPriority !== 'high') img.fetchPriority = 'high';
      } else if (img.fetchPriority !== 'low') {
        img.fetchPriority = 'low';
      }
    }
    if (!first || first.dataset.mystremioPosterWatch) return;
    first.dataset.mystremioPosterWatch = '1';
    first.addEventListener('load', () => tick(), { once: true });
  }

  function releaseNextRows() {
    if (window.__mystremioBoardFollowUp) return;
    const load = window.__mystremioBoardLoadVisibleRange;
    if (typeof load !== 'function') return;
    window.__mystremioBoardFollowUp = true;
    load({ start: 0, end: 4 });
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
        width: 100% !important;
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
    if (!isBoardRoute() || window.__mystremioFirstPosterReady) return;
    document.querySelectorAll('[class*="hero-slot"]').forEach((slot) => {
      setSlotLoading(slot);
    });
  }

  function clearLoadingWhenReady() {
    const done = posterGateOpen();
    window.__mystremioFirstPosterReady = done;
    if (!done) return;
    releaseNextRows();
    document.querySelectorAll('[class*="hero-slot"][data-state="loading"]').forEach((slot) => {
      if (isFallbackHeroContent(slot)) return;
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
    prioritizeFirstPoster();
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

  // getComputedStyle flushes layout for the whole board. Keep the node; look again only when it is gone.
  let boardScrollerEl = null;
  function boardScroller() {
    if (boardScrollerEl && boardScrollerEl.isConnected) return boardScrollerEl;
    boardScrollerEl = null;
    const board = document.querySelector('[class*="board-container"]');
    if (!board) return null;
    for (const el of board.querySelectorAll('[class*="board-content"]')) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
        boardScrollerEl = el;
        return el;
      }
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

  function heroWaitDone(posterReady, hasContinueRow, hasToggle) {
    return Boolean(posterReady) && (!hasContinueRow || hasToggle);
  }

  function boardHeroSettled() {
    const scroller = boardScroller();
    const row = scroller ? continueRow(scroller) : null;
    const hasToggle = Boolean(scroller?.querySelector('[class*="hero-indicators"] > .mystremio-cw-toggle'));
    return heroWaitDone(posterGateOpen(), Boolean(row), hasToggle);
  }

  function ensureCwToggle() {
    const scroller = boardScroller();
    if (!scroller) return;
    const row = continueRow(scroller);
    watchCwHost();
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
  }

  if (!isBoardHash('#/?streamingServerUrl=http%3A%2F%2F127.0.0.1%3A11470%2F')) throw new Error('shell board hash');
  if (isBoardHash('#/player/x')) throw new Error('player is not the board');
  if (cwFactors(0).pad !== 1 || cwFactors(0).opacity !== 1 || cwFactors(0).margin !== 1) throw new Error('cw stays over the hero');
  if (cwFactors(1).pad !== 0 || cwFactors(1).opacity !== 0) throw new Error('cw toggle hides');
  if (cwRevealAfterScroll(1, 5) !== 0) throw new Error('scroll down restores cw');
  if (cwRevealAfterScroll(1, 4) !== 1 || cwRevealAfterScroll(1, -8) !== 1) throw new Error('scroll jitter keeps hero');
  if (cwRevealAfterScroll(0, 20) !== 0) throw new Error('shown cw stays');
  if (heroWaitDone(false, false, false) || heroWaitDone(false, true, true)) throw new Error('hero wait stops before the poster');
  if (!heroWaitDone(true, false, false) || !heroWaitDone(true, true, true)) throw new Error('hero wait stays after the poster');
  if (heroWaitDone(true, true, false)) throw new Error('hero wait stops before the toggle');

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
    if (boardHeroSettled()) stopHeroInterval();
  };

  let cwWatch = null;
  const cwObserver = new MutationObserver(() => {
    if (!isBoardRoute() || boardHeroSettled()) return;
    tick();
  });

  function watchCwHost() {
    const scroller = boardScroller();
    const hero = scroller?.querySelector('[class*="hero-row"]');
    const host = hero?.parentElement || scroller;
    if (!host || cwWatch === host) return;
    cwObserver.disconnect();
    cwObserver.observe(host, { childList: true });
    cwWatch = host;
  }
  window.__stremioCustomHeroLoadingEnsure = tick;

  tick();
  document.addEventListener('stremio-custom-route-change', () => window.setTimeout(tick, 50));
  document.addEventListener('DOMContentLoaded', tick);
  window.addEventListener('load', tick);
  if (isBoardRoute()) ensureHeroInterval();
})();
