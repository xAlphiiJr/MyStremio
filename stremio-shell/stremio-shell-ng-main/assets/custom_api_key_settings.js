(function () {
  'use strict';

  if (window.__stremioCustomApiKeySettings) return;
  window.__stremioCustomApiKeySettings = true;

  const STYLE_ID = 'stremio-api-key-settings-style';
  const ROW_BOUND_ATTR = 'data-api-key-row-bound';

  const KEY_HINTS = [
    { pattern: /tidb/i, key: 'tidb_api_key', base: 'tidb' },
    { pattern: /introdb/i, key: 'introdb_api_key', base: 'tidb' },
    { pattern: /tmdb/i, key: 'tmdbApiKey', base: 'data-enrichment' },
    { pattern: /rpdb/i, key: 'rpdbApiKey', base: 'data-enrichment' },
  ];

  const API_KEY_LINKS = {
    tidb_api_key: 'https://theintrodb.org/docs',
    introdb_api_key: 'https://introdb.app/account',
    tmdbApiKey: 'https://www.themoviedb.org/settings/api',
    rpdbApiKey: 'https://ratingposterdb.com/',
  };

  function api() {
    return window.StremioCustomAPI || window.StremioEnhancedAPI;
  }

  function isApiKeyField(key) {
    const normalized = String(key || '').toLowerCase();
    return normalized.includes('apikey') || normalized.includes('api_key') || normalized.endsWith('token');
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      input::-ms-reveal,
      input::-ms-clear {
        display: none !important;
      }
      .stremio-api-key-input-wrap {
        position: relative;
        width: 100%;
      }
      .stremio-api-key-input-wrap input[class*="plugin-setting-input"] {
        width: 100%;
        padding-right: 3.25rem !important;
      }
      .stremio-api-key-input-wrap input.stremio-api-key-masked {
        -webkit-text-security: disc;
        text-security: disc;
      }
      .stremio-api-key-eye {
        position: absolute;
        right: 0.35rem;
        top: 50%;
        transform: translateY(-50%);
        width: 2.5rem;
        height: 2.5rem;
        padding: 0;
        border: 0;
        background: transparent;
        color: rgba(255, 255, 255, 0.82);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        opacity: 0.88;
        z-index: 5;
        pointer-events: auto;
        touch-action: manipulation;
      }
      .stremio-api-key-eye:hover {
        opacity: 1;
      }
      .stremio-api-key-eye svg {
        width: 1.15rem;
        height: 1.15rem;
        display: block;
        pointer-events: none;
      }
      .stremio-api-key-clear {
        align-self: flex-start;
        margin: -0.15rem 0 0 0.15rem;
        padding: 0.15rem 0;
        border: 0;
        background: transparent;
        color: rgba(255, 255, 255, 0.42);
        font-size: 0.82rem;
        line-height: 1.2;
        cursor: pointer;
        text-decoration: none;
        pointer-events: auto;
        touch-action: manipulation;
      }
      .stremio-api-key-clear:hover {
        color: rgba(255, 255, 255, 0.62);
      }
      .stremio-api-key-link {
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--secondary-accent-color, rgba(120, 180, 255, 0.95));
        font-size: 0.82rem;
        line-height: 1.35rem;
        cursor: pointer;
        text-decoration: underline;
        text-underline-offset: 0.15rem;
        white-space: nowrap;
        flex-shrink: 0;
        pointer-events: auto;
        touch-action: manipulation;
      }
      .stremio-api-key-link:hover {
        opacity: 0.85;
      }
      .stremio-api-key-label-row {
        display: flex !important;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.75rem;
        width: 100%;
      }
      .stremio-api-key-label-row [class*="plugin-setting-label"]:not([class*="row"]) {
        flex: 1;
        min-width: 0;
        line-height: 1.35rem;
        white-space: nowrap;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function eyeOpenSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  }

  function eyeClosedSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/><path d="m4 4 16 16"/></svg>';
  }

  function readLabel(row) {
    const labelEl = row.querySelector('[class*="plugin-setting-label"]:not([class*="row"])');
    return String(labelEl?.textContent || '').trim();
  }

  function resolveFieldMeta(input, row) {
    const base = input.dataset.pluginBase || row.dataset.apiKeyBase;
    const key = input.dataset.settingKey || row.dataset.apiKeySetting;
    if (base && key && isApiKeyField(key)) {
      return { base, key };
    }

    const label = readLabel(row);
    for (const hint of KEY_HINTS) {
      if (hint.pattern.test(label)) {
        return { base: hint.base, key: hint.key };
      }
    }
    return null;
  }

  function getRowParts(row) {
    const wrap = row.querySelector('.stremio-api-key-input-wrap');
    if (!wrap) return null;
    const input = wrap.querySelector('input[class*="plugin-setting-input"]');
    const eyeBtn = wrap.querySelector('.stremio-api-key-eye');
    const clearBtn = row.querySelector('.stremio-api-key-clear');
    if (!input || !eyeBtn) return null;
    return { wrap, input, eyeBtn, clearBtn };
  }

  function isRevealed(wrap) {
    return wrap.dataset.apiKeyRevealed === '1';
  }

  function setRevealed(wrap, revealed) {
    wrap.dataset.apiKeyRevealed = revealed ? '1' : '0';
  }

  function applyMaskState(input, revealed) {
    input.type = 'text';
    input.classList.toggle('stremio-api-key-masked', !revealed);
    input.setAttribute('autocomplete', 'off');
  }

  function syncRowUi(row) {
    const parts = getRowParts(row);
    if (!parts) return;
    const { wrap, input, eyeBtn } = parts;
    const revealed = isRevealed(wrap);
    eyeBtn.innerHTML = revealed ? eyeClosedSvg() : eyeOpenSvg();
    eyeBtn.setAttribute('aria-label', revealed ? 'Hide API key' : 'Show API key');
    applyMaskState(input, revealed);
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function cleanupRow(row) {
    const wraps = row.querySelectorAll('.stremio-api-key-input-wrap');
    wraps.forEach((wrap, index) => {
      if (index > 0) wrap.remove();
    });
    const wrap = row.querySelector('.stremio-api-key-input-wrap');
    if (wrap) {
      wrap.querySelectorAll('.stremio-api-key-eye').forEach((eye, index) => {
        if (index > 0) eye.remove();
      });
    }
    row.querySelectorAll('.stremio-api-key-clear').forEach((clear, index) => {
      if (index > 0) clear.remove();
    });
  }

  function ensureRowStructure(input, row, meta) {
    cleanupRow(row);

    let wrap = input.closest('.stremio-api-key-input-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'stremio-api-key-input-wrap';
      input.parentNode.insertBefore(wrap, input);
    }
    if (input.parentElement !== wrap) {
      wrap.appendChild(input);
    }

    if (!wrap.dataset.apiKeyRevealed) {
      wrap.dataset.apiKeyRevealed = '0';
    }

    if (!wrap.querySelector('.stremio-api-key-eye')) {
      const eyeBtn = document.createElement('button');
      eyeBtn.type = 'button';
      eyeBtn.className = 'stremio-api-key-eye';
      eyeBtn.setAttribute('tabindex', '-1');
      wrap.appendChild(eyeBtn);
    }

    if (!row.querySelector('.stremio-api-key-clear')) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'stremio-api-key-clear';
      clearBtn.textContent = 'Clear';
      clearBtn.setAttribute('tabindex', '-1');
      wrap.insertAdjacentElement('afterend', clearBtn);
    }

    row.dataset.apiKeyBase = meta.base;
    row.dataset.apiKeySetting = meta.key;
  }

  function bindRowEvents(row) {
    if (row.getAttribute(ROW_BOUND_ATTR) === '1') return;
    row.setAttribute(ROW_BOUND_ATTR, '1');

    row.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;

      if (event.target.closest('.stremio-api-key-eye')) {
        event.preventDefault();
        event.stopPropagation();
        const parts = getRowParts(row);
        if (!parts) return;
        setRevealed(parts.wrap, !isRevealed(parts.wrap));
        syncRowUi(row);
        return;
      }

      if (event.target.closest('.stremio-api-key-clear')) {
        event.preventDefault();
        event.stopPropagation();
        const parts = getRowParts(row);
        if (!parts) return;
        const base = row.dataset.apiKeyBase;
        const key = row.dataset.apiKeySetting;
        const client = api();
        Promise.resolve()
          .then(async () => {
            if (client?.saveSetting && base && key) {
              await client.saveSetting(base, key, '');
            }
          })
          .finally(() => {
            const latest = getRowParts(row);
            if (!latest) return;
            setInputValue(latest.input, '');
            setRevealed(latest.wrap, false);
            syncRowUi(row);
          });
      }
    }, true);

    row.addEventListener('input', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.matches('input[class*="plugin-setting-input"]')) return;
      const parts = getRowParts(row);
      if (!parts || parts.input !== target) return;
      target.type = 'text';
      if (!isRevealed(parts.wrap)) {
        target.classList.add('stremio-api-key-masked');
      }
    }, true);
  }

  function findLabelElement(row) {
    return row.querySelector('[class*="plugin-setting-label"]:not([class*="row"])');
  }

  function isLabelRowElement(element) {
    return Boolean(
      element?.className &&
        typeof element.className === 'string' &&
        element.className.includes('plugin-setting-label-row')
    );
  }

  function ensureApiKeyLabelRow(row) {
    const labelEl = findLabelElement(row);
    if (!labelEl) return null;

    labelEl.textContent = 'API Key';

    let labelRow = labelEl.parentElement;
    if (!labelRow) return null;

    if (!isLabelRowElement(labelRow)) {
      const wrapper = document.createElement('div');
      wrapper.className = 'stremio-api-key-label-row';
      labelEl.parentNode.insertBefore(wrapper, labelEl);
      wrapper.appendChild(labelEl);
      labelRow = wrapper;
    } else {
      labelRow.classList.add('stremio-api-key-label-row');
    }

    const nativeLink = row.querySelector('[class*="api-key-link"]');
    if (nativeLink && nativeLink.parentElement !== labelRow) {
      labelRow.appendChild(nativeLink);
    }

    const customLink = row.querySelector('.stremio-api-key-link');
    if (customLink && customLink.parentElement !== labelRow) {
      labelRow.appendChild(customLink);
    }

    return labelRow;
  }

  function findLabelRow(row) {
    return ensureApiKeyLabelRow(row) || row.querySelector('[class*="plugin-setting-label-row"]');
  }

  function hasNativeApiKeyLink(row) {
    return Boolean(row.querySelector('[class*="api-key-link"]'));
  }

  /**
   * Add a "Get API Key" link when the native settings UI did not render one.
   *
   * @param {Element} row Plugin setting row.
   * @param {{ base: string, key: string }} meta Resolved API key field metadata.
   */
  function ensureApiKeyLink(row, meta) {
    const url = API_KEY_LINKS[meta.key];
    if (!url) return;

    const labelRow = ensureApiKeyLabelRow(row);
    if (!labelRow) return;

    if (hasNativeApiKeyLink(row) || labelRow.querySelector('.stremio-api-key-link')) {
      return;
    }

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'stremio-api-key-link';
    link.textContent = 'Get API Key';
    link.setAttribute('aria-label', 'Get API Key');
    link.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const client = api();
      if (client?.openExternalUrl) {
        client.openExternalUrl(url).catch(() => {
          window.open(url, '_blank', 'noopener,noreferrer');
        });
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    }, true);

    labelRow.appendChild(link);
  }

  function enhanceRow(input) {
    const row = input.closest('[class*="plugin-setting-row-stacked"], [class*="plugin-setting-option"]');
    if (!row) return;

    const meta = resolveFieldMeta(input, row);
    if (!meta) return;

    injectStyles();
    ensureRowStructure(input, row, meta);
    ensureApiKeyLabelRow(row);
    ensureApiKeyLink(row, meta);
    bindRowEvents(row);
    syncRowUi(row);
  }

  function scan() {
    injectStyles();
    document.querySelectorAll('input[class*="plugin-setting-input"]').forEach((input) => {
      const row = input.closest('[class*="plugin-setting-row-stacked"], [class*="plugin-setting-option"]');
      if (!row) return;
      if (!resolveFieldMeta(input, row)) return;
      enhanceRow(input);
    });
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 120);
  }

  const observer = new MutationObserver(scheduleScan);
  function startObserver() {
    if (!document.body) return;
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleScan();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else {
    startObserver();
  }

  window.__stremioCustomApiKeySettingsEnsure = scheduleScan;
})();
