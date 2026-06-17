/**
 * @name Stream UI
 * @description Unified stream-list UI: AfterCredits, WatchHub, ratings, accordions.
 * @version 2.0.0
 * @category player
 * @author Stremio Custom
 */
/* global StremioEnhancedAPI */

(function () {
  'use strict';

  const STYLE_ID = 'stream-ui-styles';
  const SETTING_TORRENT = 'enable_torrent_accordions';
  const SETTING_RATINGS = 'enable_ratings_aggregator';
  const SETTING_IMDB = 'enable_imdb_ratings';
  const SETTING_WATCHHUB = 'enable_watchhub';
  const SETTING_AFTERCREDITS = 'enable_aftercredits';
  const PLUGIN_ID = 'stream-ui';

  function getSetting(key) {
    const a = api();
    return a ? a.getSetting(PLUGIN_ID, key) : Promise.resolve(null);
  }

  const state = {
    torrent: true,
    ratings: true,
    imdb: true,
    watchhub: true,
    aftercredits: true,
    contentKey: '',
    lastBox: null,
    ready: false,
  };

  function api() {
    return window.StremioEnhancedAPI || null;
  }

  function asToggle(value, fallback) {
    if (value === null || value === undefined) return fallback;
    return value !== false;
  }

  async function loadSettings() {
    const a = api();
    if (!a) return;

    let torrent = await getSetting(SETTING_TORRENT);
    if (torrent === null || torrent === undefined) {
      const legacy = await Promise.all([
        getSetting('enable_aio_streams'),
        getSetting('enable_storerd'),
        getSetting('enable_storetb'),
      ]);
      torrent = legacy.some((v) => v !== false);
    }

    state.torrent = asToggle(torrent, true);
    state.ratings = asToggle(await getSetting(SETTING_RATINGS), true);
    state.imdb = asToggle(await getSetting(SETTING_IMDB), true);
    state.watchhub = asToggle(await getSetting(SETTING_WATCHHUB), true);
    state.aftercredits = asToggle(await getSetting(SETTING_AFTERCREDITS), true);
    state.ready = true;
  }

  function getContentKey() {
    return (location.hash || location.pathname || location.href).split('?')[0];
  }

  function streamsLoading() {
    const list = document.querySelector('[class*="streams-list-"]');
    return !!list && /still loading|addons are loading/i.test(list.textContent || '');
  }

  function esc(t) {
    const d = document.createElement('span');
    d.textContent = t;
    return d.innerHTML;
  }

  function findStreamsBox() {
    const list = document.querySelector('[class*="streams-list-"]');
    return list?.querySelector('[class*="streams-container-"]') || null;
  }

  function getStreamText(el) {
    const desc = el.querySelector('[class*="description-container-"]');
    return desc ? desc.textContent.trim() : el.textContent.trim();
  }

  function getStreamLabel(el) {
    const nameEl = el.querySelector('[class*="addon-name-"]');
    return nameEl ? nameEl.textContent.trim().split('\n')[0].trim() : '';
  }

  function looksLikeStreamLabel(text) {
    if (!text) return false;
    if (/^\[/.test(text)) return true;
    if (/^(?:⚡\s*)?\[(?:RD|AD|PM|DL|TB|FHD|HD|4K|SD)\]/i.test(text)) return true;
    if (/\b(1080p|720p|2160p|4k|WEB[- ]?DL|BluRay|HEVC|x265|x264|S\d+\s*E\d+)\b/i.test(text)) return true;
    if (/👤|💾|⚙️|🧲|✏️/.test(text)) return true;
    return false;
  }

  function parseAddonFromLabel(label) {
    if (!label) return '';
    if (/aio\s*streams?(?:\s*nightly)?/i.test(label)) {
      const m = label.match(/aio\s*streams?(?:\s*nightly)?/i);
      return m ? m[0] : 'AIO Streams Nightly';
    }
    if (/⚡\s*\[(?:RD|AD|PM|DL|TB)\]\s*Store/i.test(label) || /store\s*\|\s*rd/i.test(label)) return 'Store | RD';
    if (/⚡\s*\[(?:RD|AD|PM|DL|TB)\]\s*Store/i.test(label) || /store\s*\|\s*tb/i.test(label)) return 'Store | TB';
    return '';
  }

  function getStreamContainer(el) {
    if (!el) return null;
    if (el.matches?.('a[class*="stream-container-"], button[class*="stream-container-"]')) return el;
    return el.closest('a[class*="stream-container-"], button[class*="stream-container-"]') || el;
  }

  function getRawStreamTitle(el) {
    const node = getStreamContainer(el);
    if (!node) return '';
    return (node.getAttribute('title') || node.title || '').trim();
  }

  /** Stremio sets title={addon.manifest.name} on each stream button — use only that for grouping. */
  function getDirectAddonTitle(el) {
    const title = getRawStreamTitle(el);
    if (!title || looksLikeStreamLabel(title)) return '';
    if (/cast\s*search/i.test(title) || isExcludedAddon(title)) return '';
    return title;
  }

  function getStreamTitle(el) {
    return getRawStreamTitle(el);
  }

  function resolveTorrentAddonName(el, box) {
    const direct = getDirectAddonTitle(el);
    if (direct) return direct;
    if (!box) return '';
    const links = visibleLinks(box);
    const node = getStreamContainer(el) || el;
    const idx = links.findIndex((l) => (getStreamContainer(l) || l) === node || l === el);
    if (idx < 0) return '';
    for (let j = idx - 1; j >= 0; j--) {
      const prev = getDirectAddonTitle(links[j]);
      if (prev) return prev;
    }
    for (let j = idx + 1; j < links.length; j++) {
      const next = getDirectAddonTitle(links[j]);
      if (next) return next;
    }
    return '';
  }

  function getAccordionAddonName(el, box) {
    return box ? resolveTorrentAddonName(el, box) : getDirectAddonTitle(el);
  }

  const WATCHHUB_ADDON_RE = /watch\s*hub|guidebox/i;
  const WATCHHUB_MODE_RE = /\b(sub(?:scription)?|buy|rent|free|abo|kauf(?:en)?|miete(?:n)?|kostenlos)\b/i;
  const WATCHHUB_PROVIDER_RE =
    /\b(netflix|amazon|prime|disney|hbo|max|hulu|apple|itunes|paramount|peacock|sky|youtube|google\s*play|rakuten|microsoft|videoland|viaplay|joyn|crunchyroll|wow)\b/i;
  const EXCLUDE_ADDON_RE = /after\s*credits?|ratings?\s*aggregator|aggregator|imdb\s*ratings?|cast\s*search/i;
  const KNOWN_TORRENT_ADDON_RE = /aio\s*streams?(?:\s*nightly)?|store\s*\|?\s*(?:rd|tb)|storerd|storetb|torz|stremthru|torrentio|torrents?\s*db|torrent|comet|mediafusion|debrid|peerflix|sootio|nuvio|knaben|jackett|prowlarr/i;

  function isExcludedAddon(name) {
    return EXCLUDE_ADDON_RE.test(name || '');
  }

  /** Fixed visual order: AIO Nightly → AIO → Store TB → Store RD → rest by DOM position. */
  function addonSortRank(name) {
    const n = (name || '').trim().toLowerCase();
    if (/aio\s*streams?\s*nightly/i.test(n)) return 10;
    if (/aio\s*streams?/i.test(n)) return 20;
    if (/store\s*\|?\s*tb|storetb/i.test(n)) return 30;
    if (/store\s*\|?\s*rd|storerd/i.test(n)) return 40;
    return 50;
  }

  function compareAddonOrder(a, b) {
    const rank = addonSortRank(a.name) - addonSortRank(b.name);
    if (rank !== 0) return rank;
    return (a.firstIdx ?? 0) - (b.firstIdx ?? 0);
  }

  function isCustomUiChild(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === 'sui-watchhub-root' || el.id === 'sui-ratings-bundle' || el.id === 'sui-aftercredits-root') return true;
    return el.classList.contains('sui-aio-group');
  }

  function getStreamsBoxTopAnchor(box) {
    if (!box) return null;
    for (const child of box.children) {
      if (child.nodeType !== 1 || isCustomUiChild(child)) continue;
      return child;
    }
    return null;
  }

  function getUiInsertAfterAfterCredits(box) {
    const ac = document.getElementById('sui-aftercredits-root');
    if (ac?.parentElement === box) return ac.nextSibling;
    return getStreamsBoxTopAnchor(box);
  }

  function getUiInsertAfterWatchHub(box) {
    const wh = document.getElementById('sui-watchhub-root');
    if (wh?.parentElement === box) return wh.nextSibling;
    return getUiInsertAfterAfterCredits(box);
  }

  function getUiInsertAfterRatings(box) {
    const ratings = document.getElementById('sui-ratings-bundle');
    if (ratings?.parentElement === box) return ratings.nextSibling;
    return getUiInsertAfterWatchHub(box);
  }

  function getAddonName(el) {
    const raw = getRawStreamTitle(el);
    if (raw && !looksLikeStreamLabel(raw)) return raw;
    const label = getStreamLabel(el);
    const fromLabel = parseAddonFromLabel(label);
    if (fromLabel) return fromLabel;
    return label || 'Unknown';
  }

  function isWatchHubStream(el) {
    const name = `${getDirectAddonTitle(el)} ${getAddonName(el)}`.trim();
    if (WATCHHUB_ADDON_RE.test(name)) return true;
    const text = getStreamText(el) || '';
    if (!WATCHHUB_MODE_RE.test(text)) return false;
    if (/👤|💾|⚙️|🧲|x26[45]|web[- ]?dl|bluray|torrent/i.test(text)) return false;
    if (WATCHHUB_PROVIDER_RE.test(text)) return true;
    return /\b\d+(?:[.,]\d{1,2})?\s*(€|\$|£)\b/.test(text);
  }

  function shouldGroupAsTorrent(el, box) {
    if (el.classList.contains('sui-hidden-stream')) return false;
    const name = getDirectAddonTitle(el);
    if (WATCHHUB_ADDON_RE.test(name || '') || isWatchHubStream(el)) return false;
    if (!name || isExcludedAddon(name)) return false;
    if (KNOWN_TORRENT_ADDON_RE.test(name)) return true;
    return isTorrentStream(el, box);
  }

  function isTorrentGroup(name, streams, box) {
    if (!name || isExcludedAddon(name)) return false;
    if (WATCHHUB_ADDON_RE.test(name)) return false;
    if (streams.some((el) => isWatchHubStream(el))) return false;
    if (KNOWN_TORRENT_ADDON_RE.test(name)) return streams.length >= 1;
    if (streams.length < 2) return false;
    return streams.some((el) => isTorrentStream(el, box));
  }

  function visibleLinks(box) {
    return getTopLevelStreamLinks(box).filter((el) => !el.classList.contains('sui-hidden-stream'));
  }

  function collectTorrentGroups(box) {
    const links = visibleLinks(box);
    const map = new Map();
    const order = [];

    for (let i = 0; i < links.length; i++) {
      const el = links[i];
      const name = getDirectAddonTitle(el);
      if (WATCHHUB_ADDON_RE.test(name || '') || isWatchHubStream(el)) continue;
      if (!name || isExcludedAddon(name)) continue;
      const key = `torrent:${name}`;
      if (!map.has(key)) {
        map.set(key, { key, name, streams: [], firstIdx: i });
        order.push(key);
      }
      const g = map.get(key);
      g.firstIdx = Math.min(g.firstIdx, i);
      if (!g.streams.includes(el)) g.streams.push(el);
    }

    return order
      .map((k) => map.get(k))
      .filter((g) => isTorrentGroup(g.name, g.streams, box));
  }

  function getTopLevelStreamLinks(box) {
    if (!box) return [];
    let links = Array.from(box.querySelectorAll('a[class*="stream-container-"], button[class*="stream-container-"]'));
    if (!links.length) {
      links = Array.from(box.querySelectorAll('a, button')).filter((a) =>
        a.querySelector('[class*="description-container-"], [class*="addon-name-"]')
      );
    }
    return links.filter((a) => !a.closest('.sui-aio-header'));
  }

  function getStreamLinks(box) {
    return getTopLevelStreamLinks(box);
  }

  function injectCSS() {
    let s = document.getElementById(STYLE_ID);
    if (!s) {
      s = document.createElement('style');
      s.id = STYLE_ID;
      document.head.appendChild(s);
    }
    s.textContent = `
.sui-hidden-stream{
  display:none!important;visibility:hidden!important;height:0!important;
  min-height:0!important;margin:0!important;padding:0!important;
  overflow:hidden!important;pointer-events:none!important;border:none!important
}

.sui-aio-group{
  display:block;margin:0 10px 10px 6px;border-radius:16px;overflow:hidden;
  background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 10px 32px rgba(0,0,0,.22);
  backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%);
  transition:border-color .2s,box-shadow .2s;animation:suiIn .35s ease-out
}
.sui-aio-group.open{border-color:rgba(255,255,255,.11);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 12px 36px rgba(0,0,0,.28)}
.sui-aio-header{
  display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;user-select:none;
  transition:background .15s;border-bottom:1px solid transparent
}
.sui-aio-icon{
  flex:none;width:30px;height:30px;border-radius:10px;display:flex;align-items:center;justify-content:center;
  font-size:13px;color:rgba(255,255,255,.72);background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.08)
}
.sui-aio-name{font-size:12px;font-weight:700;color:rgba(255,255,255,.9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sui-aio-sub{margin-top:2px;font-size:10px;color:rgba(255,255,255,.38)}
.sui-aio-group.open .sui-aio-header{border-bottom-color:rgba(255,255,255,.06)}
.sui-aio-header:hover,.sui-aio-header:focus-visible{background:rgba(255,255,255,.06);outline:none}
.sui-aio-meta{flex:1;min-width:0}
.sui-aio-badge{
  flex:none;min-width:1.6rem;padding:3px 9px;border-radius:999px;text-align:center;font-size:10px;font-weight:700;
  color:rgba(255,255,255,.65);background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06)
}
.sui-aio-caret{flex:none;font-size:10px;color:rgba(255,255,255,.35);transition:transform .25s,color .2s}
.sui-aio-group.open .sui-aio-caret{transform:rotate(180deg);color:rgba(255,255,255,.55)}
.sui-aio-body{overflow:hidden;max-height:0;opacity:0;transition:max-height .35s ease,opacity .2s;pointer-events:none}
.sui-aio-group.open .sui-aio-body{max-height:12000px;opacity:1;pointer-events:auto;padding:4px 8px 8px}
.sui-aio-group:not(.open) .sui-aio-body > *{display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important}
.sui-aio-group.open .sui-aio-body > a,
.sui-aio-group.open .sui-aio-body > [class*="stream-container"]{display:flex!important;visibility:visible!important;height:auto!important}

#sui-ratings-bundle,#sui-watchhub-root,#sui-aftercredits-root{
  margin:8px 10px 12px 6px;animation:suiIn .35s ease-out
}
.sui-ratings-bundle-row{display:flex;flex-direction:row;align-items:flex-start;gap:10px;width:100%}
.sui-ratings-bundle-row.has-both{align-items:stretch}
.sui-ratings-bundle-row.has-both .sui-ratings-panel.sui-ratings-main{flex:2 1 0;max-width:66.666%;min-width:0}
.sui-ratings-bundle-row.has-both .sui-ratings-panel.sui-ratings-side{flex:1 1 0;max-width:33.333%;min-width:0;width:auto}
.sui-ratings-bundle-row.has-both .sui-ratings-main .sui-ratings-row{
  display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px;overflow:visible
}
.sui-ratings-bundle-row.has-both .sui-ratings-side .sui-ratings-row{margin-top:8px;justify-content:center}
.sui-ratings-bundle-row.has-both .sui-panel-hdr{
  display:flex;align-items:center;gap:8px;min-height:42px;
  padding:4px 2px 10px;margin-bottom:0;box-sizing:border-box;
  border-bottom:1px solid rgba(255,255,255,.06);overflow:visible
}
.sui-ratings-bundle-row.has-both .sui-panel-icon{
  width:30px;height:30px;font-size:14px;flex:none;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;line-height:1;overflow:visible
}
.sui-ratings-bundle-row.has-both .sui-panel-hdr > div:nth-child(2){
  flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;overflow:visible
}
.sui-ratings-bundle-row.has-both .sui-panel-title{font-size:12px;line-height:1.2}
.sui-ratings-bundle-row.has-both .sui-panel-title-stacked{line-height:1.1;gap:0}
.sui-ratings-bundle-row.has-both .sui-panel-title-stacked span{font-size:12px;line-height:1.15}
.sui-ratings-bundle-row.has-both .sui-rc-card{
  width:100%;min-width:0;min-height:64px;padding:10px 6px 8px;border-radius:11px;box-sizing:border-box;overflow:visible
}
.sui-ratings-bundle-row.has-both .sui-rc-top{
  min-height:24px;margin-bottom:4px;gap:5px;align-items:center;overflow:visible
}
.sui-ratings-bundle-row.has-both .sui-rc-icon{
  width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center;overflow:visible;line-height:0
}
.sui-ratings-bundle-row.has-both .sui-rc-icon svg{width:16px;height:16px;display:block;overflow:visible}
.sui-ratings-bundle-row.has-both .sui-rc-value{font-size:1rem;line-height:1}
.sui-ratings-bundle-row.has-both .sui-rc-label{
  font-size:.58rem;line-height:1.2;max-width:100%;white-space:normal;
  overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;text-align:center
}
.sui-ratings-bundle-row.has-both .sui-rc-age-box{font-size:.95rem;padding:5px 7px;min-width:34px}
.sui-ratings-panel{
  min-width:0;padding:10px 12px 10px;border-radius:16px;
  background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 10px 32px rgba(0,0,0,.22);
  backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%)
}
.sui-ratings-panel.sui-ratings-main{flex:1 1 auto;max-width:100%;min-width:0}
.sui-ratings-panel.sui-ratings-side{flex:0 0 auto;width:max-content;max-width:36%;min-width:0;align-self:flex-start}
.sui-ratings-bundle-row .sui-ratings-panel:only-child{flex:1 1 100%!important;max-width:100%!important}
#sui-watchhub-root{
  padding:14px 14px 12px;border-radius:16px;
  background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 10px 32px rgba(0,0,0,.22);
  backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%)
}
#sui-watchhub-root .sui-watchhub-header{
  display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none;
  padding:0 0 2px;
}
#sui-watchhub-root .sui-watchhub-meta{flex:1;min-width:0}
#sui-watchhub-root .sui-watchhub-badge{
  flex:none;min-width:1.6rem;padding:4px 10px;border-radius:999px;text-align:center;
  font-size:10px;font-weight:700;color:rgba(255,255,255,.65);
  background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);
}
#sui-watchhub-root .sui-watchhub-caret{
  flex:none;font-size:10px;color:rgba(255,255,255,.35);transition:transform .25s,color .2s;
}
#sui-watchhub-root.open .sui-watchhub-caret{
  transform:rotate(180deg);color:rgba(255,255,255,.55);
}
#sui-watchhub-root .sui-watchhub-body{
  overflow:hidden;max-height:0;opacity:0;pointer-events:none;transition:max-height .35s ease,opacity .2s;
}
#sui-watchhub-root.open .sui-watchhub-body{
  max-height:6000px;opacity:1;pointer-events:auto;margin-top:8px;
}
#sui-aftercredits-root{
  padding:14px 14px 12px;border-radius:16px;
  background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 10px 32px rgba(0,0,0,.22);
  backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%)
}
.sui-ac-list{display:flex;flex-direction:column;gap:6px}
.sui-ac-message{
  padding:10px 12px;border-radius:12px;font-size:12px;font-weight:500;line-height:1.45;
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05);color:rgba(255,255,255,.72)
}
.sui-ac-message.no-stinger{color:rgba(255,255,255,.42)}
.sui-ac-message.has-stinger{
  color:#86efac;background:rgba(74,222,128,.08);border-color:rgba(74,222,128,.15)
}
@keyframes suiIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

.sui-panel-hdr{display:flex;align-items:center;gap:8px;padding:0 4px 12px;margin-bottom:4px;border-bottom:1px solid rgba(255,255,255,.06)}
.sui-panel-icon{
  width:30px;height:30px;border-radius:10px;display:flex;align-items:center;justify-content:center;
  font-size:14px;line-height:1;flex-shrink:0;overflow:visible;
  color:rgba(255,255,255,.75);background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.08)
}
.sui-panel-title{font-size:12px;font-weight:700;color:rgba(255,255,255,.88);line-height:1.2}
.sui-panel-title-stacked{display:flex;flex-direction:column;gap:1px;line-height:1.1}
.sui-panel-title-stacked span{font-size:11px;font-weight:700;color:rgba(255,255,255,.88);letter-spacing:.01em}
.sui-panel-sub{font-size:11px;color:rgba(255,255,255,.38);margin-top:2px}

.sui-ratings-row{display:flex;flex-wrap:wrap;gap:10px}
.sui-rc-card{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:78px;padding:14px 16px 11px;border-radius:12px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);box-shadow:inset 0 1px 0 rgba(255,255,255,.07);backdrop-filter:blur(16px) saturate(150%)}
.sui-rc-top{display:flex;align-items:center;justify-content:center;gap:7px;min-height:28px;margin-bottom:7px}
.sui-rc-icon{width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center}
.sui-rc-icon svg{width:18px;height:18px;display:block}
.sui-rc-value{font-size:1.2rem;font-weight:700;color:#fff;line-height:1;font-variant-numeric:tabular-nums}
.sui-rc-label{font-size:.7rem;font-weight:500;color:rgba(255,255,255,.42);text-align:center;white-space:nowrap}
.sui-rc-age-box{min-width:38px;padding:6px 8px;border-radius:8px;background:#f5c518;color:#111;font-size:1.05rem;font-weight:800;line-height:1;text-align:center}
.sui-rc-votes{font-size:.62rem;color:rgba(255,255,255,.32);margin-top:4px;text-align:center;white-space:nowrap}

.sui-wh-list{display:flex;flex-direction:column;gap:6px}
.sui-wh-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;cursor:pointer;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05);transition:background .2s,border-color .2s,transform .2s}
.sui-wh-row:hover{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.1);transform:translateY(-1px)}
.sui-wh-logo-wrap{flex:none;width:30px;height:30px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);overflow:hidden}
.sui-wh-logo{width:18px;height:18px;object-fit:contain;display:block}
.sui-wh-logo-fb{font-size:12px;font-weight:800;color:#fff;width:100%;height:100%;display:flex;align-items:center;justify-content:center}
.sui-wh-name{flex:1;min-width:0;font-size:12px;font-weight:600;color:rgba(255,255,255,.92);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sui-wh-badge{flex:none;padding:4px 10px;border-radius:999px;font-size:10px;font-weight:700}
.sui-wh-sub{color:#c4b5fd;background:rgba(167,139,250,.14);border:1px solid rgba(167,139,250,.22)}
.sui-wh-buy{color:#fdba74;background:rgba(251,146,60,.14);border:1px solid rgba(251,146,60,.22)}
.sui-wh-rent{color:#fde047;background:rgba(250,204,21,.12);border:1px solid rgba(250,204,21,.22)}
.sui-wh-free{color:#86efac;background:rgba(74,222,128,.12);border:1px solid rgba(74,222,128,.22)}
`;
  }

  // ── Torrent accordions ──────────────────────────────────────────────────────

  function isTorrentStream(el, box) {
    const name = getDirectAddonTitle(el);
    if (isExcludedAddon(name)) return false;
    if (el.classList.contains('sui-hidden-stream')) return false;

    const text = getStreamText(el);
    const full = `${name}\n${text}`;

    if (/👤/.test(text) && /💾/.test(text)) return true;
    if (/⚙️/.test(text)) return true;
    if (/🧲/.test(text)) return true;
    if (/✏️/.test(text) && /\b(4k|2160p|1080p|720p|WEB[- ]?DL|BluRay|REMUX)\b/i.test(text)) return true;
    if (/[🎥💿🎞️📺🎧]/.test(text) && /\b(4k|2160p|1080p|720p|480p|576p|WEB[- ]?DL|BluRay|BRRip|HDRip|REMUX)\b/i.test(text)) return true;
    if (/\[(?:RD|AD|PM|DL|TB|ED|UB|OFF|PK|EZ)[+\]\s]/i.test(full)) return true;
    if (/\b(4k|2160p|1080p|720p)\b/i.test(text) && /\b\d+(?:\.\d+)?\s*(?:GB|MB|TB)\b/i.test(text)) return true;
    if (/\[[^\]]*(?:1080p|720p|2160p|4k|WEB[- ]?DL|BluRay|HDR|HEVC|x265|x264)[^\]]*\]/i.test(full)) return true;

    return false;
  }

  const accordions = (() => {
    const GROUP = 'sui-aio-group';
    const OPEN_STATE_KEY = 'sui-open-accordions';
    const ALL_SEL = `.${GROUP}[data-sui-acc]`;
    let lastSig = '';
    let timer = null;
    let obs = null;

    function unpack(group) {
      const body = group.querySelector('.sui-aio-body');
      const parent = group.parentElement;
      if (!body || !parent) {
        group.remove();
        return;
      }
      for (const stream of Array.from(body.children)) {
        if (stream.nodeType === 1) parent.insertBefore(stream, group);
      }
      group.remove();
    }

    function teardown() {
      document.querySelectorAll(ALL_SEL).forEach(unpack);
      lastSig = '';
      if (obs) {
        obs.disconnect();
        obs = null;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function collectWatchHubGroups() {
      return [];
    }

    function collectAllGroups(box) {
      const groups = [];
      if (state.torrent) {
        groups.push(...collectTorrentGroups(box).map((g) => ({ ...g, type: 'torrent', icon: '▶' })));
      }
      groups.push(...collectWatchHubGroups(box));
      groups.sort((a, b) => (a.firstIdx ?? 0) - (b.firstIdx ?? 0));
      return groups;
    }

    function sig(box) {
      return collectAllGroups(box)
        .map((g) => `${g.type}:${g.name}:${g.streams.length}:${g.streams.map((el) => getStreamText(el).slice(0, 24)).join(';')}`)
        .join('|');
    }

    function readOpenStateMap() {
      try {
        const raw = sessionStorage.getItem(OPEN_STATE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (_) {
        return {};
      }
    }

    function writeOpenStateMap(map) {
      try {
        sessionStorage.setItem(OPEN_STATE_KEY, JSON.stringify(map || {}));
      } catch (_) {}
    }

    function accordionStateKey(type, name) {
      const t = String(type || '').trim().toLowerCase();
      const n = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!t || !n) return '';
      return `${t}:${n}`;
    }

    function collectOpenKeys() {
      const states = new Map();
      const map = readOpenStateMap();
      Object.entries(map).forEach(([key, value]) => {
        if (typeof key !== 'string' || !key) return;
        if (typeof value !== 'boolean') return;
        states.set(key, value);
      });
      return states;
    }

    function setAccordionOpenState(type, name, isOpen) {
      const stateKey = accordionStateKey(type, name);
      if (!stateKey) return;
      const map = readOpenStateMap();
      map[stateKey] = Boolean(isOpen);
      writeOpenStateMap(map);
    }

    function classifyForAccordion(el, box) {
      if (!state.torrent || !shouldGroupAsTorrent(el, box)) return null;
      const name = getDirectAddonTitle(el);
      if (!name || !isTorrentGroup(name, [el], box)) return null;
      return { type: 'torrent', name };
    }

    function findAccordion(type, name) {
      return [...document.querySelectorAll(ALL_SEL)].find((acc) => {
        return acc.getAttribute('data-sui-acc') === type && acc.querySelector('.sui-aio-name')?.textContent?.trim() === name;
      }) || null;
    }

    function accordionSubLabel(type, count) {
      return count === 1 ? '1 Stream gefunden' : `${count} Streams gefunden`;
    }

    function updateAccordionCounts() {
      document.querySelectorAll(ALL_SEL).forEach((acc) => {
        const body = acc.querySelector('.sui-aio-body');
        const count = body ? Array.from(body.children).filter((n) => n.nodeType === 1).length : 0;
        const type = acc.getAttribute('data-sui-acc') || '';
        const badge = acc.querySelector('.sui-aio-badge');
        const sub = acc.querySelector('.sui-aio-sub');
        if (badge) badge.textContent = String(count);
        if (sub) sub.textContent = accordionSubLabel(type, count);
      });
    }

    function repackOrphans(box) {
      let moved = false;
      let missingAccordion = false;

      for (const el of visibleLinks(box)) {
        if (el.closest('.sui-aio-body')) continue;
        if (!getDirectAddonTitle(el)) continue;
        const meta = classifyForAccordion(el, box);
        if (!meta) continue;
        const acc = findAccordion(meta.type, meta.name);
        if (!acc) {
          missingAccordion = true;
          continue;
        }
        const body = acc.querySelector('.sui-aio-body');
        if (!body || !el.isConnected) continue;
        body.appendChild(el);
        moved = true;
      }

      if (missingAccordion) {
        lastSig = '';
        build(box);
        return true;
      }

      if (moved) updateAccordionCounts();
      return moved;
    }

    function redistribute(box) {
      let changed = false;
      let needsRebuild = false;

      for (const acc of document.querySelectorAll(ALL_SEL)) {
        const accName = acc.querySelector('.sui-aio-name')?.textContent?.trim() || '';
        const body = acc.querySelector('.sui-aio-body');
        if (!body) continue;

        for (const stream of Array.from(body.children)) {
          if (stream.nodeType !== 1) continue;
          const direct = getDirectAddonTitle(stream);
          if (!direct) continue;
          if (direct === accName) continue;

          const target = findAccordion('torrent', direct);
          if (target) {
            target.querySelector('.sui-aio-body')?.appendChild(stream);
            changed = true;
          } else {
            needsRebuild = true;
          }
        }
      }

      if (needsRebuild) {
        lastSig = '';
        build(box);
        return true;
      }

      if (repackOrphans(box)) changed = true;
      if (changed) updateAccordionCounts();
      return changed;
    }

    function scheduleRebuild(box) {
      if (timer) clearTimeout(timer);
      const delay = streamsLoading() ? 120 : 250;
      timer = setTimeout(() => {
        timer = null;
        if (sig(box) !== lastSig) build(box);
      }, delay);
    }

    function shell(meta, open) {
      const { name, streams, type, icon } = meta;
      const count = streams.length;
      const shouldOpen = open === true;
      const acc = document.createElement('div');
      acc.className = GROUP + (shouldOpen ? ' open' : '');
      acc.setAttribute('data-sui-acc', type);
      const sub = accordionSubLabel(type, count);
      acc.innerHTML = `
<div class="sui-aio-header" role="button" tabindex="0" aria-expanded="${shouldOpen ? 'true' : 'false'}">
  <div class="sui-aio-icon">${icon}</div>
  <div class="sui-aio-meta"><div class="sui-aio-name">${esc(name)}</div><div class="sui-aio-sub">${esc(sub)}</div></div>
  <span class="sui-aio-badge">${count}</span><span class="sui-aio-caret">▾</span>
</div><div class="sui-aio-body"></div>`;
      const header = acc.querySelector('.sui-aio-header');
      const toggle = () => {
        const isOpen = acc.classList.toggle('open');
        header.setAttribute('aria-expanded', String(isOpen));
        setAccordionOpenState(type, name, isOpen);
      };
      header.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      });
      header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
      return acc;
    }

    function build(box) {
      const groups = collectAllGroups(box);
      const newSig = sig(box);

      if (!groups.length) {
        if (!streamsLoading() && document.querySelector(ALL_SEL)) teardown();
        return;
      }

      if (newSig === lastSig && document.querySelector(ALL_SEL)) {
        redistribute(box);
        return;
      }

      const openKeys = collectOpenKeys();
      teardown();

      for (let i = groups.length - 1; i >= 0; i--) {
        const meta = groups[i];
        const anchor = meta.streams.find((el) => el.isConnected && el.parentElement);
        if (!anchor?.parentElement) continue;
        const stateKey = accordionStateKey(meta.type, meta.name);
        const isOpen = stateKey ? openKeys.get(stateKey) : undefined;
        const acc = shell(meta, isOpen);
        anchor.parentElement.insertBefore(acc, anchor);
        const body = acc.querySelector('.sui-aio-body');
        for (const stream of meta.streams) {
          if (stream.isConnected) body.appendChild(stream);
        }
      }

      redistribute(box);
      lastSig = sig(box);
      if (!obs) {
        let mutTimer = null;
        obs = new MutationObserver(() => {
          if (mutTimer) clearTimeout(mutTimer);
          mutTimer = setTimeout(() => {
            mutTimer = null;
            if (redistribute(box)) {
              lastSig = sig(box);
              return;
            }
            if (sig(box) !== lastSig) scheduleRebuild(box);
          }, 80);
        });
        obs.observe(box, { childList: true, subtree: true });
      }
    }

    return { build, teardown, repackOrphans, redistribute };
  })();

  // ── Ratings panel factory ───────────────────────────────────────────────────

  const RATING_ICONS = {
    imdb: `<svg viewBox="0 0 24 24"><path fill="#f5c518" d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>`,
    tmdb: `<svg viewBox="0 0 24 24"><path fill="#b19cd9" d="M6 4h3.2l1.4 7.2L12.2 4H15l-2.2 11.2L17 20h-3.1l-1.5-7.4L10.8 20H7.6L6 4zm8.5 0H20v16h-2.8V4h-2.7z"/></svg>`,
    rt: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#fa320a"/><ellipse cx="12" cy="13" rx="5" ry="4" fill="#7cb342" opacity=".85"/></svg>`,
    metacritic: `<svg viewBox="0 0 24 24"><path fill="#4a9eff" d="M12 2 3 7v10l9 5 9-5V7l-9-5zm0 2.3 6.2 3.4v6.6L12 18.7 5.8 14.3V7.7L12 4.3z"/><text x="12" y="15.5" text-anchor="middle" font-size="9" font-weight="800" fill="#fff">M</text></svg>`,
    mcusers: `<svg viewBox="0 0 24 24"><circle cx="9" cy="9" r="3.2" fill="#b19cd9"/><circle cx="16.5" cy="10" r="2.6" fill="#b19cd9" opacity=".75"/><path fill="#b19cd9" d="M3.5 19c0-3 2.8-5 5.5-5s5.5 2 5.5 5v1H3.5v-1zm9 1v-1c0-2.2 1.6-4 3.8-4.7.6 1.5.9 3.1.9 4.7h-4.7z"/></svg>`,
    episode: `<svg viewBox="0 0 24 24"><path fill="#f5c518" d="M8 5v14l11-7z"/></svg>`,
    series: `<svg viewBox="0 0 24 24"><path fill="#93c5fd" d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h10v2H4v-2z"/></svg>`,
  };

  function ratingCard(r) {
    if (r.kind === 'age') {
      return `<div class="sui-rc-card"><div class="sui-rc-top"><span class="sui-rc-age-box">${esc(r.value)}</span></div><div class="sui-rc-label">${esc(r.label)}</div></div>`;
    }
    const votes = r.votes ? `<div class="sui-rc-votes">${esc(r.votes)}</div>` : '';
    return `<div class="sui-rc-card"><div class="sui-rc-top"><span class="sui-rc-icon">${RATING_ICONS[r.key] || RATING_ICONS.imdb}</span><span class="sui-rc-value">${esc(r.value)}</span></div><div class="sui-rc-label">${esc(r.label)}</div>${votes}</div>`;
  }

  function ratingPanelHTML({ title, titleStacked, iconClass, iconChar, cards, panelClass }) {
    const titleBlock = titleStacked
      ? `<div class="sui-panel-title sui-panel-title-stacked">${titleStacked.map((line) => `<span>${esc(line)}</span>`).join('')}</div>`
      : `<div class="sui-panel-title">${esc(title)}</div>`;
    const iconCls = iconClass ? ` sui-panel-icon-${iconClass}` : '';
    return `<div class="sui-ratings-panel ${panelClass}">
<div class="sui-panel-hdr"><div class="sui-panel-icon${iconCls}">${iconChar}</div><div>${titleBlock}</div></div>
<div class="sui-ratings-row">${cards}</div></div>`;
  }

  const ratingsBundle = (() => {
    const ROOT = 'sui-ratings-bundle';
    const HIDE = 'sui-hidden-stream';
    let lastSig = '';
    let hideObs = null;
    let hideTimer = null;
    const hidden = new Set();

    function hideAll(streams) {
      for (const s of streams) {
        s.classList.add(HIDE);
        s.setAttribute('aria-hidden', 'true');
        hidden.add(s);
      }
    }

    function restore() {
      for (const s of hidden) {
        s.classList.remove(HIDE);
        s.removeAttribute('aria-hidden');
      }
      hidden.clear();
    }

    function teardown(reset) {
      document.getElementById(ROOT)?.remove();
      if (hideObs) {
        hideObs.disconnect();
        hideObs = null;
      }
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (reset) restore();
      lastSig = '';
    }

    function findAnchor(box, aggStreams, imdbStreams) {
      const allLinks = getStreamLinks(box);
      const candidates = [...aggStreams, ...imdbStreams].filter(Boolean);
      if (!candidates.length) return null;
      candidates.sort((a, b) => allLinks.indexOf(a) - allLinks.indexOf(b));
      return candidates[0];
    }

    function build(box) {
      const aggStreams = state.ratings ? getStreamLinks(box).filter(isAggregator) : [];
      const imdbStreams = state.imdb ? getStreamLinks(box).filter(isImdbRatings) : [];
      const allStreams = [...aggStreams, ...imdbStreams];

      if (!allStreams.length) {
        teardown(true);
        return;
      }

      const aggParsed = aggStreams.length ? parseAggregatorText(aggStreams.map(getStreamText).join('\n')) : [];
      const imdbParsed = imdbStreams.length ? parseImdbText(imdbStreams.map(getStreamText).join('\n')) : [];

      if (!aggParsed.length && !imdbParsed.length) {
        teardown(true);
        return;
      }

      const sig = [
        aggParsed.map((r) => `a:${r.key}:${r.value}`).join(','),
        imdbParsed.map((r) => `i:${r.key}:${r.value}`).join(','),
      ].join('|');

      if (sig === lastSig && document.getElementById(ROOT)) {
        hideAll(allStreams);
        return;
      }

      document.getElementById(ROOT)?.remove();

      const panels = [];
      if (state.ratings && aggParsed.length) {
        panels.push(ratingPanelHTML({
          title: 'Ratings',
          iconClass: 'purple',
          iconChar: '★',
          cards: aggParsed.map(ratingCard).join(''),
          panelClass: 'sui-ratings-main',
        }));
      }
      if (state.imdb && imdbParsed.length) {
        panels.push(ratingPanelHTML({
          titleStacked: ['Episode', 'Rating'],
          iconClass: 'gold',
          iconChar: '★',
          cards: imdbParsed.map(ratingCard).join(''),
          panelClass: 'sui-ratings-side',
        }));
      }

      const root = document.createElement('div');
      root.id = ROOT;
      root.innerHTML = `<div class="sui-ratings-bundle-row${panels.length > 1 ? ' has-both' : ''}">${panels.join('')}</div>`;
      box.insertBefore(root, getUiInsertAfterWatchHub(box));
      hideAll(allStreams);

      if (!hideObs) {
        hideObs = new MutationObserver(() => {
          if (hideTimer) clearTimeout(hideTimer);
          hideTimer = setTimeout(() => {
            hideTimer = null;
            const current = [
              ...(state.ratings ? getStreamLinks(box).filter(isAggregator) : []),
              ...(state.imdb ? getStreamLinks(box).filter(isImdbRatings) : []),
            ];
            hideAll(current);
          }, 60);
        });
        hideObs.observe(box, { childList: true, subtree: true });
      }
      lastSig = sig;
    }

    return { build, teardown };
  })();

  function cleanRatingLine(line) {
    return line.replace(/^[⭐🎥Ⓜ️👤🍅👶👪📺🔞❌❗]\s*/u, '').replace(/\s+/g, ' ').trim();
  }

  function parseAggregatorText(text) {
    const found = [];
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/^─+$/.test(l));
    for (const raw of lines) {
      const line = cleanRatingLine(raw);
      let m = line.match(/^(\d{1,2}\+?)$/);
      if (m) {
        found.push({ key: 'fsk', label: 'FSK', kind: 'age', value: m[1].endsWith('+') ? m[1] : `${m[1]}+` });
        continue;
      }
      m = line.match(/^imdb\s*:\s*(\d+(?:\.\d+)?)\s*(?:\/\s*10)?$/i);
      if (m) {
        found.push({ key: 'imdb', label: 'IMDb', kind: 'score', value: parseFloat(m[1]).toFixed(1) });
        continue;
      }
      m = line.match(/^tmdb\s*:\s*(\d+(?:\.\d+)?)\s*(?:\/\s*10)?$/i);
      if (m) {
        found.push({ key: 'tmdb', label: 'TMDb', kind: 'score', value: parseFloat(m[1]).toFixed(1) });
        continue;
      }
      m = line.match(/^mc\s*users\s*:\s*(\d+(?:\.\d+)?)\s*(?:\/\s*10)?$/i);
      if (m) {
        found.push({ key: 'mcusers', label: 'MC Users', kind: 'score', value: parseFloat(m[1]).toFixed(1) });
        continue;
      }
      m = line.match(/^mc\s*:\s*(\d{1,3})\s*(?:\/\s*100)?$/i);
      if (m) {
        found.push({ key: 'metacritic', label: 'Metacritic', kind: 'score', value: m[1] });
        continue;
      }
      m = line.match(/^rt\s*:\s*(\d{1,3})\s*(?:\/\s*100)?$/i);
      if (m) {
        found.push({ key: 'rt', label: 'Rotten Tomatoes', kind: 'percent', value: `${m[1]}%` });
      }
    }
    const order = ['fsk', 'imdb', 'tmdb', 'rt', 'metacritic', 'mcusers'];
    const by = Object.fromEntries(found.map((r) => [r.key, r]));
    return order.filter((k) => by[k]).map((k) => by[k]);
  }

  function parseImdbText(text) {
    const found = [];
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/^─+$/.test(l) && !/^❌/.test(l) && !/^❗/.test(l));
    for (const raw of lines) {
      const line = cleanRatingLine(raw);
      let m = line.match(/^mpaa\s*:\s*(.+)$/i);
      if (m) {
        found.push({ key: 'mpaa', label: 'MPAA', kind: 'age', value: m[1].trim() });
        continue;
      }
      m = line.match(/^episode\s*:\s*(\d+(?:\.\d+)?)(?:\s*\/\s*10)?/i);
      if (m) {
        found.push({ key: 'episode', label: 'Episode', kind: 'score', value: parseFloat(m[1]).toFixed(1) });
        continue;
      }
      m = line.match(/^series\s*:\s*(\d+(?:\.\d+)?)(?:\s*\/\s*10)?/i);
      if (m) {
        found.push({ key: 'series', label: 'Serie', kind: 'score', value: parseFloat(m[1]).toFixed(1) });
        continue;
      }
      m = line.match(/^imdb\s*:\s*(\d+(?:\.\d+)?)(?:\s*\/\s*10)?/i);
      if (m) {
        found.push({ key: 'imdb', label: 'IMDb', kind: 'score', value: parseFloat(m[1]).toFixed(1) });
        continue;
      }
      m = line.match(/^(\d+(?:\.\d+)?)\s*\/\s*10$/);
      if (m) {
        found.push({ key: 'imdb', label: 'IMDb', kind: 'score', value: parseFloat(m[1]).toFixed(1) });
        continue;
      }
      m = line.match(/^\(?([\d.,]+[kKmM]?)\s*votes?\)?$/i);
      if (m && found.length) {
        const last = found[found.length - 1];
        if (!last.votes) last.votes = m[1];
      }
    }
    const order = ['mpaa', 'imdb', 'episode', 'series'];
    const by = Object.fromEntries(found.map((r) => [r.key, r]));
    return order.filter((k) => by[k]).map((k) => by[k]);
  }

  function isAggregator(el) {
    if (/ratings?\s*aggregator|aggregator/i.test(getAddonName(el))) return true;
    const cleaned = getStreamText(el).split('\n').map(cleanRatingLine);
    return cleaned.some((l) => /^imdb\s*:/i.test(l)) && (cleaned.some((l) => /^mc\s*:/i.test(l)) || cleaned.some((l) => /^rt\s*:/i.test(l)));
  }

  function isImdbRatings(el) {
    const name = getAddonName(el);
    if (/after\s*credits?/i.test(name)) return false;
    if (/ratings?\s*aggregator|aggregator/i.test(name)) return false;
    if (/imdb\s*ratings?/i.test(name)) return true;
    const text = getStreamText(el);
    if (/⭐\s*(imdb|episode)\s*:/i.test(text)) return true;
    if (/📺\s*series\s*:/i.test(text) && /\d/.test(text)) return true;
    return /^\d+(?:\.\d+)?\s*\/\s*10$/m.test(text) && /imdb/i.test(name);
  }

  // ── AfterCredits ───────────────────────────────────────────────────────────

  function isAfterCredits(el) {
    return /after\s*credits?/i.test(getAddonName(el));
  }

  function parseAfterCreditsText(el) {
    const label = getStreamLabel(el).trim();
    const desc = getStreamText(el);
    const lines = desc.split('\n').map((l) => l.trim()).filter(Boolean);
    const content = lines.filter((l) => !/^after\s*credits?$/i.test(l));
    let text = content.join(' · ') || desc.trim();
    if (!text || /^after\s*credits?$/i.test(text)) text = label || 'No information';
    if (/^after\s*credits?$/i.test(text)) text = 'No Stingers Found';
    const noStinger = /no\s*stingers?\s*found/i.test(text);
    const hasStinger = !noStinger && (/stinger|mid-?credit|post-?credit|during\s*credit|after\s*credit/i.test(text) || text.length > 0);
    return { text, noStinger, hasStinger: hasStinger && !noStinger, el };
  }

  const afterCredits = (() => {
    const ROOT = 'sui-aftercredits-root';
    const HIDE = 'sui-hidden-stream';
    const AC_RE = /after\s*credits?/i;
    let lastSig = '';
    let timer = null;
    let obs = null;
    const hidden = new Set();

    function hideAll(streams) {
      for (const s of streams) {
        s.classList.add(HIDE);
        hidden.add(s);
      }
    }

    function restore() {
      for (const s of hidden) s.classList.remove(HIDE);
      hidden.clear();
    }

    function collect(box) {
      const items = [];
      const seen = new Set();
      for (const el of getStreamLinks(box).filter((l) => AC_RE.test(getAddonName(l)))) {
        const parsed = parseAfterCreditsText(el);
        if (!parsed.text || seen.has(parsed.text)) continue;
        seen.add(parsed.text);
        items.push(parsed);
      }
      return items;
    }

    function messageRow(item) {
      const cls = item.hasStinger ? 'has-stinger' : item.noStinger ? 'no-stinger' : '';
      return `<div class="sui-ac-message ${cls}">${esc(item.text)}</div>`;
    }

    function teardown(reset) {
      document.getElementById(ROOT)?.remove();
      if (obs) {
        obs.disconnect();
        obs = null;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (reset) restore();
      lastSig = '';
    }

    function build(box) {
      const acStreams = getStreamLinks(box).filter((l) => AC_RE.test(getAddonName(l)));
      if (!acStreams.length) {
        teardown(true);
        return;
      }
      const items = collect(box);
      if (!items.length) {
        teardown(true);
        return;
      }
      const sig = items.map((p) => `${p.text}:${p.hasStinger}`).join('|');
      if (sig === lastSig && document.getElementById(ROOT)) {
        hideAll(acStreams);
        return;
      }
      document.getElementById(ROOT)?.remove();
      hideAll(acStreams);
      const root = document.createElement('div');
      root.id = ROOT;
      const sub = items.length === 1 && items[0].noStinger
        ? 'Keine Szenen nach dem Abspann'
        : items.length === 1 && items[0].hasStinger
          ? 'Szenen nach dem Abspann'
          : `${items.length} Hinweis${items.length === 1 ? '' : 'e'}`;
      root.innerHTML = `
<div class="sui-panel-hdr"><div class="sui-panel-icon">🎬</div><div><div class="sui-panel-title">After Credits</div><div class="sui-panel-sub">${esc(sub)}</div></div></div>
<div class="sui-ac-list">${items.map(messageRow).join('')}</div>`;
      box.insertBefore(root, getStreamsBoxTopAnchor(box));
      if (!obs) {
        obs = new MutationObserver(() => {
          const current = getStreamLinks(box).filter((l) => AC_RE.test(getAddonName(l)));
          const nextSig = collect(box).map((p) => `${p.text}:${p.hasStinger}`).join('|');
          if (nextSig !== lastSig) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => build(box), 300);
          } else hideAll(current);
        });
        obs.observe(box, { childList: true, subtree: true });
      }
      lastSig = sig;
    }

    return { build, teardown };
  })();

  // ── WatchHub ───────────────────────────────────────────────────────────────

  const watchhub = (() => {
    const ROOT = 'sui-watchhub-root';
    const HIDE = 'sui-hidden-stream';
    const OPEN_KEY = 'sui-watchhub-open';
    const WH_RE = /watch\s*hub|guidebox/i;
    const TYPE_RE = /^(subscription|buy|rent|free|ads|stream|flatrate|purchase)$/i;
    const CDN = 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/svg';
    const PROVIDERS = {
      netflix: { slug: 'netflix', color: '#e50914' },
      'amazon video': { slug: 'amazon-prime', color: '#00a8e1' },
      'amazon prime': { slug: 'amazon-prime', color: '#00a8e1' },
      'prime video': { slug: 'amazon-prime', color: '#00a8e1' },
      'google play movies': { slug: 'google-play', color: '#34a853' },
      'google play': { slug: 'google-play', color: '#34a853' },
      'disney+': { slug: 'disneyplus', color: '#113ccf' },
      disney: { slug: 'disneyplus', color: '#113ccf' },
      hulu: { slug: 'hulu', color: '#1ce783' },
      'apple tv': { slug: 'appletv', color: '#000' },
      'apple tv+': { slug: 'appletv', color: '#000' },
      'hbo max': { slug: 'hbo-max', color: '#b535f6' },
      hbo: { slug: 'hbo', color: '#000' },
      'paramount+': { slug: 'paramount-plus', color: '#0064ff' },
      paramount: { slug: 'paramount-plus', color: '#0064ff' },
      peacock: { slug: 'peacock', color: '#000' },
      youtube: { slug: 'youtube', color: '#ff0000' },
      crunchyroll: { slug: 'crunchyroll', color: '#f47521' },
    };
    const BADGE = {
      subscription: { label: 'Abo', cls: 'sui-wh-sub' },
      flatrate: { label: 'Abo', cls: 'sui-wh-sub' },
      buy: { label: 'Kaufen', cls: 'sui-wh-buy' },
      purchase: { label: 'Kaufen', cls: 'sui-wh-buy' },
      rent: { label: 'Leihen', cls: 'sui-wh-rent' },
      free: { label: 'Gratis', cls: 'sui-wh-free' },
      ads: { label: 'Werbung', cls: 'sui-wh-free' },
      stream: { label: 'Stream', cls: 'sui-wh-sub' },
    };

    let lastSig = '';
    let obs = null;
    let timer = null;
    const hidden = new Set();

    function isOpen() {
      try {
        return sessionStorage.getItem(OPEN_KEY) === 'true';
      } catch (_) {
        return false;
      }
    }

    function setOpen(open) {
      try {
        sessionStorage.setItem(OPEN_KEY, open ? 'true' : 'false');
      } catch (_) {}
    }

    function normType(raw) {
      const t = String(raw || '').trim().toLowerCase();
      if (!t) return 'stream';
      if (t.includes('subscr') || t === 'flatrate') return 'subscription';
      if (t.includes('buy') || t.includes('purchase')) return 'buy';
      if (t.includes('rent')) return 'rent';
      if (t.includes('ads')) return 'ads';
      if (t.includes('free')) return 'free';
      return t;
    }

    function resolve(name) {
      const key = name.toLowerCase().trim();
      if (PROVIDERS[key]) return PROVIDERS[key];
      for (const [k, v] of Object.entries(PROVIDERS)) {
        if (key.includes(k) || k.includes(key)) return v;
      }
      return { slug: null, color: '#64748b' };
    }

    function parseSingle(el) {
      const nameEl = el.querySelector('[class*="addon-name-"]');
      const descEl = el.querySelector('[class*="description-container-"]');
      const nameLines = (nameEl?.textContent || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
      const descLines = (descEl?.textContent || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
      let service = nameLines[0] || '';
      let type = descLines[0] || '';
      if (WH_RE.test(service) && descLines.length >= 2) {
        service = descLines[0];
        type = descLines[1];
      }
      if (!service && descLines.length) {
        service = descLines[0];
        type = descLines[1] || type;
      }
      const inline = `${service} ${type}`.trim();
      const m = inline.match(/^(.+?)\s+(subscription|buy|rent|free|ads|stream|flatrate|purchase)$/i);
      if (m) {
        service = m[1].trim();
        type = m[2];
      }
      if (!service || WH_RE.test(service)) return null;
      return { name: service, type: normType(type), el };
    }

    function parseMulti(text, el) {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const items = [];
      for (const line of lines) {
        if (TYPE_RE.test(line) && items.length) {
          items[items.length - 1].type = normType(line);
          continue;
        }
        const pair = line.match(/^(.+?)\s+(subscription|buy|rent|free|ads|stream|flatrate|purchase)$/i);
        if (pair) {
          items.push({ name: pair[1].trim(), type: normType(pair[2]), el });
          continue;
        }
        if (!TYPE_RE.test(line) && !WH_RE.test(line)) items.push({ name: line, type: '', el });
      }
      return items.filter((p) => p.name);
    }

    function parseStream(el) {
      const desc = el.querySelector('[class*="description-container-"]')?.textContent.trim() || '';
      const multi = parseMulti(desc, el);
      if (multi.length > 1) return multi;
      const single = parseSingle(el);
      return single ? [single] : multi;
    }

    function collect(box) {
      const items = [];
      for (const el of getStreamLinks(box).filter((l) => isWatchHubStream(l))) {
        items.push(...parseStream(el));
      }
      const seen = new Set();
      return items.filter((p) => {
        const k = `${p.name}|${p.type}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    function hideAll(streams) {
      for (const s of streams) {
        s.classList.add(HIDE);
        hidden.add(s);
      }
    }

    function restore() {
      for (const s of hidden) s.classList.remove(HIDE);
      hidden.clear();
    }

    function row(p, i) {
      const meta = resolve(p.name);
      const src = meta.slug ? `${CDN}/${meta.slug}.svg` : null;
      const initial = (p.name.replace(/[^a-zA-Z0-9]/g, '') || '?')[0].toUpperCase();
      const b = BADGE[p.type] || { label: p.type || 'Stream', cls: 'sui-wh-sub' };
      const logo = src
        ? `<img class="sui-wh-logo" src="${src}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="sui-wh-logo-fb" style="display:none;background:${meta.color}">${esc(initial)}</span>`
        : `<span class="sui-wh-logo-fb" style="background:${meta.color}">${esc(initial)}</span>`;
      return `<div class="sui-wh-row" data-sui-wh="${i}"><div class="sui-wh-logo-wrap">${logo}</div><div class="sui-wh-name">${esc(p.name)}</div><span class="sui-wh-badge ${b.cls}">${esc(b.label)}</span></div>`;
    }

    function teardown(reset) {
      document.getElementById(ROOT)?.remove();
      if (obs) {
        obs.disconnect();
        obs = null;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (reset) restore();
      lastSig = '';
    }

    function build(box) {
      const whStreams = getStreamLinks(box).filter((l) => isWatchHubStream(l));
      if (!whStreams.length) {
        teardown(true);
        return;
      }
      const providers = collect(box);
      if (!providers.length) {
        teardown(true);
        return;
      }
      const sig = providers.map((p) => `${p.name}:${p.type}`).join('|');
      if (sig === lastSig && document.getElementById(ROOT)) {
        hideAll(whStreams);
        return;
      }
      document.getElementById(ROOT)?.remove();
      hideAll(whStreams);
      const root = document.createElement('div');
      root.id = ROOT;
      root.classList.toggle('open', isOpen());
      root.innerHTML = `
<div class="sui-watchhub-header" role="button" tabindex="0" aria-expanded="${isOpen() ? 'true' : 'false'}">
  <div class="sui-panel-icon">▶</div>
  <div class="sui-watchhub-meta">
    <div class="sui-panel-title">Verfügbar bei</div>
    <div class="sui-panel-sub">${providers.length} Streaming-Dienst${providers.length === 1 ? '' : 'e'}</div>
  </div>
  <span class="sui-watchhub-badge">${providers.length}</span>
  <span class="sui-watchhub-caret">▾</span>
</div>
<div class="sui-watchhub-body"><div class="sui-wh-list">${providers.map(row).join('')}</div></div>`;
      box.insertBefore(root, getUiInsertAfterAfterCredits(box));
      const header = root.querySelector('.sui-watchhub-header');
      const toggle = () => {
        const open = !root.classList.contains('open');
        root.classList.toggle('open', open);
        if (header) header.setAttribute('aria-expanded', String(open));
        setOpen(open);
      };
      header?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      });
      header?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
      root.addEventListener('click', (e) => {
        const r = e.target.closest('[data-sui-wh]');
        if (!r) return;
        e.preventDefault();
        e.stopPropagation();
        const p = providers[parseInt(r.getAttribute('data-sui-wh'), 10)];
        if (p?.el) p.el.click();
      });
      if (!obs) {
        obs = new MutationObserver(() => {
          const current = getStreamLinks(box).filter((l) => isWatchHubStream(l));
          if (collect(box).map((p) => `${p.name}:${p.type}`).join('|') !== lastSig) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => build(box), 400);
          } else hideAll(current);
        });
        obs.observe(box, { childList: true, subtree: true });
      }
      lastSig = sig;
    }

    return { build, teardown };
  })();

  // ── Orchestrator ───────────────────────────────────────────────────────────

  function teardownAll(reset) {
    accordions.teardown();
    ratingsBundle.teardown(reset);
    watchhub.teardown(reset);
    afterCredits.teardown(reset);
    state.lastBox = null;
  }

  function tick() {
    if (window.stremioCustomSuspendBackground?.()) return;
    if (!/#\/detail|#\/meta/.test(location.hash || '') && !document.querySelector('[class*="streams-list-"]')) {
      return;
    }

    const contentKey = getContentKey();
    if (contentKey !== state.contentKey) {
      teardownAll(true);
      state.contentKey = contentKey;
    }

    if (!state.ready) return;

    const box = findStreamsBox();
    if (!box) {
      teardownAll(true);
      return;
    }

    if (box !== state.lastBox) {
      accordions.teardown();
      state.lastBox = box;
    }

    if (state.aftercredits) afterCredits.build(box);
    else afterCredits.teardown(true);

    if (state.watchhub) watchhub.build(box);
    else watchhub.teardown(true);

    ratingsBundle.build(box);

    if (state.torrent) accordions.build(box);
    else accordions.teardown();
  }

  async function init() {
    injectCSS();
    await loadSettings();

    const a = api();
    if (a?.onSettingsSaved) {
      a.onSettingsSaved(async () => {
        await loadSettings();
        teardownAll(true);
        tick();
      });
    }

    setInterval(tick, 900);
  }

  init();
})();
