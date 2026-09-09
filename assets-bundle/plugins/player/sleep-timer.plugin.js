/**
 * @name Sleep Timer
 * @description Sleep, close, or shut down when a countdown, clock, or end of episode is reached.
 * @version 1.0.3
 * @author MyStremio
 * @category player
 */
/* jshint esversion: 11, browser: true, devel: true */

(function () {
  'use strict';

  const PLUGIN_VERSION = '1.0.3';
  const PLUGIN_ID = 'sleep-timer';
  const PLUGIN_REF = 'player/sleep-timer.plugin.js';
  const LOG_PREFIX = '[Sleep Timer]';

  if (window.__stremioSleepTimerPluginReady === PLUGIN_VERSION) return;

  const BTN_ID = 'mystremio-sleep-timer-btn';
  const PANEL_ID = 'mystremio-sleep-timer-panel';
  const BADGE_ID = 'mystremio-sleep-badge';
  const PLAYER_STYLE_ID = 'mystremio-sleep-timer-player-styles';
  const OVERLAY_LOCK_CLASS = 'mystremio-sleep-overlay-lock';
  const ARMED_CLASS = 'mystremio-sleep-end-armed';
  const STORAGE_KEY = 'stremio-custom-sleep-timer';
  const ANIME4K_BTN_ID = 'mystremio-anime4k-btn';
  const CONTRIBUTE_BTN_ID = 'tidb-contribute-btn';
  const CAST_BTN_ID = 'mystremio-cast-overlay-btn';
  const ICON_SIZE = '2.0rem';
  const PANEL_VERSION = '3';
  const SETTING_RUNNING = 'running';
  const SETTING_REMAINING = 'remaining';
  const SETTING_ACTION = 'action';
  const SETTING_TRIGGER = 'trigger';
  const SETTING_HOURS = 'hours';
  const SETTING_MINUTES = 'minutes';
  const SETTINGS_SCHEMA = [
    {
      key: SETTING_RUNNING,
      type: 'toggle',
      label: 'Timer running',
      description: 'Turn on to start the sleep timer. Turn off to cancel.',
      defaultValue: false,
    },
    {
      key: SETTING_REMAINING,
      type: 'input',
      label: 'Remaining',
      description: 'Time left while the timer is running. Idle when it is off.',
      defaultValue: 'Idle',
    },
    {
      key: SETTING_ACTION,
      type: 'select',
      label: 'Action',
      defaultValue: 'sleep',
      options: [
        { value: 'sleep', label: 'Sleep' },
        { value: 'close', label: 'Close' },
        { value: 'shutdown', label: 'Shutdown' },
      ],
    },
    {
      key: SETTING_TRIGGER,
      type: 'select',
      label: 'When',
      defaultValue: 'countdown',
      options: [
        { value: 'countdown', label: 'Countdown' },
        { value: 'clock', label: 'Clock' },
        { value: 'episode', label: 'End of episode' },
      ],
    },
    {
      key: SETTING_HOURS,
      type: 'input',
      inputType: 'number',
      label: 'Hours',
      description: 'Countdown duration hours, or clock hour (0–23).',
      defaultValue: '0',
    },
    {
      key: SETTING_MINUTES,
      type: 'input',
      inputType: 'number',
      label: 'Minutes',
      description: 'Countdown duration minutes, or clock minute (0–59).',
      defaultValue: '30',
    },
  ];
  const ACTIONS = [
    { value: 'sleep', label: 'Sleep' },
    { value: 'close', label: 'Close' },
    { value: 'shutdown', label: 'Shutdown' },
  ];
  const TRIGGERS = [
    { value: 'countdown', label: 'Countdown' },
    { value: 'clock', label: 'Clock' },
    { value: 'episode', label: 'End of episode' },
  ];
  const ACTION_VALUES = new Set(ACTIONS.map((entry) => entry.value));
  const TRIGGER_VALUES = new Set(TRIGGERS.map((entry) => entry.value));

  let shellMsgId = 17000;
  let prefs = {
    action: 'sleep',
    trigger: 'countdown',
    hours: 0,
    minutes: 30,
  };
  let armed = false;
  let deadlineMs = 0;
  let tickTimer = null;
  let episodeAutoPlayHeld = false;
  let firing = false;
  let panelOpen = false;
  let outsideHandler = null;
  let keyHandler = null;
  let ensureTimer = null;
  let retryTimer = null;
  let layoutObserver = null;
  let overlayObserver = null;
  let chromeIdleWatcher = null;
  let dismissGuardUntil = 0;
  let mpvHookInstalled = false;
  let routeHandler = null;
  let streamHandler = null;
  let applyingSettings = false;
  let settingsWired = false;
  let lastWrittenRunning = false;

  /**
   * @returns {boolean}
   */
  function isPluginEnabled() {
    const helpers = window.StremioCustom?.helpers;
    if (!helpers?.isPluginEnabled) return false;
    return helpers.isPluginEnabled(PLUGIN_REF);
  }

  /**
   * @returns {boolean}
   */
  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  /**
   * Chrome is idle when the player container that owns the nav bar has overlayHidden.
   * @returns {boolean}
   */
  function isOverlayHidden() {
    const nav = document.querySelector('[class*="nav-bar-layer"]');
    const player =
      nav?.closest('[class*="player-container"]') ||
      document.querySelector('[class*="player-container"]');
    if (!player) return false;
    for (const className of player.classList) {
      if (String(className).includes('overlayHidden')) return true;
    }
    return false;
  }

  /**
   * @returns {object|null}
   */
  function getSettingsApi() {
    return window.StremioCustomAPI || window.StremioEnhancedAPI || null;
  }

  /**
   * @param {unknown} value
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function clampInt(value, min, max) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  /**
   * @param {unknown} raw
   * @returns {typeof prefs}
   */
  function normalizePrefs(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const rawAction = src.action === 'restart' ? 'sleep' : src.action;
    const action = ACTION_VALUES.has(rawAction) ? rawAction : 'sleep';
    const trigger = TRIGGER_VALUES.has(src.trigger) ? src.trigger : 'countdown';
    const hourMax = trigger === 'clock' ? 23 : 12;
    return {
      action,
      trigger,
      hours: clampInt(src.hours, 0, hourMax),
      minutes: clampInt(src.minutes, 0, 59),
    };
  }

  function isSettingsPage() {
    return /#\/settings(?:[/?#]|$)/.test(location.hash || '');
  }

  /**
   * @param {unknown} value
   * @returns {boolean|null}
   */
  function parseToggle(value) {
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    return null;
  }

  /**
   * @returns {string}
   */
  function remainingDisplayText() {
    if (!armed) return 'Idle';
    return badgeText() || 'Running';
  }

  function persistPluginSettings() {
    if (applyingSettings) return;
    const api = getSettingsApi();
    if (!api?.saveSetting) return;
    lastWrittenRunning = armed;
    applyingSettings = true;
    Promise.all([
      api.saveSetting(PLUGIN_ID, SETTING_ACTION, prefs.action),
      api.saveSetting(PLUGIN_ID, SETTING_TRIGGER, prefs.trigger),
      api.saveSetting(PLUGIN_ID, SETTING_HOURS, String(prefs.hours)),
      api.saveSetting(PLUGIN_ID, SETTING_MINUTES, String(prefs.minutes)),
      api.saveSetting(PLUGIN_ID, SETTING_RUNNING, armed),
    ])
      .catch(() => {})
      .finally(() => {
        applyingSettings = false;
      });
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      prefs = normalizePrefs(JSON.parse(raw));
    } catch (_) {}
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (_) {}
    persistPluginSettings();
  }

  /**
   * @returns {Promise<void>}
   */
  async function loadSettingsFromApi() {
    const api = getSettingsApi();
    if (!api?.getSetting) return;
    try {
      const [action, trigger, hours, minutes] = await Promise.all([
        api.getSetting(PLUGIN_ID, SETTING_ACTION),
        api.getSetting(PLUGIN_ID, SETTING_TRIGGER),
        api.getSetting(PLUGIN_ID, SETTING_HOURS),
        api.getSetting(PLUGIN_ID, SETTING_MINUTES),
      ]);
      const merged = { ...prefs };
      if (action != null && String(action).trim() !== '') merged.action = action;
      if (trigger != null && String(trigger).trim() !== '') merged.trigger = trigger;
      if (hours != null && String(hours).trim() !== '') merged.hours = hours;
      if (minutes != null && String(minutes).trim() !== '') merged.minutes = minutes;
      prefs = normalizePrefs(merged);
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to load settings:`, error);
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async function registerSettingsUi() {
    const api = getSettingsApi();
    if (!api?.registerSettings || window.__stremioSleepTimerSettingsRegistered) return;
    try {
      await api.registerSettings(PLUGIN_ID, SETTINGS_SCHEMA);
      window.__stremioSleepTimerSettingsRegistered = true;
    } catch (error) {
      const message = error && error.message ? String(error.message) : '';
      if (message.includes('settings schema registered')) {
        window.__stremioSleepTimerSettingsRegistered = true;
        return;
      }
      console.warn(`${LOG_PREFIX} Failed to register settings:`, error);
    }
  }

  function applySettingsPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    const next = { ...prefs };
    if (payload[SETTING_ACTION] != null) next.action = payload[SETTING_ACTION];
    if (payload[SETTING_TRIGGER] != null) next.trigger = payload[SETTING_TRIGGER];
    if (payload[SETTING_HOURS] != null) next.hours = payload[SETTING_HOURS];
    if (payload[SETTING_MINUTES] != null) next.minutes = payload[SETTING_MINUTES];
    const prev = { ...prefs };
    prefs = normalizePrefs(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (_) {}
    const wantRunning = parseToggle(payload[SETTING_RUNNING]);
    const prefsChanged =
      prev.action !== prefs.action ||
      prev.trigger !== prefs.trigger ||
      prev.hours !== prefs.hours ||
      prev.minutes !== prefs.minutes;
    if (wantRunning != null && wantRunning !== lastWrittenRunning) {
      lastWrittenRunning = wantRunning;
      if (wantRunning) {
        if (!armed) armTimer();
        else if (prefsChanged) armTimer();
      } else if (armed) {
        cancelTimer('settings');
      }
    } else if (armed && prefsChanged) {
      armTimer();
    }
    syncSteppers();
    syncPanelArmedState();
    syncBadge();
  }

  function wireSettingsListener() {
    const api = getSettingsApi();
    if (!api?.onSettingsSaved || settingsWired) return;
    settingsWired = true;
    api.onSettingsSaved(PLUGIN_ID, async (payload) => {
      if (applyingSettings) return;
      applyingSettings = true;
      try {
        if (payload && typeof payload === 'object') {
          applySettingsPayload(payload);
        } else {
          await loadSettingsFromApi();
          syncSteppers();
          syncPanelArmedState();
        }
      } finally {
        applyingSettings = false;
      }
    });
  }

  function syncSettingsRemainingDom() {
    if (!isSettingsPage()) return;
    const text = remainingDisplayText();
    const labels = document.querySelectorAll('[class*="plugin-setting-label"]');
    for (const label of labels) {
      if (String(label.textContent || '').trim() !== 'Remaining') continue;
      const row =
        label.closest('[class*="plugin-setting-row"]') ||
        label.closest('[class*="plugin-setting"]') ||
        label.parentElement;
      const input = row?.querySelector('input');
      if (!input || document.activeElement === input) continue;
      input.value = text;
      input.readOnly = true;
      input.tabIndex = -1;
    }
  }

  /**
   * @param {string} prop
   * @param {string|number|boolean} value
   * @returns {boolean}
   */
  function sendMpvSetProp(prop, value) {
    if (!window.chrome?.webview?.postMessage) return false;
    try {
      window.chrome.webview.postMessage(
        JSON.stringify({
          id: ++shellMsgId,
          args: ['mpv-set-prop', [prop, value]],
        })
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  function pausePlayback() {
    try {
      window.StremioCustomPlayback?.getVideo?.()?.pause?.();
    } catch (_) {}
    sendMpvSetProp('pause', true);
  }

  /**
   * @param {number} totalSeconds
   * @returns {string}
   */
  function formatRemaining(totalSeconds) {
    const sec = Math.max(0, Math.ceil(totalSeconds));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * @param {number} hours
   * @param {number} minutes
   * @returns {string}
   */
  function formatClock(hours, minutes) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  /**
   * @returns {number}
   */
  function clockDeadlineMs(hours, minutes) {
    const now = new Date();
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    if (target.getTime() <= now.getTime() + 500) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }

  /**
   * @returns {number}
   */
  function episodeRemainingSec() {
    const playback = window.StremioCustomPlayback;
    const duration = Number(playback?.getDuration?.());
    const current = Number(playback?.getCurrentTime?.());
    if (!Number.isFinite(duration) || duration <= 0) return NaN;
    if (!Number.isFinite(current) || current < 0) return duration;
    return Math.max(0, duration - current);
  }

  function setEpisodeArmedUi(on) {
    document.documentElement.classList.toggle(ARMED_CLASS, Boolean(on));
    if (on) {
      if (!episodeAutoPlayHeld) {
        window.StremioCustomPlayback?.suppressAutoPlay?.();
        episodeAutoPlayHeld = true;
      }
      return;
    }
    if (episodeAutoPlayHeld) {
      window.StremioCustomPlayback?.releaseAutoPlay?.();
      episodeAutoPlayHeld = false;
    }
  }

  /**
   * @returns {string}
   */
  function badgeText() {
    if (!armed) return '';
    if (prefs.trigger === 'clock') {
      const target = new Date(deadlineMs);
      return formatClock(target.getHours(), target.getMinutes());
    }
    if (prefs.trigger === 'episode') {
      const remaining = episodeRemainingSec();
      if (!Number.isFinite(remaining)) return 'EOF';
      return formatRemaining(remaining);
    }
    return formatRemaining((deadlineMs - Date.now()) / 1000);
  }

  const FULLSCREEN_SELECTORS = [
    '[title*="ullscreen" i]',
    '[aria-label*="ullscreen" i]',
    '[title*="ollbild" i]',
    '[aria-label*="ollbild" i]',
    '[data-testid*="fullscreen" i]',
    '[class*="fullscreen"][role="button"]',
    '[class*="button-container"][title*="ullscreen" i]',
    '[class*="button-container"][aria-label*="ullscreen" i]',
  ];

  /**
   * @param {Element|null} el
   * @returns {boolean}
   */
  function isVisibleControl(el) {
    if (!(el instanceof HTMLElement)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * @param {Element} el
   * @returns {HTMLElement}
   */
  function fullscreenAnchor(el) {
    const wrap = el.closest('[class*="button-container"]');
    return wrap instanceof HTMLElement ? wrap : el;
  }

  /**
   * Top-right player fullscreen control. Stremio renders these as
   * `div.button-container`, not `<button>`.
   * @returns {HTMLElement|null}
   */
  function findFullscreenButton() {
    const nav = document.querySelector('[class*="player-container"] [class*="nav-bar-layer"]');
    const roots = nav ? [nav, document] : [document];
    for (const root of roots) {
      const matches = root.querySelectorAll(FULLSCREEN_SELECTORS.join(', '));
      for (const el of matches) {
        if (!isVisibleControl(el)) continue;
        if (el.closest('[class*="side-drawer-button-layer"]')) continue;
        return fullscreenAnchor(el);
      }
    }
    if (!nav) return null;
    let best = null;
    let bestRight = -Infinity;
    const buttons = nav.querySelectorAll('[class*="button-container"], button, [role="button"]');
    for (const el of buttons) {
      if (!isVisibleControl(el)) continue;
      if (el.closest('[class*="side-drawer-button-layer"]')) continue;
      if (String(el.className).includes('back-button')) continue;
      const right = el.getBoundingClientRect().right;
      if (right > bestRight) {
        bestRight = right;
        best = el;
      }
    }
    return best instanceof HTMLElement ? best : null;
  }

  function ensureBadgeEl() {
    let badge = document.getElementById(BADGE_ID);
    if (badge) return badge;
    badge = document.createElement('span');
    badge.id = BADGE_ID;
    badge.className = 'mystremio-sleep-badge';
    badge.hidden = true;
    const moon = buildMoonIcon('mystremio-sleep-badge-moon');
    const time = document.createElement('span');
    time.className = 'mystremio-sleep-badge-time';
    badge.append(moon, time);
    document.body.appendChild(badge);
    return badge;
  }

  function positionBadge() {
    if (!document.getElementById(PLAYER_STYLE_ID)) injectPlayerStyles();
    const badge = document.getElementById(BADGE_ID) || (armed ? ensureBadgeEl() : null);
    if (!badge) return;
    const text = badgeText();
    const show =
      Boolean(armed && text && isPlayerRoute() && isPluginEnabled() && !isOverlayHidden());
    if (!show) {
      badge.hidden = true;
      return;
    }
    const timeEl = badge.querySelector('.mystremio-sleep-badge-time');
    if (timeEl) timeEl.textContent = text;
    if (!badge.querySelector('.mystremio-sleep-badge-moon')) {
      badge.insertBefore(buildMoonIcon('mystremio-sleep-badge-moon'), badge.firstChild);
    }
    badge.hidden = false;
    const fullscreen = findFullscreenButton();
    const gap = 8;
    if (fullscreen) {
      const rect = fullscreen.getBoundingClientRect();
      badge.style.left = `${rect.left - gap}px`;
      badge.style.top = `${rect.top + rect.height / 2}px`;
      badge.style.right = 'auto';
      badge.style.transform = 'translate(-100%, -50%)';
      return;
    }
    badge.style.left = 'auto';
    badge.style.right = '4.75rem';
    badge.style.top = '1.75rem';
    badge.style.transform = 'translateY(-50%)';
  }

  function syncBadge() {
    const button = document.getElementById(BTN_ID);
    const text = badgeText();
    if (button) {
      button.classList.toggle('is-armed', armed);
      button.title = armed ? `Sleep Timer · ${text}` : 'Sleep Timer';
    }
    positionBadge();
    syncSettingsRemainingDom();
  }

  function syncPanelArmedState() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const startBtn = panel.querySelector('[data-sleep-start]');
    if (startBtn) startBtn.textContent = armed ? 'Cancel' : 'Start';
    panel.classList.toggle('is-armed', armed);
    const timeRow = panel.querySelector('[data-sleep-time]');
    if (timeRow) timeRow.hidden = prefs.trigger === 'episode';
    panel.querySelectorAll('[data-sleep-actions] button, [data-sleep-triggers] button').forEach((btn) => {
      btn.disabled = armed;
    });
    panel.querySelectorAll('[data-sleep-time] button').forEach((btn) => {
      btn.disabled = armed;
    });
  }

  function stopTick() {
    if (tickTimer) {
      window.clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function startTick() {
    stopTick();
    tickTimer = window.setInterval(() => {
      if (!armed) {
        stopTick();
        return;
      }
      syncBadge();
      if (prefs.trigger === 'episode') {
        const remaining = episodeRemainingSec();
        if (Number.isFinite(remaining) && remaining <= 0.4) {
          fireArmedAction();
        }
        return;
      }
      if (!deadlineMs || deadlineMs <= 0) return;
      if (Date.now() >= deadlineMs) fireArmedAction();
    }, 250);
  }

  function cancelTimer(reason) {
    if (!armed && !firing) {
      setEpisodeArmedUi(false);
      syncBadge();
      syncPanelArmedState();
      return;
    }
    armed = false;
    firing = false;
    deadlineMs = 0;
    stopTick();
    setEpisodeArmedUi(false);
    syncBadge();
    syncPanelArmedState();
    persistPluginSettings();
    if (reason) console.info(`${LOG_PREFIX} Cancelled (${reason}).`);
  }

  /**
   * @returns {Promise<void>}
   */
  async function fireArmedAction() {
    if (!armed || firing) return;
    if (prefs.trigger === 'countdown' && (prefs.hours === 0 && prefs.minutes === 0)) return;
    if (prefs.trigger !== 'episode' && (!deadlineMs || deadlineMs <= 0)) return;
    firing = true;
    const action = prefs.action;
    armed = false;
    stopTick();
    setEpisodeArmedUi(false);
    syncBadge();
    syncPanelArmedState();
    persistPluginSettings();
    if (action !== 'close') pausePlayback();
    const api = getSettingsApi();
    try {
      await api?.invoke?.('power-action', { action }, 4000);
    } catch (error) {
      console.warn(`${LOG_PREFIX} Power action failed:`, error);
    }
    firing = false;
  }

  function armTimer() {
    prefs = normalizePrefs(prefs);
    if (prefs.trigger === 'countdown' && prefs.hours === 0 && prefs.minutes === 0) {
      if (armed) cancelTimer('zero-countdown');
      return;
    }
    armed = true;
    firing = false;
    if (prefs.trigger === 'countdown') {
      deadlineMs = Date.now() + (prefs.hours * 3600 + prefs.minutes * 60) * 1000;
      setEpisodeArmedUi(false);
    } else if (prefs.trigger === 'clock') {
      deadlineMs = clockDeadlineMs(prefs.hours, prefs.minutes);
      setEpisodeArmedUi(false);
    } else {
      deadlineMs = 0;
      setEpisodeArmedUi(true);
    }
    startTick();
    syncBadge();
    syncPanelArmedState();
    savePrefs();
    if (isPlayerRoute()) closePanel();
  }

  function parseEndedPayload(raw) {
    try {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!data) return null;
      if (Array.isArray(data) && data[0] === 'mpv-event-ended') return data[1];
      if (Array.isArray(data.args) && data.args[0] === 'mpv-event-ended') return data.args[1];
      if (data.type === 1 && Array.isArray(data.args) && data.args[0] === 'mpv-event-ended') {
        return data.args[1];
      }
    } catch (_) {}
    return null;
  }

  function hookMpvEnded() {
    if (mpvHookInstalled || !window.chrome?.webview?.addEventListener) return;
    mpvHookInstalled = true;
    window.chrome.webview.addEventListener('message', (ev) => {
      const ended = parseEndedPayload(ev?.data);
      if (!ended || ended.reason !== 'eof') return;
      if (!armed || prefs.trigger !== 'episode') return;
      fireArmedAction();
    });
  }

  function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  /**
   * @param {string} svgClass
   * @returns {SVGSVGElement}
   */
  function buildMoonIcon(svgClass) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    if (svgClass) svg.setAttribute('class', svgClass);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute(
      'd',
      'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'
    );
    svg.appendChild(path);
    return svg;
  }

  /**
   * @param {Element} button
   */
  function replaceButtonIcon(button) {
    const iconWrap = button.querySelector('[class*="icon"]');
    const refSvg = button.querySelector('svg');
    const svgClass = refSvg?.getAttribute('class') || '';
    const svg = buildMoonIcon(svgClass);
    if (iconWrap) {
      iconWrap.replaceChildren(svg);
    } else if (refSvg) {
      refSvg.replaceWith(svg);
    } else {
      button.appendChild(svg);
    }
  }

  function getButtonTemplate() {
    const container = document.querySelector(
      '[class*="player-container"] [class*="control-bar-buttons-container"]'
    );
    if (!container) return null;
    return container.querySelector('[class*="control-bar-button"]:not([class*="menu"])');
  }

  /**
   * @param {Element} button
   * @param {Element} container
   */
  function placeSleepButton(button, container) {
    if (!button || !container) return;
    const menuButton = container.querySelector('[class*="control-bar-buttons-menu-button"]');
    const anime4k = document.getElementById(ANIME4K_BTN_ID);
    const cast = document.getElementById(CAST_BTN_ID);
    const contribute = document.getElementById(CONTRIBUTE_BTN_ID);
    const after =
      (anime4k && container.contains(anime4k) && anime4k) ||
      (cast && container.contains(cast) && cast) ||
      (contribute && container.contains(contribute) && contribute) ||
      null;
    if (after) {
      if (button.previousElementSibling !== after) {
        container.insertBefore(button, after.nextSibling);
      }
      return;
    }
    if (menuButton && container.contains(menuButton)) {
      if (button.nextElementSibling !== menuButton) {
        container.insertBefore(button, menuButton);
      }
      return;
    }
    if (button.parentNode !== container) container.appendChild(button);
  }

  /**
   * @param {Element|null} button
   * @param {Element} container
   * @returns {boolean}
   */
  function isSleepButtonPlaced(button, container) {
    if (!button || !container || !container.contains(button)) return false;
    const menuButton = container.querySelector('[class*="control-bar-buttons-menu-button"]');
    const anime4k = document.getElementById(ANIME4K_BTN_ID);
    const cast = document.getElementById(CAST_BTN_ID);
    const contribute = document.getElementById(CONTRIBUTE_BTN_ID);
    if (anime4k && container.contains(anime4k)) return button.previousElementSibling === anime4k;
    if (cast && container.contains(cast)) return button.previousElementSibling === cast;
    if (contribute && container.contains(contribute)) {
      return button.previousElementSibling === contribute;
    }
    if (menuButton && container.contains(menuButton)) {
      return button.nextElementSibling === menuButton;
    }
    return true;
  }

  function isStaleButton(button) {
    if (!button) return true;
    return !String(button.className || '').includes('control-bar-button');
  }

  function bindButtonHandler(button) {
    if (!button || button.dataset.mystremioSleepBound === '1') return;
    button.dataset.mystremioSleepBound = '1';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismissGuardUntil = 0;
      togglePanel();
    });
  }

  function refreshChipState(group, selected) {
    group?.querySelectorAll('button[data-value]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-value') === selected);
    });
  }

  function syncSteppers() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const hoursEl = panel.querySelector('[data-sleep-hours]');
    const minutesEl = panel.querySelector('[data-sleep-minutes]');
    if (hoursEl) hoursEl.textContent = String(prefs.hours).padStart(2, '0');
    if (minutesEl) minutesEl.textContent = String(prefs.minutes).padStart(2, '0');
    refreshChipState(panel.querySelector('[data-sleep-actions]'), prefs.action);
    refreshChipState(panel.querySelector('[data-sleep-triggers]'), prefs.trigger);
    const timeRow = panel.querySelector('[data-sleep-time]');
    if (timeRow) timeRow.hidden = prefs.trigger === 'episode';
  }

  function stepHours(delta) {
    if (armed) return;
    const max = prefs.trigger === 'clock' ? 23 : 12;
    prefs.hours = (prefs.hours + delta + max + 1) % (max + 1);
    savePrefs();
    syncSteppers();
  }

  function stepMinutes(delta) {
    if (armed) return;
    prefs.minutes = (prefs.minutes + delta + 60) % 60;
    savePrefs();
    syncSteppers();
  }

  function injectPlayerStyles() {
    let style = document.getElementById(PLAYER_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = PLAYER_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = `
      #${BTN_ID} {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        margin: 0 !important;
        padding: 0 !important;
        flex: none !important;
        position: relative !important;
        z-index: 2 !important;
        overflow: visible !important;
        pointer-events: auto !important;
      }
      #${BTN_ID} [class*="button-container"] { display: none !important; }
      #${BTN_ID} [class*="icon"],
      #${BTN_ID} svg {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: ${ICON_SIZE} !important;
        height: ${ICON_SIZE} !important;
        min-width: ${ICON_SIZE} !important;
        min-height: ${ICON_SIZE} !important;
        margin: 0 !important;
        padding: 0 !important;
        line-height: 0 !important;
      }
      #${BTN_ID} svg {
        flex: none !important;
        fill: none !important;
        stroke: currentColor !important;
        pointer-events: none !important;
      }
      #${BTN_ID}.active,
      #${BTN_ID}.is-armed {
        background: rgba(255, 255, 255, 0.12) !important;
      }
      #${BADGE_ID} {
        position: fixed;
        z-index: 2147483000;
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.28rem 0.55rem;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(42, 42, 46, 0.58);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.18);
        font-size: 0.75rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.02em;
        line-height: 1.2;
        white-space: nowrap;
        color: #fff;
        pointer-events: none;
      }
      #${BADGE_ID} .mystremio-sleep-badge-moon {
        width: 0.9rem;
        height: 0.9rem;
        flex: none;
        fill: none;
        stroke: currentColor;
      }
      #${BADGE_ID}[hidden] {
        display: none !important;
      }
      #${PANEL_ID} {
        position: fixed;
        z-index: 2147483000;
        width: min(18rem, calc(100vw - 2rem));
        padding: 0.65rem 0.75rem 0.75rem;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(42, 42, 46, 0.58);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.18);
        color: #fff;
        font-family: inherit;
        font-size: 0.78rem;
        line-height: 1.2;
        display: none;
        pointer-events: auto;
      }
      #${PANEL_ID}.open { display: block; }
      #${PANEL_ID} .mystremio-sleep-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        margin-bottom: 0.55rem;
      }
      #${PANEL_ID} .mystremio-sleep-title {
        font-size: 0.82rem;
        font-weight: 600;
      }
      #${PANEL_ID} .mystremio-sleep-close {
        border: none;
        background: transparent;
        color: rgba(255, 255, 255, 0.55);
        font-size: 1rem;
        line-height: 1;
        cursor: pointer;
        width: 1.2rem;
        height: 1.2rem;
        border-radius: 6px;
      }
      #${PANEL_ID} .mystremio-sleep-close:hover {
        background: rgba(255, 255, 255, 0.08);
        color: rgba(255, 255, 255, 0.9);
      }
      #${PANEL_ID} .mystremio-sleep-label {
        display: block;
        margin: 0.45rem 0 0.3rem;
        color: rgba(255, 255, 255, 0.62);
        font-size: 0.68rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      #${PANEL_ID} .mystremio-sleep-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
      }
      #${PANEL_ID} .mystremio-sleep-chips button {
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 999px;
        padding: 0.32rem 0.62rem;
        color: rgba(255, 255, 255, 0.88);
        background: rgba(255, 255, 255, 0.08);
        cursor: pointer;
        font-size: 0.72rem;
        font-weight: 600;
      }
      #${PANEL_ID} .mystremio-sleep-chips button.is-active {
        background: rgba(255, 255, 255, 0.28);
        border-color: rgba(255, 255, 255, 0.4);
      }
      #${PANEL_ID}.is-armed .mystremio-sleep-chips button,
      #${PANEL_ID}.is-armed .mystremio-sleep-stepper button {
        opacity: 0.4;
        pointer-events: none;
        cursor: default;
      }
      #${PANEL_ID} [data-sleep-time] {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.45rem;
        margin: 0.7rem 0 0.35rem;
      }
      #${PANEL_ID} [data-sleep-time][hidden] { display: none !important; }
      #${PANEL_ID} .mystremio-sleep-stepper {
        display: flex;
        align-items: center;
        gap: 0.25rem;
      }
      #${PANEL_ID} .mystremio-sleep-stepper button {
        width: 1.55rem;
        height: 1.55rem;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
        cursor: pointer;
        font-size: 0.95rem;
        line-height: 1;
      }
      #${PANEL_ID} .mystremio-sleep-stepper button:hover {
        background: rgba(255, 255, 255, 0.18);
      }
      #${PANEL_ID} .mystremio-sleep-stepper span {
        min-width: 1.6rem;
        text-align: center;
        font-variant-numeric: tabular-nums;
        font-weight: 700;
        font-size: 0.95rem;
      }
      #${PANEL_ID} .mystremio-sleep-colon {
        font-weight: 700;
        opacity: 0.7;
      }
      #${PANEL_ID} [data-sleep-start] {
        width: 100%;
        margin-top: 0.65rem;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 10px;
        padding: 0.45rem 0.7rem;
        background: rgba(255, 255, 255, 0.14);
        color: #fff;
        font-weight: 700;
        cursor: pointer;
      }
      #${PANEL_ID} [data-sleep-start]:hover {
        background: rgba(255, 255, 255, 0.22);
      }
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] { cursor: default !important; }
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="nav-bar-layer"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="control-bar-layer"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="menu-layer"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="side-drawer-button-layer"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="seek-bar-container"] {
        opacity: 1 !important;
        visibility: visible !important;
        pointer-events: auto !important;
      }
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] > [class*="layer-"]:not([class*="control"]):not([class*="nav-bar"]):not([class*="menu"]):not([class*="side-drawer"]):not([class*="background"]):not([class*="buffering"]),
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="video-container"],
      html.${OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="seek-bar-container"] [class*="slider-container"] {
        pointer-events: none !important;
      }
      html.${ARMED_CLASS} [class*="next-video-popup-container"] {
        display: none !important;
      }
    `;
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel && panel.dataset.mystremioSleepVersion !== PANEL_VERSION) {
      panel.remove();
      panel = null;
    }
    if (panel) {
      syncSteppers();
      syncPanelArmedState();
      return panel;
    }

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.dataset.mystremioSleepVersion = PANEL_VERSION;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Sleep Timer');
    panel.innerHTML = `
      <div class="mystremio-sleep-header">
        <span class="mystremio-sleep-title">Sleep Timer</span>
        <button type="button" class="mystremio-sleep-close" data-sleep-close aria-label="Close">×</button>
      </div>
      <span class="mystremio-sleep-label">Action</span>
      <div class="mystremio-sleep-chips" data-sleep-actions role="group" aria-label="Action"></div>
      <span class="mystremio-sleep-label">When</span>
      <div class="mystremio-sleep-chips" data-sleep-triggers role="group" aria-label="Trigger"></div>
      <div data-sleep-time>
        <div class="mystremio-sleep-stepper">
          <button type="button" data-h-minus aria-label="Decrease hours">−</button>
          <span data-sleep-hours>00</span>
          <button type="button" data-h-plus aria-label="Increase hours">+</button>
        </div>
        <span class="mystremio-sleep-colon">:</span>
        <div class="mystremio-sleep-stepper">
          <button type="button" data-m-minus aria-label="Decrease minutes">−</button>
          <span data-sleep-minutes>30</span>
          <button type="button" data-m-plus aria-label="Increase minutes">+</button>
        </div>
      </div>
      <button type="button" data-sleep-start>Start</button>
    `;

    const actions = panel.querySelector('[data-sleep-actions]');
    for (const option of ACTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = option.label;
      btn.setAttribute('data-value', option.value);
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (armed) return;
        prefs.action = option.value;
        savePrefs();
        syncSteppers();
      });
      actions.appendChild(btn);
    }
    const triggers = panel.querySelector('[data-sleep-triggers]');
    for (const option of TRIGGERS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = option.label;
      btn.setAttribute('data-value', option.value);
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (armed) return;
        prefs.trigger = option.value;
        prefs = normalizePrefs(prefs);
        savePrefs();
        syncSteppers();
        syncPanelArmedState();
      });
      triggers.appendChild(btn);
    }
    panel.querySelector('[data-h-minus]')?.addEventListener('click', (event) => {
      stopEvent(event);
      stepHours(-1);
    });
    panel.querySelector('[data-h-plus]')?.addEventListener('click', (event) => {
      stopEvent(event);
      stepHours(1);
    });
    panel.querySelector('[data-m-minus]')?.addEventListener('click', (event) => {
      stopEvent(event);
      stepMinutes(-1);
    });
    panel.querySelector('[data-m-plus]')?.addEventListener('click', (event) => {
      stopEvent(event);
      stepMinutes(1);
    });
    panel.querySelector('[data-sleep-start]')?.addEventListener('click', (event) => {
      stopEvent(event);
      if (armed) cancelTimer('user');
      else armTimer();
    });
    panel.querySelector('[data-sleep-close]')?.addEventListener('click', (event) => {
      stopEvent(event);
      closePanel();
    });
    document.body.appendChild(panel);
    syncSteppers();
    syncPanelArmedState();
    return panel;
  }

  function positionPanel() {
    const panel = document.getElementById(PANEL_ID);
    const button = document.getElementById(BTN_ID);
    if (!panel || !button) return;
    const panelWidth = panel.offsetWidth || 288;
    const panelHeight = panel.offsetHeight || 220;
    const margin = 14;
    const seekBar = document.querySelector(
      '[class*="player-container"] [class*="seek-bar-container"]'
    );
    const rect = button.getBoundingClientRect();
    const left = Math.min(
      Math.max(margin, rect.left + rect.width / 2 - panelWidth / 2),
      window.innerWidth - panelWidth - margin
    );
    panel.style.left = `${left}px`;
    panel.style.right = 'auto';
    if (seekBar) {
      const seekRect = seekBar.getBoundingClientRect();
      const top = seekRect.top - panelHeight - margin;
      panel.style.top = `${top >= margin ? top : margin}px`;
      panel.style.bottom = 'auto';
    } else {
      panel.style.top = 'auto';
      panel.style.bottom = `${margin + 120}px`;
    }
  }

  function lockPlayerOverlay() {
    document.documentElement.classList.add(OVERLAY_LOCK_CLASS);
    const playerContainer = document.querySelector('[class*="player-container"]');
    if (playerContainer) {
      playerContainer.classList.forEach((className) => {
        if (className.includes('overlayHidden')) {
          playerContainer.classList.remove(className);
        }
      });
    }
  }

  function unlockPlayerOverlay() {
    document.documentElement.classList.remove(OVERLAY_LOCK_CLASS);
    if (overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
    }
  }

  function startOverlayKeepAlive() {
    if (overlayObserver) overlayObserver.disconnect();
    const playerContainer = document.querySelector('[class*="player-container"]');
    if (!playerContainer || typeof MutationObserver === 'undefined') return;
    overlayObserver = new MutationObserver(() => {
      if (!panelOpen) return;
      playerContainer.classList.forEach((className) => {
        if (className.includes('overlayHidden')) {
          playerContainer.classList.remove(className);
        }
      });
    });
    overlayObserver.observe(playerContainer, { attributes: true, attributeFilter: ['class'] });
  }

  function isSleepButtonTarget(target) {
    return target instanceof Element && Boolean(target.closest(`#${BTN_ID}`));
  }

  function isInteractivePlayerChrome(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest(
        `[id="${PANEL_ID}"], [id="${BTN_ID}"], [class*="nav-bar"], [class*="menu-layer"], [class*="side-drawer-button-layer"]`
      )
    );
  }

  function isOtherControlBarTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target.closest(`#${BTN_ID}`) || target.closest(`#${PANEL_ID}`)) return false;
    return Boolean(
      target.closest(
        `[class*="player-container"] [class*="control-bar-button"], [class*="player-container"] [class*="volume-slider"]`
      )
    );
  }

  function isOutsidePointer(event) {
    const panel = document.getElementById(PANEL_ID);
    const button = document.getElementById(BTN_ID);
    if (!panelOpen || !panel) return false;
    const target = event.target;
    if (!(target instanceof Node)) return false;
    if (panel.contains(target) || (button && button.contains(target))) return false;
    return true;
  }

  function handleOutsidePointer(event) {
    if (isSleepButtonTarget(event.target)) {
      dismissGuardUntil = 0;
      return;
    }
    if (Date.now() < dismissGuardUntil) {
      stopEvent(event);
      return;
    }
    if (!isOutsidePointer(event)) return;
    if (isOtherControlBarTarget(event.target) || isInteractivePlayerChrome(event.target)) {
      closePanel();
      return;
    }
    dismissGuardUntil = Date.now() + 500;
    stopEvent(event);
    closePanel();
  }

  function bindPanelHandlers() {
    if (outsideHandler) return;
    outsideHandler = (event) => handleOutsidePointer(event);
    document.addEventListener('pointerdown', outsideHandler, true);
    document.addEventListener('mousedown', outsideHandler, true);
    document.addEventListener('click', outsideHandler, true);
    keyHandler = (event) => {
      if (!panelOpen) return;
      if (event.key === 'Escape') {
        stopEvent(event);
        closePanel();
      }
    };
    document.addEventListener('keydown', keyHandler);
  }

  function unbindPanelHandlers() {
    if (outsideHandler) {
      document.removeEventListener('pointerdown', outsideHandler, true);
      document.removeEventListener('mousedown', outsideHandler, true);
      document.removeEventListener('click', outsideHandler, true);
      outsideHandler = null;
    }
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
  }

  function openPanel() {
    ensurePanel();
    panelOpen = true;
    document.getElementById(PANEL_ID)?.classList.add('open');
    document.getElementById(BTN_ID)?.classList.add('active');
    lockPlayerOverlay();
    startOverlayKeepAlive();
    positionPanel();
    bindPanelHandlers();
    syncSteppers();
    syncPanelArmedState();
  }

  function closePanel() {
    panelOpen = false;
    document.getElementById(PANEL_ID)?.classList.remove('open');
    document.getElementById(BTN_ID)?.classList.remove('active');
    unlockPlayerOverlay();
    unbindPanelHandlers();
  }

  function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
  }

  function removePlayerUi() {
    closePanel();
    document.getElementById(BTN_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
    const badge = document.getElementById(BADGE_ID);
    if (badge) badge.hidden = true;
  }

  function ensureButton() {
    if (!isPluginEnabled() || !isPlayerRoute()) {
      removePlayerUi();
      return;
    }

    injectPlayerStyles();
    hookMpvEnded();
    const container = document.querySelector(
      '[class*="player-container"] [class*="control-bar-buttons-container"]'
    );
    if (!container) return;

    let button = document.getElementById(BTN_ID);
    if (button && isStaleButton(button)) {
      button.remove();
      button = null;
    }

    if (!button) {
      const template = getButtonTemplate();
      if (template) {
        button = template.cloneNode(true);
        button.classList.remove('disabled');
        button.removeAttribute('tabindex');
        button.querySelectorAll('[class*="button-container"]').forEach((el) => el.remove());
      } else {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'control-bar-button';
      }
      button.id = BTN_ID;
      button.title = 'Sleep Timer';
      button.setAttribute('aria-label', 'Sleep Timer');
      replaceButtonIcon(button);
      placeSleepButton(button, container);
    } else if (!isSleepButtonPlaced(button, container)) {
      placeSleepButton(button, container);
    }

    bindButtonHandler(button);
    ensurePanel();
    syncBadge();
    if (panelOpen) positionPanel();
  }

  function needsLayoutEnsure() {
    if (!isPluginEnabled() || !isPlayerRoute()) return false;
    const button = document.getElementById(BTN_ID);
    if (!button) return true;
    const container = document.querySelector(
      '[class*="player-container"] [class*="control-bar-buttons-container"]'
    );
    if (!container || !container.contains(button)) return true;
    if (!isSleepButtonPlaced(button, container)) return true;
    return button.dataset.mystremioSleepBound !== '1';
  }

  function scheduleEnsure() {
    if (!needsLayoutEnsure()) return;
    if (ensureTimer) window.clearTimeout(ensureTimer);
    ensureTimer = window.setTimeout(() => {
      ensureTimer = null;
      ensureButton();
    }, 150);
  }

  function bindLayoutObserver() {
    if (layoutObserver) return;
    const target =
      document.querySelector('[class*="player-container"]') || document.documentElement;
    layoutObserver = new MutationObserver(() => {
      scheduleEnsure();
    });
    layoutObserver.observe(target, { childList: true, subtree: true });
  }

  function stopRetryLoop() {
    if (retryTimer) {
      window.clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  function stopLayoutObserver() {
    if (layoutObserver) {
      layoutObserver.disconnect();
      layoutObserver = null;
    }
    if (ensureTimer) {
      window.clearTimeout(ensureTimer);
      ensureTimer = null;
    }
    stopRetryLoop();
  }

  function syncLayoutWorkToChrome() {
    if (!isPlayerRoute() || !isPluginEnabled()) {
      stopLayoutObserver();
      return;
    }
    bindLayoutObserver();
    scheduleEnsure();
  }

  function bindChromeIdleWatcher() {
    if (chromeIdleWatcher || typeof MutationObserver === 'undefined') return;
    const target = document.querySelector('[class*="player-container"]');
    if (!target) return;
    chromeIdleWatcher = new MutationObserver(() => {
      syncLayoutWorkToChrome();
      positionBadge();
    });
    chromeIdleWatcher.observe(target, { attributes: true, attributeFilter: ['class'] });
  }

  function stopChromeIdleWatcher() {
    if (chromeIdleWatcher) {
      chromeIdleWatcher.disconnect();
      chromeIdleWatcher = null;
    }
  }

  function startRetryLoop() {
    if (retryTimer || !isPlayerRoute() || !isPluginEnabled()) return;
    let ticks = 0;
    retryTimer = window.setInterval(() => {
      if (!isPlayerRoute() || !isPluginEnabled()) {
        stopRetryLoop();
        return;
      }
      bindChromeIdleWatcher();
      if (needsLayoutEnsure()) ensureButton();
      else positionBadge();
      ticks += 1;
      if (ticks >= 20) stopRetryLoop();
    }, 250);
  }

  function onRouteChange() {
    if (!isPlayerRoute()) {
      if (armed && prefs.trigger === 'episode') cancelTimer('leave-player');
      removePlayerUi();
      stopLayoutObserver();
      stopChromeIdleWatcher();
      return;
    }
    bindChromeIdleWatcher();
    syncLayoutWorkToChrome();
    startRetryLoop();
    ensureButton();
  }

  function onStreamStarted() {
    if (armed && prefs.trigger === 'episode' && !firing) {
      cancelTimer('new-stream');
    }
    scheduleEnsure();
    if (isPlayerRoute()) startRetryLoop();
  }

  function unload() {
    if (armed && prefs.trigger === 'episode') cancelTimer('unload');
    removePlayerUi();
    stopLayoutObserver();
    stopChromeIdleWatcher();
    document.getElementById(PLAYER_STYLE_ID)?.remove();
    document.getElementById(BADGE_ID)?.remove();
    document.documentElement.classList.remove(OVERLAY_LOCK_CLASS);
    if (!armed) document.documentElement.classList.remove(ARMED_CLASS);
  }

  async function initialize() {
    loadPrefs();
    await loadSettingsFromApi();
    await registerSettingsUi();
    wireSettingsListener();
    persistPluginSettings();
  }

  function bootAfterSettings() {
    initialize().then(() => {
      scheduleEnsure();
      if (isPlayerRoute()) {
        bindChromeIdleWatcher();
        syncLayoutWorkToChrome();
        startRetryLoop();
      }
    });
  }

  if (!routeHandler) {
    routeHandler = () => onRouteChange();
    document.addEventListener('stremio-custom-route-change', routeHandler);
  }
  if (!streamHandler) {
    streamHandler = () => onStreamStarted();
    document.addEventListener('stremio-custom-stream-started', streamHandler);
  }
  document.addEventListener('stremio-custom-bootstrap-ready', bootAfterSettings);
  bootAfterSettings();
  document.addEventListener('stremio-custom-playback-stopped', () => {
    if (armed && prefs.trigger === 'episode') cancelTimer('playback-stopped');
    removePlayerUi();
  });
  window.addEventListener('resize', () => {
    if (panelOpen) positionPanel();
    positionBadge();
  });

  window.__stremioSleepTimerUnload = unload;
  window.__stremioSleepTimerEnsure = ensureButton;
  window.__stremioSleepTimerPluginReady = PLUGIN_VERSION;

  loadPrefs();
  scheduleEnsure();
  if (isPlayerRoute()) {
    bindChromeIdleWatcher();
    syncLayoutWorkToChrome();
    startRetryLoop();
  }

  console.info(`${LOG_PREFIX} Plugin loaded.`);
})();
