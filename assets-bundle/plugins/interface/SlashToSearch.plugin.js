/**
 * @name SlashToSearch
 * @description Whenever the slash key is pressed while in the main menu, the search bar will be focused.
 * @updateUrl https://raw.githubusercontent.com/REVENGE977/SlashToSearch/main/SlashToSearch.plugin.js
 * @version 1.0.2
 * @author REVENGE977
 */

(function () {
  'use strict';

  if (window.__SlashToSearchLoaded) return;
  window.__SlashToSearchLoaded = true;

  /**
   * Focuses the search bar when `/` is pressed outside editable fields.
   * @param {KeyboardEvent} e
   */
  function onSlashKeyup(e) {
    if (e.key !== '/') return;
    const tag = String(e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
    console.log('[ SLASHTOSEARCH ] slash pressed, focusing searchbar.');
    const searchInput =
      document.querySelector('div.search-bar-h60ja.search-bar-container-asfq1.active > input') ||
      document.querySelector('.search-input-IQ0ZW') ||
      document.querySelector('[class*="search-input"]');
    if (!searchInput) return;
    searchInput.click?.();
    searchInput.focus?.();
  }

  document.addEventListener('keyup', onSlashKeyup);

  /**
   * Hard unload for live disable.
   */
  window.__stremioSlashToSearchUnload = function () {
    document.removeEventListener('keyup', onSlashKeyup);
    try {
      delete window.__SlashToSearchLoaded;
    } catch (_) {
      window.__SlashToSearchLoaded = false;
    }
  };
})();
