(function () {
  'use strict';

  if (window.__stremioCustomLibraryFolders) return;
  window.__stremioCustomLibraryFolders = true;

  const STORAGE_KEY = 'stremio-custom-library-folders';
  const ACTIVE_FOLDER_KEY = 'stremio-custom-library-active-folder';
  const LAST_SELECTED_ITEM_KEY = 'stremio-custom-library-last-selected-item';
  const STYLE_ID = 'stremio-custom-library-folders-style';
  const ROW_ID = 'stremio-custom-library-folders-row';
  const PLUS_ID = 'stremio-custom-library-folder-plus';
  const MENU_ID = 'stremio-custom-library-folder-menu';
  const MODAL_ID = 'stremio-custom-library-folder-modal';
  const TOAST_ID = 'stremio-custom-library-folder-toast';
  const CSV_SCOPE_KEY = 'stremio-custom-library-csv-scope';
  const LIBRARY_SETTINGS_ID = 'mystremio-library-csv';
  const DETAIL_LINK_SELECTOR =
    'a[href^="stremio:///detail/"], a[href*="#/detail/"], a[href*="/detail/"]';

  let activeFolderId = null;
  let injectTimer = null;
  let filterTimer = null;
  let contextMenuBound = false;
  let itemClickBound = false;
  let lastFolderSignature = '';
  let gridLayoutLocked = false;
  let railPositionBound = false;
  let customRailBound = false;
  let suppressInjectUntil = 0;

  function getUiLanguage() {
    try {
      const chips = Array.from(
        document.querySelectorAll(
          '[class*="library-container"] [class*="chip-"]:not([data-sc-custom-folder-tab])'
        )
      );
      const labels = chips
        .map((chip) => (chip.textContent || '').trim().toLowerCase())
        .join('|');

      if (/(last watched|not watched|most watched|\bwatched\b|a-z|z-a)/.test(labels)) {
        return 'en';
      }
      if (/(zuletzt|nicht gesehen|meist gesehen|ungesehen)/.test(labels)) {
        return 'de';
      }

      const htmlLang = String(document.documentElement.lang || '').toLowerCase();
      if (htmlLang.startsWith('en')) return 'en';
      if (htmlLang.startsWith('de')) return 'de';

      return 'en';
    } catch {
      return 'en';
    }
  }

  function t(en, de) {
    return getUiLanguage() === 'de' ? de : en;
  }

  const TEXT = {
    addToCollection: () => t('Add to collection', 'Zu Sammlung hinzufügen'),
    createCollection: () => t('Create new collection…', 'Neue Sammlung erstellen…'),
    newCollection: () => t('New collection…', 'Neue Sammlung…'),
    activeCollection: () => t('Active collection', 'Aktive Sammlung'),
    removeFromActive: () => t('Remove from active collection', 'Aus aktiver Sammlung entfernen'),
    addedTo: (name) => t(`Added to “${name}”`, `Zu „${name}“ hinzugefügt`),
    removedFrom: (name) => t(`Removed from “${name}”`, `Aus „${name}“ entfernt`),
    removed: () => t('Removed', 'Entfernt'),
    rename: () => t('Rename', 'Umbenennen'),
    clearCollection: () => t('Clear collection', 'Sammlung leeren'),
    deleteCollection: () => t('Delete collection', 'Sammlung löschen'),
    newCollectionTitle: () => t('Name of new collection', 'Name der neuen Sammlung'),
    renameTitle: () => t('New collection name', 'Neuer Name der Sammlung'),
    cancel: () => t('Cancel', 'Abbrechen'),
    confirm: () => t('OK', 'OK'),
    plusTitle: () => t('New collection', 'Neue Sammlung'),
    plusTitleHint: () =>
      t('New collection (Shift+click title to add)', 'Neue Sammlung (Shift+Klick auf Titel zum Hinzufügen)'),
    exportCollectionsCsv: () => t('Export collections CSV', 'Sammlungen als CSV exportieren'),
    importCollectionsCsv: () => t('Import collections CSV', 'Sammlungen aus CSV importieren'),
    exportLibraryCsvLabel: () => t('Export CSV', 'CSV exportieren'),
    importLibraryCsvLabel: () => t('Import CSV', 'CSV importieren'),
    libraryRowTitle: () => t('Library', 'Bibliothek'),
    customCollectionsTitle: () => t('Custom Library Collections', 'Eigene Sammlungen'),
    scopeMoviesShort: () => t('Movies', 'Filme'),
    scopeSeriesShort: () => t('Series', 'Serien'),
    scopeBothShort: () => t('Both', 'Beides'),
    scopePlaceholder: () => t('Select', 'Auswählen'),
    csvScope: () => t('Export / import', 'Export / Import'),
    exportedCsv: (count) => t(`Exported ${count} titles`, `${count} Titel exportiert`),
    importedCsv: ({ added, already, skipped, folders }) =>
      t(
        `${added} new, ${already} already there, ${skipped} skipped, ${folders} collections`,
        `${added} neu, ${already} schon da, ${skipped} übersprungen, ${folders} Sammlungen`
      ),
    importEmpty: () => t('CSV has no titles', 'CSV enthält keine Titel'),
    importFailed: () => t('Could not import CSV', 'CSV konnte nicht importiert werden'),
    libraryUnread: () => t('Could not read the library', 'Bibliothek konnte nicht gelesen werden'),
  };

  function isLibraryPage() {
    const hash = location.hash || '';
    const path = location.pathname || '';
    return (
      /#\/library(?:[/?#]|$)/.test(hash) || /^\/library(?:\/|$)/.test(path)
    );
  }

  function loadFolders() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list)
        ? list.filter((folder) => folder && folder.id && folder.name)
        : [];
    } catch {
      return [];
    }
  }

  function saveFolders(folders) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(folders));
    window.StremioCustom?.helpers?.persistUserPreferences?.();
  }

  function readActiveFolderId() {
    try {
      return sessionStorage.getItem(ACTIVE_FOLDER_KEY) || localStorage.getItem(ACTIVE_FOLDER_KEY) || null;
    } catch {
      try {
        return localStorage.getItem(ACTIVE_FOLDER_KEY) || null;
      } catch {
        return null;
      }
    }
  }

  function writeActiveFolderId(id) {
    activeFolderId = id || null;
    try {
      if (id) sessionStorage.setItem(ACTIVE_FOLDER_KEY, id);
      else sessionStorage.removeItem(ACTIVE_FOLDER_KEY);
    } catch (_) {}
    try {
      if (id) localStorage.setItem(ACTIVE_FOLDER_KEY, id);
      else localStorage.removeItem(ACTIVE_FOLDER_KEY);
    } catch (_) {}
    window.StremioCustom?.helpers?.persistUserPreferences?.();
  }

  function clearStickySelection() {
    try {
      sessionStorage.removeItem(LAST_SELECTED_ITEM_KEY);
    } catch (_) {}
    const selected = document.querySelectorAll(
      '[class*="meta-item-container"][class*="selected"], [class*="meta-item"][class*="selected"]'
    );
    selected.forEach((node) => node.classList.remove('selected'));
  }

  function getActiveFolder() {
    if (!activeFolderId) return null;
    return loadFolders().find((folder) => folder.id === activeFolderId) || null;
  }

  function createFolderId() {
    return `folder-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  function normalizeItemKey(type, id) {
    const cleanType = String(type || 'movie').trim().toLowerCase();
    let cleanId = String(id || '').trim();
    try {
      cleanId = decodeURIComponent(cleanId);
    } catch (_) {}
    if (!cleanId) return null;
    return `${cleanType}:${cleanId}`;
  }

  function parseDetailHref(href) {
    if (!href) return null;
    const match = String(href).match(/detail\/(movie|series|channel|tv|other)\/([^/?#]+)/i);
    if (!match) return null;
    return normalizeItemKey(match[1], match[2]);
  }

  function extractItemKeyFromNode(node) {
    if (!node) return null;

    const link = node.matches?.('a[href*="detail"]')
      ? node
      : node.querySelector?.(DETAIL_LINK_SELECTOR) ||
        node.closest?.(DETAIL_LINK_SELECTOR);

    if (link) {
      const key = parseDetailHref(link.getAttribute('href') || link.href || '');
      if (key) return key;
    }

    const img = node.querySelector?.('img[src*="tt"]');
    if (img) {
      const imdb = String(img.src || '').match(/tt\d{7,}/i);
      if (imdb) {
        const href =
          node.querySelector(DETAIL_LINK_SELECTOR)?.getAttribute('href') ||
          node.closest?.('[class*="meta-item"]')?.querySelector(DETAIL_LINK_SELECTOR)?.getAttribute('href') ||
          '';
        const parsed = parseDetailHref(href);
        if (parsed) return parsed;
        const type = /series/i.test(href) ? 'series' : 'movie';
        return normalizeItemKey(type, imdb[0]);
      }
    }

    return null;
  }

  function findMetaItemRoot(node) {
    return (
      node.closest?.('[class*="meta-item-container"]') ||
      node.closest?.('[class*="meta-item"]') ||
      node
    );
  }

  function ensureStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = `
      [class*="library-container"]
        [class*="library-content"],
      [class*="library-container"]
        [class*="selectable-inputs-container"],
      [class*="library-container"]
        [class*="selectable-inputs-container"]
        > [class*="horizontal-scroll"] {
        overflow: visible !important;
      }
      #${ROW_ID} {
        position: static !important;
        display: inline-flex !important;
        flex-direction: row !important;
        align-items: center !important;
        justify-content: flex-end !important;
        gap: 1rem !important;
        width: max-content !important;
        max-width: min(50vw, 28rem) !important;
        margin: 0 0 0 auto !important;
        padding: 0 !important;
        white-space: nowrap !important;
        pointer-events: auto !important;
        opacity: 1 !important;
        flex: 0 0 auto !important;
        box-sizing: border-box !important;
      }
      .sc-custom-library-chip {
        all: unset;
        box-sizing: border-box !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        height: 2.75rem !important;
        min-height: 2.75rem !important;
        max-height: 2.75rem !important;
        width: auto !important;
        min-width: 0 !important;
        max-width: 11rem !important;
        padding: 0 1.75rem !important;
        border-radius: 2.75rem !important;
        font: 500 1rem/1 var(--default-font-family, inherit) !important;
        color: var(--primary-foreground-color, #fff) !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        user-select: none !important;
        cursor: pointer !important;
        opacity: 0.75 !important;
        background: transparent !important;
        border: 1px solid transparent !important;
        flex: 0 0 auto !important;
        position: relative !important;
        margin: 0 !important;
      }
      .sc-custom-library-chip-label {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        max-width: 100% !important;
      }
      .sc-custom-library-chip:hover {
        opacity: 1 !important;
        background: var(--overlay-color, rgba(255, 255, 255, 0.08)) !important;
      }
      .sc-custom-library-chip.sc-custom-library-chip-active {
        opacity: 1 !important;
        background: rgba(70, 70, 70, 0.22) !important;
        box-shadow:
          0 2px 8px rgba(0, 0, 0, 0.2),
          inset 0 1px 0 rgba(255, 255, 255, 0.15) !important;
        backdrop-filter: blur(20px) saturate(180%) !important;
        border: 1px solid rgba(255, 255, 255, 0.04) !important;
      }
      #${PLUS_ID} {
        all: unset;
        box-sizing: border-box !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        height: 2.75rem !important;
        width: 2.75rem !important;
        min-width: 2.75rem !important;
        max-width: 2.75rem !important;
        padding: 0 !important;
        border-radius: 2.75rem !important;
        font: 600 1.2rem/1 var(--default-font-family, inherit) !important;
        color: #fff !important;
        cursor: pointer !important;
        flex: 0 0 auto !important;
        opacity: 1 !important;
        background: rgba(70, 70, 70, 0.22) !important;
        box-shadow:
          0 2px 8px rgba(0, 0, 0, 0.2),
          inset 0 1px 0 rgba(255, 255, 255, 0.15) !important;
        backdrop-filter: blur(20px) saturate(180%) !important;
        border: 1px solid rgba(255, 255, 255, 0.04) !important;
      }
      body.sc-custom-library-folder-active
        [class*="library-container"]
        [class*="chip-"]:not([data-sc-custom-folder-tab])[class*="active-"] {
        background: transparent !important;
        box-shadow: none !important;
        border-color: transparent !important;
        backdrop-filter: none !important;
        font-weight: inherit !important;
      }
      body.sc-custom-library-folder-active
        [class*="library-container"]
        [class*="library-content"],
      body.sc-custom-library-folder-active
        [class*="library-container"]
        [class*="meta-items-container"] {
        width: 100% !important;
        max-width: 100% !important;
        align-self: stretch !important;
        justify-items: stretch !important;
        flex: 1 1 auto !important;
      }
      body.sc-custom-library-folder-active
        [class*="library-container"]
        [class*="meta-item-container"]:not(.sc-folder-hidden) {
        width: 100% !important;
        max-width: none !important;
        min-width: 0 !important;
        justify-self: stretch !important;
      }
      [class*="library-container"] [class*="meta-item-container"].sc-folder-hidden {
        display: none !important;
      }
      #${MENU_ID} {
        position: fixed;
        z-index: 300001;
        min-width: 210px;
        max-width: min(320px, calc(100vw - 2rem));
        display: none;
        background: rgba(30, 30, 30, 0.92);
        backdrop-filter: blur(20px) saturate(180%);
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow:
          0 8px 32px rgba(0, 0, 0, 0.5),
          0 4px 16px rgba(0, 0, 0, 0.3),
          inset 0 1px 0 rgba(255, 255, 255, 0.1);
        overflow: hidden;
        padding: 6px;
      }
      #${MENU_ID}.open { display: block; }
      #${MENU_ID} .stremio-custom-library-menu-label {
        padding: 12px 16px 8px;
        font-size: 12px;
        line-height: 1.5;
        color: rgba(255, 255, 255, 0.85);
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        margin-bottom: 4px;
      }
      #${MENU_ID} button {
        display: flex;
        align-items: center;
        gap: 10px;
        width: calc(100% - 8px);
        margin: 2px 4px;
        text-align: left;
        border: 0;
        background: transparent;
        color: #fff;
        padding: 10px 16px;
        border-radius: 8px;
        font: inherit;
        font-size: 14px;
        cursor: pointer;
        transition: background 0.2s ease;
      }
      #${MENU_ID} button:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      #${MENU_ID} button.sc-checked {
        color: rgba(255, 255, 255, 0.95);
      }
      #${MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 300002;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.55);
        pointer-events: auto;
      }
      #${MODAL_ID}.open { display: flex; }
      #${MODAL_ID} .stremio-custom-library-modal-card {
        width: min(420px, calc(100vw - 2rem));
        background: rgba(30, 30, 30, 0.92);
        backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 14px;
        box-shadow:
          0 16px 40px rgba(0, 0, 0, 0.45),
          inset 0 1px 0 rgba(255, 255, 255, 0.1);
        padding: 1rem 1rem 0.85rem;
      }
      #${MODAL_ID} h3 {
        margin: 0 0 0.75rem;
        font-size: 1.05rem;
        font-weight: 600;
        color: #fff;
      }
      #${MODAL_ID} input {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.06);
        color: #fff;
        border-radius: 8px;
        padding: 0.55rem 0.7rem;
        font: inherit;
      }
      #${MODAL_ID} .stremio-custom-library-modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        margin-top: 0.9rem;
      }
      #${MODAL_ID} .stremio-custom-library-modal-actions button {
        appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
        border-radius: 999px;
        padding: 0.4rem 0.95rem;
        font: inherit;
        cursor: pointer;
      }
      #${MODAL_ID} .stremio-custom-library-modal-actions button.primary {
        background: rgba(120, 120, 120, 0.55);
        font-weight: 600;
      }
    `;
  }

  function ensureNameModal() {
    let modal = document.getElementById(MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="stremio-custom-library-modal-card" role="dialog" aria-modal="true">
        <h3></h3>
        <input type="text" maxlength="48" autocomplete="off" />
        <div class="stremio-custom-library-modal-actions">
          <button type="button" data-action="cancel"></button>
          <button type="button" data-action="confirm" class="primary"></button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    return modal;
  }

  function promptFolderName(title, defaultValue = '') {
    return new Promise((resolve) => {
      const modal = ensureNameModal();
      const heading = modal.querySelector('h3');
      const input = modal.querySelector('input');
      const cancelBtn = modal.querySelector('[data-action="cancel"]');
      const confirmBtn = modal.querySelector('[data-action="confirm"]');
      if (!heading || !input || !cancelBtn || !confirmBtn) {
        resolve(null);
        return;
      }

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        modal.classList.remove('open');
        modal.removeEventListener('click', onBackdropClick, true);
        document.removeEventListener('keydown', onKeyDown, true);
        resolve(value);
      };

      const submit = () => {
        const value = input.value.trim();
        if (!value) {
          input.focus();
          return;
        }
        finish(value);
      };

      const onBackdropClick = (event) => {
        if (event.target === modal) finish(null);
      };

      const onKeyDown = (event) => {
        if (event.key === 'Escape') finish(null);
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      };

      heading.textContent = title;
      cancelBtn.textContent = TEXT.cancel();
      confirmBtn.textContent = TEXT.confirm();
      input.value = defaultValue || '';
      modal.classList.add('open');
      modal.addEventListener('click', onBackdropClick, true);
      document.addEventListener('keydown', onKeyDown, true);

      cancelBtn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      };
      confirmBtn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        submit();
      };

      window.setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    });
  }

  function closeMenu() {
    const menu = document.getElementById(MENU_ID);
    if (!menu) return;
    menu.classList.remove('open');
    menu.innerHTML = '';
  }

  function openMenu(x, y, items) {
    let menu = document.getElementById(MENU_ID);
    if (!menu) {
      menu = document.createElement('div');
      menu.id = MENU_ID;
      document.body.appendChild(menu);
      document.addEventListener('click', closeMenu, true);
      window.addEventListener('resize', closeMenu);
      window.addEventListener('hashchange', closeMenu);
      window.addEventListener('scroll', closeMenu, true);
    }

    menu.innerHTML = '';
    for (const item of items) {
      if (item.type === 'label') {
        const label = document.createElement('div');
        label.className = 'stremio-custom-library-menu-label';
        label.textContent = item.text;
        menu.appendChild(label);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = item.text;
      if (item.checked) btn.classList.add('sc-checked');
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        item.onClick?.();
      });
      menu.appendChild(btn);
    }

    menu.classList.add('open');
    menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 240)}px`;
  }

  function showToast(message) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      toast.style.cssText =
        'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:300003;' +
        'background:rgba(30,30,30,0.92);color:#fff;padding:0.65rem 1rem;border-radius:12px;' +
        'border:1px solid rgba(255,255,255,0.12);font:inherit;pointer-events:none;' +
        'backdrop-filter:blur(20px) saturate(180%);box-shadow:0 8px 32px rgba(0,0,0,0.45);';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(showToast._timer);
    showToast._timer = window.setTimeout(() => {
      toast.style.opacity = '0';
    }, 2200);
  }

  function buildFolderMenuItems(itemKey) {
    const folders = loadFolders();
    const menuItems = [{ type: 'label', text: TEXT.addToCollection() }];

    if (!folders.length) {
      menuItems.push({
        text: TEXT.createCollection(),
        onClick: () => {
          void createFolder().then((created) => {
            if (created) {
              addItemToFolder(created.id, itemKey);
              showToast(TEXT.addedTo(created.name));
            }
          });
        },
      });
      return menuItems;
    }

    folders.forEach((folder) => {
      const hasItem = folder.items?.includes(itemKey);
      menuItems.push({
        text: hasItem ? `✓ ${folder.name}` : folder.name,
        checked: hasItem,
        onClick: () => {
          if (hasItem) {
            removeItemFromFolder(folder.id, itemKey);
            showToast(TEXT.removedFrom(folder.name));
          } else {
            addItemToFolder(folder.id, itemKey);
            showToast(TEXT.addedTo(folder.name));
          }
        },
      });
    });

    menuItems.push({
      text: TEXT.newCollection(),
      onClick: () => {
        void createFolder().then((created) => {
          if (created) {
            addItemToFolder(created.id, itemKey);
            showToast(TEXT.addedTo(created.name));
          }
        });
      },
    });

    if (activeFolderId) {
      menuItems.push({ type: 'label', text: TEXT.activeCollection() });
      menuItems.push({
        text: TEXT.removeFromActive(),
        onClick: () => {
          removeItemFromFolder(activeFolderId, itemKey);
          const folder = getActiveFolder();
          showToast(folder ? TEXT.removedFrom(folder.name) : TEXT.removed());
        },
      });
    }

    return menuItems;
  }

  function addItemToFolder(folderId, itemKey) {
    if (!folderId || !itemKey) return;
    const folders = loadFolders();
    const folder = folders.find((entry) => entry.id === folderId);
    if (!folder) return;
    if (!Array.isArray(folder.items)) folder.items = [];
    if (!folder.items.includes(itemKey)) folder.items.push(itemKey);
    saveFolders(folders);
    scheduleFilter();
  }

  function removeItemFromFolder(folderId, itemKey) {
    const folders = loadFolders();
    const folder = folders.find((entry) => entry.id === folderId);
    if (!folder || !Array.isArray(folder.items)) return;
    folder.items = folder.items.filter((entry) => entry !== itemKey);
    saveFolders(folders);
    scheduleFilter();
  }

  function deleteFolder(folderId) {
    const folders = loadFolders().filter((entry) => entry.id !== folderId);
    saveFolders(folders);
    if (activeFolderId === folderId) writeActiveFolderId(null);
    lastFolderSignature = '';
    renderFolderTabs();
    scheduleFilter();
  }

  async function renameFolder(folderId) {
    const folders = loadFolders();
    const folder = folders.find((entry) => entry.id === folderId);
    if (!folder) return;
    const nextName = await promptFolderName(TEXT.renameTitle(), folder.name);
    if (!nextName) return;
    folder.name = nextName;
    saveFolders(folders);
    lastFolderSignature = '';
    renderFolderTabs();
  }

  async function createFolder(prefillName = '') {
    const name = await promptFolderName(TEXT.newCollectionTitle(), prefillName);
    if (!name) return null;
    const folders = loadFolders();
    const folder = { id: createFolderId(), name, items: [] };
    folders.push(folder);
    saveFolders(folders);
    writeActiveFolderId(folder.id);
    lastFolderSignature = '';
    renderFolderTabs();
    scheduleFilter();
    return folder;
  }

  function getInputsContainer() {
    return document.querySelector(
      '[class*="library-container"] [class*="selectable-inputs-container"]'
    );
  }

  function ensureCustomTabsGroup() {
    let group = document.getElementById(ROW_ID);
    if (!group) {
      group = document.createElement('div');
      group.id = ROW_ID;
    }
    return group;
  }

  function hideCustomRail() {
    const group = document.getElementById(ROW_ID);
    if (group) group.style.display = 'none';
  }

  function clearLibraryRouteState() {
    writeActiveFolderId(null);
    clearStickySelection();
    closeMenu();
    document.body.classList.remove('sc-custom-library-folder-active');
    const group = document.getElementById(ROW_ID);
    if (group) group.remove();
    document
      .querySelectorAll('[data-sc-custom-folder-tab], #' + PLUS_ID)
      .forEach((node) => node.remove());
  }

  function placeChipRow(inputsContainer, group) {
    const scroll =
      inputsContainer.querySelector(':scope > [class*="horizontal-scroll"]') ||
      inputsContainer.querySelector('[class*="horizontal-scroll"]');
    group.style.display = 'inline-flex';
    group.style.position = 'static';
    group.style.top = '';
    group.style.left = '';
    group.style.transform = '';
    group.style.opacity = '1';
    if (scroll?.parentElement) {
      if (group.previousElementSibling !== scroll) scroll.after(group);
      return;
    }
    if (group.parentElement !== inputsContainer) inputsContainer.appendChild(group);
  }

  function resetCustomTabLayout(tab) {
    if (!tab) return;
    tab.style.width = '';
    tab.style.minWidth = '';
    tab.style.maxWidth = '';
    tab.style.flex = '0 0 auto';
    tab.style.alignSelf = 'center';
    tab.style.margin = '0';
    tab.style.cursor = 'pointer';
  }

  function createChipElement(isActive) {
    const chip = document.createElement('div');
    chip.className = 'sc-custom-library-chip';
    if (isActive) chip.classList.add('sc-custom-library-chip-active');
    const label = document.createElement('span');
    label.className = 'sc-custom-library-chip-label';
    chip.appendChild(label);
    chip.style.cursor = 'pointer';
    return chip;
  }

  function applyCustomTabLook(tab, isActive) {
    if (!tab) return;
    if (tab.id === PLUS_ID) return;

    const folderId = tab.dataset.folderId;
    const text =
      tab.querySelector('.sc-custom-library-chip-label')?.textContent?.trim() ||
      tab.textContent?.trim() ||
      '';

    tab.className = 'sc-custom-library-chip';
    if (isActive) tab.classList.add('sc-custom-library-chip-active');
    tab.dataset.scCustomFolderTab = '1';
    if (folderId) tab.dataset.folderId = folderId;

    let label = tab.querySelector('.sc-custom-library-chip-label');
    if (!label) {
      label = document.createElement('span');
      label.className = 'sc-custom-library-chip-label';
      tab.appendChild(label);
    }
    label.textContent = text;
    tab.style.cursor = 'pointer';
  }

  function mountCustomTabsOnRightEdge(inputsContainer, orderedTabs) {
    if (!inputsContainer) return;

    const group = ensureCustomTabsGroup();
    const tabs = orderedTabs.filter(Boolean);
    const plus = tabs.find((tab) => tab.id === PLUS_ID) || ensurePlusButton();
    const folderTabs = tabs.filter((tab) => tab.id !== PLUS_ID);
    const mountKey = getRailMountKey(folderTabs, plus);

    if (
      group.dataset.scMountKey === mountKey &&
      group.contains(plus) &&
      folderTabs.every((tab) => group.contains(tab))
    ) {
      syncTabVisualState();
      placeChipRow(inputsContainer, group);
      return;
    }

    suppressInjectUntil = Date.now() + 250;
    group.dataset.scMountKey = mountKey;

    while (group.firstChild) group.removeChild(group.firstChild);

    folderTabs.forEach((tab) => {
      resetCustomTabLayout(tab);
      group.appendChild(tab);
    });

    resetCustomTabLayout(plus);
    group.appendChild(plus);

    placeChipRow(inputsContainer, group);

    syncTabVisualState();
  }

  function removeOrphanCustomTabs() {
    const group = document.getElementById(ROW_ID);
    document
      .querySelectorAll(`[data-sc-custom-folder-tab], #${PLUS_ID}`)
      .forEach((node) => {
        if (group?.contains(node)) return;
        if (node.id === PLUS_ID || node.dataset.folderId) node.remove();
      });
  }

  function getFolderSignature() {
    return loadFolders()
      .map((folder) => `${folder.id}:${folder.name}`)
      .join('|');
  }

  function getRailMountKey(folderTabs, plus) {
    return `${folderTabs.map((tab) => tab.dataset.folderId).join('|')}|${plus ? 'plus' : ''}`;
  }

  function writeChipText(chip, text) {
    const label = chip.querySelector('.sc-custom-library-chip-label');
    if (label) label.textContent = text;
    else chip.textContent = text;
  }

  function clearCustomTabSelection() {
    document.querySelectorAll('[data-sc-custom-folder-tab][data-folder-id]').forEach((tab) => {
      applyCustomTabLook(tab, false);
    });
  }

  function syncTabVisualState() {
    const container = getInputsContainer();
    document.body.classList.toggle('sc-custom-library-folder-active', Boolean(activeFolderId));
    if (!container) return;

    document.querySelectorAll('[data-sc-custom-folder-tab][data-folder-id]').forEach((tab) => {
      applyCustomTabLook(tab, tab.dataset.folderId === activeFolderId);
    });
  }

  function lockLibraryGridLayout() {
    if (gridLayoutLocked) return;
    const grid = document.querySelector(
      '[class*="library-container"] [class*="meta-items-container"]'
    );
    if (!grid) return;

    const computed = window.getComputedStyle(grid);
    if (computed.display === 'grid' && computed.gridTemplateColumns) {
      grid.style.gridTemplateColumns = computed.gridTemplateColumns;
      grid.dataset.scGridLocked = '1';
      gridLayoutLocked = true;
    }
  }

  function ensurePlusButton() {
    let plus = document.getElementById(PLUS_ID);
    if (!plus) {
      plus = document.createElement('button');
      plus.type = 'button';
      plus.id = PLUS_ID;
      plus.dataset.scCustomFolderTab = '1';
      plus.textContent = '+';
      plus.addEventListener(
        'click',
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          void createFolder();
        },
        true
      );
    }

    plus.title = getActiveFolder() ? TEXT.plusTitleHint() : TEXT.plusTitle();
    plus.textContent = '+';
    return plus;
  }

  function selectFolder(folderId) {
    writeActiveFolderId(folderId);
    clearStickySelection();
    syncTabVisualState();
    applyFolderFilter();
  }

  function applyFolderFilter() {
    if (!isLibraryPage()) return;

    const libraryRoot = document.querySelector('[class*="library-container"]');
    if (!libraryRoot) return;

    lockLibraryGridLayout();

    const folder = getActiveFolder();
    const nodes = libraryRoot.querySelectorAll('[class*="meta-item-container"]');

    nodes.forEach((root) => {
      if (!folder) {
        root.classList.remove('sc-folder-hidden');
        root.style.removeProperty('display');
        return;
      }

      const key = extractItemKeyFromNode(root);
      const visible = Boolean(key && folder.items.includes(key));
      root.classList.toggle('sc-folder-hidden', !visible);
      root.style.display = visible ? '' : 'none';
    });
  }

  function scheduleFilter() {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      filterTimer = null;
      applyFolderFilter();
    }, 80);
  }

  function getCore() {
    return window.core || window.services?.core?.transport || null;
  }

  function csvCell(value) {
    const text = String(value ?? '');
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const source = String(text || '').replace(/^\uFEFF/, '');
    const headerLine = source.split('\n', 1)[0] || '';
    // shortcut: delimiter from the first line only. Upgrade when a quoted comma in that line picks the wrong separator.
    const delimiter =
      (headerLine.match(/;/g) || []).length > (headerLine.match(/,/g) || []).length ? ';' : ',';
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (quoted) {
        if (char === '"') {
          if (source[i + 1] === '"') {
            cell += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          cell += char;
        }
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === delimiter) {
        row.push(cell);
        cell = '';
        continue;
      }
      if (char === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        continue;
      }
      if (char !== '\r') cell += char;
    }
    if (cell.length || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows.filter((entry) => entry.some((value) => String(value).trim()));
  }

  function unwrapBucketEntry(raw) {
    if (
      Array.isArray(raw) &&
      raw.length >= 2 &&
      raw[1] &&
      typeof raw[1] === 'object' &&
      !Array.isArray(raw[1])
    ) {
      const item = raw[1];
      if (!item.id && !item._id && raw[0] != null) return Object.assign({ _id: String(raw[0]) }, item);
      return item;
    }
    return raw;
  }

  function bucketEntries(bucket) {
    if (!bucket) return [];
    let list = [];
    if (Array.isArray(bucket)) list = bucket;
    else if (typeof bucket.forEach === 'function' && typeof bucket.size === 'number') {
      bucket.forEach((value) => list.push(value));
    } else if (typeof bucket === 'object') list = Object.values(bucket);
    return list.map(unwrapBucketEntry);
  }

  function splitTypedId(value) {
    const match = String(value || '').match(/^(movie|series|channel|tv):(.+)$/i);
    if (!match) return null;
    const type = match[1].toLowerCase() === 'tv' ? 'series' : match[1].toLowerCase();
    return { type, id: match[2] };
  }

  function normalizeLibraryRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const fromId = splitTypedId(raw.id);
    const fromStored = splitTypedId(raw._id);
    let type = String(raw.type || raw.type_name || fromId?.type || fromStored?.type || '').toLowerCase();
    if (type === 'tv') type = 'series';
    let id = raw.id || raw._id || '';
    if (fromId) id = fromId.id;
    else if (fromStored && (!raw.id || String(raw.id) === String(raw._id))) id = fromStored.id;
    const name = raw.name || raw.title;
    if (!id || !type || !name) return null;
    const poster = typeof raw.poster === 'string' ? raw.poster : '';
    const imdb = imdbOf(id, poster);
    const tmdbMatch = String(id).match(/tmdb:(?:movie:|series:|tv:)?(\d+)/i);
    return {
      id: String(id),
      type,
      name: String(name),
      poster,
      imdb,
      tmdb: tmdbMatch ? tmdbMatch[1] : '',
      removed: Boolean(raw.removed || raw.temp),
    };
  }

  function imdbOf(...parts) {
    const match = parts.filter(Boolean).join(' ').match(/tt\d{7,}/i);
    return match ? match[0].toLowerCase() : '';
  }

  function posterUrl(poster) {
    const value = String(poster || '').trim();
    return /^https?:\/\//i.test(value) ? value : '';
  }

  function displayPoster(poster, imdb) {
    return posterUrl(poster) || (imdb ? `https://images.metahub.space/poster/medium/${imdb}/img` : '');
  }

  function wasWatched(raw) {
    const state = raw && raw.state;
    if (!state || typeof state !== 'object') return false;
    return Boolean(
      state.timeWatched || state.time_watched ||
      state.timesWatched || state.times_watched ||
      state.flaggedWatched || state.flagged_watched ||
      state.lastWatched || state.last_watched
    );
  }

  async function readCoreModel(model) {
    try {
      if (window.services?.core?.transport?.getState) {
        return await window.services.core.transport.getState(model);
      }
    } catch (_) {}
    try {
      if (window.core?.getState) return await window.core.getState(model);
    } catch (_) {}
    return null;
  }

  function entriesFromStorage(rawLibrary, rawRecent) {
    const entries = [];
    for (const raw of [rawLibrary, rawRecent]) {
      if (!raw) continue;
      let parsed = raw;
      if (typeof raw === 'string') {
        try {
          parsed = JSON.parse(raw);
        } catch (_) {
          continue;
        }
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const bucket = Object.prototype.hasOwnProperty.call(parsed, 'items') ? parsed.items : parsed;
      entries.push(...bucketEntries(bucket));
    }
    return entries;
  }

  function recordsFromEntries(entries) {
    const visible = new Map();
    const metaIds = new Set();
    const byImdb = new Map();
    for (const raw of entries) {
      const item = normalizeLibraryRecord(raw);
      if (!item) continue;
      const key = normalizeItemKey(item.type, item.id);
      if (!key) continue;
      const splitAt = key.indexOf(':');
      const metaId = key.slice(splitAt + 1);
      const type = key.slice(0, splitAt);
      metaIds.add(metaId);
      const record = {
        key,
        id: metaId,
        type,
        name: item.name,
        poster: item.poster,
        imdb: item.imdb,
        tmdb: item.tmdb,
        watched: wasWatched(raw),
      };
      if (!item.removed) {
        visible.set(key, record);
        if (item.imdb) {
          const canon = `${type}:${item.imdb}`;
          const prev = byImdb.get(canon);
          if (!prev || /^tt\d/i.test(metaId)) byImdb.set(canon, record);
        }
      }
    }
    return { visible, metaIds, byImdb };
  }

  function readStorageEntries() {
    let sawKey = false;
    const chunks = [];
    try {
      for (const key of ['library', 'library_recent']) {
        const raw = localStorage.getItem(key);
        if (raw == null) continue;
        sawKey = true;
        chunks.push(raw);
      }
    } catch (_) {
      return { sawKey: false, entries: [] };
    }
    return { sawKey, entries: entriesFromStorage(chunks[0], chunks[1]) };
  }

  function catalogRows(library) {
    if (Array.isArray(library?.catalog)) return library.catalog;
    const content = library?.catalog?.content;
    if (content?.type === 'Ready' && Array.isArray(content.content)) return content.content;
    return null;
  }

  async function loadLibraryFromCatalog() {
    const transport = window.services?.core?.transport || window.core?.transport || window.core;
    if (!transport?.dispatch) return null;
    try {
      await transport.dispatch(
        { action: 'Load', args: { model: 'LibraryWithFilters', args: { request: { type: null } } } },
        'library'
      );
    } catch (_) {
      return null;
    }
    let library = await readCoreModel('library');
    for (let page = 0; page < 100; page += 1) {
      const requestType = library?.selected?.request?.type;
      if (!library?.selected || requestType != null) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        library = await readCoreModel('library');
        continue;
      }
      // shortcut: at most 100 pages of 100 titles. Upgrade when a library is larger than that and localStorage has no copy.
      const next = library?.selectable?.nextPage || library?.selectable?.next_page;
      if (!next) break;
      const before = catalogRows(library)?.length || 0;
      try {
        await transport.dispatch({ action: 'LibraryWithFilters', args: { action: 'LoadNextPage' } }, 'library');
      } catch (_) {
        break;
      }
      library = await readCoreModel('library');
      if ((catalogRows(library)?.length || 0) <= before) break;
    }
    const rows = catalogRows(library);
    if (!rows) return null;
    return recordsFromEntries(bucketEntries(rows));
  }

  async function loadLibraryItems() {
    // ctx.library is not sent to the page, so the saved bucket is the full list.
    const stored = readStorageEntries();
    if (stored.entries.length) return recordsFromEntries(stored.entries);
    const paged = await loadLibraryFromCatalog();
    if (paged && (paged.visible.size || paged.metaIds.size)) return paged;
    if (stored.sawKey) return recordsFromEntries(stored.entries);
    return null;
  }

  function folderNameForKey(itemKey) {
    return loadFolders()
      .filter((folder) => Array.isArray(folder.items) && folder.items.includes(itemKey))
      .map((folder) => folder.name)
      .join(';');
  }

  function ensureFolderByName(folders, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    let folder = folders.find((entry) => entry.name === trimmed);
    if (!folder) {
      folder = { id: createFolderId(), name: trimmed, items: [] };
      folders.push(folder);
    }
    if (!Array.isArray(folder.items)) folder.items = [];
    return folder;
  }

  function readCsvScope() {
    try {
      const raw = localStorage.getItem(CSV_SCOPE_KEY);
      if (raw === 'movie' || raw === 'series' || raw === 'both') return raw;
    } catch (_) {}
    return 'both';
  }

  function writeCsvScope(scope) {
    const next = scope === 'movie' || scope === 'series' ? scope : 'both';
    try {
      localStorage.setItem(CSV_SCOPE_KEY, next);
    } catch (_) {}
    return next;
  }

  function typeMatchesScope(type, scope) {
    const value = String(type || '').trim().toLowerCase();
    if (value !== 'movie' && value !== 'series') return false;
    if (scope === 'movie') return value === 'movie';
    if (scope === 'series') return value === 'series';
    return true;
  }

  function activeCsvScope() {
    if (sessionCsvScope === 'movie' || sessionCsvScope === 'series' || sessionCsvScope === 'both') {
      return sessionCsvScope;
    }
    sessionCsvScope = readCsvScope();
    return sessionCsvScope;
  }

  function libraryRowDecision(visibleKeys, metaIds, type, id, name, scope) {
    const key = normalizeItemKey(type, id);
    if (!key || !String(name || '').trim() || !typeMatchesScope(type, scope)) return { action: 'skip' };
    const splitAt = key.indexOf(':');
    const metaId = key.slice(splitAt + 1);
    const cleanType = key.slice(0, splitAt);
    if (visibleKeys.has(key)) return { action: 'already', key, metaId, type: cleanType };
    if (metaIds.has(metaId)) return { action: 'skip' };
    return { action: 'add', key, metaId, type: cleanType };
  }

  function mergeLibraryExportRows(items) {
    const byCanon = new Map();
    const order = [];
    for (const item of items) {
      const imdb = imdbOf(item.imdb, item.id, item.poster);
      const canonId = imdb || item.id;
      const canon = imdb ? `imdb:${item.type}:${imdb}` : `id:${item.type}:${item.id}`;
      let row = byCanon.get(canon);
      if (!row) {
        row = {
          type: item.type,
          id: canonId,
          name: item.name,
          poster: item.poster,
          imdb,
          folders: new Set(String(item.folder || '').split(';').filter(Boolean)),
          alts: new Set(),
        };
        byCanon.set(canon, row);
        order.push(row);
      } else {
        if (!posterUrl(row.poster) && posterUrl(item.poster)) row.poster = item.poster;
        if (!row.name && item.name) row.name = item.name;
        for (const folderName of String(item.folder || '').split(';')) {
          if (folderName) row.folders.add(folderName);
        }
      }
      if (item.id && item.id !== row.id) row.alts.add(item.id);
    }
    return order.map((row) => ({
      type: row.type,
      id: row.id,
      name: row.name,
      folder: [...row.folders].join(';'),
      poster: displayPoster(row.poster, row.imdb),
      imdb: row.imdb,
      alt: [...row.alts].join(';'),
    }));
  }

  function spareLibraryIds(visible, type, canonKey, imdb, alt) {
    const alts = new Set(String(alt || '').split(';').map((value) => value.trim()).filter(Boolean));
    const drops = [];
    for (const record of visible.values()) {
      if (record.type !== type || record.key === canonKey || record.watched) continue;
      if ((imdb && record.imdb === imdb) || alts.has(record.id)) drops.push(record.id);
    }
    return drops;
  }

  function planLibraryImportRow(visible, byImdb, metaIds, type, id, name, scope, imdb, poster, alt) {
    const key = normalizeItemKey(type, id);
    if (!key || !String(name || '').trim() || !typeMatchesScope(type, scope)) return { action: 'skip' };
    const splitAt = key.indexOf(':');
    const metaId = key.slice(splitAt + 1);
    const cleanType = key.slice(0, splitAt);
    const knownImdb = imdbOf(imdb, metaId, poster);
    const canonId = knownImdb || metaId;
    const canonKey = normalizeItemKey(cleanType, canonId);
    const hit = (knownImdb && byImdb.get(`${cleanType}:${knownImdb}`)) || visible.get(canonKey);
    const posterValue = displayPoster(poster, knownImdb);
    if (hit) {
      return {
        action: !posterUrl(hit.poster) && posterValue ? 'fill' : 'already',
        key: hit.key,
        metaId: hit.id,
        type: hit.type,
        poster: posterValue,
        imdb: knownImdb,
        dropIds: spareLibraryIds(visible, cleanType, hit.key, knownImdb, alt),
      };
    }
    if (metaIds.has(canonId)) return { action: 'skip' };
    return {
      action: 'add',
      key: canonKey,
      metaId: canonId,
      type: cleanType,
      poster: posterValue,
      imdb: knownImdb,
      dropIds: spareLibraryIds(visible, cleanType, canonKey, knownImdb, alt),
    };
  }

  function mergeCollectionRows(existingFolders, rows) {
    const folders = existingFolders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      items: Array.isArray(folder.items) ? folder.items.slice() : [],
    }));
    const byName = new Map(folders.map((folder) => [folder.name, folder]));
    let added = 0;
    let already = 0;
    let skipped = 0;
    let sawFolder = false;
    const touched = new Set();
    const header = (rows[0] || []).map((cell) => String(cell).trim().toLowerCase());
    const folderIndex = header.indexOf('folder');
    const typeIndex = header.indexOf('type');
    const idIndex = header.indexOf('id');
    const dataRows = folderIndex >= 0 ? rows.slice(1) : rows;
    for (const row of dataRows) {
      const name = String(row[folderIndex >= 0 ? folderIndex : 0] || '').trim();
      const type = String(row[typeIndex >= 0 ? typeIndex : 1] || '').trim();
      const id = String(row[idIndex >= 0 ? idIndex : 2] || '').trim();
      if (!name) {
        skipped += 1;
        continue;
      }
      sawFolder = true;
      let folder = byName.get(name);
      if (!folder) {
        folder = { id: createFolderId(), name, items: [] };
        byName.set(name, folder);
        folders.push(folder);
        touched.add(folder.id);
      }
      const key = type && id ? normalizeItemKey(type, id) : null;
      if (!key) continue;
      if (folder.items.includes(key)) {
        already += 1;
        continue;
      }
      folder.items.push(key);
      added += 1;
      touched.add(folder.id);
    }
    return { folders, added, already, skipped, sawFolder, touched: touched.size };
  }

  function downloadCsv(filename, lines) {
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  }

  function exportCollectionsCsv() {
    const lines = [['folder', 'type', 'id'].join(',')];
    for (const folder of loadFolders()) {
      const items = Array.isArray(folder.items) ? folder.items : [];
      if (!items.length) {
        lines.push([folder.name, '', ''].map(csvCell).join(','));
        continue;
      }
      for (const item of items) {
        const [type, ...rest] = String(item).split(':');
        lines.push([folder.name, type, rest.join(':')].map(csvCell).join(','));
      }
    }
    downloadCsv('mystremio-collections.csv', lines);
    showToast(TEXT.exportedCsv(Math.max(lines.length - 1, 0)));
  }

  async function importCollectionsCsv() {
    const file = await pickCsvFile();
    if (!file) return;
    let rows;
    try {
      rows = parseCsv(await file.text());
    } catch (_) {
      showToast(TEXT.importFailed());
      return;
    }
    if (!rows.length) {
      showToast(TEXT.importEmpty());
      return;
    }
    const plan = mergeCollectionRows(loadFolders(), rows);
    if (!plan.sawFolder) {
      showToast(TEXT.importEmpty());
      return;
    }
    if (plan.touched) {
      saveFolders(plan.folders);
      lastFolderSignature = '';
      renderFolderTabs();
      scheduleFilter();
    }
    showToast(
      TEXT.importedCsv({
        added: plan.added,
        already: plan.already,
        skipped: plan.skipped,
        folders: plan.touched,
      })
    );
  }

  async function readTmdbKey() {
    try {
      const config = await window.StremioCustomAPI?.getPluginConfig?.('data-enrichment');
      return String(config?.tmdbApiKey || '').trim();
    } catch (_) {
      return '';
    }
  }

  async function imdbFromTmdb(type, tmdbId, apiKey) {
    const kind = type === 'series' ? 'tv' : 'movie';
    try {
      const response = await fetch(
        `https://api.themoviedb.org/3/${kind}/${tmdbId}/external_ids?api_key=${encodeURIComponent(apiKey)}`
      );
      if (!response.ok) return '';
      const data = await response.json();
      return imdbOf(data?.imdb_id);
    } catch (_) {
      return '';
    }
  }

  async function exportLibraryCsv() {
    const scope = activeCsvScope();
    const loaded = await loadLibraryItems();
    if (!loaded) {
      showToast(TEXT.libraryUnread());
      return;
    }
    const rows = [];
    for (const [key, item] of loaded.visible) {
      if (!typeMatchesScope(item.type, scope)) continue;
      rows.push({
        type: item.type,
        id: item.id,
        name: item.name,
        folder: folderNameForKey(key),
        poster: item.poster,
        imdb: item.imdb,
        tmdb: item.tmdb,
      });
    }
    const apiKey = await readTmdbKey();
    const resolved = new Map();
    for (const row of rows) {
      if (row.imdb || !row.tmdb || !apiKey) continue;
      const cacheKey = `${row.type}:${row.tmdb}`;
      // shortcut: one TMDB lookup per id, in order. Upgrade when a large library makes export too slow.
      if (!resolved.has(cacheKey)) resolved.set(cacheKey, imdbFromTmdb(row.type, row.tmdb, apiKey));
      row.imdb = await resolved.get(cacheKey);
    }
    const merged = mergeLibraryExportRows(rows);
    const lines = [['type', 'id', 'name', 'folder', 'poster', 'imdb', 'alt'].join(',')];
    for (const row of merged) {
      lines.push([row.type, row.id, row.name, row.folder, row.poster, row.imdb, row.alt].map(csvCell).join(','));
    }
    downloadCsv('mystremio-library.csv', lines);
    showToast(TEXT.exportedCsv(merged.length));
  }

  function pickCsvFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,text/csv';
      input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.click();
    });
  }

  async function importLibraryCsv() {
    const scope = activeCsvScope();
    const file = await pickCsvFile();
    if (!file) return;
    let rows;
    try {
      rows = parseCsv(await file.text());
    } catch (_) {
      showToast(TEXT.importFailed());
      return;
    }
    if (!rows.length) {
      showToast(TEXT.importEmpty());
      return;
    }
    const header = rows[0].map((cell) => String(cell).trim().toLowerCase());
    const typeIndex = header.indexOf('type');
    const idIndex = header.indexOf('id');
    const nameIndex = header.indexOf('name');
    const folderIndex = header.indexOf('folder');
    const posterIndex = header.indexOf('poster');
    const imdbIndex = header.indexOf('imdb');
    const altIndex = header.indexOf('alt');
    const dataRows = typeIndex >= 0 && idIndex >= 0 ? rows.slice(1) : rows;
    const loaded = await loadLibraryItems();
    if (!loaded) {
      showToast(TEXT.libraryUnread());
      return;
    }
    const { visible, metaIds, byImdb } = loaded;
    const core = getCore();
    const folders = loadFolders();
    let added = 0;
    let already = 0;
    let skipped = 0;
    const touchedFolders = new Set();
    for (const row of dataRows) {
      const type = String(row[typeIndex >= 0 ? typeIndex : 0] || '').trim().toLowerCase();
      const id = String(row[idIndex >= 0 ? idIndex : 1] || '').trim();
      const name = String(row[nameIndex >= 0 ? nameIndex : 2] || '').trim();
      const folderCell = folderIndex >= 0 ? row[folderIndex] : '';
      const poster = posterIndex >= 0 ? row[posterIndex] : '';
      const imdb = imdbIndex >= 0 ? row[imdbIndex] : '';
      const alt = altIndex >= 0 ? row[altIndex] : '';
      const decision = planLibraryImportRow(visible, byImdb, metaIds, type, id, name, scope, imdb, poster, alt);
      if (decision.action === 'skip') {
        skipped += 1;
        continue;
      }
      if (decision.action === 'add' || decision.action === 'fill') {
        if (!core?.dispatch) {
          skipped += 1;
          continue;
        }
        const args = { id: decision.metaId, type: decision.type, name };
        if (decision.poster) {
          args.poster = decision.poster;
          args.posterShape = 'poster';
        }
        try {
          await core.dispatch({
            action: 'Ctx',
            args: { action: 'AddToLibrary', args },
          });
        } catch (error) {
          console.warn('[StremioCustom] Library CSV import failed:', error);
          skipped += 1;
          continue;
        }
        const record = visible.get(decision.key) || {
          key: decision.key,
          id: decision.metaId,
          type: decision.type,
          name,
          watched: false,
        };
        record.poster = decision.poster || record.poster;
        record.imdb = decision.imdb || record.imdb;
        visible.set(decision.key, record);
        metaIds.add(decision.metaId);
        if (decision.imdb) byImdb.set(`${decision.type}:${decision.imdb}`, record);
        if (decision.action === 'add') added += 1;
        else already += 1;
      } else {
        already += 1;
      }
      if (core?.dispatch) {
        for (const dropId of decision.dropIds || []) {
          const dropKey = normalizeItemKey(decision.type, dropId);
          try {
            await core.dispatch({
              action: 'Ctx',
              args: { action: 'RemoveFromLibrary', args: dropId },
            });
          } catch (error) {
            console.warn('[StremioCustom] Library CSV merge failed:', error);
            continue;
          }
          const gone = visible.get(dropKey);
          visible.delete(dropKey);
          if (gone?.imdb && byImdb.get(`${decision.type}:${gone.imdb}`)?.key === dropKey) {
            byImdb.delete(`${decision.type}:${gone.imdb}`);
          }
          for (const folder of folders) {
            if (!Array.isArray(folder.items)) continue;
            const index = folder.items.indexOf(dropKey);
            if (index < 0) continue;
            folder.items.splice(index, 1);
            if (decision.key && !folder.items.includes(decision.key)) folder.items.push(decision.key);
            touchedFolders.add(folder.id);
          }
        }
      }
      for (const folderName of String(folderCell || '').split(';')) {
        const folder = ensureFolderByName(folders, folderName);
        if (!folder || folder.items.includes(decision.key)) continue;
        folder.items.push(decision.key);
        touchedFolders.add(folder.id);
      }
    }
    if (touchedFolders.size) {
      saveFolders(folders);
      lastFolderSignature = '';
      renderFolderTabs();
      scheduleFilter();
    }
    showToast(TEXT.importedCsv({ added, already, skipped, folders: touchedFolders.size }));
  }

  function bindCustomRailInteractions() {
    if (customRailBound) return;
    customRailBound = true;

    document.addEventListener(
      'click',
      (event) => {
        if (!isLibraryPage()) return;

        const tab = event.target.closest('[data-sc-custom-folder-tab][data-folder-id]');
        if (!tab || tab.id === PLUS_ID) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        selectFolder(tab.dataset.folderId);
      },
      true
    );

    document.addEventListener(
      'contextmenu',
      (event) => {
        if (!isLibraryPage()) return;

        const tab = event.target.closest('[data-sc-custom-folder-tab][data-folder-id]');
        if (!tab || tab.id === PLUS_ID) return;

        const folder = loadFolders().find((entry) => entry.id === tab.dataset.folderId);
        if (!folder) return;

        event.preventDefault();
        event.stopPropagation();
        openMenu(event.clientX, event.clientY, [
          { type: 'label', text: folder.name },
          {
            text: TEXT.rename(),
            onClick: () => renameFolder(folder.id),
          },
          {
            text: TEXT.clearCollection(),
            onClick: () => {
              saveFolders(
                loadFolders().map((item) =>
                  item.id === folder.id ? { ...item, items: [] } : item
                )
              );
              scheduleFilter();
            },
          },
          {
            text: TEXT.deleteCollection(),
            onClick: () => deleteFolder(folder.id),
          },
        ]);
      },
      true
    );
  }

  function wireNativeTabs(container) {
    if (!container) return;
    container.querySelectorAll('[class*="chip-"]:not([data-sc-custom-folder-tab])').forEach((tab) => {
      if (tab.dataset.scNativeLibraryWired === '1') return;
      tab.dataset.scNativeLibraryWired = '1';
      tab.addEventListener(
        'click',
        () => {
          if (!activeFolderId) return;
          writeActiveFolderId(null);
          clearStickySelection();
          clearCustomTabSelection();
          document.body.classList.remove('sc-custom-library-folder-active');
          scheduleFilter();
        },
        false
      );
    });
  }

  function collectOrderedCustomTabs(folders, plus) {
    const byId = new Map(
      Array.from(
        document.querySelectorAll('[data-sc-custom-folder-tab][data-folder-id]')
      ).map((tab) => [tab.dataset.folderId, tab])
    );
    const folderTabs = folders.map((folder) => byId.get(folder.id)).filter(Boolean);
    return [...folderTabs, plus];
  }

  function renderFolderTabs() {
    if (!isLibraryPage()) return;

    const inputsContainer = getInputsContainer();
    if (!inputsContainer) return;

    const signature = getFolderSignature();
    const folders = loadFolders();
    const plus = ensurePlusButton();
    const existingTabs = new Map(
      Array.from(
        document.querySelectorAll('[data-sc-custom-folder-tab][data-folder-id]')
      ).map((tab) => [tab.dataset.folderId, tab])
    );
    const needsRebuild =
      signature !== lastFolderSignature || existingTabs.size !== folders.length;

    let rebuiltTabs = null;

    if (needsRebuild) {
      lastFolderSignature = signature;
      inputsContainer.style.pointerEvents = 'auto';
      document
        .querySelectorAll('[data-sc-custom-folder-tab][data-folder-id]')
        .forEach((tab) => tab.remove());

      rebuiltTabs = folders.map((folder) => {
        const tab = createChipElement(folder.id === activeFolderId);
        tab.dataset.scCustomFolderTab = '1';
        tab.dataset.folderId = folder.id;
        writeChipText(tab, folder.name);
        return tab;
      });
    }

    const orderedTabs = rebuiltTabs
      ? [...rebuiltTabs, plus]
      : collectOrderedCustomTabs(folders, plus);

    mountCustomTabsOnRightEdge(inputsContainer, orderedTabs);
    removeOrphanCustomTabs();
    wireNativeTabs(inputsContainer);
  }

  function openItemFolderMenu(event, itemRoot) {
    const itemKey = extractItemKeyFromNode(itemRoot);
    if (!itemKey) return false;

    event.preventDefault();
    event.stopPropagation();
    openMenu(event.clientX, event.clientY, buildFolderMenuItems(itemKey));
    return true;
  }

  function bindItemInteractions() {
    if (itemClickBound) return;
    itemClickBound = true;

    document.addEventListener(
      'click',
      (event) => {
        if (!isLibraryPage() || !event.shiftKey) return;
        const libraryRoot = document.querySelector('[class*="library-container"]');
        if (!libraryRoot?.contains(event.target)) return;
        if (event.target.closest(`[data-sc-custom-folder-tab], #${MENU_ID}, #${MODAL_ID}`)) return;

        const itemRoot = findMetaItemRoot(event.target);
        if (!itemRoot || !libraryRoot.contains(itemRoot)) return;

        const itemKey = extractItemKeyFromNode(itemRoot);
        if (!itemKey) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const folder = getActiveFolder();
        if (folder) {
          if (folder.items?.includes(itemKey)) {
            removeItemFromFolder(folder.id, itemKey);
            showToast(TEXT.removedFrom(folder.name));
          } else {
            addItemToFolder(folder.id, itemKey);
            showToast(TEXT.addedTo(folder.name));
          }
          return;
        }

        openMenu(event.clientX, event.clientY, buildFolderMenuItems(itemKey));
      },
      true
    );
  }

  function bindContextMenu() {
    if (contextMenuBound) return;
    contextMenuBound = true;

    document.addEventListener(
      'contextmenu',
      (event) => {
        if (!isLibraryPage()) return;
        const libraryRoot = document.querySelector('[class*="library-container"]');
        if (!libraryRoot?.contains(event.target)) return;

        const itemRoot = findMetaItemRoot(event.target);
        if (!itemRoot || !libraryRoot.contains(itemRoot)) return;

        if (openItemFolderMenu(event, itemRoot)) return;
      },
      true
    );
  }

  function isSettingsPage() {
    return /#\/settings(?:[/?#]|$)/.test(location.hash || '');
  }

  function findButtonByOwnText(text) {
    const settings = document.querySelector('[class*="settings-content"]');
    if (!settings) return null;
    for (const el of settings.querySelectorAll('[class*="button-container"]')) {
      if (el.closest(`#${LIBRARY_SETTINGS_ID}`)) continue;
      if (el.querySelector('[class*="button-container"]')) continue;
      const value = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (value === text) return el;
    }
    return null;
  }

  function setOwnButtonText(pill, text) {
    const current = (pill.textContent || '').replace(/\s+/g, ' ').trim();
    if (current === text) return;
    const textNodes = [];
    const walk = (el) => {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (node.textContent.trim()) textNodes.push(node);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          walk(node);
        }
      }
    };
    walk(pill);
    if (textNodes.length === 1) {
      textNodes[0].textContent = text;
      return;
    }
    pill.textContent = text;
  }

  function bindPill(pill, text, onClick) {
    if (!pill) return;
    setOwnButtonText(pill, text);
    if (pill.dataset.mystremioCsvBound === '1') return;
    pill.dataset.mystremioCsvBound = '1';
    pill.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onClick();
      },
      true
    );
  }

  function rowTitleLabel(row) {
    for (const label of row.querySelectorAll('[class*="label-"]')) {
      if (label.closest('button, [class*="button-container"]')) continue;
      return label;
    }
    return null;
  }

  function rowPills(row) {
    return Array.from(row.querySelectorAll('button, [class*="button-container"]')).filter(
      (node) => !node.querySelector('button, [class*="button-container"]') && !node.dataset.mystremioScope
    );
  }

  function setRowTitle(row, text) {
    const title = rowTitleLabel(row);
    if (!title) return;
    const current = (title.textContent || '').replace(/\s+/g, ' ').trim();
    if (current !== text) title.textContent = text;
  }

  const SCOPE_OPTIONS = [
    ['movie', () => TEXT.scopeMoviesShort()],
    ['series', () => TEXT.scopeSeriesShort()],
    ['both', () => TEXT.scopeBothShort()],
  ];

  let sessionCsvScope = null;

  function scopeChoiceLabel(scope) {
    if (scope === 'movie') return TEXT.scopeMoviesShort();
    if (scope === 'series') return TEXT.scopeSeriesShort();
    if (scope === 'both') return TEXT.scopeBothShort();
    return TEXT.scopePlaceholder();
  }

  function ensureCsvScopeStyles() {
    const id = 'mystremio-library-csv-scope-style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      #${LIBRARY_SETTINGS_ID} .mystremio-scope-menu {
        position: relative;
        width: 100%;
        margin: 0 0 0.65rem 0;
      }
      #${LIBRARY_SETTINGS_ID} .mystremio-scope-trigger {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        min-width: 9rem;
        height: 2.75rem;
        padding: 0 1.15rem;
        border-radius: 2.75rem;
        border: 1px solid rgba(255, 255, 255, 0.22);
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
        font: 500 0.95rem/1 var(--default-font-family, inherit);
        cursor: pointer;
      }
      #${LIBRARY_SETTINGS_ID} .mystremio-scope-trigger::after {
        content: "";
        width: 0.45rem;
        height: 0.45rem;
        margin-left: 0.75rem;
        border-right: 2px solid #fff;
        border-bottom: 2px solid #fff;
        transform: rotate(45deg) translateY(-2px);
        opacity: 0.8;
      }
      .mystremio-scope-list {
        position: fixed;
        z-index: 400;
        margin: 0;
        padding: 0.35rem;
        border-radius: 0.9rem;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgb(32, 32, 36);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      }
      .mystremio-scope-list button {
        display: block;
        width: 100%;
        margin: 0;
        padding: 0.65rem 0.9rem;
        border: 0;
        border-radius: 0.65rem;
        background: transparent;
        color: #fff;
        font: 500 0.95rem/1 var(--default-font-family, inherit);
        text-align: left;
        cursor: pointer;
      }
      .mystremio-scope-list button:hover,
      .mystremio-scope-list button[aria-selected="true"] {
        background: rgba(255, 255, 255, 0.12);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function paintScopeMenu(root) {
    if (!root) return;
    const label = root.querySelector('[data-mystremio-scope-label]');
    const next = scopeChoiceLabel(sessionCsvScope);
    if (label && label.textContent !== next) label.textContent = next;
    root.querySelectorAll('[data-mystremio-scope-option]').forEach((option) => {
      const selected = option.dataset.mystremioScopeOption === sessionCsvScope;
      if (option.getAttribute('aria-selected') !== (selected ? 'true' : 'false')) {
        option.setAttribute('aria-selected', selected ? 'true' : 'false');
      }
    });
  }

  function closeScopeLists(except) {
    document.querySelectorAll(`#${LIBRARY_SETTINGS_ID} [data-mystremio-scope-list]`).forEach((list) => {
      if (list !== except) list.hidden = true;
    });
  }

  function buildScopeMenu() {
    const wrap = document.createElement('div');
    wrap.className = 'mystremio-scope-menu';
    wrap.dataset.mystremioScopeMenu = '1';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mystremio-scope-trigger';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-label', TEXT.csvScope());
    const label = document.createElement('span');
    label.dataset.mystremioScopeLabel = '1';
    label.textContent = scopeChoiceLabel(sessionCsvScope);
    button.appendChild(label);

    const list = document.createElement('div');
    list.className = 'mystremio-scope-list';
    list.dataset.mystremioScopeList = '1';
    list.hidden = true;
    list.setAttribute('role', 'listbox');

    for (const [scope, labelOf] of SCOPE_OPTIONS) {
      const option = document.createElement('button');
      option.type = 'button';
      option.dataset.mystremioScopeOption = scope;
      option.setAttribute('role', 'option');
      option.textContent = labelOf();
      option.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        sessionCsvScope = scope;
        writeCsvScope(scope);
        list.hidden = true;
        paintScopeMenu(wrap);
      }, true);
      list.appendChild(option);
    }

    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (list.hidden) {
        const rect = button.getBoundingClientRect();
        list.style.left = `${rect.left}px`;
        list.style.top = `${rect.bottom + 6}px`;
        list.style.width = `${rect.width}px`;
        if (list.parentElement !== document.body) document.body.appendChild(list);
        closeScopeLists(list);
        list.hidden = false;
      } else {
        list.hidden = true;
      }
    }, true);

    wrap.append(button, list);
    paintScopeMenu(wrap);
    return wrap;
  }

  let ensuringLibrarySettings = false;

  function ensureLibrarySettings() {
    if (ensuringLibrarySettings) return;
    if (!isSettingsPage()) return;
    ensuringLibrarySettings = true;
    observer.disconnect();
    try {
    activeCsvScope();
    document.querySelectorAll('[data-mystremio-library-section="1"]').forEach((node) => node.remove());
    ensureCsvScopeStyles();

    const exportPill =
      findButtonByOwnText('Export library JSON') ||
      findButtonByOwnText(TEXT.exportCollectionsCsv());
    const importPill =
      findButtonByOwnText('Import library JSON') ||
      findButtonByOwnText(TEXT.importCollectionsCsv());
    const backupRow = exportPill?.closest('[class*="option-"]') || exportPill?.parentElement;
    if (!backupRow?.parentElement || !exportPill) return;

    setRowTitle(backupRow, TEXT.customCollectionsTitle());
    bindPill(exportPill, TEXT.exportCollectionsCsv(), () => exportCollectionsCsv());
    bindPill(importPill, TEXT.importCollectionsCsv(), () => void importCollectionsCsv());

    let row = document.getElementById(LIBRARY_SETTINGS_ID);
    if (row && !row.querySelector('[data-mystremio-scope-menu]')) {
      row.remove();
      row = null;
    }
    if (row) {
      setRowTitle(row, TEXT.libraryRowTitle());
      paintScopeMenu(row.querySelector('[data-mystremio-scope-menu]'));
      if (backupRow.previousElementSibling !== row) backupRow.before(row);
      return;
    }

    row = backupRow.cloneNode(true);
    row.id = LIBRARY_SETTINGS_ID;
    row.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    row.querySelectorAll('[data-mystremio-csv-bound]').forEach((node) => {
      delete node.dataset.mystremioCsvBound;
    });
    setRowTitle(row, TEXT.libraryRowTitle());

    const pills = rowPills(row);
    const exportCsvPill = pills[0];
    const importCsvPill = pills[1];
    if (!exportCsvPill || !importCsvPill) return;

    exportCsvPill.before(buildScopeMenu());
    bindPill(exportCsvPill, TEXT.exportLibraryCsvLabel(), () => void exportLibraryCsv());
    bindPill(importCsvPill, TEXT.importLibraryCsvLabel(), () => void importLibraryCsv());
    backupRow.before(row);
    } finally {
      ensuringLibrarySettings = false;
      const root = document.body || document.documentElement;
      if (root) observer.observe(root, { childList: true, subtree: true });
    }
  }

  function scheduleInject() {
    if (Date.now() < suppressInjectUntil) return;
    if (injectTimer) clearTimeout(injectTimer);
    injectTimer = setTimeout(() => {
      injectTimer = null;
      if (Date.now() < suppressInjectUntil) return;
      if (!isLibraryPage()) {
        clearLibraryRouteState();
        gridLayoutLocked = false;
        return;
      }
      activeFolderId = readActiveFolderId();
      ensureStyles();
      bindContextMenu();
      bindItemInteractions();
      bindCustomRailInteractions();
      renderFolderTabs();
      lockLibraryGridLayout();
      syncTabVisualState();
      scheduleFilter();
    }, 120);
  }

  window.__stremioCustomLibraryFoldersEnsure = scheduleInject;

  window.addEventListener('hashchange', scheduleInject);
  if (!window.__stremioCsvScopeOutsideBound) {
    window.__stremioCsvScopeOutsideBound = true;
    document.addEventListener('pointerdown', (event) => {
      const menu = event.target?.closest?.('[data-mystremio-scope-menu]');
      if (!menu) closeScopeLists(null);
    });
  }

  window.addEventListener('hashchange', () => {
    if (!isLibraryPage()) {
      clearLibraryRouteState();
    }
    if (!isSettingsPage()) sessionCsvScope = null;
    if (isSettingsPage()) ensureLibrarySettings();
  });
  window.addEventListener('popstate', scheduleInject);
  document.addEventListener('stremio-custom-bootstrap-ready', scheduleInject);

  const observer = new MutationObserver(() => {
    if (isSettingsPage()) ensureLibrarySettings();
    scheduleInject();
  });
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

  window.__libraryCsvPlan = {
    parseCsv,
    mergeCollectionRows,
    libraryRowDecision,
    entriesFromStorage,
    recordsFromEntries,
    mergeLibraryExportRows,
    planLibraryImportRow,
  };

  console.info('[StremioCustom] Library folders ready.');
})();
