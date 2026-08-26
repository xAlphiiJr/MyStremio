/**
 * @name Detail Slogan
 * @description Shows the TMDB tagline on the detail page below the title/logo.
 * @version 1.0.2
 * @author allecsc / Stremio-Kai; adapted by MyStremio
 * @credit Tagline feature based on Stremio-Kai by allecsc (https://github.com/allecsc/Stremio-Kai)
 * @category Metadata
 */

(function () {
  'use strict';

  if (window.__DetailSloganLoaded) return;
  window.__DetailSloganLoaded = true;

  const PLUGIN_ID = 'detail-slogan';
  const STYLE_ID = 'detail-slogan-css';
  const SLOGAN_CLASS = 'detail-slogan';
  const CACHE_SIZE = 64;

  /** @type {Map<string, string|null>} */
  const taglineCache = new Map();
  let generation = 0;
  let retryTimer = null;
  let debounceTimer = null;
  /** @type {MutationObserver|null} */
  let observer = null;

  /**
   * Escapes text for safe HTML textContent assignment is preferred;
   * this helper is used when building quoted display strings.
   * @param {unknown} text
   * @returns {string}
   */
  function normalizeTagline(text) {
    return String(text == null ? '' : text).trim();
  }

  /**
   * Wraps a tagline in double quotes when not already quoted.
   * @param {string} tagline
   * @returns {string}
   */
  function formatSlogan(tagline) {
    const raw = normalizeTagline(tagline);
    if (!raw) return '';
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('\u201c') && raw.endsWith('\u201d'))) {
      return raw;
    }
    return `"${raw}"`;
  }

  /**
   * @returns {boolean}
   */
  function isDetailRoute() {
    const hash = String(location.hash || '');
    if (/#\/player\b/i.test(hash)) return false;
    return /#\/(?:detail|metadetails|meta)\b/i.test(hash);
  }

  /**
   * @returns {string|null}
   */
  function getImdbIdFromHash() {
    const match = String(location.hash || '').match(/tt\d+/i);
    return match ? match[0].toLowerCase() : null;
  }

  /**
   * Resolves TMDB API key from the shared vault, then plugin settings.
   * @returns {Promise<string|null>}
   */
  async function resolveTmdbApiKey() {
    try {
      const client = window.StremioCustomAPI || window.StremioEnhancedAPI;
      if (client?.getApiKey) {
        const shared = await client.getApiKey('tmdb');
        if (shared && String(shared).trim()) return String(shared).trim();
      }
      if (client?.getSetting) {
        for (const plugin of [PLUGIN_ID, 'data-enrichment', 'meta-hover-panel']) {
          const value = await client.getSetting(plugin, 'tmdbApiKey');
          if (value && String(value).trim()) return String(value).trim();
        }
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  /**
   * Fetches TMDB tagline for an IMDb id.
   * @param {string} imdbId
   * @param {string} apiKey
   * @returns {Promise<string|null>}
   */
  async function fetchTagline(imdbId, apiKey) {
    if (taglineCache.has(imdbId)) return taglineCache.get(imdbId);

    try {
      const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id`;
      const findResponse = await fetch(findUrl);
      if (!findResponse.ok) {
        taglineCache.set(imdbId, null);
        return null;
      }

      const findData = await findResponse.json();
      let tmdbId = null;
      let mediaType = 'movie';

      if (findData.movie_results?.[0]?.id) {
        tmdbId = findData.movie_results[0].id;
        mediaType = 'movie';
      } else if (findData.tv_results?.[0]?.id) {
        tmdbId = findData.tv_results[0].id;
        mediaType = 'tv';
      }

      if (!tmdbId) {
        taglineCache.set(imdbId, null);
        return null;
      }

      const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${apiKey}`;
      const detailResponse = await fetch(detailUrl);
      if (!detailResponse.ok) {
        taglineCache.set(imdbId, null);
        return null;
      }

      const detail = await detailResponse.json();
      const tagline = normalizeTagline(detail?.tagline) || null;

      if (taglineCache.size >= CACHE_SIZE) {
        const oldest = taglineCache.keys().next().value;
        taglineCache.delete(oldest);
      }
      taglineCache.set(imdbId, tagline);
      return tagline;
    } catch (err) {
      console.warn('[DetailSlogan] Fetch error:', err);
      return null;
    }
  }

  /**
   * Visible meta-info mount (same rules as Data Enrichment).
   * @returns {Element|null}
   */
  function findMetaInfoContainer() {
    const selectors = [
      '[class*="meta-info-container"]',
      '[class*="meta-preview-container"] [class*="meta-info"]',
      '[class*="meta-details-container"] [class*="meta-info"]',
    ];

    /** @type {Element[]} */
    const candidates = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (
          el.closest(
            '[class*="player-container"], [class*="control-bar-layer"], [class*="subtitles-menu-container"]'
          )
        ) {
          continue;
        }
        if (el.closest('[class*="meta-preview-placeholder-container"]')) continue;
        if (!el.isConnected) continue;
        candidates.push(el);
      }
    }
    if (!candidates.length) return null;

    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const underDetails = candidates.filter(
      (el) => el.closest('[class*="meta-details"]') && isVisible(el)
    );
    if (underDetails.length) return underDetails[0];

    const visible = candidates.filter(isVisible);
    if (visible.length) return visible[0];

    return candidates[0];
  }

  /**
   * IMDb id from the live details tree (series overview often has no tt in the hash).
   * @returns {string|null}
   */
  function extractImdbIdFromVisibleRoot() {
    const mount = findMetaInfoContainer();
    const root =
      mount?.closest('[class*="meta-details"], [class*="meta-preview"], [class*="metadetails"]') ||
      mount;
    if (!root) return null;
    const hrefNodes = root.querySelectorAll('a[href], [href], [class*="imdb-button-container"]');
    for (const el of hrefNodes) {
      const blob = `${el.getAttribute('href') || ''} ${el.getAttribute('title') || ''}`;
      const match = blob.match(/tt\d{7,8}/i);
      if (match) return match[0].toLowerCase();
    }
    const textMatch = String(root.textContent || '').match(/tt\d{7,8}/i);
    return textMatch ? textMatch[0].toLowerCase() : null;
  }

  /**
   * @returns {string|null}
   */
  function resolveImdbId() {
    return getImdbIdFromHash() || extractImdbIdFromVisibleRoot();
  }

  /**
   * Finds the year/runtime row to insert the slogan before.
   * @param {Element} metaInfo
   * @returns {Element|null}
   */
  function findRuntimeRow(metaInfo) {
    return (
      metaInfo.querySelector('[class*="runtime-release-info"]') ||
      metaInfo.querySelector('[class*="duration-release-info"]') ||
      null
    );
  }

  /**
   * Removes all injected slogan nodes.
   */
  function removeSloganNodes() {
    document.querySelectorAll(`.${SLOGAN_CLASS}`).forEach((node) => node.remove());
  }

  /**
   * Injects the slogan element into the detail meta block.
   * @param {string} tagline
   * @param {string} imdbId
   * @returns {boolean} whether injection succeeded
   */
  function injectSlogan(tagline, imdbId) {
    const formatted = formatSlogan(tagline);
    if (!formatted) return false;

    const metaInfo = findMetaInfoContainer();
    if (!metaInfo) return false;

    document.querySelectorAll(`.${SLOGAN_CLASS}`).forEach((node) => {
      if (!metaInfo.contains(node)) node.remove();
    });

    const existing = metaInfo.querySelector(`.${SLOGAN_CLASS}`);
    if (existing) {
      if (existing.dataset.imdbId === imdbId && existing.textContent === formatted) {
        return true;
      }
      existing.remove();
    }

    const sloganEl = document.createElement('div');
    sloganEl.className = SLOGAN_CLASS;
    sloganEl.dataset.imdbId = imdbId;
    sloganEl.textContent = formatted;

    const runtimeRow = findRuntimeRow(metaInfo);
    if (runtimeRow?.parentElement === metaInfo) {
      metaInfo.insertBefore(sloganEl, runtimeRow);
    } else if (runtimeRow) {
      runtimeRow.parentElement.insertBefore(sloganEl, runtimeRow);
    } else {
      const logo =
        metaInfo.querySelector('[class*="logo-"]:not([class*="logo-container"])') ||
        metaInfo.querySelector('img[class*="logo"]') ||
        metaInfo.querySelector('[class*="logo-placeholder"]') ||
        metaInfo.querySelector('[class*="logo-container"]');
      if (logo?.nextSibling) {
        logo.parentElement.insertBefore(sloganEl, logo.nextSibling);
      } else if (logo) {
        logo.parentElement.appendChild(sloganEl);
      } else {
        metaInfo.insertBefore(sloganEl, metaInfo.firstChild);
      }
    }

    return true;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${SLOGAN_CLASS} {
        color: rgba(255, 255, 255, 0.95);
        font-family: "PlusJakartaSans", Candara, Calibri, "Segoe UI", sans-serif;
        font-style: italic;
        font-weight: 700;
        font-size: 1.2rem;
        letter-spacing: 0.01em;
        line-height: 1.45;
        /* Logo keeps native top position + margin-bottom; slogan only pushes content below */
        margin: 0 0 1rem;
        max-width: 36rem;
        text-shadow: 0 1px 8px rgba(0, 0, 0, 0.45);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * Schedules a delayed detail check.
   * @param {number} [delayMs]
   */
  function scheduleCheck(delayMs = 80) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      checkAndInject();
    }, delayMs);
  }

  async function checkAndInject() {
    const gen = ++generation;

    if (!isDetailRoute()) {
      removeSloganNodes();
      return;
    }

    const metaInfo = findMetaInfoContainer();
    if (!metaInfo) {
      scheduleCheck(120);
      return;
    }

    const imdbId = resolveImdbId();
    if (!imdbId) {
      removeSloganNodes();
      scheduleCheck(200);
      return;
    }

    const existing = metaInfo.querySelector(`.${SLOGAN_CLASS}`);
    if (existing?.dataset.imdbId === imdbId && metaInfo.contains(existing)) return;

    const apiKey = await resolveTmdbApiKey();
    if (gen !== generation) return;
    if (!apiKey) return;

    const tagline = await fetchTagline(imdbId, apiKey);
    if (gen !== generation) return;
    if (!tagline) {
      removeSloganNodes();
      return;
    }

    if (!injectSlogan(tagline, imdbId)) {
      scheduleCheck(150);
    }
  }

  function onRouteChange() {
    generation += 1;
    removeSloganNodes();
    scheduleCheck(60);
  }

  function setupObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (!isDetailRoute()) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        checkAndInject();
      }, 100);
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function bindSloganObserver() {
    if (!observer) setupObserver();
    else {
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  }

  window.__stremioDetailSloganSuspend = function () {
    try {
      observer?.disconnect();
    } catch (_) {}
  };

  window.__stremioDetailSloganResume = function () {
    bindSloganObserver();
    if (isDetailRoute()) scheduleCheck(60);
  };

  function init() {
    ensureStyles();
    setupObserver();

    document.addEventListener('stremio-custom-route-change', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);

    const client = window.StremioCustomAPI || window.StremioEnhancedAPI;
    if (client?.onSettingsSaved) {
      client.onSettingsSaved(PLUGIN_ID, () => {
        taglineCache.clear();
        onRouteChange();
      });
      client.onSettingsSaved('data-enrichment', () => {
        taglineCache.clear();
        onRouteChange();
      });
    }

    scheduleCheck(100);
    if (window.stremioCustomSuspendBackground?.()) {
      window.__stremioDetailSloganSuspend?.();
    }
    console.log('[DetailSlogan] Plugin loaded v1.0.2 (based on Stremio-Kai / allecsc; adapted by MyStremio)');
  }

  window.__stremioDetailSloganUnload = function () {
    generation += 1;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    removeSloganNodes();
    document.getElementById(STYLE_ID)?.remove();
    document.removeEventListener('stremio-custom-route-change', onRouteChange);
    window.removeEventListener('hashchange', onRouteChange);
    try {
      delete window.__DetailSloganLoaded;
    } catch (_) {
      window.__DetailSloganLoaded = false;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
