/**
 * @name Enhanced Title Bar
 * @description Enhances the title bar with additional information.
 * @version 26.0.12
 * @author Fxy · adapted for MyStremio
 */

(function () {
  'use strict';

  if (window.__EnhancedTitlebarLoaded) return;
  window.__EnhancedTitlebarLoaded = true;

const CONFIG = {
  apiBase: "https://v3-cinemeta.strem.io/meta",
  timeout: 5000,
};

const metadataCache = new Map();
const RETRY_CONFIG = {
  delay: 1200,
  maxAttempts: 3,
};
let enhanceTimeout = null;
let mutationObserver = null;
let intersectionObserver = null;
/** @type {Set<Element>} */
let pendingVisibleItems = new Set();
let isEnhancing = false;
let enhanceQueued = false;
let applyingEnhancement = false;
let lastEnhanceRun = 0;
const MIN_RUN_INTERVAL = 800;
const ENHANCE_CONCURRENCY = 4;
/** Pause DOM enhance while the board is vertically scrolling. */
let boardScrollBusy = false;
let boardScrollIdleTimer = null;
let boardScrollBound = false;
/** Pause while board row reveal / LoadNextPage is busy. */
let boardRowBusy = false;
let boardRowBusyBound = false;

function onTitlebarLibraryClick(event) {
  const chip = event.target?.closest?.(
    '[class*="library-container"] [class*="chip-"]:not([data-sc-custom-folder-tab])',
  );
  if (!chip) return;
  setTimeout(scheduleLibraryEnhancementRefresh, 120);
}

function onTitlebarRouteChange() {
  if (isLibraryPage()) {
    restoreLibraryNativeTitlebars();
    return;
  }
  observeTitlebarTargets();
  scheduleEnhancement();
}

function injectStyles() {
  if (document.getElementById("enhanced-title-bar-styles")) return;

  const style = document.createElement("style");
  style.id = "enhanced-title-bar-styles";
  style.textContent = `
        .enhanced-title-bar {
            position: relative !important;
            padding: 5px 4px !important;
            padding-right: 10px !important;
            overflow: hidden !important;
            max-width: 400px !important;
        }

        .enhanced-title {
            font-size: 16px !important;
            font-weight: 600 !important;
            color: #ffffff !important;
            margin-bottom: 8px !important;
            line-height: 1.3 !important;
        }

        .enhanced-metadata {
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
            flex-wrap: wrap !important;
            font-size: 12px !important;
            color: #999 !important;
        }

        .enhanced-metadata-item {
            display: inline-flex !important;
            align-items: center !important;
            gap: 4px !important;
        }

        .enhanced-separator {
            color: #666 !important;
            margin: 0 4px !important;
        }

        .enhanced-loading {
            background: linear-gradient(90deg, #333 25%, #444 50%, #333 75%) !important;
            background-size: 200% 100% !important;
            animation: enhanced-loading 1.5s infinite !important;
            border-radius: 3px !important;
            height: 12px !important;
            width: 60px !important;
            display: inline-block !important;
        }

        @keyframes enhanced-loading {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }
    `;
  document.head.appendChild(style);
}

function metaRequestUrls(type, id) {
  const fromGate = window.StremioCustomMetadataMetaGate?.metaRequestUrls;
  if (typeof fromGate === "function") {
    const urls = fromGate(type, id);
    if (Array.isArray(urls) && urls.length) return urls;
  }
  const kind = String(type || "movie").trim() || "movie";
  const rawId = String(id || "").trim();
  if (!rawId) return [];
  return [`${CONFIG.apiBase}/${kind}/${encodeURIComponent(rawId)}.json`];
}

async function getMetadata(id, type) {
  const cacheKey = `${type}-${id}`;

  if (metadataCache.has(cacheKey)) {
    return metadataCache.get(cacheKey);
  }

  const urls = metaRequestUrls(type, id);
  if (!urls.length) return null;

  try {
    for (const url of urls) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);
      let response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } catch (error) {
        clearTimeout(timeoutId);
        console.log(`Failed to fetch ${id}:`, error);
        continue;
      }
      clearTimeout(timeoutId);

      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }
      if (!response.ok || data?.error === "mystremio-meta-gated" || !data?.meta) {
        continue;
      }

      const meta = data.meta;
      const metadata = {
        title: meta.name || meta.title,
        year: meta.year ? meta.year.toString() : null,
        rating: meta.imdbRating ? meta.imdbRating.toString() : null,
        genres: Array.isArray(meta.genre)
          ? meta.genre
          : Array.isArray(meta.genres)
            ? meta.genres
            : [],
        runtime: meta.runtime || null,
        type: meta.type || type,
      };

      metadataCache.set(cacheKey, metadata);
      return metadata;
    }
    return null;
  } catch (error) {
    console.log(`Failed to fetch ${id}:`, error);
    return null;
  }
}

