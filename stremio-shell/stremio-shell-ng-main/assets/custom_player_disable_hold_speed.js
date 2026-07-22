(function () {
  'use strict';

  if (window.__stremioDisableHoldSpeed) return;
  window.__stremioDisableHoldSpeed = true;

  const OUT_MARKER = '__stremioHoldSpeedOutgoing';
  const IN_MARKER = '__stremioHoldSpeedIncoming';

  let leftMouseDown = false;
  let userSpeedChangeUntil = 0;
  let lastSpeed = 1;
  let shellMsgId = 15000;
  let enforceTimer = null;

  function isPlayerRoute() {
    return /#\/player/.test(location.hash || '');
  }

  function isSpeedMenuOpen() {
    return Boolean(document.querySelector('[class*="speed-menu-container"]'));
  }

  function isSpeedMenuInteraction(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest('[class*="speed-menu-container"], [class*="control-bar-button"] [class*="icon"][name="speed"]') ||
        target.closest('[class*="control-bar-button"]')?.querySelector?.('[name="speed"]')
    );
  }

  function parseShellWire(raw) {
    if (raw == null) return null;
    try {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!data || !Array.isArray(data.args)) return null;
      return {
        data,
        args: data.args,
        stringMode: typeof raw === 'string',
      };
    } catch (_) {
      return null;
    }
  }

  function serializeShellWire(parsed) {
    if (!parsed) return null;
    return parsed.stringMode ? JSON.stringify(parsed.data) : parsed.data;
  }

  function parseMpvPropChange(raw) {
    let data = raw;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (_) {
        return null;
      }
    }
    if (!data) return null;
    const args = Array.isArray(data) ? data : data.args;
    if (!Array.isArray(args) || args[0] !== 'mpv-prop-change' || !args[1] || typeof args[1] !== 'object') {
      return null;
    }
    return args[1];
  }

  function shouldBlockHoldSpeed() {
    if (!isPlayerRoute()) return false;
    if (!leftMouseDown) return false;
    if (isSpeedMenuOpen()) return false;
    if (Date.now() < userSpeedChangeUntil) return false;
    return true;
  }

  function sendMpvSpeed(speed) {
    if (!window.chrome?.webview?.postMessage) return;
    try {
      shellMsgId += 1;
      window.chrome.webview.postMessage(
        JSON.stringify({
          id: shellMsgId,
          args: ['mpv-set-prop', ['speed', speed]],
        })
      );
    } catch (_) {}
  }

  function rewriteHoldSpeedOutgoing(raw) {
    const parsed = parseShellWire(raw);
    if (!parsed) return raw;

    const args = parsed.args;
    if (args[0] !== 'mpv-set-prop' || !Array.isArray(args[1])) return raw;

    const [prop, value] = args[1];
    if (prop !== 'speed') return raw;
    if (!shouldBlockHoldSpeed()) {
      const speed = Number(value);
      if (Number.isFinite(speed)) lastSpeed = speed;
      return raw;
    }

    args[1] = ['speed', lastSpeed];
    return serializeShellWire(parsed);
  }

  function rewriteHoldSpeedIncoming(raw) {
    if (!shouldBlockHoldSpeed()) return raw;
    const parsed = parseShellWire(raw);
    if (!parsed) return raw;

    const args = parsed.args;
    if (args[0] !== 'mpv-prop-change' || !args[1] || typeof args[1] !== 'object') return raw;
    if (args[1].name !== 'speed') return raw;

    const speed = Number(args[1].data);
    if (!Number.isFinite(speed) || Math.abs(speed - lastSpeed) < 0.001) return raw;

    args[1].data = lastSpeed;
    return serializeShellWire(parsed);
  }

  function unwrapRewriter(fn, marker) {
    if (typeof fn !== 'function') return null;
    if (fn[marker]) return fn.__stremioPreviousRewriter || null;
    return fn;
  }

  function installOutgoingHook() {
    const previous = unwrapRewriter(window.__stremioRewriteShellOutgoing, OUT_MARKER);
    const wrapped = function (raw) {
      let message = raw;
      if (typeof previous === 'function') {
        message = previous(message) || message;
      }
      return rewriteHoldSpeedOutgoing(message);
    };
    wrapped[OUT_MARKER] = true;
    wrapped.__stremioPreviousRewriter = previous;
    window.__stremioRewriteShellOutgoing = wrapped;
  }

  function installIncomingHook() {
    const previous = unwrapRewriter(window.__stremioRewriteShellIncoming, IN_MARKER);
    const wrapped = function (raw) {
      let message = raw;
      if (typeof previous === 'function') {
        message = previous(message) || message;
      }
      return rewriteHoldSpeedIncoming(message);
    };
    wrapped[IN_MARKER] = true;
    wrapped.__stremioPreviousRewriter = previous;
    window.__stremioRewriteShellIncoming = wrapped;
  }

  function installHooks() {
    installOutgoingHook();
    installIncomingHook();
  }

  function interceptShellOutgoing(event) {
    if (!event || event.detail == null) return;
    const parsed = parseShellWire(event.detail);
    if (parsed) {
      const args = parsed.args;
      if (args[0] === 'mpv-set-prop' && Array.isArray(args[1]) && args[1][0] === 'speed') {
        const speed = Number(args[1][1]);
        if (Number.isFinite(speed) && !shouldBlockHoldSpeed()) {
          lastSpeed = speed;
        }
      }
    }
    if (!shouldBlockHoldSpeed()) return;
    const rewritten = rewriteHoldSpeedOutgoing(event.detail);
    if (rewritten != null && rewritten !== event.detail) {
      event.detail = rewritten;
    }
  }

  function startEnforce() {
    if (enforceTimer) return;
    enforceTimer = window.setInterval(() => {
      if (!shouldBlockHoldSpeed()) {
        stopEnforce();
        return;
      }
      sendMpvSpeed(lastSpeed);
    }, 80);
  }

  function stopEnforce() {
    if (!enforceTimer) return;
    window.clearInterval(enforceTimer);
    enforceTimer = null;
  }

  function bindUi() {
    document.addEventListener(
      'mousedown',
      (event) => {
        if (event.button !== 0) return;
        leftMouseDown = true;
        if (isSpeedMenuInteraction(event.target)) {
          userSpeedChangeUntil = Date.now() + 3000;
        }
        startEnforce();
      },
      true
    );
    document.addEventListener(
      'mouseup',
      (event) => {
        if (event.button !== 0) return;
        leftMouseDown = false;
        stopEnforce();
      },
      true
    );
    document.addEventListener(
      'click',
      (event) => {
        if (isSpeedMenuInteraction(event.target) || isSpeedMenuOpen()) {
          userSpeedChangeUntil = Date.now() + 3000;
        }
      },
      true
    );
    window.chrome?.webview?.addEventListener?.('message', (event) => {
      const change = parseMpvPropChange(event?.data);
      if (!change || change.name !== 'speed') return;
      const speed = Number(change.data);
      if (!Number.isFinite(speed)) return;
      if (!shouldBlockHoldSpeed()) {
        lastSpeed = speed;
      }
    });
  }

  function scheduleHookRefresh() {
    installHooks();
    window.setTimeout(installHooks, 0);
    window.setTimeout(installHooks, 120);
    window.setTimeout(installHooks, 600);
  }

  function wrapVolumePersistEnsure() {
    const original = window.__stremioCustomVolumePersistEnsure;
    if (typeof original !== 'function' || original.__stremioHoldSpeedWrapped) return;
    const wrapped = function () {
      return Promise.resolve(original.apply(this, arguments)).finally(scheduleHookRefresh);
    };
    wrapped.__stremioHoldSpeedWrapped = true;
    window.__stremioCustomVolumePersistEnsure = wrapped;
  }

  installHooks();
  wrapVolumePersistEnsure();
  document.addEventListener('stremio-shell-outgoing', interceptShellOutgoing, true);
  bindUi();
  document.addEventListener('stremio-custom-bootstrap-ready', () => {
    wrapVolumePersistEnsure();
    scheduleHookRefresh();
  });
  document.addEventListener('stremio-custom-route-change', () => {
    if (!isPlayerRoute()) {
      leftMouseDown = false;
      stopEnforce();
      return;
    }
    scheduleHookRefresh();
  });
  document.addEventListener('stremio-custom-playback-stopped', () => {
    leftMouseDown = false;
    stopEnforce();
  });

  window.__stremioDisableHoldSpeedEnsure = scheduleHookRefresh;

  console.info('[StremioCustom] Hold-to-speed boost disabled.');
})();
