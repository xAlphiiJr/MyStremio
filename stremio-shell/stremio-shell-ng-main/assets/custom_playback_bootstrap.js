(function () {
  if (window.__stremioCustomPlaybackBootstrap) return;
  window.__stremioCustomPlaybackBootstrap = true;

  let shellInitSent = false;
  let fullscreenActive = false;
  let fullscreenObserver = null;
  let fullscreenStateInitialized = false;
  let webviewMessageHookInstalled = false;

  function isFullscreenControl(element) {
    return Boolean(
      element?.closest?.(
        [
          'button[title*="ullscreen" i]',
          'button[aria-label*="ullscreen" i]',
          'button[title*="ollbild" i]',
          'button[aria-label*="ollbild" i]',
          '[data-testid*="fullscreen" i]',
          '[class*="fullscreen"][role="button"]',
        ].join(', ')
      )
    );
  }

  function ensureShellHandshake() {
    if (!window.chrome?.webview?.postMessage) return false;
    try {
      window.chrome.webview.postMessage(JSON.stringify({ id: 0, type: 3 }));
      if (typeof initShellComm === 'function') initShellComm();
      if (!shellInitSent) {
        shellInitSent = true;
        console.info('[StremioCustom] Shell handshake requested');
      }
      return true;
    } catch (error) {
      console.warn('[StremioCustom] Shell handshake failed:', error);
      return false;
    }
  }

  function canReportAppReady() {
    // Wait for MyStremio bootstrap + plugins — early app-ready hides splash on the BAD path.
    if (!window.__stremioCustomBootstrapReady) return false;
    const app = document.getElementById('app');
    return Boolean(app && app.childElementCount > 0);
  }

  function ensureShellAppReady() {
    if (window.__stremioShellAppReadySent) return;
    if (!canReportAppReady()) return;
    try {
      ensureShellHandshake();
      const payload = JSON.stringify({ id: Date.now(), args: ['app-ready'] });
      if (window.chrome?.webview?.postMessage) {
        window.chrome.webview.postMessage(payload);
      } else if (window.qt?.webChannelTransport?.send) {
        window.qt.webChannelTransport.send(payload);
      } else {
        return;
      }
      window.__stremioShellAppReadySent = true;
      console.info('[StremioCustom] app-ready fallback sent (after bootstrap)');
    } catch (error) {
      console.warn('[StremioCustom] app-ready fallback failed:', error);
    }
  }

  function scheduleShellAppReadyFallback() {
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      ensureShellAppReady();
      if (window.__stremioShellAppReadySent || attempts >= 30) {
        window.clearInterval(timer);
      }
    }, 500);
  }

  window.__stremioCustomScheduleShellAppReadyFallback = scheduleShellAppReadyFallback;

  function inferFullscreenFromUi() {
    const controls = document.querySelectorAll(
      [
        'button[title*="ullscreen" i]',
        'button[aria-label*="ullscreen" i]',
        'button[title*="ollbild" i]',
        'button[aria-label*="ollbild" i]',
        '[data-testid*="fullscreen" i]',
        '[class*="fullscreen"][role="button"]',
      ].join(', ')
    );
    for (const control of controls) {
      const title = String(control.getAttribute('title') || '').toLowerCase();
      const aria = String(control.getAttribute('aria-label') || '').toLowerCase();
      const text = `${title} ${aria}`;
      if (text.includes('exit fullscreen mode') || text.includes('fullscreen deaktivieren')) {
        return true;
      }
      if (text.includes('enter fullscreen mode') || text.includes('fullscreen aktivieren')) {
        return false;
      }
    }
    return null;
  }

  function parseWebViewPayload(event) {
    const candidates = [event?.data, event?.detail, event];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (typeof candidate === 'string') {
        try {
          const parsed = JSON.parse(candidate);
          if (typeof parsed === 'string') {
            try {
              return JSON.parse(parsed);
            } catch (_) {
              return null;
            }
          }
          return parsed;
        } catch (_) {
          continue;
        }
      }
      if (typeof candidate === 'object') return candidate;
    }
    return null;
  }

  function updateFullscreenButtonUi() {
    const isActive = Boolean(fullscreenActive);
    const label = isActive ? 'Exit Fullscreen Mode' : 'Enter Fullscreen Mode';
    const buttons = document.querySelectorAll(
      [
        'button[title*="ullscreen" i]',
        'button[aria-label*="ullscreen" i]',
        'button[title*="ollbild" i]',
        'button[aria-label*="ollbild" i]',
        '[data-testid*="fullscreen" i]',
        '[class*="fullscreen"][role="button"]',
      ].join(', ')
    );
    buttons.forEach((button) => {
      if (!(button instanceof HTMLElement)) return;
      button.setAttribute('title', label);
      button.setAttribute('aria-label', label);
      button.dataset.fullscreenState = isActive ? 'on' : 'off';
    });
  }

  function syncFullscreenState(next) {
    fullscreenActive = Boolean(next);
    fullscreenStateInitialized = true;
    updateFullscreenButtonUi();
  }

  let shellFullscreenMsgId = 1;

  /**
   * Ask the native shell to enter/leave monitor fullscreen (WS_OVERLAPPEDWINDOW clear).
   * Must not rely on HTML ContainsFullScreenElement alone — that left caption buttons visible.
   * @param {boolean} enabled
   */
  function requestShellFullscreen(enabled) {
    const payload = JSON.stringify({
      id: shellFullscreenMsgId++,
      args: ['win-set-visibility', { fullscreen: Boolean(enabled) }],
    });
    try {
      if (window.chrome?.webview?.postMessage) {
        window.chrome.webview.postMessage(payload);
        return;
      }
      if (window.qt?.webChannelTransport?.send) {
        window.qt.webChannelTransport.send(payload);
      }
    } catch (error) {
      console.warn('[StremioCustom] win-set-visibility failed:', error);
    }
  }

  function extractRpcArgs(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (Array.isArray(payload.args)) return payload.args;
    const nested = payload.data;
    if (!nested) return null;
    if (Array.isArray(nested)) return nested;
    if (Array.isArray(nested.args)) return nested.args;
    if (typeof nested === 'string') {
      try {
        const parsed = JSON.parse(nested);
        if (Array.isArray(parsed?.args)) return parsed.args;
      } catch (_) {}
    }
    return null;
  }

  /**
   * Shell `win-visibility-changed` is the source of truth for fullscreen UI.
   * Optimistic local toggles are reconciled here so desync cannot stick.
   * @param {MessageEvent|object} event
   */
  function handleIncomingFullscreenMessage(event) {
    const payload = parseWebViewPayload(event);
    const args = extractRpcArgs(payload);
    if (!Array.isArray(args) || args.length < 2) return;
    if (args[0] !== 'win-visibility-changed') return;
    syncFullscreenState(Boolean(args[1]?.isFullscreen));
  }

  function ensureFullscreenMessageHook() {
    if (!webviewMessageHookInstalled && window.chrome?.webview?.addEventListener) {
      webviewMessageHookInstalled = true;
      window.chrome.webview.addEventListener('message', handleIncomingFullscreenMessage);
    }

    const transport = window.qt?.webChannelTransport;
    if (!transport) return;
    if (transport.onmessage && transport.onmessage.__stremioCustomFullscreenWrapped) return;

    const previous = transport.onmessage;
    const wrapped = function (ev) {
      try {
        handleIncomingFullscreenMessage(ev);
      } catch (_) {}
      if (typeof previous === 'function') {
        return previous.call(this, ev);
      }
      return undefined;
    };
    wrapped.__stremioCustomFullscreenWrapped = true;
    transport.onmessage = wrapped;
  }

  function ensureFullscreenUiSync() {
    if (!fullscreenStateInitialized) {
      const inferred = inferFullscreenFromUi();
      if (inferred != null) {
        fullscreenActive = inferred;
        fullscreenStateInitialized = true;
      }
    }
    updateFullscreenButtonUi();
    if (!fullscreenObserver && typeof MutationObserver !== 'undefined') {
      fullscreenObserver = new MutationObserver(() => {
        updateFullscreenButtonUi();
      });
      fullscreenObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'title', 'aria-label'],
      });
    }
  }

  ensureShellHandshake();
  ensureFullscreenMessageHook();
  ensureFullscreenUiSync();
  if (typeof window.__stremioCustomPlayerTransparencyEnsure === 'function') {
    window.__stremioCustomPlayerTransparencyEnsure();
  }

  window.addEventListener('hashchange', () => {
    ensureShellHandshake();
    ensureFullscreenMessageHook();
    ensureFullscreenUiSync();
    if (typeof window.__stremioCustomPlayerTransparencyEnsure === 'function') {
      window.__stremioCustomPlayerTransparencyEnsure();
    }
  });
  window.addEventListener('load', ensureShellHandshake);
  window.addEventListener('load', ensureFullscreenUiSync);
  /**
   * Block stock webui handlers so only one `win-set-visibility` RPC is sent.
   * @param {Event} event
   */
  function stopStockFullscreenHandlers(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
  }

  document.addEventListener(
    'click',
    (event) => {
      if (!isFullscreenControl(event.target)) return;
      stopStockFullscreenHandlers(event);
      const expected = !fullscreenActive;
      // Optimistic UI; shell confirmation via win-visibility-changed reconciles.
      syncFullscreenState(expected);
      requestShellFullscreen(expected);
      window.setTimeout(() => ensureFullscreenUiSync(), 120);
    },
    true
  );
  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function isNavDigitKey(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return false;
    if (event.code && String(event.code).startsWith('Numpad')) return false;
    if (event.location === 3) return false;
    return event.key >= '1' && event.key <= '6';
  }

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'F11') {
        stopStockFullscreenHandlers(event);
        const expected = !fullscreenActive;
        syncFullscreenState(expected);
        requestShellFullscreen(expected);
        window.setTimeout(() => ensureFullscreenUiSync(), 120);
        return;
      }
      if (event.key === 'Escape' && fullscreenActive) {
        stopStockFullscreenHandlers(event);
        syncFullscreenState(false);
        requestShellFullscreen(false);
        window.setTimeout(() => ensureFullscreenUiSync(), 120);
        return;
      }
      if (isPlayerRoute() && isNavDigitKey(event) && !isEditableTarget(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
          event.stopImmediatePropagation();
        }
      }
    },
    true
  );
  window.addEventListener('focus', () => ensureFullscreenUiSync(), true);
  document.addEventListener('visibilitychange', () => ensureFullscreenUiSync(), true);

  let attempts = 0;
  const bootstrapTimer = setInterval(() => {
    if (window.__stremioShellAppReadySent) {
      clearInterval(bootstrapTimer);
      return;
    }
    attempts += 1;
    ensureShellHandshake();
    ensureShellAppReady();
    ensureFullscreenMessageHook();
    ensureFullscreenUiSync();
    if (attempts >= 12) clearInterval(bootstrapTimer);
  }, 1000);
  window.setTimeout(ensureShellAppReady, 2500);
  window.setTimeout(ensureShellAppReady, 5000);
  scheduleShellAppReadyFallback();
})();