async function resolveMetadata(imdbId, typeHints) {
  for (let i = 0; i < typeHints.length; i++) {
    const type = typeHints[i];
    const metadata = await getMetadata(imdbId, type);
    if (metadata) return metadata;
  }
  return null;
}

function computeTitlebarSlotKey(posterImg, detailLink, itemRoot) {
  return extractImdbId(posterImg, detailLink, itemRoot) || "";
}

/**
 * Restore a title-bar container to stock markup (or a minimal title-label).
 * @param {Element} titlebar
 */
function clearEnhancedState(titlebar) {
  if (!(titlebar instanceof Element)) return;

  const savedTitle =
    titlebar.querySelector?.(".enhanced-title")?.textContent?.trim() ||
    titlebar.querySelector?.('[class*="title-label"]')?.textContent?.trim() ||
    "";

  if (titlebar.dataset.originalContent) {
    titlebar.innerHTML = titlebar.dataset.originalContent;
  } else if (
    titlebar.classList.contains("enhanced-title-bar") ||
    titlebar.querySelector?.(".enhanced-title, .enhanced-metadata, .enhanced-loading")
  ) {
    titlebar
      .querySelectorAll(".enhanced-title, .enhanced-metadata, .enhanced-loading")
      .forEach((node) => node.remove());
    // Ensure a native-looking title label remains for Liquid Glass / stock CSS.
    if (!titlebar.querySelector?.('[class*="title-label"]') && savedTitle) {
      const label = document.createElement("div");
      label.className = "title-label";
      label.textContent = savedTitle;
      titlebar.appendChild(label);
    }
  }

  titlebar.classList.remove("enhanced-title-bar");
  delete titlebar.dataset.enhancedId;
  delete titlebar.dataset.enhancedSlotKey;
  delete titlebar.dataset.enhancedComplete;
  delete titlebar.dataset.enhancedPending;
  delete titlebar.dataset.enhancedAttempts;
  delete titlebar.dataset.enhancedRetryAt;
  delete titlebar.dataset.enhancedUpdatedAt;
  delete titlebar.dataset.enhancedFetchToken;
  delete titlebar.dataset.originalContent;
}

/**
 * Find title-bar hosts that still contain enhanced markup (including orphans).
 * @returns {Set<Element>}
 */
function collectEnhancedTitlebarHosts() {
  /** @type {Set<Element>} */
  const hosts = new Set();
  document.querySelectorAll(".enhanced-title-bar").forEach((el) => hosts.add(el));
  document
    .querySelectorAll(".enhanced-title, .enhanced-metadata, .enhanced-loading")
    .forEach((node) => {
      const host =
        node.closest?.('[class*="title-bar-container"]') ||
        node.closest?.('[class*="title-bar"]') ||
        node.parentElement;
      if (host) hosts.add(host);
    });
  return hosts;
}

