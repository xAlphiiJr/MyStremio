(function () {
  'use strict';

  if (window.__stremioCustomMarketplace) return;
  window.__stremioCustomMarketplace = true;

  const REGISTRY_SUBMIT_URL =
    'https://github.com/REVENGE977/stremio-enhanced-registry/issues/new';
  const CINEBYE_URL = 'https://cinebye.elfhosted.com/';
  const OVERLAY_ID = 'stremio-custom-marketplace';
  const STYLE_ID = 'stremio-custom-marketplace-style-v5';

  const PUZZLE_ICON_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-2 .9-2 2v3.8h1.5c1.5 0 2.7 1.2 2.7 2.7S5 16.2 3.5 16.2H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.5 1.2-2.7 2.7-2.7s2.7 1.2 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11Z"/></svg>';

  function api() {
    return window.StremioCustomAPI;
  }

  function helpers() {
    return window.StremioCustom?.helpers || {};
  }

  function pluginsApi() {
    return window.StremioCustom?.plugins || {};
  }

  function themeApi() {
    return window.StremioCustom?.theme || {};
  }

  function basename(fileRef) {
    const normalized = String(fileRef || '').replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || normalized;
  }

  function ensureStyles() {
    document.getElementById('stremio-custom-marketplace-style')?.remove();
    document.getElementById('stremio-custom-marketplace-style-v2')?.remove();
    document.getElementById('stremio-custom-marketplace-style-v3')?.remove();
    document.getElementById('stremio-custom-marketplace-style-v4')?.remove();
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
    #${OVERLAY_ID} { position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,0.62); backdrop-filter: blur(14px) saturate(140%); -webkit-backdrop-filter: blur(14px) saturate(140%); display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
    #${OVERLAY_ID} .sc-marketplace-panel { width: min(940px,100%); max-height: min(90vh,920px); background: rgba(24,24,24,0.88); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; box-shadow: 0 24px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08); backdrop-filter: blur(24px) saturate(180%); -webkit-backdrop-filter: blur(24px) saturate(180%); display: flex; flex-direction: column; overflow: hidden; }
    #${OVERLAY_ID} .sc-marketplace-top { flex-shrink: 0; padding: 1.35rem 1.25rem 1.1rem; display: flex; flex-direction: column; gap: 0.9rem; }
    #${OVERLAY_ID} .sc-marketplace-header { display: flex; align-items: center; gap: 0.75rem; padding: 0; }
    #${OVERLAY_ID} .sc-marketplace-search-wrap { position: relative; flex: 1; }
    #${OVERLAY_ID} .sc-marketplace-search { width: 100%; box-sizing: border-box; background: rgba(70,70,70,0.22); border: 1px solid rgba(255,255,255,0.08); border-radius: 999px; color: #fff; padding: 0.8rem 1rem 0.8rem 2.6rem; font: inherit; box-shadow: inset 0 1px 0 rgba(255,255,255,0.1), 0 4px 18px rgba(0,0,0,0.18); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
    #${OVERLAY_ID} .sc-marketplace-search::placeholder { color: rgba(255,255,255,0.45); }
    #${OVERLAY_ID} .sc-marketplace-search:focus { outline: none; border-color: rgba(255,255,255,0.22); background: rgba(90,90,90,0.28); }
    #${OVERLAY_ID} .sc-marketplace-search-icon { position: absolute; left: 0.95rem; top: 50%; transform: translateY(-50%); width: 1rem; height: 1rem; opacity: 0.45; pointer-events: none; }
    #${OVERLAY_ID} .sc-marketplace-close, #${OVERLAY_ID} .sc-marketplace-action, #${OVERLAY_ID} .sc-marketplace-repo { border: none; cursor: pointer; font: inherit; }
    #${OVERLAY_ID} .sc-marketplace-close { width: 2.5rem; height: 2.5rem; border-radius: 999px; background: rgba(70,70,70,0.22); border: 1px solid rgba(255,255,255,0.08); color: #fff; font-size: 1.35rem; line-height: 1; flex-shrink: 0; transition: background 0.15s ease; }
    #${OVERLAY_ID} .sc-marketplace-close:hover { background: rgba(90,90,90,0.32); }
    #${OVERLAY_ID} .sc-marketplace-submit { padding: 0; color: rgba(255,255,255,0.62); font-size: 0.88rem; line-height: 1.45; }
    #${OVERLAY_ID} .sc-marketplace-submit a { color: #fff; text-decoration: underline; text-underline-offset: 2px; }
    #${OVERLAY_ID} .sc-marketplace-list { overflow: auto; padding: 0.15rem 1.25rem 1.25rem; display: flex; flex-direction: column; gap: 0.85rem; }
    #${OVERLAY_ID} .sc-marketplace-card { display: flex; flex-direction: row; align-items: flex-start; gap: 1rem; overflow: visible; isolation: isolate; background: rgba(38,38,38,0.96); border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 1rem 1.1rem; box-shadow: 0 8px 28px rgba(0,0,0,0.28); transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease; }
    #${OVERLAY_ID} .sc-marketplace-card.is-installed { background: rgba(28,42,34,0.96); border-color: rgba(34,179,101,0.42); box-shadow: 0 8px 28px rgba(0,0,0,0.28), inset 0 0 0 1px rgba(34,179,101,0.12); }
    #${OVERLAY_ID} .sc-marketplace-card.is-available { background: rgba(34,34,34,0.92); border-color: rgba(255,255,255,0.08); }
    #${OVERLAY_ID} .sc-marketplace-card.is-installed .sc-marketplace-icon { border-color: rgba(34,179,101,0.28); background: rgba(34,179,101,0.1); }
    #${OVERLAY_ID} .sc-marketplace-icon { width: 76px; height: 76px; border-radius: 12px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); display: flex; align-items: center; justify-content: center; overflow: hidden; color: rgba(255,255,255,0.88); flex: 0 0 76px; position: relative; z-index: 2; }
    #${OVERLAY_ID} .sc-marketplace-icon svg { width: 2rem; height: 2rem; }
    #${OVERLAY_ID} .sc-marketplace-icon img { width: 100%; height: 100%; object-fit: cover; }
    #${OVERLAY_ID} .sc-marketplace-body { flex: 1 1 auto; min-width: 0; overflow: hidden; position: relative; z-index: 1; }
    #${OVERLAY_ID} .sc-marketplace-title { color: #fff; font-size: 1.02rem; font-weight: 600; line-height: 1.3; margin-bottom: 0.2rem; }
    #${OVERLAY_ID} .sc-marketplace-type { display: flex; align-items: center; gap: 0.45rem; color: rgba(255,255,255,0.52); font-size: 0.8rem; margin-bottom: 0.45rem; }
    #${OVERLAY_ID} .sc-marketplace-status { display: inline-flex; align-items: center; border-radius: 999px; padding: 0.12rem 0.55rem; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; line-height: 1.2; }
    #${OVERLAY_ID} .sc-marketplace-card.is-installed .sc-marketplace-status { background: rgba(34,179,101,0.18); color: #6ee7a8; border: 1px solid rgba(34,179,101,0.35); }
    #${OVERLAY_ID} .sc-marketplace-card.is-available .sc-marketplace-status { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.48); border: 1px solid rgba(255,255,255,0.1); }
    #${OVERLAY_ID} .sc-marketplace-description { color: rgba(255,255,255,0.82); font-size: 0.86rem; line-height: 1.5; margin-bottom: 0.45rem; }
    #${OVERLAY_ID} .sc-marketplace-author { color: rgba(255,255,255,0.5); font-size: 0.8rem; }
    #${OVERLAY_ID} .sc-marketplace-actions { display: flex; flex-direction: column; align-items: stretch; gap: 0.5rem; flex: 0 0 7.5rem; width: 7.5rem; padding-top: 0.15rem; position: relative; z-index: 3; }
    #${OVERLAY_ID} .sc-marketplace-action { display: block; width: 100%; box-sizing: border-box; border-radius: 999px; padding: 0.62rem 0.75rem; background: rgba(255,255,255,0.14) !important; border: 1px solid rgba(255,255,255,0.18) !important; color: #fff !important; -webkit-text-fill-color: #fff !important; font-weight: 600; font-size: 0.84rem; line-height: 1.2; text-align: center; white-space: nowrap; box-shadow: none; position: relative; z-index: 4; transition: background 0.15s ease, border-color 0.15s ease; }
    #${OVERLAY_ID} .sc-marketplace-action:hover:not([aria-disabled="true"]) { background: rgba(255,255,255,0.24) !important; border-color: rgba(255,255,255,0.28) !important; }
    #${OVERLAY_ID} .sc-marketplace-action[aria-disabled="true"] { opacity: 0.65; cursor: wait; pointer-events: none; }
    #${OVERLAY_ID} .sc-marketplace-action.installed { background: rgba(198,40,40,0.16) !important; border-color: rgba(239,83,80,0.42) !important; color: #ffb4b0 !important; -webkit-text-fill-color: #ffb4b0 !important; font-weight: 600; }
    #${OVERLAY_ID} .sc-marketplace-action.available { background: rgba(34,179,101,0.18) !important; border-color: rgba(34,179,101,0.42) !important; color: #9cf0c0 !important; -webkit-text-fill-color: #9cf0c0 !important; }
    #${OVERLAY_ID} .sc-marketplace-repo { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem; background: transparent !important; border: none !important; box-shadow: none !important; color: rgba(255,255,255,0.82) !important; -webkit-text-fill-color: rgba(255,255,255,0.82) !important; font-size: 0.78rem; line-height: 1.2; text-decoration: underline; text-underline-offset: 2px; padding: 0.2rem 0; position: relative; z-index: 4; }
    #${OVERLAY_ID} .sc-marketplace-repo:hover { color: #fff; }
    #${OVERLAY_ID} .sc-marketplace-empty, #${OVERLAY_ID} .sc-marketplace-loading, #${OVERLAY_ID} .sc-marketplace-error { padding: 2rem 1rem; text-align: center; color: rgba(255,255,255,0.72); }
    `;
    document.head.appendChild(style);
  }

  function closeMarketplace() {
    document.getElementById(OVERLAY_ID)?.remove();
  }

  async function fetchRegistryEntries() {
    const registry = await api().fetchRegistry();
    const plugins = (registry.plugins || []).map((entry) => ({ ...entry, itemType: 'plugin' }));
    const themes = (registry.themes || []).map((entry) => ({ ...entry, itemType: 'theme' }));
    return [...plugins, ...themes];
  }

  async function getInstalledRef(entry) {
    return api().findInstalledRegistryItem({
      type: entry.itemType,
      download: entry.download,
      name: entry.name,
    });
  }

  async function removeEnabledPluginRef(installedRef) {
    const { getEnabledPlugins, setEnabledPlugins } = helpers();
    const { resolvePluginRef } = pluginsApi();
    if (!getEnabledPlugins || !setEnabledPlugins || !resolvePluginRef) return;

    const enabled = getEnabledPlugins();
    const kept = [];
    for (const fileRef of enabled) {
      const resolved = await resolvePluginRef(fileRef);
      if (resolved !== installedRef) kept.push(fileRef);
    }
    setEnabledPlugins(kept);
  }

  function setCardInstallState(card, installBtn, installedRef) {
    const isInstalled = Boolean(installedRef);
    card.classList.toggle('is-installed', isInstalled);
    card.classList.toggle('is-available', !isInstalled);
    installBtn.classList.toggle('installed', isInstalled);
    installBtn.classList.toggle('available', !isInstalled);
  }

  function createCard(entry, installedRef, onChange) {
    const card = document.createElement('div');
    card.className = 'sc-marketplace-card';
    card.dataset.name = entry.name.toLowerCase();

    const icon = document.createElement('div');
    icon.className = 'sc-marketplace-icon';
    if (entry.preview) {
      const img = document.createElement('img');
      img.src = entry.preview;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => {
        img.remove();
        icon.innerHTML = PUZZLE_ICON_SVG;
      };
      icon.appendChild(img);
    } else {
      icon.innerHTML = PUZZLE_ICON_SVG;
    }

    const body = document.createElement('div');
    body.className = 'sc-marketplace-body';
    const title = document.createElement('div');
    title.className = 'sc-marketplace-title';
    title.textContent = `${entry.name} ${entry.version || ''}`.trim();

    const type = document.createElement('div');
    type.className = 'sc-marketplace-type';
    const typeLabel = document.createElement('span');
    typeLabel.textContent = entry.itemType === 'theme' ? 'Theme' : 'Plugin';
    const status = document.createElement('span');
    status.className = 'sc-marketplace-status';
    type.append(typeLabel, status);

    const description = document.createElement('div');
    description.className = 'sc-marketplace-description';
    description.textContent = entry.description || '';

    const author = document.createElement('div');
    author.className = 'sc-marketplace-author';
    author.textContent = `Author: ${entry.author || 'Unknown'}`;
    body.append(title, type, description, author);

    const actions = document.createElement('div');
    actions.className = 'sc-marketplace-actions';
    const installBtn = document.createElement('div');
    installBtn.className = 'sc-marketplace-action';
    installBtn.setAttribute('role', 'button');
    installBtn.tabIndex = 0;

    const updateInstallButton = () => {
      setCardInstallState(card, installBtn, installedRef);
      status.textContent = installedRef ? 'Installed' : 'Not installed';
      installBtn.textContent = installedRef ? 'Uninstall' : 'Install';
      installBtn.setAttribute('aria-disabled', 'false');
    };
    updateInstallButton();

    const runInstallAction = async () => {
      if (installBtn.getAttribute('aria-disabled') === 'true') return;
      installBtn.setAttribute('aria-disabled', 'true');
      installBtn.textContent = installedRef ? 'Removing…' : 'Installing…';

      try {
        if (installedRef) {
          await api().uninstallRegistryItem({ type: entry.itemType, fileRef: installedRef });
          if (entry.itemType === 'plugin') {
            await removeEnabledPluginRef(installedRef);
          } else {
            const { getCurrentTheme, setCurrentTheme } = helpers();
            const { applyTheme } = themeApi();
            const current = getCurrentTheme?.() || '';
            if (current === installedRef || current === basename(installedRef)) {
              setCurrentTheme?.('');
              await applyTheme?.('');
            }
          }
          installedRef = null;
        } else {
          const result = await api().installRegistryItem({
            type: entry.itemType,
            download: entry.download,
            name: entry.name,
            category: entry.category,
          });
          installedRef = result.relativePath;
        }
        updateInstallButton();
        onChange?.();
      } catch (error) {
        installBtn.textContent = 'Error';
        console.error('[StremioCustom] Marketplace action failed:', error);
        setTimeout(updateInstallButton, 1500);
      }
    };

    installBtn.addEventListener('click', runInstallAction);
    installBtn.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        runInstallAction();
      }
    });

    const repoBtn = document.createElement('div');
    repoBtn.className = 'sc-marketplace-repo';
    repoBtn.setAttribute('role', 'button');
    repoBtn.tabIndex = 0;
    repoBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.58 2 12.26c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.48 0-.24-.01-.87-.01-1.7-2.78.63-3.37-1.36-3.37-1.36-.45-1.18-1.12-1.5-1.12-1.5-.92-.64.07-.63.07-.63 1.02.07 1.56 1.07 1.56 1.07.9 1.57 2.36 1.12 2.94.86.09-.67.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.32.1-2.74 0 0 .84-.27 2.75 1.05A9.2 9.2 0 0 1 12 6.84c.85.004 1.71.12 2.51.35 1.91-1.32 2.75-1.05 2.75-1.05.55 1.42.2 2.48.1 2.74.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.07.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.8 0 .27.18.59.69.48A10.03 10.03 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"/></svg><span>Open repository</span>';
    repoBtn.addEventListener('click', () => {
      if (entry.repo) api().openExternalUrl(entry.repo);
    });

    actions.append(installBtn, repoBtn);
    card.append(icon, body, actions);
    return card;
  }

  async function renderMarketplace(panel, list, statusEl, onChange) {
    list.innerHTML = '';
    statusEl.textContent = 'Loading Community Marketplace…';
    try {
      const entries = await fetchRegistryEntries();
      statusEl.textContent = '';
      panel.hidden = false;
      for (const entry of entries) {
        const installedRef = await getInstalledRef(entry);
        list.appendChild(createCard(entry, installedRef, onChange));
      }
    } catch (error) {
      statusEl.className = 'sc-marketplace-error';
      statusEl.textContent = `Could not load registry: ${error.message}`;
    }
  }

  function filterCards(list, query) {
    const normalized = query.trim().toLowerCase();
    list.querySelectorAll('.sc-marketplace-card').forEach((card) => {
      const haystack = [card.dataset.name, card.textContent].join(' ').toLowerCase();
      card.hidden = normalized ? !haystack.includes(normalized) : false;
    });
  }

  function openCommunityMarketplace({ onChange } = {}) {
    if (document.getElementById(OVERLAY_ID)) return;
    if (!window.StremioCustomAPI?.fetchRegistry) {
      console.error('[StremioCustom] Marketplace API unavailable');
      return;
    }

    ensureStyles();
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    const panel = document.createElement('div');
    panel.className = 'sc-marketplace-panel';

    const header = document.createElement('div');
    header.className = 'sc-marketplace-header';
    const searchWrap = document.createElement('div');
    searchWrap.className = 'sc-marketplace-search-wrap';
    const searchIcon = document.createElement('span');
    searchIcon.className = 'sc-marketplace-search-icon';
    searchIcon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'sc-marketplace-search';
    search.placeholder = 'Search plugins and themes…';
    searchWrap.append(searchIcon, search);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'sc-marketplace-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeMarketplace);
    header.append(searchWrap, closeBtn);

    const top = document.createElement('div');
    top.className = 'sc-marketplace-top';
    const submit = document.createElement('div');
    submit.className = 'sc-marketplace-submit';
    submit.innerHTML = 'Submit your themes and plugins <a href="#">here</a>.';
    submit.querySelector('a')?.addEventListener('click', (event) => {
      event.preventDefault();
      api().openExternalUrl(REGISTRY_SUBMIT_URL);
    });
    top.append(header, submit);

    const statusEl = document.createElement('div');
    statusEl.className = 'sc-marketplace-loading';
    const list = document.createElement('div');
    list.className = 'sc-marketplace-list';
    search.addEventListener('input', () => filterCards(list, search.value));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeMarketplace();
    });

    panel.append(top, statusEl, list);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    renderMarketplace(panel, list, statusEl, onChange);
  }

  function createMarketplaceButton(classes, onOpen) {
    const openCinebye = onOpen || (() => api().openExternalUrl(CINEBYE_URL));
    const option = document.createElement('div');
    option.id = 'stremio-custom-marketplace-entry';
    if (classes.option) option.className = classes.option;
    const content = document.createElement('div');
    if (classes.optionContent) content.className = classes.optionContent;
    const button = document.createElement('div');
    button.className = [classes.button, 'button'].filter(Boolean).join(' ');
    button.tabIndex = 0;
    button.textContent = 'Open Addon Manager';
    button.addEventListener('click', openCinebye);
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openCinebye();
      }
    });
    content.appendChild(button);
    option.appendChild(content);
    return option;
  }

  window.StremioCustomMarketplace = {
    openCommunityMarketplace,
    createMarketplaceButton,
    closeMarketplace,
    openCinebyeAddonManager: () => api().openExternalUrl(CINEBYE_URL),
  };
})();
