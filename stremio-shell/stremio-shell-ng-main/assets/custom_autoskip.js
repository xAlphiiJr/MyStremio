(function () {
  'use strict';

  if (window.__stremioCustomAutoskipBootstrapped) return;

  const AUTOSKIP_OPTION_ID = 'stremio-custom-autoskip';
  const AUTOSKIP_STYLE_ID = 'stremio-custom-autoskip-style';

  const AUTOSKIP_ITEMS = [
    { id: 'intro', label: 'Intros', storageKey: 'stremio-custom-autoskip-intro' },
    { id: 'credits', label: 'Credits', storageKey: 'stremio-custom-autoskip-credits' },
    { id: 'recap', label: 'Recaps', storageKey: 'stremio-custom-autoskip-recap' },
  ];

  function getDeps() {
    const helpers = window.StremioCustom?.helpers;
    const ensureQuickSettingsSection = window.StremioCustomFavoriteLanguages?.ensureQuickSettingsSection;
    if (!helpers || !ensureQuickSettingsSection) return null;
    return { helpers, ensureQuickSettingsSection };
  }

  function getSettingsSections(getNativeSettingsSections) {
    return getNativeSettingsSections();
  }

  function findSettingsSection(getNativeSettingsSections, pattern) {
    for (const section of getSettingsSections(getNativeSettingsSections)) {
      const label = section.querySelector(':scope > [class*="label-"]')?.textContent || '';
      if (pattern.test(label)) return section;
    }
    return null;
  }

  function findGeneralSection(getNativeSettingsSections) {
    return (
      findSettingsSection(getNativeSettingsSections, /general|allgemein/i) ||
      getSettingsSections(getNativeSettingsSections)[0] ||
      null
    );
  }

  function findInterfaceSection(getNativeSettingsSections) {
    return findSettingsSection(getNativeSettingsSections, /interface|oberfläche/i);
  }

  function findPlayerSection(getNativeSettingsSections) {
    for (const section of getSettingsSections(getNativeSettingsSections)) {
      const text = section.textContent || '';
      if (/audiospur|audio.?track|untertitelsprache|subtitle.?language|surround.?sound|umgebungsklang/i.test(text)) {
        return section;
      }
    }
    return findSettingsSection(getNativeSettingsSections, /player|wiedergabe|abspielen/i) || getSettingsSections(getNativeSettingsSections)[2] || null;
  }

  function normalizeToggleClass(className) {
    return String(className || '')
      .split(/\s+/)
      .filter((part) => part && part !== 'checked')
      .join(' ');
  }

  function getClassesFromSection(section) {
    const option = section?.querySelector('[class*="option-"]');
    if (!option) return null;

    const toggle = document.querySelector('[class*="toggle-container"]');
    const toggleInner = toggle?.querySelector('[class*="toggle-"]');

    return {
      option: option.className,
      optionContent: option.querySelector('[class*="content-"]')?.className || '',
      optionHeading: option.querySelector('[class*="heading-"]')?.className || '',
      optionLabel: option.querySelector('[class*="label-"]')?.className || '',
      toggle: normalizeToggleClass(toggle?.className || ''),
      toggleInner: toggleInner?.className || '',
    };
  }

  function getClassesFromAnySection(getNativeSettingsSections) {
    const candidates = [
      findInterfaceSection(getNativeSettingsSections),
      findPlayerSection(getNativeSettingsSections),
      ...getSettingsSections(getNativeSettingsSections),
    ].filter(Boolean);
    const seen = new Set();
    for (const section of candidates) {
      if (seen.has(section)) continue;
      seen.add(section);
      const classes = getClassesFromSection(section);
      if (classes?.option) return classes;
    }
    return null;
  }

  function formatAutoskipSummary() {
    const enabled = AUTOSKIP_ITEMS.filter((item) => readAutoskipEnabled(item.id, item.storageKey));
    if (!enabled.length) return 'None';
    if (enabled.length === 1) return enabled[0].label;
    return enabled.map((item) => item.label).join(', ');
  }

  function createNativeDropdownCaret() {
    const caret = document.createElement('span');
    caret.className = 'stremio-custom-native-caret';
    caret.setAttribute('aria-hidden', 'true');
    return caret;
  }

  function ensureAutoskipStyles() {
    if (document.getElementById(AUTOSKIP_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = AUTOSKIP_STYLE_ID;
    style.textContent = `
      .stremio-custom-autoskip-dropdown {
        position: relative;
        width: 100%;
        border-radius: 2.75rem;
        background: var(--overlay-color, rgba(255, 255, 255, 0.08));
      }

      .stremio-custom-autoskip-dropdown .stremio-custom-native-dropdown-trigger {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        height: 3rem;
        min-height: 3rem;
        max-height: 3rem;
        padding: 0.75rem 1.5rem;
        border-radius: 2.75rem;
        border: none;
        background: transparent;
        color: var(--primary-foreground-color);
        font: inherit;
        cursor: pointer;
        box-sizing: border-box;
        box-shadow: none;
      }

      .stremio-custom-autoskip-dropdown.active .stremio-custom-native-dropdown-trigger,
      .stremio-custom-autoskip-dropdown .stremio-custom-native-dropdown-trigger:hover {
        background: transparent;
        border: none;
      }

      .stremio-custom-autoskip-dropdown .stremio-custom-native-dropdown-value {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-align: left;
      }

      .stremio-custom-autoskip-dropdown .stremio-custom-native-caret {
        display: block;
        width: 0;
        height: 0;
        margin-left: 1rem;
        flex: none;
        border: 6px solid transparent;
        border-top-color: rgba(255, 255, 255, 0.45);
        border-bottom: 0;
        transition: none;
      }

      .stremio-custom-autoskip-dropdown.active .stremio-custom-native-caret {
        transform: scaleY(-1);
      }

      .stremio-custom-autoskip-dropdown .stremio-custom-native-dropdown-panel {
        position: fixed;
        z-index: 100000;
        display: block;
        padding: 0.35rem 0;
        background: var(--modal-background-color, rgba(30, 30, 30, 0.92));
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: var(--border-radius, 12px);
        box-shadow: var(--outer-glow);
        max-height: 16rem;
        overflow-y: auto;
      }

      .stremio-custom-autoskip-dropdown .stremio-custom-native-dropdown-panel[hidden] {
        display: none !important;
      }

      .stremio-custom-autoskip-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.65rem 1rem;
      }

      .stremio-custom-autoskip-label {
        font-size: 0.92em;
        color: var(--primary-foreground-color);
      }
    `;
    document.head.appendChild(style);
  }

  function readAutoskipEnabled(id, storageKey) {
    const prefs = window.StremioCustom?.helpers?.getAutoskipPreferences?.();
    if (prefs && typeof prefs[id] === 'boolean') {
      return prefs[id];
    }
    try {
      return localStorage.getItem(storageKey) === 'true';
    } catch {
      return false;
    }
  }

  function getToggleTemplate() {
    return (
      document.querySelector('#stremio-custom [class*="toggle-container"]') ||
      document.querySelector('[class*="settings-content"] [class*="toggle-container"]') ||
      document.querySelector('[class*="toggle-container"]')
    );
  }

  function setToggleChecked(toggle, checked) {
    if (!toggle) return;
    const on = Boolean(checked);
    toggle.classList.remove('checked');
    if (on) toggle.classList.add('checked');
    toggle.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  function createToggle(checked, classes) {
    const template = getToggleTemplate();
    if (template) {
      const toggle = template.cloneNode(true);
      toggle.removeAttribute('name');
      setToggleChecked(toggle, checked);
      toggle.tabIndex = 0;
      return toggle;
    }

    const toggle = document.createElement('div');
    toggle.className = classes.toggle || '';
    toggle.tabIndex = 0;
    setToggleChecked(toggle, checked);

    const inner = document.createElement('div');
    if (classes.toggleInner) inner.className = classes.toggleInner;
    toggle.appendChild(inner);

    return toggle;
  }

  function createSettingsOption(classes, title, elementId) {
    const option = document.createElement('div');
    if (classes.option) option.className = classes.option;
    option.id = elementId;

    const heading = document.createElement('div');
    if (classes.optionHeading) heading.className = classes.optionHeading;

    const label = document.createElement('div');
    if (classes.optionLabel) label.className = classes.optionLabel;
    label.textContent = title;
    heading.appendChild(label);

    const content = document.createElement('div');
    if (classes.optionContent) content.className = classes.optionContent;

    option.append(heading, content);
    return { option, content };
  }

  function updateAutoskipSummary(dropdown) {
    const value = dropdown?.querySelector('.stremio-custom-native-dropdown-value');
    if (value) value.textContent = formatAutoskipSummary();
  }

  function positionAutoskipDropdown(dropdown) {
    const trigger = dropdown.querySelector('.stremio-custom-native-dropdown-trigger');
    const panel = dropdown.querySelector('.stremio-custom-native-dropdown-panel');
    if (!trigger || !panel) return;
    const rect = trigger.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || rect.top < 1) {
      closeAutoskipDropdown(dropdown);
      return;
    }
    panel.style.top = `${rect.bottom + 2}px`;
    panel.style.left = `${rect.left}px`;
    panel.style.width = `${Math.max(rect.width, 280)}px`;
  }

  function closeAutoskipDropdown(dropdown) {
    dropdown.classList.remove('active');
    const panel = dropdown.querySelector('.stremio-custom-native-dropdown-panel');
    const trigger = dropdown.querySelector('.stremio-custom-native-dropdown-trigger');
    if (panel) panel.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  function createAutoskipDropdown(content, classes) {
    const dropdown = document.createElement('div');
    dropdown.className = 'stremio-custom-native-dropdown stremio-custom-autoskip-dropdown';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'stremio-custom-native-dropdown-trigger';
    trigger.setAttribute('aria-expanded', 'false');

    const value = document.createElement('span');
    value.className = 'stremio-custom-native-dropdown-value';
    value.textContent = formatAutoskipSummary();

    trigger.append(value, createNativeDropdownCaret());

    const panel = document.createElement('div');
    panel.className = 'stremio-custom-native-dropdown-panel stremio-custom-autoskip-toggles';
    panel.hidden = true;

    for (const item of AUTOSKIP_ITEMS) {
      const row = document.createElement('div');
      row.className = 'stremio-custom-autoskip-row';

      const label = document.createElement('span');
      label.className = 'stremio-custom-autoskip-label';
      label.textContent = item.label;

      const enabled = readAutoskipEnabled(item.id, item.storageKey);
      const toggle = createToggle(enabled, classes);
      toggle.dataset.autoskipId = item.id;
      toggle.addEventListener('click', async (event) => {
        event.stopPropagation();
        const next = !toggle.classList.contains('checked');
        setToggleChecked(toggle, next);
        if (window.StremioCustom?.helpers?.setAutoskipEnabled) {
          await window.StremioCustom.helpers.setAutoskipEnabled(item.id, next);
        } else if (window.StremioCustom?.helpers?.ensureAutoskipReady) {
          await window.StremioCustom.helpers.ensureAutoskipReady();
          await window.StremioCustom.helpers.setAutoskipEnabled(item.id, next);
        } else {
          localStorage.setItem(item.storageKey, String(next));
        }
        updateAutoskipSummary(dropdown);
      });

      row.append(label, toggle);
      panel.appendChild(row);
    }

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = dropdown.classList.contains('active');
      document.querySelectorAll('.stremio-custom-autoskip-dropdown.active').forEach((other) => {
        if (other !== dropdown) closeAutoskipDropdown(other);
      });
      if (open) {
        closeAutoskipDropdown(dropdown);
        return;
      }
      dropdown.classList.add('active');
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      positionAutoskipDropdown(dropdown);
    });

    if (!window.__stremioCustomAutoskipDropdownHook) {
      window.__stremioCustomAutoskipDropdownHook = true;
      document.addEventListener(
        'click',
        (event) => {
          if (event.target.closest('.stremio-custom-autoskip-dropdown')) return;
          document.querySelectorAll('.stremio-custom-autoskip-dropdown.active').forEach(closeAutoskipDropdown);
        },
        true
      );
      window.addEventListener('resize', () => {
        document.querySelectorAll('.stremio-custom-autoskip-dropdown.active').forEach(positionAutoskipDropdown);
      });
    }

    dropdown.append(trigger, panel);
    content.appendChild(dropdown);
    return dropdown;
  }

  async function injectAutoskipSettings(classes, deps) {
    const { getNativeSettingsSections, isOnSettingsPage, ensureAutoskipReady } = deps.helpers;
    const { ensureQuickSettingsSection } = deps;
    if (!isOnSettingsPage()) return false;

    await ensureAutoskipReady();

    const effectiveClasses = getClassesFromAnySection(getNativeSettingsSections) || classes;
    if (!effectiveClasses?.option) return false;
    if (!effectiveClasses.toggle) {
      effectiveClasses.toggle = 'toggle-container';
      effectiveClasses.toggleInner = '';
    }

    ensureAutoskipStyles();

    const existing = document.getElementById(AUTOSKIP_OPTION_ID);
    if (existing) {
      window.StremioCustom?.helpers?.refreshAutoskipToggles?.();
      return true;
    }

    const quickSection =
      ensureQuickSettingsSection() || document.getElementById('stremio-custom-lang-quick-section');
    if (!quickSection) return false;

    const { option, content } = createSettingsOption(effectiveClasses, 'Autoskip', AUTOSKIP_OPTION_ID);
    createAutoskipDropdown(content, effectiveClasses);
    quickSection.appendChild(option);

    return true;
  }

  function injectAutoskipOption(content, classes) {
    const getSections = window.StremioCustom?.helpers?.getNativeSettingsSections;
    const effectiveClasses =
      classes || (getSections ? getClassesFromAnySection(getSections) : null) || {};
    if (!effectiveClasses.toggle) {
      effectiveClasses.toggle = 'toggle-container';
      effectiveClasses.toggleInner = '';
    }
    ensureAutoskipStyles();
    createAutoskipDropdown(content, effectiveClasses);
    return true;
  }

  let injectTimer = null;

  function tryInjectAutoskipSettings(classes) {
    const deps = getDeps();
    if (!deps) return;

    injectAutoskipSettings(classes, deps).then((injected) => {
      if (injected) return;
      if (injectTimer) return;
      injectTimer = setTimeout(() => {
        injectTimer = null;
        const retryDeps = getDeps();
        if (!retryDeps) return;
        injectAutoskipSettings(
          getClassesFromAnySection(retryDeps.helpers.getNativeSettingsSections) || classes,
          retryDeps
        );
      }, 400);
    });
  }

  function boot(attempt) {
    const deps = getDeps();
    if (!deps) {
      if (attempt < 80) setTimeout(() => boot(attempt + 1), 100);
      return;
    }

    window.__stremioCustomAutoskipBootstrapped = true;
    window.StremioCustomAutoskip = {
      ...(window.StremioCustomAutoskip || {}),
      tryInjectAutoskipSettings,
      injectAutoskipOption,
      createAutoskipDropdown,
      AUTOSKIP_ITEMS,
      formatAutoskipSummary,
      updateAutoskipSummary,
    };
    document.addEventListener('stremio-custom-autoskip-ready', () => {
      tryInjectAutoskipSettings();
      window.StremioCustom?.helpers?.refreshAutoskipToggles?.();
    });
    console.info('[StremioCustom] Autoskip quick settings ready.');
  }

  boot(0);
})();