function readNativeTitle(card, posterImg, detailLink, titlebar) {
  if (titlebar) {
    const titleLabel = titlebar.querySelector('[class*="title-label"]');
    const nativeLabel = titleLabel?.textContent?.trim();
    if (nativeLabel) {
      return nativeLabel;
    }
  }

  if (detailLink) {
    const ariaLabel = detailLink.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) {
      return ariaLabel.trim();
    }
    const labelled = detailLink.querySelector('[class*="title"]');
    if (labelled?.textContent?.trim()) {
      return labelled.textContent.trim();
    }
  }

  if (posterImg) {
    const altTitle = posterImg.getAttribute("alt");
    if (altTitle && altTitle.trim()) {
      return altTitle.trim();
    }
    const posterTitle = posterImg.getAttribute("title");
    if (posterTitle && posterTitle.trim()) {
      return posterTitle.trim();
    }
  }

  if (titlebar && !titlebar.querySelector(".enhanced-title")) {
    const titleElement =
      titlebar.querySelector('[class*="menu-label"]') ||
      titlebar.querySelector('[class*="title"]:not(.enhanced-title)');
    const nativeTitle = titleElement?.textContent?.trim();
    if (nativeTitle) {
      return nativeTitle;
    }
  }

  return "";
}

function matchImdbId(value) {
  if (!value || typeof value !== "string") return null;
  const match = value.match(/tt\d{7,}/);
  return match ? match[0] : null;
}

function extractImdbIdFromPoster(posterImg) {
  if (!posterImg) return null;
  const sources = [
    posterImg.currentSrc,
    posterImg.getAttribute("src"),
    posterImg.getAttribute("data-src"),
    posterImg.getAttribute("data-original"),
    posterImg.getAttribute("data-imdb-id"),
  ];
  for (let i = 0; i < sources.length; i++) {
    const id = matchImdbId(sources[i]);
    if (id) return id;
  }
  return null;
}

function matchTmdbCatalogId(value) {
  if (!value || typeof value !== "string") return null;
  const match = value.match(/tmdb:(\d+)/i);
  return match ? `tmdb:${match[1]}` : null;
}

function extractImdbIdFromDetailLink(detailLink) {
  if (!detailLink) return null;
  const sources = [
    detailLink.getAttribute("href"),
    detailLink.getAttribute("data-id"),
    /^tt\d{7,}$/.test(detailLink.id || "") ? detailLink.id : null,
  ];
  for (let i = 0; i < sources.length; i++) {
    const id = matchImdbId(sources[i]);
    if (id) return id;
  }
  for (let i = 0; i < sources.length; i++) {
    const id = matchTmdbCatalogId(sources[i]);
    if (id) return id;
  }
  return null;
}

function isContinueWatchingItem(el) {
  return Boolean(el?.closest?.('[class*="continue-watching-row"]'));
}

function extractImdbId(posterImg, detailLink, cardOrContainer) {
  // Prefer detail href — Enhanced Covers owns CW poster URLs/data-imdb-id.
  const linkId = extractImdbIdFromDetailLink(detailLink);
  if (linkId) {
    return linkId;
  }

  // Never key CW identity from poster/cover URLs (covers owns those).
  if (isContinueWatchingItem(posterImg) || isContinueWatchingItem(cardOrContainer)) {
    return null;
  }

  const posterId = extractImdbIdFromPoster(posterImg);
  if (posterId) {
    return posterId;
  }

  if (cardOrContainer?.dataset) {
    const containerId =
      matchImdbId(cardOrContainer.dataset.imdb) ||
      matchImdbId(cardOrContainer.dataset.id);
    if (containerId) {
      return containerId;
    }
  }

  return null;
}

function resolveTileLinks(posterImg, detailLink, itemRoot) {
  let link = detailLink;
  if (link && itemRoot && !itemRoot.contains(link)) {
    link = null;
  }
  // Keep href even when poster Metahub/data-imdb-id disagrees (CW remount reuse).
  return link;
}

function createMetadataElements(metadata) {
  const elements = [];

  if (metadata.rating) {
    const rating = document.createElement("span");
    rating.className = "enhanced-metadata-item enhanced-rating";
    rating.textContent = `★ ${metadata.rating}`;
    elements.push(rating);
  }

  if (metadata.year) {
    const year = document.createElement("span");
    year.className = "enhanced-metadata-item";
    year.textContent = metadata.year;
    elements.push(year);
  }

  if (metadata.genres && metadata.genres.length > 0) {
    const genres = document.createElement("span");
    genres.className = "enhanced-metadata-item enhanced-genres";
    genres.textContent = metadata.genres.slice(0, 3).join(", ");
    elements.push(genres);
  }

  return elements;
}

