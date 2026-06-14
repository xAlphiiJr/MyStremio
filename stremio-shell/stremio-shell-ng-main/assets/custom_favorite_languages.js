(function () {
  if (!window.StremioCustom?.helpers) {
    console.error('[StremioCustom] Favorite languages aborted: bootstrap missing');
    return;
  }

function getLanguageNames() {
  return window.__stremioLanguageNames || {};
}
const { getNativeSettingsSections } = window.StremioCustom.helpers;

const KEYS = {
  FAV_AUDIO: 'stremio-custom-fav-audio',
  ACTIVE_AUDIO: 'stremio-custom-active-audio',
  FAV_SUBS: 'stremio-custom-fav-subs',
  ACTIVE_SUBS: 'stremio-custom-active-subs',
};

const PLAYER_SETTINGS_FAV_AUDIO_ID = 'stremio-custom-fav-audio-select';
const PLAYER_SETTINGS_QUICK_AUDIO_ID = 'stremio-custom-fav-audio-quick';
const PLAYER_SETTINGS_FAV_SUBS_ID = 'stremio-custom-fav-subs-select';
const PLAYER_SETTINGS_QUICK_SUBS_ID = 'stremio-custom-fav-subs-quick';
const QUICK_SECTION_ID = 'stremio-custom-lang-quick-section';

const quickRenderers = { audio: null, subs: null };

const NONE_VALUE = 'none';
const MAX_FAVORITES = 6;

const ISO2_TO_ISO3 = {
  de: 'ger',
  en: 'eng',
  ja: 'jpn',
  fr: 'fre',
  es: 'spa',
  it: 'ita',
  pt: 'por',
  ru: 'rus',
  ko: 'kor',
  zh: 'zho',
  ar: 'ara',
  nl: 'nld',
  pl: 'pol',
  tr: 'tur',
};

const CLEANUP_PLAYER_BARS_SCRIPT = `
(function() {
  [
    'stremio-custom-fav-audio-bar',
    'stremio-custom-fav-subs-bar',
    'stremio-custom-fav-lang-bar',
    'stremio-custom-favorite-languages-runtime',
    'stremio-custom-general-lang-quick',
  ].forEach((id) => document.getElementById(id)?.remove());
})();
`;

function normalizeLanguageCode(code) {
  if (!code || typeof code !== 'string') return null;
  const trimmed = code.trim().toLowerCase();
  if (trimmed === NONE_VALUE) return NONE_VALUE;
  const mapped = ISO2_TO_ISO3[trimmed] || trimmed;
  return getLanguageNames()[mapped] ? mapped : null;
}

function sanitizeFavorites(list, allowNone = false) {
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

function cleanupLegacyLanguageData() {
  localStorage.removeItem('stremio-custom-language-filter');
  localStorage.removeItem('stremio-custom-favorite-languages');

  for (const [key, allowNone] of [
    [KEYS.FAV_AUDIO, false],
    [KEYS.FAV_SUBS, true],
  ]) {
    const cleaned = sanitizeFavorites(readJsonList(key), allowNone);
    if (cleaned.length) localStorage.setItem(key, JSON.stringify(cleaned));
    else localStorage.removeItem(key);
  }

  const activeAudio = normalizeLanguageCode(localStorage.getItem(KEYS.ACTIVE_AUDIO));
  if (activeAudio) localStorage.setItem(KEYS.ACTIVE_AUDIO, activeAudio);
  else localStorage.removeItem(KEYS.ACTIVE_AUDIO);

  const favSubs = sanitizeFavorites(readJsonList(KEYS.FAV_SUBS), true);
  const activeSubs = normalizeLanguageCode(localStorage.getItem(KEYS.ACTIVE_SUBS));
  if (activeSubs === NONE_VALUE) {
    localStorage.setItem(KEYS.ACTIVE_SUBS, NONE_VALUE);
  } else if (activeSubs && favSubs.some((code) => code === activeSubs)) {
    localStorage.setItem(KEYS.ACTIVE_SUBS, activeSubs);
  } else {
    localStorage.removeItem(KEYS.ACTIVE_SUBS);
  }
}

function readJsonList(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeJsonList(key, list, allowNone = false) {
  const cleaned = sanitizeFavorites(list, allowNone);
  if (cleaned.length) localStorage.setItem(key, JSON.stringify(cleaned));
  else localStorage.removeItem(key);
}

function getLanguageOptions(includeNone = false) {
  const options = Object.entries(getLanguageNames())
    .map(([code, label]) => ({ code, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'de'));

  if (includeNone) {
    return [{ code: NONE_VALUE, label: 'None' }, ...options];
  }
  return options;
}

function getSettingsSections() {
  return getNativeSettingsSections();
}

function findSettingsSection(pattern) {
  for (const section of getSettingsSections()) {
    const label = section.querySelector(':scope > [class*="label-"]')?.textContent || '';
    if (pattern.test(label)) return section;
  }
  return null;
}

function findPlayerSectionByContent() {
  for (const section of getSettingsSections()) {
    if (section.id === 'stremio-custom') continue;
    const text = section.textContent || '';
    if (
      /audiospur|audio.?track|default.?audio|untertitelsprache|subtitle.?language|surround.?sound|umgebungsklang/i.test(
        text
      )
    ) {
      return section;
    }
  }
  return null;
}

function findPlayerSectionByIndex() {
  const sections = getSettingsSections().filter((section) => section.id !== 'stremio-custom');
  return sections[2] || null;
}

function findPlayerSection() {
  return (
    findSettingsSection(/player|wiedergabe|abspielen/i) ||
    findPlayerSectionByContent() ||
    findPlayerSectionByIndex()
  );
}

function findGeneralSection() {
  return findSettingsSection(/general|allgemein/i) || getSettingsSections()[0] || null;
}

function findInterfaceSection() {
  return findSettingsSection(/interface|oberfläche/i) || getSettingsSections()[1] || null;
}

function ensureQuickSettingsSection() {
  document.getElementById('stremio-custom-quick-category')?.remove();

  const generalSection = findGeneralSection();
  if (!generalSection) return null;

  let quickSection = document.getElementById(QUICK_SECTION_ID);
  if (!quickSection) {
    quickSection = document.createElement('div');
    quickSection.id = QUICK_SECTION_ID;
    quickSection.className = generalSection.className;
  }

  if (!quickSection.parentElement) {
    const interfaceSection = findInterfaceSection();
    if (interfaceSection) {
      interfaceSection.insertAdjacentElement('beforebegin', quickSection);
    } else {
      generalSection.insertAdjacentElement('afterend', quickSection);
    }
  }

  return quickSection;
}

function removeQuickMenusFromWrongPlace() {
  const playerSection = findPlayerSection();

  for (const id of [PLAYER_SETTINGS_QUICK_AUDIO_ID, PLAYER_SETTINGS_QUICK_SUBS_ID]) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (playerSection?.contains(el)) {
      el.remove();
    }
  }
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

function findAudioCategory(playerSection) {
  return (
    findCategoryByLabel(playerSection, /audio|ton|laut|sound/i) ||
    findCategoryByOptionLabel(
      playerSection,
      /default.?audio|audiospur|standard.*audio|audio.?track|standard-audiospur/i
    )
  );
}

function findSubsCategory(playerSection) {
  return (
    findCategoryByLabel(playerSection, /subtitle|untertitel|untitel/i) ||
    findCategoryByOptionLabel(
      playerSection,
      /subtitle.?language|untertitel.*sprache|untertitelsprache|sprache.*untertitel/i
    )
  );
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

function isLanguageUiComplete() {
  const audioFav = document.getElementById(PLAYER_SETTINGS_FAV_AUDIO_ID);
  const subsFav = document.getElementById(PLAYER_SETTINGS_FAV_SUBS_ID);
  return Boolean(
    audioFav?.querySelector('.stremio-custom-lang-picker') &&
      subsFav?.querySelector('.stremio-custom-lang-picker')
  );
}

const LANG_SETTINGS_STYLE_ID = 'stremio-custom-lang-settings-style-v8';

function ensureLanguageSettingsStyles() {
  let style = document.getElementById(LANG_SETTINGS_STYLE_ID);
  document.getElementById('stremio-custom-lang-settings-style')?.remove();
  document.getElementById('stremio-custom-lang-settings-style-v2')?.remove();
  document.getElementById('stremio-custom-lang-settings-style-v3')?.remove();
  document.getElementById('stremio-custom-lang-settings-style-v4')?.remove();
  document.getElementById('stremio-custom-lang-settings-style-v5')?.remove();
  document.getElementById('stremio-custom-lang-settings-style-v6')?.remove();
  document.getElementById('stremio-custom-lang-settings-style-v7')?.remove();

  if (!style) {
    style = document.createElement('style');
    style.id = LANG_SETTINGS_STYLE_ID;
    document.head.appendChild(style);
  }

  style.textContent = `
    #stremio-custom-fav-audio-select > [class*="content-"],
    #stremio-custom-fav-subs-select > [class*="content-"] {
      align-items: stretch !important;
    }

    #stremio-custom-fav-audio-select .stremio-custom-lang-picker,
    #stremio-custom-fav-subs-select .stremio-custom-lang-picker {
      width: 100%;
      max-width: none;
      flex: 1 1 auto;
      align-self: stretch;
    }

    .stremio-custom-lang-picker {
      position: relative;
      width: 100%;
      min-width: 8.5rem;
      max-width: none;
      overflow: visible;
      border-radius: 2.75rem;
      background: var(--overlay-color);
    }

    .stremio-custom-lang-picker:hover,
    .stremio-custom-lang-picker.active {
      background-color: var(--overlay-color);
    }

    .stremio-custom-lang-picker-trigger {
      width: 100%;
      height: 3rem;
      padding: 0.75rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      border-radius: 2.75rem;
      border: none;
      background: transparent;
      color: var(--primary-foreground-color);
      cursor: pointer;
      font: inherit;
      box-shadow: none;
      backdrop-filter: none;
    }

    .stremio-custom-lang-picker-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: left;
      flex: 1;
      color: var(--primary-foreground-color);
    }

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

    .stremio-custom-lang-picker-dropdown {
      position: fixed;
      display: none;
      z-index: 100000;
      box-sizing: border-box;
      padding: 0;
      background: var(--modal-background-color);
      border: none;
      box-shadow: var(--outer-glow);
      border-radius: var(--border-radius);
      backdrop-filter: none;
      overflow: hidden;
      max-height: 21rem;
      overflow-y: auto;
    }

    .stremio-custom-lang-picker-dropdown.open {
      display: block !important;
    }

    .stremio-custom-fav-option {
      height: 3rem;
      font-size: var(--font-size-normal);
      color: var(--primary-foreground-color);
      align-items: center;
      display: flex;
      flex-direction: row;
      padding: 1rem;
      margin: 0;
      border-radius: 0;
      cursor: pointer;
    }

    .stremio-custom-fav-option:hover {
      background-color: rgba(255, 255, 255, 0.15);
    }

    .stremio-custom-fav-option.selected {
      background-color: transparent;
    }

    .stremio-custom-fav-option-label {
      flex: 1;
      color: var(--primary-foreground-color);
    }

    .stremio-custom-fav-option-icon {
      flex: none;
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 100%;
      margin-left: 1rem;
      background-color: var(--secondary-accent-color);
      opacity: 1;
    }

    #stremio-custom-fav-audio-quick > [class*="content-"],
    #stremio-custom-fav-subs-quick > [class*="content-"] {
      justify-content: flex-start !important;
    }

    .stremio-custom-lang-quick-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
      width: 100%;
    }

    .stremio-custom-lang-quick-btn {
      min-height: 2.75rem;
      padding: 0.55rem 1.1rem;
      border-radius: 2.75rem;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(70, 70, 70, 0.22);
      backdrop-filter: blur(12px) saturate(140%);
      color: var(--primary-foreground-color, #fff);
      font: inherit;
      font-size: 0.95rem;
      cursor: pointer;
      transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
      box-shadow:
        0 4px 14px rgba(0, 0, 0, 0.12),
        inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }

    .stremio-custom-lang-quick-btn:hover {
      background: rgba(90, 90, 90, 0.32);
    }

    .stremio-custom-lang-quick-btn.active {
      border-color: rgba(255, 255, 255, 0.35);
      background: rgba(255, 255, 255, 0.12);
      box-shadow:
        0 4px 18px rgba(0, 0, 0, 0.25),
        inset 0 1px 0 rgba(255, 255, 255, 0.2);
    }
  `;
}

const LANGUAGE_UI_IDS = [
  PLAYER_SETTINGS_FAV_AUDIO_ID,
  PLAYER_SETTINGS_FAV_SUBS_ID,
];

function cleanupBrokenLanguageUi() {
  document.getElementById('stremio-custom-general-lang-quick')?.remove();

  for (const id of LANGUAGE_UI_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;

    const isFav = id.includes('select');
    const isQuick = id.includes('quick');
    const hasPicker = Boolean(el.querySelector('.stremio-custom-lang-picker'));
    const hasQuick = Boolean(el.querySelector('.stremio-custom-lang-quick-row'));

    if ((isFav && !hasPicker) || (isQuick && !hasQuick)) {
      el.remove();
    }
  }
}

function favoriteSelectPlaceholder() {
  return 'Select…';
}

function formatSelectionLabel(selected, options) {
  if (!selected.length) return favoriteSelectPlaceholder();
  const labels = selected
    .map((code) => options.find((o) => o.code === code)?.label || code)
    .slice(0, 2);
  const extra = selected.length - labels.length;
  return labels.join(', ') + (extra > 0 ? ` +${extra}` : '');
}

function createFavoritePicker(content, options, storageKey, allowNone, onChange) {
  let selected = sanitizeFavorites(readJsonList(storageKey), allowNone);
  writeJsonList(storageKey, selected, allowNone);

  const picker = document.createElement('div');
  picker.className = 'stremio-custom-lang-picker';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'stremio-custom-lang-picker-trigger';

  const buttonLabel = document.createElement('span');
  buttonLabel.className = 'stremio-custom-lang-picker-label';
  buttonLabel.textContent = formatSelectionLabel(selected, options);

  const caret = document.createElement('span');
  caret.className = 'stremio-custom-native-caret';
  caret.setAttribute('aria-hidden', 'true');

  trigger.append(buttonLabel, caret);
  picker.appendChild(trigger);

  const dropdown = document.createElement('div');
  dropdown.className = 'stremio-custom-lang-picker-dropdown';
  picker.appendChild(dropdown);

  const updateRowState = (row, isRowSelected) => {
    row.classList.toggle('selected', isRowSelected);
    row.setAttribute('aria-selected', isRowSelected ? 'true' : 'false');
    const existingDot = row.querySelector('.stremio-custom-fav-option-icon');
    if (isRowSelected && !existingDot) {
      const dot = document.createElement('div');
      dot.className = 'stremio-custom-fav-option-icon';
      row.appendChild(dot);
    } else if (!isRowSelected && existingDot) {
      existingDot.remove();
    }
  };

  const renderDropdown = () => {
    dropdown.innerHTML = '';
    for (const opt of options) {
      const isSelected = selected.includes(opt.code);
      const row = document.createElement('div');
      row.className = 'stremio-custom-fav-option' + (isSelected ? ' selected' : '');
      row.setAttribute('aria-selected', isSelected ? 'true' : 'false');

      const label = document.createElement('div');
      label.className = 'stremio-custom-fav-option-label';
      label.textContent = opt.label;

      row.appendChild(label);
      if (isSelected) {
        const dot = document.createElement('div');
        dot.className = 'stremio-custom-fav-option-icon';
        row.appendChild(dot);
      }
      row.addEventListener('mousedown', (event) => {
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
        onChange(selected);
        renderDropdown();
      });

      dropdown.appendChild(row);
    }
  };

  const getDropdownWidth = () => {
    const category = picker.closest('[class*="category-"]');
    const nativeMultiselect = category?.querySelector('[class*="multiselect"]');
    const reference = nativeMultiselect || picker;
    return reference.getBoundingClientRect().width;
  };

  const positionDropdown = () => {
    const pickerRect = picker.getBoundingClientRect();
    const width = getDropdownWidth();
    dropdown.style.top = `${pickerRect.bottom + 4}px`;
    dropdown.style.left = `${pickerRect.left}px`;
    dropdown.style.width = `${width}px`;
    dropdown.style.minWidth = `${width}px`;
    dropdown.style.maxWidth = `${width}px`;
  };

  const closeDropdown = () => {
    picker.classList.remove('active');
    dropdown.classList.remove('open');
    dropdown.style.display = 'none';
    if (dropdown.parentElement === document.body) {
      picker.appendChild(dropdown);
    }
  };

  const openDropdown = () => {
    renderDropdown();
    document.body.appendChild(dropdown);
    picker.classList.add('active');
    dropdown.classList.add('open');
    dropdown.style.display = 'block';
    positionDropdown();
    requestAnimationFrame(positionDropdown);
  };

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (picker.classList.contains('active')) {
      closeDropdown();
    } else {
      openDropdown();
    }
  });

  document.addEventListener('click', (event) => {
    if (!picker.classList.contains('active')) return;
    if (picker.contains(event.target) || dropdown.contains(event.target)) return;
    closeDropdown();
  });

  window.addEventListener('resize', () => {
    if (picker.classList.contains('active')) positionDropdown();
  });
  window.addEventListener('scroll', () => {
    if (picker.classList.contains('active')) positionDropdown();
  }, true);

  content.appendChild(picker);
}

function setDefaultLanguageViaCore(settingKey, code) {
  const coreValue = code === NONE_VALUE ? null : code;
  const payload = JSON.stringify({ settingKey, value: coreValue });

  const script = document.createElement('script');
  script.textContent = `
    (async function() {
      try {
        const payload = ${payload};
        if (!window.core?.dispatch || !window.core?.getState) return;
        const ctx = await window.core.getState('ctx');
        const settings = ctx?.profile?.settings;
        if (!settings) return;
        await window.core.dispatch({
          action: 'Ctx',
          args: {
            action: 'UpdateSettings',
            args: Object.assign({}, settings, { [payload.settingKey]: payload.value })
          }
        });
      } catch (e) {
        console.warn('[StremioCustom] Language update failed:', e);
      }
    })();
  `;
  (document.documentElement || document.head).appendChild(script);
  script.remove();
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

function createQuickSelectRow(content, favorites, activeKey, options, settingKey, allowNone = false) {
  const row = document.createElement('div');
  row.className = 'stremio-custom-lang-quick-row';

  const render = (favs) => {
    row.innerHTML = '';
    const cleaned = sanitizeFavorites(favs, allowNone);

    if (!cleaned.length) {
      const hint = document.createElement('span');
      hint.dataset.scMeta = 'true';
      hint.textContent = 'Select favorite languages above first.';
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
        setDefaultLanguageViaCore(settingKey, code);
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

function injectPlayerFavoriteSettings(classes) {
  const playerSection = findPlayerSection();
  if (!playerSection) return false;

  const playerClasses = getClassesFromSection(playerSection) || classes;
  if (!playerClasses?.option) return false;

  const audioCategory = findAudioCategory(playerSection);
  const subsCategory = findSubsCategory(playerSection);
  const audioOptions = getLanguageOptions(false);
  const subsOptions = getLanguageOptions(true);
  let injected = false;

  if (audioCategory && !document.getElementById(PLAYER_SETTINGS_FAV_AUDIO_ID)) {
    const anchor = findOptionByLabel(
      audioCategory,
      /default.?audio|audiospur|standard.*audio|audio.?track|standard-audiospur/i
    );
    const { option, content } = createSettingsOption(
      playerClasses,
      'Favorite audio languages',
      PLAYER_SETTINGS_FAV_AUDIO_ID
    );
    createFavoritePicker(content, audioOptions, KEYS.FAV_AUDIO, false, (favs) => {
      if (quickRenderers.audio) quickRenderers.audio(favs);
    });
    if (anchor) anchor.insertAdjacentElement('afterend', option);
    else audioCategory.appendChild(option);
    injected = true;
  }

  if (subsCategory && !document.getElementById(PLAYER_SETTINGS_FAV_SUBS_ID)) {
    const anchor =
      findOptionByLabel(
        subsCategory,
        /subtitle.?language|untertitel.*sprache|untertitelsprache|sprache.*untertitel/i
      ) || subsCategory.querySelector('[class*="option-"]');
    const { option, content } = createSettingsOption(
      playerClasses,
      'Favorite subtitles',
      PLAYER_SETTINGS_FAV_SUBS_ID
    );
    createFavoritePicker(content, subsOptions, KEYS.FAV_SUBS, true, (favs) => {
      if (quickRenderers.subs) quickRenderers.subs(favs);
    });
    if (anchor) anchor.insertAdjacentElement('afterend', option);
    else subsCategory.appendChild(option);
    injected = true;
  }

  return injected;
}

function injectPlayerLanguageSettings(classes) {
  try {
    cleanupBrokenLanguageUi();
    cleanupLegacyLanguageData();
    ensureLanguageSettingsStyles();

    injectPlayerFavoriteSettings(classes);

    return isLanguageUiComplete();
  } catch (error) {
    console.error('[StremioCustom] Language settings injection failed:', error);
    return false;
  }
}

let languageInjectTimer = null;
let languageInjectAttempts = 0;
const MAX_LANGUAGE_INJECT_ATTEMPTS = 120;

function tryInjectPlayerLanguageSettings(classes) {
  if (!/#\/settings/.test(location.href)) return;

  const injected = injectPlayerLanguageSettings(classes);
  if (injected || isLanguageUiComplete()) {
    languageInjectAttempts = 0;
    return;
  }

  if (languageInjectAttempts >= MAX_LANGUAGE_INJECT_ATTEMPTS) return;
  languageInjectAttempts += 1;

  if (languageInjectTimer) return;
  languageInjectTimer = setTimeout(() => {
    languageInjectTimer = null;
    if (!/#\/settings/.test(location.href)) return;
    const playerSection = findPlayerSection();
    const retryClasses = getClassesFromSection(playerSection) || classes;
    tryInjectPlayerLanguageSettings(retryClasses);
  }, 400);
}

function removePlayerLanguageBars() {
  const inject = () => {
    if (document.getElementById('stremio-custom-player-bars-cleanup')) return;
    const script = document.createElement('script');
    script.id = 'stremio-custom-player-bars-cleanup';
    script.textContent = CLEANUP_PLAYER_BARS_SCRIPT;
    (document.head || document.documentElement).appendChild(script);
  };

  if (document.head || document.documentElement) inject();
  else window.addEventListener('DOMContentLoaded', inject, { once: true });
}

function injectFavoriteHeartsRuntime() {
  const { buildFavoriteLanguagesPageScript } = window.StremioCustomFavoriteLanguagesPage;

  const inject = () => {
    if (window.__stremioCustomLangPageRuntime) {
      return;
    }

    const script = document.createElement('script');
    script.id = 'stremio-custom-fav-lang-page-runtime';
    script.textContent = buildFavoriteLanguagesPageScript();
    (document.head || document.documentElement).appendChild(script);
  };

  if (document.head || document.documentElement) {
    inject();
  } else {
    window.addEventListener('DOMContentLoaded', inject, { once: true });
  }
}

window.StremioCustomFavoriteLanguages = {
  KEYS,
  QUICK_SECTION_ID,
  ensureQuickSettingsSection,
  cleanupLegacyLanguageData,
  removePlayerLanguageBars,
  injectFavoriteHeartsRuntime,
  injectPlayerLanguageSettings,
  tryInjectPlayerLanguageSettings,
  isLanguageUiComplete,
};
})();
