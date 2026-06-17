(function () {
  if (window.__stremioCustomPlaybackBootstrap) return;
  window.__stremioCustomPlaybackBootstrap = true;

  let shellInitSent = false;
  let fullscreenActive = false;
  let fullscreenObserver = null;
  let fullscreenStateInitialized = false;
  let webviewMessageHookInstalled = false;
  let fullscreenIntent = null;
  let fullscreenIntentAt = 0;

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

  function handleIncomingFullscreenMessage(event) {
    const payload = parseWebViewPayload(event);
    const args = extractRpcArgs(payload);
    if (!Array.isArray(args) || args.length < 2) return;
    if (args[0] !== 'win-visibility-changed') return;
    const next = Boolean(args[1]?.isFullscreen);
    // Only trust shell fullscreen updates that correspond to a recent
    // user fullscreen intent. This prevents delayed stale events from
    // flipping the button label back to the opposite state.
    if (fullscreenIntent == null) {
      return;
    }
    if (Date.now() - fullscreenIntentAt > 2500) {
      fullscreenIntent = null;
      return;
    }
    if (next !== fullscreenIntent) return;
    fullscreenIntent = null;
    syncFullscreenState(next);
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
  document.addEventListener(
    'click',
    (event) => {
      if (!isFullscreenControl(event.target)) return;
      const expected = !fullscreenActive;
      fullscreenIntent = expected;
      fullscreenIntentAt = Date.now();
      syncFullscreenState(expected);
      window.setTimeout(() => ensureFullscreenUiSync(), 120);
    },
    true
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'F11' || event.key === 'Escape') {
        const expected = !fullscreenActive;
        fullscreenIntent = expected;
        fullscreenIntentAt = Date.now();
        window.setTimeout(() => ensureFullscreenUiSync(), 120);
      }
    },
    true
  );
  window.addEventListener('focus', () => ensureFullscreenUiSync(), true);
  document.addEventListener('visibilitychange', () => ensureFullscreenUiSync(), true);

  let attempts = 0;
  const bootstrapTimer = setInterval(() => {
    attempts += 1;
    ensureShellHandshake();
    ensureFullscreenMessageHook();
    ensureFullscreenUiSync();
    if (attempts >= 20) clearInterval(bootstrapTimer);
  }, 1000);
})();
