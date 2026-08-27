(function () {
  'use strict';

  if (window.self !== window.top) return;
  if (window.__stremioCustomAddonManager) return;
  window.__stremioCustomAddonManager = true;

  const API_BASE = 'https://api.strem.io/api';
  const BACKUP_KEY = 'stremio-custom-addon-collection-backup';
  const CINEMETA_ORIGINAL_KEY = 'stremio-custom-cinemeta-original';
  const CINEMETA_CATALOG_BACKUP_KEY = 'stremio-custom-cinemeta-catalogs';
  const METADATA_CAPABLE_KEY = 'stremio-custom-metadata-capable';
  const METADATA_RESOURCE_KEY = 'stremio-custom-metadata-resources';
  const METADATA_SELECTION_ENABLED = true;
  const STYLE_ID = 'stremio-custom-addon-manager-style';
  const ROOT_ID = 'mystremio-addon-manager';
  const TOOLBAR_ID = 'mystremio-addon-toolbar';
  const SOURCE_MENU_ID = 'mystremio-am-source-menu';
  const TOAST_ID = 'stremio-custom-addon-manager-toast';
  const CONFIRM_ID = 'mystremio-am-confirm';
  const PAGE_CLASS = 'mystremio-own-addons';
  const SEARCH_EXTRA = 'search';
  const HOME_HIDE_EXTRA = 'mystremio-home-hide';
  const META_HIDE_EXTRA = 'mystremio-meta-hide';
  const DISCOVER_HIDE_EXTRA = 'mystremio-discover-hide';
  const SEARCH_HIDE_EXTRA = 'mystremio-search-hide';
  const VISIBILITY_KEY = 'stremio-custom-catalog-visibility';
  const ADDON_SEARCH_KEY = 'stremio-custom-addon-search-disabled';
  const DUMMY_EXTRAS = new Set([HOME_HIDE_EXTRA, META_HIDE_EXTRA, DISCOVER_HIDE_EXTRA, SEARCH_HIDE_EXTRA]);
  const DISCOVER_TYPE_LABELS = new Set([
    'movie',
    'movies',
    'film',
    'filme',
    'series',
    'serien',
    'tv',
    'channel',
    'channels',
    'kanäle',
    'kanale',
    'anime',
    'all',
    'alle',
  ]);

  /** @type {object[]|null} */
  let liveAddons = null;
  /** @type {object[]|null} */
  let draft = null;
  let dirty = false;
  let persistBusy = false;
  let persistQueued = false;
  /** @type {object[]|null} */
  let persistQueuedAddons = null;
  let persistQueuedSilent = false;
  let sourceMenuOpen = false;
  let filterQuery = '';
  let filterType = '';
  let toastTimer = null;
  let mountTimer = null;
  let livePoll = null;
  /** @type {Set<string>} */
  const expanded = new Set();
  /** @type {object|null} */
  let originalCinemeta = null;
  let dragFrom = -1;
  let dragOver = -1;
  let domLock = 0;
  let discoverSwitching = false;
  /** @type {MutationObserver|null} */
  let observer = null;
  /** @type {Set<string>} */
  const locallyRemoved = new Set();
  let nativeDialogOpen = false;
  let metadataTouchedThisSession = false;

  function getUiLanguage() {
    try {
      const htmlLang = String(document.documentElement.lang || '').toLowerCase();
      if (htmlLang.startsWith('de')) return 'de';
      if (htmlLang.startsWith('en')) return 'en';
    } catch (_) {}
    return 'en';
  }

  function t(en, de) {
    return getUiLanguage() === 'de' ? de : en;
  }

  function getCore() {
    return window.core || window.services?.core?.transport || null;
  }

  function isInstalledAddonsRoute() {
    return /#\/addons\/?(?:\?.*)?$/.test(location.hash || '');
  }

  function isDiscoverRoute() {
    return /#\/discover/.test(location.hash || '');
  }

  function isBoardRoute() {
    const hash = location.hash || '';
    if (!hash || hash === '#/' || hash === '#') return true;
    if (hash.includes('/board')) return true;
    if (/^#\/?\?/.test(hash)) return true;
    return false;
  }

  function normalizeTransport(url) {
    const helper = window.StremioCustomAddonSoftDisable?.normalizeTransportBase;
    if (typeof helper === 'function') return helper(url);
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw, location.href);
      parsed.hash = '';
      parsed.search = '';
      let path = parsed.pathname.replace(/\/manifest\.json$/i, '');
      parsed.pathname = path.replace(/\/+$/, '') || '/';
      let href = parsed.href;
      if (href.endsWith('/') && parsed.pathname !== '/') href = href.replace(/\/+$/, '');
      return href;
    } catch (_) {
      return raw.replace(/\/manifest\.json(?:\?.*)?$/i, '').replace(/\/+$/, '');
    }
  }

  function addonTransportUrl(addon) {
    return String(addon?.transportUrl || addon?.transport_url || addon?.manifestUrl || '');
  }

  function addonTransport(addon) {
    return normalizeTransport(addonTransportUrl(addon));
  }

  function sameTransport(addon, transport) {
    return addonTransport(addon) === normalizeTransport(transport);
  }

  function cloneAddons(addons) {
    return JSON.parse(JSON.stringify(Array.isArray(addons) ? addons : []));
  }

  function toDescriptors(addons) {
    return (Array.isArray(addons) ? addons : [])
      .map((addon) => ({
        transportUrl: addonTransportUrl(addon),
        manifest: addon?.manifest,
        flags: addon?.flags || { official: false, protected: false },
      }))
      .filter((item) => item.transportUrl && item.manifest);
  }

  function collectionSignature(addons) {
    return JSON.stringify(toDescriptors(addons));
  }

  function resourceName(resource) {
    if (typeof resource === 'string') return resource;
    return String(resource?.name || '');
  }

  function hasMetaResource(addon) {
    return (addon?.manifest?.resources || []).some((resource) => resourceName(resource) === 'meta');
  }

  function getCatalogs(addon) {
    const catalogs = addon?.manifest?.catalogs;
    return Array.isArray(catalogs) ? catalogs : [];
  }

  function catalogLabel(catalog) {
    const name = String(catalog?.name || catalog?.id || 'Catalog').trim();
    const type = String(catalog?.type || '').trim();
    return type ? `${name} · ${type}` : name;
  }

  function catalogKey(catalog) {
    return `${String(catalog?.type || '')}::${String(catalog?.id || '')}`;
  }

  function normalizeExtras(catalog) {
    if (Array.isArray(catalog?.extra)) {
      return catalog.extra.map((extra) => Object.assign({}, extra));
    }
    const supported = Array.isArray(catalog?.extraSupported) ? catalog.extraSupported : [];
    const required = Array.isArray(catalog?.extraRequired) ? catalog.extraRequired : [];
    return supported.map((name) => ({
      name,
      isRequired: required.includes(name),
    }));
  }

  function writeExtras(catalog, extras) {
    catalog.extra = extras;
    delete catalog.extraRequired;
    delete catalog.extraSupported;
  }

  function extraOptions(extra) {
    return Array.isArray(extra?.options) ? extra.options.map(String) : [];
  }

  function hasNamedExtra(catalog, name, required) {
    return normalizeExtras(catalog).some((extra) => {
      if (extra.name !== name) return false;
      if (required == null) return true;
      return Boolean(extra.isRequired) === required;
    });
  }

  function isLegacyHomeHideSearch(catalog) {
    const search = normalizeExtras(catalog).find((extra) => extra.name === SEARCH_EXTRA && extra.isRequired);
    if (!search) return false;
    const options = extraOptions(search);
    return options.includes(HOME_HIDE_EXTRA) || options.includes(META_HIDE_EXTRA);
  }

  function looksLikeSearchCatalog(catalog) {
    return /\bsearch\b/i.test(String(catalog?.id || '')) || /\bsearch\b/i.test(String(catalog?.name || ''));
  }

  function catalogKind(catalog) {
    if (looksLikeSearchCatalog(catalog)) return 'search';
    if (hasNamedExtra(catalog, SEARCH_EXTRA, true) && !isLegacyHomeHideSearch(catalog)) return 'search';
    return 'catalog';
  }

  function visibilityId(addon, catalog) {
    return `${addonTransport(addon)}::${catalogKey(catalog)}`;
  }

  function readVisibilityMap() {
    const stored = readJson(VISIBILITY_KEY, {});
    return stored && typeof stored === 'object' ? stored : {};
  }

  function writeVisibilityMap(map) {
    writeJson(VISIBILITY_KEY, map);
  }

  function catalogFlags(addon, catalog) {
    const stored = readVisibilityMap()[visibilityId(addon, catalog)] || {};
    return {
      disabled: stored.disabled === true,
      home: stored.home !== false,
      discover: stored.discover !== false,
      search: stored.search !== false,
    };
  }

  function patchCatalogFlags(addon, catalog, patch) {
    const map = readVisibilityMap();
    const key = visibilityId(addon, catalog);
    map[key] = Object.assign({}, map[key] || {}, patch);
    writeVisibilityMap(map);
  }

  function readDisabledAddonSearch() {
    const stored = readJson(ADDON_SEARCH_KEY, []);
    return new Set(Array.isArray(stored) ? stored.map(normalizeTransport).filter(Boolean) : []);
  }

  function writeDisabledAddonSearch(set) {
    writeJson(ADDON_SEARCH_KEY, [...set]);
  }

  function isAddonSearchDisabled(addon) {
    return readDisabledAddonSearch().has(addonTransport(addon));
  }

  function setAddonSearchDisabled(addon, disabled) {
    const set = readDisabledAddonSearch();
    const key = addonTransport(addon);
    if (!key) return;
    if (disabled) set.add(key);
    else set.delete(key);
    writeDisabledAddonSearch(set);
  }

  function effectiveCatalogFlags(addon, catalog) {
    const flags = catalogFlags(addon, catalog);
    const kind = catalogKind(catalog);
    const disabled = flags.disabled;
    return {
      disabled,
      home: !disabled && flags.home && kind !== 'search',
      discover: !disabled && flags.discover && kind !== 'search',
      search: !disabled && flags.search && !isAddonSearchDisabled(addon),
    };
  }

  function isCatalogDisabled(addon, catalog) {
    return effectiveCatalogFlags(addon, catalog).disabled;
  }

  function isCatalogHomeHidden(addon, catalog) {
    return !effectiveCatalogFlags(addon, catalog).home;
  }

  function setCatalogHomeVisible(addon, catalog, visible) {
    if (catalogKind(catalog) !== 'catalog') return;
    patchCatalogFlags(addon, catalog, { home: Boolean(visible) });
  }

  function catalogHasOptionalSearch(catalog) {
    return hasNamedExtra(catalog, SEARCH_EXTRA, false);
  }

  function catalogCanContributeSearch(addon, catalog) {
    return catalogKind(catalog) === 'search' ||
      catalogHasOptionalSearch(catalog) ||
      addonCanSearch(addon);
  }

  function isCatalogSearchVisible(addon, catalog) {
    return effectiveCatalogFlags(addon, catalog).search && catalogCanContributeSearch(addon, catalog);
  }

  function stripOptionalSearch(catalog) {
    writeExtras(
      catalog,
      normalizeExtras(catalog).filter((extra) => extra.name !== SEARCH_EXTRA || extra.isRequired)
    );
  }

  function restoreOptionalSearch(catalog, originalCatalog) {
    if (catalogHasOptionalSearch(catalog)) return;
    const originalSearch = originalCatalog
      ? normalizeExtras(originalCatalog).find((extra) => extra.name === SEARCH_EXTRA && !extra.isRequired)
      : null;
    const extras = normalizeExtras(catalog);
    extras.push(Object.assign({}, originalSearch || { name: SEARCH_EXTRA }, { isRequired: false }));
    writeExtras(catalog, extras);
  }

  function setCatalogSearchVisible(addon, catalog, visible, originalCatalog) {
    patchCatalogFlags(addon, catalog, { search: Boolean(visible) });
    if (catalogKind(catalog) === 'search') return;
    const original = originalCatalog || originalCatalogFor(addon, catalog);
    if (!catalogHasOptionalSearch(catalog) && !catalogHasOptionalSearch(original)) return;
    if (visible) restoreOptionalSearch(catalog, original);
    else stripOptionalSearch(catalog);
  }

  function isCatalogDiscoverHidden(addon, catalog) {
    return !effectiveCatalogFlags(addon, catalog).discover;
  }

  function setCatalogDiscoverVisible(addon, catalog, visible) {
    if (catalogKind(catalog) !== 'catalog') return;
    patchCatalogFlags(addon, catalog, { discover: Boolean(visible) });
  }

  function setCatalogDisabled(addon, catalog, disabled) {
    patchCatalogFlags(addon, catalog, { disabled: Boolean(disabled) });
  }

  function resourceHasSearch(resource) {
    if (resourceName(resource) !== 'catalog') return false;
    const extras = Array.isArray(resource?.extra) ? resource.extra : [];
    return extras.some((extra) => {
      const name = typeof extra === 'string' ? extra : extra?.name;
      return name === SEARCH_EXTRA;
    });
  }

  function catalogShowsSearchToggle(addon, catalog) {
    if (catalogCanContributeSearch(addon, catalog)) return true;
    const original = originalCatalogFor(addon, catalog);
    return Boolean(original && catalogHasOptionalSearch(original));
  }

  function catalogsWithSearchToggle(addon) {
    return getCatalogs(addon).filter((catalog) => catalogShowsSearchToggle(addon, catalog));
  }

  function syncAddonSearchFromCatalogs(addon) {
    const relevant = catalogsWithSearchToggle(addon);
    if (relevant.length === 0) return;
    const allOff = relevant.every((catalog) => {
      const flags = catalogFlags(addon, catalog);
      return flags.search === false || flags.disabled;
    });
    setAddonSearchDisabled(addon, allOff);
  }

  function addonCanSearch(addon) {
    if (isAddonSearchDisabled(addon)) return true;
    if ((addon?.manifest?.resources || []).some(resourceHasSearch)) return true;
    return getCatalogs(addon).some((catalog) => {
      if (catalogKind(catalog) === 'search') return true;
      if (catalogHasOptionalSearch(catalog)) return true;
      if (hasNamedExtra(catalog, SEARCH_EXTRA, true)) return true;
      const original = originalCatalogFor(addon, catalog);
      if (original && catalogHasOptionalSearch(original)) return true;
      return false;
    });
  }

  function stripDummyExtras(catalog) {
    const extras = normalizeExtras(catalog).filter((extra) => !DUMMY_EXTRAS.has(extra.name));
    const search = extras.find((extra) => extra.name === SEARCH_EXTRA && extra.isRequired);
    if (search && isLegacyHomeHideSearch({ extra: [search] })) {
      const leftover = extraOptions(search).filter(
        (option) => option !== HOME_HIDE_EXTRA && option !== META_HIDE_EXTRA
      );
      if (!leftover.length) extras.splice(extras.indexOf(search), 1);
      else search.options = leftover;
    }
    writeExtras(catalog, extras);
  }

  function stripDummyExtrasFromAddons(addons) {
    const next = cloneAddons(addons);
    for (const addon of next) {
      for (const catalog of getCatalogs(addon)) stripDummyExtras(catalog);
    }
    return next;
  }

  function applyVisibilityToExtras(addons) {
    const next = stripDummyExtrasFromAddons(addons);
    for (const addon of next) {
      for (const catalog of getCatalogs(addon)) {
        const flags = effectiveCatalogFlags(addon, catalog);
        if (catalogKind(catalog) !== 'search' && !flags.search && catalogHasOptionalSearch(catalog)) {
          stripOptionalSearch(catalog);
        }
      }
    }
    return next;
  }

  function migrateVisibilityFromExtras(addons) {
    for (const addon of addons || []) {
      for (const catalog of getCatalogs(addon)) {
        const patch = {};
        if (hasNamedExtra(catalog, HOME_HIDE_EXTRA, true) || isLegacyHomeHideSearch(catalog)) patch.home = false;
        if (hasNamedExtra(catalog, DISCOVER_HIDE_EXTRA)) patch.discover = false;
        if (hasNamedExtra(catalog, SEARCH_HIDE_EXTRA, true)) patch.search = false;
        if (Object.keys(patch).length) patchCatalogFlags(addon, catalog, patch);
      }
    }
  }

  let visibilityMigrated = false;

  function ensureVisibilityMigrated(addons) {
    if (visibilityMigrated) return;
    migrateVisibilityFromExtras(addons);
    visibilityMigrated = true;
  }

  function refreshVisibilitySurfaces() {
    applyDiscoverCatalogFilter();
    applyBoardCatalogFilter();
  }

  async function ensureLiveAddons() {
    if (Array.isArray(liveAddons) && liveAddons.length) return liveAddons;
    return loadLiveAddons();
  }

  function scheduleVisibilityRefresh() {
    const run = () => {
      void ensureLiveAddons().then((addons) => {
        ensureVisibilityMigrated(addons);
        refreshVisibilitySurfaces();
      });
    };
    run();
    window.requestAnimationFrame(run);
    window.setTimeout(run, 300);
    window.setTimeout(run, 1200);
  }

  function parseCatalogRequest(url) {
    try {
      const parsed = new URL(String(url || ''), location.href);
      const match = parsed.pathname.match(/\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/i);
      if (!match) return null;
      const extra = match[3] ? decodeURIComponent(match[3]) : '';
      const extras = {};
      extra.split('&').filter(Boolean).forEach((pair) => {
        const eq = pair.indexOf('=');
        const key = eq >= 0 ? pair.slice(0, eq) : pair;
        const value = eq >= 0 ? pair.slice(eq + 1) : '';
        extras[decodeURIComponent(key)] = decodeURIComponent(value);
      });
      parsed.searchParams.forEach((value, key) => {
        extras[key] = value;
      });
      return {
        href: parsed.href,
        type: decodeURIComponent(match[1]),
        id: decodeURIComponent(match[2]),
        extras,
        hasSearch: Object.prototype.hasOwnProperty.call(extras, 'search'),
      };
    } catch (_) {
      return null;
    }
  }

  function addonForCatalogRequest(href) {
    const addons = liveAddons || workingAddons() || [];
    return (
      addons.find((addon) => {
        const base = addonTransport(addon);
        if (!base) return false;
        return href === base || href.startsWith(`${base}/`);
      }) || null
    );
  }

  function shouldEmptyCatalogRequest(url) {
    const request = parseCatalogRequest(url);
    if (!request) return false;
    const addon = addonForCatalogRequest(request.href);
    if (!addon) return false;
    const catalog = getCatalogs(addon).find(
      (item) => String(item?.type || '') === request.type && String(item?.id || '') === request.id
    );
    if (isAddonSearchDisabled(addon) && (request.hasSearch || (catalog && catalogKind(catalog) === 'search'))) {
      return true;
    }
    if (!catalog) return isAddonSearchDisabled(addon) && request.hasSearch;
    const flags = effectiveCatalogFlags(addon, catalog);
    if (flags.disabled) return true;
    if (request.hasSearch && !flags.search) return true;
    if (catalogKind(catalog) === 'search' && !flags.search) return true;
    return false;
  }

  function emptyCatalogResponse() {
    return Promise.resolve(
      new Response('{"metas":[]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }

  function installCatalogSearchFilter() {
    if (window.__mystremioCatalogSearchFetchFiltered) return;
    window.__mystremioCatalogSearchFetchFiltered = true;

    const originalFetch = window.fetch?.bind(window);
    if (typeof originalFetch === 'function') {
      window.fetch = function (input, init) {
        const url =
          typeof input === 'string'
            ? input
            : input && typeof input === 'object' && 'url' in input
              ? String(input.url)
              : String(input || '');
        if (shouldEmptyCatalogRequest(url)) return emptyCatalogResponse();
        return originalFetch(input, init);
      };
    }

    const XHR = window.XMLHttpRequest;
    if (!XHR || XHR.__mystremioCatalogSearchPatched) return;
    const proto = XHR.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    proto.open = function (method, url, ...rest) {
      this.__mystremioCatalogSearchUrl = String(url || '');
      return originalOpen.call(this, method, url, ...rest);
    };
    proto.send = function (...args) {
      if (shouldEmptyCatalogRequest(this.__mystremioCatalogSearchUrl)) {
        const self = this;
        const body = '{"metas":[]}';
        Object.defineProperty(this, 'readyState', { configurable: true, get: () => 4 });
        Object.defineProperty(this, 'status', { configurable: true, get: () => 200 });
        Object.defineProperty(this, 'responseText', { configurable: true, get: () => body });
        Object.defineProperty(this, 'response', { configurable: true, get: () => body });
        queueMicrotask(() => {
          self.dispatchEvent(new Event('readystatechange'));
          self.dispatchEvent(new Event('load'));
          self.dispatchEvent(new Event('loadend'));
        });
        return;
      }
      return originalSend.apply(this, args);
    };
    XHR.__mystremioCatalogSearchPatched = true;
  }

  function originalCatalogFor(addon, catalog) {
    if (isCinemeta(addon) && originalCinemeta) {
      return (originalCinemeta.catalogs || []).find((item) => catalogKey(item) === catalogKey(catalog)) || null;
    }
    const live = (liveAddons || []).find((item) => sameTransport(item, addonTransport(addon)));
    return getCatalogs(live).find((item) => catalogKey(item) === catalogKey(catalog)) || null;
  }

  function catalogMatchKeys(addon, catalog) {
    const keys = new Set();
    const name = String(catalog?.name || '').trim().toLowerCase();
    const id = String(catalog?.id || '').trim().toLowerCase();
    const type = String(catalog?.type || '').trim().toLowerCase();
    const addonName = String(addon?.manifest?.name || '').trim().toLowerCase();
    const label = catalogLabel(catalog).toLowerCase();
    if (name) keys.add(name);
    if (id) keys.add(id);
    if (label) keys.add(label);
    if (addonName) keys.add(addonName);
    if (name && type) keys.add(`${name} · ${type}`);
    if (addonName && name) {
      keys.add(`${addonName} ${name}`);
      keys.add(`${name} ${addonName}`);
      keys.add(`${addonName} · ${name}`);
    }
    if (id === 'top' || name === 'popular') {
      keys.add('popular');
      keys.add('top');
    }
    return [...keys].filter(Boolean);
  }

  function isDiscoverTypeText(text) {
    return DISCOVER_TYPE_LABELS.has(String(text || '').trim().toLowerCase());
  }

  function isDiscoverSearchText(text) {
    const value = String(text || '').trim().toLowerCase();
    return value === 'search' || value === 'suche' || value === 'buscar';
  }

  function isDiscoverExtraText(text) {
    const value = String(text || '').trim().toLowerCase();
    return (
      value === 'genre' ||
      value === 'year' ||
      value === 'jahr' ||
      value === 'select' ||
      value === 'auswahl' ||
      value === 'none' ||
      value === 'keine'
    );
  }

  function isNonCatalogDiscoverControl(text) {
    return isDiscoverTypeText(text) || isDiscoverSearchText(text) || isDiscoverExtraText(text);
  }

  function discoverHashUsesCinemeta() {
    return /cinemeta/i.test(String(location.hash || ''));
  }

  function cinemetaDiscoverIsOff(addon) {
    if (!addon) return true;
    return isSoftDisabled(addon) || cinemetaCatalogsRemoved(addon);
  }

  function pushHiddenDiscoverEntry(entries, addon, catalog) {
    entries.push({
      keys: catalogMatchKeys(addon, catalog),
      reason: catalogKind(catalog) === 'search' ? 'search' : 'marked',
    });
  }

  function hiddenDiscoverEntries() {
    const entries = [];
    const addons = liveAddons || workingAddons() || [];
    for (const addon of addons) {
      if (isCinemeta(addon)) {
        const hideAll = cinemetaDiscoverIsOff(addon);
        const live = getCatalogs(addon);
        const storedBackup = readJson(CINEMETA_CATALOG_BACKUP_KEY, []);
        const backup = Array.isArray(storedBackup) && storedBackup.length
          ? storedBackup
          : Array.isArray(originalCinemeta?.catalogs)
            ? originalCinemeta.catalogs
            : [];
        const catalogs = hideAll ? [...live, ...backup] : live.length ? live : backup;
        for (const catalog of catalogs) {
          if (!hideAll && !isCatalogDiscoverHidden(addon, catalog)) continue;
          pushHiddenDiscoverEntry(entries, addon, catalog);
        }
        continue;
      }
      for (const catalog of getCatalogs(addon)) {
        if (!isCatalogDiscoverHidden(addon, catalog)) continue;
        pushHiddenDiscoverEntry(entries, addon, catalog);
      }
    }
    if (discoverHashUsesCinemeta()) {
      const cinemeta = findCinemeta(addons);
      if (cinemetaDiscoverIsOff(cinemeta)) {
        const backup =
          (cinemeta && cinemetaCatalogSource(cinemeta)) ||
          readJson(CINEMETA_CATALOG_BACKUP_KEY, []) ||
          originalCinemeta?.catalogs ||
          [];
        if (Array.isArray(backup)) {
          const stub = cinemeta || { manifest: { name: 'Cinemeta' } };
          for (const catalog of backup) pushHiddenDiscoverEntry(entries, stub, catalog);
        }
        entries.push({ keys: ['popular', 'top', 'cinemeta'], reason: 'marked' });
      }
    }
    return entries;
  }

  function textMatchesKeys(text, keys) {
    const value = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!value || isDiscoverTypeText(value)) return false;
    return keys.some((key) => {
      if (!key) return false;
      if (value === key) return true;
      if (value.startsWith(`${key} ·`) || value.startsWith(`${key}·`) || value.startsWith(`${key} -`)) return true;
      if (value.startsWith(`${key} (`)) return true;
      return value.includes(` ${key}`) && value.length - key.length < 28;
    });
  }

  function isDummyExtraText(text) {
    const value = String(text || '').trim().toLowerCase();
    if (!value) return false;
    if (DUMMY_EXTRAS.has(value)) return true;
    return /mystremio-(?:home|discover|search|meta)-hi/i.test(value);
  }

  function optionMatchesHidden(text, entries) {
    if (isDummyExtraText(text)) return true;
    const value = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return (entries || []).some((entry) => {
      if (textMatchesKeys(text, entry.keys)) return true;
      if (entry.reason === 'search' && /\bsearch\b/i.test(value)) {
        return (entry.keys || []).some(
          (key) => key && key.length >= 3 && (value.includes(key) || key.includes(value))
        );
      }
      return false;
    });
  }

  function discoverOptionNodes(scope) {
    return [
      ...scope.querySelectorAll(
        '[class*="menu-container"] [class*="option"], [class*="selectable-inputs"] [class*="option"], [class*="select-input-container"] [class*="option"]'
      ),
    ];
  }

  function applyDiscoverCatalogFilter() {
    if (!isDiscoverRoute() || discoverSwitching) return;
    const entries = hiddenDiscoverEntries();
    const forceLeaveCinemeta =
      discoverHashUsesCinemeta() &&
      cinemetaDiscoverIsOff(findCinemeta(liveAddons || workingAddons() || []));
    const scope =
      document.querySelector('[class*="discover-container"]') ||
      document.querySelector('[class*="discover-"]') ||
      document;
    const options = discoverOptionNodes(scope);
    options.forEach((option) => {
      const text = String(option.textContent || '');
      const hide = optionMatchesHidden(text, entries);
      const next = hide ? '1' : '0';
      if (option.dataset.msDiscoverHide !== next) {
        option.dataset.msDiscoverHide = next;
        option.style.display = hide ? 'none' : '';
      }
    });
    const inputs = [...scope.querySelectorAll('[class*="select-input-container"]')];
    for (const input of inputs) {
      const label = input.querySelector('[class*="label"]');
      const labelText = String(label?.textContent || '');
      if (isDiscoverTypeText(labelText) || isDiscoverSearchText(labelText)) {
        delete input.dataset.msDiscoverOpenAttempt;
        continue;
      }
      const labelHidden = optionMatchesHidden(labelText, entries);
      if (!labelHidden && !(forceLeaveCinemeta && !isNonCatalogDiscoverControl(labelText))) {
        delete input.dataset.msDiscoverOpenAttempt;
        continue;
      }
      const visible = [...input.querySelectorAll('[class*="option"]')].find((option) => {
        const text = String(option.textContent || '');
        if (option.dataset.msDiscoverHide === '1' || option.style.display === 'none') return false;
        if (isDiscoverTypeText(text) || isDiscoverSearchText(text)) return false;
        return true;
      });
      if (visible) {
        discoverSwitching = true;
        delete input.dataset.msDiscoverOpenAttempt;
        visible.click();
        window.setTimeout(() => {
          discoverSwitching = false;
        }, 0);
        return;
      }
      if (input.dataset.msDiscoverOpenAttempt === '1') continue;
      input.dataset.msDiscoverOpenAttempt = '1';
      discoverSwitching = true;
      (label || input).click();
      window.setTimeout(() => {
        discoverSwitching = false;
        applyDiscoverCatalogFilter();
      }, 60);
      return;
    }
  }

  function hiddenBoardEntries() {
    const entries = [];
    for (const addon of liveAddons || workingAddons() || []) {
      for (const catalog of getCatalogs(addon)) {
        if (!isCatalogHomeHidden(addon, catalog)) continue;
        entries.push({ keys: catalogMatchKeys(addon, catalog) });
      }
    }
    return entries;
  }

  function applyBoardCatalogFilter() {
    if (!isBoardRoute()) return;
    const board = document.querySelector('[class*="board-container"]');
    if (!board) return;
    const entries = hiddenBoardEntries();
    const rows = [...board.querySelectorAll('[class*="meta-row-container"]')];
    for (const row of rows) {
      const className = String(row.className || '');
      if (className.includes('continue-watching') || className.includes('placeholder')) continue;
      const title = row.querySelector('[class*="title-container"]');
      const text = String(title?.textContent || '');
      const hide = optionMatchesHidden(text, entries);
      const next = hide ? '1' : '0';
      if (row.dataset.msBoardHide !== next) {
        row.dataset.msBoardHide = next;
        row.style.display = hide ? 'none' : '';
      }
    }
  }

  function isCinemeta(addon) {
    const transport = addonTransport(addon);
    const id = String(addon?.manifest?.id || '');
    return (
      /cinemeta\.strem\.io/i.test(transport) ||
      id === 'com.linvo.cinemeta' ||
      /^cinemeta$/i.test(String(addon?.manifest?.name || ''))
    );
  }

  function findCinemeta(addons) {
    return (addons || []).find((addon) => isCinemeta(addon)) || null;
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function rememberOriginalCinemeta(addon) {
    if (!isCinemeta(addon) || !addon?.manifest) return;
    const catalogs = getCatalogs(addon);
    const looksComplete = hasMetaResource(addon) && catalogs.some(catalogHasOptionalSearch);
    if (!looksComplete) {
      if (!originalCinemeta) originalCinemeta = readJson(CINEMETA_ORIGINAL_KEY, null);
      return;
    }
    originalCinemeta = JSON.parse(JSON.stringify(addon.manifest));
    writeJson(CINEMETA_ORIGINAL_KEY, originalCinemeta);
  }

  function cinemetaCatalogSource(addon) {
    const catalogs = getCatalogs(addon);
    if (catalogs.length) return catalogs;
    const backup = readJson(CINEMETA_CATALOG_BACKUP_KEY, []);
    return Array.isArray(backup) ? backup : [];
  }

  function cinemetaSearchRemoved(addon) {
    const catalogs = cinemetaCatalogSource(addon);
    if (!catalogs.length) return false;
    return !catalogs.some(catalogHasOptionalSearch);
  }

  function cinemetaCatalogsRemoved(addon) {
    if (readJson(CINEMETA_CATALOG_BACKUP_KEY, null)) return true;
    return getCatalogs(addon).length === 0;
  }

  function cinemetaMetadataRemoved(addon) {
    return !hasMetaResource(addon);
  }

  function applyCinemetaSearchPatch(addon, remove) {
    const liveCatalogs = getCatalogs(addon);
    const backup = readJson(CINEMETA_CATALOG_BACKUP_KEY, null);
    const targets = liveCatalogs.length ? liveCatalogs : Array.isArray(backup) ? backup : [];
    if (remove) {
      for (const catalog of targets) stripOptionalSearch(catalog);
      if (!liveCatalogs.length && Array.isArray(backup)) writeJson(CINEMETA_CATALOG_BACKUP_KEY, backup);
      return;
    }
    const originalCatalogs = Array.isArray(originalCinemeta?.catalogs) ? originalCinemeta.catalogs : [];
    for (const catalog of targets) {
      const original = originalCatalogs.find((item) => catalogKey(item) === catalogKey(catalog));
      restoreOptionalSearch(catalog, original);
    }
    if (!liveCatalogs.length && Array.isArray(backup)) writeJson(CINEMETA_CATALOG_BACKUP_KEY, backup);
  }

  function applyCinemetaCatalogsPatch(addon, remove) {
    if (remove) {
      const current = getCatalogs(addon);
      if (current.length) writeJson(CINEMETA_CATALOG_BACKUP_KEY, JSON.parse(JSON.stringify(current)));
      addon.manifest.catalogs = current.filter((catalog) => {
        if (catalogKind(catalog) === 'search') return true;
        if (catalogHasOptionalSearch(catalog)) {
          patchCatalogFlags(addon, catalog, { home: false, discover: false });
          return true;
        }
        return false;
      });
      return;
    }
    const backup = readJson(CINEMETA_CATALOG_BACKUP_KEY, null);
    const catalogs =
      Array.isArray(backup) && backup.length
        ? backup
        : Array.isArray(originalCinemeta?.catalogs)
          ? JSON.parse(JSON.stringify(originalCinemeta.catalogs))
          : [];
    addon.manifest.catalogs = catalogs;
    writeJson(CINEMETA_CATALOG_BACKUP_KEY, null);
    if (cinemetaSearchRemoved(addon) && catalogs.some(catalogHasOptionalSearch)) {
      applyCinemetaSearchPatch(addon, true);
    }
  }

  function applyCinemetaMetadataPatch(addon, remove) {
    const resources = Array.isArray(addon.manifest.resources) ? addon.manifest.resources.slice() : [];
    if (remove) {
      rememberOriginalMetaResources([addon]);
      addon.manifest.resources = resources.filter((resource) => resourceName(resource) !== 'meta');
      return;
    }
    if (!resources.some((resource) => resourceName(resource) === 'meta')) {
      resources.push(fallbackMetaResource(addon));
      addon.manifest.resources = resources;
    }
  }

  function extractMetaResource(addon) {
    return (addon?.manifest?.resources || []).find((resource) => resourceName(resource) === 'meta') || null;
  }

  function cloneMetaResource(resource) {
    if (resource == null) return null;
    if (typeof resource === 'string') return resource;
    try {
      return JSON.parse(JSON.stringify(resource));
    } catch (_) {
      return resource;
    }
  }

  function isStructuredMetaResource(resource) {
    return Boolean(resource) && typeof resource === 'object';
  }

  function readMetadataResources() {
    const stored = readJson(METADATA_RESOURCE_KEY, {});
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  }

  function writeMetadataResources(map) {
    const current = readMetadataResources();
    const merged = { ...current };
    for (const [key, value] of Object.entries(map && typeof map === 'object' ? map : {})) {
      if (isStructuredMetaResource(current[key]) && !isStructuredMetaResource(value)) continue;
      if (value == null) continue;
      merged[key] = value;
    }
    writeJson(METADATA_RESOURCE_KEY, merged);
  }

  function rememberOriginalMetaResources(addons) {
    const map = readMetadataResources();
    let changed = false;
    for (const addon of addons || []) {
      const transport = addonTransport(addon);
      if (!transport) continue;
      const resource = isCinemeta(addon)
        ? extractMetaResource({ manifest: originalCinemeta || addon.manifest }) || extractMetaResource(addon)
        : extractMetaResource(addon);
      if (!resource) continue;
      const existing = map[transport];
      if (isStructuredMetaResource(resource)) {
        if (JSON.stringify(existing) !== JSON.stringify(resource)) {
          map[transport] = cloneMetaResource(resource);
          changed = true;
        }
        continue;
      }
      if (existing != null) continue;
      if (resource === 'meta' || resourceName(resource) === 'meta') {
        map[transport] = typeof resource === 'string' ? resource : cloneMetaResource(resource);
        changed = true;
      }
    }
    if (changed) writeMetadataResources(map);
    return map;
  }

  function rememberOriginalMetaResourcesFromBackup() {
    try {
      const raw = localStorage.getItem(BACKUP_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      rememberOriginalMetaResources(parsed?.addons);
    } catch (_) {}
  }

  function originalMetaResource(addon) {
    if (isCinemeta(addon)) {
      const fromOriginal = (originalCinemeta?.resources || []).find((resource) => resourceName(resource) === 'meta');
      if (fromOriginal) return cloneMetaResource(fromOriginal);
    }
    const transport = addonTransport(addon);
    const stored = transport ? readMetadataResources()[transport] : null;
    if (isStructuredMetaResource(stored)) return cloneMetaResource(stored);
    const live = (liveAddons || []).find((item) => sameTransport(item, transport));
    const liveMeta = extractMetaResource(live);
    if (isStructuredMetaResource(liveMeta)) return cloneMetaResource(liveMeta);
    if (stored === 'meta' || liveMeta === 'meta') return 'meta';
    if (stored != null) return cloneMetaResource(stored);
    if (liveMeta != null) return cloneMetaResource(liveMeta);
    return null;
  }

  function inferMetaIdPrefixes(addon) {
    const prefixes = [];
    const seen = new Set();
    const push = (value) => {
      const prefix = String(value || '').trim();
      if (!prefix || seen.has(prefix)) return;
      seen.add(prefix);
      prefixes.push(prefix);
    };
    const resource = originalMetaResource(addon) || extractMetaResource(addon);
    if (resource && typeof resource === 'object') {
      const fromResource = resource.idPrefixes || resource.id_prefixes;
      if (Array.isArray(fromResource)) fromResource.forEach(push);
    }
    const fromManifest = addon?.manifest?.idPrefixes || addon?.manifest?.id_prefixes;
    if (Array.isArray(fromManifest)) fromManifest.forEach(push);
    const haystack = `${addonTransport(addon)} ${addon?.manifest?.id || ''} ${addon?.manifest?.name || ''}`;
    if (/kitsu/i.test(haystack)) push('kitsu:');
    if (/\btmdb\b/i.test(haystack)) push('tmdb:');
    return prefixes;
  }

  function looksLikeKitsuAddon(addon) {
    if (!addon) return false;
    const haystack = `${addonTransport(addon)} ${addon?.manifest?.id || ''} ${addon?.manifest?.name || ''}`;
    if (/kitsu/i.test(haystack)) return true;
    return inferMetaIdPrefixes(addon).some((prefix) => String(prefix).toLowerCase().startsWith('kitsu'));
  }

  function healPrefixMetaAddons(addons) {
    for (const addon of addons || []) {
      if (isCinemeta(addon) || !looksLikeKitsuAddon(addon)) continue;
      if (!hasMetaResource(addon)) applyAddonMetadataPatch(addon, false);
    }
    return addons;
  }

  function fallbackMetaResource(addon) {
    const original = originalMetaResource(addon);
    if (original === 'meta') return 'meta';
    if (isStructuredMetaResource(original)) return cloneMetaResource(original);
    if (original != null) return cloneMetaResource(original);
    const live = extractMetaResource(addon);
    if (live === 'meta') return 'meta';
    if (live != null) return cloneMetaResource(live);
    return 'meta';
  }

  function applyAddonMetadataPatch(addon, remove) {
    if (isCinemeta(addon)) {
      applyCinemetaMetadataPatch(addon, remove);
      return;
    }
    const resources = Array.isArray(addon.manifest.resources) ? addon.manifest.resources.slice() : [];
    if (remove) {
      if (looksLikeKitsuAddon(addon)) {
        if (!resources.some((resource) => resourceName(resource) === 'meta')) {
          resources.push(fallbackMetaResource(addon));
          addon.manifest.resources = resources;
        }
        return;
      }
      rememberOriginalMetaResources([addon]);
      addon.manifest.resources = resources.filter((resource) => resourceName(resource) !== 'meta');
      return;
    }
    if (!resources.some((resource) => resourceName(resource) === 'meta')) {
      resources.push(fallbackMetaResource(addon));
      addon.manifest.resources = resources;
    }
  }

  function metadataKeyForAddon(addon) {
    if (isCinemeta(addon)) return '';
    return addonTransport(addon);
  }

  function sameMetadataValue(left, right) {
    const a = String(left ?? '');
    const b = String(right ?? '');
    if (a === '' || b === '') return a === b;
    return normalizeTransport(a) === normalizeTransport(b);
  }

  function findAddonForMetadataValue(addons, value, used) {
    return addons.findIndex((addon, index) => {
      if (used.has(index)) return false;
      return sameMetadataValue(metadataKeyForAddon(addon), value);
    });
  }

  function uniqueMetadataValues(values) {
    return (Array.isArray(values) ? values : [values])
      .map((item) => String(item ?? ''))
      .filter((item, index, list) => list.findIndex((entry) => sameMetadataValue(entry, item)) === index);
  }

  function metaIdPrefixes(addon) {
    if (isCinemeta(addon)) {
      const resource = originalMetaResource(addon) || extractMetaResource(addon);
      const prefixes = resource?.idPrefixes || resource?.id_prefixes;
      if (Array.isArray(prefixes) && prefixes.length) return prefixes.map(String);
      return ['tt'];
    }
    const resource = originalMetaResource(addon) || extractMetaResource(addon);
    if (typeof resource === 'object' && resource) {
      const prefixes = resource.idPrefixes || resource.id_prefixes;
      if (Array.isArray(prefixes) && prefixes.length) return prefixes.map(String);
    }
    return [];
  }

  function prefixesOverlap(left, right) {
    const a = metaIdPrefixes(left);
    const b = metaIdPrefixes(right);
    if (!a.length || !b.length) return false;
    return a.some((prefix) =>
      b.some((other) => prefix === other || prefix.startsWith(other) || other.startsWith(prefix))
    );
  }

  function restoreAddonOrderFromBackup(addons) {
    try {
      const raw = localStorage.getItem(BACKUP_KEY);
      if (!raw) return addons;
      const parsed = JSON.parse(raw);
      const backup = parsed?.addons;
      if (!Array.isArray(backup) || !backup.length) return addons;
      const byTransport = new Map();
      for (const addon of addons || []) {
        const transport = addonTransport(addon);
        if (transport && !byTransport.has(transport)) byTransport.set(transport, addon);
      }
      const ordered = [];
      const used = new Set();
      for (const item of backup) {
        const transport = addonTransport(item);
        const live = transport ? byTransport.get(transport) : null;
        if (!live) continue;
        ordered.push(live);
        used.add(transport);
      }
      for (const addon of addons || []) {
        const transport = addonTransport(addon);
        if (transport && used.has(transport)) continue;
        ordered.push(addon);
      }
      return ordered;
    } catch (_) {
      return addons;
    }
  }

  function manifestUrlForAddon(addon) {
    const raw = String(addonTransportUrl(addon) || '').trim();
    if (!raw) return '';
    if (/manifest\.json(?:\?|$)/i.test(raw)) return raw;
    return `${raw.replace(/\/+$/, '')}/manifest.json`;
  }

  async function fetchAddonManifest(addon) {
    const url = manifestUrlForAddon(addon);
    if (!url) return null;
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return await response.json();
    } catch (_) {
      return null;
    }
  }

  async function hydrateOriginalMetaResources(addons) {
    rememberOriginalMetaResources(addons);
    rememberOriginalMetaResourcesFromBackup();
    const map = readMetadataResources();
    const pending = [];
    for (const addon of addons || []) {
      if (isCinemeta(addon)) continue;
      const transport = addonTransport(addon);
      if (!transport) continue;
      if (isStructuredMetaResource(map[transport])) continue;
      const live = extractMetaResource(addon);
      if (isStructuredMetaResource(live)) {
        map[transport] = cloneMetaResource(live);
        continue;
      }
      if (live === 'meta' && map[transport] == null) {
        map[transport] = 'meta';
      }
      pending.push(
        fetchAddonManifest(addon).then((manifest) => {
          const resource = (manifest?.resources || []).find((item) => resourceName(item) === 'meta');
          if (isStructuredMetaResource(resource)) {
            map[transport] = cloneMetaResource(resource);
            return;
          }
          if (resourceName(resource) === 'meta' && !isStructuredMetaResource(map[transport])) {
            map[transport] = typeof resource === 'string' ? resource : 'meta';
          }
        })
      );
    }
    if (pending.length) await Promise.all(pending);
    writeMetadataResources(map);
    return map;
  }

  function readMetadataCapable() {
    const stored = readJson(METADATA_CAPABLE_KEY, []);
    return new Set(Array.isArray(stored) ? stored.map((item) => normalizeTransport(item)).filter(Boolean) : []);
  }

  function writeMetadataCapable(set) {
    writeJson(METADATA_CAPABLE_KEY, [...set]);
  }

  function rememberMetadataCapable(addons) {
    const set = readMetadataCapable();
    for (const addon of addons || []) {
      if (isCinemeta(addon) || !hasMetaResource(addon)) continue;
      const transport = addonTransport(addon);
      if (transport) set.add(transport);
    }
    writeMetadataCapable(set);
    return set;
  }

  function rememberMetadataCapableFromBackup() {
    try {
      const raw = localStorage.getItem(BACKUP_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      rememberMetadataCapable(parsed?.addons);
      rememberOriginalMetaResources(parsed?.addons);
    } catch (_) {}
  }

  function isMetadataCapable(addon) {
    if (isCinemeta(addon)) return true;
    if (hasMetaResource(addon)) return true;
    const transport = addonTransport(addon);
    return Boolean(transport && readMetadataCapable().has(transport));
  }

  function hasExplicitMetadataSelection() {
    if (!METADATA_SELECTION_ENABLED) return false;
    return Boolean(String(getMetadataAddon() || '').trim()) || metadataTouchedThisSession;
  }

  function restoreAllAddonMetadata(addons) {
    const next = cloneAddons(addons);
    const selected = uniqueMetadataValues(selectedMetadataValues());
    const want = new Set(selected.filter(Boolean).map((item) => normalizeTransport(item)));
    for (const addon of next) {
      if (isCinemeta(addon)) {
        applyCinemetaMetadataPatch(addon, false);
        continue;
      }
      const transport = addonTransport(addon);
      if (isMetadataCapable(addon) || hasMetaResource(addon) || (transport && want.has(transport))) {
        applyAddonMetadataPatch(addon, false);
      }
    }
    return next;
  }

  function implicitMetadataValues(addons) {
    const values = [];
    for (const addon of addons || []) {
      if (!hasMetaResource(addon)) continue;
      const value = isCinemeta(addon) ? '' : addonTransport(addon);
      if (!value && !isCinemeta(addon)) continue;
      if (!values.some((item) => sameMetadataValue(item, value))) values.push(value);
    }
    return values.length ? values : [''];
  }

  function applyMetadataPreference(addons, _selectedValues) {
    rememberMetadataCapable(addons);
    rememberOriginalMetaResources(addons);
    rememberOriginalMetaResources(liveAddons);
    rememberOriginalMetaResourcesFromBackup();
    rememberMetadataCapableFromBackup();
    return restoreAllAddonMetadata(addons);
  }

  function syncMetadataOrderFromAddons(addons) {
    if (!hasExplicitMetadataSelection()) return;
    const selected = selectedMetadataValues();
    if (!selected.length) return;
    const next = [];
    for (const addon of addons || []) {
      const value = metadataKeyForAddon(addon);
      if (!selected.some((item) => sameMetadataValue(item, value))) continue;
      if (!next.some((item) => sameMetadataValue(item, value))) next.push(value);
    }
    for (const item of selected) {
      if (!next.some((entry) => sameMetadataValue(entry, item))) next.push(item);
    }
    setMetadataAddons(next.length ? next : ['']);
  }

  async function fetchCinemetaManifest(addon) {
    const raw = addonTransportUrl(addon);
    const manifestUrl = /manifest\.json/i.test(raw)
      ? raw
      : `${String(raw || '').replace(/\/+$/, '')}/manifest.json`;
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function resetCinemetaAddon(addon) {
    let manifest = originalCinemeta;
    try {
      manifest = await fetchCinemetaManifest(addon);
      originalCinemeta = JSON.parse(JSON.stringify(manifest));
      writeJson(CINEMETA_ORIGINAL_KEY, originalCinemeta);
    } catch (error) {
      if (!manifest) throw error;
    }
    addon.manifest = JSON.parse(JSON.stringify(manifest));
    writeJson(CINEMETA_CATALOG_BACKUP_KEY, null);
    applyCinemetaMetadataPatch(addon, false);
  }

  async function getAuthKey() {
    try {
      const core = getCore();
      if (core?.getState) {
        const ctx = await core.getState('ctx');
        return ctx?.profile?.auth?.key || ctx?.auth?.key || null;
      }
    } catch (_) {}
    try {
      const profile = JSON.parse(localStorage.getItem('profile') || '{}');
      return profile?.auth?.key || null;
    } catch (_) {}
    return null;
  }

  async function loadLiveAddons() {
    try {
      const core = getCore();
      if (!core?.getState) return liveAddons || [];
      const ctx = await core.getState('ctx');
      const addons = ctx?.profile?.addons || ctx?.addons || [];
      liveAddons = Array.isArray(addons) ? addons : [];
      rememberMetadataCapableFromBackup();
      rememberOriginalMetaResourcesFromBackup();
      rememberMetadataCapable(liveAddons);
      rememberOriginalMetaResources(liveAddons);
      void hydrateOriginalMetaResources(liveAddons);
      const cinemeta = findCinemeta(liveAddons);
      if (cinemeta) rememberOriginalCinemeta(cinemeta);
      refreshVisibilitySurfaces();
      return liveAddons;
    } catch (_) {
      return liveAddons || [];
    }
  }

  function workingAddons() {
    return draft || cloneAddons(liveAddons || []);
  }

  function markDirty(nextAddons) {
    draft = cloneAddons(nextAddons);
    dirty = collectionSignature(draft) !== collectionSignature(liveAddons || []);
    paintSyncButton();
    paintMetadataChip();
    refreshListPreserveScroll();
  }

  function mutateDraft(mutate) {
    const next = cloneAddons(workingAddons());
    mutate(next);
    markDirty(next);
  }

  function adoptLiveCollection(live) {
    const nextLive = cloneAddons(live || []);
    for (const key of [...locallyRemoved]) {
      if (!nextLive.some((addon) => addonTransport(addon) === key)) locallyRemoved.delete(key);
    }
    liveAddons = nextLive;
    rememberMetadataCapable(nextLive);
    if (!dirty) {
      const changed = collectionSignature(nextLive) !== collectionSignature(draft || []);
      draft = cloneAddons(nextLive);
      paintSyncButton();
      paintMetadataChip();
      refreshVisibilitySurfaces();
      if (changed) refreshListPreserveScroll();
      return;
    }
    const current = workingAddons();
    const have = new Set(current.map((addon) => addonTransport(addon)));
    const extras = nextLive.filter((addon) => {
      const key = addonTransport(addon);
      return Boolean(key) && !have.has(key) && !locallyRemoved.has(key);
    });
    if (extras.length) draft = cloneAddons(current.concat(extras));
    dirty = collectionSignature(draft || []) !== collectionSignature(liveAddons);
    paintSyncButton();
    paintMetadataChip();
    refreshVisibilitySurfaces();
    if (extras.length) refreshListPreserveScroll();
  }

  async function pullLiveAndAdopt() {
    if (!isInstalledAddonsRoute()) return;
    adoptLiveCollection(await loadLiveAddons());
  }

  function hasNativeDialog() {
    return Boolean(document.querySelector('[class*="modal-dialog-container"]'));
  }

  function syncNativeDialogState() {
    const open = hasNativeDialog();
    if (nativeDialogOpen && !open) {
      nativeDialogOpen = false;
      void pullLiveAndAdopt();
      window.setTimeout(() => void pullLiveAndAdopt(), 300);
      window.setTimeout(() => void pullLiveAndAdopt(), 1000);
      return;
    }
    nativeDialogOpen = open;
  }

  function writeBackup(addons) {
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify({ at: Date.now(), addons: cloneAddons(addons) }));
    } catch (_) {}
  }

  function ensureBackup(addons) {
    try {
      if (localStorage.getItem(BACKUP_KEY)) return;
      writeBackup(addons);
    } catch (_) {}
  }

  function removeAddonFromBackup(transport) {
    if (!transport) return;
    try {
      const raw = localStorage.getItem(BACKUP_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const addons = parsed?.addons;
      if (!Array.isArray(addons)) return;
      writeBackup(addons.filter((item) => addonTransport(item) !== transport));
    } catch (_) {}
  }

  function getMetadataAddon() {
    return window.StremioCustom?.helpers?.getMetadataAddon?.() || '';
  }

  function getMetadataAddons() {
    if (typeof window.StremioCustom?.helpers?.getMetadataAddons === 'function') {
      return window.StremioCustom.helpers.getMetadataAddons();
    }
    const raw = getMetadataAddon();
    if (!raw) return [];
    if (String(raw).startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed
            .map((item) => String(item ?? '').trim())
            .filter((item, index, list) => list.indexOf(item) === index);
        }
      } catch (_) {}
    }
    return [raw];
  }

  function setMetadataAddons(values) {
    if (typeof window.StremioCustom?.helpers?.setMetadataAddons === 'function') {
      window.StremioCustom.helpers.setMetadataAddons(values);
      return;
    }
    window.StremioCustom?.helpers?.setMetadataAddon?.(
      Array.isArray(values) && values.length ? JSON.stringify(values) : ''
    );
  }

  function setMetadataAddon(value) {
    const text = String(value || '').trim();
    setMetadataAddons(text ? [text] : []);
  }

  function showToast(message) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.dataset.visible = 'true';
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.dataset.visible = 'false';
    }, 2800);
  }

  function closeConfirmDialog() {
    document.getElementById(CONFIRM_ID)?.remove();
  }

  function confirmUninstall(message) {
    return new Promise((resolve) => {
      closeConfirmDialog();
      const overlay = document.createElement('div');
      overlay.id = CONFIRM_ID;
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      const box = document.createElement('div');
      box.className = 'mystremio-am-confirm-box';
      const text = document.createElement('p');
      text.textContent = message;
      const actions = document.createElement('div');
      actions.className = 'mystremio-am-confirm-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = t('Cancel', 'Abbrechen');
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.dataset.role = 'ok';
      ok.textContent = t('Uninstall', 'Deinstallieren');
      const finish = (value) => {
        overlay.remove();
        resolve(value);
      };
      cancel.addEventListener('click', () => finish(false));
      ok.addEventListener('click', () => finish(true));
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) finish(false);
      });
      actions.append(cancel, ok);
      box.append(text, actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      ok.focus();
    });
  }

  function withDomLock(fn) {
    domLock += 1;
    try {
      observer?.disconnect();
      return fn();
    } finally {
      window.requestAnimationFrame(() => {
        domLock = Math.max(0, domLock - 1);
        const node = document.body || document.documentElement;
        if (node && observer && !domLock) observer.observe(node, { childList: true, subtree: true });
      });
    }
  }

  function findAddonsRoot() {
    return (
      document.querySelector('[class*="addons-content"]') ||
      document.querySelector('[class*="addons-container"]')
    );
  }

  function findAddonsHost() {
    return document.querySelector('[class*="addons-content"]') || findAddonsRoot();
  }

  function mountIntoAddonsHost(node) {
    const host = findAddonsHost();
    if (!host || !node) return;
    if (node.parentElement !== host) host.appendChild(node);
  }

  function findSelectableInputs() {
    return findAddonsRoot()?.querySelector('[class*="selectable-inputs-container"]') || null;
  }

  function positionOverlays() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    const root = document.getElementById(ROOT_ID);
    if (toolbar) toolbar.style.top = '';
    if (root) root.style.top = '';
    positionSourceMenu();
  }

  function mountManagerRoot() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
    }
    mountIntoAddonsHost(root);
    positionOverlays();
    return root;
  }

  function findStockAddButton() {
    const inputs = findSelectableInputs();
    if (!inputs) return null;
    const nodes = [...inputs.querySelectorAll('button, a, [role="button"]')];
    return (
      nodes.find((el) =>
        /add\s*addon|addon\s*hinzufügen|addon\s*hinzufuegen/i.test(
          `${el.textContent || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`
        )
      ) || null
    );
  }

  function mountToolbarIntoNativeBar(bar) {
    const inputs = findSelectableInputs();
    if (!inputs || !bar) return false;
    const addButton = findStockAddButton();
    const addContainer = addButton?.closest('[class*="add-button-container"]') || addButton;
    if (addContainer && addContainer.parentElement === inputs) {
      if (bar.parentElement !== inputs || bar.previousElementSibling !== addContainer) {
        inputs.insertBefore(bar, addContainer.nextSibling);
      }
      return true;
    }
    const search =
      inputs.querySelector('[class*="search-bar"]') || inputs.querySelector('input')?.closest('div');
    if (search && search.parentElement === inputs) {
      if (bar.parentElement !== inputs || bar.nextElementSibling !== search) {
        inputs.insertBefore(bar, search);
      }
      return true;
    }
    if (bar.parentElement !== inputs) inputs.appendChild(bar);
    return true;
  }

  function mapStockTypeLabel(text) {
    const value = String(text || '').trim().toLowerCase();
    if (!value || /^(all|alle|all types|alle typen)\b/.test(value)) return '';
    const types = addonTypes(workingAddons());
    const exact = types.find(
      (type) => type.toLowerCase() === value || typeLabel(type).toLowerCase() === value
    );
    return exact || '';
  }

  function syncFilterTypeFromStock() {
    const inputs = findSelectableInputs();
    const label = inputs?.querySelector('[class*="select-input-container"] [class*="label"]');
    const next = mapStockTypeLabel(label?.textContent);
    if (next === filterType) return;
    filterType = next;
    refreshListPreserveScroll();
  }

  function bindStockFilters() {
    const inputs = findSelectableInputs();
    if (!inputs) return;
    const search = inputs.querySelector('input');
    if (search && search.dataset.msAmSearch !== '1') {
      search.dataset.msAmSearch = '1';
      filterQuery = search.value || filterQuery;
      search.addEventListener('input', () => {
        filterQuery = search.value;
        refreshListPreserveScroll();
      });
    }
    if (inputs.dataset.msAmType !== '1') {
      inputs.dataset.msAmType = '1';
      inputs.addEventListener(
        'click',
        () => {
          window.setTimeout(syncFilterTypeFromStock, 0);
        },
        true
      );
    }
  }

  function paintSyncButton() {
    const text = persistBusy
      ? t('Syncing…', 'Synchronisiere…')
      : dirty
        ? t('Sync to Stremio', 'Mit Stremio synchronisieren')
        : t('Synced', 'Synchron');
    const dirtyFlag = dirty ? 'true' : 'false';
    const disabled = persistBusy || !dirty;
    document.querySelectorAll(`#${TOOLBAR_ID} .mystremio-am-sync`).forEach((sync) => {
      if (sync.dataset.dirty !== dirtyFlag) sync.dataset.dirty = dirtyFlag;
      if (sync.disabled !== disabled) sync.disabled = disabled;
      if (sync.textContent !== text) sync.textContent = text;
    });
  }

  function selectedMetadataValues() {
    if (!hasExplicitMetadataSelection()) return implicitMetadataValues(workingAddons());
    const stored = getMetadataAddons().map((item) => normalizeTransport(item));
    if (!stored.length) return [''];
    return stored;
  }

  function metadataOptions(addons) {
    const selectedValues = selectedMetadataValues();
    const all = [
      {
        value: '',
        label: t('Default (Cinemeta)', 'Standard (Cinemeta)'),
      },
      ...metaAddonOptions(addons).filter((option) => option.value),
    ].filter(
      (option, index, list) => list.findIndex((item) => sameMetadataValue(item.value, option.value)) === index
    );
    const used = new Set();
    const picked = [];
    for (const value of selectedValues) {
      const index = all.findIndex((option, i) => !used.has(i) && sameMetadataValue(option.value, value));
      if (index < 0) continue;
      used.add(index);
      picked.push(Object.assign({}, all[index], { selected: true }));
    }
    const rest = all
      .filter((_, index) => !used.has(index))
      .map((option) => Object.assign({}, option, { selected: false }));
    return picked.concat(rest);
  }

  function paintMetadataChip() {
    if (!METADATA_SELECTION_ENABLED) return;
    const chip = document.querySelector(`#${TOOLBAR_ID} .mystremio-am-chip`);
    if (!chip) return;
    const chosen = metadataOptions(workingAddons()).filter((option) => option.selected);
    const value = chip.querySelector('[data-role="value"]');
    let label = t('Default (Cinemeta)', 'Standard (Cinemeta)');
    if (chosen.length === 1) label = chosen[0].label;
    else if (chosen.length > 1) label = `${chosen[0].label} + ${chosen.length - 1}`;
    if (value) value.textContent = label;
    chip.setAttribute('aria-expanded', sourceMenuOpen ? 'true' : 'false');
  }

  function ensureSourceMenu() {
    if (!METADATA_SELECTION_ENABLED) return null;
    let menu = document.getElementById(SOURCE_MENU_ID);
    if (!menu) {
      menu = document.createElement('div');
      menu.id = SOURCE_MENU_ID;
      menu.className = 'mystremio-am-menu';
      menu.dataset.open = 'false';
    }
    mountIntoAddonsHost(menu);
    return menu;
  }

  function positionSourceMenu() {
    const menu = document.getElementById(SOURCE_MENU_ID);
    const chip = document.querySelector(`#${TOOLBAR_ID} .mystremio-am-chip`);
    const host = findAddonsHost();
    if (!menu || !chip || !host || menu.dataset.open !== 'true') return;
    const hostRect = host.getBoundingClientRect();
    const rect = chip.getBoundingClientRect();
    menu.style.top = `${Math.round(rect.bottom - hostRect.top + 6)}px`;
    menu.style.right = `${Math.max(12, Math.round(hostRect.right - rect.right))}px`;
    menu.style.left = 'auto';
  }

  function renderSourceMenuOptions() {
    if (!METADATA_SELECTION_ENABLED) return;
    const menu = ensureSourceMenu();
    if (!menu) return;
    const options = metadataOptions(workingAddons());
    const selectedCount = options.filter((option) => option.selected).length;
    let selectedIndex = 0;
    menu.replaceChildren(
      ...options.map((option) => {
        const row = document.createElement('div');
        row.className = 'mystremio-am-option-row';
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'mystremio-am-option';
        item.textContent = option.label;
        item.setAttribute('role', 'menuitemcheckbox');
        item.setAttribute('aria-checked', option.selected ? 'true' : 'false');
        item.setAttribute('aria-selected', option.selected ? 'true' : 'false');
        item.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleMetadataSource(option.value);
        });
        row.appendChild(item);
        if (option.selected) {
          const index = selectedIndex;
          selectedIndex += 1;
          const up = document.createElement('button');
          up.type = 'button';
          up.className = 'mystremio-am-order';
          up.title = t('Higher priority', 'Höhere Priorität');
          up.setAttribute('aria-label', t('Higher priority', 'Höhere Priorität'));
          up.innerHTML = ICON_UP;
          up.disabled = index === 0;
          up.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            moveMetadataSource(option.value, -1);
          });
          const down = document.createElement('button');
          down.type = 'button';
          down.className = 'mystremio-am-order';
          down.title = t('Lower priority', 'Niedrigere Priorität');
          down.setAttribute('aria-label', t('Lower priority', 'Niedrigere Priorität'));
          down.innerHTML = ICON_DOWN;
          down.disabled = index === selectedCount - 1;
          down.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            moveMetadataSource(option.value, 1);
          });
          row.append(up, down);
        }
        return row;
      })
    );
    menu.dataset.open = sourceMenuOpen ? 'true' : 'false';
    if (sourceMenuOpen) positionSourceMenu();
  }

  function setSourceMenuOpen(open) {
    if (!METADATA_SELECTION_ENABLED) {
      sourceMenuOpen = false;
      return;
    }
    sourceMenuOpen = Boolean(open);
    const menu = ensureSourceMenu();
    menu.dataset.open = sourceMenuOpen ? 'true' : 'false';
    paintMetadataChip();
    if (sourceMenuOpen) {
      renderSourceMenuOptions();
      positionSourceMenu();
    }
  }

  function toggleSourceMenu(event) {
    if (!METADATA_SELECTION_ENABLED) return;
    event.preventDefault();
    event.stopPropagation();
    setSourceMenuOpen(!sourceMenuOpen);
  }

  function closeMenus(event) {
    const target = event?.target;
    if (target?.closest?.(`#${TOOLBAR_ID} .mystremio-am-chip, #${SOURCE_MENU_ID}`)) return;
    if (!sourceMenuOpen) return;
    setSourceMenuOpen(false);
  }

  function ensureExtraToolbar(force) {
    let bar = document.getElementById(TOOLBAR_ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = TOOLBAR_ID;
    }
    mountToolbarIntoNativeBar(bar);
    if (!force && bar.childElementCount) {
      paintSyncButton();
      if (METADATA_SELECTION_ENABLED) paintMetadataChip();
      positionOverlays();
      return;
    }
    const sync = document.createElement('button');
    sync.type = 'button';
    sync.className = 'mystremio-am-sync';
    sync.addEventListener('click', (event) => {
      event.stopPropagation();
      void syncDraft();
    });
    if (!METADATA_SELECTION_ENABLED) {
      bar.replaceChildren(sync);
      paintSyncButton();
      positionOverlays();
      return;
    }
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'mystremio-am-chip';
    chip.setAttribute('aria-haspopup', 'menu');
    chip.setAttribute('aria-expanded', sourceMenuOpen ? 'true' : 'false');
    chip.setAttribute('aria-label', t('Metadata source', 'Metadatenquelle'));
    chip.title = t('Metadata source', 'Metadatenquelle');
    chip.innerHTML = `<span data-role="value"></span><span class="mystremio-am-chip-caret" aria-hidden="true">${ICON_EXPAND}</span>`;
    chip.addEventListener('click', toggleSourceMenu);
    bar.replaceChildren(chip, sync);
    paintSyncButton();
    paintMetadataChip();
    ensureSourceMenu();
    if (sourceMenuOpen) renderSourceMenuOptions();
    positionOverlays();
  }

  function addonLogoUrl(addon) {
    const raw = String(
      addon?.manifest?.logo || addon?.manifest?.icon || addon?.manifest?.background || ''
    ).trim();
    if (!raw) return '';
    try {
      return new URL(raw, addonTransportUrl(addon) || location.href).href;
    } catch (_) {
      return raw;
    }
  }

  function addonLogoFallback(addon) {
    const name = String(addon?.manifest?.name || '?').trim();
    return (name.charAt(0) || '?').toUpperCase();
  }

  function setAddonLogo(slot, addon) {
    slot.replaceChildren();
    const url = addonLogoUrl(addon);
    const fallback = document.createElement('div');
    fallback.className = 'mystremio-am-logo-fallback';
    fallback.textContent = addonLogoFallback(addon);
    if (!url) {
      slot.appendChild(fallback);
      return;
    }
    const logo = document.createElement('img');
    logo.className = 'mystremio-am-logo';
    logo.alt = '';
    logo.referrerPolicy = 'no-referrer';
    logo.decoding = 'async';
    logo.addEventListener(
      'error',
      () => {
        slot.replaceChildren(fallback);
      },
      { once: true }
    );
    logo.src = url;
    slot.appendChild(logo);
  }

  function addonTypes(addons) {
    const types = new Set();
    for (const addon of addons || []) {
      for (const type of addon?.manifest?.types || []) {
        if (type) types.add(String(type));
      }
      for (const catalog of getCatalogs(addon)) {
        if (catalog?.type) types.add(String(catalog.type));
      }
    }
    return [...types].sort();
  }

  function typeLabel(type) {
    const labels = {
      movie: t('Movies', 'Filme'),
      series: t('Series', 'Serien'),
      channel: t('Channels', 'Kanäle'),
      tv: t('TV', 'TV'),
      anime: t('Anime', 'Anime'),
    };
    return labels[type] || type;
  }

  function addonMatchesFilters(addon) {
    if (filterType) {
      const types = new Set([
        ...(addon?.manifest?.types || []).map(String),
        ...getCatalogs(addon).map((catalog) => String(catalog?.type || '')),
      ]);
      if (!types.has(filterType)) return false;
    }
    const query = filterQuery.trim().toLowerCase();
    if (!query) return true;
    const hay = [addon?.manifest?.name, addon?.manifest?.description, addonTransport(addon)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(query);
  }

  function metaAddonOptions(addons) {
    rememberMetadataCapable(addons);
    return addons
      .filter((addon) => addonTransport(addon) && isMetadataCapable(addon))
      .map((addon) => ({
        value: isCinemeta(addon) ? '' : addonTransport(addon),
        label: isCinemeta(addon)
          ? t('Default (Cinemeta)', 'Standard (Cinemeta)')
          : String(addon?.manifest?.name || addonTransport(addon)),
      }))
      .filter((option, index, list) => list.findIndex((item) => item.value === option.value) === index);
  }

  function currentMetadataSelection(addons) {
    const stored = normalizeTransport(getMetadataAddon());
    const cinemeta = findCinemeta(addons);
    if (cinemeta && cinemetaMetadataRemoved(cinemeta) && stored) return stored;
    if (cinemeta && cinemetaMetadataRemoved(cinemeta) && !stored) {
      const other = addons.find((addon) => !isCinemeta(addon) && hasMetaResource(addon));
      return other ? addonTransport(other) : '';
    }
    return stored;
  }

  function isSoftDisabled(addon) {
    return Boolean(window.StremioCustomAddonSoftDisable?.isDisabledUrl?.(addonTransport(addon)));
  }

  function setSoftDisabled(addon, disabled) {
    window.StremioCustomAddonSoftDisable?.setDisabledAddonUrl?.(addonTransport(addon), disabled);
  }

  function configureUrl(addon) {
    const raw = addonTransportUrl(addon);
    if (!raw) return '';
    return /manifest\.json/i.test(raw)
      ? raw.replace(/\/manifest\.json(?:\?.*)?$/i, '/configure')
      : `${raw.replace(/\/+$/, '')}/configure`;
  }

  function isConfigurable(addon) {
    return Boolean(
      addon?.manifest?.behaviorHints?.configurable || addon?.manifest?.behaviorHints?.configurationRequired
    );
  }

  function isProtected(addon) {
    return Boolean(addon?.flags?.protected);
  }

  async function uninstallAddon(addon) {
    const name = String(addon?.manifest?.name || addonTransport(addon));
    const ok = await confirmUninstall(t(`Uninstall “${name}”?`, `„${name}“ deinstallieren?`));
    if (!ok) return;
    const transport = addonTransport(addon);
    if (transport) locallyRemoved.add(transport);
    const descriptor = {
      transportUrl: addonTransportUrl(addon),
      manifest: addon.manifest,
      flags: addon.flags || { official: false, protected: false },
    };
    try {
      const core = getCore();
      if (core?.dispatch) {
        await core.dispatch({ action: 'Ctx', args: { action: 'UninstallAddon', args: descriptor } });
      }
    } catch (error) {
      console.warn('[StremioCustom] UninstallAddon dispatch failed:', error);
    }
    mutateDraft((addons) => {
      const index = addons.findIndex((item) => sameTransport(item, transport));
      if (index >= 0) addons.splice(index, 1);
    });
    removeAddonFromBackup(transport);
    void persistAddons(workingAddons());
  }

  async function persistAddons(nextAddons, options) {
    const silent = Boolean(options?.silent);
    if (persistBusy) {
      persistQueued = true;
      persistQueuedAddons = nextAddons;
      persistQueuedSilent = silent;
      return false;
    }
    const authKey = await getAuthKey();
    if (!authKey) {
      if (!silent) {
        showToast(
          t('Sign in to Stremio to sync addon changes.', 'Melde dich bei Stremio an, um Addons zu synchronisieren.')
        );
      }
      return false;
    }
    persistBusy = true;
    if (!silent) paintSyncButton();
    try {
      const current = await loadLiveAddons();
      ensureBackup(current);
      rememberMetadataCapable(current);
      rememberOriginalMetaResources(current);
      rememberOriginalMetaResourcesFromBackup();
      rememberMetadataCapable(nextAddons);
      rememberOriginalMetaResources(nextAddons);
      void hydrateOriginalMetaResources(current);
      void hydrateOriginalMetaResources(nextAddons);
      const preferred = restoreAllAddonMetadata(cloneAddons(nextAddons));
      const cleaned = applyVisibilityToExtras(preferred);
      healPrefixMetaAddons(cleaned);
      const addons = toDescriptors(cleaned);
      const response = await fetch(`${API_BASE}/addonCollectionSet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'AddonCollectionSet',
          authKey,
          addons,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.error) {
        throw new Error(data?.error?.message || `HTTP ${response.status}`);
      }
      const core = getCore();
      if (core?.dispatch) {
        await core.dispatch({ action: 'Ctx', args: { action: 'PullAddonsFromAPI' } });
      }
      liveAddons = cloneAddons(cleaned);
      draft = cloneAddons(cleaned);
      dirty = false;
      writeBackup(cleaned);
      if (!silent) showToast(t('Addons synced.', 'Addons synchronisiert.'));
      paintSyncButton();
      if (!silent || isInstalledAddonsRoute()) {
        ensureExtraToolbar(true);
        refreshListPreserveScroll();
      }
      return true;
    } catch (error) {
      console.warn('[StremioCustom] Addon collection save failed:', error);
      if (!silent) {
        showToast(t('Could not sync addon changes.', 'Addon-Änderungen konnten nicht synchronisiert werden.'));
      }
      return false;
    } finally {
      persistBusy = false;
      paintSyncButton();
      if (persistQueued) {
        persistQueued = false;
        const queued = persistQueuedAddons;
        const queuedSilent = persistQueuedSilent;
        persistQueuedAddons = null;
        persistQueuedSilent = false;
        void persistAddons(queued || workingAddons(), { silent: queuedSilent });
      }
    }
  }

  async function syncDraft() {
    if (!dirty) {
      showToast(t('Nothing to sync.', 'Nichts zu synchronisieren.'));
      return;
    }
    await persistAddons(workingAddons());
  }

  function toggleMetadataSource(value) {
    if (!METADATA_SELECTION_ENABLED) return;
    const key = String(value || '');
    const current = selectedMetadataValues();
    let next;
    if (key === '') {
      next = current.includes('') ? current.filter((item) => item !== '') : ['', ...current.filter(Boolean)];
    } else {
      const normalized = normalizeTransport(key);
      const has = current.some((item) => normalizeTransport(item) === normalized);
      next = has
        ? current.filter((item) => normalizeTransport(item) !== normalized)
        : current.concat(key);
    }
    if (!next.length) next = [''];
    metadataTouchedThisSession = true;
    setMetadataAddons(next);
    renderSourceMenuOptions();
    paintMetadataChip();
  }

  function moveMetadataSource(value, delta) {
    if (!METADATA_SELECTION_ENABLED) return;
    const current = selectedMetadataValues();
    const index = current.findIndex((item) => sameMetadataValue(item, value));
    if (index < 0) return;
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= current.length) return;
    const next = current.slice();
    const [moved] = next.splice(index, 1);
    next.splice(nextIndex, 0, moved);
    metadataTouchedThisSession = true;
    setMetadataAddons(next);
    const addons = cloneAddons(workingAddons());
    const neighbor = current[nextIndex];
    const used = new Set();
    const fromPos = findAddonForMetadataValue(addons, value, used);
    if (fromPos >= 0) used.add(fromPos);
    const toPos = findAddonForMetadataValue(addons, neighbor, used);
    if (fromPos >= 0 && toPos >= 0 && prefixesOverlap(addons[fromPos], addons[toPos])) {
      const swap = addons[fromPos];
      addons[fromPos] = addons[toPos];
      addons[toPos] = swap;
      markDirty(applyMetadataPreference(addons, next));
    } else {
      markDirty(applyMetadataPreference(workingAddons(), next));
    }
    renderSourceMenuOptions();
    paintMetadataChip();
    void persistAddons(workingAddons());
  }

  function chooseMetadataSource(value) {
    toggleMetadataSource(value);
  }

  function ensureStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = `
      html.${PAGE_CLASS} [class*="addons-container"] [class*="addons-list-container"],
      html.${PAGE_CLASS} [class*="addons-container"] [class*="message-container"] {
        display: none !important;
      }
      html.${PAGE_CLASS} nav[class*="horizontal-nav-bar"],
      html.${PAGE_CLASS} #stremio-custom-nav-transition-host {
        z-index: 220 !important;
        pointer-events: auto !important;
      }
      html.${PAGE_CLASS} [class*="addons-container"] {
        display: flex !important;
        flex-direction: column !important;
        min-height: 0;
        overflow: hidden !important;
      }
      html.${PAGE_CLASS} [class*="addons-content"] {
        display: flex !important;
        flex-direction: column !important;
        position: relative;
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden !important;
      }
      html.${PAGE_CLASS} [class*="addons-content"] [class*="selectable-inputs-container"] {
        display: flex !important;
        position: relative;
        z-index: 2;
        flex: 0 0 auto;
        overflow: visible !important;
        margin-top: 4.6rem !important;
        pointer-events: auto !important;
      }
      html.${PAGE_CLASS} [class*="addons-content"] [class*="selectable-inputs-container"] [class*="menu-container"] {
        z-index: 3;
      }
      #${TOOLBAR_ID} {
        position: relative;
        z-index: 3;
        flex: none;
        display: flex;
        flex-wrap: nowrap;
        align-items: center;
        justify-content: flex-end;
        gap: 0.75rem;
        height: 3rem;
        margin-right: 1.5rem;
        padding: 0;
        pointer-events: auto;
        box-sizing: border-box;
      }
      #${ROOT_ID} {
        position: relative;
        z-index: 1;
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        min-height: 0;
        width: 100%;
        box-sizing: border-box;
        padding: 0.45rem 1.5rem 2rem;
        color: #fff;
        overflow: hidden;
        pointer-events: auto;
      }
      #${TOOLBAR_ID} .mystremio-am-chip,
      #${TOOLBAR_ID} .mystremio-am-sync,
      #${SOURCE_MENU_ID},
      #${SOURCE_MENU_ID} .mystremio-am-option,
      #${SOURCE_MENU_ID} .mystremio-am-order,
      #${ROOT_ID} .mystremio-am-list,
      #${ROOT_ID} .mystremio-am-card,
      #${ROOT_ID} .mystremio-am-panel,
      #${ROOT_ID} .mystremio-am-icon,
      #${ROOT_ID} .mystremio-am-textbtn,
      #${ROOT_ID} .mystremio-am-handle,
      #${ROOT_ID} .mystremio-am-name,
      #${ROOT_ID} .mystremio-catalog-name,
      #${ROOT_ID} .mystremio-addon-soft-toggle,
      #${ROOT_ID} .mystremio-catalog-toggle {
        pointer-events: auto;
      }
      #${TOOLBAR_ID} .mystremio-am-chip,
      #${TOOLBAR_ID} .mystremio-am-sync {
        min-height: 3rem;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(70, 70, 70, 0.22);
        color: #fff;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
        backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
        -webkit-backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
        font: inherit;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0 1.25rem;
        cursor: pointer;
        font-weight: 600;
        white-space: nowrap;
      }
      #${TOOLBAR_ID} .mystremio-am-sync,
      #${TOOLBAR_ID} .mystremio-am-chip {
        height: 3rem;
        flex-direction: row;
        align-items: center;
      }
      #${TOOLBAR_ID} .mystremio-am-chip {
        max-width: 16rem;
      }
      #${TOOLBAR_ID} .mystremio-am-chip [data-role="value"] {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${TOOLBAR_ID} .mystremio-am-chip-caret {
        display: inline-flex;
        align-items: center;
        flex: none;
      }
      #${TOOLBAR_ID} .mystremio-am-chip-caret svg,
      #${ROOT_ID} .mystremio-am-icon svg {
        display: block;
        transition: transform 0.18s ease;
      }
      #${TOOLBAR_ID} .mystremio-am-chip[aria-expanded="true"] .mystremio-am-chip-caret svg,
      #${ROOT_ID} .mystremio-am-icon[aria-expanded="true"] svg {
        transform: rotate(180deg);
      }
      #${TOOLBAR_ID} .mystremio-am-chip:hover,
      #${TOOLBAR_ID} .mystremio-am-sync:hover,
      #${ROOT_ID} .mystremio-am-icon:not(.mystremio-am-configure):hover {
        background: rgba(90, 90, 90, 0.32);
        border-color: rgba(255, 255, 255, 0.16);
      }
      #${TOOLBAR_ID} .mystremio-am-sync[data-dirty="true"] {
        background: rgba(61, 220, 132, 0.28);
        border-color: rgba(61, 220, 132, 0.4);
      }
      #${TOOLBAR_ID} .mystremio-am-sync:disabled { opacity: 0.45; cursor: default; }
      #${SOURCE_MENU_ID} {
        display: none;
        position: absolute;
        min-width: 18rem;
        max-height: 18rem;
        overflow: auto;
        padding: 0.35rem;
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(24, 24, 24, 0.96);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.08);
        z-index: 5;
      }
      #${SOURCE_MENU_ID}[data-open="true"] { display: block; }
      #${SOURCE_MENU_ID} .mystremio-am-option-row {
        display: flex;
        align-items: center;
        gap: 0.15rem;
      }
      #${SOURCE_MENU_ID} .mystremio-am-option {
        display: block;
        flex: 1 1 auto;
        width: auto;
        text-align: left;
        border: 0;
        border-radius: 10px;
        padding: 0.55rem 0.7rem;
        background: transparent;
        color: #fff;
        font: inherit;
        cursor: pointer;
      }
      #${SOURCE_MENU_ID} .mystremio-am-order {
        flex: none;
        width: 1.75rem;
        height: 1.75rem;
        padding: 0;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #fff;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #${SOURCE_MENU_ID} .mystremio-am-order:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      #${SOURCE_MENU_ID} .mystremio-am-order:disabled {
        opacity: 0.28;
        cursor: default;
      }
      #${SOURCE_MENU_ID} .mystremio-am-option:hover,
      #${SOURCE_MENU_ID} .mystremio-am-option[aria-selected="true"],
      #${SOURCE_MENU_ID} .mystremio-am-option[aria-checked="true"] {
        background: rgba(61, 220, 132, 0.22);
      }
      #${ROOT_ID} .mystremio-am-list {
        display: block;
        flex: 1 1 auto;
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
        box-sizing: border-box;
        padding: 0 1.25rem 1.5rem 0;
      }
      #${ROOT_ID} .mystremio-am-card {
        position: relative;
        display: block;
        flex: none;
        width: 100%;
        box-sizing: border-box;
        margin: 0 0 1.5rem;
        border-radius: var(--border-radius, 16px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(70, 70, 70, 0.22);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.14);
        backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
        -webkit-backdrop-filter: var(--backdrop-filter, blur(20px) saturate(180%));
      }
      #${ROOT_ID} .mystremio-am-card:last-child { margin-bottom: 0; }
      #${ROOT_ID} .mystremio-am-card:has(.mystremio-am-panel) { z-index: 3; }
      #${ROOT_ID} .mystremio-am-card[data-disabled="true"] { opacity: 0.58; }
      #${ROOT_ID} .mystremio-am-card[data-drag-over="true"] {
        outline: 2px solid rgba(61, 220, 132, 0.55);
      }
      #${ROOT_ID} .mystremio-am-row {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 1.5rem;
        min-height: 8rem;
        box-sizing: border-box;
      }
      #${ROOT_ID} .mystremio-am-handle {
        flex: 0 0 auto;
        width: 1.7rem;
        height: 2.2rem;
        border: 0;
        background: transparent;
        color: rgba(255, 255, 255, 0.72);
        cursor: grab;
        padding: 0;
      }
      #${ROOT_ID} .mystremio-am-handle:active { cursor: grabbing; }
      #${ROOT_ID} .mystremio-am-logo-slot {
        flex: 0 0 5rem;
        width: 5rem;
        height: 5rem;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.06);
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #${ROOT_ID} .mystremio-am-logo {
        width: 5rem;
        height: 5rem;
        border-radius: 16px;
        object-fit: contain;
        padding: 0.35rem;
        box-sizing: border-box;
      }
      #${ROOT_ID} .mystremio-am-logo-fallback {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.6rem;
        font-weight: 700;
        color: #fff;
        letter-spacing: 0.02em;
      }
      #${ROOT_ID} .mystremio-am-copy { flex: 1 1 auto; min-width: 0; }
      #${ROOT_ID} .mystremio-am-name {
        width: 100%;
        border: 0;
        background: transparent;
        color: #fff;
        font: inherit;
        font-weight: 700;
        font-size: 1.5rem;
        line-height: 1.25;
        padding: 0;
        outline: none;
      }
      #${ROOT_ID} .mystremio-am-desc {
        margin-top: 0.45rem;
        font-size: 0.95rem;
        line-height: 1.4;
        color: rgba(255, 255, 255, 0.72);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      #${ROOT_ID} .mystremio-am-actions {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        flex: 0 0 auto;
      }
      #${ROOT_ID} .mystremio-am-icon,
      #${ROOT_ID} .mystremio-am-textbtn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 3.5rem;
        min-height: 3.5rem;
        border-radius: 4rem;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(70, 70, 70, 0.22);
        color: #fff;
        cursor: pointer;
        font: inherit;
      }
      #${ROOT_ID} .mystremio-am-icon {
        width: 3.5rem;
        padding: 0;
      }
      #${ROOT_ID} .mystremio-am-textbtn {
        padding: 0 1rem;
        font-weight: 700;
        font-size: 1.1rem;
      }
      #${ROOT_ID} .mystremio-am-icon[aria-expanded="true"],
      #${ROOT_ID} .mystremio-am-textbtn[aria-pressed="true"] {
        background: rgba(61, 220, 132, 0.28);
        border-color: rgba(61, 220, 132, 0.35);
      }
      #${ROOT_ID} .mystremio-am-icon.mystremio-am-configure {
        flex: none;
        width: 3.5rem;
        height: 3.5rem;
        min-height: 3.5rem;
        padding: 0 1rem;
        border: 0;
        background-color: var(--secondary-accent-color);
        color: var(--primary-foreground-color);
      }
      #${ROOT_ID} .mystremio-am-icon.mystremio-am-configure svg {
        flex: none;
        width: 2rem;
        height: 2rem;
      }
      #${ROOT_ID} .mystremio-am-icon.mystremio-am-configure:hover {
        outline: var(--focus-outline-size) solid var(--secondary-accent-color);
        background-color: transparent;
      }
      #${ROOT_ID} .mystremio-addon-soft-toggle {
        position: relative;
        display: inline-flex;
        align-items: center;
        width: 2.75rem;
        height: 1.55rem;
        padding: 0;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(70, 70, 70, 0.22);
        cursor: pointer;
      }
      #${ROOT_ID} .mystremio-addon-soft-toggle[aria-checked="true"] {
        background: rgba(61, 220, 132, 0.45);
        border-color: rgba(61, 220, 132, 0.35);
      }
      #${ROOT_ID} .mystremio-addon-soft-knob {
        position: absolute;
        top: 50%;
        left: 0.18rem;
        width: 1.15rem;
        height: 1.15rem;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.92);
        transform: translateY(-50%);
        transition: transform 0.18s ease;
        pointer-events: none;
      }
      #${ROOT_ID} .mystremio-addon-soft-toggle[aria-checked="true"] .mystremio-addon-soft-knob {
        transform: translate(1.1rem, -50%);
      }
      #${ROOT_ID} .mystremio-am-panel {
        position: relative;
        z-index: 2;
        padding: 0 1.5rem 1.5rem 7.7rem;
        color: rgba(255, 255, 255, 0.92);
      }
      #${ROOT_ID} .mystremio-am-patches {
        display: flex;
        flex-wrap: wrap;
        gap: 0.45rem;
        margin-bottom: 0.75rem;
      }
      #${ROOT_ID} .mystremio-catalog-row {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.45rem 0;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
      }
      #${ROOT_ID} .mystremio-catalog-row[data-disabled="true"] { opacity: 0.45; }
      #${ROOT_ID} .mystremio-catalog-row[data-disabled="true"] .mystremio-catalog-name {
        text-decoration: line-through;
      }
      #${ROOT_ID} .mystremio-catalog-kind {
        flex: 0 0 auto;
        min-width: 4.4rem;
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.55);
      }
      #${ROOT_ID} .mystremio-catalog-name {
        flex: 1 1 auto;
        min-width: 0;
        border: 0;
        background: transparent;
        color: #fff;
        font: inherit;
        font-size: 0.9rem;
        outline: none;
      }
      #${ROOT_ID} .mystremio-catalog-name[data-hidden="true"] { opacity: 0.55; }
      #${ROOT_ID} .mystremio-catalog-toggle {
        min-width: 1.7rem;
        height: 1.7rem;
        padding: 0;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(70, 70, 70, 0.22);
        color: rgba(255, 255, 255, 0.72);
        font: inherit;
        font-size: 0.72rem;
        font-weight: 700;
        cursor: pointer;
      }
      #${ROOT_ID} .mystremio-catalog-toggle[aria-pressed="true"] {
        background: rgba(61, 220, 132, 0.28);
        border-color: rgba(61, 220, 132, 0.35);
        color: #fff;
      }
      #${CONFIRM_ID} {
        position: fixed;
        inset: 0;
        z-index: 310;
        display: flex;
        align-items: center;
        justify-content: center;
        background: hsla(0, 0%, 0%, 0.45);
        pointer-events: auto;
      }
      #${CONFIRM_ID} .mystremio-am-confirm-box {
        min-width: min(22rem, 90vw);
        max-width: 90vw;
        padding: 1.25rem 1.4rem;
        border-radius: 1rem;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(28, 28, 28, 0.96);
        color: #fff;
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
      }
      #${CONFIRM_ID} .mystremio-am-confirm-box p {
        margin: 0 0 1rem;
        font-size: 1rem;
        line-height: 1.4;
      }
      #${CONFIRM_ID} .mystremio-am-confirm-actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.6rem;
      }
      #${CONFIRM_ID} .mystremio-am-confirm-actions button {
        min-height: 2.4rem;
        padding: 0 1rem;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(70, 70, 70, 0.28);
        color: #fff;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      #${CONFIRM_ID} .mystremio-am-confirm-actions button[data-role="ok"] {
        background: rgba(220, 80, 80, 0.42);
        border-color: rgba(255, 120, 120, 0.35);
      }
      #${TOAST_ID} {
        position: fixed;
        left: 50%;
        bottom: 1.4rem;
        transform: translateX(-50%);
        z-index: 2147483000;
        max-width: 90vw;
        padding: 0.55rem 0.9rem;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(24, 24, 24, 0.92);
        color: #fff;
        font-size: 0.9rem;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.18s ease;
      }
      #${TOAST_ID}[data-visible="true"] { opacity: 1; }
    `;
  }

  function iconButton(label, svg) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mystremio-am-icon';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = svg;
    return button;
  }

  const ICON_GRIP =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>';
  const ICON_UP =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 14l6-6 6 6"/></svg>';
  const ICON_DOWN =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 10l6 6 6-6"/></svg>';
  const ICON_EXPAND =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  const NATIVE_SETTINGS_SVG =
    '<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="M464 250C464 247.333 463 245 461 243L455 240L429 236L426 234L424 231L423 222V218L425 216L448 203L453 198V190L449 179C448.333 177 446.667 175.333 444 174C442 172.667 439.667 172.333 437 173L412 178L408 177L406 175L401 167C400.404 165.878 400.18 164.595 400.359 163.337C400.539 162.079 401.114 160.91 402 160L419 141L421 134C421.667 131.333 421 129 419 127L412 118C410.409 115.878 408.04 114.475 405.414 114.1C402.789 113.725 400.122 114.409 398 116L376 129C375.065 129.916 373.809 130.429 372.5 130.429C371.191 130.429 369.935 129.916 369 129L362 122L360 120V116L369 91.9998C370.096 89.7279 370.292 87.1258 369.551 84.7151C368.809 82.3043 367.183 80.2628 365 78.9998L355 72.9998C353 70.9998 350.667 70.6665 348 71.9998C345.333 72.6665 343 73.9998 341 75.9998L325 95.9998L323 97.9998H319L310 93.9998L307 91.9998L306 88.9998V62.9998C306.667 60.3332 306 57.9998 304 55.9998C302.667 53.3332 300.667 51.9998 298 51.9998L286 49.9998C284 49.3332 281.667 49.6665 279 50.9998L275 56.9998L266 81.9998L264 84.9998H251C249.667 85.6665 248.667 85.3332 248 83.9998L246 81.9998L237 56.9998C237 54.9998 235.667 52.9998 233 50.9998L226 49.9998L214 51.9998C211.333 51.9998 209.333 53.3332 208 55.9998C206 57.9998 205.333 60.3332 206 62.9998V88.9998L205 91.9998L202 93.9998L193 97.9998C190.333 98.6665 188.333 97.9998 187 95.9998L170 75.9998C169.333 73.9998 167.333 72.6665 164 71.9998C162 71.3332 159.667 71.6665 157 72.9998L147 78.9998L142 83.9998V91.9998L152 116V119C152 121 151.333 122 150 122L143 128C142.606 128.525 142.113 128.968 141.548 129.302C140.983 129.637 140.357 129.857 139.707 129.95C139.057 130.042 138.395 130.006 137.759 129.843C137.123 129.68 136.525 129.394 136 129L114 115L107 114L100 117L93.0001 126C91.1679 127.869 90.1416 130.382 90.1416 133C90.1416 135.617 91.1679 138.131 93.0001 140L111 160L112 163L111 166L106 175L104 177H100L75.0001 173C72.612 172.335 70.0619 172.58 67.8446 173.689C65.6273 174.797 63.9008 176.69 63.0001 179L59.0001 190V197C60.3335 200.333 62.0001 202.333 64.0001 203L87.0001 216L89.0001 218V223L87.0001 231L86.0001 234L83.0001 236L57.0001 240C54.5249 240.249 52.2312 241.411 50.5671 243.26C48.9029 245.109 47.9877 247.512 48.0001 250V262C47.9877 264.488 48.9029 266.89 50.5671 268.74C52.2312 270.589 54.5249 271.751 57.0001 272L83.0001 276L86.0001 278L87.0001 281L89.0001 290V294L87.0001 296L64.0001 309L59.0001 314V322L63.0001 333C63.6668 335 65.3335 336.667 68.0001 338C70.0001 339.333 72.3335 339.667 75.0001 339L100 334L104 335L106 337L111 345C111.733 346.02 112.127 347.244 112.127 348.5C112.127 349.756 111.733 350.98 111 352L94.0001 372C92.306 373.689 91.2736 375.929 91.0901 378.314C90.9066 380.7 91.5843 383.072 93.0001 385L100 394C101.591 396.122 103.96 397.524 106.586 397.899C109.211 398.274 111.878 397.591 114 396L136 383C137.061 382.204 138.394 381.863 139.707 382.05C141.02 382.238 142.204 382.939 143 384L150 390C151.333 390.667 152 391.667 152 393V396L143 420C141.904 422.272 141.708 424.874 142.45 427.285C143.191 429.695 144.817 431.737 147 433L157 439C158.111 439.739 159.359 440.248 160.67 440.497C161.98 440.746 163.328 440.73 164.632 440.451C165.937 440.171 167.173 439.633 168.266 438.869C169.36 438.105 170.289 437.129 171 436L187 416L192 414L202 418L205 420L206 423V449C205.333 451.667 206 454 208 456C209.333 458.667 211.333 460 214 460L226 462C228.34 462.158 230.67 461.565 232.649 460.305C234.628 459.046 236.153 457.187 237 455L246 430L248 428C249.333 426.667 250.333 426.333 251 427H261L264 428L266 430L275 455C275.667 457 277 458.667 279 460C280.333 462 282.333 462.667 285 462H287L298 460C301.333 459.333 303.333 458 304 456C306 454 307 451.667 307 449L306 423L307 420L310 418L319 415C322.333 414.333 324.333 414.667 325 416L342 436C343.418 438.012 345.528 439.431 347.927 439.985C350.325 440.538 352.844 440.188 355 439L365 433L370 428V420L360 396V393L362 390L369 384L373 382L376 383L398 396C400.667 398 403 398.667 405 398C407.667 398 410 396.667 412 394L419 385C421 383.667 422 381.667 422 379C422 376.333 421 374 419 372L402 352L400 349L401 345L406 337L409 335L412 334L437 339C438.246 339.477 439.575 339.699 440.909 339.655C442.242 339.61 443.553 339.299 444.765 338.74C445.976 338.181 447.064 337.385 447.963 336.399C448.862 335.413 449.555 334.258 450 333L453 322V314L449 309L426 296L423 294V289L425 281L426 278L429 276L455 272C457.475 271.751 459.769 270.589 461.433 268.74C463.097 266.89 464.013 264.488 464 262V250ZM182 344C180.667 346 178.667 347.667 176 349C173.976 350.384 171.661 351.284 169.233 351.631C166.806 351.977 164.331 351.762 162 351L156 347C133.303 322.128 120.72 289.672 120.72 256C120.72 222.328 133.303 189.872 156 165L163 161L170 160C172.487 160.301 174.868 161.182 176.953 162.571C179.037 163.961 180.766 165.82 182 168L228 248C229.404 250.432 230.144 253.191 230.144 256C230.144 258.808 229.404 261.568 228 264L182 344ZM256 391C246 391 236.667 390 228 388C224.295 387.293 220.958 385.3 218.58 382.373C216.201 379.445 214.933 375.771 215 372L217 365L263 285L269 279L277 277H369C371.484 276.922 373.952 277.423 376.209 278.465C378.465 279.506 380.448 281.059 382 283L385 290L384 297C367 352 316 391 256 391ZM263 227L218 147L216 140C215.885 136.366 217.011 132.802 219.192 129.894C221.373 126.986 224.48 124.907 228 124C260.651 117.223 294.654 122.77 323.458 139.573C352.262 156.375 373.828 183.243 384 215L385 222C384.293 225.705 382.3 229.042 379.373 231.42C376.445 233.799 372.772 235.067 369 235H277C274.333 235.666 271.667 235 269 233L263 227Z"/><path d="M396 459.9c-18 .11-35.6-6.92-48.4-19.61-13.1-12.68-20.4-29.97-20.7-48.09v-1.51L188.5 345.1c-7.4 9.27-16.7 16.74-27.5 21.83a77.86 77.86 0 0 1-34.25 7.56c-20.26.8-39.99-6.47-54.89-20.22-14.9-13.73-23.73-32.83-24.57-53.09a76.47 76.47 0 0 1 20.11-54.91 76.46 76.46 0 0 1 53.05-24.68c2.1-.09 4.19-.09 6.3 0 17.45.18 34.35 5.85 48.55 16.2l101.6-66.2c-6.3-12.84-9.7-26.88-10.2-41.19-.9-19.1 3.8-38.03 13.8-54.37 10.1-16.31 24.6-29.28 42.1-37.22 17.3-7.94 36.8-10.48 55.6-7.3a95.4 95.4 0 0 1 50.1 25.13c13.9 13.2 23.4 30.24 27.4 48.91 4.1 18.69 2.5 38.17-4.6 55.91-7 17.77-19.4 32.98-35.2 43.7-15.9 10.71-34.5 16.43-53.7 16.43-12.1.2-24.4-2.03-35.7-6.58-11.3-4.56-21.8-11.32-30.4-19.92l-100 64.71c5.7 10.86 8.7 22.93 8.8 35.2-.3 6.44-1.3 12.85-2.9 19.1l132.2 42.59c7.6-13.23 19.4-23.66 33.3-29.65 14.1-6.01 29.6-7.27 44.5-3.6 14.7 3.65 28 12.06 37.6 23.9 9.5 11.86 15 26.52 15.5 41.75-.1 18.45-7.4 36.14-20.2 49.34-13 13.2-30.4 20.9-48.9 21.47m0-104.41c-6.8.31-13.5 2.62-19.1 6.68-5.7 4.05-9.9 9.68-12.4 16.15-2.4 6.47-2.9 13.51-1.4 20.25 1.6 6.73 5.1 12.88 10 17.65 5.1 4.79 11.4 8 18.1 9.23 6.8 1.23 14 .44 20.3-2.28 6.4-2.72 11.7-7.25 15.5-13.03 3.8-5.76 5.8-12.54 5.8-19.45a35.87 35.87 0 0 0-11.1-25.18c-6.8-6.61-16.1-10.19-25.7-10.02m-270.55-102.9c-5.99-.13-11.95.9-17.53 3.05a46 46 0 0 0-15.04 9.53 45.8 45.8 0 0 0-10.25 14.55 45.8 45.8 0 0 0-3.89 17.38c-.13 5.99.89 11.95 3.06 17.53 2.16 5.58 5.4 10.69 9.52 15.04 4.14 4.32 9.08 7.8 14.56 10.23a45.7 45.7 0 0 0 17.37 3.9h2.2c5.99.13 11.95-.9 17.45-3.05 5.7-2.16 10.7-5.4 15.1-9.54 4.3-4.12 7.8-9.07 10.2-14.54 2.5-5.48 3.9-11.39 4-17.37.2-6-.9-11.95-3-17.54-2.3-5.58-5.4-10.7-9.7-15.03-4.1-4.33-9.1-7.82-14.4-10.25a46.6 46.6 0 0 0-17.46-3.89zM362.2 71.7c-7.9-.26-15.9 1.05-23.6 3.88-7.5 2.83-14.3 7.12-20.2 12.63-5.9 5.49-10.7 12.08-14 19.41-3.3 7.34-5.1 15.24-5.3 23.27V132c.2 16.24 6.9 31.71 18.6 43.01 11.7 11.32 27.4 17.53 43.5 17.29h1.1c8.2.38 16.4-.89 24.1-3.75 7.5-2.86 14.5-7.25 20.5-12.89 6-5.65 10.7-12.42 13.8-19.94 3.2-7.51 4.8-15.6 4.8-23.77 0-8.18-1.6-16.27-4.9-23.77-3.1-7.51-7.8-14.29-13.7-19.92-6-5.63-13.1-10.02-20.6-12.86-7.7-2.85-15.9-4.1-24.1-3.7"/></svg>';
  let cachedSettingsSvg = '';

  function settingsIconHtml() {
    if (cachedSettingsSvg) return cachedSettingsSvg;
    try {
      const live = document.querySelector(
        '[class*="addon-container"] [class*="configure-button-container"] svg, [class*="configure-button-container"] svg'
      );
      if (live) {
        const clone = live.cloneNode(true);
        clone.removeAttribute('class');
        clone.setAttribute('aria-hidden', 'true');
        if (!clone.getAttribute('fill')) clone.setAttribute('fill', 'currentColor');
        cachedSettingsSvg = clone.outerHTML;
        return cachedSettingsSvg;
      }
    } catch (_) {}
    cachedSettingsSvg = NATIVE_SETTINGS_SVG;
    return cachedSettingsSvg;
  }

  const ICON_SETTINGS = NATIVE_SETTINGS_SVG;

  function moveAddon(from, to) {
    if (from === to || from < 0 || to < 0) return;
    mutateDraft((addons) => {
      if (from >= addons.length || to >= addons.length) return;
      const [moved] = addons.splice(from, 1);
      addons.splice(to, 0, moved);
      syncMetadataOrderFromAddons(addons);
    });
  }

  function bindDrag(handle, index) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragFrom = index;
      dragOver = index;
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', (event) => {
      if (dragFrom < 0) return;
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const card = el?.closest?.('.mystremio-am-card');
      const next = Number(card?.dataset?.index);
      document.querySelectorAll(`#${ROOT_ID} .mystremio-am-card`).forEach((node) => {
        node.dataset.dragOver = Number(node.dataset.index) === next ? 'true' : 'false';
      });
      if (Number.isFinite(next)) dragOver = next;
    });
    handle.addEventListener('pointerup', () => {
      const from = dragFrom;
      const to = dragOver;
      dragFrom = -1;
      dragOver = -1;
      document.querySelectorAll(`#${ROOT_ID} .mystremio-am-card`).forEach((node) => {
        node.dataset.dragOver = 'false';
      });
      if (from >= 0 && to >= 0 && from !== to) moveAddon(from, to);
    });
  }

  function catalogToggle(letter, label, pressed, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mystremio-catalog-toggle';
    button.textContent = letter;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    button.addEventListener('click', onClick);
    return button;
  }

  function renderCatalogs(panel, addon, index) {
    const catalogs = getCatalogs(addon);
    if (!catalogs.length) {
      const empty = document.createElement('div');
      empty.className = 'mystremio-am-desc';
      empty.textContent = t('No catalogs', 'Keine Kataloge');
      panel.appendChild(empty);
      return;
    }
    catalogs.forEach((catalog, catalogIndex) => {
      const kind = catalogKind(catalog);
      const row = document.createElement('div');
      row.className = 'mystremio-catalog-row';
      const up = iconButton(
        kind === 'search' ? t('Move search up', 'Suche nach oben') : t('Move catalog up', 'Katalog nach oben'),
        ICON_UP
      );
      up.disabled = catalogIndex === 0;
      up.addEventListener('click', () => {
        mutateDraft((addons) => {
          const list = getCatalogs(addons[index]);
          if (catalogIndex <= 0) return;
          const [moved] = list.splice(catalogIndex, 1);
          list.splice(catalogIndex - 1, 0, moved);
        });
      });
      const down = iconButton(
        kind === 'search' ? t('Move search down', 'Suche nach unten') : t('Move catalog down', 'Katalog nach unten'),
        ICON_DOWN
      );
      down.disabled = catalogIndex === catalogs.length - 1;
      down.addEventListener('click', () => {
        mutateDraft((addons) => {
          const list = getCatalogs(addons[index]);
          if (catalogIndex >= list.length - 1) return;
          const [moved] = list.splice(catalogIndex, 1);
          list.splice(catalogIndex + 1, 0, moved);
        });
      });
      const kindTag = document.createElement('span');
      kindTag.className = 'mystremio-catalog-kind';
      kindTag.textContent = kind === 'search' ? t('Search', 'Suche') : t('Catalog', 'Katalog');
      const name = document.createElement('input');
      name.className = 'mystremio-catalog-name';
      name.value = String(catalog?.name || catalog?.id || '');
      const flags = effectiveCatalogFlags(addon, catalog);
      const disabled = flags.disabled;
      const homeHidden = isCatalogHomeHidden(addon, catalog);
      const searchVisible = isCatalogSearchVisible(addon, catalog);
      const discoverVisible = !isCatalogDiscoverHidden(addon, catalog);
      row.dataset.disabled = disabled ? 'true' : 'false';
      name.dataset.hidden = (kind === 'search' ? !searchVisible : homeHidden) || disabled ? 'true' : 'false';
      name.addEventListener('change', () => {
        mutateDraft((addons) => {
          const item = getCatalogs(addons[index])[catalogIndex];
          if (item) item.name = name.value.trim() || item.id;
        });
      });
      row.append(up, down, kindTag, name);
      if (kind === 'catalog') {
        row.appendChild(
          catalogToggle(
            'H',
            homeHidden ? t('Show on Home', 'Auf Home anzeigen') : t('Hide from Home', 'Von Home ausblenden'),
            !homeHidden && !disabled,
            () => {
              if (isCatalogDisabled(workingAddons()[index], getCatalogs(workingAddons()[index])[catalogIndex])) return;
              const current = workingAddons()[index];
              const item = getCatalogs(current)[catalogIndex];
              if (!item) return;
              setCatalogHomeVisible(current, item, homeHidden);
              refreshListPreserveScroll();
              refreshVisibilitySurfaces();
            }
          )
        );
      }
      if (catalogShowsSearchToggle(addon, catalog)) {
        row.appendChild(
          catalogToggle(
            'S',
            searchVisible
              ? t('Hide from Search', 'Aus der Suche ausblenden')
              : t('Show in Search', 'In der Suche anzeigen'),
            searchVisible && !disabled,
            () => {
              const current = workingAddons()[index];
              const item = getCatalogs(current)[catalogIndex];
              if (!item || isCatalogDisabled(current, item)) return;
              const original = originalCatalogFor(current, item);
              const extrasChange =
                catalogKind(item) !== 'search' &&
                (catalogHasOptionalSearch(item) || catalogHasOptionalSearch(original));
              const applySearch = (addon, catalog) => {
                setCatalogSearchVisible(
                  addon,
                  catalog,
                  !searchVisible,
                  originalCatalogFor(addon, catalog)
                );
                syncAddonSearchFromCatalogs(addon);
              };
              const turningOn = !searchVisible;
              if (extrasChange) {
                mutateDraft((addons) => {
                  const nextItem = getCatalogs(addons[index])[catalogIndex];
                  if (!nextItem) return;
                  applySearch(addons[index], nextItem);
                });
              } else {
                applySearch(current, item);
                refreshListPreserveScroll();
              }
              if (turningOn) {
                setAddonSearchDisabled(workingAddons()[index], false);
                if (extrasChange) void persistAddons(workingAddons());
              }
              refreshVisibilitySurfaces();
            }
          )
        );
      }
      if (kind === 'catalog') {
        row.appendChild(
          catalogToggle(
            'D',
            discoverVisible
              ? t('Hide from Discover', 'Aus Discover ausblenden')
              : t('Show in Discover', 'In Discover anzeigen'),
            discoverVisible && !disabled,
            () => {
              if (isCatalogDisabled(workingAddons()[index], getCatalogs(workingAddons()[index])[catalogIndex])) return;
              const current = workingAddons()[index];
              const item = getCatalogs(current)[catalogIndex];
              if (!item) return;
              setCatalogDiscoverVisible(current, item, !discoverVisible);
              refreshListPreserveScroll();
              refreshVisibilitySurfaces();
            }
          )
        );
      }
      const remove = iconButton(
        disabled
          ? t('Enable catalog', 'Katalog aktivieren')
          : t('Disable catalog', 'Katalog deaktivieren'),
        ''
      );
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        const current = workingAddons()[index];
        const item = getCatalogs(current)[catalogIndex];
        if (!item) return;
        const nextDisabled = !isCatalogDisabled(current, item);
        setCatalogDisabled(current, item, nextDisabled);
        const original = originalCatalogFor(current, item);
        const hasOptional = catalogHasOptionalSearch(item) || catalogHasOptionalSearch(original);
        if (catalogKind(item) !== 'search' && hasOptional) {
          mutateDraft((addons) => {
            const nextItem = getCatalogs(addons[index])[catalogIndex];
            if (!nextItem) return;
            if (nextDisabled) stripOptionalSearch(nextItem);
            else if (catalogFlags(addons[index], nextItem).search) {
              restoreOptionalSearch(nextItem, originalCatalogFor(addons[index], nextItem));
            }
            syncAddonSearchFromCatalogs(addons[index]);
          });
        } else {
          syncAddonSearchFromCatalogs(current);
          refreshListPreserveScroll();
        }
        refreshVisibilitySurfaces();
      });
      row.appendChild(remove);
      panel.appendChild(row);
    });
  }

  function renderCinemetaPatches(panel, addon, index) {
    const wrap = document.createElement('div');
    wrap.className = 'mystremio-am-patches';
    const patches = [
      {
        key: 'search',
        on: cinemetaSearchRemoved(addon),
        label: t('Remove Cinemeta Search', 'Cinemeta-Suche entfernen'),
        apply: (target, remove) => applyCinemetaSearchPatch(target, remove),
      },
      {
        key: 'catalogs',
        on: cinemetaCatalogsRemoved(addon),
        label: t('Remove Cinemeta Catalogs', 'Cinemeta-Kataloge entfernen'),
        apply: (target, remove) => applyCinemetaCatalogsPatch(target, remove),
      },
      {
        key: 'metadata',
        on:
          METADATA_SELECTION_ENABLED &&
          hasExplicitMetadataSelection() &&
          !getMetadataAddons().some((item) => item === ''),
        label: t('Remove Cinemeta Metadata', 'Cinemeta-Metadaten entfernen'),
        apply: null,
      },
    ];

    function firstOtherMeta() {
      const other = workingAddons().find((item) => !isCinemeta(item) && hasMetaResource(item));
      return other ? addonTransport(other) : '';
    }

    for (const patch of patches) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mystremio-am-textbtn';
      button.textContent = patch.label;
      button.setAttribute('aria-pressed', patch.on ? 'true' : 'false');
      button.addEventListener('click', () => {
        if (patch.key === 'metadata') {
          const others = getMetadataAddons().filter(Boolean);
          if (!patch.on) {
            const next = others.length ? others : [firstOtherMeta()].filter(Boolean);
            setMetadataAddons(next);
          } else {
            setMetadataAddons([''].concat(others));
          }
          paintMetadataChip();
          if (sourceMenuOpen) renderSourceMenuOptions();
          refreshListPreserveScroll();
          return;
        }
        mutateDraft((addons) => {
          const target = addons[index];
          if (!target) return;
          patch.apply(target, !patch.on);
        });
      });
      wrap.appendChild(button);
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'mystremio-am-textbtn';
    reset.textContent = t('Reset Cinemeta', 'Cinemeta zurücksetzen');
    reset.addEventListener('click', async () => {
      try {
        const next = cloneAddons(workingAddons());
        const target = next[index];
        if (!target) return;
        await resetCinemetaAddon(target);
        markDirty(next);
        showToast(t('Cinemeta reset in draft. Sync to apply.', 'Cinemeta im Entwurf zurückgesetzt. Sync speichert.'));
      } catch (error) {
        console.warn('[StremioCustom] Cinemeta reset failed:', error);
        showToast(t('Could not reset Cinemeta.', 'Cinemeta konnte nicht zurückgesetzt werden.'));
      }
    });
    wrap.appendChild(reset);
    panel.appendChild(wrap);
  }

  function renderCard(addon, index) {
    const transport = addonTransport(addon);
    const card = document.createElement('article');
    card.className = 'mystremio-am-card';
    card.dataset.index = String(index);
    card.dataset.transport = transport;
    card.dataset.disabled = isSoftDisabled(addon) ? 'true' : 'false';

    const row = document.createElement('div');
    row.className = 'mystremio-am-row';

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'mystremio-am-handle';
    handle.title = t('Drag to reorder', 'Ziehen zum Sortieren');
    handle.innerHTML = ICON_GRIP;
    bindDrag(handle, index);

    const logoSlot = document.createElement('div');
    logoSlot.className = 'mystremio-am-logo-slot';
    setAddonLogo(logoSlot, addon);

    const copy = document.createElement('div');
    copy.className = 'mystremio-am-copy';
    const name = document.createElement('input');
    name.className = 'mystremio-am-name';
    name.value = String(addon?.manifest?.name || transport);
    name.addEventListener('change', () => {
      mutateDraft((addons) => {
        if (addons[index]?.manifest) addons[index].manifest.name = name.value.trim() || addons[index].manifest.name;
      });
    });
    const desc = document.createElement('div');
    desc.className = 'mystremio-am-desc';
    desc.textContent = String(addon?.manifest?.description || addonTransportUrl(addon) || '');
    copy.append(name, desc);

    const actions = document.createElement('div');
    actions.className = 'mystremio-am-actions';

    if (isConfigurable(addon)) {
      const configure = iconButton(t('Configure', 'Konfigurieren'), settingsIconHtml());
      configure.classList.add('mystremio-am-configure');
      configure.addEventListener('click', () => {
        const url = configureUrl(addon);
        if (url) window.open(url, '_blank', 'noopener');
      });
      actions.appendChild(configure);
    }

    if (!isProtected(addon)) {
      const uninstall = document.createElement('button');
      uninstall.type = 'button';
      uninstall.className = 'mystremio-am-textbtn';
      uninstall.textContent = t('Uninstall', 'Deinstallieren');
      uninstall.addEventListener('click', () => void uninstallAddon(addon));
      actions.appendChild(uninstall);
    }

    const expand = iconButton(t('Catalogs', 'Kataloge'), ICON_EXPAND);
    const open = expanded.has(transport);
    expand.setAttribute('aria-expanded', open ? 'true' : 'false');
    expand.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const willOpen = !expanded.has(transport);
      if (willOpen) expanded.add(transport);
      else expanded.delete(transport);
      expand.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      card.querySelector('.mystremio-am-panel')?.remove();
      if (!willOpen) return;
      const panel = document.createElement('div');
      panel.className = 'mystremio-am-panel';
      if (isCinemeta(addon)) renderCinemetaPatches(panel, addon, index);
      renderCatalogs(panel, addon, index);
      card.appendChild(panel);
    });
    actions.appendChild(expand);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mystremio-addon-soft-toggle';
    toggle.setAttribute('role', 'switch');
    const disabled = isSoftDisabled(addon);
    toggle.setAttribute('aria-checked', disabled ? 'false' : 'true');
    toggle.title = disabled
      ? t('Enable addon (stays installed)', 'Addon aktivieren (bleibt installiert)')
      : t('Disable addon without uninstalling', 'Addon deaktivieren ohne Deinstallation');
    toggle.innerHTML = '<span class="mystremio-addon-soft-knob" aria-hidden="true"></span>';
    toggle.addEventListener('click', () => {
      setSoftDisabled(addon, toggle.getAttribute('aria-checked') !== 'false');
      refreshListPreserveScroll();
    });
    actions.appendChild(toggle);

    row.append(handle, logoSlot, copy, actions);
    card.appendChild(row);

    if (open) {
      const panel = document.createElement('div');
      panel.className = 'mystremio-am-panel';
      if (isCinemeta(addon)) renderCinemetaPatches(panel, addon, index);
      renderCatalogs(panel, addon, index);
      card.appendChild(panel);
    }

    return card;
  }

  function fillAddonList(list) {
    const addons = workingAddons();
    const visible = addons
      .map((addon, index) => ({ addon, index }))
      .filter((entry) => addonMatchesFilters(entry.addon));
    list.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'mystremio-am-desc';
      empty.textContent = t('No installed addons match this filter.', 'Keine installierten Addons passen zum Filter.');
      list.appendChild(empty);
      return;
    }
    visible.forEach((entry) => {
      list.appendChild(renderCard(entry.addon, entry.index));
    });
  }

  function refreshListPreserveScroll() {
    const root = document.getElementById(ROOT_ID);
    const list = root?.querySelector('.mystremio-am-list');
    if (!list) {
      render();
      return;
    }
    withDomLock(() => {
      const top = list.scrollTop;
      fillAddonList(list);
      list.scrollTop = top;
      positionOverlays();
    });
  }

  function render() {
    if (!isInstalledAddonsRoute()) {
      teardown();
      return;
    }
    withDomLock(() => {
      try {
        ensureStyles();
        if (!findAddonsRoot()) return;
        const root = mountManagerRoot();
        document.documentElement.classList.add(PAGE_CLASS);
        bindStockFilters();
        ensureExtraToolbar(true);
        let list = root.querySelector(':scope > .mystremio-am-list');
        if (!list) {
          root.replaceChildren();
          list = document.createElement('div');
          list.className = 'mystremio-am-list';
          root.appendChild(list);
        }
        fillAddonList(list);
        positionOverlays();
      } catch (error) {
        console.error('[StremioCustom] Addon manager render failed:', error);
        document.documentElement.classList.remove(PAGE_CLASS);
      }
    });
  }

  function teardown() {
    withDomLock(() => {
      document.documentElement.classList.remove(PAGE_CLASS);
      document.getElementById(ROOT_ID)?.remove();
      document.getElementById(TOOLBAR_ID)?.remove();
      document.getElementById(SOURCE_MENU_ID)?.remove();
      closeConfirmDialog();
      sourceMenuOpen = false;
    });
    if (livePoll) {
      window.clearInterval(livePoll);
      livePoll = null;
    }
  }

  let kitsuHealAttempted = false;
  let metadataBootSyncAttempted = false;
  let metadataBootSyncTries = 0;

  async function healKitsuMetaIfNeeded() {
    if (kitsuHealAttempted) return;
    kitsuHealAttempted = true;
    try {
      const live = await loadLiveAddons();
      const next = cloneAddons(live);
      healPrefixMetaAddons(next);
      if (collectionSignature(next) !== collectionSignature(live || [])) {
        void persistAddons(next, { silent: true });
      }
    } catch (_) {}
  }

  /**
   * Restore stripped meta on every metadata-capable addon. The fetch gate
   * decides which /meta/ actually runs; collection persist is only for heal.
   */
  async function syncMetadataPreferenceOnBoot() {
    if (metadataBootSyncAttempted) return;
    const core = getCore();
    if (!core?.getState) {
      if (metadataBootSyncTries >= 20) return;
      metadataBootSyncTries += 1;
      window.setTimeout(() => {
        void syncMetadataPreferenceOnBoot();
      }, 400);
      return;
    }
    metadataBootSyncAttempted = true;
    try {
      rememberMetadataCapableFromBackup();
      rememberOriginalMetaResourcesFromBackup();
      const live = await loadLiveAddons();
      if (!Array.isArray(live) || !live.length) {
        metadataBootSyncAttempted = false;
        if (metadataBootSyncTries >= 20) return;
        metadataBootSyncTries += 1;
        window.setTimeout(() => {
          void syncMetadataPreferenceOnBoot();
        }, 800);
        return;
      }
      rememberMetadataCapable(live);
      rememberOriginalMetaResources(live);
      const preferred = applyMetadataPreference(live, selectedMetadataValues());
      healPrefixMetaAddons(preferred);
      if (collectionSignature(preferred) === collectionSignature(live)) return;
      const ok = await persistAddons(preferred, { silent: true });
      if (!ok) {
        metadataBootSyncAttempted = false;
        if (metadataBootSyncTries >= 20) return;
        metadataBootSyncTries += 1;
        window.setTimeout(() => {
          void syncMetadataPreferenceOnBoot();
        }, 800);
      }
    } catch (error) {
      metadataBootSyncAttempted = false;
      console.warn('[StremioCustom] Metadata preference boot sync failed:', error);
    }
  }

  async function hydrate() {
    if (!isInstalledAddonsRoute()) {
      teardown();
      return;
    }
    const live = await loadLiveAddons();
    ensureVisibilityMigrated(live);
    adoptLiveCollection(live);
    for (const addon of workingAddons()) syncAddonSearchFromCatalogs(addon);
    const healed = cloneAddons(workingAddons());
    healPrefixMetaAddons(healed);
    if (collectionSignature(healed) !== collectionSignature(workingAddons())) {
      markDirty(healed);
      void persistAddons(healed);
    }
    if (!originalCinemeta) originalCinemeta = readJson(CINEMETA_ORIGINAL_KEY, null);
    const ours = document.getElementById(ROOT_ID);
    if (ours) {
      document.documentElement.classList.add(PAGE_CLASS);
      ensureStyles();
      bindStockFilters();
      withDomLock(() => {
        ensureExtraToolbar();
        positionOverlays();
      });
      refreshListPreserveScroll();
    } else {
      render();
    }
    if (!livePoll) {
      livePoll = window.setInterval(() => {
        void pullLiveAndAdopt();
      }, 2000);
    }
  }

  function pretouchInstalledRoute() {
    if (isInstalledAddonsRoute()) {
      ensureStyles();
      document.documentElement.classList.add(PAGE_CLASS);
      if (((liveAddons && liveAddons.length) || (draft && draft.length)) && findAddonsRoot()) {
        if (!document.getElementById(ROOT_ID)) render();
      }
      return;
    }
    document.documentElement.classList.remove(PAGE_CLASS);
  }

  function scheduleMount() {
    pretouchInstalledRoute();
    if (domLock) return;
    if (mountTimer) window.clearTimeout(mountTimer);
    mountTimer = window.setTimeout(() => {
      mountTimer = null;
      void hydrate();
    }, 80);
  }

  window.__stremioCustomAddonManagerEnsure = scheduleMount;
  window.StremioCustomAddonManager = {
    scheduleInject: scheduleMount,
    persistAddons,
    loadAddons: loadLiveAddons,
    isInstalledAddonsRoute,
  };

  window.addEventListener('hashchange', () => {
    pretouchInstalledRoute();
    scheduleMount();
    scheduleVisibilityRefresh();
  });
  window.addEventListener('popstate', () => {
    pretouchInstalledRoute();
    scheduleMount();
    scheduleVisibilityRefresh();
  });
  window.addEventListener('resize', () => {
    if (isInstalledAddonsRoute()) positionOverlays();
    if (sourceMenuOpen) positionSourceMenu();
  });
  document.addEventListener('stremio-custom-bootstrap-ready', scheduleMount);
  document.addEventListener('stremio-custom-route-change', () => {
    pretouchInstalledRoute();
    scheduleMount();
    scheduleVisibilityRefresh();
  });
  document.addEventListener('stremio-custom-metadata-addon-changed', () => {
    if (isInstalledAddonsRoute()) {
      paintMetadataChip();
      if (sourceMenuOpen) renderSourceMenuOptions();
    }
  });
  document.addEventListener('stremio-custom-disabled-addons-changed', () => {
    if (isInstalledAddonsRoute()) refreshListPreserveScroll();
  });
  document.addEventListener('click', closeMenus);

  observer = new MutationObserver(() => {
    if (domLock) return;
    if (isDiscoverRoute()) applyDiscoverCatalogFilter();
    if (isBoardRoute()) applyBoardCatalogFilter();
    if (!isInstalledAddonsRoute()) {
      if (document.getElementById(ROOT_ID) || document.getElementById(TOOLBAR_ID)) teardown();
      return;
    }
    const bar = document.getElementById(TOOLBAR_ID);
    const inputs = findSelectableInputs();
    if (!document.getElementById(ROOT_ID) || !bar || (inputs && !inputs.contains(bar))) {
      scheduleMount();
    }
    syncNativeDialogState();
  });

  const boot = () => {
    const root = document.body || document.documentElement;
    if (!root) {
      window.setTimeout(boot, 200);
      return;
    }
    installCatalogSearchFilter();
    observer.observe(root, { childList: true, subtree: true });
    pretouchInstalledRoute();
    scheduleMount();
    scheduleVisibilityRefresh();
    void healKitsuMetaIfNeeded();
    void syncMetadataPreferenceOnBoot();
  };
  boot();

  console.info('[StremioCustom] Own addon manager ready.');
})();
