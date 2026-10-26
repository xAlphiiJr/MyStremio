(function (root, factory) {
  'use strict';

  const api = factory();
  if (root) root.StremioCustomQuickPlay = api;
  if (!root && typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const RES_KEY = 'stremio-custom-quick-play-resolution';
  const QUAL_KEY = 'stremio-custom-quick-play-quality';

  const RESOLUTIONS = [
    { id: '4320p', label: '8K (4320p)', height: 4320 },
    { id: '2160p', label: '4K (2160p)', height: 2160 },
    { id: '1440p', label: '2K (1440p)', height: 1440 },
    { id: '1080p', label: '1080p', height: 1080 },
    { id: '720p', label: '720p', height: 720 },
    { id: '576p', label: '576p', height: 576 },
    { id: '480p', label: '480p', height: 480 },
    { id: '360p', label: '360p', height: 360 },
  ];
  const QUALITIES = [
    { id: 'dv', label: 'Dolby Vision', re: /\b(dv|dovi|dolby[\s.-]?vision)\b/i },
    { id: 'hdr', label: 'HDR', re: /\bhdr(10)?\b/i },
    { id: 'remux', label: 'Remux', re: /remux/i },
    { id: 'bluray', label: 'BluRay', re: /blu-?ray/i },
    { id: 'bdrip', label: 'BDRip / BRRip', re: /\b(bd|br)-?rip\b/i },
    { id: 'webdl', label: 'WEB-DL', re: /web-?dl/i },
    { id: 'webrip', label: 'WEBRip', re: /web-?rip/i },
    { id: 'hdrip', label: 'HDRip', re: /\bhd-?rip\b/i },
    { id: 'hdtv', label: 'HDTV', re: /\bhdtv\b/i },
    { id: 'dvdrip', label: 'DVDRip', re: /\bdvd-?rip\b/i },
  ];
  const RES_HEIGHT = Object.fromEntries(RESOLUTIONS.map((item) => [item.id, item.height]));
  const QUAL_INDEX = Object.fromEntries(QUALITIES.map((item, index) => [item.id, index]));
  const LANGS = {
    ger: /\b(german|deutsch|ger|deu)\b|🇩🇪/i,
    eng: /\b(english|eng)\b|🇬🇧|🇺🇸/i,
    jpn: /\b(japanese|jpn|jap)\b|🇯🇵/i,
    fre: /\b(french|fran[cç]ais|truefrench|vff|fre|fra)\b|🇫🇷/i,
    spa: /\b(spanish|espa[nñ]ol|castellano|latino|spa|esp)\b|🇪🇸|🇲🇽/i,
    ita: /\b(italian|italiano|ita)\b|🇮🇹/i,
    por: /\b(portuguese|portugu[eê]s|dublado|pt-?br|por)\b|🇵🇹|🇧🇷/i,
    rus: /\b(russian|rus)\b|🇷🇺/i,
    kor: /\b(korean|kor)\b|🇰🇷/i,
    zho: /\b(chinese|mandarin|chs|cht|chi|zho)\b|🇨🇳|🇹🇼/i,
    ara: /\b(arabic|ara)\b|🇸🇦/i,
    nld: /\b(dutch|nederlands|nld|dut)\b|🇳🇱/i,
    pol: /\b(polish|polski|pol)\b|🇵🇱/i,
    tur: /\b(turkish|t[uü]rk[cç]e|tur)\b|🇹🇷/i,
  };
  const ALIAS = {
    deu: 'ger', de: 'ger', fra: 'fre', fr: 'fre', dut: 'nld', nl: 'nld',
    chi: 'zho', zh: 'zho', en: 'eng', ja: 'jpn', es: 'spa', it: 'ita',
    pt: 'por', ru: 'rus', ko: 'kor', ar: 'ara', pl: 'pol', tr: 'tur', cs: 'ces', cz: 'ces',
  };
  const CAM_RE = /\b(cam|camrip|hdcam|ts|telesync|hdts|tc|telecine|scr|screener)\b/i;
  const UNCACHED_RE = /\bdownload\b|uncached|⏳/i;
  const MISS = 'No stream with the selected settings is available';

  let playToken = 0;

  function storage() {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (_) {
      return null;
    }
  }

  function allowedIds(kind) {
    return (kind === 'resolution' ? RESOLUTIONS : QUALITIES).map((item) => item.id);
  }

  function sanitize(kind, ids) {
    const allow = new Set(allowedIds(kind));
    const seen = new Set();
    const next = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      if (!allow.has(id) || seen.has(id)) continue;
      seen.add(id);
      next.push(id);
    }
    return allowedIds(kind).filter((id) => seen.has(id));
  }

  function readIds(kind) {
    const store = storage();
    const key = kind === 'resolution' ? RES_KEY : QUAL_KEY;
    if (!store) return kind === 'resolution' ? ['1080p'] : [];
    const raw = store.getItem(key);
    if (raw == null) return kind === 'resolution' ? ['1080p'] : [];
    try {
      return sanitize(kind, JSON.parse(raw));
    } catch (_) {
      return kind === 'resolution' ? ['1080p'] : [];
    }
  }

  function writeIds(kind, ids) {
    const store = storage();
    if (!store) return sanitize(kind, ids);
    const next = sanitize(kind, ids);
    store.setItem(kind === 'resolution' ? RES_KEY : QUAL_KEY, JSON.stringify(next));
    return next;
  }

  function readPrefs() {
    return { resolution: readIds('resolution'), quality: readIds('quality') };
  }

  function normLang(code) {
    if (!code) return null;
    const value = String(code).trim().toLowerCase();
    if (!value || value === 'none') return null;
    return ALIAS[value] || value;
  }

  function langName(code) {
    if (!code) return 'Any language';
    try {
      const names = (typeof window !== 'undefined' && window.__stremioLanguageNames) || {};
      return names[code] || code.toUpperCase();
    } catch (_) {
      return String(code).toUpperCase();
    }
  }

  function langRe(code) {
    if (LANGS[code]) return LANGS[code];
    const name = langName(code);
    if (!name || name === code.toUpperCase()) return null;
    return new RegExp(String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  function streamText(stream) {
    return [stream.name, stream.description, stream.title, stream.behaviorHints && stream.behaviorHints.filename]
      .filter(Boolean)
      .join(' ');
  }

  function detectHeight(text) {
    if (/\b(4320p|8k)\b/i.test(text)) return 4320;
    if (/\b(2160p|4k|uhd)\b/i.test(text)) return 2160;
    if (/\b(1440p|2k)\b/i.test(text)) return 1440;
    if (/\b(1080p|fhd)\b/i.test(text)) return 1080;
    if (/\b(720p|hd)\b/i.test(text)) return 720;
    if (/\b576p\b/i.test(text)) return 576;
    if (/\b(480p|sd)\b/i.test(text)) return 480;
    if (/\b360p\b/i.test(text)) return 360;
    return 0;
  }

  function matchesLang(text, code) {
    const re = langRe(code);
    if (re && re.test(text)) return 'exact';
    // A "Multi" release is not that language. The player picks the track afterwards.
    if (code === 'eng' && !Object.keys(LANGS).some((key) => key !== 'eng' && LANGS[key].test(text))) return 'exact';
    return null;
  }

  function rankRes(height, selectedIds) {
    const selected = selectedIds.map((id) => RES_HEIGHT[id]).filter(Boolean);
    if (!selected.length) return { tier: 0, penalty: height ? -height : 0 };
    // shortcut: unlabeled resolution is skipped once a resolution is selected
    if (!height) return null;
    if (selected.includes(height)) return { tier: 0, penalty: -height };
    const best = Math.max(...selected);
    if (height > best) return { tier: 1, penalty: height - best };
    return null;
  }

  function rankQual(text, selectedIds) {
    const hits = [];
    QUALITIES.forEach((item, index) => {
      if (item.re.test(text)) hits.push(index);
    });
    if (!selectedIds.length) {
      return { tier: 0, penalty: 0, qualityIndex: hits.length ? Math.min(...hits) : null };
    }
    const selected = selectedIds.map((id) => QUAL_INDEX[id]).filter((index) => index != null);
    if (!selected.length) return { tier: 0, penalty: 0, qualityIndex: null };
    const matched = hits.filter((index) => selected.includes(index));
    if (matched.length) {
      const qualityIndex = Math.min(...matched);
      return { tier: 0, penalty: qualityIndex, qualityIndex };
    }
    const best = Math.min(...selected);
    const better = hits.filter((index) => index < best);
    if (!better.length) return null;
    const closest = Math.max(...better);
    return { tier: 1, penalty: best - closest, qualityIndex: closest };
  }

  function worse(a, b) {
    const keys = ['langIndex', 'resTier', 'qualTier', 'langTier', 'resPenalty', 'qualPenalty', 'cam', 'uncached'];
    for (const key of keys) {
      if (a[key] !== b[key]) return a[key] > b[key];
    }
    return false;
  }

  function pickStream(streams, langs, resolutionIds, qualityIds) {
    let best = null;
    for (const stream of streams || []) {
      const text = streamText(stream);
      const height = detectHeight(text);
      const res = rankRes(height, resolutionIds);
      if (!res) continue;
      const qual = rankQual(text, qualityIds);
      if (!qual) continue;
      let langIndex = 0;
      let langTier = 0;
      if (langs && langs.length) {
        let found = -1;
        let tier = 0;
        for (let i = 0; i < langs.length; i += 1) {
          const hit = matchesLang(text, langs[i]);
          if (!hit) continue;
          found = i;
          tier = hit === 'multi' ? 1 : 0;
          break;
        }
        if (found < 0) continue;
        langIndex = found;
        langTier = tier;
      }
      const rank = {
        stream,
        height,
        langIndex,
        langTier,
        resTier: res.tier,
        resPenalty: res.penalty,
        qualTier: qual.tier,
        qualPenalty: qual.penalty,
        qualityIndex: qual.qualityIndex,
        cam: CAM_RE.test(text) ? 1 : 0,
        uncached: UNCACHED_RE.test(text) ? 1 : 0,
      };
      if (!best || worse(best, rank)) best = rank;
    }
    return best;
  }

  function isPerfect(picked, prefs) {
    if (!picked || picked.cam || picked.uncached || picked.langIndex || picked.langTier) return false;
    if (!prefs.resolution.length || picked.resTier) return false;
    const bestHeight = Math.max(...prefs.resolution.map((id) => RES_HEIGHT[id] || 0));
    if (picked.height !== bestHeight) return false;
    if (!prefs.quality.length) return true;
    if (picked.qualTier) return false;
    const bestQual = Math.min(...prefs.quality.map((id) => QUAL_INDEX[id]).filter((index) => index != null));
    return picked.qualityIndex === bestQual;
  }

  function heightLabel(height) {
    const item = RESOLUTIONS.find((entry) => entry.height === height);
    return item ? item.label : height + 'p';
  }

  function explain(picked, langs, prefs) {
    const reasons = [];
    if (langs.length && picked.langIndex > 0) {
      reasons.push('No ' + langName(langs[0]) + ' audio, using ' + langName(langs[picked.langIndex]));
    } else if (langs.length && picked.langTier > 0) {
      reasons.push('No ' + langName(langs[0]) + ' audio, using a multi-audio release');
    }
    if (prefs.resolution.length && picked.height) {
      const best = Math.max(...prefs.resolution.map((id) => RES_HEIGHT[id] || 0));
      if (picked.height !== best) {
        reasons.push('No ' + heightLabel(best) + ' available, playing ' + heightLabel(picked.height));
      }
    }
    if (prefs.quality.length && picked.qualTier) {
      const best = Math.min(...prefs.quality.map((id) => QUAL_INDEX[id]).filter((index) => index != null));
      const found = QUALITIES[picked.qualityIndex];
      reasons.push('No ' + QUALITIES[best].label + ' available, playing ' + (found ? found.label : 'another quality'));
    }
    if (picked.cam) reasons.push('Only CAM/TS releases available');
    if (picked.uncached) reasons.push('No cached stream available');
    return reasons;
  }

  function criteriaLabel(prefs, langs) {
    const res = prefs.resolution.length
      ? prefs.resolution.map((id) => RESOLUTIONS.find((item) => item.id === id).label).join(', ')
      : 'Any resolution';
    const qual = prefs.quality.length
      ? prefs.quality.map((id) => QUALITIES.find((item) => item.id === id).label).join(', ')
      : 'Any quality';
    const lang = langs.length ? langs.map(langName).join(', ') : 'Any language';
    return res + ' · ' + qual + ' · ' + lang;
  }

  async function languageOrder() {
    const order = [];
    const push = (code) => {
      const norm = normLang(code);
      if (norm && !order.includes(norm)) order.push(norm);
    };
    const store = storage();
    try {
      push(store && store.getItem('stremio-custom-active-audio'));
    } catch (_) {}
    if (!order.length) {
      try {
        const ctx = window.core && await window.core.getState('ctx');
        push(ctx && ctx.profile && ctx.profile.settings && ctx.profile.settings.audioLanguage);
      } catch (_) {}
    }
    try {
      const favs = JSON.parse((store && store.getItem('stremio-custom-fav-audio')) || '[]');
      (Array.isArray(favs) ? favs : []).forEach(push);
    } catch (_) {}
    return order;
  }

  function collect(state) {
    const list = [];
    (state.streams || []).forEach((group) => {
      if (!group.content || group.content.type !== 'Ready' || !Array.isArray(group.content.content)) return;
      const addon = group.addon && group.addon.manifest && group.addon.manifest.name;
      group.content.content.forEach((stream) => {
        if (stream && stream.deepLinks && stream.deepLinks.player && !stream.ytId && !stream.externalUrl && !stream.playerFrameUrl) {
          list.push({ stream, addon });
        }
      });
    });
    return list;
  }

  function pendingCount(state, type, id) {
    return (state.streams || []).filter((group) => {
      if (group.content && group.content.type && group.content.type !== 'Loading') return false;
      const resources = group.addon && group.addon.manifest && group.addon.manifest.resources;
      if (!resources || !resources.length) return true;
      return resources.some((resource) => {
        const name = typeof resource === 'string' ? resource : resource && resource.name;
        if (name !== 'stream') return false;
        if (typeof resource === 'string') return true;
        if (resource.types && resource.types.indexOf(type) < 0) return false;
        if (resource.idPrefixes && resource.idPrefixes.length && !resource.idPrefixes.some((prefix) => String(id).indexOf(prefix) === 0)) return false;
        return true;
      });
    }).length;
  }

  function playerHash(link) {
    if (link.indexOf('stremio:///') === 0) return '#/' + link.slice(11);
    if (link.charAt(0) === '#') return link;
    return '#' + link;
  }

  function bucketEntries(bucket) {
    if (!bucket) return [];
    if (Array.isArray(bucket)) return bucket;
    if (typeof bucket === 'object') {
      return Object.entries(bucket).map(([key, value]) => {
        if (value && typeof value === 'object' && !value.id) return { id: key, ...value };
        return value;
      });
    }
    return [];
  }

  function rowsOf(state) {
    if (!state) return [];
    return [
      state.items,
      state.libraryItems,
      state.library_items,
      state.catalog,
      state.catalog && state.catalog.content && state.catalog.content.content,
    ].flatMap(bucketEntries);
  }

  function matchesSeries(item, seriesId) {
    const want = String(seriesId || '').toLowerCase();
    if (!want || !item) return false;
    const ids = [item.id, item._id, item.content && item.content.id];
    return ids.some((value) => {
      if (value == null) return false;
      const lower = String(value).toLowerCase();
      if (lower === want || lower.endsWith(':' + want)) return true;
      const imdb = lower.match(/tt\d{7,8}/);
      return Boolean(imdb && imdb[0] === want);
    });
  }

  function videoIdOf(item) {
    if (!item || typeof item !== 'object') return null;
    const state = item.state || (item.libraryItem && item.libraryItem.state) || (item.content && item.content.state) || null;
    const fromState = state && (state.videoId || state.video_id);
    if (typeof fromState === 'string' && fromState) return fromState;
    const links = item.deepLinks || item.deep_links || {};
    const raw = [links.metaDetailsStreams, links.meta_details_streams, links.player].filter(Boolean).join(' ');
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch (_) {}
    const match = decoded.match(/tt\d{7,8}:\d+:\d+/i);
    return match ? match[0] : null;
  }

  function inProgress(state) {
    if (!state) return false;
    const offset = Number(state.timeOffset != null ? state.timeOffset : state.time_offset);
    const duration = Number(state.duration);
    if (!Number.isFinite(offset) || !Number.isFinite(duration) || duration <= 0) return false;
    const ratio = offset / duration;
    return ratio > 0.01 && ratio < 0.97;
  }

  function seasonEpisode(video) {
    const info = (video && (video.seriesInfo || video.series_info)) || {};
    const season = Number(video && video.season != null ? video.season : info.season);
    const episode = Number(video && video.episode != null ? video.episode : info.episode);
    return {
      season: Number.isFinite(season) ? season : -1,
      episode: Number.isFinite(episode) ? episode : -1,
    };
  }

  // Meta videos ship without library progress, so the first "unwatched" hit is episode 1.
  function pickEpisode(videos, resumeId) {
    const list = Array.isArray(videos) ? videos : [];
    if (resumeId) {
      const want = String(resumeId);
      const exact = list.find((item) => item && String(item.id).toLowerCase() === want.toLowerCase());
      if (exact) return exact.id;
      const se = want.match(/:(\d+):(\d+)$/);
      if (se) {
        const season = Number(se[1]);
        const episode = Number(se[2]);
        const byNumber = list.find((item) => {
          const pos = seasonEpisode(item);
          return pos.season === season && pos.episode === episode;
        });
        if (byNumber) return byNumber.id;
        return want;
      }
    }
    const video = list.find((item) => item && Number(item.progress) > 0 && !item.watched)
      || list.find((item) => item && !item.watched)
      || list[0];
    return video && video.id ? video.id : null;
  }

  function libraryEntries() {
    const store = storage();
    if (!store) return [];
    const out = [];
    for (const key of ['library', 'library_recent']) {
      let parsed = null;
      try { parsed = JSON.parse(store.getItem(key) || 'null'); } catch (_) { continue; }
      if (!parsed || typeof parsed !== 'object') continue;
      const bucket = Object.prototype.hasOwnProperty.call(parsed, 'items') ? parsed.items : parsed;
      out.push(...bucketEntries(bucket));
    }
    return out;
  }

  async function readModel(model) {
    try {
      const transport = window.services && window.services.core && window.services.core.transport;
      if (transport && transport.getState) return await transport.getState(model);
    } catch (_) {}
    try {
      if (window.core && window.core.getState) return await window.core.getState(model);
    } catch (_) {}
    return null;
  }

  async function resumeVideoId(seriesId, explicit) {
    if (explicit && explicit !== seriesId) return explicit;
    for (const model of ['continue_watching_preview', 'continue_watching']) {
      const hit = rowsOf(await readModel(model)).find((item) => matchesSeries(item, seriesId));
      const videoId = videoIdOf(hit);
      if (videoId && videoId !== seriesId) return videoId;
    }
    const stored = libraryEntries().find((item) => matchesSeries(item, seriesId) && inProgress(item.state));
    const videoId = videoIdOf(stored);
    return videoId && videoId !== seriesId ? videoId : null;
  }

  function selfCheck() {
    const videos = [
      { id: 'tt1:1:1', season: 1, episode: 1 },
      { id: 'tt1:2:3', season: 2, episode: 3 },
    ];
    if (pickEpisode(videos, 'tt1:2:3') !== 'tt1:2:3') throw new Error('resume id');
    if (pickEpisode(videos, 'other:2:3') !== 'tt1:2:3') throw new Error('season match');
    if (pickEpisode(videos, null) !== 'tt1:1:1') throw new Error('fallback');
    const item = { id: 'tt1', state: { videoId: 'tt1:2:3', timeOffset: 40, duration: 100 } };
    if (videoIdOf(item) !== 'tt1:2:3') throw new Error('videoId');
    if (!matchesSeries(item, 'tt1')) throw new Error('match');
    if (!inProgress(item.state)) throw new Error('partial');
    if (inProgress({ timeOffset: 99, duration: 100 })) throw new Error('finished');
  }

  async function resolve(title, isCancelled, onStatus) {
    const core = typeof window !== 'undefined' ? window.core : null;
    if (!core || !core.dispatch || !core.getState || !title || !title.id) {
      return { miss: true, label: 'No playable stream found', reasons: [], hold: 4000 };
    }
    const cancelled = () => (typeof isCancelled === 'function' ? isCancelled() : false);
    const status = (info) => {
      try { if (onStatus) onStatus(info); } catch (_) {}
    };
    const type = title.type || 'movie';
    const id = title.id;
    const load = (videoId) => core.dispatch({
      action: 'Load',
      args: {
        model: 'MetaDetails',
        args: {
          metaPath: { resource: 'meta', type, id, extra: [] },
          streamPath: videoId ? { resource: 'stream', type, id: videoId, extra: [] } : null,
          guessStream: false,
        },
      },
    }, 'meta_details');
    const wait = async (ready, ms) => {
      const end = Date.now() + ms;
      while (!cancelled()) {
        const state = await core.getState('meta_details');
        if (ready(state) || Date.now() > end) return state;
        await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      }
      return null;
    };

    const prefs = readPrefs();
    const langs = await languageOrder();
    const criteria = criteriaLabel(prefs, langs);
    status({ criteria });

    let videoId = id;
    if (type === 'series') {
      status('Finding the next episode…');
      const resumePromise = resumeVideoId(id, title.videoId);
      await load(null);
      const metaState = await wait((state) => {
        return state && state.selected && state.selected.metaPath && state.selected.metaPath.id === id
          && state.metaItem && state.metaItem.content && state.metaItem.content.type !== 'Loading';
      }, 15000);
      const meta = metaState && metaState.metaItem && metaState.metaItem.content && metaState.metaItem.content.type === 'Ready'
        ? metaState.metaItem.content.content
        : null;
      const videos = ((meta && meta.videos) || [])
        .filter((video) => !video.upcoming)
        .sort((a, b) => (a.season || 1000) - (b.season || 1000) || (a.episode || 0) - (b.episode || 0));
      const picked = pickEpisode(videos, await resumePromise);
      if (!picked) return { miss: true, label: 'No episode to play', criteria, reasons: [], hold: 4000 };
      videoId = picked;
    }

    await load(videoId);
    const openedAt = Date.now();
    const state = await wait((current) => {
      if (!current || !current.selected || !current.selected.streamPath || current.selected.streamPath.id !== videoId) return false;
      const total = (current.streams || []).length;
      const left = pendingCount(current, type, id);
      const list = collect(current);
      const hit = isPerfect(pickStream(list.map((entry) => entry.stream), langs, prefs.resolution, prefs.quality), prefs);
      if (hit || !left || Date.now() - openedAt >= 30000) {
        status({ progress: (total - left) + '/' + total, criteria });
        return true;
      }
      status({ progress: (total - left) + '/' + total, label: '', criteria });
      return false;
    }, 30000);
    if (!state || cancelled()) return null;

    const list = collect(state);
    const picked = pickStream(list.map((entry) => entry.stream), langs, prefs.resolution, prefs.quality);
    if (!picked) {
      return { miss: true, label: list.length ? MISS : 'No playable stream found', criteria, reasons: [], hold: 4000 };
    }

    const entry = list.find((item) => item.stream === picked.stream);
    const reasons = explain(picked, langs, prefs);
    const left = pendingCount(state, type, id);
    if (left && !isPerfect(picked, prefs)) {
      reasons.push(left + (left === 1 ? ' addon' : ' addons') + ' did not respond in time');
    }
    const link = picked.stream.deepLinks.player;
    const stepped = picked.resTier || picked.qualTier;
    return {
      hash: playerHash(link),
      file: (picked.stream.behaviorHints && picked.stream.behaviorHints.filename)
        || String(picked.stream.description || picked.stream.title || picked.stream.name || '').split('\n')[0],
      addon: entry && entry.addon,
      reasons,
      criteria,
      label: stepped ? 'Playing the next better stream' : (entry && entry.addon ? 'Playing via ' + entry.addon : 'Starting playback'),
      hold: reasons.length ? 4000 : 600,
      miss: false,
    };
  }

  function unload() {
    try { window.core.dispatch({ action: 'Unload' }, 'meta_details'); } catch (_) {}
  }

  function showLoader(title) {
    document.getElementById('mystremio-quick-play-loader')?.remove();
    const rootEl = document.createElement('div');
    rootEl.id = 'mystremio-quick-play-loader';
    rootEl.className = 'mystremio-hero-watch-loader';
    rootEl.setAttribute('role', 'status');
    if (title.background) {
      const bg = document.createElement('img');
      bg.className = 'mystremio-hero-watch-loader-bg';
      bg.src = title.background;
      bg.alt = '';
      rootEl.appendChild(bg);
    }
    if (title.logo) {
      const logo = document.createElement('img');
      logo.className = 'mystremio-hero-watch-loader-logo';
      logo.src = title.logo;
      logo.alt = title.title || title.name || '';
      rootEl.appendChild(logo);
    }
    const label = document.createElement('p');
    label.className = 'mystremio-hero-watch-loader-label';
    label.textContent = 'Finding the best stream…';
    const meta = document.createElement('p');
    meta.className = 'mystremio-hero-watch-loader-meta';
    const file = document.createElement('p');
    file.className = 'mystremio-hero-watch-loader-file';
    const reasons = document.createElement('ul');
    reasons.className = 'mystremio-hero-watch-loader-reasons';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'mystremio-hero-watch-loader-cancel';
    cancel.textContent = 'Cancel';
    rootEl.append(label, meta, file, reasons, cancel);
    document.body.appendChild(rootEl);
    return { root: rootEl, label, meta, file, reasons, cancel };
  }

  function paint(ui, info) {
    if (!ui.root.isConnected) return;
    if (typeof info === 'string') {
      ui.label.textContent = info;
      return;
    }
    if (info.label) ui.label.textContent = info.label;
    if (info.criteria) ui.meta.textContent = info.criteria;
    if (info.progress && !info.file) {
      ui.meta.textContent = info.criteria ? info.criteria + ' · ' + info.progress + ' addons' : info.progress + ' addons';
    }
    if (info.file) ui.file.textContent = info.file;
    ui.reasons.replaceChildren();
    (info.reasons || []).forEach((reason) => {
      const item = document.createElement('li');
      item.textContent = reason;
      ui.reasons.appendChild(item);
    });
  }

  function go(hash, title) {
    const splash = window.StremioCustomPlayerSplash;
    if (splash && splash.cacheArtwork) {
      splash.cacheArtwork({ id: title.id, background: title.background, logo: title.logo });
    }
    if (window.__stremioCustomMarkPlayIntent) window.__stremioCustomMarkPlayIntent();
    else {
      const intent = document.createElement('a');
      intent.setAttribute('href', '#/player/_');
      document.body.appendChild(intent);
      intent.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      intent.remove();
    }
    window.location.hash = hash;
  }

  async function play(title) {
    if (!title || !title.id) return;
    const token = ++playToken;
    const cancelled = () => token !== playToken;
    const ui = showLoader(title);
    ui.cancel.addEventListener('click', () => {
      playToken += 1;
      ui.root.remove();
      unload();
    });
    let result = null;
    try {
      result = await resolve(title, cancelled, (info) => { if (!cancelled()) paint(ui, info); });
    } catch (err) {
      console.warn('[QuickPlay] failed', err);
    }
    if (cancelled()) return;
    unload();
    if (!result || result.miss || !result.hash) {
      paint(ui, {
        label: (result && result.label) || MISS,
        criteria: result && result.criteria,
        reasons: (result && result.reasons) || [],
      });
      setTimeout(() => { if (!cancelled()) ui.root.remove(); }, (result && result.hold) || 4000);
      return;
    }
    paint(ui, result);
    setTimeout(() => {
      if (cancelled()) return;
      ui.root.remove();
      go(result.hash, title);
    }, result.hold || 600);
  }

  if (typeof window === 'undefined') selfCheck();

  return {
    RESOLUTIONS,
    QUALITIES,
    readIds,
    writeIds,
    readPrefs,
    pickStream,
    resolve,
    play,
  };
});
