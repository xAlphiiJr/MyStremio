/**
 * MyStremio API Keys hub — native Category before Plugins.
 *
 * Clones a live settings Category shell (same approach as UI Scaling) so the
 * section matches Plugins / Preload styling instead of a custom card.
 */
(function () {
  'use strict';

  if (window.__stremioCustomApiKeysHub) return;
  window.__stremioCustomApiKeysHub = true;

  var HUB_ID = 'mystremio-api-keys-hub';
  var STYLE_ID = 'mystremio-api-keys-hub-style';
  var OPEN_EVENT = 'mystremio-open-api-keys-hub';

  var hubEl = null;
  var bodyEl = null;
  var badgeEl = null;
  var expanded = false;
  var servicesCache = [];
  var refreshToken = 0;

  /**
   * @returns {object|null}
   */
  function api() {
    return window.StremioCustomAPI || window.StremioEnhancedAPI || null;
  }

  /**
   * Inject minimal hub-only styles (native classes do the rest).
   * @returns {void}
   */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + HUB_ID + ' .mystremio-api-keys-badge {',
      '  margin-left: 0.5rem;',
      '  font-size: 0.75rem;',
      '  font-weight: 600;',
      '  padding: 0.12rem 0.45rem;',
      '  border-radius: 999px;',
      '  vertical-align: middle;',
      '}',
      '#' + HUB_ID + ' .mystremio-api-keys-badge.is-missing {',
      '  background: rgba(220, 80, 80, 0.22);',
      '  color: #ffb4b4;',
      '}',
      '#' + HUB_ID + ' .mystremio-api-keys-badge.is-ok {',
      '  background: rgba(80, 180, 120, 0.2);',
      '  color: #b8f0cc;',
      '}',
      '#' + HUB_ID + ' .option-vFOAS .heading-dYMDt,',
      '#' + HUB_ID + ' .option-vFOAS .heading-dYMDt .label-qI6Vh,',
      '#' + HUB_ID + ' .option-vFOAS .content-P2T0i {',
      '  color: var(--primary-foreground-color);',
      '}',
      '#' + HUB_ID + ' .mystremio-api-keys-option-meta {',
      '  margin-top: 0.35rem;',
      '  font-size: 0.78rem;',
      '  line-height: 1.25rem;',
      '  opacity: 0.72;',
      '  color: var(--primary-foreground-color);',
      '  align-self: flex-start;',
      '}',
      '#' + HUB_ID + ' .mystremio-api-keys-status {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  align-self: flex-start;',
      '  width: auto;',
      '  margin-top: 0.35rem;',
      '  font-size: 0.75rem;',
      '  font-weight: 600;',
      '  padding: 0.1rem 0.45rem;',
      '  border-radius: 999px;',
      '}',
      '#' + HUB_ID + ' .mystremio-api-keys-status.is-set {',
      '  background: rgba(80, 180, 120, 0.2);',
      '  color: #b8f0cc;',
      '}',
      '#' + HUB_ID + ' .mystremio-api-keys-status.is-missing {',
      '  background: rgba(220, 80, 80, 0.22);',
      '  color: #ffb4b4;',
      '}',
      '#' + HUB_ID + ' input::-ms-reveal,',
      '#' + HUB_ID + ' input::-ms-clear {',
      '  display: none !important;',
      '}',
      '#' + HUB_ID + ' .stremio-api-key-input-wrap {',
      '  position: relative;',
      '  width: 100%;',
      '}',
      '#' + HUB_ID + ' .stremio-api-key-input-wrap input[class*="plugin-setting-input"] {',
      '  width: 100%;',
      '  padding-right: 3.25rem !important;',
      '  color: var(--primary-foreground-color);',
      '}',
      '#' + HUB_ID + ' .stremio-api-key-input-wrap input.stremio-api-key-masked {',
      '  -webkit-text-security: disc;',
      '  text-security: disc;',
      '}',
      '#' + HUB_ID + ' .stremio-api-key-eye {',
      '  position: absolute;',
      '  right: 0.35rem;',
      '  top: 50%;',
      '  transform: translateY(-50%);',
      '  width: 2.5rem;',
      '  height: 2.5rem;',
      '  padding: 0;',
      '  border: 0;',
      '  background: transparent;',
      '  color: rgba(255, 255, 255, 0.82);',
      '  cursor: pointer;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  opacity: 0.88;',
      '  z-index: 5;',
      '}',
      '#' + HUB_ID + ' .stremio-api-key-eye:hover { opacity: 1; }',
      '#' + HUB_ID + ' .stremio-api-key-eye svg {',
      '  width: 1.15rem;',
      '  height: 1.15rem;',
      '  display: block;',
      '  pointer-events: none;',
      '}',
      '#' + HUB_ID + ' .stremio-api-key-clear {',
      '  align-self: flex-start;',
      '  margin: 0.15rem 0 0;',
      '  padding: 0.15rem 0;',
      '  border: 0;',
      '  background: transparent;',
      '  color: rgba(255, 255, 255, 0.42);',
      '  font-size: 0.82rem;',
      '  line-height: 1.2;',
      '  cursor: pointer;',
      '}',
      '#' + HUB_ID + ' .stremio-api-key-clear:hover {',
      '  color: rgba(255, 255, 255, 0.62);',
      '}',
      '#' + HUB_ID + ' .mystremio-api-keys-empty {',
      '  padding: 0.85rem 1rem;',
      '  opacity: 0.75;',
      '  color: var(--primary-foreground-color);',
      '}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * Open-eye SVG for the reveal toggle.
   * @returns {string}
   */
  function eyeOpenSvg() {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
      '<circle cx="12" cy="12" r="3"/></svg>'
    );
  }

  /**
   * Closed-eye SVG for the hide toggle.
   * @returns {string}
   */
  function eyeClosedSvg() {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.77 21.77 0 0 1 5.06-5.94"/>' +
      '<path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.77 21.77 0 0 1-2.16 3.19"/>' +
      '<path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>' +
      '<line x1="1" y1="1" x2="23" y2="23"/></svg>'
    );
  }

  /**
   * Find the native Plugins Category element.
   * @returns {HTMLElement|null}
   */
  function findPluginsCategory() {
    var labels = document.querySelectorAll('.category-GP0hI .label-N_O2v, .category-GP0hI [class*="label-"]');
    for (var i = 0; i < labels.length; i++) {
      var text = (labels[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (text === 'Plugins' || text.indexOf('Plugins') === 0) {
        return labels[i].closest('.category-GP0hI');
      }
    }
    return null;
  }

  /**
   * Find any native Category to clone the shell from.
   * @returns {HTMLElement|null}
   */
  function findTemplateCategory() {
    return findPluginsCategory() || document.querySelector('.category-GP0hI');
  }

  /**
   * Find a native Option template inside a category (for class names).
   * @param {HTMLElement|null} category
   * @returns {HTMLElement|null}
   */
  function findTemplateOption(category) {
    if (!category) return null;
    return (
      category.querySelector('.option-vFOAS') ||
      category.querySelector('[class*="option-"]') ||
      null
    );
  }

  /**
   * @param {boolean} set
   * @returns {string}
   */
  function statusClass(set) {
    return set ? 'mystremio-api-keys-status is-set' : 'mystremio-api-keys-status is-missing';
  }

  /**
   * @param {boolean} set
   * @returns {string}
   */
  function statusText(set) {
    return set ? 'Set' : 'Missing';
  }

  /**
   * Normalize list-api-key-services IPC result.
   * @param {*} res
   * @returns {Array}
   */
  function normalizeServices(res) {
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.services)) return res.services;
    return [];
  }

  /**
   * Update the category summary badge.
   * @param {Array} services
   * @returns {void}
   */
  function updateBadge(services) {
    if (!badgeEl) return;
    var missing = 0;
    for (var i = 0; i < services.length; i++) {
      if (!services[i].isSet) missing++;
    }
    if (!services.length) {
      badgeEl.textContent = '';
      badgeEl.style.display = 'none';
      return;
    }
    badgeEl.style.display = '';
    if (missing > 0) {
      badgeEl.textContent = missing + ' missing';
      badgeEl.className = 'mystremio-api-keys-badge is-missing';
    } else {
      badgeEl.textContent = 'All set';
      badgeEl.className = 'mystremio-api-keys-badge is-ok';
    }
  }

  /**
   * Persist a key and refresh local status UI.
   * @param {string} serviceId
   * @param {string} value
   * @param {HTMLElement} statusEl
   * @returns {void}
   */
  function saveKey(serviceId, value, statusEl) {
    var client = api();
    if (!client?.setApiKey) return;
    client
      .setApiKey(serviceId, value)
      .then(function (saved) {
        var set = !!(saved && String(saved).trim());
        if (statusEl) {
          statusEl.className = statusClass(set);
          statusEl.textContent = statusText(set);
        }
        for (var i = 0; i < servicesCache.length; i++) {
          if (servicesCache[i].id === serviceId) {
            servicesCache[i].isSet = set;
            break;
          }
        }
        updateBadge(servicesCache);
      })
      .catch(function () {});
  }

  /**
   * Build one native-looking Option row for a service.
   * @param {Object} service
   * @param {HTMLElement|null} optionTemplate
   * @returns {HTMLElement}
   */
  function buildServiceOption(service, optionTemplate) {
    var option = document.createElement('div');
    option.className = (optionTemplate && optionTemplate.className) || 'option-vFOAS';
    option.setAttribute('data-api-key-service', service.id);

    var heading = document.createElement('div');
    heading.className = 'heading-dYMDt';
    var label = document.createElement('div');
    label.className = 'label-qI6Vh';
    label.textContent = service.label || service.id;
    heading.appendChild(label);
    option.appendChild(heading);

    var content = document.createElement('div');
    content.className = 'content-P2T0i';

    var stacked = document.createElement('div');
    stacked.className = 'plugin-setting-row-stacked-PN1AF';
    stacked.style.width = '100%';

    if (service.docsUrl) {
      var link = document.createElement('button');
      link.type = 'button';
      link.className = 'api-key-link-vAO15';
      link.textContent = 'Get API Key';
      link.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var client = api();
        if (client?.openExternalUrl) {
          client.openExternalUrl(service.docsUrl);
        } else {
          window.open(service.docsUrl, '_blank', 'noopener,noreferrer');
        }
      });
      stacked.appendChild(link);
    }

    var wrap = document.createElement('div');
    wrap.className = 'stremio-api-key-input-wrap';
    wrap.dataset.apiKeyRevealed = '0';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'plugin-setting-input-b4k_e stremio-api-key-masked';
    input.placeholder = 'Paste API key…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = '';
    input.setAttribute('data-loaded', '0');

    var eyeBtn = document.createElement('button');
    eyeBtn.type = 'button';
    eyeBtn.className = 'stremio-api-key-eye';
    eyeBtn.setAttribute('tabindex', '-1');
    eyeBtn.setAttribute('aria-label', 'Show API key');
    eyeBtn.innerHTML = eyeOpenSvg();

    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'stremio-api-key-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.setAttribute('tabindex', '-1');

    var status = document.createElement('span');
    status.className = statusClass(!!service.isSet);
    status.textContent = statusText(!!service.isSet);

    var lastSaved = '';

    /**
     * Apply reveal/mask UI without changing the stored value.
     * @param {boolean} revealed
     * @returns {void}
     */
    function applyReveal(revealed) {
      wrap.dataset.apiKeyRevealed = revealed ? '1' : '0';
      input.type = 'text';
      input.classList.toggle('stremio-api-key-masked', !revealed);
      eyeBtn.innerHTML = revealed ? eyeClosedSvg() : eyeOpenSvg();
      eyeBtn.setAttribute('aria-label', revealed ? 'Hide API key' : 'Show API key');
    }

    /**
     * Load the real vault value into the input (masked).
     * @returns {void}
     */
    function loadValue() {
      var client = api();
      if (!client?.getApiKey) {
        input.setAttribute('data-loaded', '1');
        return;
      }
      client
        .getApiKey(service.id)
        .then(function (value) {
          var realValue = typeof value === 'string' ? value : (value && value.value) || '';
          lastSaved = realValue;
          input.value = realValue;
          service.isSet = !!realValue.trim();
          status.className = statusClass(service.isSet);
          status.textContent = statusText(service.isSet);
          applyReveal(false);
          input.setAttribute('data-loaded', '1');
        })
        .catch(function () {
          input.setAttribute('data-loaded', '1');
        });
    }

    input.addEventListener('input', function () {
      // Keep text type + CSS mask so Edge never injects a second reveal icon.
      input.type = 'text';
      if (wrap.dataset.apiKeyRevealed !== '1') {
        input.classList.add('stremio-api-key-masked');
      }
    });

    input.addEventListener('blur', function () {
      if (input.getAttribute('data-loaded') !== '1') return;
      if (input.value === lastSaved) return;
      saveKey(service.id, input.value, status);
      lastSaved = input.value;
      service.isSet = !!input.value.trim();
      if (!service.isSet) {
        applyReveal(false);
      }
    });

    eyeBtn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      applyReveal(wrap.dataset.apiKeyRevealed !== '1');
    });

    clearBtn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      lastSaved = '';
      applyReveal(false);
      saveKey(service.id, '', status);
      service.isSet = false;
    });

    wrap.appendChild(input);
    wrap.appendChild(eyeBtn);
    stacked.appendChild(wrap);
    stacked.appendChild(clearBtn);
    stacked.appendChild(status);

    var usedBy = Array.isArray(service.usedBy) ? service.usedBy : [];
    if (usedBy.length) {
      var meta = document.createElement('div');
      meta.className = 'mystremio-api-keys-option-meta';
      meta.textContent = 'Used by: ' + usedBy.join(', ');
      stacked.appendChild(meta);
    }

    content.appendChild(stacked);
    option.appendChild(content);
    loadValue();
    return option;
  }

  /**
   * Rebuild option rows from the services list.
   * @param {Array} services
   * @returns {void}
   */
  function renderBody(services) {
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    servicesCache = services || [];
    updateBadge(servicesCache);

    if (!servicesCache.length) {
      var empty = document.createElement('div');
      empty.className = 'mystremio-api-keys-empty';
      empty.textContent = 'No API-key services discovered from installed plugins.';
      bodyEl.appendChild(empty);
      return;
    }

    var optionTemplate = findTemplateOption(hubEl) || findTemplateOption(findTemplateCategory());
    for (var i = 0; i < servicesCache.length; i++) {
      bodyEl.appendChild(buildServiceOption(servicesCache[i], optionTemplate));
    }
  }

  /**
   * Load services from the shell and render.
   * @returns {void}
   */
  function refresh() {
    var client = api();
    if (!client?.listApiKeyServices) return;
    var token = ++refreshToken;
    client
      .listApiKeyServices()
      .then(function (res) {
        if (token !== refreshToken) return;
        renderBody(normalizeServices(res));
      })
      .catch(function () {
        if (token !== refreshToken) return;
        renderBody([]);
      });
  }

  /**
   * Expand the hub and scroll it into view (deep-link from plugin panels).
   * @returns {void}
   */
  function openHub() {
    if (!hubEl || !bodyEl) return;
    expanded = true;
    bodyEl.style.display = '';
    try {
      hubEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (_) {
      hubEl.scrollIntoView(true);
    }
  }

  /**
   * Build the Category shell by cloning a live native Category.
   * @param {HTMLElement} template
   * @returns {HTMLElement|null}
   */
  function buildHubFromTemplate(template) {
    var clone = template.cloneNode(true);
    clone.id = HUB_ID;
    clone.setAttribute('data-mystremio-api-keys-hub', '1');

    var label = clone.querySelector('.label-N_O2v') || clone.querySelector('[class*="label-"]');
    if (!label) return null;
    label.textContent = 'API Keys';

    badgeEl = document.createElement('span');
    badgeEl.className = 'mystremio-api-keys-badge';
    badgeEl.style.display = 'none';
    label.appendChild(badgeEl);

    var heading =
      clone.querySelector('.heading-XePFl') ||
      label.closest('[class*="heading-"]') ||
      label.parentElement;

    // Remove every direct child after the heading (native option rows).
    var removeAfter = false;
    var children = Array.prototype.slice.call(clone.children);
    for (var i = 0; i < children.length; i++) {
      if (children[i] === heading) {
        removeAfter = true;
        continue;
      }
      if (removeAfter) {
        children[i].remove();
      }
    }
    // Also strip any leftover option nodes if the category wraps them.
    var leftovers = clone.querySelectorAll('.option-vFOAS, [class*="option-"]');
    for (var j = 0; j < leftovers.length; j++) {
      if (heading && heading.contains(leftovers[j])) continue;
      leftovers[j].remove();
    }

    bodyEl = document.createElement('div');
    bodyEl.setAttribute('data-mystremio-api-keys-body', '1');
    bodyEl.style.display = expanded ? '' : 'none';
    clone.appendChild(bodyEl);

    if (heading) {
      heading.style.cursor = 'pointer';
      heading.setAttribute('tabindex', '0');
      heading.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        expanded = !expanded;
        bodyEl.style.display = expanded ? '' : 'none';
      });
      heading.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          heading.click();
        }
      });
    }

    return clone;
  }

  /**
   * Insert the hub Category immediately before the Plugins Category.
   * @returns {boolean}
   */
  function ensureHub() {
    ensureStyle();

    var existing = document.getElementById(HUB_ID);
    if (existing) {
      hubEl = existing;
      bodyEl = existing.querySelector('[data-mystremio-api-keys-body]') || bodyEl;
      badgeEl = existing.querySelector('.mystremio-api-keys-badge') || badgeEl;
      // Keep hub before Plugins if React re-ordered the tree.
      var pluginsCat = findPluginsCategory();
      if (pluginsCat && pluginsCat.parentNode && hubEl.nextElementSibling !== pluginsCat) {
        pluginsCat.parentNode.insertBefore(hubEl, pluginsCat);
      }
      if (bodyEl && !bodyEl.childNodes.length) {
        refresh();
      }
      return true;
    }

    var pluginsCat = findPluginsCategory();
    var template = findTemplateCategory();
    if (!template) return false;

    hubEl = buildHubFromTemplate(template);
    if (!hubEl) return false;

    if (pluginsCat && pluginsCat.parentNode) {
      pluginsCat.parentNode.insertBefore(hubEl, pluginsCat);
    } else if (template.parentNode) {
      template.parentNode.insertBefore(hubEl, template);
    } else {
      return false;
    }

    refresh();
    return true;
  }

  /**
   * @returns {void}
   */
  function tick() {
    try {
      if (!/#\/settings/.test(location.href || '')) return;
      ensureHub();
    } catch (_) {}
  }

  document.addEventListener(OPEN_EVENT, function () {
    ensureHub();
    openHub();
  });

  document.addEventListener('mystremio-api-keys-changed', function () {
    refresh();
  });

  setInterval(tick, 900);
  setTimeout(tick, 400);
  setTimeout(tick, 1200);
})();
