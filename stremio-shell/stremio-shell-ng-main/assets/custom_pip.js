(function () {
  'use strict';

  if (window.__stremioCustomPip) return;
  window.__stremioCustomPip = true;

  const NOTICE_ID = 'stremio-custom-pip-notice';

  function showNotice() {
    let notice = document.getElementById(NOTICE_ID);
    if (!notice) {
      notice = document.createElement('div');
      notice.id = NOTICE_ID;
      notice.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:5.5rem',
        'transform:translateX(-50%)',
        'z-index:2147483646',
        'padding:0.7rem 1rem',
        'border-radius:999px',
        'background:rgba(30,30,30,0.88)',
        'color:#fff',
        'font-size:0.92rem',
        'border:1px solid rgba(255,255,255,0.12)',
        'box-shadow:0 10px 30px rgba(0,0,0,0.45)',
        'pointer-events:none',
      ].join(';');
      document.body.appendChild(notice);
    }
    notice.textContent = 'PiP ist in Stremio Custom (MPV) nicht verfügbar.';
    notice.style.display = 'block';
    clearTimeout(notice.__hideTimer);
    notice.__hideTimer = setTimeout(() => {
      notice.style.display = 'none';
    }, 3200);
  }

  async function togglePiP() {
    showNotice();
    return false;
  }

  window.StremioCustomAPI = window.StremioCustomAPI || {};
  window.StremioCustomAPI.enterPlayerPiP = () => Promise.resolve(togglePiP());
  window.StremioCustomAPI.exitPlayerPiP = () => Promise.resolve(false);
  window.StremioCustomAPI.togglePlayerPiP = () => Promise.resolve(togglePiP());
  window.StremioCustomAPI.isPlayerPiPActive = () => false;
  window.__stremioCustomPipToggle = togglePiP;
  window.__stremioCustomPipEnter = togglePiP;
  window.__stremioCustomPipExit = () => Promise.resolve(false);

  console.info('[StremioCustom] PiP disabled in shell mode (MPV limitation).');
})();
