(function () {
  'use strict';

  /**
   * Continue Watching helpers (always on, independent of Enhanced Titlebar):
   * - When Enhanced Covers is off: swap landscape/backdrop posters to Metahub portrait.
   * - Always: sync stale title-labels after React remount/reuse (href drifted).
   */

  if (window.self !== window.top) return;
  if (window.__stremioCustomCwPosters) return;
  window.__stremioCustomCwPosters = true;

  const ATTR_GEN = 'data-mystremio-cw-poster-gen';
  const ATTR_FIXED = 'data-mystremio-cw-poster-fixed';
  const ATTR_TITLE_ID = 'data-mystremio-cw-title-id';
  const CINEMETA = 'https://v3-cinemeta.strem.io/meta';
  const LANDSCAPE_RATIO = 1.2;
  /** @type {Map<string, string>} */
  const titleCache = new Map();
  let generation = 0;
  let scheduled = false;

  function isEnhancedCoversActive() {
    return Boolean(document.getElementById('enhanced-covers-styles'));
  }

  /**
   * @param {string} value
   * @returns {string|null}
   */
  function extractImdbId(value) {
    if (!value || typeof value !== 'string') return null;
    const match = value.match(/tt\d{7,8}/i);
    return match ? match[0].toLowerCase() : null;
  }

  /**
   * @param {string} src
   * @returns {boolean}
   */
  function isBackgroundUrl(src) {
    return /images\.metahub\.space\/background\//i.test(src || '');
  }

  /**
   * @param {string} imdbId
   * @returns {string}
   */
  function metahubPosterUrl(imdbId) {
    return `https://images.metahub.space/poster/medium/${imdbId}/img`;
  }

  /**
   * @param {Element} img
   * @returns {string|null}
   */
  function resolveImdbIdForImage(img) {
    const card =
      img.closest('[class*="meta-item"]') ||
      img.closest('[class*="lib-item"]') ||
      img.closest('a') ||
      img.parentElement;
    if (!card) return null;

    const href =
      card.getAttribute('href') ||
      card.querySelector?.('a[href]')?.getAttribute('href') ||
      '';
    return (
      extractImdbId(href) ||
      extractImdbId(card.getAttribute('data-imdb-id') || '') ||
      extractImdbId(img.getAttribute('src') || '') ||
      extractImdbId(img.getAttribute('alt') || '')
    );
  }

  /**
   * @param {HTMLImageElement} img
   * @param {number} gen
   */
  /**
   * Force cover crop after a Metahub portrait swap so leftover EC/layout CSS
   * cannot leave gray empty bands above/below the image.
   * @param {HTMLImageElement} img
   */
  function applyCoverFit(img) {
    if (!img) return;
    img.style.objectFit = 'cover';
    img.style.objectPosition = 'center';
    img.style.width = '100%';
    img.style.height = '100%';
  }

  function tryFixPoster(img, gen) {
    if (
      !img ||
      (img.getAttribute(ATTR_GEN) === String(gen) && img.hasAttribute(ATTR_FIXED))
    ) {
      return;
    }
    // Stay completely out of the way while Enhanced Covers owns layout CSS.
    if (isEnhancedCoversActive()) return;

    const currentSrc = img.currentSrc || img.src || '';
    // Already a portrait Metahub poster — do not swap or restyle.
    if (!currentSrc || /images\.metahub\.space\/poster\//i.test(currentSrc)) {
      img.setAttribute(ATTR_GEN, String(gen));
      return;
    }

    const imdbId = resolveImdbIdForImage(img);
    if (!imdbId) {
      img.setAttribute(ATTR_GEN, String(gen));
      return;
    }

    const applySwap = () => {
      if (generation !== gen || isEnhancedCoversActive()) return;
      const next = metahubPosterUrl(imdbId);
      if ((img.currentSrc || img.src) === next) {
        img.setAttribute(ATTR_FIXED, '1');
        img.setAttribute(ATTR_GEN, String(gen));
        applyCoverFit(img);
        return;
      }
      img.setAttribute(ATTR_FIXED, '1');
      img.setAttribute(ATTR_GEN, String(gen));
      img.src = next;
      applyCoverFit(img);
    };

    if (isBackgroundUrl(currentSrc)) {
      applySwap();
      return;
    }

    const checkRatio = () => {
      if (generation !== gen || isEnhancedCoversActive()) return;
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      if (w > 0 && h > 0 && w / h > LANDSCAPE_RATIO) {
        applySwap();
      } else {
        img.setAttribute(ATTR_GEN, String(gen));
      }
    };

    if (img.complete && img.naturalWidth > 0) {
      checkRatio();
    } else {
      img.addEventListener('load', checkRatio, { once: true });
      img.setAttribute(ATTR_GEN, String(gen));
    }
  }

  /**
   * @param {string} imdbId
   * @param {string[]} typeHints
   * @returns {Promise<string|null>}
   */
  async function fetchCinemetaTitle(imdbId, typeHints) {
    if (titleCache.has(imdbId)) return titleCache.get(imdbId) || null;
    const types = typeHints.length ? typeHints : ['series', 'movie'];
    for (const type of types) {
      try {
        const res = await fetch(`${CINEMETA}/${type}/${imdbId}.json`);
        if (!res.ok) continue;
        const data = await res.json();
        const name = data?.meta?.name || data?.meta?.title;
        if (name && String(name).trim()) {
          const title = String(name).trim();
          titleCache.set(imdbId, title);
          return title;
        }
      } catch (_) {
        /* try next type */
      }
    }
    titleCache.set(imdbId, '');
    return null;
  }

  /**
   * Sync CW title-label to the current detail href (React remount often leaves stale text).
   * Does not apply Enhanced Titlebar chrome (year/rating/genres).
   * @param {Element} item
   */
  function syncCwTitleLabel(item) {
    if (!item || !item.closest?.('[class*="continue-watching"]')) return;
    // Enhanced Titlebar owns the rewritten title UI when active.
    if (item.querySelector?.('.enhanced-title-bar')) return;

    const link =
      item.matches?.('a[href]')
        ? item
        : item.querySelector?.('a[href*="tt"], a[href*="/detail/"]');
    const href = link?.getAttribute?.('href') || '';
    const imdbId = extractImdbId(href);
    if (!imdbId) return;

    const label =
      item.querySelector?.('[class*="title-label"]') ||
      item.querySelector?.('[class*="title-bar"] [class*="label"]');
    if (!label) return;

    if (label.getAttribute(ATTR_TITLE_ID) === imdbId && label.textContent?.trim()) {
      return;
    }

    const typeMatch = href.match(/detail\/([^/]+)\//);
    const typeHints = [];
    if (typeMatch?.[1]) typeHints.push(typeMatch[1]);
    typeHints.push('series', 'movie');

    const aria = link?.getAttribute?.('aria-label')?.trim();
    const linkTitle = link?.getAttribute?.('title')?.trim();
    const quick = aria || linkTitle;
    if (quick && quick.length > 1 && !/^tt\d+/i.test(quick)) {
      label.textContent = quick;
      label.setAttribute(ATTR_TITLE_ID, imdbId);
    }

    fetchCinemetaTitle(imdbId, typeHints).then((title) => {
      if (!title) return;
      if (extractImdbId(link?.getAttribute?.('href') || '') !== imdbId) return;
      if (item.querySelector?.('.enhanced-title-bar')) return;
      label.textContent = title;
      label.setAttribute(ATTR_TITLE_ID, imdbId);
    });
  }

  function scanTitles() {
    const root =
      document.querySelector('[class*="continue-watching-row"]') ||
      document.querySelector('[class*="continue-watching"]');
    if (!root) return;
    root
      .querySelectorAll('[class*="meta-item-container"], [class*="meta-item"]')
      .forEach((item) => {
        try {
          syncCwTitleLabel(item);
        } catch (_) {
          /* ignore */
        }
      });
  }

  function scan() {
    scheduled = false;
    bindObserver();

    scanTitles();

    if (isEnhancedCoversActive()) return;
    if (!/#\/(?:board)?\/?$|#\/$/.test(location.hash || '#/') && !document.querySelector('[class*="continue-watching"]')) {
      // Still scan if CW row exists on board-like views
    }

    const gen = ++generation;
    const root =
      document.querySelector('[class*="continue-watching-row"]') ||
      document.querySelector('[class*="continue-watching"]') ||
      document;
    const images = root.querySelectorAll('img[class*="poster-image"]');
    for (const img of images) {
      if (!(img instanceof HTMLImageElement)) continue;
      // Prefer images inside continue-watching when possible
      if (
        root !== document &&
        !img.closest('[class*="continue-watching"]') &&
        document.querySelector('[class*="continue-watching"]')
      ) {
        continue;
      }
      tryFixPoster(img, gen);
    }

    // Board CW row: also catch LibItem posters under continue-watching section
    for (const section of document.querySelectorAll('[class*="continue-watching"]')) {
      for (const img of section.querySelectorAll('img[class*="poster-image"], img[class*="poster"]')) {
        if (img instanceof HTMLImageElement) tryFixPoster(img, gen);
      }
    }
  }

  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scan();
    });
  }

  const observer = new MutationObserver(scheduleScan);
  /** @type {Element|null} */
  let observedRoot = null;

  /**
   * Prefer the Continue Watching row as observer root (avoids document-wide storms).
   * Falls back to document until the row mounts, then rebinds.
   */
  function bindObserver() {
    const cwRoot =
      document.querySelector('[class*="continue-watching-row"]') ||
      document.querySelector('[class*="continue-watching"]');
    const nextRoot = cwRoot || document.documentElement;
    if (!nextRoot) return;
    if (observedRoot === nextRoot) return;
    try {
      observer.disconnect();
    } catch (_) {
      /* ignore */
    }
    observedRoot = nextRoot;
    observer.observe(nextRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'class', 'href'],
    });
  }

  function onRouteOrBoot() {
    bindObserver();
    scheduleScan();
  }

  document.addEventListener('stremio-custom-route-change', onRouteOrBoot);
  window.addEventListener('hashchange', onRouteOrBoot);
  document.addEventListener('stremio-custom-bootstrap-ready', onRouteOrBoot);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onRouteOrBoot, { once: true });
  } else {
    onRouteOrBoot();
  }

})();
