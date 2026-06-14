(function () {
  'use strict';

  if (window.__stremioCustomCinebyeAddons) return;
  window.__stremioCustomCinebyeAddons = true;

  const CINEBYE_BASE = 'https://cinebye.elfhosted.com/';
  const BUTTON_ID = 'stremio-custom-cinebye-addons-btn';
  const OVERLAY_ID = 'stremio-custom-cinebye-overlay';
  const STYLE_ID = 'stremio-custom-cinebye-addons-style';

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 2.35rem;
        padding: 0.45rem 1rem;
        margin-right: 0.5rem;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(70, 70, 70, 0.22);
        color: var(--primary-foreground-color, #fff);
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
        backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
        -webkit-backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
      }
      #${BUTTON_ID}:hover {
        background: rgba(90, 90, 90, 0.3);
        border-color: rgba(255, 255, 255, 0.16);
      }
      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147482500;
        background: rgba(0, 0, 0, 0.72);
        backdrop-filter: blur(14px) saturate(140%);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        display: flex;
        flex-direction: column;
      }
      #${OVERLAY_ID} .sc-cinebye-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.85rem 1rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(24, 24, 24, 0.88);
      }
      #${OVERLAY_ID} .sc-cinebye-title {
        color: #fff;
        font-size: 1rem;
        font-weight: 600;
      }
      #${OVERLAY_ID} .sc-cinebye-close {
        width: 2.4rem;
        height: 2.4rem;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(70, 70, 70, 0.22);
        color: #fff;
        font-size: 1.35rem;
        line-height: 1;
        cursor: pointer;
      }
      #${OVERLAY_ID} .sc-cinebye-frame {
        flex: 1 1 auto;
        width: 100%;
        border: 0;
        background: #111;
      }
      #${OVERLAY_ID} .sc-cinebye-fallback {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2rem;
        color: rgba(255, 255, 255, 0.8);
        text-align: center;
        line-height: 1.5;
      }
    `;
    document.head.appendChild(style);
  }

  async function getStremioAuthKey() {
    try {
      if (window.core?.getState) {
        const ctx = await window.core.getState('ctx');
        return ctx?.auth?.key || ctx?.profile?.auth?.key || null;
      }
    } catch (_) {}
    try {
      const profile = JSON.parse(localStorage.getItem('profile') || '{}');
      return profile?.auth?.key || null;
    } catch (_) {}
    return null;
  }

  async function buildCinebyeUrl() {
    const authKey = await getStremioAuthKey();
    if (!authKey) return CINEBYE_BASE;
    try {
      const url = new URL(CINEBYE_BASE);
      url.searchParams.set('authkey', authKey);
      return url.toString();
    } catch (_) {
      return CINEBYE_BASE;
    }
  }

  function closeOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
  }

  async function openCinebyeInApp() {
    if (document.getElementById(OVERLAY_ID)) return;
    ensureStyles();

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;

    const top = document.createElement('div');
    top.className = 'sc-cinebye-top';

    const title = document.createElement('div');
    title.className = 'sc-cinebye-title';
    title.textContent = 'Cinebye Addon Manager';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'sc-cinebye-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeOverlay);

    top.append(title, closeBtn);

    const frame = document.createElement('iframe');
    frame.className = 'sc-cinebye-frame';
    frame.referrerPolicy = 'no-referrer-when-downgrade';
    frame.allow = 'clipboard-read; clipboard-write';
    frame.src = await buildCinebyeUrl();

    let blocked = false;
    frame.addEventListener('error', () => {
      blocked = true;
    });

    window.setTimeout(() => {
      if (blocked) return;
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
      } catch (_) {
        return;
      }
    }, 2500);

    overlay.append(top, frame);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeOverlay();
    });

    document.body.appendChild(overlay);
  }

  function isAddonsPage() {
    return /#\/addons(?:[/?#]|$)/.test(location.hash || '');
  }

  function injectAddonsButton() {
    if (!isAddonsPage()) return;

    const inputsContainer = document.querySelector('[class*="selectable-inputs-container"]');
    const spacingDiv =
      inputsContainer?.querySelector('[class*="spacing"]') ||
      document.querySelector('[class*="addons-list-container"] [class*="spacing"]');
    if (!spacingDiv) return;

    let button = document.getElementById(BUTTON_ID);
    if (!button) {
      button = document.createElement('button');
      button.id = BUTTON_ID;
      button.type = 'button';
      button.textContent = 'Addon Manager';
      button.title = 'Open Cinebye addon manager';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openCinebyeInApp();
      });
    }

    spacingDiv.style.pointerEvents = 'auto';
    spacingDiv.style.display = 'flex';
    spacingDiv.style.alignItems = 'center';
    spacingDiv.style.justifyContent = 'flex-end';

    if (!spacingDiv.contains(button)) {
      spacingDiv.insertBefore(button, spacingDiv.firstChild);
    }
  }

  function scheduleInject() {
    if (!isAddonsPage()) {
      closeOverlay();
      return;
    }
    injectAddonsButton();
  }

  ensureStyles();
  window.addEventListener('hashchange', scheduleInject);
  const observer = new MutationObserver(() => scheduleInject());
  const observeTarget = () => {
    const root = document.body || document.documentElement;
    if (!root) {
      window.setTimeout(observeTarget, 200);
      return;
    }
    observer.observe(root, { childList: true, subtree: true });
    scheduleInject();
  };
  observeTarget();

  window.StremioCustomCinebyeAddons = {
    openCinebyeInApp,
    closeOverlay,
    buildCinebyeUrl,
  };
})();
