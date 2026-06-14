(function () {
  if (window.__stremioCustomPlaybackBootstrap) return;
  window.__stremioCustomPlaybackBootstrap = true;

  let shellInitSent = false;

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

  ensureShellHandshake();
  if (typeof window.__stremioCustomPlayerTransparencyEnsure === 'function') {
    window.__stremioCustomPlayerTransparencyEnsure();
  }

  window.addEventListener('hashchange', () => {
    ensureShellHandshake();
    if (typeof window.__stremioCustomPlayerTransparencyEnsure === 'function') {
      window.__stremioCustomPlayerTransparencyEnsure();
    }
  });
  window.addEventListener('load', ensureShellHandshake);

  let attempts = 0;
  const bootstrapTimer = setInterval(() => {
    attempts += 1;
    ensureShellHandshake();
    if (attempts >= 20) clearInterval(bootstrapTimer);
  }, 1000);
})();