function isLibraryPage() {
  return /#\/library(?:[/?#]|$)/.test(location.hash || "");
}

function shouldEnhancePage() {
  if (/#\/player/.test(location.hash)) return false;
  if (isLibraryPage()) return false;
  return true;
}

function restoreLibraryNativeTitlebars() {
  const libraryRoot = document.querySelector('[class*="library-container"]');
  if (!libraryRoot) return;
  libraryRoot
    .querySelectorAll('[class*="title-bar-container"], [class*="title-bar"]')
    .forEach((titlebar) => clearEnhancedState(titlebar));
}

async function enhanceMediaContainers() {
  if (!shouldEnhancePage()) return;
  if (isBoardEnhancePaused()) {
    enhanceQueued = true;
    return;
  }
  if (isEnhancing) {
    enhanceQueued = true;
    return;
  }
  isEnhancing = true;
  lastEnhanceRun = Date.now();

  try {
    await enhanceMediaContainersImpl();
  } finally {
    isEnhancing = false;
    if (enhanceQueued) {
      enhanceQueued = false;
      scheduleEnhancement();
    }
  }
}

/**
 * @returns {Element[]}
 */
function getEnhanceRoots() {
  const roots = [];
  document
    .querySelectorAll(
      '[class*="board-container"], [class*="discover-container"], [class*="meta-row-container"]',
    )
    .forEach((el) => roots.push(el));
  return roots;
}

/**
 * Observe catalog tiles; enhance when they enter the viewport.
 */
function observeTitlebarTargets() {
  if (!intersectionObserver || !shouldEnhancePage()) return;
  const roots = getEnhanceRoots();
  const scope =
    roots.length > 0
      ? roots
      : document.querySelector("#app")
        ? [document.querySelector("#app")]
        : [document.body].filter(Boolean);
  scope.forEach((root) => {
    root
      .querySelectorAll('[class*="meta-item-container"]')
      .forEach((item) => {
        try {
          intersectionObserver.observe(item);
        } catch (_) {
          /* ignore */
        }
      });
  });
}

/**
 * Enhance only tiles queued by IntersectionObserver (or a one-shot scan).
 * @param {Element[]} [forceItems]
 */
async function enhanceMediaContainersImpl(forceItems) {
  let items;
  if (Array.isArray(forceItems) && forceItems.length) {
    items = forceItems;
  } else if (pendingVisibleItems.size > 0) {
    items = [...pendingVisibleItems];
    pendingVisibleItems.clear();
  } else {
    // Fallback: visible-ish items in board/discover (first paint before IO fires).
    items = [];
    getEnhanceRoots().forEach((root) => {
      root.querySelectorAll('[class*="meta-item-container"]').forEach((el) => {
        items.push(el);
      });
    });
    // Cap first-pass work; IO will pick up the rest as user scrolls.
    items = items.slice(0, 24);
  }

  for (let i = 0; i < items.length; i += ENHANCE_CONCURRENCY) {
    const batch = items.slice(i, i + ENHANCE_CONCURRENCY);
    await Promise.all(
      batch.map(async (item) => {
        try {
          await enhanceMetaItemContainer(item);
        } catch (error) {
          console.log("Meta item enhancement failed:", error);
        }
      }),
    );
  }

  observeTitlebarTargets();
}

/**
 * Enhance the title bar inside a single catalog/library tile.
 *
 * @param {Element} itemRoot One `meta-item-container` tile.
 */
async function enhanceMetaItemContainer(itemRoot) {
  if (!itemRoot || !itemRoot.matches?.('[class*="meta-item-container"]')) {
    return;
  }

  const titlebar = itemRoot.querySelector(
    '[class*="title-bar-container"], [class*="title-bar"]',
  );

  const posterImg =
    itemRoot.querySelector('img[src*="tt"]') || itemRoot.querySelector("img");
  if (!posterImg) {
    return;
  }

  if (!titlebar) {
    return;
  }

  let detailLink =
    posterImg.closest('a[href^="stremio:///detail/"], a[href*="#/detail/"]') ||
    itemRoot.querySelector('a[href^="stremio:///detail/"], a[href*="#/detail/"]');

  detailLink = resolveTileLinks(posterImg, detailLink, itemRoot);

  const hrefId = extractImdbIdFromDetailLink(detailLink);
  // Force rebind when React reused the CW card (href drifted) even if enhancedComplete.
  if (
    hrefId &&
    (titlebar.dataset.enhancedId || titlebar.dataset.enhancedSlotKey) &&
    (titlebar.dataset.enhancedId !== hrefId ||
      titlebar.dataset.enhancedSlotKey !== hrefId)
  ) {
    clearEnhancedState(titlebar);
  }

  const slotKey = computeTitlebarSlotKey(posterImg, detailLink, itemRoot);
  if (!slotKey) {
    return;
  }

  if (titlebar.dataset.enhancedSlotKey !== slotKey) {
    clearEnhancedState(titlebar);
    titlebar.dataset.enhancedSlotKey = slotKey;
  }

  let originalTitle = readNativeTitle(itemRoot, posterImg, detailLink, titlebar);
  if (!originalTitle && detailLink) {
    const linkTitle =
      detailLink.getAttribute("title") || detailLink.textContent;
    if (linkTitle && linkTitle.trim()) {
      originalTitle = linkTitle.trim();
    }
  }

  const imdbId = slotKey;
  await applyTitlebarEnhancement(
    titlebar,
    originalTitle,
    imdbId,
    detailLink,
    slotKey,
  );
}

async function applyTitlebarEnhancement(
  titlebar,
  originalTitle,
  imdbId,
  detailLink,
  slotKey,
) {
  const now = Date.now();
  const retryAt = parseInt(titlebar.dataset.enhancedRetryAt || "0", 10);
  if (retryAt && now < retryAt) {
    return;
  }

  let attempts = parseInt(titlebar.dataset.enhancedAttempts || "0", 10);
  const currentId = titlebar.dataset.enhancedId || "";
  const pending = titlebar.dataset.enhancedPending === "true";
  const complete = titlebar.dataset.enhancedComplete === "true";

  if (currentId !== imdbId || titlebar.dataset.enhancedSlotKey !== slotKey) {
    attempts = 0;
  } else {
    if (complete) {
      return;
    }
    if (pending) {
      const updatedAt = parseInt(titlebar.dataset.enhancedUpdatedAt || "0", 10);
      if (!updatedAt || now - updatedAt < CONFIG.timeout) {
        return; // Still waiting on previous fetch
      }
    }
  }

  attempts += 1;
  titlebar.dataset.enhancedAttempts = attempts.toString();
  titlebar.dataset.enhancedUpdatedAt = now.toString();
  titlebar.dataset.enhancedPending = "true";
  titlebar.dataset.enhancedComplete = "false";
  titlebar.dataset.enhancedId = imdbId;
  titlebar.dataset.enhancedFetchToken = `${slotKey}|${now}`;
  delete titlebar.dataset.enhancedRetryAt;

  applyingEnhancement = true;
  try {
    // Store original content before we rewrite the titlebar.
    if (!titlebar.dataset.originalContent) {
      titlebar.dataset.originalContent = titlebar.innerHTML;
    }

    // Mark as enhanced and store ID
    titlebar.classList.add("enhanced-title-bar");

    // Create enhanced structure
    titlebar.innerHTML = "";

    const title = document.createElement("div");
    title.className = "enhanced-title";
    title.textContent = originalTitle || "…";
    titlebar.appendChild(title);

    const metadataContainer = document.createElement("div");
    metadataContainer.className = "enhanced-metadata";

    const loading = document.createElement("div");
    loading.className = "enhanced-loading";
    metadataContainer.appendChild(loading);

    titlebar.appendChild(metadataContainer);
  } finally {
    applyingEnhancement = false;
  }

  const title = titlebar.querySelector(".enhanced-title");
  const metadataContainer = titlebar.querySelector(".enhanced-metadata");
  if (!title || !metadataContainer) return;

  // Determine type hints for metadata fetching
  const typeHints = [];
  if (detailLink && detailLink.href) {
    const match = detailLink.href.match(/detail\/([^/]+)\//);
    if (match && match[1] && typeHints.indexOf(match[1]) === -1) {
      typeHints.push(match[1]);
    }
  }

  if (typeHints.indexOf("series") === -1) typeHints.push("series");
  if (typeHints.indexOf("movie") === -1) typeHints.push("movie");

  // Fetch and display metadata
  try {
    const fetchToken = titlebar.dataset.enhancedFetchToken || "";
    const metadata = await resolveMetadata(imdbId, typeHints);

    if (
      titlebar.dataset.enhancedFetchToken !== fetchToken ||
      titlebar.dataset.enhancedSlotKey !== slotKey ||
      titlebar.dataset.enhancedId !== imdbId
    ) {
      return;
    }

    applyingEnhancement = true;
    try {
    if (metadata) {
      if (metadata.title) {
        title.textContent = metadata.title;
      }

      metadataContainer.innerHTML = "";

      const elements = createMetadataElements(metadata);
      elements.forEach((element, index) => {
        metadataContainer.appendChild(element);
        if (index < elements.length - 1) {
          const separator = document.createElement("span");
          separator.className = "enhanced-separator";
          separator.textContent = "•";
          metadataContainer.appendChild(separator);
        }
      });
      titlebar.dataset.enhancedPending = "false";
      titlebar.dataset.enhancedComplete = "true";
      titlebar.dataset.enhancedAttempts = "0";
      delete titlebar.dataset.enhancedRetryAt;
    } else {
      metadataContainer.innerHTML = "";
      titlebar.dataset.enhancedPending = "false";
      titlebar.dataset.enhancedComplete = "false";
      if (attempts < RETRY_CONFIG.maxAttempts) {
        titlebar.dataset.enhancedRetryAt = (
          Date.now() +
          RETRY_CONFIG.delay * attempts
        ).toString();
        scheduleEnhancement();
      }
    }
    } finally {
      applyingEnhancement = false;
    }
  } catch (error) {
    applyingEnhancement = true;
    try {
      metadataContainer.innerHTML = "";
    } finally {
      applyingEnhancement = false;
    }
    console.log("Metadata fetch failed:", error);
    titlebar.dataset.enhancedPending = "false";
    titlebar.dataset.enhancedComplete = "false";
    if (attempts < RETRY_CONFIG.maxAttempts) {
      titlebar.dataset.enhancedRetryAt = (
        Date.now() +
        RETRY_CONFIG.delay * attempts
      ).toString();
      scheduleEnhancement();
    }
  }
}

function isOwnEnhancementMutation(target) {
  // Only ignore mutations we ourselves cause while applying DOM writes.
  return applyingEnhancement;
}

/**
 * True when board scroll or row reveal/load should defer titlebar work.
 * @returns {boolean}
 */
function isBoardEnhancePaused() {
  return (
    boardScrollBusy ||
    boardRowBusy ||
    !!window.__mystremioBoardRowBusy
  );
}

/**
 * Bind board vertical-scroll pause so enhance runs on idle only.
 */
function ensureBoardScrollPause() {
  if (boardScrollBound) return;
  boardScrollBound = true;
  document.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!String(target.className || "").includes("board-content")) return;
      boardScrollBusy = true;
      if (boardScrollIdleTimer) clearTimeout(boardScrollIdleTimer);
      boardScrollIdleTimer = setTimeout(() => {
        boardScrollBusy = false;
        scheduleEnhancement();
      }, 180);
    },
    { capture: true, passive: true },
  );
}

