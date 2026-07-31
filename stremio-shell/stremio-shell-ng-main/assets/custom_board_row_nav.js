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
  const ITEM_COUNT_ATTR = 'data-mystremio-nav-items';
  const NAV_READY_ATTR = 'data-mystremio-nav-ready';

  let enhancing = false;
  let lastSyncAt = 0;
  let containmentPinned = false;
  let heroNotifyPending = false;
  /** @type {Map<Element, ResizeObserver|{disconnect(): void}>} */
  const chevronLayoutObservers = new Map();

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

  /**
   * Inject layout CSS: board x-lock, stock item sizes, hidden scrollbars, chevrons.
   */
  function injectStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = `
      /* Never overflow-x on board-content (clips hero → grey stripe).
         Contain row ancestors only — exclude hero-row so hero can stay full-bleed. */
      #app [class*="board-container"] [class*="board-content"] > :not([class*="hero-row"]),
      #app [class*="board-container"] [class*="board-row"],
      #app [class*="board-container"] [class*="meta-row-container"],
      #app [class*="board-container"] [class*="continue-watching-row"] {
        max-width: 100%;
        min-width: 0;
        box-sizing: border-box;
      }
      #app [class*="board-container"] [class*="meta-row-container"],
      #app [class*="board-container"] [class*="continue-watching-row"] {
        position: relative;
        overflow-x: clip;
      }
      @supports not (overflow: clip) {
        #app [class*="board-container"] [class*="meta-row-container"],
        #app [class*="board-container"] [class*="continue-watching-row"] {
          overflow-x: hidden;
        }
      }
      /* Unhide stock nth-child{display:none} only — NEVER display:flex (breaks poster/title layout). */
      #app [class*="board-container"] [class*="meta-items-container"].${ROW_SCROLLPORT_CLASS} > [class*="meta-item"] {
        display: revert !important;
        content-visibility: auto;
        contain-intrinsic-size: auto 280px;
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
        backdrop-filter: blur(8px);
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
   * Row already has scrollport + freeze + chevrons for the current item count.
   * @param {Element} row
   * @returns {boolean}
   */
  function isRowNavReady(row) {
    if (!row.classList.contains(ROW_SCROLLPORT_CLASS)) return false;
    if (!row.hasAttribute(WIDTH_FROZEN_ATTR)) return false;
    if (row.getAttribute(NAV_READY_ATTR) !== '1') return false;
    const items = getRowDirectItems(row);
    const prev = Number(row.getAttribute(ITEM_COUNT_ATTR) || '0');
    return prev === items.length && items.length > 0;
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
   * Resolve Core catalog index (data-attr → title resolve → DOM ordinal).
   * @param {Element} rowItems
   * @returns {Promise<number>}
   */
  async function catalogIndexForRow(rowItems) {
    if (rowItems.closest('[class*="continue-watching-row"]')) return -1;

    const root = getRowRoot(rowItems);
    const attr = root?.getAttribute('data-mystremio-catalog-index');
    if (attr != null && attr !== '') {
      const n = Number(attr);
      if (Number.isFinite(n) && n >= 0) return n;
    }

    const sync = window.__mystremioBoardSyncCatalogIndices;
    if (typeof sync === 'function') {
      try {
        await sync();
      } catch (_) {}
      const again = root?.getAttribute('data-mystremio-catalog-index');
      if (again != null && again !== '') {
        const n = Number(again);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }

    const title = getRowTitle(rowItems);
    const resolve = window.__mystremioBoardResolveCatalogIndex;
    if (typeof resolve === 'function' && title) {
      try {
        const resolved = await resolve(title);
        if (Number.isFinite(resolved) && resolved >= 0) {
          root?.setAttribute('data-mystremio-catalog-index', String(resolved));
          return resolved;
        }
      } catch (_) {}
    }

    return catalogIndexDomFallback(rowItems);
  }

  /**
   * @param {number} index
   * @returns {boolean}
   */
  function requestLoadNextPage(index) {
    if (index < 0) return false;
    const fn = window.__mystremioBoardLoadNextPage;
    if (typeof fn !== 'function') return false;
    try {
      fn(index);
      return true;
    } catch (err) {
      console.warn('[BoardRowNav] LoadNextPage failed:', err);
      return false;
    }
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
    const force = window.__mystremioBoardRequestRender;
    if (typeof force === 'function') {
      try {
        force();
      } catch (_) {
        /* ignore */
      }
    }
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
      bumpRevealLimit(idx);
      await waitTwoFrames();

      let grew =
        countRowMetaItems(rowItems) > prevCount || rowItems.scrollWidth > prevWidth + 24;

      if (!grew && !exhausted) {
        const requested = requestLoadNextPage(idx);
        if (requested) {
          grew = await waitForRowGrowth(rowItems, prevCount, prevWidth, LOAD_WAIT_MS);
          if (grew) {
            const shown = countRowMetaItems(rowItems);
            window.__mystremioBoardReveal[idx] = Math.max(getRevealLimit(idx), shown);
            const force = window.__mystremioBoardRequestRender;
            if (typeof force === 'function') {
              try {
                force();
              } catch (_) {
                /* ignore */
              }
            }
            await waitTwoFrames();
            freezeRowItemWidths(rowItems, freezeWidth);
            root?.removeAttribute(LOAD_EXHAUSTED_ATTR);
            console.info('[BoardRowNav] load grew', {
              catalogIndex: idx,
              title: getRowTitle(rowItems),
            });
          } else {
            root?.setAttribute(LOAD_EXHAUSTED_ATTR, '1');
            console.info('[BoardRowNav] load no-growth', {
              catalogIndex: idx,
              title: getRowTitle(rowItems),
            });
          }
        }
      } else if (grew) {
        freezeRowItemWidths(rowItems, freezeWidth);
        root?.removeAttribute(LOAD_EXHAUSTED_ATTR);
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
   * Own overlay host under the row root so chevrons are not React meta-item children.
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
   * Vertically center chevrons on the cover/poster (landscape or poster shape).
   * @param {Element} rowItems
   * @param {HTMLElement|null} leftBtn
   * @param {HTMLElement|null} rightBtn
   */
  function positionChevronsOnCover(rowItems, leftBtn, rightBtn) {
    const root = getRowRoot(rowItems);
    if (!root) return;

    const cover =
      rowItems.querySelector('[class*="poster-container"]') ||
      rowItems.querySelector('[class*="meta-item-container"]') ||
      rowItems.querySelector('[class*="meta-item"]');

    if (!(cover instanceof Element)) return;

    const rootRect = root.getBoundingClientRect();
    const coverRect = cover.getBoundingClientRect();
    if (coverRect.height < 8) return;

    const mid = coverRect.top - rootRect.top + coverRect.height / 2;
    for (const btn of [leftBtn, rightBtn]) {
      if (!(btn instanceof HTMLElement)) continue;
      btn.style.top = `${Math.round(mid)}px`;
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
   * @param {Element} rowItems
   */
  function ensureChevrons(rowItems) {
    const root = getRowRoot(rowItems);
    if (!root) return;
    root.classList.add(ROW_WRAP_CLASS);

    const host = ensureOverlayHost(root);
    let leftBtn = host.querySelector(`:scope > .${CHEVRON_LEFT}`);
    let rightBtn = host.querySelector(`:scope > .${CHEVRON_RIGHT}`);
    const alreadyReady = !!(leftBtn && rightBtn && rowItems.getAttribute(NAV_READY_ATTR) === '1');

    // Legacy: chevrons previously appended directly under the React row root.
    if (!alreadyReady) {
      root
        .querySelectorAll(
          ':scope > .mystremio-board-row-chevron, :scope > .mystremio-board-row-chevron-left, :scope > .mystremio-board-row-chevron-right'
        )
        .forEach((el) => {
          el.remove();
        });
    }

    if (!leftBtn) {
      leftBtn = createChevron(CHEVRON_LEFT, 'Scroll catalog row left', '15 6 9 12 15 18', () => {
        scrollRowBack(rowItems);
        window.setTimeout(() => refreshChevrons(rowItems, leftBtn, rightBtn), 320);
      });
      host.appendChild(leftBtn);
    }
    if (!rightBtn) {
      rightBtn = createChevron(CHEVRON_RIGHT, 'Scroll catalog row right', '9 6 15 12 9 18', () => {
        Promise.resolve(scrollRowForward(rowItems)).finally(() => {
          window.setTimeout(() => refreshChevrons(rowItems, leftBtn, rightBtn), 120);
          window.setTimeout(() => refreshChevrons(rowItems, leftBtn, rightBtn), 500);
        });
      });
      host.appendChild(rightBtn);
    }

    refreshChevrons(rowItems, leftBtn, rightBtn);
    ensureChevronLayoutWatch(rowItems);
    rowItems.setAttribute(NAV_READY_ATTR, '1');
  }

  /**
   * Enhanced Covers (and similar) often apply after first paint and change CW poster height.
   * Re-run chevron vertical placement when the row/cover size changes.
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
        const host = root && root.querySelector(`:scope > .${OVERLAY_CLASS}`);
        if (!host) return;
        const leftBtn = host.querySelector(`:scope > .${CHEVRON_LEFT}`);
        const rightBtn = host.querySelector(`:scope > .${CHEVRON_RIGHT}`);
        if (leftBtn && rightBtn) refreshChevrons(rowItems, leftBtn, rightBtn);
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

    // Styles/images from Enhanced Covers often land shortly after nav binds.
    [200, 600, 1400].forEach((ms) => {
      window.setTimeout(schedule, ms);
    });
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

  function enhanceRows() {
    if (!isBoardRoute()) return;
    enhancing = true;
    try {
      injectStyles();
      lockBoardScrollLeft();

      const now = Date.now();
      const sync = window.__mystremioBoardSyncCatalogIndices;
      if (typeof sync === 'function' && now - lastSyncAt > 1200) {
        lastSyncAt = now;
        Promise.resolve(sync()).catch(() => {});
      }

      const rows = document.querySelectorAll(
        '[class*="board-container"] [class*="meta-items-container"]'
      );
      let touched = false;
      for (const row of rows) {
        if (isRowNavReady(row)) continue;

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
          }
        } else if (row.hasAttribute(WIDTH_FROZEN_ATTR)) {
          const px = readFrozenWidthPx(row);
          if (px) {
            freezeRowItemWidths(row, px);
            touched = true;
          }
        }

        if (!row.classList.contains(ROW_SCROLLPORT_CLASS)) continue;

        ensureChevrons(row);
        touched = true;
        if (!row.dataset.mystremioRowScrollBound) {
          row.dataset.mystremioRowScrollBound = '1';
          let scrollRaf = 0;
          row.addEventListener(
            'scroll',
            () => {
              if (scrollRaf) return;
              scrollRaf = requestAnimationFrame(() => {
                scrollRaf = 0;
                const root = getRowRoot(row);
                const host = root?.querySelector(`:scope > .${OVERLAY_CLASS}`);
                const leftBtn = host?.querySelector(`:scope > .${CHEVRON_LEFT}`);
                const rightBtn = host?.querySelector(`:scope > .${CHEVRON_RIGHT}`);
                refreshChevrons(row, leftBtn, rightBtn);
              });
            },
            { passive: true }
          );
        }
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
    if (enhancing) return;
    if (tickTimer) return;
    tickTimer = window.setTimeout(() => {
      tickTimer = null;
      enhanceRows();
    }, ENHANCE_DEBOUNCE_MS);
  }

  /**
   * Only react to mutations that actually add/remove board catalog nodes.
   * @param {MutationRecord[]} records
   * @returns {boolean}
   */
  function mutationsAffectBoardRows(records) {
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const nodes = [];
      if (rec.addedNodes?.length) nodes.push(...rec.addedNodes);
      if (rec.removedNodes?.length) nodes.push(...rec.removedNodes);
      for (let j = 0; j < nodes.length; j++) {
        const node = nodes[j];
        if (!(node instanceof Element)) continue;
        const cn = String(node.className || '');
        if (
          cn.includes('meta-items-container') ||
          cn.includes('meta-row-container') ||
          cn.includes('meta-item') ||
          cn.includes('board-row') ||
          cn.includes('continue-watching')
        ) {
          return true;
        }
        if (
          node.querySelector?.(
            '[class*="meta-items-container"], [class*="meta-row-container"], [class*="meta-item"]'
          )
        ) {
          return true;
        }
      }
    }
    return false;
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

  function ensureObserver() {
    if (observer) return;
    const root = document.querySelector('#app') || document.body;
    if (!root) return;
    observer = new MutationObserver((records) => {
      if (enhancing || !isBoardRoute()) return;
      if (!mutationsAffectBoardRows(records)) return;
      scheduleEnhance();
    });
    observer.observe(root, { childList: true, subtree: true });
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
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
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
        `.${CHEVRON_LEFT}, .${CHEVRON_RIGHT}, .mystremio-board-row-chevron`
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
    });
    try {
      window.__mystremioBoardReveal = {};
    } catch (_) {
      /* ignore */
    }
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
    injectStyles();
    patchFocusPreventScroll();
    ensureBoardScrollLock();
    ensureObserver();
    scheduleEnhance();
    lockBoardScrollLeft();
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
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onRoute, { once: true });
  } else {
    onRoute();
  }
})();
