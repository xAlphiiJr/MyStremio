(function () {
  'use strict';

  if (window.__stremioCustomScrollRestore) return;
  window.__stremioCustomScrollRestore = true;

  const RATIO_KEY = 'stremio-custom-board-scroll-ratio';
  const ANCHOR_KEY = 'stremio-custom-board-scroll-anchor';
  const SELECTED_ANCHOR_KEY = 'stremio-custom-board-selected-anchor';

  let savedScrollRatio = 0;
  let savedAnchorKey = '';
  let savedSelectedAnchorKey = '';
  let lastHash = location.hash;
  let restoreUntil = 0;
  let userOverrodeRestore = false;

  function isBoardHash(hash) {
    const h = hash || '';
    return !h || h === '#/' || h === '#' || h.includes('/board');
  }

  function isBoardRoute() {
    return isBoardHash(location.hash);
  }

  function getBoardScrollEl() {
    return document.querySelector('[class*="board-content"]');
  }

  function getItemAnchorKey(item) {
    if (!item) return '';
    return (
      item.getAttribute('href') ||
      item.querySelector('a')?.getAttribute('href') ||
      item.dataset?.id ||
      item.textContent?.trim()?.slice(0, 80) ||
      ''
    );
  }

  function getScrollRatio(el) {
    if (!el) return 0;
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll <= 0) return 0;
    return Math.max(0, Math.min(1, el.scrollTop / maxScroll));
  }

  function persistScroll(el) {
    if (!el) return;
    savedScrollRatio = getScrollRatio(el);

    const containerRect = el.getBoundingClientRect();
    const items = el.querySelectorAll('[class*="meta-item"]');
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (rect.bottom > containerRect.top + 8 && rect.top < containerRect.bottom - 8) {
        savedAnchorKey = getItemAnchorKey(item);
        break;
      }
    }

    try {
      sessionStorage.setItem(RATIO_KEY, String(savedScrollRatio));
      sessionStorage.setItem(ANCHOR_KEY, savedAnchorKey || '');
      sessionStorage.setItem(SELECTED_ANCHOR_KEY, savedSelectedAnchorKey || '');
    } catch (_) {}
  }

  function loadPersistedScroll() {
    try {
      const ratio = Number(sessionStorage.getItem(RATIO_KEY));
      if (Number.isFinite(ratio) && ratio >= 0) {
        savedScrollRatio = Math.max(0, Math.min(1, ratio));
      }
      savedAnchorKey = sessionStorage.getItem(ANCHOR_KEY) || '';
      savedSelectedAnchorKey = sessionStorage.getItem(SELECTED_ANCHOR_KEY) || '';
    } catch (_) {}
  }

  function captureScroll() {
    if (!isBoardRoute()) return;
    persistScroll(getBoardScrollEl());
  }

  function applyScrollRatio(el) {
    if (!el || userOverrodeRestore) return;
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll <= 0) {
      el.scrollTop = 0;
      return;
    }
    el.scrollTop = Math.round(savedScrollRatio * maxScroll);
  }

  function restoreByAnchor(el) {
    if (!el || userOverrodeRestore) return false;
    const preferred = savedSelectedAnchorKey || savedAnchorKey;
    if (!preferred) return false;
    const items = el.querySelectorAll('[class*="meta-item"]');
    for (const item of items) {
      if (getItemAnchorKey(item) === preferred) {
        item.scrollIntoView({ block: 'center', behavior: 'instant' in window ? 'instant' : 'auto' });
        return true;
      }
    }
    return false;
  }

  function cancelRestore() {
    userOverrodeRestore = true;
    restoreUntil = 0;
    window.__stremioCustomScrollRestoreActive = false;
  }

  function restoreScroll(attempt) {
    if (!isBoardRoute() || userOverrodeRestore) return;
    if (Date.now() > restoreUntil && attempt > 8) return;

    const el = getBoardScrollEl();
    if (!el) {
      if (attempt < 60) {
        setTimeout(() => restoreScroll(attempt + 1), 40 + attempt * 15);
      }
      return;
    }

    window.__stremioCustomScrollRestoreActive = true;

    if (!restoreByAnchor(el)) {
      applyScrollRatio(el);
    }

    requestAnimationFrame(() => {
      if (userOverrodeRestore) return;
      if (!restoreByAnchor(el)) {
        applyScrollRatio(el);
      }
      if (attempt < 30 && Date.now() <= restoreUntil) {
        setTimeout(() => restoreScroll(attempt + 1), 60 + attempt * 40);
      }
    });
  }

  function scheduleRestore() {
    userOverrodeRestore = false;
    if (savedScrollRatio < 0.02 && !savedAnchorKey && !savedSelectedAnchorKey) {
      window.__stremioCustomScrollRestoreActive = false;
      return;
    }

    restoreUntil = Date.now() + 2500;
    window.__stremioCustomScrollRestoreActive = true;
    restoreScroll(0);
    setTimeout(() => restoreScroll(10), 300);
    setTimeout(() => restoreScroll(20), 900);
    setTimeout(() => {
      window.__stremioCustomScrollRestoreActive = false;
    }, 2600);
  }

  function ensureBoardObserver() {
    const el = getBoardScrollEl();
    if (!el || el.__stremioCustomScrollObserved) return;
    el.__stremioCustomScrollObserved = true;

    const observer = new MutationObserver(() => {
      if (!isBoardRoute() || Date.now() > restoreUntil || userOverrodeRestore) return;
      if (!restoreByAnchor(el)) {
        applyScrollRatio(el);
      }
    });
    observer.observe(el, { childList: true, subtree: true });
  }

  function onUserScrollIntent() {
    if (!isBoardRoute()) return;
    cancelRestore();
  }

  document.addEventListener('wheel', onUserScrollIntent, { capture: true, passive: true });
  document.addEventListener('touchmove', onUserScrollIntent, { capture: true, passive: true });
  document.addEventListener('keydown', (event) => {
    if (!isBoardRoute()) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      onUserScrollIntent();
    }
  });

  document.addEventListener(
    'scroll',
    (event) => {
      if (!isBoardRoute()) return;
      const target = event.target;
      if (target && String(target.className || '').includes('board-content')) {
        if (Date.now() <= restoreUntil && !userOverrodeRestore) {
          const maxScroll = target.scrollHeight - target.clientHeight;
          const targetTop = Math.round(savedScrollRatio * maxScroll);
          if (Math.abs(target.scrollTop - targetTop) > 24) {
            onUserScrollIntent();
          }
        }
        persistScroll(target);
      }
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    'click',
    (event) => {
      if (!isBoardRoute()) return;
      const metaItem = event.target?.closest?.('[class*="meta-item"]');
      if (metaItem) {
        savedSelectedAnchorKey = getItemAnchorKey(metaItem);
        try {
          sessionStorage.setItem(SELECTED_ANCHOR_KEY, savedSelectedAnchorKey || '');
        } catch (_) {}
        const el = getBoardScrollEl();
        if (el) persistScroll(el);
      }
    },
    true
  );

  window.addEventListener('hashchange', () => {
    if (isBoardHash(lastHash)) {
      captureScroll();
    }
    lastHash = location.hash;
    if (isBoardRoute()) {
      loadPersistedScroll();
      ensureBoardObserver();
      scheduleRestore();
    } else {
      cancelRestore();
    }
  });

  window.addEventListener('popstate', () => {
    if (isBoardRoute()) {
      loadPersistedScroll();
      ensureBoardObserver();
      scheduleRestore();
    }
  });

  loadPersistedScroll();
  if (isBoardRoute()) {
    ensureBoardObserver();
  }

  console.info('[StremioCustom] Board scroll restore active.');
})();
