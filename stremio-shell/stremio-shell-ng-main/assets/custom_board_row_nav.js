/**
 * Board row horizontal navigation: lock board-content.scrollLeft so the hero
 * cannot shift, give meta rows their own overflow-x scrollport, left/right
 * chevrons, arrow-key focus scrolling, and on-demand catalog growth.
 *
 * MetaRow starts at CATALOG_PREVIEW_SIZE items. At the end of a row, the right
 * chevron raises window.__mystremioBoardReveal and only then may LoadNextPage.
 * Item widths are frozen after growth so extras scroll instead of shrinking.
 */
(function () {
  'use strict';

  if (window.__stremioCustomBoardRowNav) return;
  window.__stremioCustomBoardRowNav = true;

  const STYLE_ID = 'mystremio-board-row-nav-styles';
  const CHEVRON_RIGHT = 'mystremio-board-row-chevron-right';
  const CHEVRON_LEFT = 'mystremio-board-row-chevron-left';
  const ROW_WRAP_CLASS = 'mystremio-board-row-scroll-wrap';
  const ROW_SCROLLPORT_CLASS = 'mystremio-board-row-scrollport';
  const OVERLAY_CLASS = 'mystremio-board-row-nav-overlay';
  const WIDTH_FROZEN_ATTR = 'data-mystremio-width-frozen';
  const LOAD_EXHAUSTED_ATTR = 'data-mystremio-load-exhausted';
  const SCROLL_EPS = 8;
  const LOAD_WAIT_MS = 1200;
  /** Matches stremio-web CATALOG_PREVIEW_SIZE — reveal grows by this step. */
  const CATALOG_PREVIEW_SIZE = 10;
  /** Debounce enhance while the board mutates during fast vertical scroll. */
  const ENHANCE_DEBOUNCE_MS = 180;
  /** Pause MutationObserver during fast vertical board scroll; resume after idle. */
  const SCROLL_IDLE_MS = 180;
  const WIDTH_RETRY_MS = 200;
  /** Short TTL for catalog index / buffer count getState round-trips. */
  const STATE_CACHE_MS = 300;
  /** Keep Titlebar paused briefly after reveal / LoadNextPage. */
  const ROW_BUSY_IDLE_MS = 400;
  const ITEM_COUNT_ATTR = 'data-mystremio-nav-items';
  const NAV_READY_ATTR = 'data-mystremio-nav-ready';

  let enhancing = false;
  /** @type {boolean} Schedule another enhance after the current pass finishes. */
  let enhanceQueued = false;
  let lastSyncAt = 0;
  let containmentPinned = false;
  let heroNotifyPending = false;
  let observerPaused = false;
  let scrollIdleTimer = null;
  let boardVertScrollBound = false;
  let renderBumpRaf = 0;
  /** @type {Element|null} Current MutationObserver root (board-container). */
  let observerRoot = null;
  let rowBusyIdleTimer = null;
  /** @type {number[]} */
  let enterRetryTimers = [];
  /** @type {Map<Element, ResizeObserver|{disconnect(): void}>} */
  const chevronLayoutObservers = new Map();
  /** Named scroll handlers so catalog teardown can remove listeners. */
  const rowScrollHandlers = new WeakMap();
  /** Per-catalog LoadNextPage in-flight lock. */
  const loadInFlight = new Set();
  /** @type {Set<Element>} Rows waiting for a scoped enhance pass. */
  const pendingEnhanceRows = new Set();
  /**
   * Cached catalog index per row element.
   * @type {WeakMap<Element, {at: number, index: number}>}
   */
  const catalogIndexCache = new WeakMap();
  /**
   * Cached Core buffer counts keyed by catalog index.
   * @type {Map<number, {at: number, count: number}>}
   */
  const bufferedCountCache = new Map();

  /**
   * @returns {boolean}
   */
  function isBoardRoute() {
    const h = location.hash || '';
    if (!h || h === '#/' || h === '#') return true;
    if (h.includes('/board')) return true;
    if (/^#\/?\?/.test(h)) return true;
    return false;
  }

  /**
   * @returns {Element|null}
   */
  function getBoardScrollEl() {
    const board = document.querySelector('[class*="board-container"]');
    if (!board) return null;
    const candidates = board.querySelectorAll('[class*="board-content"]');
    for (const el of candidates) {
      const overflowY = window.getComputedStyle(el).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
        return el;
      }
    }
    return (
      board.querySelector('[class*="board-content-container"] [class*="board-content"]') ||
      document.querySelector('[class*="board-content"]')
    );
  }

  /**
   * Hard-lock horizontal board scroll (focus must never pan the hero).
   */
  function lockBoardScrollLeft() {
    const board = getBoardScrollEl();
    if (board && board.scrollLeft !== 0) board.scrollLeft = 0;
  }

  function isCatalogScrollEnabled() {
    return Boolean(window.__mystremioCatalogScrollEnabled);
  }

  /**
   * Inject layout CSS: board x-lock, stock item sizes, hidden scrollbars, chevrons.
   * Catalog scrollport / content-visibility rules only when Horizontal Navigation is on.
   */
  function injectStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    const catalogOn = isCatalogScrollEnabled();
    const catalogContain = catalogOn
      ? `
      #app [class*="board-container"] [class*="meta-row-container"]:not([class*="continue-watching"]) {
        position: relative;
        overflow-x: clip;
      }
      @supports not (overflow: clip) {
        #app [class*="board-container"] [class*="meta-row-container"]:not([class*="continue-watching"]) {
          overflow-x: hidden;
        }
      }
      #app [class*="board-container"] [class*="meta-row-container"]:not([class*="continue-watching"])
        [class*="meta-items-container"].${ROW_SCROLLPORT_CLASS} > [class*="meta-item"] {
        content-visibility: auto;
        contain-intrinsic-size: auto 280px;
      }`
      : '';
    style.textContent = `
      /* Never overflow-x on board-content (clips hero → grey stripe).
         Contain row ancestors only — exclude hero-row so hero can stay full-bleed. */
      #app [class*="board-container"] [class*="board-content"] > :not([class*="hero-row"]),
      #app [class*="board-container"] [class*="board-row"],
      #app [class*="board-container"] [class*="continue-watching-row"] {
        max-width: 100%;
        min-width: 0;
        box-sizing: border-box;
      }
      ${
        catalogOn
          ? `#app [class*="board-container"] [class*="meta-row-container"] {
        max-width: 100%;
        min-width: 0;
        box-sizing: border-box;
      }`
          : ''
      }
      #app [class*="board-container"] [class*="continue-watching-row"] {
        position: relative;
        overflow-x: clip;
      }
      @supports not (overflow: clip) {
        #app [class*="board-container"] [class*="continue-watching-row"] {
          overflow-x: hidden;
        }
      }
      ${catalogContain}
      /* Unhide stock nth-child{display:none} only — NEVER display:flex (breaks poster/title layout). */
      #app [class*="board-container"] [class*="meta-items-container"].${ROW_SCROLLPORT_CLASS} > [class*="meta-item"] {
        display: revert !important;
      }
      #app [class*="board-container"] [class*="meta-items-container"].${ROW_SCROLLPORT_CLASS} {
        width: 100% !important;
        max-width: 100% !important;
        min-width: 0 !important;
        box-sizing: border-box !important;
        flex-wrap: nowrap !important;
        overflow-x: auto !important;
        overflow-y: hidden !important;
        overscroll-behavior-x: contain !important;
        scroll-behavior: smooth;
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
      }
      #app [class*="board-container"] [class*="meta-items-container"].${ROW_SCROLLPORT_CLASS}::-webkit-scrollbar {
        width: 0 !important;
        height: 0 !important;
        display: none !important;
      }
      #app [class*="board-container"] .${CHEVRON_RIGHT},
      #app [class*="board-container"] .${CHEVRON_LEFT} {
        position: absolute;
        top: 0;
        transform: translateY(-50%);
        z-index: 5;
        width: 2.25rem;
        height: 2.25rem;
        border: none;
        border-radius: 999px;
        cursor: pointer;
        color: #fff;
        background: rgba(20, 20, 20, 0.72);
        display: none;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
        pointer-events: auto;
      }
      #app [class*="board-container"] .${CHEVRON_RIGHT} { right: 0.25rem; }
      #app [class*="board-container"] .${CHEVRON_LEFT} { left: 0.25rem; }
      #app [class*="board-container"] .${CHEVRON_RIGHT}:hover,
      #app [class*="board-container"] .${CHEVRON_LEFT}:hover {
        background: rgba(40, 40, 44, 0.9);
      }
      #app [class*="board-container"] .${CHEVRON_RIGHT}.visible,
      #app [class*="board-container"] .${CHEVRON_LEFT}.visible {
        display: inline-flex;
      }
      #app [class*="board-container"] .${CHEVRON_RIGHT} svg,
      #app [class*="board-container"] .${CHEVRON_LEFT} svg {
        width: 1.15rem;
        height: 1.15rem;
        fill: none;
        stroke: currentColor;
        stroke-width: 2.25;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      #app [class*="board-container"] .${ROW_WRAP_CLASS} {
        position: relative;
        max-width: 100%;
        min-width: 0;
      }
      #app [class*="board-container"] .${OVERLAY_CLASS} {
        position: absolute;
        inset: 0;
        z-index: 5;
        pointer-events: none;
      }
    `;
  }

  /**
   * @param {Element} item
   * @returns {Element|null}
   */
  function getMetaItemsContainer(item) {
    return item?.closest?.('[class*="meta-items-container"]') || null;
  }

  /**
   * @param {Element} rowItems
   * @returns {Element|null}
   */
  function getRowRoot(rowItems) {
    return (
      rowItems.closest('[class*="meta-row-container"]') ||
      rowItems.closest('[class*="continue-watching-row"]') ||
      rowItems.parentElement
    );
  }

  /**
   * Direct meta-item children of a row scrollport (same row only).
   * @param {Element} rowItems
   * @returns {HTMLElement[]}
   */
  function getRowDirectItems(rowItems) {
    return [...rowItems.children].filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      const cls = String(el.className || '');
      if (!cls.includes('meta-item')) return false;
      return el.getClientRects().length > 0 || el.offsetParent !== null;
    });
  }

  /**
   * @param {Element} rowItems
   * @returns {string}
   */
  function getRowTitle(rowItems) {
    const root = getRowRoot(rowItems);
    if (!root) return '';
    const titleEl =
      root.querySelector('[class*="title-container"]') ||
      root.querySelector('[class*="title-label"]') ||
      root.querySelector('h1, h2, h3');
    return String(titleEl?.textContent || '').trim();
  }

  /**
   * @param {Element} item
   */
  function scrollItemIntoRow(item) {
    const row = getMetaItemsContainer(item);
    if (!row || !(item instanceof HTMLElement)) return;

    lockBoardScrollLeft();

    const rowRect = row.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const pad = 16;
    if (itemRect.right > rowRect.right - pad) {
      row.scrollLeft += itemRect.right - rowRect.right + pad;
    } else if (itemRect.left < rowRect.left + pad) {
      row.scrollLeft -= rowRect.left + pad - itemRect.left;
    }
  }

  /**
   * Freeze each item to the current stock-rendered width so extras scroll instead of shrink.
   * @param {Element} rowItems
   * @param {number} [widthPx]
   */
  function freezeRowItemWidths(rowItems, widthPx) {
    const items = getRowDirectItems(rowItems);
    if (!items.length) return;
    let w = widthPx;
    if (!(w > 40)) {
      w = items[0].getBoundingClientRect().width;
    }
    if (!(w > 40)) return;
    const flex = `0 0 ${Math.round(w)}px`;
    for (const el of items) {
      // Skip writes when already frozen to this width (avoids style thrash on scroll).
      if (el.style.flex === flex) continue;
      el.style.flex = flex;
      el.style.width = '';
      el.style.minWidth = '';
      el.style.maxWidth = '';
    }
    rowItems.setAttribute(WIDTH_FROZEN_ATTR, '1');
    rowItems.setAttribute(ITEM_COUNT_ATTR, String(items.length));
  }

  /**
   * @param {Element} rowItems
   * @returns {number|null}
   */
  function readFrozenWidthPx(rowItems) {
    const existing = getRowDirectItems(rowItems).find((el) => el.style.flex);
    const match = existing?.style.flex?.match(/(\d+(?:\.\d+)?)px/);
    const px = match ? Number(match[1]) : 0;
    return px > 40 ? px : null;
  }

  /**
   * True when the row overlay still has both chevron buttons in the DOM.
   * @param {Element} row
   * @returns {boolean}
   */
  function rowHasChevrons(row) {
    const root = getRowRoot(row);
    if (!root) return false;
    const host = root.querySelector(`:scope > .${OVERLAY_CLASS}`);
    if (!host) return false;
    return !!(
      host.querySelector(`:scope > .${CHEVRON_LEFT}`) &&
      host.querySelector(`:scope > .${CHEVRON_RIGHT}`)
    );
  }

  /**
   * Row already has scrollport + freeze + chevrons for the current item count.
   * @param {Element} row
   * @returns {boolean}
   */
  function isRowNavReady(row) {
    if (!row.classList.contains(ROW_SCROLLPORT_CLASS)) return false;
    if (!row.hasAttribute(WIDTH_FROZEN_ATTR)) return false;
    if (row.getAttribute(NAV_READY_ATTR) !== '1') return false;
    if (!rowHasChevrons(row)) return false;
    const items = getRowDirectItems(row);
    const prev = Number(row.getAttribute(ITEM_COUNT_ATTR) || '0');
    return prev === items.length && items.length > 0;
  }

  /**
   * Coalesce Board re-render bumps to one per animation frame.
   */
  function requestBoardRender() {
    if (renderBumpRaf) return;
    renderBumpRaf = requestAnimationFrame(() => {
      renderBumpRaf = 0;
      const force = window.__mystremioBoardRequestRender;
      if (typeof force === 'function') {
        try {
          force();
        } catch (_) {
          /* ignore */
        }
      }
    });
  }

  /**
   * Clear frozen inline flex so stock ratios apply again.
   * @param {Element} rowItems
   */
  function clearRowItemWidthFreeze(rowItems) {
    if (!rowItems.hasAttribute(WIDTH_FROZEN_ATTR)) return;
    for (const el of getRowDirectItems(rowItems)) {
      el.style.flex = '';
      el.style.width = '';
      el.style.minWidth = '';
      el.style.maxWidth = '';
    }
    rowItems.removeAttribute(WIDTH_FROZEN_ATTR);
  }

  /**
   * @param {FocusEvent} event
   */
  function onFocusIn(event) {
    if (!isBoardRoute()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('[class*="meta-item"]')) return;
    const item =
      target.closest('[class*="meta-item-container"]') ||
      target.closest('[class*="meta-item"]');
    if (!item) return;
    const row = getMetaItemsContainer(item);
    if (!row || !shouldEnhanceRow(row)) return;

    lockBoardScrollLeft();
    requestAnimationFrame(() => scrollItemIntoRow(item));
  }

  function patchFocusPreventScroll() {
    if (window.__mystremioBoardFocusPatched) return;
    window.__mystremioBoardFocusPatched = true;
    const original = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function focusWithBoardGuard(options) {
      try {
        if (
          isBoardRoute() &&
          this instanceof HTMLElement &&
          this.closest?.('[class*="meta-item"]')
        ) {
          const next =
            options && typeof options === 'object'
              ? { ...options, preventScroll: true }
              : { preventScroll: true };
          return original.call(this, next);
        }
      } catch (_) {}
      return original.call(this, options);
    };
  }

  /**
   * True for catalog meta-rows (excludes Continue Watching + placeholders).
   * @param {Element} el
   * @returns {boolean}
   */
  function isCatalogMetaRow(el) {
    const cn = String(el.className || '');
    if (cn.includes('placeholder')) return false;
    if (cn.includes('continue-watching-row')) return false;
    return cn.includes('meta-row-container');
  }

  /**
   * CW rows always enhance. Catalog rows only when Horizontal Navigation plugin is on.
   * @param {Element} row meta-items-container (or parent)
   * @returns {boolean}
   */
  function shouldEnhanceRow(row) {
    if (!(row instanceof Element)) return false;
    if (row.closest?.('[class*="continue-watching-row"]')) return true;
    if (!isCatalogScrollEnabled()) return false;
    const root = getRowRoot(row) || row.closest?.('[class*="meta-row-container"]') || row;
    return root ? isCatalogMetaRow(root) : false;
  }

  /**
   * DOM-ordinal fallback when Core index helpers are unavailable.
   * @param {Element} rowItems
   * @returns {number}
   */
  function catalogIndexDomFallback(rowItems) {
    const board = document.querySelector('[class*="board-container"]');
    if (!board) return -1;
    const rows = [...board.querySelectorAll('[class*="meta-row-container"]')].filter(
      isCatalogMetaRow
    );
    const root = getRowRoot(rowItems);
    return root ? rows.indexOf(root) : -1;
  }

  /**
   * Pause Titlebar (and similar) while a row reveal / LoadNextPage is in flight.
   * @param {number} [idleMs]
   */
  function pulseBoardRowBusy(idleMs) {
    const ms = typeof idleMs === 'number' ? idleMs : ROW_BUSY_IDLE_MS;
    window.__mystremioBoardRowBusy = true;
    try {
      document.dispatchEvent(
        new CustomEvent('mystremio-board-row-busy', { detail: { busy: true } })
      );
    } catch (_) {
      /* ignore */
    }
    if (rowBusyIdleTimer) clearTimeout(rowBusyIdleTimer);
    rowBusyIdleTimer = window.setTimeout(() => {
      rowBusyIdleTimer = null;
      window.__mystremioBoardRowBusy = false;
      try {
        document.dispatchEvent(
          new CustomEvent('mystremio-board-row-busy', { detail: { busy: false } })
        );
      } catch (_) {
        /* ignore */
      }
    }, ms);
  }

  /**
   * Resolve Core catalog index (data-attr → title resolve → DOM ordinal).
   * @param {Element} rowItems
   * @returns {Promise<number>}
   */
  async function catalogIndexForRow(rowItems) {
    if (rowItems.closest('[class*="continue-watching-row"]')) return -1;

    const cached = catalogIndexCache.get(rowItems);
    if (cached && Date.now() - cached.at < STATE_CACHE_MS) {
      return cached.index;
    }

    const root = getRowRoot(rowItems);
    const attr = root?.getAttribute('data-mystremio-catalog-index');
    if (attr != null && attr !== '') {
      const n = Number(attr);
      if (Number.isFinite(n) && n >= 0) {
        catalogIndexCache.set(rowItems, { at: Date.now(), index: n });
        return n;
      }
    }

    const sync = window.__mystremioBoardSyncCatalogIndices;
    if (typeof sync === 'function') {
      try {
        await sync();
      } catch (_) {}
      const again = root?.getAttribute('data-mystremio-catalog-index');
      if (again != null && again !== '') {
        const n = Number(again);
        if (Number.isFinite(n) && n >= 0) {
          catalogIndexCache.set(rowItems, { at: Date.now(), index: n });
          return n;
        }
      }
    }

    const title = getRowTitle(rowItems);
    const resolve = window.__mystremioBoardResolveCatalogIndex;
    if (typeof resolve === 'function' && title) {
      try {
        const resolved = await resolve(title);
        if (Number.isFinite(resolved) && resolved >= 0) {
          root?.setAttribute('data-mystremio-catalog-index', String(resolved));
          catalogIndexCache.set(rowItems, { at: Date.now(), index: resolved });
          return resolved;
        }
      } catch (_) {}
    }

    const fallback = catalogIndexDomFallback(rowItems);
    catalogIndexCache.set(rowItems, { at: Date.now(), index: fallback });
    return fallback;
  }

  /**
   * Buffered item count already in Core for catalog index (flattened Ready pages).
   * @param {number} index
   * @returns {Promise<number>}
   */
  async function catalogBufferedItemCount(index) {
    if (index < 0) return 0;
    const hit = bufferedCountCache.get(index);
    if (hit && Date.now() - hit.at < STATE_CACHE_MS) {
      return hit.count;
    }
    const fn = window.__mystremioBoardGetCatalogItemCount;
    if (typeof fn !== 'function') return 0;
    try {
      const n = await fn(index);
      const count = Number.isFinite(n) && n > 0 ? n : 0;
      bufferedCountCache.set(index, { at: Date.now(), count });
      return count;
    } catch (_) {
      return 0;
    }
  }

  /**
   * @param {number} index
   * @returns {boolean}
   */
  function requestLoadNextPage(index) {
    if (index < 0) return false;
    if (loadInFlight.has(index)) return false;
    const fn = window.__mystremioBoardLoadNextPage;
    if (typeof fn !== 'function') return false;
    try {
      loadInFlight.add(index);
      pulseBoardRowBusy(LOAD_WAIT_MS + ROW_BUSY_IDLE_MS);
      bufferedCountCache.delete(index);
      fn(index);
      return true;
    } catch (err) {
      loadInFlight.delete(index);
      console.warn('[BoardRowNav] LoadNextPage failed:', err);
      return false;
    }
  }

  /**
   * @param {number} index
   */
  function clearLoadInFlight(index) {
    loadInFlight.delete(index);
    bufferedCountCache.delete(index);
    pulseBoardRowBusy(ROW_BUSY_IDLE_MS);
  }

  /**
   * @param {Element} rowItems
   * @returns {number}
   */
  function rowStep(rowItems) {
    return Math.max(180, rowItems.clientWidth * 0.85);
  }

  /**
   * @param {Element} rowItems
   * @returns {number}
   */
  function countRowMetaItems(rowItems) {
    return getRowDirectItems(rowItems).length;
  }

  /**
   * Wait until the row grows after LoadNextPage (or timeout).
   * @param {Element} rowItems
   * @param {number} prevCount
   * @param {number} prevWidth
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  function waitForRowGrowth(rowItems, prevCount, prevWidth, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const count = countRowMetaItems(rowItems);
        const width = rowItems.scrollWidth;
        if (count > prevCount || width > prevWidth + 24) {
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  /**
   * @param {Element} rowItems
   * @returns {boolean}
   */
  function rowNearEnd(rowItems) {
    return (
      rowItems.scrollLeft + rowItems.clientWidth >=
      rowItems.scrollWidth - SCROLL_EPS * 3
    );
  }

  /**
   * @param {number} idx
   * @returns {number}
   */
  function getRevealLimit(idx) {
    const map = window.__mystremioBoardReveal;
    if (!map || typeof map !== 'object') return CATALOG_PREVIEW_SIZE;
    const v = Number(map[idx]);
    return Number.isFinite(v) && v > 0 ? v : CATALOG_PREVIEW_SIZE;
  }

  /**
   * Raise MetaRow slice limit and ask Board to re-render (see webui hook).
   * @param {number} idx
   * @returns {number}
   */
  function bumpRevealLimit(idx) {
    if (!window.__mystremioBoardReveal || typeof window.__mystremioBoardReveal !== 'object') {
      window.__mystremioBoardReveal = {};
    }
    const next = getRevealLimit(idx) + CATALOG_PREVIEW_SIZE;
    window.__mystremioBoardReveal[idx] = next;
    pulseBoardRowBusy(ROW_BUSY_IDLE_MS);
    requestBoardRender();
    return next;
  }

  /**
   * @returns {Promise<void>}
   */
  function waitTwoFrames() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  }

  /**
   * Pan right; only at the end reveal more items / LoadNextPage once.
   * @param {Element} rowItems
   * @returns {Promise<void>}
   */
  async function scrollRowForward(rowItems) {
    if (rowItems.closest('[class*="continue-watching-row"]') || !rowNearEnd(rowItems)) {
      rowItems.scrollBy({ left: rowStep(rowItems), behavior: 'smooth' });
      return;
    }

    const idx = await catalogIndexForRow(rowItems);
    const itemsBefore = getRowDirectItems(rowItems);
    const prevCount = itemsBefore.length;
    const prevWidth = rowItems.scrollWidth;
    const freezeWidth =
      itemsBefore[0] instanceof HTMLElement
        ? itemsBefore[0].getBoundingClientRect().width
        : 0;

    const root = getRowRoot(rowItems);
    const exhausted = root?.hasAttribute(LOAD_EXHAUSTED_ATTR);

    if (idx >= 0) {
      const revealBefore = getRevealLimit(idx);
      const buffered = await catalogBufferedItemCount(idx);
      // Core already has more items than the MetaRow slice — reveal only, no network.
      const hasBuffer = buffered > revealBefore;

      bumpRevealLimit(idx);
      await waitTwoFrames();

      let grew =
        countRowMetaItems(rowItems) > prevCount || rowItems.scrollWidth > prevWidth + 24;

      if (grew) {
        freezeRowItemWidths(rowItems, freezeWidth);
        root?.removeAttribute(LOAD_EXHAUSTED_ATTR);
        enhanceSingleRow(rowItems);
      } else if (hasBuffer) {
        // Buffer exists but DOM missed a frame — one more render, never LoadNextPage.
        requestBoardRender();
        await waitTwoFrames();
        if (
          countRowMetaItems(rowItems) > prevCount ||
          rowItems.scrollWidth > prevWidth + 24
        ) {
          freezeRowItemWidths(rowItems, freezeWidth);
          root?.removeAttribute(LOAD_EXHAUSTED_ATTR);
          enhanceSingleRow(rowItems);
        }
      } else if (!exhausted) {
        const requested = requestLoadNextPage(idx);
        if (requested) {
          try {
            grew = await waitForRowGrowth(rowItems, prevCount, prevWidth, LOAD_WAIT_MS);
            if (grew) {
              const shown = countRowMetaItems(rowItems);
              window.__mystremioBoardReveal[idx] = Math.max(getRevealLimit(idx), shown);
              requestBoardRender();
              await waitTwoFrames();
              freezeRowItemWidths(rowItems, freezeWidth);
              root?.removeAttribute(LOAD_EXHAUSTED_ATTR);
              enhanceSingleRow(rowItems);
            } else {
              root?.setAttribute(LOAD_EXHAUSTED_ATTR, '1');
            }
          } finally {
            clearLoadInFlight(idx);
          }
        }
      }
    }

    rowItems.scrollBy({ left: rowStep(rowItems), behavior: 'smooth' });
  }

  /**
   * @param {Element} rowItems
   */
  function scrollRowBack(rowItems) {
    rowItems.scrollBy({ left: -rowStep(rowItems), behavior: 'smooth' });
  }

  /**
   * Overlay host under the row root so absolute chevrons sit on the cover.
   * @param {Element} root
   * @returns {HTMLElement}
   */
  function ensureOverlayHost(root) {
    let host = root.querySelector(`:scope > .${OVERLAY_CLASS}`);
    if (!host) {
      host = document.createElement('div');
      host.className = OVERLAY_CLASS;
      host.setAttribute('aria-hidden', 'true');
      root.appendChild(host);
    }
    return /** @type {HTMLElement} */ (host);
  }

  /**
   * Place chevrons on the cover midline relative to the row root.
   * @param {Element} rowItems
   * @param {HTMLElement|null} leftBtn
   * @param {HTMLElement|null} rightBtn
   */
  function positionChevronsOnCover(rowItems, leftBtn, rightBtn) {
    const root = getRowRoot(rowItems) || rowItems;
    const cover =
      rowItems.querySelector('[class*="poster-container"]') ||
      rowItems.querySelector('[class*="meta-item-container"]') ||
      rowItems.querySelector('[class*="meta-item"]');

    if (!(cover instanceof Element)) return;

    const rowRect = root.getBoundingClientRect();
    const coverRect = cover.getBoundingClientRect();
    if (coverRect.height < 8 || rowRect.width < 8) return;

    const midY = coverRect.top + coverRect.height / 2 - rowRect.top;

    for (const btn of [leftBtn, rightBtn]) {
      if (!(btn instanceof HTMLElement)) continue;
      btn.style.top = `${Math.round(midY)}px`;
      btn.style.transform = 'translateY(-50%)';
    }
  }

  /**
   * @param {string} className
   * @param {string} ariaLabel
   * @param {string} svgPoints
   * @param {() => void} onClick
   * @returns {HTMLButtonElement}
   */
  function createChevron(className, ariaLabel, svgPoints, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute('aria-label', ariaLabel);
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="${svgPoints}"></polyline></svg>`;
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return btn;
  }

  /**
   * Reposition chevrons on the cover and update left/right visibility.
   * @param {Element} rowItems
   * @param {HTMLElement|null} leftBtn
   * @param {HTMLElement|null} rightBtn
   */
  function refreshChevrons(rowItems, leftBtn, rightBtn) {
    positionChevronsOnCover(rowItems, leftBtn, rightBtn);

    const maxScroll = Math.max(0, rowItems.scrollWidth - rowItems.clientWidth);
    const overflow = maxScroll > 12;
    const atStart = rowItems.scrollLeft <= SCROLL_EPS;
    const atEnd = rowItems.scrollLeft >= maxScroll - SCROLL_EPS;
    const root = getRowRoot(rowItems);
    const hasCatalogAttr = root?.hasAttribute('data-mystremio-catalog-index');
    const exhausted = root?.hasAttribute(LOAD_EXHAUSTED_ATTR);
    const canLoadMore =
      !exhausted &&
      typeof window.__mystremioBoardLoadNextPage === 'function' &&
      !rowItems.closest('[class*="continue-watching-row"]') &&
      (hasCatalogAttr || catalogIndexDomFallback(rowItems) >= 0);

    if (leftBtn) {
      if (overflow && !atStart) leftBtn.classList.add('visible');
      else leftBtn.classList.remove('visible');
    }
    if (rightBtn) {
      if ((overflow && !atEnd) || canLoadMore) {
        rightBtn.classList.add('visible');
      } else {
        rightBtn.classList.remove('visible');
      }
    }
  }

  /**
   * Ensure left/right chevrons exist under the row overlay host.
   * @param {Element} rowItems
   */
  function ensureChevrons(rowItems) {
    const root = getRowRoot(rowItems);
    if (!root) return;
    root.classList.add(ROW_WRAP_CLASS);
    const host = ensureOverlayHost(root);

    let leftBtn = host.querySelector(`:scope > .${CHEVRON_LEFT}`);
    let rightBtn = host.querySelector(`:scope > .${CHEVRON_RIGHT}`);

    if (!(leftBtn instanceof HTMLButtonElement)) {
      leftBtn = createChevron(CHEVRON_LEFT, 'Scroll catalog row left', '15 6 9 12 15 18', () => {
        scrollRowBack(rowItems);
        window.setTimeout(() => refreshChevrons(rowItems, leftBtn, rightBtn), 320);
      });
      host.appendChild(leftBtn);
    }

    if (!(rightBtn instanceof HTMLButtonElement)) {
      rightBtn = createChevron(
        CHEVRON_RIGHT,
        'Scroll catalog row right',
        '9 6 15 12 9 18',
        () => {
          Promise.resolve(scrollRowForward(rowItems)).finally(() => {
            window.setTimeout(() => refreshChevrons(rowItems, leftBtn, rightBtn), 200);
          });
        }
      );
      host.appendChild(rightBtn);
    }

    refreshChevrons(rowItems, leftBtn, rightBtn);
    ensureChevronLayoutWatch(rowItems);
    rowItems.setAttribute(NAV_READY_ATTR, '1');
  }

  /**
   * Re-run chevron placement when the row/cover size changes.
   * @param {Element} rowItems
   */
  function ensureChevronLayoutWatch(rowItems) {
    if (chevronLayoutObservers.has(rowItems)) return;

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        if (!document.contains(rowItems)) return;
        const root = getRowRoot(rowItems);
        const host = root?.querySelector(`:scope > .${OVERLAY_CLASS}`);
        const leftBtn = host?.querySelector(`:scope > .${CHEVRON_LEFT}`);
        const rightBtn = host?.querySelector(`:scope > .${CHEVRON_RIGHT}`);
        if (leftBtn instanceof HTMLElement || rightBtn instanceof HTMLElement) {
          refreshChevrons(
            rowItems,
            leftBtn instanceof HTMLElement ? leftBtn : null,
            rightBtn instanceof HTMLElement ? rightBtn : null
          );
        }
      });
    };

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(schedule);
      ro.observe(rowItems);
      const cover = rowItems.querySelector(
        '[class*="poster-container"], [class*="poster-image-layer"], [class*="meta-item-poster"]'
      );
      if (cover && cover !== rowItems) ro.observe(cover);
      chevronLayoutObservers.set(rowItems, ro);
    } else {
      chevronLayoutObservers.set(rowItems, /** @type {any} */ ({ disconnect() {} }));
    }

    // One post-mount layout pass; ResizeObserver covers later size changes.
    schedule();
  }

  /**
   * Re-measure hero gutter after row layout changes (pairs with custom_scroll_restore.js).
   */
  function notifyHeroLayoutChanged() {
    try {
      document.dispatchEvent(new CustomEvent('stremio-custom-hero-layout-changed'));
    } catch (_) {}
  }

  /**
   * If board-content grew wider than the viewport, pin row roots to client width
   * so the hero 100vw breakout is not clipped into a left #141414 stripe.
   */
  function sharpenRowContainment() {
    if (containmentPinned) return;
    const board = getBoardScrollEl();
    if (!board) return;
    if (board.scrollWidth <= board.clientWidth + 1) return;
    const cs = window.getComputedStyle(board);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const inner = Math.max(0, board.clientWidth - padL - padR);
    if (!(inner > 40)) return;
    document
      .querySelectorAll(
        '[class*="board-container"] [class*="meta-row-container"], ' +
          '[class*="board-container"] [class*="continue-watching-row"]'
      )
      .forEach((root) => {
        if (!(root instanceof HTMLElement)) return;
        root.style.maxWidth = `${Math.round(inner)}px`;
      });
    containmentPinned = true;
  }

  function scheduleHeroLayoutNotify() {
    if (heroNotifyPending) return;
    heroNotifyPending = true;
    window.setTimeout(() => {
      heroNotifyPending = false;
      notifyHeroLayoutChanged();
    }, 250);
  }

  /**
   * Bind scrollport / chevrons / width freeze for one meta-items row.
   * @param {Element} row
   * @returns {boolean} whether layout was touched
   */
  function enhanceSingleRow(row) {
    if (!(row instanceof Element)) return false;
    if (!row.closest?.('[class*="board-container"]')) return false;
    if (!String(row.className || '').includes('meta-items-container')) {
      const nested = row.querySelector?.('[class*="meta-items-container"]');
      if (nested) return enhanceSingleRow(nested);
      return false;
    }
    if (!shouldEnhanceRow(row)) return false;

    let touched = false;
    // 1) Measure stock slot WHILE extras are still display:none
    // 2) Freeze flex-basis  3) Then enable scrollport unhide (display:revert)
    if (!row.classList.contains(ROW_SCROLLPORT_CLASS)) {
      const first = getRowDirectItems(row)[0];
      const w =
        first instanceof HTMLElement ? first.getBoundingClientRect().width : 0;
      if (w > 40) {
        freezeRowItemWidths(row, w);
        row.classList.add(ROW_SCROLLPORT_CLASS);
        touched = true;
        delete row.dataset.mystremioWidthRetry;
      } else if (getRowDirectItems(row).length > 0) {
        pendingEnhanceRows.add(row);
        if (!row.dataset.mystremioWidthRetry) {
          row.dataset.mystremioWidthRetry = '1';
          window.setTimeout(() => {
            delete row.dataset.mystremioWidthRetry;
            if (!isBoardRoute()) return;
            pendingEnhanceRows.add(row);
            scheduleEnhance();
          }, WIDTH_RETRY_MS);
        }
      }
    } else if (row.hasAttribute(WIDTH_FROZEN_ATTR)) {
      const px = readFrozenWidthPx(row);
      if (px) {
        freezeRowItemWidths(row, px);
        touched = true;
      }
    }

    if (!row.classList.contains(ROW_SCROLLPORT_CLASS)) return touched;

    ensureChevrons(row);
    touched = true;
    if (!row.dataset.mystremioRowScrollBound) {
      row.dataset.mystremioRowScrollBound = '1';
      let scrollRaf = 0;
      const onRowScroll = () => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = 0;
          const root = getRowRoot(row);
          const host = root?.querySelector(`:scope > .${OVERLAY_CLASS}`);
          const leftBtn = host?.querySelector(`:scope > .${CHEVRON_LEFT}`);
          const rightBtn = host?.querySelector(`:scope > .${CHEVRON_RIGHT}`);
          if (leftBtn instanceof HTMLElement || rightBtn instanceof HTMLElement) {
            refreshChevrons(
              row,
              leftBtn instanceof HTMLElement ? leftBtn : null,
              rightBtn instanceof HTMLElement ? rightBtn : null
            );
          }
        });
      };
      rowScrollHandlers.set(row, onRowScroll);
      row.addEventListener('scroll', onRowScroll, { passive: true });
    }
    return touched;
  }

  /**
   * Ensure every board meta-items row (including CW) has scrollport + chevrons.
   */
  function ensureChevronsPresent() {
    if (!isBoardRoute()) return;
    const rows = document.querySelectorAll(
      '[class*="board-container"] [class*="meta-items-container"]'
    );
    for (const row of rows) {
      if (!shouldEnhanceRow(row)) continue;
      if (!row.classList.contains(ROW_SCROLLPORT_CLASS) || !rowHasChevrons(row)) {
        row.removeAttribute(NAV_READY_ATTR);
        pendingEnhanceRows.add(row);
        enhanceSingleRow(row);
      }
    }
  }

  /**
   * Refresh visibility for every row that already has chevrons.
   */
  function refreshAllChevrons() {
    document
      .querySelectorAll(
        `[class*="board-container"] [class*="meta-items-container"].${ROW_SCROLLPORT_CLASS}`
      )
      .forEach((row) => {
        const root = getRowRoot(row);
        const host = root?.querySelector(`:scope > .${OVERLAY_CLASS}`);
        const leftBtn = host?.querySelector(`:scope > .${CHEVRON_LEFT}`);
        const rightBtn = host?.querySelector(`:scope > .${CHEVRON_RIGHT}`);
        if (leftBtn instanceof HTMLElement || rightBtn instanceof HTMLElement) {
          refreshChevrons(
            row,
            leftBtn instanceof HTMLElement ? leftBtn : null,
            rightBtn instanceof HTMLElement ? rightBtn : null
          );
        }
      });
  }

  /**
   * @param {Iterable<Element>|null} [onlyRows] When set, enhance only these rows.
   */
  function enhanceRows(onlyRows) {
    if (!isBoardRoute()) return;
    enhancing = true;
    try {
      injectStyles();
      lockBoardScrollLeft();

      const now = Date.now();
      const sync = window.__mystremioBoardSyncCatalogIndices;
      if (
        isCatalogScrollEnabled() &&
        typeof sync === 'function' &&
        now - lastSyncAt > 1200
      ) {
        lastSyncAt = now;
        Promise.resolve(sync()).catch(() => {});
      }

      /** @type {Element[]} */
      let rows;
      if (onlyRows) {
        rows = [...onlyRows].filter(Boolean);
      } else {
        rows = [
          ...document.querySelectorAll(
            '[class*="board-container"] [class*="meta-items-container"]'
          ),
        ];
      }

      let touched = false;
      let missingChevrons = false;
      for (const row of rows) {
        if (!shouldEnhanceRow(row)) continue;
        if (!onlyRows && isRowNavReady(row)) continue;
        if (enhanceSingleRow(row)) touched = true;
        if (!rowHasChevrons(row)) missingChevrons = true;
      }
      // Only sweep when this pass left rows without overlays (board-enter calls it explicitly).
      if (missingChevrons) {
        ensureChevronsPresent();
      }
      if (touched) {
        sharpenRowContainment();
        scheduleHeroLayoutNotify();
      }
      lockBoardScrollLeft();
    } finally {
      enhancing = false;
      // Drop mutations we caused (chevron/class writes) so they don't re-schedule.
      try {
        observer?.takeRecords();
      } catch (_) {}
      if (enhanceQueued) {
        enhanceQueued = false;
        scheduleEnhance();
      }
    }
  }

  /**
   * Keep Left/Right navigation inside the focused board row.
   * @param {KeyboardEvent} event
   */
  function onKeyDown(event) {
    if (!isBoardRoute()) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const active = document.activeElement;
    if (!(active instanceof Element)) return;

    const item =
      active.closest('[class*="meta-item-container"]') ||
      active.closest('[class*="meta-item"]');
    if (!item) return;
    const row = getMetaItemsContainer(item);
    if (!row || !row.closest('[class*="board-container"]')) return;
    // Catalog keyboard LoadNextPage/reveal only while Horizontal Navigation is on.
    if (!shouldEnhanceRow(row)) return;

    const items = getRowDirectItems(row);
    // Resolve focused item to the direct row child (not a nested match).
    const focused =
      items.find((el) => el === item || el.contains(item)) || null;
    if (!focused) return;
    const idx = items.indexOf(focused);
    if (idx < 0) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }

    if (event.key === 'ArrowRight') {
      if (idx >= items.length - 1) {
        Promise.resolve(scrollRowForward(row)).then(() => {
          const after = getRowDirectItems(row);
          const next = after[Math.min(idx + 1, after.length - 1)];
          if (next instanceof HTMLElement && next !== focused) {
            next.focus({ preventScroll: true });
            scrollItemIntoRow(next);
          }
        });
        return;
      }
      const next = items[idx + 1];
      if (next instanceof HTMLElement) {
        next.focus({ preventScroll: true });
        scrollItemIntoRow(next);
      }
      return;
    }

    if (idx <= 0) {
      scrollRowBack(row);
      return;
    }
    const prev = items[idx - 1];
    if (prev instanceof HTMLElement) {
      prev.focus({ preventScroll: true });
      scrollItemIntoRow(prev);
    }
  }

  let observer = null;
  let tickTimer = null;
  let boardScrollBound = false;

  function scheduleEnhance() {
    if (enhancing) {
      enhanceQueued = true;
      return;
    }
    if (tickTimer) return;
    tickTimer = window.setTimeout(() => {
      tickTimer = null;
      if (pendingEnhanceRows.size > 0) {
        const scoped = [...pendingEnhanceRows];
        pendingEnhanceRows.clear();
        enhanceRows(scoped);
        return;
      }
      enhanceRows();
    }, ENHANCE_DEBOUNCE_MS);
  }

  /**
   * Collect meta-items-container rows touched by a mutation batch.
   * @param {MutationRecord[]} records
   * @returns {Set<Element>}
   */
  function collectAffectedMetaItemRows(records) {
    /** @type {Set<Element>} */
    const rows = new Set();
    /**
     * @param {Node} node
     */
    const addFrom = (node) => {
      if (!(node instanceof Element)) return;
      const row =
        (String(node.className || '').includes('meta-items-container')
          ? node
          : null) ||
        node.closest?.('[class*="meta-items-container"]') ||
        node.querySelector?.('[class*="meta-items-container"]');
      if (row && row.closest?.('[class*="board-container"]')) {
        rows.add(row);
      }
    };
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.addedNodes?.length) {
        for (let j = 0; j < rec.addedNodes.length; j++) addFrom(rec.addedNodes[j]);
      }
      if (rec.removedNodes?.length) {
        // Removals may leave the parent row needing chevron refresh.
        addFrom(rec.target);
      }
    }
    return rows;
  }

  function ensureBoardScrollLock() {
    if (boardScrollBound) return;
    boardScrollBound = true;
    document.addEventListener(
      'scroll',
      (event) => {
        if (!isBoardRoute()) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (!String(target.className || '').includes('board-content')) return;
        if (target.scrollLeft !== 0) target.scrollLeft = 0;
      },
      { capture: true, passive: true }
    );
  }

  /**
   * Pause DOM observation while the user scrolls the board vertically.
   */
  function pauseObserverForScroll() {
    if (!observer || observerPaused) return;
    observerPaused = true;
    try {
      observer.disconnect();
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Resume observation after scroll idle and catch up chevrons.
   */
  function resumeObserverAfterScroll() {
    if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
    scrollIdleTimer = window.setTimeout(() => {
      scrollIdleTimer = null;
      observerPaused = false;
      if (!isBoardRoute()) return;
      ensureObserver();
      scheduleEnhance();
    }, SCROLL_IDLE_MS);
  }

  /**
   * Bind vertical scroll → observer pause (MutationObserver storms).
   */
  function ensureBoardScrollPause() {
    if (boardVertScrollBound) return;
    boardVertScrollBound = true;
    document.addEventListener(
      'scroll',
      (event) => {
        if (!isBoardRoute()) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (!String(target.className || '').includes('board-content')) return;
        pauseObserverForScroll();
        resumeObserverAfterScroll();
      },
      { capture: true, passive: true }
    );
  }

  /**
   * Prefer board-container so nav/settings/plugin churn outside the board
   * does not schedule enhance passes.
   * @returns {Element|null}
   */
  function getObserverRoot() {
    return (
      document.querySelector('[class*="board-container"]') ||
      getBoardScrollEl()
    );
  }

  function ensureObserver() {
    const root = getObserverRoot();
    if (!root) return;
    if (!observer) {
      observer = new MutationObserver((records) => {
        if (enhancing || observerPaused || !isBoardRoute()) return;
        const affected = collectAffectedMetaItemRows(records);
        if (affected.size === 0) return;
        let queued = false;
        for (const row of affected) {
          if (!shouldEnhanceRow(row)) continue;
          pendingEnhanceRows.add(row);
          queued = true;
        }
        if (queued) scheduleEnhance();
      });
    }
    if (observerPaused) return;
    if (observerRoot !== root) {
      try {
        observer.disconnect();
      } catch (_) {
        /* ignore */
      }
      observerRoot = root;
    }
    try {
      observer.observe(root, { childList: true, subtree: true });
    } catch (_) {
      /* ignore */
    }
  }

  function clearEnterRetryTimers() {
    for (const id of enterRetryTimers) clearTimeout(id);
    enterRetryTimers = [];
  }

  /**
   * Re-ensure scrollports/chevrons after board enter (React remount races).
   */
  function ensureBoardNavOnEnter() {
    clearEnterRetryTimers();
    injectStyles();
    patchFocusPreventScroll();
    ensureBoardScrollLock();
    ensureBoardScrollPause();
    ensureObserver();
    lockBoardScrollLeft();

    const runFull = () => {
      if (!isBoardRoute()) return;
      ensureObserver();
      enhanceRows();
      ensureChevronsPresent();
    };

    runFull();
    requestAnimationFrame(runFull);
    // One delayed remount insurance — scoped chevron sweep only.
    enterRetryTimers.push(
      window.setTimeout(() => {
        if (!isBoardRoute()) return;
        ensureObserver();
        ensureChevronsPresent();
      }, 400)
    );
  }

  function clearAllRowWidthFreezes() {
    document
      .querySelectorAll(`[class*="meta-items-container"][${WIDTH_FROZEN_ATTR}]`)
      .forEach((row) => clearRowItemWidthFreeze(row));
  }

  /**
   * Tear down before React unmounts the board tree (Board → Detail).
   * Disconnect observer, remove chevron overlays / styles, clear freezes.
   */
  function teardownBoardNav() {
    clearEnterRetryTimers();
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    if (scrollIdleTimer) {
      clearTimeout(scrollIdleTimer);
      scrollIdleTimer = null;
    }
    if (rowBusyIdleTimer) {
      clearTimeout(rowBusyIdleTimer);
      rowBusyIdleTimer = null;
    }
    if (renderBumpRaf) {
      cancelAnimationFrame(renderBumpRaf);
      renderBumpRaf = 0;
    }
    enhanceQueued = false;
    observerPaused = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    observerRoot = null;
    window.__mystremioBoardRowBusy = false;
    bufferedCountCache.clear();
    for (const ro of chevronLayoutObservers.values()) {
      try {
        ro.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    chevronLayoutObservers.clear();
    containmentPinned = false;
    heroNotifyPending = false;
    lastSyncAt = 0;
    document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => el.remove());
    document
      .querySelectorAll(
        `.${CHEVRON_LEFT}, .${CHEVRON_RIGHT}`
      )
      .forEach((el) => el.remove());
    document.querySelectorAll(`.${ROW_WRAP_CLASS}`).forEach((el) => {
      el.classList.remove(ROW_WRAP_CLASS);
    });
    document.querySelectorAll(`.${ROW_SCROLLPORT_CLASS}`).forEach((el) => {
      el.classList.remove(ROW_SCROLLPORT_CLASS);
      el.removeAttribute(NAV_READY_ATTR);
      el.removeAttribute(ITEM_COUNT_ATTR);
      delete el.dataset.mystremioRowScrollBound;
      delete el.dataset.mystremioWidthRetry;
    });
    // Keep __mystremioBoardReveal across detail hops so return-to-board
    // does not rebuild every row from CATALOG_PREVIEW_SIZE.
    pendingEnhanceRows.clear();
    loadInFlight.clear();
    document
      .querySelectorAll(
        '[class*="board-container"] [class*="meta-row-container"], ' +
          '[class*="board-container"] [class*="continue-watching-row"]'
      )
      .forEach((el) => {
        if (el instanceof HTMLElement) el.style.maxWidth = '';
      });
    document.getElementById(STYLE_ID)?.remove();
    clearAllRowWidthFreezes();
    notifyHeroLayoutChanged();
  }

  function onRoute() {
    if (!isBoardRoute()) {
      teardownBoardNav();
      return;
    }
    ensureBoardNavOnEnter();
  }

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('stremio-custom-route-change', onRoute);
  // Capture so we tear down before React finishes unmounting the board tree.
  window.addEventListener('hashchange', onRoute, true);
  window.addEventListener('resize', () => {
    if (!isBoardRoute()) return;
    containmentPinned = false;
    // Re-measure frozen rows after resize so slot sizes stay sane.
    document
      .querySelectorAll(`[class*="meta-items-container"][${WIDTH_FROZEN_ATTR}]`)
      .forEach((row) => {
        clearRowItemWidthFreeze(row);
        row.removeAttribute(NAV_READY_ATTR);
      });
    scheduleEnhance();
    refreshAllChevrons();
  });

  /**
   * Tear down catalog-only scrollports/chevrons (CW rows stay).
   * Called when Horizontal Navigation plugin unloads.
   */
  function teardownCatalogRowNav() {
    for (const row of [...pendingEnhanceRows]) {
      if (!row?.closest?.('[class*="continue-watching-row"]')) {
        pendingEnhanceRows.delete(row);
      }
    }

    const reveal = window.__mystremioBoardReveal;
    if (reveal && typeof reveal === 'object') {
      for (const key of Object.keys(reveal)) {
        delete reveal[key];
      }
      try {
        window.__mystremioBoardRequestRender?.();
      } catch (_) {
        /* ignore */
      }
    }

    document
      .querySelectorAll(
        '[class*="board-container"] [class*="meta-row-container"]:not([class*="continue-watching-row"]) [class*="meta-items-container"]'
      )
      .forEach((row) => {
        if (!(row instanceof Element)) return;

        const ro = chevronLayoutObservers.get(row);
        if (ro) {
          try {
            ro.disconnect();
          } catch (_) {
            /* ignore */
          }
          chevronLayoutObservers.delete(row);
        }

        const onScroll = rowScrollHandlers.get(row);
        if (onScroll) {
          try {
            row.removeEventListener('scroll', onScroll);
          } catch (_) {
            /* ignore */
          }
          rowScrollHandlers.delete(row);
        }

        clearRowItemWidthFreeze(row);
        row.classList.remove(ROW_SCROLLPORT_CLASS);
        row.removeAttribute(NAV_READY_ATTR);
        row.removeAttribute(WIDTH_FROZEN_ATTR);
        row.removeAttribute(LOAD_EXHAUSTED_ATTR);
        row.removeAttribute(ITEM_COUNT_ATTR);
        delete row.dataset.mystremioRowScrollBound;
        delete row.dataset.mystremioWidthRetry;
        const root = getRowRoot(row);
        root?.classList.remove(ROW_WRAP_CLASS);
        root?.querySelector(`:scope > .${OVERLAY_CLASS}`)?.remove();
        root?.querySelectorAll(
          `:scope > .${CHEVRON_LEFT}, :scope > .${CHEVRON_RIGHT}, :scope > .mystremio-board-row-chevron`
        ).forEach((el) => el.remove());
        if (root instanceof HTMLElement) root.style.maxWidth = '';
      });

    loadInFlight.clear();
    bufferedCountCache.clear();
    injectStyles();
    if (isBoardRoute()) {
      scheduleEnhance();
      ensureChevronsPresent();
    }
  }

  window.__mystremioEnsureBoardRowNav = function () {
    if (!isBoardRoute()) return;
    injectStyles();
    scheduleEnhance();
    ensureChevronsPresent();
  };

  window.__mystremioTeardownCatalogRowNav = teardownCatalogRowNav;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onRoute, { once: true });
  } else {
    onRoute();
  }
})();
