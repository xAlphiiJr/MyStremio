(function () {
  'use strict';

  if (window.StremioCustomSettings) return;

  const HOST_ID = 'mystremio-native-settings-host';
  const ROOT_ID = 'stremio-mystremio-plugins-root';
  const STYLE_ID = 'stremio-mystremio-plugins-style';
  const PLUGIN_CATEGORY_ORDER = [
    { id: 'player', label: 'Player' },
    { id: 'interface', label: 'Interface' },
    { id: 'metadata', label: 'Metadata' },
    { id: 'addons', label: 'Addons' },
    { id: 'utilities', label: 'Utilities' },
  ];

  function helpers() {
    return window.StremioCustom?.helpers || {};
  }

  function pluginsApi() {
    return window.StremioCustom?.plugins || {};
  }

  function api() {
    return window.StremioCustomAPI || window.StremioEnhancedAPI;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} { display: flex; flex-direction: column; gap: 0.75rem; }
      #${ROOT_ID} .stremio-mystremio-plugin-group-title {
        font-size: 0.82rem; font-weight: 600; opacity: 0.72; margin: 0.35rem 0 0.15rem;
      }
      #${ROOT_ID} .stremio-mystremio-plugin-row {
        display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
        padding: 0.55rem 0.65rem; border-radius: 0.65rem;
        background: rgba(255, 255, 255, 0.04);
      }
      #${ROOT_ID} .stremio-mystremio-plugin-name { font-weight: 600; font-size: 0.92rem; }
      #${ROOT_ID} .stremio-mystremio-plugin-meta { font-size: 0.78rem; opacity: 0.7; margin-top: 0.1rem; }
      #${ROOT_ID} .stremio-mystremio-plugin-toggle {
        flex: none; width: 2.5rem; height: 1.45rem; border: none; border-radius: 999px;
        background: rgba(255, 255, 255, 0.18); position: relative; cursor: pointer;
        transition: background 0.15s ease;
      }
      #${ROOT_ID} .stremio-mystremio-plugin-toggle::after {
        content: ""; position: absolute; top: 0.18rem; left: 0.18rem;
        width: 1.08rem; height: 1.08rem; border-radius: 999px; background: #fff;
        transition: transform 0.15s ease;
      }
      #${ROOT_ID} .stremio-mystremio-plugin-toggle.is-on {
        background: rgba(255, 255, 255, 0.42);
      }
      #${ROOT_ID} .stremio-mystremio-plugin-toggle.is-on::after {
        transform: translateX(1.05rem);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function getPluginCategory(fileRef, metadata) {
    if (metadata?.category) return String(metadata.category).toLowerCase();
    const folder = String(fileRef).includes('/') ? String(fileRef).split('/')[0] : '';
    return folder || 'utilities';
  }

  async function readMetadata(fileRef) {
    const client = api();
    if (!client?.getMetadata) return null;
    try {
      const meta = await client.getMetadata(fileRef);
      if (meta && meta.name) return meta;
    } catch (_) {}
    try {
      const base = String(fileRef).replace(/\\/g, '/').split('/').pop();
      const meta = await client.getMetadata(base);
      if (meta && meta.name) return meta;
    } catch (_) {}
    return null;
  }

  function createToggle(enabled) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'stremio-mystremio-plugin-toggle' + (enabled ? ' is-on' : '');
    toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    toggle.setAttribute('aria-label', enabled ? 'Disable plugin' : 'Enable plugin');
    return toggle;
  }

  async function togglePlugin(fileRef, toggle) {
    const h = helpers();
    if (!h.isPluginEnabled || !h.disablePlugin || !h.enablePlugin) return;

    const enabled = h.isPluginEnabled(fileRef);
    toggle.disabled = true;
    try {
      if (enabled) {
        await h.disablePlugin(fileRef);
        toggle.classList.remove('is-on');
        toggle.setAttribute('aria-pressed', 'false');
      } else {
        await h.enablePlugin(fileRef);
        toggle.classList.add('is-on');
        toggle.setAttribute('aria-pressed', 'true');
      }
    } finally {
      toggle.disabled = false;
    }
  }

  async function buildPluginList(host) {
    const h = helpers();
    const client = api();
    if (!client?.listPlugins || !h.getEnabledPlugins || !h.isPluginEnabled) return;

    injectStyles();
    host.innerHTML = '';
    const root = document.createElement('div');
    root.id = ROOT_ID;

    const pluginFiles = await client.listPlugins();
    const grouped = {};

    for (const fileRef of pluginFiles) {
      const metadata = await readMetadata(fileRef);
      const category = getPluginCategory(fileRef, metadata);
      if (!grouped[category]) grouped[category] = [];
      grouped[category].push({ fileRef, metadata });
    }

    for (const { id, label } of PLUGIN_CATEGORY_ORDER) {
      const entries = grouped[id];
      if (!entries?.length) continue;

      const title = document.createElement('div');
      title.className = 'stremio-mystremio-plugin-group-title';
      title.textContent = label;
      root.appendChild(title);

      for (const { fileRef, metadata } of entries) {
        const row = document.createElement('div');
        row.className = 'stremio-mystremio-plugin-row';

        const info = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'stremio-mystremio-plugin-name';
        name.textContent = metadata?.name || fileRef.split('/').pop();
        info.appendChild(name);

        if (metadata?.description) {
          const desc = document.createElement('div');
          desc.className = 'stremio-mystremio-plugin-meta';
          desc.textContent = metadata.description;
          info.appendChild(desc);
        }

        const toggle = createToggle(h.isPluginEnabled(fileRef));
        toggle.addEventListener('click', () => togglePlugin(fileRef, toggle));

        row.append(info, toggle);
        root.appendChild(row);
      }
    }

    host.appendChild(root);
    host.dataset.pluginsBuilt = '1';
  }

  async function checkSettings() {
    const h = helpers();
    if (!h.isOnSettingsPage?.()) return;

    const host = document.getElementById(HOST_ID);
    if (!host) return;
    if (host.dataset.pluginsBuilt === '1') return;
    await buildPluginList(host);
  }

  let watcherStarted = false;

  function startSettingsWatcher(pluginApi) {
    if (watcherStarted) return;
    watcherStarted = true;

    const schedule = () => {
      setTimeout(() => checkSettings(pluginApi), 300);
    };

    window.addEventListener('hashchange', schedule);
    document.addEventListener('stremio-custom-bootstrap-ready', schedule);

    const observer = new MutationObserver(() => {
      if (typeof window.stremioCustomSuspendBackground === 'function' &&
        window.stremioCustomSuspendBackground()) {
        return;
      }
      if (!helpers().isOnSettingsPage?.()) return;
      if (!document.getElementById(HOST_ID)) return;
      if (document.getElementById(HOST_ID)?.dataset.pluginsBuilt === '1') return;
      schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
  }

  window.StremioCustomSettings = {
    checkSettings,
    startSettingsWatcher,
  };
})();
