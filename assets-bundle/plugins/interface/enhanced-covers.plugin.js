/**
 * @name EnhancedCovers
 * @description Widens the cover images in the Continue Watching section using background images with logo overlay.
 * @updateUrl none
 * @version 26.0.5
 * @author Fxy rewritten and improved by MrBlu03
 */

(function () {
  if (window.__EnhancedCoversLoaded) return;
  window.__EnhancedCoversLoaded = true;

  // Store references for cleanup
  let coverInterval = null;
  let coverObserver = null;

  function onCoversRouteChange() {
    injectStyles();
    setTimeout(replaceCover, 500);
    setTimeout(replaceCover, 1500);
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
    console.log("[EnhancedCovers] Styles injected");
  }

  // Extract IMDB ID from various URL formats
  function extractImdbId(url) {
    if (!url) return null;
    const match = String(url).match(/(tt\d+)/);
    return match ? match[1] : null;
  }

  /**
   * Card identity from the meta-item link (authoritative after React reuse).
   * Prefer href over img.src because EnhancedCovers owns the image URL.
   * @param {HTMLImageElement} img
   * @returns {string|null}
   */
  function getCardImdbId(img) {
    const card =
      img.closest('[class*="meta-item-container"]') ||
      img.closest('[class*="meta-item"]');
    if (!card) return extractImdbId(img.src);
    const link =
      card.tagName === 'A'
        ? card
        : card.querySelector('a[href*="tt"], a[href*="/detail/"]');
    const fromHref = extractImdbId(link?.getAttribute('href') || link?.href || '');
    if (fromHref) return fromHref;
    return extractImdbId(img.dataset.originalSrc) || extractImdbId(img.src);
  }

  /**
   * Hard-reset an enhanced poster so it can be re-bound to a new title.
   * @param {HTMLImageElement} img
   */
  function resetEnhancedCover(img) {
    const gen = String((Number(img.dataset.enhanceGen) || 0) + 1);
    img.dataset.enhanceGen = gen;

    if (img.dataset.originalSrc) {
      img.src = img.dataset.originalSrc;
    }
    delete img.dataset.enhancedCover;
    delete img.dataset.originalSrc;
    delete img.dataset.imdbId;

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
      'img[class*="poster-image"][data-enhanced-cover]',
    );

    posters.forEach((img) => {
      const storedImdbId = img.dataset.imdbId || '';
      const cardImdbId = getCardImdbId(img) || '';

      // Identity drifted, missing, or unknown → hard reset (React reused the node)
      if (!storedImdbId || !cardImdbId || storedImdbId !== cardImdbId) {
        console.log(
          `[EnhancedCovers] Detected stale cover: was ${storedImdbId || '?'}, card ${cardImdbId || '?'}`,
        );
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
          console.log("[EnhancedCovers] Removed orphaned logo");
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

      const imdbId = getCardImdbId(img);
      if (!imdbId) return;

      // Already enhanced for this exact title
      if (img.dataset.enhancedCover === "true" && img.dataset.imdbId === imdbId) {
        return;
      }

      // Stale enhancement for a different title
      if (img.dataset.enhancedCover === "true") {
        resetEnhancedCover(img);
      }

      const backgroundSrc = `https://images.metahub.space/background/large/${imdbId}/img`;
      const logoSrc = `https://images.metahub.space/logo/medium/${imdbId}/img`;

      const gen = String((Number(img.dataset.enhanceGen) || 0) + 1);
      img.dataset.enhanceGen = gen;
      img.dataset.enhancedCover = "true";
      img.dataset.originalSrc = img.dataset.originalSrc || img.src;
      img.dataset.imdbId = imdbId;

      const posterContainer = img.closest('[class*="poster-container"]');
      if (posterContainer) {
        posterContainer.querySelectorAll('.enhanced-logo-overlay').forEach((logo) => logo.remove());
      }

      const testImg = new Image();
      testImg.onload = function () {
        if (img.dataset.enhanceGen !== gen || img.dataset.imdbId !== imdbId) return;
        img.src = backgroundSrc;

        if (posterContainer) {
          const logoImg = document.createElement("img");
          logoImg.className = "enhanced-logo-overlay";
          logoImg.alt = "";
          logoImg.loading = "lazy";

          const testLogo = new Image();
          testLogo.onload = function () {
            if (img.dataset.enhanceGen !== gen || img.dataset.imdbId !== imdbId) return;
            logoImg.src = logoSrc;
            const playLayer = posterContainer.querySelector('[class*="play-icon-layer"]');
            if (playLayer) {
              posterContainer.insertBefore(logoImg, playLayer);
            } else {
              posterContainer.appendChild(logoImg);
            }
            console.log(`[EnhancedCovers] Added logo for ${imdbId}`);
          };
          testLogo.onerror = function () {
            console.log(`[EnhancedCovers] No logo found for ${imdbId}`);
          };
          testLogo.src = logoSrc;
        }

        console.log(`[EnhancedCovers] Replaced cover for ${imdbId}`);
      };
      testImg.onerror = function () {
        if (img.dataset.enhanceGen !== gen) return;
        img.dataset.enhancedCover = "failed";
        console.log(`[EnhancedCovers] No background found for ${imdbId}`);
      };
      testImg.src = backgroundSrc;
    });
  }

  function startPlugin() {
    // Inject styles immediately
    injectStyles();

    // Initial run with delay to let Stremio load
    setTimeout(replaceCover, 1000);
    setTimeout(replaceCover, 2000);

    // Use MutationObserver for efficient DOM change detection
    coverObserver = new MutationObserver((mutations) => {
      let shouldUpdate = false;
      let hasRemovedNodes = false;

      for (const mutation of mutations) {
        // Check for removed nodes (item dismissed)
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

        // Check for added nodes
        if (mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              if (
                node.matches?.('[class*="continue-watching"]') ||
                node.querySelector?.('[class*="continue-watching"]') ||
                node.matches?.('[class*="meta-item"]') ||
                node.querySelector?.('[class*="meta-item"]') ||
                node.matches?.('[class*="board-row"]') ||
                node.querySelector?.('[class*="board-row"]')
              ) {
                shouldUpdate = true;
              }
            }
            
            if (shouldUpdate) break;
          }
        }

        // Check for attribute changes on images (src changes)
        if (mutation.type === "attributes" && mutation.attributeName === "src") {
          const target = mutation.target;
          if (target.matches?.('img[class*="poster-image"]')) {
            shouldUpdate = true;
          }
        }

        if (shouldUpdate) break;
      }

      if (shouldUpdate) {
        injectStyles();
        if (hasRemovedNodes) {
          // Item was removed - need immediate cleanup
          cleanupStaleCovers();
          setTimeout(replaceCover, 50);
        }
        setTimeout(replaceCover, 100);
        setTimeout(replaceCover, 500);
      }
    });

    coverObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
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

  console.log("[EnhancedCovers] Plugin loaded successfully v1.7.0");
})();
