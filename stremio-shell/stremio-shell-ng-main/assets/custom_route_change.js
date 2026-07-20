(function () {
  'use strict';

  /**
   * Reliable SPA route-change bus for Stremio's HashRouter.
   *
   * React Router updates the hash via history.pushState/replaceState, which does
   * not fire the native `hashchange` event. Shell leave/enter cleanup must listen
   * to this custom event instead (or in addition) so player transparency and
   * playback state reset when leaving `#/player`.
   */

  if (window.self !== window.top) return;
  if (window.__stremioCustomRouteChange) return;
  window.__stremioCustomRouteChange = true;

  const EVENT_NAME = 'stremio-custom-route-change';

  let lastHash = location.hash || '';
  let notifyScheduled = false;

  /**
   * @param {string} prev
   * @param {string} next
   * @param {string} source
   */
  function dispatchRouteChange(prev, next, source) {
    try {
      document.dispatchEvent(
        new CustomEvent(EVENT_NAME, {
          detail: { prev, next, source },
        })
      );
    } catch (err) {
      console.warn('[StremioCustom] route-change dispatch failed:', err);
    }
  }

  /**
   * Notify listeners when location.hash changed since the last check.
   * @param {string} source
   */
  function notifyIfHashChanged(source) {
    const next = location.hash || '';
    if (next === lastHash) return;
    const prev = lastHash;
    lastHash = next;
    dispatchRouteChange(prev, next, source);
  }

  /**
   * Coalesce bursty history updates into one microtask notification.
   * @param {string} source
   */
  function scheduleNotify(source) {
    if (notifyScheduled) return;
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      notifyIfHashChanged(source);
    });
  }

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = function stremioCustomPushState(state, title, url) {
    const result = originalPushState(state, title, url);
    scheduleNotify('pushState');
    return result;
  };

  history.replaceState = function stremioCustomReplaceState(state, title, url) {
    const result = originalReplaceState(state, title, url);
    scheduleNotify('replaceState');
    return result;
  };

  window.addEventListener('popstate', () => scheduleNotify('popstate'));
  window.addEventListener('hashchange', () => scheduleNotify('hashchange'));

  console.info('[StremioCustom] Route-change bus ready.');
})();
