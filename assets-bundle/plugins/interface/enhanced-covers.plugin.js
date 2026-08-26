/**
 * @name EnhancedCovers
 * @description Widens the cover images in the Continue Watching section using background images with logo overlay.
 * @updateUrl none
 * @version 26.0.6
 * @author Fxy / MrBlu03 · adapted for MyStremio
 */

(function () {
  if (window.__EnhancedCoversLoaded) return;
  window.__EnhancedCoversLoaded = true;

  // Store references for cleanup
  let coverInterval = null;
  let coverObserver = null;
  let coverObserveRetry = null;
  let coverUpdateTimer = null;

  /**
   * @returns {boolean}
   */
  function isBoardRoute() {
    const h = location.hash || "";
    if (!h || h === "#/" || h === "#") return true;
    if (h.includes("/board")) return true;
    if (/^#\/?\?/.test(h)) return true;
    return false;
  }

  function onCoversRouteChange() {
    injectStyles();
    observeContinueWatchingRoot();
    if (!isBoardRoute()) {
      if (coverObserver) {
        try {
          coverObserver.disconnect();
        } catch (_) {
          /* ignore */
        }
      }
      return;
    }
    scheduleReplaceCover(120);
    scheduleReplaceCover(600);
  }

  /**
   * Coalesce replaceCover calls (avoid 50/100/500 storms).
   * @param {number} delayMs
   */
  function scheduleReplaceCover(delayMs) {
    if (coverUpdateTimer) clearTimeout(coverUpdateTimer);
    coverUpdateTimer = setTimeout(() => {
      coverUpdateTimer = null;
      replaceCover();
    }, delayMs);
  }

  // Inject CSS to widen the poster containers - only in continue-watching-row
  function injectStyles() {
    if (document.getElementById("enhanced-covers-styles")) return;

    const style = document.createElement("style");
    style.id = "enhanced-covers-styles";
    style.textContent = `
      /* Only target Continue Watching row using exact class */
      [class*="continue-watching-row"] [class*="meta-item-container"] {
        min-width: 422px !important;
        max-width: 422px !important;
        flex: none !important;
      }

      /* Override the poster-shape-poster aspect ratio */
      [class*="continue-watching-row"] [class*="meta-item-container"][class*="poster-shape-poster"] {
        height: auto !important;
      }

      /* Make poster container height fit content, not use padding trick */
      [class*="continue-watching-row"] [class*="poster-container"] {
        padding-top: 0 !important;
        height: auto !important;
        aspect-ratio: 16 / 9 !important;
      }

      /* Keep image layer behind interactive overlays (play button, progress) */
      [class*="continue-watching-row"] [class*="poster-image-layer"] {
        position: absolute !important;
        top: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        left: 0 !important;
        z-index: 1 !important;
        height: 100% !important;
        width: 100% !important;
      }

      [class*="continue-watching-row"] [class*="play-icon-layer"] {
        z-index: 20 !important;
        pointer-events: auto !important;
        position: absolute !important;
      }

      /* Keep inner play triangle above the ring (do not flatten child z-index) */
      [class*="continue-watching-row"] [class*="play-icon-layer"] [class*="play-icon-outer"] {
        z-index: 1 !important;
      }

      [class*="continue-watching-row"] [class*="play-icon-layer"] [class*="play-icon-"]:not([class*="outer"]):not([class*="background"]) {
        z-index: 2 !important;
        position: relative !important;
        opacity: 1 !important;
        visibility: visible !important;
      }

      [class*="continue-watching-row"] [class*="progress-bar-layer"] {
        z-index: 12 !important;
        pointer-events: none !important;
      }

      [class*="continue-watching-row"] [class*="dismiss-icon-layer"] {
        z-index: 16 !important;
        pointer-events: auto !important;
      }

      /* Ensure the image covers properly */
      [class*="continue-watching-row"] [class*="poster-image-layer"] img[class*="poster-image"] {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: 100% !important;
        height: 100% !important;
        aspect-ratio: 16 / 9 !important;
        object-fit: cover !important;
        object-position: center center !important;
      }

      /* Logo overlay styling */
      .enhanced-logo-overlay {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 2;
        max-height: 50%;
        max-width: 70%;
        object-fit: contain;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));
        pointer-events: none;
      }

      /* Add vignette overlay for better logo visibility */
      [class*="continue-watching-row"] [class*="poster-container"]::after {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        right: 0;
        background: radial-gradient(ellipse at center, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.5) 100%);
        pointer-events: none;
        z-index: 0;
        border-radius: var(--border-radius, 0.5rem);
      }

      /* Ensure poster container is relative for absolute positioning */
      [class*="continue-watching-row"] [class*="poster-container"] {
        position: relative;
      }
    `;
    document.head.appendChild(style);
  }

  // Extract IMDB ID from various URL formats
  function extractImdbId(url) {
    if (!url) return null;
    const match = String(url).match(/(tt\d{7,8})/i);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * @param {Element|null} el
   * @returns {Element|null}
   */
  function closestCard(el) {
    return (
      el?.closest?.('[class*="meta-item-container"]') ||
      el?.closest?.('[class*="meta-item"]') ||
      null
    );
  }

  /**
   * Authoritative card identity after React reuse — never img.src (that is EC-owned).
   * @param {Element|null} el
   * @returns {string}
   */
  function getCardKey(el) {
    const card = closestCard(el);
    if (!card) return '';
    const link =
      card.tagName === 'A'
        ? card
        : card.querySelector('a[href*="/detail/"], a[href]');
    const href = String(link?.getAttribute?.('href') || link?.href || '').trim();
    return href;
  }

  /**
   * IMDb from the current href only. Never from img.src (stale Outer Banks URL).
   * @param {HTMLImageElement} img
   * @returns {string|null}
   */
  function getCardImdbId(img) {
    return extractImdbId(getCardKey(img)) || null;
  }

  /**
   * Hard-reset an enhanced poster so it can be re-bound to a new title.
   * @param {HTMLImageElement} img
   */
  function resetEnhancedCover(img) {
    const gen = String((Number(img.dataset.enhanceGen) || 0) + 1);
    img.dataset.enhanceGen = gen;
    img.style.removeProperty('content');
    delete img.dataset.enhancedCover;
    delete img.dataset.originalSrc;
    delete img.dataset.imdbId;
    delete img.dataset.coverKey;

    const posterContainer = img.closest('[class*="poster-container"]');
    if (posterContainer) {
      posterContainer.querySelectorAll('.enhanced-logo-overlay').forEach((logo) => logo.remove());
    }
  }

  // Clean up stale enhanced covers when items change / cards are reused
  function cleanupStaleCovers() {
    const continueWatchingRow = document.querySelector(
      '[class*="continue-watching-row"]',
    );
    if (!continueWatchingRow) return;

    const posters = continueWatchingRow.querySelectorAll(
      'img[class*="poster-image"]',
    );

    posters.forEach((img) => {
      const coverKey = getCardKey(img);
      const storedKey = img.dataset.coverKey || '';
      if (img.dataset.enhancedCover && storedKey !== coverKey) {
        resetEnhancedCover(img);
      }
    });

    // Also clean up any orphaned logos (logos without matching enhanced image)
    const allLogos = continueWatchingRow.querySelectorAll(
      ".enhanced-logo-overlay",
    );
    allLogos.forEach((logo) => {
      const posterContainer = logo.closest('[class*="poster-container"]');
      if (posterContainer) {
        const img = posterContainer.querySelector('img[class*="poster-image"]');
        if (!img || img.dataset.enhancedCover !== "true") {
          logo.remove();
        }
      }
    });
  }

  function replaceCover() {
    // First cleanup any stale covers
    cleanupStaleCovers();

    // Only target poster images inside continue-watching-row
    const continueWatchingRow = document.querySelector(
      '[class*="continue-watching-row"]',
    );
    if (!continueWatchingRow) return;

    const posters = continueWatchingRow.querySelectorAll(
      'img[class*="poster-image"]',
    );

    posters.forEach((img) => {
      if (!img.src) return;

      const coverKey = getCardKey(img);
      if (!coverKey) return;

      if (img.dataset.enhancedCover === "true" && img.dataset.coverKey === coverKey) {
        return;
      }

      if (img.dataset.enhancedCover) {
        resetEnhancedCover(img);
      }

      const imdbId = extractImdbId(coverKey);
      if (!imdbId) {
        // Kitsu / non-IMDb cards keep their own poster — do not steal tt from img.src.
        return;
      }

      const backgroundSrc = `https://images.metahub.space/background/large/${imdbId}/img`;
      const logoSrc = `https://images.metahub.space/logo/medium/${imdbId}/img`;

      const gen = String((Number(img.dataset.enhanceGen) || 0) + 1);
      img.dataset.enhanceGen = gen;
      img.dataset.enhancedCover = "true";
      img.dataset.coverKey = coverKey;
      img.dataset.originalSrc = img.src;
      img.dataset.imdbId = imdbId;

      const posterContainer = img.closest('[class*="poster-container"]');
      if (posterContainer) {
        posterContainer.querySelectorAll('.enhanced-logo-overlay').forEach((logo) => logo.remove());
      }

      const testImg = new Image();
        testImg.onload = function () {
        if (
          img.dataset.enhanceGen !== gen ||
          img.dataset.imdbId !== imdbId ||
          img.dataset.coverKey !== coverKey
        ) {
          return;
        }
        img.src = backgroundSrc;

        if (posterContainer) {
          const logoImg = document.createElement("img");
          logoImg.className = "enhanced-logo-overlay";
          logoImg.alt = "";
          logoImg.loading = "lazy";

          const testLogo = new Image();
          testLogo.onload = function () {
            if (
              img.dataset.enhanceGen !== gen ||
              img.dataset.imdbId !== imdbId ||
              img.dataset.coverKey !== coverKey
            ) {
              return;
            }
            logoImg.src = logoSrc;
            const playLayer = posterContainer.querySelector('[class*="play-icon-layer"]');
            if (playLayer) {
              posterContainer.insertBefore(logoImg, playLayer);
            } else {
              posterContainer.appendChild(logoImg);
            }
          };
          testLogo.src = logoSrc;
        }
      };
      testImg.onerror = function () {
        if (img.dataset.enhanceGen !== gen) return;
        img.dataset.enhancedCover = "failed";
      };
      testImg.src = backgroundSrc;
    });
  }

  /**
   * Observe only the Continue Watching row — never board catalog rows.
   */
  function observeContinueWatchingRoot() {
    if (!coverObserver) {
      coverObserver = new MutationObserver((mutations) => {
        let shouldUpdate = false;
        let hasRemovedNodes = false;

        for (const mutation of mutations) {
          if (mutation.removedNodes.length > 0) {
            for (const node of mutation.removedNodes) {
              if (node.nodeType === 1) {
                if (
                  node.matches?.('[class*="meta-item"]') ||
                  node.querySelector?.('[class*="meta-item"]')
                ) {
                  hasRemovedNodes = true;
                  shouldUpdate = true;
                  break;
                }
              }
            }
          }

          if (mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== 1) continue;
              if (
                node.matches?.('[class*="meta-item"]') ||
                node.querySelector?.('[class*="meta-item"]') ||
                node.matches?.('[class*="continue-watching"]')
              ) {
                shouldUpdate = true;
                break;
              }
            }
          }

          if (mutation.type === "attributes") {
            const target = mutation.target;
            if (
              mutation.attributeName === "src" &&
              target.matches?.('img[class*="poster-image"]')
            ) {
              const coverKey = getCardKey(target);
              const owned =
                target.dataset?.enhancedCover === "true" &&
                coverKey &&
                target.dataset?.coverKey === coverKey;
              if (!owned) shouldUpdate = true;
            }
            if (
              mutation.attributeName === "href" &&
              target.closest?.('[class*="continue-watching"]')
            ) {
              shouldUpdate = true;
              hasRemovedNodes = true;
              cleanupStaleCovers();
            }
          }

          if (shouldUpdate) break;
        }

        if (shouldUpdate) {
          injectStyles();
          if (hasRemovedNodes) cleanupStaleCovers();
          scheduleReplaceCover(120);
        }
      });
    }

    try {
      coverObserver.disconnect();
    } catch (_) {
      /* ignore */
    }

    const cw = document.querySelector('[class*="continue-watching-row"]');
    if (!cw) {
      if (coverObserveRetry) clearTimeout(coverObserveRetry);
      coverObserveRetry = setTimeout(() => {
        coverObserveRetry = null;
        if (isBoardRoute()) observeContinueWatchingRoot();
      }, 400);
      return;
    }

    coverObserver.observe(cw, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "href"],
    });
  }

  function startPlugin() {
    injectStyles();
    scheduleReplaceCover(800);
    scheduleReplaceCover(1800);
    observeContinueWatchingRoot();
  }

  if (document.body && document.head) {
    startPlugin();
  } else {
    const checkReady = () => {
      if (document.body && document.head) {
        startPlugin();
      } else {
        setTimeout(checkReady, 50);
      }
    };
    checkReady();
  }

  // Handle navigation changes (HashRouter via route bus)
  document.addEventListener("stremio-custom-route-change", onCoversRouteChange);

  /**
   * Hard unload for live disable.
   */
  window.__stremioEnhancedCoversUnload = function () {
    if (coverObserver) {
      coverObserver.disconnect();
      coverObserver = null;
    }
    if (coverInterval) {
      clearInterval(coverInterval);
      coverInterval = null;
    }
    if (coverUpdateTimer) {
      clearTimeout(coverUpdateTimer);
      coverUpdateTimer = null;
    }
    if (coverObserveRetry) {
      clearTimeout(coverObserveRetry);
      coverObserveRetry = null;
    }
    document.removeEventListener("stremio-custom-route-change", onCoversRouteChange);
    document.querySelectorAll('img[data-enhanced-cover="true"]').forEach((img) => {
      try {
        resetEnhancedCover(img);
      } catch (_) {}
    });
    document.getElementById("enhanced-covers-styles")?.remove();
    try {
      delete window.__EnhancedCoversLoaded;
    } catch (_) {
      window.__EnhancedCoversLoaded = false;
    }
  };

})();
