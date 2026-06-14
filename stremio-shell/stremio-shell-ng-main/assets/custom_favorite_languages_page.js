(function () {
function buildFavoriteLanguagesPageScript() {
  const namesJson = JSON.stringify(window.__stremioLanguageNames || {});

  return `
(function() {
  if (window.__stremioCustomLangPageRuntime) return;
  window.__stremioCustomLangPageRuntime = true;

  const CUSTOM_SECTION_IDS = new Set(['stremio-custom', 'stremio-custom-lang-quick-section']);

  const LANGUAGE_NAMES = ${namesJson};
  const KEYS = {
    FAV_AUDIO: 'stremio-custom-fav-audio',
    FAV_SUBS: 'stremio-custom-fav-subs',
    ACTIVE_AUDIO: 'stremio-custom-active-audio',
    ACTIVE_SUBS: 'stremio-custom-active-subs',
  };
  const FAV_AUDIO_ID = 'stremio-custom-fav-audio-select';
  const FAV_SUBS_ID = 'stremio-custom-fav-subs-select';
  const QUICK_SECTION_ID = 'stremio-custom-lang-quick-section';
  const QUICK_AUDIO_ID = 'stremio-custom-fav-audio-quick';
  const QUICK_SUBS_ID = 'stremio-custom-fav-subs-quick';
  const QUICK_AUTOSKIP_ID = 'stremio-custom-autoskip';
  const AUTOSKIP_ITEMS = [
    { id: 'intro', label: 'Intros', storageKey: 'stremio-custom-autoskip-intro' },
    { id: 'credits', label: 'Credits', storageKey: 'stremio-custom-autoskip-credits' },
    { id: 'recap', label: 'Recaps', storageKey: 'stremio-custom-autoskip-recap' },
  ];
  const STYLE_ID = 'stremio-custom-lang-settings-style-page';
  const NONE_VALUE = 'none';
  const MAX_FAVORITES = 6;

  const ISO2_TO_ISO3 = {
    de: 'ger', en: 'eng', ja: 'jpn', fr: 'fre', es: 'spa', it: 'ita',
    pt: 'por', ru: 'rus', ko: 'kor', zh: 'zho', ar: 'ara', nl: 'nld', pl: 'pol', tr: 'tur',
  };

  function normalizeLanguageCode(code) {
    if (!code || typeof code !== 'string') return null;
    const trimmed = code.trim().toLowerCase();
    if (trimmed === NONE_VALUE) return NONE_VALUE;
    const mapped = ISO2_TO_ISO3[trimmed] || trimmed;
    return LANGUAGE_NAMES[mapped] ? mapped : null;
  }

  function readJsonList(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function sanitizeFavorites(list, allowNone) {
    const seen = new Set();
    const result = [];
    for (const raw of list) {
      const code = normalizeLanguageCode(raw);
      if (!code) continue;
      if (!allowNone && code === NONE_VALUE) continue;
      if (seen.has(code)) continue;
      seen.add(code);
      result.push(code);
      if (result.length >= MAX_FAVORITES) break;
    }
    return result;
  }

  function writeJsonList(key, list, allowNone) {
    const cleaned = sanitizeFavorites(list, allowNone);
    if (cleaned.length) localStorage.setItem(key, JSON.stringify(cleaned));
    else localStorage.removeItem(key);
  }

  function getLanguageOptions(includeNone) {
    const options = Object.entries(LANGUAGE_NAMES)
      .map(([code, label]) => ({ code, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'de'));
    if (includeNone) return [{ code: NONE_VALUE, label: 'None' }, ...options];
    return options;
  }

  function getSettingsSections() {
    const container = document.querySelector('[class*="settings-content"] [class*="sections-container"]');
    if (!container) return [];
    return Array.from(container.querySelectorAll(':scope > [class*="section-"]'))
      .filter((section) => !CUSTOM_SECTION_IDS.has(section.id));
  }

  function cleanupLegacyQuickSection() {
    document.getElementById('stremio-custom-general-category')?.remove();
  }

  function findSettingsSection(pattern) {
    for (const section of getSettingsSections()) {
      const label = section.querySelector(':scope > [class*="label-"]')?.textContent || '';
      if (pattern.test(label)) return section;
    }
    return null;
  }

  function findGeneralSection() {
    return findSettingsSection(/general|allgemein/i) || getSettingsSections()[0] || null;
  }

  function findInterfaceSection() {
    return findSettingsSection(/interface|oberfläche/i);
  }

  function getClassesFromAnySection() {
    const candidates = [
      findInterfaceSection(),
      findPlayerSection(),
      ...getSettingsSections(),
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

  function ensureQuickSection() {
    document.getElementById('stremio-custom-quick-category')?.remove();

    const general = findGeneralSection();
    if (!general) return null;

    let quick = document.getElementById(QUICK_SECTION_ID);
    if (!quick) {
      quick = document.createElement('div');
      quick.id = QUICK_SECTION_ID;
      quick.className = general.className;
    }

    if (!quick.parentElement) {
      const iface = findSettingsSection(/interface|oberfläche/i);
      if (iface) iface.insertAdjacentElement('beforebegin', quick);
      else general.insertAdjacentElement('afterend', quick);
    }

    return quick;
  }

  function findPlayerSection() {
    for (const section of getSettingsSections()) {
      const text = section.textContent || '';
      if (/audiospur|audio.?track|untertitelsprache|subtitle.?language|surround.?sound|umgebungsklang/i.test(text)) {
        return section;
      }
    }
    return findSettingsSection(/player|wiedergabe|abspielen/i) || getSettingsSections()[2] || null;
  }

  function findCategoryByLabel(section, pattern) {
    if (!section) return null;
    for (const category of section.querySelectorAll('[class*="category-"]')) {
      const label = category.querySelector('[class*="label-"]')?.textContent || '';
      if (pattern.test(label)) return category;
    }
    return null;
  }

  function findCategoryByOptionLabel(section, pattern) {
    if (!section) return null;
    for (const category of section.querySelectorAll('[class*="category-"]')) {
      for (const option of category.querySelectorAll('[class*="option-"]')) {
        const label = option.querySelector('[class*="label-"]')?.textContent?.trim() || '';
        if (pattern.test(label)) return category;
      }
    }
    return null;
  }

  function findOptionByLabel(category, pattern) {
    if (!category) return null;
    for (const option of category.querySelectorAll('[class*="option-"]')) {
      const label = option.querySelector('[class*="label-"]')?.textContent?.trim() || '';
      if (pattern.test(label)) return option;
    }
    return null;
  }

  function getClassesFromSection(section) {
    const option = section?.querySelector('[class*="option-"]');
    if (!option) return null;
    return {
      option: option.className,
      optionContent: option.querySelector('[class*="content-"]')?.className || '',
      optionHeading: option.querySelector('[class*="heading-"]')?.className || '',
      optionLabel: option.querySelector('[class*="label-"]')?.className || '',
    };
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = \`
      #\${FAV_AUDIO_ID} > [class*="content-"], #\${FAV_SUBS_ID} > [class*="content-"] { align-items: stretch !important; }
      #\${FAV_AUDIO_ID} .stremio-custom-lang-picker, #\${FAV_SUBS_ID} .stremio-custom-lang-picker {
        width: 100%; max-width: none; flex: 1 1 auto; align-self: stretch; position: relative;
        border-radius: 2.75rem; background: var(--overlay-color); pointer-events: auto !important;
        overflow: visible;
      }
      .stremio-custom-lang-picker-trigger {
        width: 100%; height: 3rem; padding: 0.75rem 1.5rem; display: flex; align-items: center;
        justify-content: space-between; gap: 0.5rem; border-radius: 2.75rem; border: none;
        background: transparent; color: var(--primary-foreground-color); cursor: pointer; pointer-events: auto !important;
      }
      .stremio-custom-lang-picker-dropdown {
        position: fixed; display: none; z-index: 100000; box-sizing: border-box; padding: 0;
        background: var(--modal-background-color); box-shadow: var(--outer-glow);
        border-radius: var(--border-radius); max-height: 21rem; overflow-y: auto; pointer-events: auto !important;
      }
      .stremio-custom-lang-picker-dropdown.open { display: block !important; }
      .stremio-custom-native-caret {
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
      .stremio-custom-lang-picker.active .stremio-custom-native-caret {
        transform: scaleY(-1);
      }
      .stremio-custom-fav-option {
        height: 3rem; display: flex; align-items: center; padding: 1rem; cursor: pointer; pointer-events: auto !important;
        color: var(--primary-foreground-color);
      }
      .stremio-custom-fav-option:hover { background-color: rgba(255, 255, 255, 0.15); }
      .stremio-custom-fav-option-icon {
        width: 0.5rem; height: 0.5rem; border-radius: 100%; margin-left: 1rem;
        background-color: var(--secondary-accent-color);
      }
      #\${QUICK_AUDIO_ID} > [class*="content-"], #\${QUICK_SUBS_ID} > [class*="content-"] {
        justify-content: flex-start !important;
      }
      .stremio-custom-lang-quick-row {
        display: flex; flex-wrap: wrap; gap: 0.45rem; width: 100%;
      }
      .stremio-custom-lang-quick-btn {
        min-height: 2.75rem; padding: 0.55rem 1.1rem; border-radius: 2.75rem;
        border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(70, 70, 70, 0.22);
        backdrop-filter: blur(12px) saturate(140%); color: var(--primary-foreground-color, #fff);
        font: inherit; font-size: 0.95rem; cursor: pointer;
      }
      .stremio-custom-lang-quick-btn:hover { background: rgba(90, 90, 90, 0.32); }
      .stremio-custom-lang-quick-btn.active {
        border-color: rgba(255, 255, 255, 0.35); background: rgba(255, 255, 255, 0.12);
      }
      .stremio-custom-autoskip-toggles {
        display: flex; flex-direction: column; gap: 0.15rem; width: 100%;
      }
      .stremio-custom-autoskip-row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 1rem; padding: 0.35rem 0;
      }
      .stremio-custom-autoskip-label {
        font-size: 0.92em; color: var(--primary-foreground-color);
      }
    \`;
    document.head.appendChild(style);
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

  function favoriteSelectPlaceholder() {
    return 'Select…';
  }

  function formatSelectionLabel(selected, options) {
    if (!selected.length) return favoriteSelectPlaceholder();
    const labels = selected.map((code) => options.find((o) => o.code === code)?.label || code).slice(0, 2);
    const extra = selected.length - labels.length;
    return labels.join(', ') + (extra > 0 ? ' +' + extra : '');
  }

  function createFavoritePicker(content, options, storageKey, allowNone) {
    let selected = sanitizeFavorites(readJsonList(storageKey), allowNone);
    writeJsonList(storageKey, selected, allowNone);
    let outsideCloser = null;

    const picker = document.createElement('div');
    picker.className = 'stremio-custom-lang-picker';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'stremio-custom-lang-picker-trigger';
    const buttonLabel = document.createElement('span');
    buttonLabel.textContent = formatSelectionLabel(selected, options);
    const caret = document.createElement('span');
    caret.className = 'stremio-custom-native-caret';
    caret.setAttribute('aria-hidden', 'true');
    trigger.append(buttonLabel, caret);
    picker.appendChild(trigger);

    const dropdown = document.createElement('div');
    dropdown.className = 'stremio-custom-lang-picker-dropdown';
    picker.appendChild(dropdown);

    const renderDropdown = () => {
      dropdown.innerHTML = '';
      for (const opt of options) {
        const isSelected = selected.includes(opt.code);
        const row = document.createElement('div');
        row.className = 'stremio-custom-fav-option' + (isSelected ? ' selected' : '');
        const label = document.createElement('div');
        label.textContent = opt.label;
        row.appendChild(label);
        if (isSelected) {
          const dot = document.createElement('div');
          dot.className = 'stremio-custom-fav-option-icon';
          row.appendChild(dot);
        }
        row.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (selected.includes(opt.code)) {
            selected = selected.filter((code) => code !== opt.code);
          } else if (selected.length < MAX_FAVORITES) {
            selected = [...selected, opt.code];
          }
          selected = sanitizeFavorites(selected, allowNone);
          writeJsonList(storageKey, selected, allowNone);
          buttonLabel.textContent = formatSelectionLabel(selected, options);
          renderDropdown();
        });
        dropdown.appendChild(row);
      }
    };

    const positionDropdown = () => {
      const pickerRect = picker.getBoundingClientRect();
      dropdown.style.top = (pickerRect.bottom + 4) + 'px';
      dropdown.style.left = pickerRect.left + 'px';
      dropdown.style.width = pickerRect.width + 'px';
    };

    const closeDropdown = () => {
      picker.classList.remove('active');
      dropdown.classList.remove('open');
      dropdown.style.display = 'none';
      window.__stremioCustomLangPickerOpen = false;
      if (outsideCloser) {
        document.removeEventListener('click', outsideCloser, true);
        outsideCloser = null;
      }
    };

    const openDropdown = () => {
      renderDropdown();
      picker.classList.add('active');
      dropdown.classList.add('open');
      dropdown.style.display = 'block';
      positionDropdown();
      window.__stremioCustomLangPickerOpen = true;
      if (outsideCloser) {
        document.removeEventListener('click', outsideCloser, true);
      }
      outsideCloser = (event) => {
        if (picker.contains(event.target) || dropdown.contains(event.target)) return;
        closeDropdown();
      };
      setTimeout(() => document.addEventListener('click', outsideCloser, true), 0);
    };

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (picker.classList.contains('active')) closeDropdown();
      else openDropdown();
    });

    content.appendChild(picker);
  }

  async function setDefaultLanguage(settingKey, code) {
    try {
      if (!window.core?.dispatch || !window.core?.getState) return;
      const ctx = await window.core.getState('ctx');
      const settings = ctx?.profile?.settings;
      if (!settings) return;
      const value = code === NONE_VALUE ? null : code;
      await window.core.dispatch({
        action: 'Ctx',
        args: {
          action: 'UpdateSettings',
          args: Object.assign({}, settings, { [settingKey]: value }),
        },
      });
    } catch (error) {
      console.warn('[StremioCustom] Language update failed:', error);
    }
  }

  function createQuickSelectRow(content, favorites, activeKey, options, settingKey, allowNone) {
    const row = document.createElement('div');
    row.className = 'stremio-custom-lang-quick-row';

    const render = (favs) => {
      row.innerHTML = '';
      const cleaned = sanitizeFavorites(favs, allowNone);
      if (!cleaned.length) {
        const hint = document.createElement('span');
        hint.textContent = 'Select favorite languages in the Player tab first.';
        row.appendChild(hint);
        return;
      }

      const currentActive = normalizeLanguageCode(localStorage.getItem(activeKey));
      cleaned.forEach((code) => {
        const opt = options.find((o) => o.code === code);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'stremio-custom-lang-quick-btn';
        if (code === currentActive) btn.classList.add('active');
        btn.textContent = opt?.label || code;
        btn.addEventListener('click', () => {
          localStorage.setItem(activeKey, code);
          setDefaultLanguage(settingKey, code);
          if (settingKey === 'subtitlesLanguage') {
            window.__stremioCustomSubtitleSyncNow?.();
          }
          render(cleaned);
        });
        row.appendChild(btn);
      });
    };

    render(favorites);
    content.appendChild(row);
    return render;
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

  function normalizeToggleClass(className) {
    return String(className || '')
      .split(/\s+/)
      .filter((part) => part && part !== 'checked')
      .join(' ');
  }

  function setToggleChecked(toggle, checked) {
    if (!toggle) return;
    const on = Boolean(checked);
    toggle.classList.remove('checked');
    if (on) toggle.classList.add('checked');
    toggle.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  function createToggle(checked) {
    const toggleTemplate = document.querySelector('[class*="toggle-container"]');
    const toggleInnerTemplate = toggleTemplate?.querySelector('[class*="toggle-"]');
    const toggle = document.createElement('div');
    toggle.className = normalizeToggleClass(toggleTemplate?.className);
    toggle.tabIndex = 0;
    setToggleChecked(toggle, checked);
    const inner = document.createElement('div');
    if (toggleInnerTemplate) inner.className = toggleInnerTemplate.className;
    toggle.appendChild(inner);
    return toggle;
  }

  function createAutoskipToggles(content) {
    const container = document.createElement('div');
    container.className = 'stremio-custom-autoskip-toggles';
    for (const item of AUTOSKIP_ITEMS) {
      const row = document.createElement('div');
      row.className = 'stremio-custom-autoskip-row';
      const label = document.createElement('span');
      label.className = 'stremio-custom-autoskip-label';
      label.textContent = item.label;
      const enabled = readAutoskipEnabled(item.id, item.storageKey);
      const toggle = createToggle(enabled);
      toggle.dataset.autoskipId = item.id;
      toggle.addEventListener('click', async () => {
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
      });
      row.append(label, toggle);
      container.appendChild(row);
    }
    content.appendChild(container);
  }

  function injectQuickMenus() {
    const quick = ensureQuickSection();
    if (!quick) return;

    const classes = getClassesFromAnySection();
    if (!classes?.option) return;

    const audioOptions = getLanguageOptions(false);
    const subsOptions = getLanguageOptions(true);

    if (!document.getElementById(QUICK_SUBS_ID)) {
      const { option, content } = createSettingsOption(classes, 'Quick select subtitles', QUICK_SUBS_ID);
      createQuickSelectRow(content, readJsonList(KEYS.FAV_SUBS), KEYS.ACTIVE_SUBS, subsOptions, 'subtitlesLanguage', true);
      quick.appendChild(option);
    }

    if (!document.getElementById(QUICK_AUDIO_ID)) {
      const { option, content } = createSettingsOption(classes, 'Quick select audio', QUICK_AUDIO_ID);
      createQuickSelectRow(content, readJsonList(KEYS.FAV_AUDIO), KEYS.ACTIVE_AUDIO, audioOptions, 'audioLanguage', false);
      quick.appendChild(option);
    }

    if (!document.getElementById(QUICK_AUTOSKIP_ID)) {
      const { option, content } = createSettingsOption(classes, 'Autoskip', QUICK_AUTOSKIP_ID);
      if (window.StremioCustomAutoskip?.injectAutoskipOption) {
        window.StremioCustomAutoskip.injectAutoskipOption(content, classes);
      } else {
        createAutoskipToggles(content);
      }
      quick.appendChild(option);
    }
  }

  function injectFavorites() {
    if (window.__stremioCustomLangPickerOpen) return;
    if (document.querySelector('.stremio-custom-lang-picker.active')) return;
    if (!/#\\/settings/.test(location.hash)) return;
    cleanupLegacyQuickSection();
    ensureStyles();
    injectQuickMenus();

    const playerSection = findPlayerSection();
    if (!playerSection) return;

    const classes = getClassesFromSection(playerSection);
    if (!classes?.option) return;

    const audioCategory = findCategoryByLabel(playerSection, /audio|ton|laut|sound/i)
      || findCategoryByOptionLabel(playerSection, /default.?audio|audiospur|standard.*audio|audio.?track|standard-audiospur/i);
    const subsCategory = findCategoryByLabel(playerSection, /subtitle|untertitel|untitel/i)
      || findCategoryByOptionLabel(playerSection, /subtitle.?language|untertitel.*sprache|untertitelsprache/i);

    const audioOptions = getLanguageOptions(false);
    const subsOptions = getLanguageOptions(true);

    if (audioCategory && !document.getElementById(FAV_AUDIO_ID)) {
      const anchor = findOptionByLabel(audioCategory, /default.?audio|audiospur|standard.*audio|audio.?track|standard-audiospur/i);
      const { option, content } = createSettingsOption(classes, 'Favorite audio languages', FAV_AUDIO_ID);
      createFavoritePicker(content, audioOptions, KEYS.FAV_AUDIO, false);
      if (anchor) anchor.insertAdjacentElement('afterend', option);
      else audioCategory.append(option);
    }

    if (subsCategory && !document.getElementById(FAV_SUBS_ID)) {
      const anchor = findOptionByLabel(subsCategory, /subtitle.?language|untertitel.*sprache|untertitelsprache/i)
        || subsCategory.querySelector('[class*="option-"]');
      const { option, content } = createSettingsOption(classes, 'Favorite subtitles', FAV_SUBS_ID);
      createFavoritePicker(content, subsOptions, KEYS.FAV_SUBS, true);
      if (anchor) anchor.insertAdjacentElement('afterend', option);
      else subsCategory.append(option);
    }
  }

  injectFavorites();
  window.addEventListener('hashchange', injectFavorites);
  let injectTimer = null;
  const scheduleInject = () => {
    if (window.__stremioCustomLangPickerOpen) return;
    if (document.querySelector('.stremio-custom-lang-picker.active')) return;
    clearTimeout(injectTimer);
    injectTimer = setTimeout(injectFavorites, 300);
  };
  const observer = new MutationObserver(scheduleInject);
  const root = document.querySelector('[class*="settings-content"]') || document.body;
  observer.observe(root, { childList: true, subtree: true });
  setInterval(() => {
    if (!/#\\/settings/.test(location.hash)) return;
    if (window.__stremioCustomLangPickerOpen) return;
    const missing =
      !document.getElementById(FAV_AUDIO_ID) ||
      !document.getElementById(FAV_SUBS_ID) ||
      !document.getElementById(QUICK_AUDIO_ID) ||
      !document.getElementById(QUICK_SUBS_ID) ||
      !document.getElementById(QUICK_AUTOSKIP_ID);
    if (missing) injectFavorites();
  }, 1500);
  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    window.StremioCustom?.helpers?.refreshAutoskipToggles?.();
  });
  document.addEventListener('stremio-custom-autoskip-ready', () => {
    window.StremioCustom?.helpers?.refreshAutoskipToggles?.();
  });
  console.info('[StremioCustom] Settings language runtime active (quick menu + favorites).');
})();
`;
}

window.StremioCustomFavoriteLanguagesPage = { buildFavoriteLanguagesPageScript };
})();
