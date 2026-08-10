/**
 * @name Horizontal Navigation
 * @description Scroll buttons and page-load for all board catalog rows (Continue Watching always has chevrons)
 * @version 1.0.0
 * @author MyStremio
 * @category interface
 */
(function () {
  'use strict';

  if (window.__stremioHorizontalNavPlugin) return;
  window.__stremioHorizontalNavPlugin = true;

  window.__mystremioCatalogScrollEnabled = true;
  try {
    window.__mystremioEnsureBoardRowNav?.();
  } catch (_) {
    /* ignore */
  }

  window.__stremioHorizontalNavUnload = function () {
    window.__mystremioCatalogScrollEnabled = false;
    try {
      window.__mystremioTeardownCatalogRowNav?.();
    } catch (_) {
      /* ignore */
    }
  };
})();
