(function () {
  'use strict';

  if (window.__stremioCustomLiquidGlassNav) return;
  window.__stremioCustomLiquidGlassNav = true;

  const cachedNavbars = new Map();
  let fixTimer = null;
  let observer = null;
  let transitionActive = false;
  let navClickCaptureBound = false;

  const NAV_FOCUS_STYLE_ID = 'stremio-custom-nav-focus-style';
  const NAV_TRANSITION_STYLE_ID = 'stremio-custom-nav-transition-style';
  const TRANSITION_HOST_ID = 'stremio-custom-nav-transition-host';

  function ensureTransitionStyles() {
    if (document.getElementById(NAV_TRANSITION_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = NAV_TRANSITION_STYLE_ID;
    style.textContent = `
      #${TRANSITION_HOST_ID} {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 121;
        pointer-events: auto;
      }

      #${TRANSITION_HOST_ID} nav[class*="horizontal-nav-bar"] {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
      }

      #app [class*="main-nav-bars-container"] > [class*="vertical-nav-bar"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }

      #app nav[class*="horizontal-nav-bar"] [class*="vertical-nav-bar"] {
        visibility: visible !important;
        pointer-events: auto !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureNavFocusStyles() {
    if (document.getElementById(NAV_FOCUS_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = NAV_FOCUS_STYLE_ID;
    style.textContent = `
      #app [class*="nav-tab-button-container"],
      #app [class*="nav-tab-button"],
      #app [class*="horizontal-nav-bar"] a {
        -webkit-tap-highlight-color: transparent !important;
      }

      #app [class*="nav-tab-button-container"]:focus,
      #app [class*="nav-tab-button-container"]:focus-visible,
      #app [class*="nav-tab-button"]:focus,
      #app [class*="nav-tab-button"]:focus-visible,
      #app [class*="horizontal-nav-bar"] a:focus,
      #app [class*="horizontal-nav-bar"] a:focus-visible {
        outline: none !important;
        box-shadow: none !important;
      }

      #app [class*="nav-tab-button-container"]:active,
      #app [class*="horizontal-nav-bar"] [class*="nav-tab-button-container"]:active,
      #app [class*="horizontal-nav-bar"] [class*="nav-tab-button"]:active,
      #app [class*="horizontal-nav-bar"] a:active {
        border-color: rgba(255, 255, 255, 0.5) !important;
        outline: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function navigateToHash(href) {
    if (!href || href === '#') return;
    const target = href.startsWith('#') ? href : `#${href}`;
    if (location.hash === target) {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return;
    }
    location.hash = target;
  }

  function wireNavLinks(root) {
    if (!root) return;
    root.querySelectorAll('a[href^="#"]').forEach((link) => {
      if (link.dataset.scNavWired === '1') return;
      link.dataset.scNavWired = '1';
      link.style.pointerEvents = 'auto';
      link.style.cursor = 'pointer';
    });
  }

  function wireCloneLinks(root) {
    if (!root) return;
    root.querySelectorAll('a[href^="#"]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        navigateToHash(link.getAttribute('href'));
      }, true);
    });
  }

  function ensureNavClickable() {
    const roots = [
      document.querySelector('[class*="horizontal-nav-bar"]'),
      document.querySelector('[class*="vertical-nav-bar"]'),
      document.querySelector('[class*="main-nav-bars-container"]'),
    ].filter(Boolean);
    roots.forEach(wireNavLinks);
  }

  function isNavVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isHorizontalNavReady(nav) {
    return Boolean(
      nav &&
      nav.isConnected &&
      nav.querySelector('[class*="vertical-nav-bar"]') &&
      isNavVisible(nav)
    );
  }

  function ensureTransitionHost() {
    let host = document.getElementById(TRANSITION_HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = TRANSITION_HOST_ID;
      document.body.appendChild(host);
    }
    return host;
  }

  function beginNavTransition() {
    if (transitionActive) return true;

    const nav = document.querySelector('#app nav[class*="horizontal-nav-bar"]');
    if (!isHorizontalNavReady(nav)) return false;

    const host = ensureTransitionHost();
    const clone = nav.cloneNode(true);
    wireCloneLinks(clone);
    host.replaceChildren(clone);
    transitionActive = true;
    return true;
  }

  function endNavTransition() {
    const host = document.getElementById(TRANSITION_HOST_ID);
    if (host) host.replaceChildren();
    transitionActive = false;
  }

  function tryEndNavTransition() {
    if (!transitionActive) return;
    const liveNav = document.querySelector('#app nav[class*="horizontal-nav-bar"]');
    if (!isHorizontalNavReady(liveNav)) return;
    endNavTransition();
  }

  function onNavLinkClick(event) {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    if (!link.closest('[class*="horizontal-nav-bar"], [class*="vertical-nav-bar"]')) return;

    const href = link.getAttribute('href');
    if (!href || href === '#') return;
    const target = href.startsWith('#') ? href : `#${href}`;
    if (location.hash === target) return;

    beginNavTransition();
  }

  function moveNavbar(verticalNavbar, targetParent) {
    if (!verticalNavbar || !targetParent) return;
    if (verticalNavbar.parentElement !== targetParent) {
      targetParent.appendChild(verticalNavbar);
    }
  }

  function fixAllNavbars() {
    const verticalNavbars = Array.from(document.querySelectorAll('[class*="vertical-nav-bar"]'));

    verticalNavbars.forEach((verticalNav) => {
      if (!cachedNavbars.has(verticalNav) || !document.body.contains(cachedNavbars.get(verticalNav))) {
        cachedNavbars.set(verticalNav, verticalNav.parentElement);
      }
      const originalParent = cachedNavbars.get(verticalNav);

      const horizontalNav = verticalNav
        .closest('[class*="main-nav-bars-container"], [class*="nav-bars-container"]')
        ?.querySelector('[class*="horizontal-nav-bar"]');
      const horizontalVisible = isNavVisible(horizontalNav);
      const originalVisible = isNavVisible(originalParent);

      if (horizontalVisible && horizontalNav) {
        moveNavbar(verticalNav, horizontalNav);
        // Only restyle vertical tab links — never touch profile/nav-menu <a> icons
        // (Settings / Addons / Help), which live as siblings under horizontal-nav.
        verticalNav.querySelectorAll('a').forEach((link) => {
          if (link.closest('[class*="nav-menu-container"]')) return;
          link.querySelector('svg')?.remove();
          const label = link.querySelector('div');
          if (label) label.className = 'nav-label';
        });
      } else if (!horizontalVisible && originalVisible) {
        moveNavbar(verticalNav, originalParent);
      }
    });

    ensureNavClickable();
    tryEndNavTransition();
  }

  function restoreVerticalNavLayout() {
    cachedNavbars.forEach((originalParent, verticalNav) => {
      if (!verticalNav?.isConnected || !originalParent?.isConnected) return;
      moveNavbar(verticalNav, originalParent);
    });
    cachedNavbars.clear();
  }

  function scheduleFix() {
    if (fixTimer) clearTimeout(fixTimer);
    fixTimer = setTimeout(() => {
      fixTimer = null;
      fixAllNavbars();
    }, 80);
  }

  function fixNavOnRouteChange() {
    beginNavTransition();
    fixAllNavbars();
    requestAnimationFrame(fixAllNavbars);
    requestAnimationFrame(() => requestAnimationFrame(fixAllNavbars));
  }

  function bindNavClickCapture() {
    if (navClickCaptureBound) return;
    document.addEventListener('click', onNavLinkClick, true);
    navClickCaptureBound = true;
  }

  function unbindNavClickCapture() {
    if (!navClickCaptureBound) return;
    document.removeEventListener('click', onNavLinkClick, true);
    navClickCaptureBound = false;
  }

  function start() {
    ensureTransitionStyles();
    ensureNavFocusStyles();
    bindNavClickCapture();
    fixAllNavbars();
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (transitionActive && mutations.some((mutation) => mutation.type === 'childList')) {
        fixAllNavbars();
        return;
      }
      scheduleFix();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    window.addEventListener('resize', scheduleFix, { passive: true });
    window.addEventListener('hashchange', fixNavOnRouteChange);
    window.addEventListener('hashchange', ensureNavClickable);
  }

  function stop() {
    if (fixTimer) {
      clearTimeout(fixTimer);
      fixTimer = null;
    }
    endNavTransition();
    observer?.disconnect();
    observer = null;
    unbindNavClickCapture();
    window.removeEventListener('resize', scheduleFix);
    restoreVerticalNavLayout();
  }

  window.__stremioCustomLiquidGlassNavStart = start;
  window.__stremioCustomLiquidGlassNavStop = stop;

  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    const theme = window.StremioCustom?.helpers?.getCurrentTheme?.() || '';
    if (theme === 'liquid-glass.theme.css') {
      start();
    }
  });
})();
