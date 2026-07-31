(function () {
  'use strict';

  /**
   * Runs before bundled main.js. Desktop shell serves the UI locally; the PWA
   * service worker only causes stale main.js after updates and provokes hero crashes.
   */
  if (window.__stremioCustomPreboot) return;
  window.__stremioCustomPreboot = true;

  const HERO_CACHE_KEY = 'mystremio_hero_titles_v1';
  const RELOAD_GUARD_KEY = 'mystremio_hero_crash_reload_v1';

  function sanitizeHeroCache() {
    try {
      const raw = localStorage.getItem(HERO_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        localStorage.removeItem(HERO_CACHE_KEY);
        return;
      }
      const valid = parsed.filter(
        (item) =>
          item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          item.id.length > 0 &&
          item.id !== 'tt0903747'
      );
      if (!valid.length || valid.length !== parsed.length) {
        if (valid.length) localStorage.setItem(HERO_CACHE_KEY, JSON.stringify(valid));
        else localStorage.removeItem(HERO_CACHE_KEY);
      }
    } catch (_) {
      localStorage.removeItem(HERO_CACHE_KEY);
    }
  }

  function disableServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const blocked = function () {
      console.info('[StremioCustom] Service worker registration blocked (desktop shell)');
      return Promise.resolve({
        unregister: () => Promise.resolve(true),
        update: () => Promise.resolve(),
        active: null,
        installing: null,
        waiting: null,
        addEventListener: () => {},
        removeEventListener: () => {},
      });
    };
    try {
      navigator.serviceWorker.register = blocked;
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((registration) => registration.unregister());
      }).catch(() => {});
    } catch (_) {}
    if (window.caches && typeof caches.keys === 'function') {
      caches.keys().then((keys) => keys.forEach((key) => caches.delete(key))).catch(() => {});
    }
  }

  function installCrashRecovery() {
    if (window.__stremioCustomPrebootCrashHook) return;
    window.__stremioCustomPrebootCrashHook = true;

    window.addEventListener('error', (event) => {
      const message = String(event?.message || '');
      if (!/reading 'year'|DynamicHero/i.test(message)) return;
      try {
        localStorage.removeItem(HERO_CACHE_KEY);
        if (sessionStorage.getItem(RELOAD_GUARD_KEY) === '1') return;
        sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
        console.warn('[StremioCustom] Hero crash detected, clearing cache and reloading once');
        window.location.reload();
      } catch (_) {}
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = String(event?.reason?.message || event?.reason || '');
      if (!/reading 'year'|DynamicHero/i.test(reason)) return;
      try {
        localStorage.removeItem(HERO_CACHE_KEY);
        if (sessionStorage.getItem(RELOAD_GUARD_KEY) === '1') return;
        sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
        console.warn('[StremioCustom] Hero promise rejection, clearing cache and reloading once');
        window.location.reload();
      } catch (_) {}
    });
  }

  /**
   * BAD cold-start path: WebView2 restores #/player → board paints under splash
   * (bottom banner strip) and plugin unload/reload races. Force #/board before
   * React/HashRouter boots so every launch takes the GOOD path.
   */
  function forceBoardHashBeforeReact() {
    try {
      const hash = location.hash || '';
      if (!/#\/player(?:\/|$|\?|#)/.test(hash)) return;
      const target =
        (location.pathname || '/index.html') + (location.search || '') + '#/board';
      history.replaceState(null, '', target);
      console.info('[StremioCustom] Preboot: cleared stale #/player → #/board');
    } catch (_) {}
  }

  /**
   * Full-viewport seal so board posters cannot paint through gaps in the native
   * splash (or before plugins finish). Once removed (splash safety / bootstrap
   * ready), never recreate — that caused permanent black screens after start #3.
   */
  function ensureBootSeal() {
    try {
      if (window.__stremioCustomBootSealRetired) return;
      document.documentElement.classList.add('mystremio-booting');
      let seal = document.getElementById('mystremio-boot-seal');
      if (!seal) {
        seal = document.createElement('div');
        seal.id = 'mystremio-boot-seal';
        seal.setAttribute('aria-hidden', 'true');
        seal.style.cssText =
          'position:fixed;inset:0;z-index:2147483647;background:rgb(20,20,20);' +
          'pointer-events:all;opacity:1;display:block;';
        (document.documentElement || document.body).appendChild(seal);
      }
      if (!document.getElementById('mystremio-boot-seal-style')) {
        const style = document.createElement('style');
        style.id = 'mystremio-boot-seal-style';
        style.textContent =
          'html.mystremio-booting #app,html.mystremio-booting #root{' +
          'visibility:hidden!important;}' +
          '#mystremio-boot-seal{position:fixed!important;inset:0!important;' +
          'z-index:2147483647!important;background:rgb(20,20,20)!important;' +
          'pointer-events:all!important;opacity:1!important;display:block!important;}';
        (document.head || document.documentElement).appendChild(style);
      }
      window.__stremioCustomBootSealActive = true;
    } catch (_) {}
  }

  window.__stremioCustomEnsureBootSeal = ensureBootSeal;
  window.__stremioCustomRemoveBootSeal = function () {
    try {
      window.__stremioCustomBootSealRetired = true;
      document.documentElement.classList.remove('mystremio-booting');
      document.getElementById('mystremio-boot-seal')?.remove();
      document.getElementById('mystremio-boot-seal-style')?.remove();
      window.__stremioCustomBootSealActive = false;
    } catch (_) {}
  };

  forceBoardHashBeforeReact();
  ensureBootSeal();
  sanitizeHeroCache();
  disableServiceWorker();
  installCrashRecovery();
  window.__MYSTREMIO_REACT_HERO__ = true;
})();
