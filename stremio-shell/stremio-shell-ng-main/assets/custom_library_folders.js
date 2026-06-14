(function () {
  'use strict';

  if (window.__stremioCustomLibraryFolders) return;
  window.__stremioCustomLibraryFolders = true;

  const STORAGE_KEY = 'stremio-custom-library-folders';
  const ACTIVE_FOLDER_KEY = 'stremio-custom-library-active-folder';
  const STYLE_ID = 'stremio-custom-library-folders-style';
  const ROW_ID = 'stremio-custom-library-folders-row';
  const PLUS_ID = 'stremio-custom-library-folder-plus';
  const MENU_ID = 'stremio-custom-library-folder-menu';
  const MODAL_ID = 'stremio-custom-library-folder-modal';
  const TOAST_ID = 'stremio-custom-library-folder-toast';
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
  }

  function readActiveFolderId() {
    try {
      return sessionStorage.getItem(ACTIVE_FOLDER_KEY) || null;
    } catch {
      return null;
    }
  }

  function writeActiveFolderId(id) {
    activeFolderId = id || null;
    try {
      if (id) sessionStorage.setItem(ACTIVE_FOLDER_KEY, id);
      else sessionStorage.removeItem(ACTIVE_FOLDER_KEY);
    } catch (_) {}
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
    const cleanId = decodeURIComponent(String(id || '').trim());
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
        position: fixed !important;
        display: inline-flex !important;
        flex-direction: row !important;
        align-items: center !important;
        justify-content: flex-end !important;
        gap: 1rem !important;
        width: max-content !important;
        max-width: min(50vw, 28rem) !important;
        margin: 0 !important;
        padding: 0 !important;
        white-space: nowrap !important;
        pointer-events: auto !important;
        z-index: 200 !important;
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

  function bindRailPositioning() {
    if (railPositionBound) return;
    railPositionBound = true;
    window.addEventListener('resize', scheduleInject);
    window.addEventListener('scroll', scheduleInject, true);
  }

  function positionCustomRail(inputsContainer, group) {
    if (!inputsContainer || !group) return;

    const rect = inputsContainer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    group.style.display = 'inline-flex';
    group.style.transform = 'translateY(-50%)';
    group.style.top = `${rect.top + rect.height / 2}px`;

    const placeRail = () => {
      const width = Math.ceil(group.getBoundingClientRect().width);
      const left = Math.max(rect.right - width - 12, rect.left + 12);
      group.style.left = `${left}px`;
      group.style.right = 'auto';

      const hScroll = inputsContainer.querySelector('[class*="horizontal-scroll"]');
      if (hScroll) {
        const reserve = Math.max(rect.right - left + 16, 120);
        hScroll.style.flex = '1 1 auto';
        hScroll.style.minWidth = '0';
        hScroll.style.maxWidth = `calc(100% - ${Math.ceil(reserve)}px)`;
      }
    };

    placeRail();
    requestAnimationFrame(placeRail);
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
      positionCustomRail(inputsContainer, group);
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

    if (group.parentElement !== document.body) {
      document.body.appendChild(group);
    }

    syncTabVisualState();
    positionCustomRail(inputsContainer, group);
    bindRailPositioning();
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

  function scheduleInject() {
    if (Date.now() < suppressInjectUntil) return;
    if (injectTimer) clearTimeout(injectTimer);
    injectTimer = setTimeout(() => {
      injectTimer = null;
      if (Date.now() < suppressInjectUntil) return;
      if (!isLibraryPage()) {
        closeMenu();
        hideCustomRail();
        document.body.classList.remove('sc-custom-library-folder-active');
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
  window.addEventListener('popstate', scheduleInject);
  document.addEventListener('stremio-custom-bootstrap-ready', scheduleInject);

  const observer = new MutationObserver(scheduleInject);
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

  console.info('[StremioCustom] Library folders ready.');
})();
