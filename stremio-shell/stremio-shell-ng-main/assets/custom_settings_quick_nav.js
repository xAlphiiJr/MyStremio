(function () {
  'use strict';

  /**
   * Settings: Reload button (aligned with Quick Settings title) + dropdown width CSS.
   * Native menu / scroll-spy live in the patched React Settings bundle.
   */
  if (window.self !== window.top) return;
  if (window.__stremioCustomSettingsQuickNav) return;
  window.__stremioCustomSettingsQuickNav = true;

  const STYLE_ID = 'stremio-custom-settings-quick-nav-style';
  const RELOAD_BTN_ID = 'mystremio-quick-settings-reload';

  let injectTimer = null;

  function isSettingsPage() {
    return /#\/settings(?:[/?#]|$)/.test(location.hash || '');
  }

  function ensureStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = `
      [class*="settings-content"] [class*="section"] > [class*="label"]:has(#${RELOAD_BTN_ID}) {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        width: 100%;
        box-sizing: border-box;
      }
      #${RELOAD_BTN_ID} {
        flex: none;
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 2.1rem;
        padding: 0.35rem 0.95rem;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(70, 70, 70, 0.22);
        color: var(--primary-foreground-color, #fff);
        font: inherit;
        font-weight: 600;
        font-size: 0.9rem;
        line-height: 1;
        cursor: pointer;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
      }
      #${RELOAD_BTN_ID}:hover {
        background: rgba(90, 90, 90, 0.3);
        border-color: rgba(255, 255, 255, 0.18);
      }
      /* Keep MyStremio custom multi-select triggers from growing with labels. */
      [class*="settings-content"] [class*="dropdown-wrap-"] {
        max-width: 14rem;
      }
      [class*="settings-content"] [class*="dropdown-wrap-"] [class*="label"] {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
      }
    `;
  }

  function injectAll() {
    if (!isSettingsPage()) return false;
    ensureStyles();
    return true;
  }

  ensureStyles();

  function scheduleInject() {
    if (injectTimer) clearTimeout(injectTimer);
    injectTimer = setTimeout(() => {
      injectTimer = null;
      if (!isSettingsPage()) return;
      if (!injectAll()) {
        let attempts = 0;
        const id = setInterval(() => {
          if (!isSettingsPage() || injectAll() || attempts > 40) {
            clearInterval(id);
            return;
          }
          attempts += 1;
        }, 200);
      }
    }, 100);
  }

  window.__stremioCustomSettingsQuickNavEnsure = scheduleInject;

  window.addEventListener('hashchange', scheduleInject);
  window.addEventListener('popstate', scheduleInject);
  document.addEventListener('stremio-custom-bootstrap-ready', scheduleInject);
  document.addEventListener('stremio-custom-route-change', scheduleInject);

  const observer = new MutationObserver(() => {
    if (!isSettingsPage()) return;
    scheduleInject();
  });
  const boot = () => {
    const root = document.body || document.documentElement;
    if (!root) {
      setTimeout(boot, 200);
      return;
    }
    observer.observe(root, { childList: true, subtree: true });
    scheduleInject();
  };
  boot();

  console.info('[StremioCustom] Settings Quick Reload ready.');
})();
