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
  const SECTION_ATTR = 'data-mystremio-quick-section';
  const HEADER_ATTR = 'data-mystremio-quick-header';

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
      [${HEADER_ATTR}="1"] {
        position: relative;
        display: block;
        width: 100%;
        /* Reserve space so absolute Reload does not collide with the title. */
        padding-right: 5.5rem;
        box-sizing: border-box;
      }
      [${HEADER_ATTR}="1"] > [class*="label"] {
        display: block;
        width: 100%;
      }
      #${RELOAD_BTN_ID} {
        position: absolute;
        right: 0;
        top: 0;
        z-index: 2;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 2.1rem;
        padding: 0.35rem 0.95rem;
        margin: 0;
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
        backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
        -webkit-backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
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

  function findSectionsContainer() {
    return (
      document.querySelector('[class*="settings-content"] [class*="sections-container"]') ||
      document.querySelector('[class*="sections-container"]')
    );
  }

  function findSectionTitle(section) {
    const children = Array.from(section.children || []);
    for (const child of children) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.id === RELOAD_BTN_ID || child.hasAttribute(HEADER_ATTR)) continue;
      const text = (child.textContent || '').trim();
      if (/^quick settings$/i.test(text) && child.children.length === 0) {
        return child;
      }
      if (/(^|\s)label(\s|$)/i.test(child.className) && /^quick settings$/i.test(text)) {
        return child;
      }
    }
    const labeled = section.querySelector('[class*="label"]');
    if (labeled && /^quick settings$/i.test((labeled.textContent || '').trim())) {
      return labeled;
    }
    return null;
  }

  function findQuickSettingsSection() {
    const tagged = document.querySelector(`[${SECTION_ATTR}="1"]`);
    if (tagged) return tagged;

    const container = findSectionsContainer();
    if (!container) return null;

    const sections = container.querySelectorAll('[class*="section"]');
    for (const section of sections) {
      const label = findSectionTitle(section);
      if (label) {
        section.setAttribute(SECTION_ATTR, '1');
        return section;
      }
    }
    return null;
  }

  function ensureHeaderRow(section, label) {
    if (label.parentElement?.hasAttribute(HEADER_ATTR)) {
      return label.parentElement;
    }

    const header = document.createElement('div');
    header.setAttribute(HEADER_ATTR, '1');
    label.parentNode.insertBefore(header, label);
    header.appendChild(label);
    return header;
  }

  /** Vertical center of the painted title glyphs (not the line-box). */
  function getTitleGlyphCenterY(label, header) {
    try {
      const range = document.createRange();
      const textNode = [...label.childNodes].find(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim()
      );
      if (textNode) {
        range.selectNodeContents(textNode);
      } else {
        range.selectNodeContents(label);
      }
      const rects = range.getClientRects();
      const textRect = rects.length ? rects[0] : range.getBoundingClientRect();
      if (textRect && textRect.height > 0) {
        const headerRect = header.getBoundingClientRect();
        return textRect.top - headerRect.top + textRect.height / 2;
      }
    } catch (_) {
      /* fall through */
    }
    const style = window.getComputedStyle(label);
    const fontSize = parseFloat(style.fontSize) || 16;
    let lineHeight = parseFloat(style.lineHeight);
    if (!Number.isFinite(lineHeight)) lineHeight = fontSize * 1.2;
    const halfLeading = Math.max(0, (lineHeight - fontSize) / 2);
    return label.offsetTop + halfLeading + fontSize / 2;
  }

  function alignReloadToTitle(header, label, reload) {
    const centerY = getTitleGlyphCenterY(label, header);
    const btnH = reload.offsetHeight || 34;
    const top = Math.max(0, centerY - btnH / 2);
    reload.style.top = `${top}px`;
  }

  function injectReloadButton() {
    const section = findQuickSettingsSection();
    if (!section) return false;

    const label = findSectionTitle(section);
    if (!label) return false;

    const header = ensureHeaderRow(section, label);

    let reload = document.getElementById(RELOAD_BTN_ID);
    if (!reload) {
      reload = document.createElement('button');
      reload.id = RELOAD_BTN_ID;
      reload.type = 'button';
      reload.textContent = 'Reload';
      reload.title = 'Reload MyStremio';
      reload.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        location.reload();
      });
    }

    if (!header.contains(reload)) {
      header.appendChild(reload);
    }

    // Layout must settle before measuring glyph bounds.
    requestAnimationFrame(() => alignReloadToTitle(header, label, reload));
    return true;
  }

  function injectAll() {
    if (!isSettingsPage()) return false;
    ensureStyles();
    return injectReloadButton();
  }

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
