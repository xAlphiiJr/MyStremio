/**
 * @name Meta Hover Panel
 * @description Rich movie/series info panel on poster hover using Cinemeta metadata.
 * @version 2.1.4
 * @author MyStremio
 * @category Metadata
 */

(function () {
  'use strict';

  const CONFIG = {
    HOVER_DELAY: 450,
    API_BASE: 'https://v3-cinemeta.strem.io/meta',
    API_TIMEOUT: 2500,
    CACHE_SIZE: 80,
    PANEL_WIDTH: 420,
    MAX_CAST: 4,
    MAX_GENRES: 6,
  };

  const metaCache = new Map();
  const photoCache = new Map();
  const imdbResolveCache = new Map();
  const ratingsCache = new Map();
  const ratingsPending = new Map();
  const RATINGS_CACHE_TTL_MS = 10 * 60 * 1000;
  const RATINGS_INCOMPLETE_TTL_MS = 5 * 1000;
  let hoverTimer = null;
  let activePanel = null;
  let activeAnchor = null;
  let trackedAnchor = null;
  let showGeneration = 0;
  let moveRaf = null;
  let catalogCache = { at: 0, items: [] };

  const styles = `
    .meta-hover-panel {
      position: fixed;
      width: ${CONFIG.PANEL_WIDTH}px;
      max-height: min(78vh, 640px);
      overflow: hidden auto;
      z-index: 100;
      border-radius: 14px;
      background: rgba(18, 18, 22, 0.94);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow:
        0 16px 48px rgba(0, 0, 0, 0.55),
        0 0 0 1px rgba(123, 91, 245, 0.25),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(18px) saturate(160%);
      color: #fff;
      font-family: inherit;
      pointer-events: none;
      opacity: 0;
      transform: translateY(8px) scale(0.98);
      transition: opacity 0.2s ease, transform 0.2s ease;
    }

    .meta-hover-panel.visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    .meta-hover-panel-header {
      padding: 1.1rem 1.15rem 0.85rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .meta-hover-panel-title {
      font-size: 1.35rem;
      font-weight: 700;
      line-height: 1.25;
      margin-bottom: 0.45rem;
    }

    .meta-hover-panel-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.55rem;
      align-items: center;
      font-size: 0.82rem;
      color: rgba(255, 255, 255, 0.78);
    }

    .meta-hover-panel-imdb {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      background: linear-gradient(135deg, #f5c518, #e4b00d);
      color: #111;
      font-weight: 800;
      font-size: 0.68rem;
      padding: 0.15rem 0.35rem;
      border-radius: 3px;
    }

    .meta-hover-panel-rating {
      font-weight: 700;
      color: #f5c518;
    }

    .meta-hover-panel-ratings-host {
      display: inline-flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.35rem;
      min-height: 22px;
      max-width: 100%;
      margin-top: 0.15rem;
      pointer-events: auto;
    }

    .meta-hover-panel-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.28rem;
      margin: 0;
      padding: 0.18rem 0.45rem;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(0, 0, 0, 0.42);
      color: #fff;
      font: inherit;
      font-size: 0.72rem;
      font-weight: 700;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      cursor: pointer;
      border-radius: 999px;
    }

    .meta-hover-panel-chip:hover {
      filter: brightness(1.08);
      border-color: rgba(255, 255, 255, 0.24);
    }

    .meta-hover-panel-chip-brand {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 15px;
      padding: 0 5px;
      border-radius: 3px;
      font-size: 0.58rem;
      font-weight: 800;
      letter-spacing: 0.02em;
    }

    .meta-hover-panel-chip-brand[data-key="imdb"] { background: #f5c518; color: #111; }
    .meta-hover-panel-chip-brand[data-key="tmdb"] { background: #032541; color: #01b4e4; }
    .meta-hover-panel-chip-brand[data-key="mal"] { background: #2e51a2; color: #fff; }
    .meta-hover-panel-chip-brand[data-key="metacritic"] { background: #ffcc33; color: #111; }
    .meta-hover-panel-chip-brand[data-key="mcusers"] { background: #6c5ce7; color: #fff; }
    .meta-hover-panel-chip-brand[data-key="trakt"] { background: #ed1c24; color: #fff; }
    .meta-hover-panel-chip-brand[data-key="letterboxd"] { background: #14181c; color: #00e054; }
    .meta-hover-panel-chip-brand[data-key="rt"] { background: #fa320a; color: #fff; }
    .meta-hover-panel-chip-brand[data-key="tvmaze"] { background: #3c948b; color: #fff; }
    .meta-hover-panel-chip-brand[data-key="tvdb"] { background: #6cd591; color: #111; }

    .meta-hover-panel-chip-value { font-weight: 700; }
    .meta-hover-panel-chip-value[data-key="imdb"] { color: #f5c518; }
    .meta-hover-panel-chip-value[data-key="tmdb"] { color: #01b4e4; }
    .meta-hover-panel-chip-value[data-key="mal"] { color: #2ecc71; }
    .meta-hover-panel-chip-value[data-key="rt"] { color: #fa320a; }
    .meta-hover-panel-chip-value[data-key="metacritic"] { color: #2ecc71; }
    .meta-hover-panel-chip-value[data-key="trakt"] { color: #ed1c24; }
    .meta-hover-panel-chip-value[data-key="letterboxd"] { color: #00e054; }
    .meta-hover-panel-chip-value[data-key="tvmaze"] { color: #3c948b; }
    .meta-hover-panel-chip-value[data-key="tvdb"] { color: #6cd591; }

    .meta-hover-panel-chip[data-key="fsk"] {
      background: rgba(245, 197, 24, 0.16);
      border-color: rgba(245, 197, 24, 0.45);
    }

    .meta-hover-panel-chip-age {
      min-width: 1.4rem;
      padding: 0.05rem 0.35rem;
      border-radius: 999px;
      background: #f5c518;
      color: #111;
      font-size: 0.65rem;
      font-weight: 800;
      text-align: center;
    }

    .meta-hover-panel-ratings-skeleton {
      display: inline-block;
      width: 148px;
      height: 14px;
      border-radius: 4px;
      background: linear-gradient(
        90deg,
        rgba(255, 255, 255, 0.08),
        rgba(255, 255, 255, 0.18),
        rgba(255, 255, 255, 0.08)
      );
      background-size: 200% 100%;
      animation: meta-hover-ratings-shimmer 1.1s ease-in-out infinite;
    }

    @keyframes meta-hover-ratings-shimmer {
      0% { background-position: 100% 0; }
      100% { background-position: -100% 0; }
    }

    .meta-hover-panel-section {
      padding: 0.85rem 1.15rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .meta-hover-panel-section:last-child {
      border-bottom: none;
    }

    .meta-hover-panel-label {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: rgba(255, 255, 255, 0.45);
      margin-bottom: 0.45rem;
    }

    .meta-hover-panel-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }

    .meta-hover-panel-tag {
      padding: 0.28rem 0.65rem;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 0.78rem;
      color: rgba(255, 255, 255, 0.9);
    }

    .meta-hover-panel-plot {
      font-size: 0.86rem;
      line-height: 1.45;
      color: rgba(255, 255, 255, 0.82);
      display: -webkit-box;
      -webkit-line-clamp: 5;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .meta-hover-panel-person {
      display: flex;
      align-items: center;
      gap: 0.65rem;
    }

    .meta-hover-panel-person img {
      width: 2.4rem;
      height: 2.4rem;
      border-radius: 50%;
      object-fit: cover;
      background: rgba(255, 255, 255, 0.08);
    }

    .meta-hover-panel-person-name {
      font-size: 0.88rem;
      font-weight: 600;
    }

    .meta-hover-panel-person-role {
      font-size: 0.76rem;
      color: rgba(255, 255, 255, 0.55);
    }

    .meta-hover-panel-cast-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.65rem;
    }

    .meta-hover-panel-loading {
      padding: 1.25rem 1.15rem;
      font-size: 0.85rem;
      color: rgba(255, 255, 255, 0.6);
    }
  `;

  function injectStyles() {
    if (document.getElementById('meta-hover-panel-css')) return;
    const style = document.createElement('style');
    style.id = 'meta-hover-panel-css';
    style.textContent = styles;
    document.head.appendChild(style);
  }

  function extractImdbFromSource(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.match(/tt\d{7,}/i);
    return match ? match[0].toLowerCase() : null;
  }

  function normalizeTitle(text) {
    return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function getPosterImdbId(root) {
    if (!root) return null;
    // Prefer detail href over poster Metahub / data-imdb-id (CW reuse).
    const hrefCandidates = [];
    if (root.getAttribute?.('href')) hrefCandidates.push(root.getAttribute('href'));
    if (root.href) hrefCandidates.push(root.href);
    root.querySelectorAll?.('[href]').forEach((node) => {
      const href = node.getAttribute('href');
      if (href) hrefCandidates.push(href);
    });
    for (const value of hrefCandidates) {
      const id = extractImdbFromSource(value);
      if (id) return id;
    }
    const nodes = [root, ...root.querySelectorAll('img, [data-imdb-id], [data-id]')];
    for (const node of nodes) {
      const attrs = [
        node.getAttribute?.('data-imdb-id'),
        node.getAttribute?.('data-id'),
        node.getAttribute?.('src'),
        node.getAttribute?.('data-src'),
        node.getAttribute?.('data-original'),
      ];
      for (const value of attrs) {
        const id = extractImdbFromSource(value);
        if (id) return id;
      }
    }
    return null;
  }

  function findCatalogMatch(items, title, posterImdbId) {
    const norm = normalizeTitle(title);
    if (!norm && !posterImdbId) return null;

    if (posterImdbId) {
      const byImdb = items.find((item) => extractImdbFromItem(item) === posterImdbId);
      if (byImdb) return byImdb;
    }

    if (!norm) return null;

    const exact = items.find((item) => normalizeTitle(item?.name) === norm);
    if (exact) return exact;

    const candidates = items.filter((item) => {
      const itemTitle = normalizeTitle(item?.name);
      if (!itemTitle) return false;
      return itemTitle === norm
        || itemTitle.startsWith(`${norm} `)
        || itemTitle.startsWith(`${norm}:`)
        || itemTitle.startsWith(`${norm}-`);
    });

    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1 && posterImdbId) {
      return candidates.find((item) => extractImdbFromItem(item) === posterImdbId) || null;
    }

    return null;
  }

  function parseMediaFromHref(href) {
    if (!href) return null;

    const patterns = [
      /\/(?:detail|metadetails)\/(movie|series)\/([^/?#]+)/i,
      /\/player\/[^/]+\/[^/]+\/[^/]+\/(movie|series)\/([^/?#]+)/i,
      /\/library\/(movie|series)\/([^/?#]+)/i,
    ];

    for (const pattern of patterns) {
      const match = href.match(pattern);
      if (match) {
        return { type: match[1].toLowerCase(), id: decodeURIComponent(match[2]) };
      }
    }

    const imdbMatch = href.match(/tt\d{7,}/i);
    if (imdbMatch) {
      const type = /series|episode|season/i.test(href) ? 'series' : 'movie';
      return { type, id: imdbMatch[0] };
    }

    return null;
  }

  function parseMediaFromText(text) {
    if (!text) return null;
    const imdbMatch = text.match(/tt\d{7,}/i);
    if (!imdbMatch) return null;
    const type = /series|episode|season/i.test(text) ? 'series' : 'movie';
    return { type, id: imdbMatch[0] };
  }

  function getItemTitle(root) {
    return (
      root.querySelector('[class*="title-label"]')?.textContent?.trim() ||
      root.querySelector('[class*="title-bar"] [class*="title"]')?.textContent?.trim() ||
      root.getAttribute('title')?.trim() ||
      ''
    );
  }

  async function loadCatalogItems() {
    if (Date.now() - catalogCache.at < 4000) {
      return catalogCache.items;
    }

    const models = ['continue_watching_preview', 'continue_watching', 'library'];
    const items = [];

    for (const model of models) {
      try {
        const state = await window.services?.core?.transport?.getState(model);
        if (Array.isArray(state?.items)) {
          items.push(...state.items);
        }
        if (Array.isArray(state?.catalog)) {
          items.push(...state.catalog);
        }
      } catch {
        // Ignore unavailable models.
      }
    }

    catalogCache = { at: Date.now(), items };
    return items;
  }

  function normalizeMediaType(itemOrType) {
    const raw =
      typeof itemOrType === 'string'
        ? itemOrType
        : itemOrType?.type || itemOrType?.contentType || 'movie';
    const value = String(raw).toLowerCase();
    return value === 'series' || value === 'tv' || value === 'episode' ? 'series' : 'movie';
  }

  function extractImdbFromItem(item) {
    if (!item) return null;

    const candidates = [item.imdb_id, item.imdbId, item.ids?.imdb, item.id, item._id];
    for (const value of candidates) {
      if (typeof value !== 'string') continue;
      const match = value.match(/tt\d{7,}/i);
      if (match) return match[0].toLowerCase();
    }

    if (typeof item.series === 'string') {
      const seriesMatch = item.series.match(/tt\d{7,}/i);
      if (seriesMatch) return seriesMatch[0].toLowerCase();
    }

    if (Array.isArray(item.links)) {
      for (const link of item.links) {
        const source = [link.url, link.href, link.name, link.id].filter(Boolean).join(' ');
        const match = source.match(/tt\d{7,}/i);
        if (match) return match[0].toLowerCase();
      }
    }

    return null;
  }

  function mediaFromCatalogItem(item) {
    if (!item) return null;

    const type = normalizeMediaType(item);
    const imdbId = extractImdbFromItem(item);
    if (imdbId) {
      return { type, id: imdbId, item };
    }

    const rawId = typeof item.id === 'string' ? item.id : '';
    const tmdbMatch = rawId.match(/^tmdb:(\d+)$/i);
    if (tmdbMatch) {
      return { type, id: rawId, tmdbId: tmdbMatch[1], item };
    }

    return null;
  }

  async function resolveFromCatalog(root) {
    const title = getItemTitle(root);
    const hrefId = (() => {
      const hrefCandidates = new Set();
      [root.getAttribute?.('href'), root.href]
        .filter(Boolean)
        .forEach((href) => hrefCandidates.add(href));
      root.querySelectorAll('[href]').forEach((node) => {
        const href = node.getAttribute('href');
        if (href) hrefCandidates.add(href);
      });
      for (const href of hrefCandidates) {
        const media = parseMediaFromHref(href);
        if (media?.id && /^tt\d{7,}$/i.test(media.id)) return media.id.toLowerCase();
      }
      return null;
    })();
    const posterImdbId = hrefId || getPosterImdbId(root);
    if (!title && !posterImdbId) return null;

    const items = await loadCatalogItems();
    const match = findCatalogMatch(items, title, posterImdbId);
    return mediaFromCatalogItem(match);
  }

  function clearResolvedMedia(root) {
    if (!root) return;
    delete root.dataset.metaHoverId;
    delete root.dataset.metaHoverType;
  }

  function invalidateCatalogCache() {
    catalogCache = { at: 0, items: [] };
  }

  function clearHoverBindingsIn(container) {
    if (!container) return;
    container.querySelectorAll('[class*="meta-item-container"]').forEach((root) => {
      clearResolvedMedia(root);
    });
  }

  function isCatalogMutation(mutations) {
    for (const mutation of mutations) {
      const target = mutation.target;
      if (target instanceof Element) {
        if (target.closest('[class*="meta-items-container"], [class*="meta-row-container"], [class*="continue-watching"]')) {
          return true;
        }
      }
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          if (
            node.matches?.('[class*="meta-item"], [class*="meta-item-container"], [class*="meta-items-container"]')
            || node.querySelector?.('[class*="meta-item"], [class*="meta-item-container"]')
          ) {
            return true;
          }
        }
      }
      for (const node of mutation.removedNodes) {
        if (node instanceof Element) {
          if (
            node.matches?.('[class*="meta-item"], [class*="meta-item-container"], [class*="meta-items-container"]')
            || node.querySelector?.('[class*="meta-item"], [class*="meta-item-container"]')
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  function datasetMatchesDom(root) {
    const datasetId = root.dataset.metaHoverId;
    if (!datasetId || !/^tt\d{7,}$/i.test(datasetId)) return false;

    const hrefCandidates = new Set();
    [root.getAttribute?.('href'), root.href]
      .filter(Boolean)
      .forEach((href) => hrefCandidates.add(href));
    root.querySelectorAll('[href]').forEach((node) => {
      const href = node.getAttribute('href');
      if (href) hrefCandidates.add(href);
    });
    for (const href of hrefCandidates) {
      const media = parseMediaFromHref(href);
      if (media?.id && /^tt\d{7,}$/i.test(media.id)) {
        return media.id.toLowerCase() === datasetId.toLowerCase();
      }
    }

    const posterId = getPosterImdbId(root);
    if (posterId && posterId !== datasetId.toLowerCase()) return false;

    return true;
  }

  function inferSeriesFromRoot(root) {
    const href = root.href || root.getAttribute('href') || '';
    if (/series|episode|season/i.test(href)) return true;

    for (const node of root.querySelectorAll('[href]')) {
      const nodeHref = node.getAttribute('href') || '';
      if (/series|episode|season/i.test(nodeHref)) return true;
    }

    const title = getItemTitle(root);
    if (title && /\bS\d{1,2}E\d{1,2}\b/i.test(title)) return true;

    return false;
  }

  function storeResolvedMedia(root, media) {
    if (!root || !media?.id) return;
    if (/^tt\d{7,}$/i.test(media.id)) {
      root.dataset.metaHoverId = media.id.toLowerCase();
      root.dataset.metaHoverType = media.type || 'movie';
    }
  }

  function annotateMetaItem(root) {
    if (root.dataset.metaHoverBound !== 'true') {
      root.dataset.metaHoverBound = 'true';
    }

    let resolvedId = null;
    let resolvedType = inferSeriesFromRoot(root) ? 'series' : 'movie';

    // Href first (CW React reuse leaves stale poster data-imdb-id).
    const href = root.href || root.getAttribute('href') || '';
    const media = parseMediaFromHref(href) || parseMediaFromText(root.textContent || '');
    if (media && /^tt\d{7,}$/i.test(media.id)) {
      resolvedId = media.id.toLowerCase();
      resolvedType = media.type || resolvedType;
    }

    if (!resolvedId) {
      root.querySelectorAll('[href]').forEach((node) => {
        if (resolvedId) return;
        const nodeMedia = parseMediaFromHref(node.getAttribute('href') || '');
        if (nodeMedia && /^tt\d{7,}$/i.test(nodeMedia.id)) {
          resolvedId = nodeMedia.id.toLowerCase();
          resolvedType = nodeMedia.type || resolvedType;
        }
      });
    }

    if (!resolvedId) {
      const posterId = getPosterImdbId(root);
      if (posterId) resolvedId = posterId;
    }

    if (resolvedId) {
      root.dataset.metaHoverId = resolvedId;
      root.dataset.metaHoverType = resolvedType;
    } else {
      clearResolvedMedia(root);
    }
  }

  let annotateTimer = null;
  function annotateMetaItems() {
    if (annotateTimer) clearTimeout(annotateTimer);
    annotateTimer = setTimeout(() => {
      annotateTimer = null;
      document.querySelectorAll('[class*="meta-item-container"]').forEach(annotateMetaItem);
    }, 120);
  }

  async function extractMediaInfo(element) {
    const root = element.closest('[class*="meta-item-container"]') || element;

    if (root.dataset.metaHoverId && !datasetMatchesDom(root)) {
      clearResolvedMedia(root);
    }

    const hrefCandidates = new Set();
    [root.getAttribute?.('href'), root.href]
      .filter(Boolean)
      .forEach((href) => hrefCandidates.add(href));

    root.querySelectorAll('[href]').forEach((node) => {
      const href = node.getAttribute('href');
      if (href) hrefCandidates.add(href);
    });

    // Prefer detail href over poster Metahub/data-imdb-id (CW card reuse after Detail).
    for (const href of hrefCandidates) {
      const media = parseMediaFromHref(href);
      if (!media) continue;

      if (/^tmdb:/i.test(media.id)) {
        const fromCatalog = await resolveFromCatalog(root);
        if (fromCatalog) {
          storeResolvedMedia(root, fromCatalog);
          return fromCatalog;
        }
        return { ...media, title: getItemTitle(root), item: null };
      }

      if (/^tt\d{7,}$/i.test(media.id)) {
        storeResolvedMedia(root, media);
        return media;
      }
    }

    const posterId = getPosterImdbId(root);
    if (posterId) {
      const media = {
        type: inferSeriesFromRoot(root) ? 'series' : 'movie',
        id: posterId,
      };
      storeResolvedMedia(root, media);
      return media;
    }

    const fromRootText = parseMediaFromText(root.textContent || '');
    if (fromRootText && /^tt\d{7,}$/i.test(fromRootText.id)) {
      storeResolvedMedia(root, fromRootText);
      return fromRootText;
    }

    const fromCatalog = await resolveFromCatalog(root);
    if (fromCatalog) {
      storeResolvedMedia(root, fromCatalog);
      return fromCatalog;
    }

    if (root.dataset.metaHoverId && /^tt\d{7,}$/i.test(root.dataset.metaHoverId) && datasetMatchesDom(root)) {
      return {
        type: root.dataset.metaHoverType || 'movie',
        id: root.dataset.metaHoverId.toLowerCase(),
      };
    }

    return null;
  }

  async function resolveImdbId(media) {
    if (!media?.id) return null;

    const rawId = String(media.id);
    if (/^tt\d{7,}$/i.test(rawId)) {
      return rawId.toLowerCase();
    }

    const cacheKey = `${media.type}:${rawId}`;
    if (imdbResolveCache.has(cacheKey)) {
      return imdbResolveCache.get(cacheKey);
    }

    const fromItem = extractImdbFromItem(media.item);
    if (fromItem) {
      imdbResolveCache.set(cacheKey, fromItem);
      return fromItem;
    }

    const tmdbId = media.tmdbId || rawId.match(/^tmdb:(\d+)$/i)?.[1];
    if (tmdbId) {
      const apiKey = await getTmdbApiKey();
      if (apiKey) {
        try {
          const mediaType = media.type === 'series' ? 'tv' : 'movie';
          const response = await fetch(
            `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/external_ids?api_key=${apiKey}`
          );
          if (response.ok) {
            const data = await response.json();
            if (data.imdb_id) {
              imdbResolveCache.set(cacheKey, data.imdb_id);
              return data.imdb_id;
            }
          }
        } catch {
          // Fall through to catalog title match.
        }
      }

      const title = media.item?.name?.trim() || media.title?.trim();
      if (title) {
        const items = await loadCatalogItems();
        const match = findCatalogMatch(items, title, null);
        const imdbId = extractImdbFromItem(match);
        if (imdbId) {
          imdbResolveCache.set(cacheKey, imdbId);
          return imdbId;
        }
      }
    }

    imdbResolveCache.set(cacheKey, null);
    return null;
  }

  function metaRequestUrls(type, id) {
    const fromGate = window.StremioCustomMetadataMetaGate?.metaRequestUrls;
    if (typeof fromGate === 'function') {
      const urls = fromGate(type, id);
      if (Array.isArray(urls) && urls.length) return urls;
    }
    const kind = String(type || 'movie').trim() || 'movie';
    const rawId = String(id || '').trim();
    if (!rawId) return [];
    return [`${CONFIG.API_BASE}/${kind}/${encodeURIComponent(rawId)}.json`];
  }

  function isUsableMeta(meta) {
    if (!meta || typeof meta !== 'object') return false;
    return Boolean(String(meta.name || meta.title || '').trim());
  }

  function isGatedMetaResponse(response, data) {
    if (!response) return true;
    if (data && data.error === 'mystremio-meta-gated') return true;
    if (response.status === 404) return true;
    return !response.ok;
  }

  /**
   * One provider URL. Failures return null and never abort siblings.
   * @param {string} url
   * @returns {Promise<object|null>}
   */
  async function fetchMetaUrl(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT);
    try {
      const response = await fetch(url, { signal: controller.signal });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (isGatedMetaResponse(response, data)) return null;
      const meta = data?.meta || null;
      return isUsableMeta(meta) ? meta : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parallel provider × id × type fetch. Chip order wins among usable results.
   * Misses are not cached so extra sources cannot poison a later TMDB hit.
   * @param {string} type
   * @param {string[]} ids
   * @returns {Promise<{meta: object, type: string}|null>}
   */
  async function fetchMetaCandidates(type, ids) {
    const unique = [];
    const seen = new Set();
    for (const id of ids || []) {
      const raw = String(id || '').trim();
      if (!raw) continue;
      if (!/^tt\d{7,}$/i.test(raw) && !/^tmdb:\d+$/i.test(raw)) continue;
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(raw);
    }
    if (!unique.length) return null;

    const requested = String(type || 'movie').trim() || 'movie';
    const alt = requested === 'series' ? 'movie' : 'series';
    const kinds = [requested, alt];
    const tasks = [];
    unique.forEach((id, idIndex) => {
      kinds.forEach((kind, typeIndex) => {
        const urls = metaRequestUrls(kind, id);
        urls.forEach((url, urlIndex) => {
          tasks.push({
            order: idIndex * 10000 + typeIndex * 100 + urlIndex,
            kind,
            id,
            url,
          });
        });
      });
    });
    if (!tasks.length) return null;

    const results = await Promise.allSettled(tasks.map((task) => fetchMetaUrl(task.url)));
    let best = null;
    let bestOrder = Infinity;
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled' || !result.value) return;
      const task = tasks[index];
      if (task.order >= bestOrder) return;
      bestOrder = task.order;
      best = { meta: result.value, type: task.kind, id: task.id };
    });
    if (best) {
      const key = `${best.type}:${best.id}`;
      if (metaCache.size >= CONFIG.CACHE_SIZE) {
        metaCache.delete(metaCache.keys().next().value);
      }
      metaCache.set(key, best.meta);
    }
    return best;
  }

  function getGenres(meta) {
    if (Array.isArray(meta.genre) && meta.genre.length) return meta.genre;
    if (!Array.isArray(meta.links)) return [];
    return meta.links
      .filter((link) => /genre/i.test(link.category || ''))
      .map((link) => link.name)
      .filter(Boolean);
  }

  function getDirector(meta) {
    if (Array.isArray(meta.director) && meta.director.length) return meta.director[0];
    if (!Array.isArray(meta.links)) return null;
    const link = meta.links.find((l) => /director/i.test(l.category || ''));
    return link?.name || null;
  }

  function getCast(meta) {
    if (Array.isArray(meta.enrichedCast) && meta.enrichedCast.length) {
      return meta.enrichedCast;
    }

    if (Array.isArray(meta.cast) && meta.cast.length) {
      return meta.cast.slice(0, CONFIG.MAX_CAST).map((person) => ({
        name: person.name || person,
        character: person.character || '',
        photo: person.photo || person.image || person.thumbnail || null,
      }));
    }

    if (!Array.isArray(meta.links)) return [];
    return meta.links
      .filter((link) => /cast|actor/i.test(link.category || ''))
      .slice(0, CONFIG.MAX_CAST)
      .map((link) => ({
        name: link.name,
        character: link.description || '',
        photo: link.thumbnail || link.icon || null,
      }));
  }

  async function getTmdbApiKey() {
    try {
      const client = window.StremioCustomAPI || window.StremioEnhancedAPI;
      const value = await client?.getSetting?.('meta-hover-panel', 'tmdbApiKey');
      return value && String(value).trim() ? String(value).trim() : null;
    } catch {
      return null;
    }
  }

  async function fetchTmdbCast(imdbId, type, apiKey) {
    const cacheKey = `tmdb:${imdbId}`;
    if (photoCache.has(cacheKey)) return photoCache.get(cacheKey);

    try {
      const findResponse = await fetch(
        `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id`
      );
      if (!findResponse.ok) return null;

      const findData = await findResponse.json();
      let tmdbId = null;
      let mediaType = type === 'series' ? 'tv' : 'movie';

      if (type === 'series' && findData.tv_results?.[0]) {
        tmdbId = findData.tv_results[0].id;
        mediaType = 'tv';
      } else if (findData.movie_results?.[0]) {
        tmdbId = findData.movie_results[0].id;
        mediaType = 'movie';
      } else if (findData.tv_results?.[0]) {
        tmdbId = findData.tv_results[0].id;
        mediaType = 'tv';
      }

      if (!tmdbId) return null;

      const creditsResponse = await fetch(
        `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/credits?api_key=${apiKey}`
      );
      if (!creditsResponse.ok) return null;

      const credits = await creditsResponse.json();
      const cast = (credits.cast || []).slice(0, CONFIG.MAX_CAST).map((actor) => ({
        name: actor.name,
        character: actor.character || '',
        photo: actor.profile_path
          ? `https://image.tmdb.org/t/p/w185${actor.profile_path}`
          : null,
      }));

      photoCache.set(cacheKey, cast);
      return cast;
    } catch {
      return null;
    }
  }

  async function wikipediaSummaryPhoto(pageTitle, controller) {
    const encoded = encodeURIComponent(String(pageTitle).replace(/ /g, '_'));
    const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.thumbnail?.source || null;
  }

  async function wikipediaSearchPhoto(query, controller) {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&format=json&origin=*`;
    const response = await fetch(searchUrl, { signal: controller.signal });
    if (!response.ok) return null;

    const searchData = await response.json();
    const hits = searchData.query?.search || [];
    for (const hit of hits) {
      const photo = await wikipediaSummaryPhoto(hit.title, controller);
      if (photo) return photo;
    }
    return null;
  }

  async function fetchWikipediaPhoto(name) {
    const cacheKey = `wiki:${name}`;
    if (photoCache.has(cacheKey)) return photoCache.get(cacheKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);

    try {
      let photo = await wikipediaSummaryPhoto(name.trim().replace(/ /g, '_'), controller);
      if (!photo) {
        photo = await wikipediaSearchPhoto(name, controller);
      }
      photoCache.set(cacheKey, photo);
      return photo;
    } catch {
      photoCache.set(cacheKey, null);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchActorPhoto(name, filmTitle) {
    const cacheKey = `actor:${normalizeTitle(name)}`;
    if (photoCache.has(cacheKey)) return photoCache.get(cacheKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);

    try {
      let photo = await wikipediaSummaryPhoto(name.trim().replace(/ /g, '_'), controller);
      if (photo) {
        photoCache.set(cacheKey, photo);
        return photo;
      }

      const queries = [
        `${name} (actor)`,
        `${name} actor`,
        name,
      ];
      if (filmTitle) queries.unshift(`${name} ${filmTitle}`);

      for (const query of queries) {
        const photo = await wikipediaSearchPhoto(query, controller);
        if (photo) {
          photoCache.set(cacheKey, photo);
          return photo;
        }
      }

      photoCache.set(cacheKey, null);
      return null;
    } catch {
      photoCache.set(cacheKey, null);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function enrichCast(meta, type) {
    const imdbId = meta.imdb_id || (String(meta.id || '').startsWith('tt') ? meta.id : null);
    const apiKey = await getTmdbApiKey();
    const baseCast = getCast(meta).slice(0, CONFIG.MAX_CAST);
    const photoByName = new Map();

    if (apiKey && imdbId) {
      const tmdbCast = await fetchTmdbCast(imdbId, type, apiKey);
      if (tmdbCast?.length) {
        for (const actor of tmdbCast) {
          if (actor.photo) {
            photoByName.set(normalizeTitle(actor.name), actor.photo);
          }
        }
      }
    }

    const filmTitle = meta.name || '';
    const enriched = [];
    for (const actor of baseCast) {
      let photo = actor.photo || photoByName.get(normalizeTitle(actor.name)) || null;
      if (!photo) {
        photo = await fetchActorPhoto(actor.name, filmTitle);
      }
      enriched.push({ ...actor, photo });
    }

    meta.enrichedCast = enriched;
    return enriched;
  }

  function appendPersonPhoto(container, photo, altText) {
    if (photo) {
      const img = document.createElement('img');
      img.src = photo;
      img.alt = altText;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => {
        img.replaceWith(createPhotoPlaceholder());
      };
      container.appendChild(img);
      return;
    }

    container.appendChild(createPhotoPlaceholder());
  }

  function createPhotoPlaceholder() {
    const placeholder = document.createElement('div');
    placeholder.style.cssText =
      'width:2.4rem;height:2.4rem;border-radius:50%;background:rgba(255,255,255,0.08);';
    return placeholder;
  }

  function buildMetaLine(meta, type) {
    const parts = [];
    const releaseInfo = String(meta.releaseInfo || '').trim();
    if (releaseInfo) {
      parts.push(releaseInfo);
    } else if (meta.year) {
      parts.push(String(meta.year));
    }
    if (type === 'series' && Array.isArray(meta.videos) && meta.videos.length) {
      parts.push(`${meta.videos.length} Episodes`);
    }
    if (meta.runtime) parts.push(meta.runtime);
    return parts.filter(Boolean).join(' · ');
  }

  function createSection(label, contentEl) {
    const section = document.createElement('div');
    section.className = 'meta-hover-panel-section';
    const labelEl = document.createElement('div');
    labelEl.className = 'meta-hover-panel-label';
    labelEl.textContent = label;
    section.append(labelEl, contentEl);
    return section;
  }

  /**
   * IMDb tt… from resolved hover identity or meta fields — never tmdb:/kitsu: catalog ids.
   * @param {string|null|undefined} resolvedImdb
   * @param {object|null|undefined} meta
   * @returns {string|null}
   */
  function pickHoverImdbId(resolvedImdb, meta) {
    const candidates = [
      resolvedImdb,
      meta && meta.imdb_id,
      meta && meta.imdbId,
    ];
    if (meta && /^tt\d{7,}$/i.test(String(meta.id || ''))) {
      candidates.push(meta.id);
    }
    for (const value of candidates) {
      const match = String(value || '').match(/tt\d{7,}/i);
      if (match) return match[0].toLowerCase();
    }
    return null;
  }

  function hoverRatingsApi() {
    return window.StremioCustomAPI || window.StremioEnhancedAPI || null;
  }

  // Strict whitelist: a key missing here is silently dropped and never rendered.
  function orderHoverRatings(ratings) {
    const order = [
      'fsk',
      'imdb',
      'mal',
      'rt',
      'tmdb',
      'metacritic',
      'trakt',
      'mcusers',
      'tvmaze',
      'tvdb',
      'letterboxd',
    ];
    const by = Object.fromEntries(
      (ratings || []).filter((item) => item?.key).map((item) => [item.key, item])
    );
    return order.filter((key) => by[key]).map((key) => by[key]);
  }

  function hoverMediaType(typeHint) {
    const hint = String(typeHint || '').toLowerCase();
    if (
      hint === 'series' ||
      hint === 'tv' ||
      hint === 'show' ||
      hint === 'anime' ||
      hint === 'episode' ||
      hint === 'season'
    ) {
      return 'series';
    }
    if (hint === 'movie' || hint === 'film') return 'movie';
    return 'movie';
  }

  /**
   * A result whose sources all answered is worth the full TTL; one with an
   * unreachable source is only held long enough to dedupe a request burst.
   * @param {{ at: number, complete?: boolean }} entry
   */
  function hoverCacheFresh(entry) {
    if (!entry) return false;
    const ttl = entry.complete === false ? RATINGS_INCOMPLETE_TTL_MS : RATINGS_CACHE_TTL_MS;
    return Date.now() - entry.at < ttl;
  }

  /**
   * Cache slot for a title's ratings.
   *
   * Keyed by media type because the shell answers per type and a board poster only
   * yields a guess. A result fetched under a guessed 'movie' used to occupy the single
   * slot the resolved type read from, so a series showed IMDb plus a TMDb score taken
   * from an unrelated movie of the same numeric id.
   */
  function hoverRatingsKey(id, type) {
    return `${id}:${hoverMediaType(type)}`;
  }

  function rememberHoverRatings(imdbId, ratings, complete = true, type = 'series') {
    const ordered = orderHoverRatings(ratings);
    const id = pickHoverImdbId(imdbId, null);
    if (!id || !ordered.length) return ordered;
    const key = hoverRatingsKey(id, type);
    const existing = ratingsCache.get(key);
    if (existing && hoverCacheFresh(existing) && existing.complete && !complete) {
      return existing.ratings.slice();
    }
    ratingsCache.set(key, { at: Date.now(), ratings: ordered, complete });
    if (ratingsCache.size > 256) {
      for (const [cachedKey, entry] of ratingsCache) {
        if (!hoverCacheFresh(entry)) ratingsCache.delete(cachedKey);
      }
    }
    return ordered.slice();
  }

  /**
   * @param {string} imdbId
   * @param {string} [typeHint]
   * @param {'fast'|'full'} [mode]
   * @param {{ background?: boolean }} [options]
   * @returns {Promise<object[]>}
   */
  async function fetchHoverRatings(imdbId, typeHint, mode = 'full', options = null) {
    const id = pickHoverImdbId(imdbId, null);
    if (!id) return [];
    const background = options?.background === true;
    // Background and foreground stay separate jobs on purpose: a visible panel must
    // not end up waiting behind the low-priority queue. Whichever finishes first
    // fills ratingsCache, and the native cache absorbs the overlap.
    const requestedType = hoverMediaType(typeHint);
    const cacheKey = `${id}:${requestedType}:${mode}${background ? ':bg' : ''}`;
    if (mode === 'full') {
      const cached = ratingsCache.get(hoverRatingsKey(id, requestedType));
      if (cached && hoverCacheFresh(cached)) return cached.ratings.slice();
    }
    if (ratingsPending.has(cacheKey)) return ratingsPending.get(cacheKey);

    const job = (async () => {
      const client = hoverRatingsApi();
      if (!client?.invoke) return [];
      const types = [requestedType];
      if (types[0] === 'movie') types.push('series');
      else types.push('movie');
      let ratings = [];
      let complete = true;
      let resolvedType = requestedType;
      for (const type of types) {
        try {
          const payload = {
            imdbId: id,
            type,
            mode,
          };
          if (background) payload.background = true;
          const result = await client.invoke('get-title-ratings', payload);
          if (Array.isArray(result?.ratings) && result.ratings.length) {
            const answeredComplete = result.complete !== false;
            // Keep the richer answer.
            if (!ratings.length || result.ratings.length > ratings.length) {
              ratings = result.ratings;
              complete = answeredComplete;
              // The shell proves the type via TMDB and reports what it resolved.
              resolvedType = hoverMediaType(result.type || type);
            }
            // Only an unproven type justifies asking again. Retrying on an incomplete
            // answer instead meant a single slow source doubled every hover, because
            // the other type is a full second fan-out.
            if (result.typeVerified === true || answeredComplete) break;
          }
        } catch (_) {
          complete = false;
        }
      }
      const ordered = orderHoverRatings(ratings);
      if (mode === 'full' && ordered.length) {
        const stored = rememberHoverRatings(id, ordered, complete, resolvedType);
        // Also fill the slot the caller asked under, so a repeated wrong guess is a
        // cache hit instead of a refetch. Same answer, the shell already corrected it.
        if (resolvedType !== requestedType) {
          rememberHoverRatings(id, ordered, complete, requestedType);
        }
        return stored;
      }
      return ordered.slice();
    })().finally(() => ratingsPending.delete(cacheKey));

    ratingsPending.set(cacheKey, job);
    return job;
  }

  /**
   * Starts the full fan-out while meta/cast are still loading, so the panel can
   * paint the complete bar in one go instead of trickling chips in.
   */
  function prefetchHoverRatings(imdbId, typeHint) {
    const id = pickHoverImdbId(imdbId, null);
    if (!id) return;
    fetchHoverRatings(id, typeHint, 'full', { background: true }).catch(() => {});
  }

  function peekHoverRatings(imdbId, type) {
    const id = pickHoverImdbId(imdbId, null);
    if (!id) return null;
    const cached = ratingsCache.get(hoverRatingsKey(id, type));
    if (cached && hoverCacheFresh(cached)) return cached.ratings.slice();
    return null;
  }

  function chipLabel(rating) {
    const key = String(rating?.key || '').toLowerCase();
    if (key === 'imdb') return 'IMDb';
    if (key === 'tmdb') return 'TMDb';
    if (key === 'mal') return 'MAL';
    if (key === 'metacritic') return 'MC';
    if (key === 'mcusers') return 'MC U';
    if (key === 'trakt') return 'Trakt';
    if (key === 'letterboxd') return 'LB';
    if (key === 'rt') return 'RT';
    if (key === 'fsk') return 'FSK';
    if (key === 'tvmaze') return 'TVmaze';
    if (key === 'tvdb') return 'TVDB';
    return String(rating?.label || key || '?');
  }

  function openHoverRatingUrl(url) {
    if (!url) return;
    const client = hoverRatingsApi();
    if (client?.openExternalUrl) {
      Promise.resolve(client.openExternalUrl(url)).catch(() => {
        window.open(url, '_blank', 'noopener,noreferrer');
      });
      return;
    }
    if (client?.invoke) {
      Promise.resolve(client.invoke('open-external-url', { url })).catch(() => {
        window.open(url, '_blank', 'noopener,noreferrer');
      });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function paintHoverRatings(host, ratings) {
    if (!host || !ratings?.length) return;
    host.replaceChildren();
    for (const rating of ratings) {
      const key = String(rating.key || '').toLowerCase();
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'meta-hover-panel-chip';
      chip.dataset.key = key;
      chip.title = rating.label || chipLabel(rating);
      if (rating.url) {
        chip.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openHoverRatingUrl(rating.url);
        });
      }
      if (rating.kind === 'age' || key === 'fsk') {
        const age = document.createElement('span');
        age.className = 'meta-hover-panel-chip-age';
        age.textContent = rating.value;
        chip.appendChild(age);
      } else {
        const brand = document.createElement('span');
        brand.className = 'meta-hover-panel-chip-brand';
        brand.dataset.key = key;
        brand.textContent = chipLabel(rating);
        const value = document.createElement('span');
        value.className = 'meta-hover-panel-chip-value';
        value.dataset.key = key;
        value.textContent = rating.value;
        chip.append(brand, value);
      }
      host.appendChild(chip);
    }
  }

  /**
   * @param {Element} host
   * @param {object} meta
   */
  function renderImdbFallback(host, meta) {
    if (!host || !meta?.imdbRating) return;
    host.replaceChildren();
    const imdb = document.createElement('span');
    imdb.className = 'meta-hover-panel-imdb';
    imdb.textContent = 'IMDb';
    const rating = document.createElement('span');
    rating.className = 'meta-hover-panel-rating';
    rating.textContent = meta.imdbRating;
    host.append(imdb, rating);
  }

  /**
   * @param {Element} host
   */
  function showRatingsSkeleton(host) {
    if (!host) return;
    host.replaceChildren();
    const sk = document.createElement('span');
    sk.className = 'meta-hover-panel-ratings-skeleton';
    sk.setAttribute('aria-hidden', 'true');
    host.appendChild(sk);
  }

  /**
   * @param {Element} host
   * @param {object} meta
   * @param {string} type
   * @param {string|null} resolvedImdb
   * @returns {Promise<void>}
   */
  async function fillHoverRatings(host, meta, type, resolvedImdb) {
    if (!host) return;
    const imdbId = pickHoverImdbId(resolvedImdb, meta);
    if (!imdbId) {
      renderImdbFallback(host, meta);
      return;
    }

    const cached = peekHoverRatings(imdbId, type);
    if (cached?.length) {
      paintHoverRatings(host, cached);
      return;
    }

    if (!host.querySelector('.meta-hover-panel-ratings-skeleton')) {
      showRatingsSkeleton(host);
    }

    // Skeleton until the one native answer arrives, then paint everything at once.
    try {
      const ratings = await fetchHoverRatings(imdbId, type, 'full');
      if (!host.isConnected) return;
      if (ratings.length) paintHoverRatings(host, ratings);
      else renderImdbFallback(host, meta);
    } catch (_) {
      if (host.isConnected) renderImdbFallback(host, meta);
    }
  }

  function renderPanel(meta, type, resolvedImdb) {
    const panel = document.createElement('div');
    panel.className = 'meta-hover-panel';
    panel.id = 'meta-hover-panel-active';

    const header = document.createElement('div');
    header.className = 'meta-hover-panel-header';

    const title = document.createElement('div');
    title.className = 'meta-hover-panel-title';
    title.textContent = meta.name || 'Unbekannt';

    const metaLine = document.createElement('div');
    metaLine.className = 'meta-hover-panel-meta';
    const info = buildMetaLine(meta, type);
    if (info) {
      const span = document.createElement('span');
      span.textContent = info;
      metaLine.appendChild(span);
    }
    const ratingsHost = document.createElement('span');
    ratingsHost.className = 'meta-hover-panel-ratings-host';
    const imdbId = pickHoverImdbId(resolvedImdb, meta);
    const cached = imdbId ? peekHoverRatings(imdbId, type) : null;
    if (cached?.length) {
      paintHoverRatings(ratingsHost, cached);
    } else if (imdbId) {
      showRatingsSkeleton(ratingsHost);
    } else if (meta.imdbRating) {
      renderImdbFallback(ratingsHost, meta);
    }
    metaLine.appendChild(ratingsHost);
    fillHoverRatings(ratingsHost, meta, type, imdbId);

    header.append(title, metaLine);
    panel.appendChild(header);

    const genres = getGenres(meta).slice(0, CONFIG.MAX_GENRES);
    if (genres.length) {
      const tags = document.createElement('div');
      tags.className = 'meta-hover-panel-tags';
      genres.forEach((genre) => {
        const tag = document.createElement('span');
        tag.className = 'meta-hover-panel-tag';
        tag.textContent = genre;
        tags.appendChild(tag);
      });
      panel.appendChild(createSection('Tags', tags));
    }

    if (meta.description) {
      const plot = document.createElement('div');
      plot.className = 'meta-hover-panel-plot';
      plot.textContent = meta.description;
      panel.appendChild(createSection('Plot', plot));
    }

    const director = getDirector(meta);
    if (director) {
      const person = document.createElement('div');
      person.className = 'meta-hover-panel-person';
      appendPersonPhoto(person, meta.directorPhoto || null, director);
      const text = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'meta-hover-panel-person-name';
      name.textContent = director;
      text.appendChild(name);
      person.appendChild(text);
      panel.appendChild(createSection('Director', person));
    }

    const cast = getCast(meta);
    if (cast.length) {
      const grid = document.createElement('div');
      grid.className = 'meta-hover-panel-cast-grid';
      cast.forEach((actor) => {
        const item = document.createElement('div');
        item.className = 'meta-hover-panel-person';
        appendPersonPhoto(item, actor.photo, actor.name);
        const text = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'meta-hover-panel-person-name';
        name.textContent = actor.name;
        text.appendChild(name);
        if (actor.character) {
          const role = document.createElement('div');
          role.className = 'meta-hover-panel-person-role';
          role.textContent = actor.character;
          text.appendChild(role);
        }
        item.appendChild(text);
        grid.appendChild(item);
      });
      panel.appendChild(createSection('Cast', grid));
    }

    return panel;
  }

  function positionPanel(panel, anchorRect) {
    const padding = 12;
    let left = anchorRect.right + padding;
    let top = anchorRect.top;

    if (left + CONFIG.PANEL_WIDTH > window.innerWidth - padding) {
      left = anchorRect.left - CONFIG.PANEL_WIDTH - padding;
    }
    if (left < padding) {
      left = Math.max(padding, anchorRect.left + anchorRect.width / 2 - CONFIG.PANEL_WIDTH / 2);
    }

    top = Math.max(padding, Math.min(top, window.innerHeight - panel.offsetHeight - padding));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function removePanel() {
    if (activePanel) {
      activePanel.remove();
      activePanel = null;
    }
    activeAnchor = null;
    document.querySelectorAll('#meta-hover-panel-active').forEach((node) => node.remove());
  }

  function isAnchorVisible(anchor) {
    if (!anchor?.isConnected) return false;
    const rect = anchor.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    );
  }

  function isHoverIntentActive(anchor) {
    return Boolean(anchor?.isConnected && trackedAnchor === anchor);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {DOMRect} rect
   * @param {number} [pad]
   * @returns {boolean}
   */
  function pointInRect(x, y, rect, pad = 0) {
    return (
      x >= rect.left - pad &&
      x <= rect.right + pad &&
      y >= rect.top - pad &&
      y <= rect.bottom + pad
    );
  }

  /**
   * True while pointer remains over the poster or the open panel footprint.
   * Panel uses pointer-events:none, so elementFromPoint alone is not enough.
   * @param {number} x
   * @param {number} y
   * @returns {boolean}
   */
  function isPointerOverHoverTarget(x, y) {
    const pad = 48;
    if (activeAnchor?.isConnected && pointInRect(x, y, activeAnchor.getBoundingClientRect(), pad)) {
      return true;
    }
    if (trackedAnchor?.isConnected && pointInRect(x, y, trackedAnchor.getBoundingClientRect(), pad)) {
      return true;
    }
    if (activePanel?.isConnected && pointInRect(x, y, activePanel.getBoundingClientRect(), pad)) {
      return true;
    }
    return false;
  }

  /**
   * Hover panels are only for browse surfaces — never on detail/player routes.
   * @returns {boolean}
   */
  function isHoverRouteAllowed() {
    const hash = String(location.hash || '');
    if (/#\/(?:detail|metadetails)\b/i.test(hash)) return false;
    if (/#\/player\b/i.test(hash)) return false;
    return true;
  }

  function isPointerOverAnchor(anchor, x, y) {
    if (!anchor?.isConnected) return false;
    return pointInRect(x, y, anchor.getBoundingClientRect(), 0);
  }

  function validateActivePanel(pointer) {
    if (!activePanel) return;

    if (!activeAnchor?.isConnected || !isAnchorVisible(activeAnchor)) {
      clearHoverState();
      return;
    }

    if (!isHoverIntentActive(activeAnchor)) {
      clearHoverState();
      return;
    }

    if (pointer && !isPointerOverHoverTarget(pointer.x, pointer.y)) {
      clearHoverState();
    }
  }

  async function showPanel(anchor, media) {
    if (!isHoverRouteAllowed()) {
      clearHoverState();
      return;
    }
    const generation = ++showGeneration;
    const stillValid = () =>
      generation === showGeneration && isHoverIntentActive(anchor) && isHoverRouteAllowed();

    removePanel();
    if (!stillValid()) return;

    activeAnchor = anchor;

    const loading = document.createElement('div');
    loading.className = 'meta-hover-panel visible';
    loading.id = 'meta-hover-panel-active';
    loading.innerHTML = '<div class="meta-hover-panel-loading">Lade Infos…</div>';
    document.body.appendChild(loading);
    positionPanel(loading, anchor.getBoundingClientRect());
    activePanel = loading;

    const imdbId = await resolveImdbId(media);
    const tmdbId =
      media.tmdbId || String(media.id || '').match(/^tmdb:(\d+)$/i)?.[1] || null;
    const candidateIds = [];
    if (imdbId) candidateIds.push(imdbId);
    if (tmdbId) candidateIds.push(`tmdb:${tmdbId}`);
    if (!candidateIds.length || !stillValid()) {
      removePanel();
      return;
    }

    // Overlap network with meta/cast so the bar is warm when the panel paints.
    if (imdbId) prefetchHoverRatings(imdbId, media.type);

    const result = await fetchMetaCandidates(media.type, candidateIds);
    if (!stillValid()) {
      removePanel();
      return;
    }
    if (!result) {
      if (activePanel) {
        activePanel.innerHTML = '<div class="meta-hover-panel-loading">Keine Metadaten</div>';
        setTimeout(() => {
          if (generation === showGeneration) removePanel();
        }, 1200);
      }
      return;
    }

    const { meta, type: resolvedType } = result;
    await enrichCast(meta, resolvedType);
    if (!stillValid()) {
      removePanel();
      return;
    }

    const director = getDirector(meta);
    if (director && !meta.directorPhoto) {
      meta.directorPhoto = await fetchWikipediaPhoto(director);
    }
    if (!stillValid()) {
      removePanel();
      return;
    }

    const panel = renderPanel(meta, resolvedType, imdbId);
    panel.classList.add('visible');
    document.body.appendChild(panel);
    loading.remove();
    activePanel = panel;
    positionPanel(panel, anchor.getBoundingClientRect());
  }

  function getMetaItemAnchor(target) {
    if (!(target instanceof Element)) return null;

    const direct = target.closest('[class*="meta-item-container"]');
    if (direct) return direct;

    const card = target.closest('[class*="meta-items-container"] > [class*="meta-item"]');
    if (card) {
      return card.querySelector('[class*="meta-item-container"]');
    }

    return null;
  }

  function clearHoverState() {
    showGeneration += 1;
    clearTimeout(hoverTimer);
    hoverTimer = null;
    trackedAnchor = null;
    removePanel();
  }

  function scheduleHover(anchor) {
    if (!anchor || !isHoverRouteAllowed()) return;
    trackedAnchor = anchor;
    clearTimeout(hoverTimer);

    hoverTimer = setTimeout(async () => {
      if (!isHoverRouteAllowed() || !isHoverIntentActive(anchor)) return;
      const media = await extractMediaInfo(anchor);
      if (!isHoverRouteAllowed() || !media || !isHoverIntentActive(anchor)) return;
      if (media.id && /^tt\d{7,}/i.test(String(media.id))) {
        prefetchHoverRatings(media.id, media.type);
      }
      showPanel(anchor, media);
    }, CONFIG.HOVER_DELAY);
  }

  function handlePointerMove(event) {
    if (!isHoverRouteAllowed()) {
      if (activePanel || trackedAnchor || hoverTimer) clearHoverState();
      return;
    }
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = null;
      if (!isHoverRouteAllowed()) {
        clearHoverState();
        return;
      }

      const x = event.clientX;
      const y = event.clientY;

      // Keep an open panel while the pointer stays over poster or panel area.
      if (activePanel && isPointerOverHoverTarget(x, y)) {
        validateActivePanel({ x, y });
        repositionActivePanel();
        return;
      }

      const anchor = getMetaItemAnchor(document.elementFromPoint(x, y));
      if (!anchor) {
        if (isPointerOverHoverTarget(x, y)) {
          return;
        }
        clearHoverState();
        return;
      }

      validateActivePanel({ x, y });

      if (activePanel && activeAnchor === anchor) {
        repositionActivePanel();
        return;
      }

      scheduleHover(anchor);
    });
  }

  /**
   * Dismiss immediately on click/press so navigation to detail never flashes the panel.
   * @param {Event} event
   * @returns {void}
   */
  function handlePointerDown(event) {
    if (!(event instanceof PointerEvent) || event.button !== 0) return;
    const anchor = getMetaItemAnchor(event.target);
    if (anchor || activePanel || trackedAnchor) {
      clearHoverState();
    }
  }

  /**
   * Dismiss hover on vertical board/window scroll only — ignore horizontal catalog row pans.
   * @param {Event} event
   */
  function handleScroll(event) {
    if (!activePanel) return;
    const target = event?.target;
    if (target instanceof Element) {
      if (
        target.closest('[class*="meta-items-container"]') ||
        target.closest('.meta-hover-panel')
      ) {
        return;
      }
    }
    clearHoverState();
  }

  function repositionActivePanel() {
    if (!activePanel || !activeAnchor) return;
    positionPanel(activePanel, activeAnchor.getBoundingClientRect());
  }

  let catalogObserver = null;
  let runtimeBound = false;
  let resizeHandler = null;

  /**
   * @returns {boolean}
   */
  function isMetaHoverRoute() {
    const hash = location.hash || '';
    if (/#\/player/.test(hash)) return false;
    if (/#\/settings/.test(hash)) return false;
    return true;
  }

  /**
   * Soft leave: clear hover UI / catalog observer (keeps Loaded gate).
   */
  function suspendRuntime() {
    clearHoverState();
    if (catalogObserver) {
      catalogObserver.disconnect();
      catalogObserver = null;
    }
  }

  /**
   * Hard unload for live disable — unbinds listeners and clears Loaded gate.
   */
  function hardUnload() {
    suspendRuntime();
    if (runtimeBound) {
      document.removeEventListener('mousemove', handlePointerMove);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('mouseleave', clearHoverState);
      window.removeEventListener('scroll', handleScroll, true);
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      window.removeEventListener('blur', clearHoverState);
      document.removeEventListener('stremio-custom-route-change', onMetaHoverRouteChange);
      document.removeEventListener('visibilitychange', onMetaHoverVisibility);
      document.removeEventListener('stremio-custom-playback-route', ensureRuntime);
      document.removeEventListener('stremio-custom-playback-stopped', ensureRuntime);
      runtimeBound = false;
      resizeHandler = null;
    }
    document.getElementById('meta-hover-panel-css')?.remove();
    document.querySelectorAll('#meta-hover-panel-active, .meta-hover-panel').forEach((node) => node.remove());
    try {
      delete window.__MetaHoverPanelLoaded;
    } catch (_) {
      window.__MetaHoverPanelLoaded = false;
    }
  }

  /**
   * Re-attaches catalog observer when back on board/library routes.
   */
  function ensureRuntime() {
    if (!isMetaHoverRoute()) {
      suspendRuntime();
      return;
    }
    annotateMetaItems();
    if (catalogObserver) return;
    catalogObserver = new MutationObserver((mutations) => {
      if (!isMetaHoverRoute()) {
        suspendRuntime();
        return;
      }
      if (isCatalogMutation(mutations)) {
        invalidateCatalogCache();
        // Row-nav chevrons / width freezes mutate the catalog constantly — only tear down
        // when the hovered poster itself was removed from the DOM.
        if (activeAnchor && !activeAnchor.isConnected) {
          clearHoverState();
        }
        mutations.forEach((mutation) => {
          if (mutation.target instanceof Element) {
            const container = mutation.target.closest('[class*="meta-items-container"], [class*="meta-row-container"]');
            if (container) clearHoverBindingsIn(container);
          }
          mutation.addedNodes.forEach((node) => {
            if (node instanceof Element) {
              const container = node.closest?.('[class*="meta-items-container"], [class*="meta-row-container"]')
                || (node.matches?.('[class*="meta-items-container"], [class*="meta-row-container"]') ? node : null);
              if (container) clearHoverBindingsIn(container);
            }
          });
        });
      }
      annotateMetaItems();
    });
    catalogObserver.observe(document.body, { childList: true, subtree: true });
  }

  window.__stremioMetaHoverUnload = hardUnload;

  function onMetaHoverRouteChange() {
    invalidateCatalogCache();
    clearHoverState();
    ensureRuntime();
  }

  function onMetaHoverVisibility() {
    if (document.hidden) clearHoverState();
  }

  function init() {
    if (window.__MetaHoverPanelLoaded) return;
    window.__MetaHoverPanelLoaded = true;

    injectStyles();

    if (!runtimeBound) {
      runtimeBound = true;
      document.addEventListener('mousemove', handlePointerMove, { passive: true });
      document.addEventListener('pointerdown', handlePointerDown, true);
      document.addEventListener('mouseleave', clearHoverState);
      window.addEventListener('scroll', handleScroll, true);
      resizeHandler = () => {
        if (!activePanel) return;
        if (!activeAnchor?.isConnected || !isAnchorVisible(activeAnchor)) {
          clearHoverState();
          return;
        }
        repositionActivePanel();
      };
      window.addEventListener('resize', resizeHandler);
      document.addEventListener('stremio-custom-route-change', onMetaHoverRouteChange);
      window.addEventListener('blur', clearHoverState);
      document.addEventListener('visibilitychange', onMetaHoverVisibility);
      document.addEventListener('stremio-custom-playback-route', ensureRuntime);
      document.addEventListener('stremio-custom-playback-stopped', ensureRuntime);
    }

    ensureRuntime();
    console.info('[MetaHoverPanel] Ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 400);
  }
})();
