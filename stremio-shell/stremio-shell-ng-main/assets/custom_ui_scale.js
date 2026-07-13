(function () {
  'use strict';

  if (window.StremioCustomUiScale) return;

  const STORAGE_KEY = 'stremio-custom-ui-scale-percent';
  const OPTION_ROW_ID = 'mystremio-ui-scale-row';
  const SCALE_OPTIONS = [75, 100, 125, 150, 175, 200];
  const DEFAULT_PERCENT = 100;
  const MAX_INJECT_ATTEMPTS = 24;

  let settingsWatcherStarted = false;
  let injectTimer = null;
  let injectAttempts = 0;
  let applyPromise = null;
  let activeController = null;

  function api() {
    return window.StremioCustomAPI || window.StremioEnhancedAPI;
  }

  function helpers() {
    return window.StremioCustom?.helpers || {};
  }

  /**
   * Returns the first class token on `element` matching `predicate`.
   * @param {Element | null | undefined} element
   * @param {(token: string) => boolean} predicate
   * @returns {string | null}
   */
  function pickClass(element, predicate) {
    if (!element) return null;
    for (const token of element.classList) {
      if (predicate(token)) return token;
    }
    return null;
  }

  /**
   * Snaps a value to the nearest supported 25% UI scale step.
   * @param {unknown} value Raw stored or user input.
   * @returns {number}
   */
  function normalizePercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return DEFAULT_PERCENT;
    let closest = DEFAULT_PERCENT;
    let bestDelta = Infinity;
    for (const option of SCALE_OPTIONS) {
      const delta = Math.abs(option - num);
      if (delta < bestDelta) {
        bestDelta = delta;
        closest = option;
      }
    }
    return closest;
  }

  /**
   * Reads the persisted UI scale percentage from localStorage.
   * @returns {number}
   */
  function readStoredPercent() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw == null || raw === '') return DEFAULT_PERCENT;
      return normalizePercent(raw);
    } catch (_) {
      return DEFAULT_PERCENT;
    }
  }

  /**
   * Writes the UI scale percentage to localStorage.
   * @param {number} percent
   */
  function writeStoredPercent(percent) {
    try {
      localStorage.setItem(STORAGE_KEY, String(normalizePercent(percent)));
    } catch (_) {}
  }

  /**
   * Applies the UI scale via the shell (WebView2 zoom factor).
   * @param {number} percent
   * @returns {Promise<number>}
   */
  function applyUiScale(percent) {
    const normalized = normalizePercent(percent);
    writeStoredPercent(normalized);
    activeController?.setValue(normalized);

    const client = api();
    if (!client?.invoke) return Promise.resolve(normalized);
    if (applyPromise) return applyPromise;

    applyPromise = client
      .invoke('set-ui-scale', { percent: normalized })
      .then((result) => {
        const applied = normalizePercent(result);
        writeStoredPercent(applied);
        helpers().persistUserPreferences?.();
        activeController?.setValue(applied);
        return applied;
      })
      .catch(() => normalized)
      .finally(() => {
        applyPromise = null;
      });
    return applyPromise;
  }

  function isOnSettingsPage() {
    return /#\/settings/.test(location.href || '');
  }

  /**
   * Resolves dropdown class names from a cloned UI Language row and any live open panel.
   * @param {HTMLElement} templateRow
   * @returns {{
   *   menuActive: string,
   *   buttonOpen: string,
   *   dropdown: string,
   *   dropdownOpen: string,
   *   option: string,
   *   optionLabel: string,
   *   optionIcon: string,
   *   buttonContainer: string | null,
   * }}
   */
  function resolveDropdownClasses(templateRow) {
    const templateButton = templateRow.querySelector('[class*="multiselect-button"]');
    const templateIcon = templateButton?.querySelector('[class*="icon-"]');
    const liveDropdown = document.querySelector('[class*="settings-content"] [class*="multiselect-menu"] [class*="dropdown-"]');
    const liveOption = liveDropdown?.querySelector('[class*="option-"]');

    return {
      menuActive: 'active-gKhO5',
      buttonOpen: pickClass(templateIcon, (token) => token.startsWith('open-')) || 'open-TvFQd',
      dropdown: pickClass(liveDropdown, (token) => token.startsWith('dropdown-')) || 'dropdown-MWaxp',
      dropdownOpen: pickClass(liveDropdown, (token) => token.startsWith('open-') && token !== 'open-TvFQd') || 'open-yuN4f',
      option: pickClass(liveOption, (token) => token.startsWith('option-')) || 'option-HcOSE',
      optionLabel: pickClass(liveOption?.querySelector('[class*="label-"]'), (token) => token.startsWith('label-')) || 'label-IR8xX',
      optionIcon: pickClass(liveOption?.querySelector('[class*="icon-"]'), (token) => token.startsWith('icon-')) || 'icon-I_g2q',
      buttonContainer: pickClass(templateButton, (token) => token.startsWith('button-container')) || 'button-container-zVLH6',
    };
  }

  /**
   * Wires a cloned UI Language multiselect row to behave like the native MultiselectMenu.
   * @param {HTMLElement} row Cloned settings option row.
   * @param {HTMLElement} templateRow Native UI Language row used for class discovery.
   * @returns {{ close: () => void, setValue: (percent: number) => void }}
   */
  function wireClonedMultiselect(row, templateRow) {
    const classes = resolveDropdownClasses(templateRow);
    const menu = row.querySelector('[class*="multiselect-menu"]');
    const button = row.querySelector('[class*="multiselect-button"]');
    const labelEl = button?.querySelector('[class*="label-"]');
    const iconEl = button?.querySelector('[class*="icon-"]');

    if (!menu || !button || !labelEl) {
      return { close() {}, setValue() {} };
    }

    menu.querySelectorAll(':scope > [class*="dropdown-"]').forEach((node) => node.remove());

    let open = false;
    let panel = null;
    let value = readStoredPercent();
    let unbindOutside = null;

    function setOpenState(isOpen) {
      open = isOpen;
      menu.classList.toggle(classes.menuActive, isOpen);
      button.classList.toggle(classes.buttonOpen, isOpen);
      iconEl?.classList.toggle(classes.buttonOpen, isOpen);
      button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    function close() {
      if (!open) return;
      setOpenState(false);
      try {
        panel?.remove();
      } catch (_) {}
      panel = null;
      unbindOutside?.();
      unbindOutside = null;
    }

    /**
     * Builds one dropdown option row using the same div.button-container markup as MultiselectMenu.
     * @param {number} percent
     * @param {boolean} selected
     * @param {typeof classes} classes
     * @returns {HTMLDivElement}
     */
    function createOptionRow(percent, selected, classes) {
      const optionRow = document.createElement('div');
      optionRow.className = [classes.buttonContainer, classes.option].filter(Boolean).join(' ');
      optionRow.tabIndex = 0;
      optionRow.setAttribute('role', 'option');
      optionRow.setAttribute('aria-selected', selected ? 'true' : 'false');

      const optionLabel = document.createElement('div');
      optionLabel.className = classes.optionLabel;
      optionLabel.textContent = `${percent}%`;
      optionRow.appendChild(optionLabel);

      if (selected) {
        const optionIcon = document.createElement('div');
        optionIcon.className = classes.optionIcon;
        optionRow.appendChild(optionIcon);
      }

      optionRow.addEventListener('click', (event) => {
        event.stopPropagation();
        close();
        applyUiScale(percent).catch(() => {});
      });

      return optionRow;
    }

    /**
     * Builds the in-flow dropdown panel matching native MultiselectMenu markup.
     * @returns {HTMLElement}
     */
    function buildPanel() {
      const element = document.createElement('div');
      element.className = `${classes.dropdown} ${classes.dropdownOpen}`;
      element.setAttribute('role', 'listbox');

      for (const percent of SCALE_OPTIONS) {
        element.appendChild(createOptionRow(percent, percent === value, classes));
      }

      return element;
    }

    function openDropdown() {
      if (open) return;
      panel = buildPanel();
      menu.appendChild(panel);
      setOpenState(true);

      const outsideHandler = (event) => {
        const target = event.target;
        if (target instanceof Node && menu.contains(target)) return;
        close();
      };

      document.addEventListener('mouseup', outsideHandler);
      document.addEventListener('touchend', outsideHandler);
      unbindOutside = () => {
        document.removeEventListener('mouseup', outsideHandler);
        document.removeEventListener('touchend', outsideHandler);
      };
    }

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (open) close();
      else openDropdown();
    });

    function setValue(percent) {
      value = normalizePercent(percent);
      labelEl.textContent = `${value}%`;
    }

    setValue(value);

    return { close, setValue };
  }

  /**
   * Finds the Interface settings section container.
   * @returns {HTMLElement | null}
   */
  function findInterfaceSection() {
    const settings = document.querySelector('[class*="settings-content"]');
    if (!settings) return null;

    for (const section of settings.querySelectorAll('[class*="section-"]')) {
      const sectionLabel = section.querySelector(':scope > [class*="label-"], [class*="heading-"] [class*="label-"]');
      const text = (sectionLabel?.textContent || '').trim();
      if (/^interface$/i.test(text)) return section;
    }
    return null;
  }

  /**
   * Finds the native UI Language settings row used as a 1:1 clone template.
   * @returns {HTMLElement | null}
   */
  function findUiLanguageOption() {
    const interfaceSection = findInterfaceSection();
    const searchRoot = interfaceSection || document.querySelector('[class*="settings-content"]');
    if (!searchRoot) return null;

    for (const row of searchRoot.querySelectorAll('[class*="option-"]')) {
      if (row.id === OPTION_ROW_ID) continue;
      const headingLabel = row.querySelector('[class*="heading-"] [class*="label-"]');
      const text = (headingLabel?.textContent || '').trim();
      if (/ui\s*language/i.test(text) && row.querySelector('[class*="multiselect-menu"]')) {
        return row;
      }
    }
    return null;
  }

  /**
   * Returns whether the UI scale row must be (re)created.
   * @returns {boolean}
   */
  function needsInjection() {
    const row = document.getElementById(OPTION_ROW_ID);
    return !row || row.dataset.uiScaleBound !== '1';
  }

  /**
   * Injects the UI Scaling option above UI Language by cloning that row 1:1.
   * @returns {boolean}
   */
  function injectUiScaleSetting() {
    if (!isOnSettingsPage()) return false;

    const templateRow = findUiLanguageOption();
    if (!templateRow?.parentElement) return false;

    const existing = document.getElementById(OPTION_ROW_ID);
    if (existing?.dataset.uiScaleBound === '1') {
      activeController = existing.__uiScaleController || activeController;
      activeController?.setValue(readStoredPercent());
      return true;
    }

    activeController?.close?.();
    existing?.remove();

    const row = templateRow.cloneNode(true);
    row.id = OPTION_ROW_ID;

    const headingLabel = row.querySelector('[class*="heading-"] [class*="label-"]');
    if (headingLabel) headingLabel.textContent = 'UI Scaling';

    const controller = wireClonedMultiselect(row, templateRow);
    row.__uiScaleController = controller;
    row.dataset.uiScaleBound = '1';
    activeController = controller;

    templateRow.parentElement.insertBefore(row, templateRow);
    controller.setValue(readStoredPercent());
    return true;
  }

  function scheduleSettingsCheck() {
    if (injectTimer) clearTimeout(injectTimer);
    injectAttempts = 0;

    const attemptInject = () => {
      injectTimer = null;
      if (!isOnSettingsPage()) {
        activeController?.close?.();
        return;
      }

      let success = false;
      try {
        success = injectUiScaleSetting();
      } catch (error) {
        console.warn('[StremioCustom] UI scale settings inject failed:', error);
      }

      if (success) {
        injectAttempts = 0;
        return;
      }

      injectAttempts += 1;
      if (injectAttempts < MAX_INJECT_ATTEMPTS) {
        injectTimer = setTimeout(attemptInject, 250);
      }
    };

    injectTimer = setTimeout(attemptInject, 150);
  }

  function startSettingsWatcher() {
    if (settingsWatcherStarted) return;
    settingsWatcherStarted = true;

    window.addEventListener('hashchange', () => {
      activeController?.close?.();
      scheduleSettingsCheck();
    });
    document.addEventListener('stremio-custom-bootstrap-ready', scheduleSettingsCheck);

    const observer = new MutationObserver(() => {
      if (typeof window.stremioCustomSuspendBackground === 'function' &&
        window.stremioCustomSuspendBackground()) {
        return;
      }
      if (!isOnSettingsPage()) return;
      if (!needsInjection()) return;
      scheduleSettingsCheck();
    });

    observer.observe(document.body, { childList: true, subtree: true });
    scheduleSettingsCheck();
  }

  window.StremioCustomUiScale = {
    applyUiScale,
    scheduleSettingsCheck,
  };

  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    startSettingsWatcher();
  });

  if (document.readyState !== 'loading') {
    startSettingsWatcher();
  } else {
    document.addEventListener('DOMContentLoaded', () => startSettingsWatcher());
  }
})();
