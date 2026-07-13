/**
 * @name Enhanced Title Bar
 * @description Enhances the title bar with additional information.
 * @version 26.0.5
 * @author Fxy
 */

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
let isEnhancing = false;
let lastEnhanceRun = 0;
const MIN_RUN_INTERVAL = 800;

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

async function getMetadata(id, type) {
  const cacheKey = `${type}-${id}`;

  if (metadataCache.has(cacheKey)) {
    return metadataCache.get(cacheKey);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);

    const response = await fetch(`${CONFIG.apiBase}/${type}/${id}.json`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const meta = data.meta;

    if (!meta) return null;

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
      poster: meta.poster,
      background: meta.background,
    };

    metadataCache.set(cacheKey, metadata);
    return metadata;
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

function clearEnhancedState(titlebar) {
  if (titlebar.classList.contains("enhanced-title-bar")) {
    if (titlebar.dataset.originalContent) {
      titlebar.innerHTML = titlebar.dataset.originalContent;
    } else {
      titlebar
        .querySelectorAll(".enhanced-title, .enhanced-metadata, .enhanced-loading")
        .forEach((node) => node.remove());
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
  return null;
}

function extractImdbId(posterImg, detailLink, cardOrContainer) {
  const posterId = extractImdbIdFromPoster(posterImg);
  if (posterId) {
    return posterId;
  }

  const linkId = extractImdbIdFromDetailLink(detailLink);
  if (linkId) {
    return linkId;
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

  const posterId = extractImdbIdFromPoster(posterImg);
  const linkId = extractImdbIdFromDetailLink(link);
  if (posterId && linkId && posterId !== linkId) {
    link = null;
  }

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
    genres.className = "enhanced-metadata-item";
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
  if (isEnhancing) return;
  isEnhancing = true;
  lastEnhanceRun = Date.now();

  try {
    await enhanceMediaContainersImpl();
  } finally {
    isEnhancing = false;
  }
}

async function enhanceMediaContainersImpl() {
  const items = document.querySelectorAll('[class*="meta-item-container"]');
  for (let i = 0; i < items.length; i++) {
    try {
      await enhanceMetaItemContainer(items[i]);
    } catch (error) {
      console.log("Meta item enhancement failed:", error);
    }
  }
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

  const posterImg =
    itemRoot.querySelector('img[src*="tt"]') || itemRoot.querySelector("img");
  if (!posterImg) {
    return;
  }

  const titlebar = itemRoot.querySelector(
    '[class*="title-bar-container"], [class*="title-bar"]',
  );
  if (!titlebar) {
    return;
  }

  let detailLink =
    posterImg.closest('a[href^="stremio:///detail/"], a[href*="#/detail/"]') ||
    itemRoot.querySelector('a[href^="stremio:///detail/"], a[href*="#/detail/"]');

  detailLink = resolveTileLinks(posterImg, detailLink, itemRoot);

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

  console.log(`Enhancing: "${originalTitle}" with IMDb ID: ${imdbId}`);

  // Mark as enhanced and store ID
  titlebar.classList.add("enhanced-title-bar");

  // Store original content if not already stored
  if (!titlebar.dataset.originalContent && !titlebar.classList.contains("enhanced-title-bar")) {
    titlebar.dataset.originalContent = titlebar.innerHTML;
  }

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
  } catch (error) {
    metadataContainer.innerHTML = "";
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
  return (
    target &&
    typeof target.closest === "function" &&
    target.closest(".enhanced-title-bar")
  );
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
    const now = Date.now();
    if (isEnhancing || now - lastEnhanceRun < MIN_RUN_INTERVAL) {
      return;
    }
    enhanceMediaContainers();
  }, 300);
}

function scheduleLibraryEnhancementRefresh() {
  restoreLibraryNativeTitlebars();
}

function init() {
  injectStyles();
  if (isLibraryPage()) {
    restoreLibraryNativeTitlebars();
  } else {
    enhanceMediaContainers();
  }

  if (mutationObserver) {
    mutationObserver.disconnect();
  }
  if (typeof MutationObserver !== "undefined") {
    mutationObserver = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const target = mutations[i].target;
        if (!isOwnEnhancementMutation(target)) {
          scheduleEnhancement(target);
          return;
        }
      }
    });
    if (document.body) {
      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  }

  setInterval(() => {
    if (window.stremioCustomSuspendBackground?.()) return;
    if (shouldEnhancePage()) {
      enhanceMediaContainers();
    }
  }, 5000);

  document.addEventListener(
    "click",
    (event) => {
      const chip = event.target?.closest?.(
        '[class*="library-container"] [class*="chip-"]:not([data-sc-custom-folder-tab])',
      );
      if (!chip) return;
      setTimeout(scheduleLibraryEnhancementRefresh, 120);
    },
    true,
  );

  window.addEventListener("hashchange", () => {
    if (isLibraryPage()) {
      restoreLibraryNativeTitlebars();
      return;
    }
    scheduleEnhancement();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

setTimeout(init, 100);
