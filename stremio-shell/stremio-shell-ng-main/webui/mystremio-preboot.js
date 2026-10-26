(function () {
  'use strict';

  /**
   * Runs before bundled main.js. Desktop shell serves the UI locally; the PWA
   * service worker only causes stale main.js after updates and provokes hero crashes.
   */
  if (window.__stremioCustomPreboot) return;
  window.__stremioCustomPreboot = true;

  if (!document.getElementById('mystremio-critical-theme')) {
    const critical = document.createElement('style');
    critical.id = 'mystremio-critical-theme';
    critical.textContent =
      'html,body,#root,#app{background:rgb(20,20,20)!important;color:#fff!important;}' +
      'a,a:visited,a:hover,a:active{color:#fff!important;}' +
      ':root{--primary-accent-color:#fff!important;--primary-foreground-color:#fff!important;' +
      '--background:rgb(20,20,20)!important;}' +
      '[class*="settings-content"] [class*="section"]>[class*="label"]:has(#mystremio-quick-settings-reload){' +
      'display:flex!important;align-items:center!important;justify-content:space-between!important;' +
      'gap:1rem!important;width:100%!important;box-sizing:border-box!important;}' +
      '#mystremio-quick-settings-reload{flex:none!important;margin-left:auto!important;display:inline-flex!important;' +
      'align-items:center!important;justify-content:center!important;min-height:2.1rem!important;' +
      'padding:0.35rem 0.95rem!important;border-radius:999px!important;border:1px solid rgba(255,255,255,0.12)!important;' +
      'background:rgba(70,70,70,0.22)!important;color:#fff!important;font:inherit!important;font-weight:600!important;' +
      'font-size:0.9rem!important;line-height:1!important;cursor:pointer!important;}';
    (document.documentElement || document.head).appendChild(critical);
  }

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
   * (bottom banner strip) and plugin unload/reload races. Force `#/` (Board
   * route path:"/") before React/HashRouter boots — never `#/board` (NotFound).
   */
  function forceBoardHashBeforeReact() {
    try {
      const hash = location.hash || '';
      if (!/#\/player(?:\/|$|\?|#)/.test(hash)) return;
      const target =
        (location.pathname || '/index.html') + (location.search || '') + '#/';
      history.replaceState(null, '', target);
      console.info('[StremioCustom] Preboot: cleared stale #/player → #/');
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
          'html.mystremio-booting #app,html.mystremio-booting #root,' +
          'html.mystremio-booting [class*="hero-slot"]{' +
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
      if (!document.getElementById('stremio-custom-active-theme')) return;
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
