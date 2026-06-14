(function () {
  'use strict';

  if (window.__stremioCustomLiquidGlassNav) return;
  window.__stremioCustomLiquidGlassNav = true;

  const cachedNavbars = new Map();
  let fixTimer = null;
  let observer = null;

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
      const href = link.getAttribute('href');
      if (!href || href === '#') return;
      link.style.pointerEvents = 'auto';
      link.style.cursor = 'pointer';
      link.addEventListener(
        'click',
        (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          navigateToHash(href);
        },
        true
      );
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

  function moveNavbar(verticalNavbar, targetParent) {
    if (!verticalNavbar || !targetParent) return;
    if (verticalNavbar.parentElement !== targetParent) {
      verticalNavbar.style.visibility = 'hidden';
      targetParent.appendChild(verticalNavbar);
      verticalNavbar.style.visibility = 'visible';
    }
  }

  function fixAllNavbars() {
    const verticalNavbars = Array.from(document.querySelectorAll('[class*="vertical-nav-bar"]'));

    verticalNavbars.forEach((verticalNav) => {
      if (!cachedNavbars.has(verticalNav) || !document.body.contains(cachedNavbars.get(verticalNav))) {
        cachedNavbars.set(verticalNav, verticalNav.parentElement);
      }
      const originalParent = cachedNavbars.get(verticalNav);

      const horizontalNav = verticalNav.closest('div')?.querySelector('[class*="horizontal-nav-bar"]');
      const horizontalVisible = horizontalNav?.offsetParent !== null;
      const originalVisible = originalParent?.offsetParent !== null;

      if (horizontalVisible && horizontalNav) {
        moveNavbar(verticalNav, horizontalNav);
        horizontalNav.querySelectorAll('a').forEach((link) => {
          link.querySelector('svg')?.remove();
          const label = link.querySelector('div');
          if (label) label.className = 'nav-label';
        });
      } else if (!horizontalVisible && originalVisible) {
        moveNavbar(verticalNav, originalParent);
      }
    });

    ensureNavClickable();
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

  function start() {
    fixAllNavbars();
    if (observer) return;
    observer = new MutationObserver(scheduleFix);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    window.addEventListener('resize', scheduleFix, { passive: true });
    window.addEventListener('hashchange', scheduleFix);
    window.addEventListener('hashchange', ensureNavClickable);
  }

  function stop() {
    if (fixTimer) {
      clearTimeout(fixTimer);
      fixTimer = null;
    }
    observer?.disconnect();
    observer = null;
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
