/**
 * Replaces per-plugin API key inputs with Set/Missing status pointing at the central hub.
 */
(function () {
  'use strict';

  if (window.__stremioCustomApiKeySettings) return;
  window.__stremioCustomApiKeySettings = true;

  const STYLE_ID = 'stremio-api-key-settings-style';
  const STATUS_ATTR = 'data-api-key-status';

  const KEY_HINTS = [
    { pattern: /theintrodb|\btidb\b/i, key: 'tidb_api_key', base: 'tidb' },
    { pattern: /introdb/i, key: 'introdb_api_key', base: 'tidb' },
    { pattern: /rpdb/i, key: 'rpdbApiKey', base: 'data-enrichment' },
    { pattern: /tmdb/i, key: 'tmdbApiKey', base: 'data-enrichment' },
    { pattern: /mdblist/i, key: 'mdblistApiKey', base: 'data-enrichment' },
  ];

  function api() {
    return window.StremioCustomAPI || window.StremioEnhancedAPI;
  }

  function isApiKeyField(key) {
    const normalized = String(key || '').toLowerCase();
    return (
      normalized.includes('apikey') ||
      normalized.includes('api_key') ||
      normalized.ends_with('token')
    );
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .stremio-api-key-status-row {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 0.75rem;
        padding: 0.35rem 0;
      }
      .stremio-api-key-status-meta {
        display: inline-flex;
        align-items: center;
        gap: 0.55rem;
      }
      .stremio-api-key-status-pill {
        font-size: 0.74rem;
        font-weight: 650;
        padding: 0.15rem 0.5rem;
        border-radius: 999px;
      }
      .stremio-api-key-status-pill.is-set {
        background: rgba(90, 200, 120, 0.22);
        color: rgba(170, 235, 190, 0.95);
      }
      .stremio-api-key-status-pill.is-missing {
        background: rgba(255, 180, 70, 0.22);
        color: rgba(255, 210, 140, 0.95);
      }
      .stremio-api-key-status-link {
        font-size: 0.74rem;
        color: rgba(130, 190, 255, 0.95);
        background: transparent;
        border: 0;
        padding: 0;
        cursor: pointer;
        text-decoration: none;
      }
      .stremio-api-key-status-link:hover {
        text-decoration: underline;
      }
      /* Hide native key inputs once converted */
      [data-api-key-status="1"] input[class*="plugin-setting-input"],
      [data-api-key-status="1"] .stremio-api-key-input-wrap,
      [data-api-key-status="1"] [class*="api-key-link"] {
        display: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function readLabel(row) {
    const labelEl =
      row.querySelector('[class*="plugin-setting-label"]:not([class*="row"])') ||
      row.querySelector('[class*="label-"]');
    return String(labelEl?.textContent || '').trim();
  }

  function resolvePluginBaseFromCard(row) {
    const card = row.closest(
      '[class*="plugin-block"], [class*="plugin-card"], [class*="plugin-item"], [data-plugin-base], [data-plugin-id]'
    );
    const fromAttr =
      card?.getAttribute('data-plugin-base') ||
      card?.getAttribute('data-plugin-id') ||
      row.dataset.pluginBase ||
      '';
    if (fromAttr) return fromAttr;

    const name =
      card?.querySelector('[class*="plugin-name"]')?.textContent ||
      card?.querySelector('[class*="plugin-title"]')?.textContent ||
      '';
    const normalized = String(name).toLowerCase();
    if (/cast\s*overlay/.test(normalized)) return 'cast-overlay';
    if (/data\s*enrichment/.test(normalized)) return 'data-enrichment';
    if (/intro\s*skip|tidb/.test(normalized)) return 'tidb';
    if (/meta\s*hover/.test(normalized)) return 'meta-hover-panel';
    return null;
  }

  function resolveFieldMeta(input, row) {
    const base = input.dataset.pluginBase || row.dataset.apiKeyBase;
    const key = input.dataset.settingKey || row.dataset.apiKeySetting;
    if (base && key && isApiKeyField(key)) {
      return { base, key };
    }

    const label = readLabel(row);
    const cardBase = resolvePluginBaseFromCard(row);
    for (const hint of KEY_HINTS) {
      if (hint.pattern.test(label)) {
        return { base: cardBase || hint.base, key: hint.key };
      }
    }

    if (cardBase && /api\s*key/i.test(label)) {
      if (cardBase === 'cast-overlay' || cardBase === 'data-enrichment' || cardBase === 'meta-hover-panel') {
        return { base: cardBase, key: 'tmdbApiKey' };
      }
      if (cardBase === 'tidb') {
        if (/introdb/i.test(label) && !/theintrodb|tidb/i.test(label)) {
          return { base: cardBase, key: 'introdb_api_key' };
        }
        return { base: cardBase, key: 'tidb_api_key' };
      }
    }
    return null;
  }

  /**
   * Scrolls to / expands the central API Keys hub Category.
   * @returns {void}
   */
  function openApiKeysHub() {
    try {
      document.dispatchEvent(new CustomEvent('mystremio-open-api-keys-hub'));
    } catch (_) {}
  }

  /**
   * Status row only: Set/Missing pill + Open API Keys (native Option title stays).
   * @param {HTMLElement} row
   * @param {{ isSet: boolean }} status
   * @returns {void}
   */
  function applyStatusUi(row, status) {
    injectStyles();
    row.dataset.apiKeyStatus = '1';

    let statusRoot = row.querySelector('.stremio-api-key-status-row');
    if (!statusRoot) {
      statusRoot = document.createElement('div');
      statusRoot.className = 'stremio-api-key-status-row';
      row.appendChild(statusRoot);
    }

    statusRoot.innerHTML = '';

    const meta = document.createElement('div');
    meta.className = 'stremio-api-key-status-meta';

    const pill = document.createElement('span');
    pill.className =
      'stremio-api-key-status-pill ' + (status.isSet ? 'is-set' : 'is-missing');
    pill.textContent = status.isSet ? 'Set' : 'Missing';
    meta.appendChild(pill);

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'stremio-api-key-status-link';
    link.textContent = 'Open API Keys';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openApiKeysHub();
    });
    meta.appendChild(link);
    statusRoot.appendChild(meta);
  }

  async function convertRow(input) {
    if (!(input instanceof HTMLInputElement)) return;
    if (!input.matches('input[class*="plugin-setting-input"]')) return;

    const row =
      input.closest('[class*="plugin-setting-row-stacked"], [class*="plugin-setting-option"], [class*="plugin-setting-row"]') ||
      input.parentElement;
    if (!row || row.dataset.apiKeyStatus === '1') return;

    const meta = resolveFieldMeta(input, row);
    if (!meta || !isApiKeyField(meta.key)) return;

    row.dataset.apiKeyBase = meta.base || '';
    row.dataset.apiKeySetting = meta.key;

    const client = api();
    let isSet = Boolean(String(input.value || '').trim());

    try {
      if (client?.getPluginApiKeyStatus && meta.base) {
        const rows = await client.getPluginApiKeyStatus(meta.base);
        if (Array.isArray(rows)) {
          const match = rows.find((item) => item.fieldKey === meta.key) || rows[0];
          if (match) {
            isSet = Boolean(match.isSet);
          }
        }
      } else if (client?.getSetting && meta.base) {
        const value = await client.getSetting(meta.base, meta.key);
        isSet = Boolean(value && String(value).trim());
      }
    } catch (_) {}

    applyStatusUi(row, { isSet });
  }

  function scan() {
    document.querySelectorAll('input[class*="plugin-setting-input"]').forEach((input) => {
      convertRow(input).catch(() => {});
    });
  }

  injectStyles();
  scan();

  const observer = new MutationObserver(() => scan());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('mystremio-api-keys-changed', () => {
    document.querySelectorAll('[data-api-key-status="1"]').forEach((row) => {
      delete row.dataset.apiKeyStatus;
      row.querySelector('.stremio-api-key-status-row')?.remove();
    });
    scan();
  });

  console.info('[StremioCustom] API key status bridge ready.');
})();