/**
 * Pause titlebar enhance during horizontal reveal / LoadNextPage.
 */
function ensureBoardRowBusyPause() {
  if (boardRowBusyBound) return;
  boardRowBusyBound = true;
  document.addEventListener("mystremio-board-row-busy", (event) => {
    const detail = event && event.detail;
    boardRowBusy = !!(detail && detail.busy) || !!window.__mystremioBoardRowBusy;
    if (!boardRowBusy && !boardScrollBusy) {
      scheduleEnhancement();
    }
  });
}

/**
 * @param {*} fn
 */
function runWhenIdle(fn) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => fn(), { timeout: 800 });
    return;
  }
  setTimeout(fn, 0);
}

function scheduleEnhancement(mutationTarget) {
  if (mutationTarget && isOwnEnhancementMutation(mutationTarget)) {
    return;
  }
  if (enhanceTimeout) {
    clearTimeout(enhanceTimeout);
  }
  enhanceTimeout = setTimeout(() => {
    enhanceTimeout = null;
    if (isBoardEnhancePaused()) {
      enhanceQueued = true;
      return;
    }
    const now = Date.now();
    if (isEnhancing) {
      enhanceQueued = true;
      return;
    }
    const wait = MIN_RUN_INTERVAL - (now - lastEnhanceRun);
    if (wait > 0) {
      enhanceQueued = true;
      // Drain queue after rate-limit window (late enable / IO bursts).
      enhanceTimeout = setTimeout(() => {
        enhanceTimeout = null;
        if (isBoardEnhancePaused()) {
          enhanceQueued = true;
          return;
        }
        if (enhanceQueued || pendingVisibleItems.size > 0) {
          enhanceQueued = false;
          runWhenIdle(() => enhanceMediaContainers());
        }
      }, wait);
      return;
    }
    runWhenIdle(() => enhanceMediaContainers());
  }, 300);
}

function scheduleLibraryEnhancementRefresh() {
  restoreLibraryNativeTitlebars();
}

function init() {
  injectStyles();
  ensureBoardScrollPause();
  ensureBoardRowBusyPause();

  if (intersectionObserver) {
    intersectionObserver.disconnect();
  }
  if (typeof IntersectionObserver !== "undefined") {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        let queued = false;
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (!entry.isIntersecting) continue;
          pendingVisibleItems.add(entry.target);
          queued = true;
        }
        if (queued) scheduleEnhancement();
      },
      { root: null, rootMargin: "120px 0px", threshold: 0.01 },
    );
  }

  if (isLibraryPage()) {
    restoreLibraryNativeTitlebars();
  } else {
    observeTitlebarTargets();
    enhanceMediaContainers();
    [100, 600].forEach((ms) => {
      setTimeout(() => {
        if (!shouldEnhancePage()) return;
        observeTitlebarTargets();
        scheduleEnhancement();
      }, ms);
    });
  }

  bindMutationObserver();

  document.addEventListener("click", onTitlebarLibraryClick, true);
  document.addEventListener("stremio-custom-route-change", onTitlebarRouteChange);
}

function bindMutationObserver() {
  if (typeof MutationObserver === "undefined") return;
  if (!mutationObserver) {
    mutationObserver = new MutationObserver((mutations) => {
      let shouldObserve = false;
      let queued = false;
      for (let i = 0; i < mutations.length; i++) {
        const mutation = mutations[i];
        if (mutation.type === "attributes") {
          if (mutation.attributeName !== "href") continue;
          const item = mutation.target?.closest?.(
            '[class*="meta-item-container"]',
          );
          if (item) pendingVisibleItems.add(item);
          queued = true;
          continue;
        }
        if (mutation.type !== "childList" || !mutation.addedNodes?.length) {
          continue;
        }
        for (let j = 0; j < mutation.addedNodes.length; j++) {
          const node = mutation.addedNodes[j];
          if (!(node instanceof Element)) continue;
          if (isOwnEnhancementMutation(node)) continue;
          if (
            node.closest?.(".enhanced-title-bar") ||
            (typeof node.className === "string" &&
              node.className.includes("enhanced-title"))
          ) {
            continue;
          }
          if (
            node.matches?.('img[class*="poster-image"]') ||
            node.closest?.('[class*="poster-image-layer"]')
          ) {
            continue;
          }
          const item =
            (typeof node.className === "string" &&
            node.className.includes("meta-item-container")
              ? node
              : null) ||
            node.querySelector?.('[class*="meta-item-container"]');
          if (!item) continue;
          pendingVisibleItems.add(item);
          shouldObserve = true;
          queued = true;
        }
      }
      if (shouldObserve) observeTitlebarTargets();
      if (queued) scheduleEnhancement();
    });
  }
  const moRoot = document.querySelector("#app") || document.body;
  if (!moRoot) return;
  try {
    mutationObserver.observe(moRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
  } catch (_) {
    /* ignore */
  }
}

/**
 * Soft re-apply after live enable when hard reload did not run.
 */
window.__stremioEnhancedTitlebarForceRefresh = function () {
  try {
    injectStyles();
    ensureBoardScrollPause();
    ensureBoardRowBusyPause();
    observeTitlebarTargets();
    scheduleEnhancement();
    [100, 600].forEach((ms) => {
      setTimeout(() => {
        if (!shouldEnhancePage()) return;
        observeTitlebarTargets();
        scheduleEnhancement();
      }, ms);
    });
  } catch (error) {
    console.warn("[EnhancedTitlebar] ForceRefresh failed:", error);
  }
};

/**
 * Hard unload for live disable — restores stock titlebars and removes reserved height.
 * DOM restore runs before style removal so orphan enhanced nodes never render unstyled.
 */
window.__stremioEnhancedTitlebarUnload = function () {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
  }
  pendingVisibleItems.clear();
  if (enhanceTimeout) {
    clearTimeout(enhanceTimeout);
    enhanceTimeout = null;
  }
  if (boardScrollIdleTimer) {
    clearTimeout(boardScrollIdleTimer);
    boardScrollIdleTimer = null;
  }
  boardScrollBusy = false;
  boardRowBusy = false;
  document.removeEventListener("click", onTitlebarLibraryClick, true);
  document.removeEventListener("stremio-custom-route-change", onTitlebarRouteChange);
  try {
    restoreLibraryNativeTitlebars();
  } catch (_) {}
  collectEnhancedTitlebarHosts().forEach((node) => {
    try {
      clearEnhancedState(node);
    } catch (_) {
      /* ignore */
    }
  });
  // Strip any leftover enhanced nodes that escaped host restore.
  document
    .querySelectorAll(".enhanced-title, .enhanced-metadata, .enhanced-loading")
    .forEach((node) => {
      try {
        node.remove();
      } catch (_) {
        /* ignore */
      }
    });
  document.getElementById("enhanced-title-bar-styles")?.remove();
  try {
    document.dispatchEvent(new CustomEvent("stremio-custom-hero-layout-changed"));
  } catch (_) {
    /* ignore */
  }
  try {
    delete window.__stremioEnhancedTitlebarForceRefresh;
  } catch (_) {
    window.__stremioEnhancedTitlebarForceRefresh = undefined;
  }
  try {
    delete window.__EnhancedTitlebarLoaded;
  } catch (_) {
    window.__EnhancedTitlebarLoaded = false;
  }
};

window.__stremioEnhancedTitlebarSuspend = function () {
  try {
    mutationObserver?.disconnect();
    intersectionObserver?.disconnect();
  } catch (_) {}
};

window.__stremioEnhancedTitlebarResume = function () {
  try {
    bindMutationObserver();
    if (typeof window.__stremioEnhancedTitlebarForceRefresh === "function") {
      window.__stremioEnhancedTitlebarForceRefresh();
    }
  } catch (_) {}
};

function bootEnhancedTitlebar() {
  init();
  if (window.stremioCustomSuspendBackground?.()) {
    window.__stremioEnhancedTitlebarSuspend?.();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootEnhancedTitlebar, { once: true });
} else {
  bootEnhancedTitlebar();
}

})();
