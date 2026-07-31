/**
 * Native Cinemeta search suggestions (always-on shell module).
 * Dropdown is portaled to document.body and opens above the bottom search bar.
 *
 * Ranking: tiered exact/prefix first, then Damerau fuzzy fallback;
 * keyboard ↑/↓/Enter/Esc; recent picks from localStorage.
 */
(function () {
  'use strict';

  if (window.__mystremioSearchSuggestionsReady) return;
  window.__mystremioSearchSuggestionsReady = true;

  const STYLE_ID = 'mystremio-search-suggestions-styles';
  const ROOT_ID = 'mystremio-search-suggestions';
  const CINEMETA_CATALOG = 'https://v3-cinemeta.strem.io/catalog';
  const RECENT_KEY = 'mystremio_search_recent_v1';
  const DEBOUNCE_MS = 200;
  const MIN_QUERY = 2;
  const MAX_RESULTS = 10;
  const MAX_RECENT = 5;
  const STRONG_SCORE = 500;
  const STRONG_MIN = 3;

  let debounceTimer = null;
  let activeInput = null;
  let requestGen = 0;
  let activeIndex = -1;
  /** @type {object[]} */
  let currentMetas = [];
  /** @type {WeakSet<HTMLInputElement>} */
  const boundInputs = new WeakSet();
  let positionRaf = null;

  /**
   * @param {string} text
   * @returns {string}
   */
  function esc(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID}{
        position:fixed;left:0;width:min(420px,92vw);z-index:10050;
        max-height:min(50vh,380px);overflow:auto;
        overscroll-behavior:contain;
        border-radius:12px;padding:6px;
        background:rgba(18,18,22,.97);
        border:1px solid rgba(255,255,255,.12);
        box-shadow:0 -12px 40px rgba(0,0,0,.5);
        backdrop-filter:blur(14px) saturate(140%);
        display:none;
      }
      #${ROOT_ID}.open{display:block}
      #${ROOT_ID} .mss-item{
        display:flex;align-items:center;gap:10px;
        width:100%;padding:8px 10px;border:0;border-radius:9px;
        background:transparent;color:#fff;text-align:left;cursor:pointer;font:inherit;
      }
      #${ROOT_ID} .mss-item:hover,
      #${ROOT_ID} .mss-item:focus,
      #${ROOT_ID} .mss-item.active{background:rgba(255,255,255,.08);outline:none}
      #${ROOT_ID} .mss-poster{
        width:36px;height:54px;border-radius:6px;object-fit:cover;
        background:rgba(255,255,255,.06);flex:none;
      }
      #${ROOT_ID} .mss-meta{min-width:0;flex:1}
      #${ROOT_ID} .mss-title{
        font-size:13px;font-weight:650;line-height:1.25;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      }
      #${ROOT_ID} .mss-sub{margin-top:2px;font-size:11px;color:rgba(255,255,255,.45)}
      #${ROOT_ID} .mss-empty{padding:12px 10px;font-size:12px;color:rgba(255,255,255,.45)}
      #${ROOT_ID} .mss-section{
        padding:6px 10px 4px;font-size:10px;font-weight:700;letter-spacing:.04em;
        text-transform:uppercase;color:rgba(255,255,255,.35);
      }
    `;
    document.documentElement.appendChild(style);
  }

  /**
   * @returns {HTMLElement}
   */
  function ensureRoot() {
    ensureStyles();
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('role', 'listbox');
    document.body.appendChild(root);
    return root;
  }

  /**
   * @param {HTMLInputElement} input
   */
  function positionRoot(input) {
    const root = ensureRoot();
    const bar =
      input.closest('[class*="search-bar-container"]') ||
      input.closest('[class*="search-bar"]') ||
      input;
    const rect = bar.getBoundingClientRect();
    const width = Math.min(420, Math.max(rect.width, 280), window.innerWidth - 16);
    root.style.width = `${width}px`;
    root.style.left = `${Math.max(
      8,
      Math.min(rect.left + (rect.width - width) / 2, window.innerWidth - width - 8)
    )}px`;
    root.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
    root.style.top = 'auto';
  }

  function hide() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.classList.remove('open');
    root.innerHTML = '';
    activeIndex = -1;
    currentMetas = [];
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  function normalizeQuery(text) {
    return String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * @param {string} token
   * @returns {string[]}
   */
  function expandToken(token) {
    const t = String(token || '');
    if (!t) return [];
    const out = new Set([t]);
    const wordToDigit = {
      zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
      six: '6', seven: '7', eight: '8', nine: '9', null: '0',
      eins: '1', zwei: '2', drei: '3', vier: '4', fuenf: '5', funf: '5',
      sechs: '6', sieben: '7', acht: '8', neun: '9',
    };
    const digitToWord = {
      '0': ['zero', 'null'], '1': ['one', 'eins'], '2': ['two', 'zwei'],
      '3': ['three', 'drei'], '4': ['four', 'vier'], '5': ['five', 'fuenf', 'funf'],
      '6': ['six', 'sechs'], '7': ['seven', 'sieben'], '8': ['eight', 'acht'],
      '9': ['nine', 'neun'],
    };
    if (wordToDigit[t]) out.add(wordToDigit[t]);
    if (digitToWord[t]) digitToWord[t].forEach((w) => out.add(w));
    return [...out];
  }

  /**
   * @param {string} token
   * @returns {string}
   */
  function canonicalizeToken(token) {
    const t = String(token || '');
    if (!t) return '';
    const wordToDigit = {
      zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
      six: '6', seven: '7', eight: '8', nine: '9', null: '0',
      eins: '1', zwei: '2', drei: '3', vier: '4', fuenf: '5', funf: '5',
      sechs: '6', sieben: '7', acht: '8', neun: '9',
    };
    if (wordToDigit[t]) return wordToDigit[t];
    return t;
  }

  /**
   * @param {string} text
   * @returns {string[]}
   */
  function canonicalTokens(text) {
    return normalizeQuery(text)
      .split(' ')
      .filter(Boolean)
      .map(canonicalizeToken);
  }

  /** DE→EN title aliases for common search misses. */
  const DE_ALIASES = [
    { re: /\bfantastische\s*(4|vier|4er)\b/i, en: 'fantastic four' },
    { re: /\bherr\s+der\s+ringe\b/i, en: 'lord of the rings' },
    { re: /\bder\s+hobbit\b/i, en: 'the hobbit' },
    { re: /\bspiel\s+mir\s+das\s+lied\s+vom\s+tod\b/i, en: 'once upon a time in the west' },
    { re: /\bschindlers\s+liste\b/i, en: "schindler's list" },
    { re: /\bder\s+pate\b/i, en: 'the godfather' },
    { re: /\bkriegsstern\b|\bstern\s+der\s+kriege\b/i, en: 'star wars' },
    { re: /\bgeisterj(ä|ae)ger\b/i, en: 'ghostbusters' },
    { re: /\bindiana\s+jones\b/i, en: 'indiana jones' },
    { re: /\bzur(ü|ue)ck\s+in\s+die\s+zukunft\b/i, en: 'back to the future' },
  ];

  /**
   * @param {string} query
   * @returns {string[]}
   */
  function expandSearchQueries(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const out = [q];
    for (const alias of DE_ALIASES) {
      if (alias.re.test(q)) out.push(alias.en);
    }
    const norm = normalizeQuery(q);
    const parts = norm.split(' ').filter(Boolean);
    const toDigit = parts
      .map((tok) => {
        const alts = expandToken(tok);
        return alts.find((a) => a !== tok && /^\d+$/.test(a)) || tok;
      })
      .join(' ');
    if (toDigit && toDigit !== norm) out.push(toDigit);
    const toWordEn = parts
      .map((tok) => {
        const alts = expandToken(tok);
        return (
          alts.find(
            (a) =>
              a !== tok &&
              !/^\d+$/.test(a) &&
              !/^(null|eins|zwei|drei|vier|fuenf|funf|sechs|sieben|acht|neun)$/.test(a)
          ) || tok
        );
      })
      .join(' ');
    if (toWordEn && toWordEn !== norm) out.push(toWordEn);
    const toWordDe = parts
      .map((tok) => {
        if (!/^\d+$/.test(tok)) return tok;
        const de = {
          '0': 'null', '1': 'eins', '2': 'zwei', '3': 'drei', '4': 'vier',
          '5': 'fuenf', '6': 'sechs', '7': 'sieben', '8': 'acht', '9': 'neun',
        };
        return de[tok] || tok;
      })
      .join(' ');
    if (toWordDe && toWordDe !== norm) out.push(toWordDe);
    if (parts.length >= 2) out.push(parts.slice(0, -1).join(' '));
    return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
  }

  /**
   * Damerau-Levenshtein (includes adjacent transposition).
   * @param {string} a
   * @param {string} b
   * @returns {number}
   */
  function damerauDistance(a, b) {
    if (a === b) return 0;
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    // Near-match band needs up to ~3 edits (full-title typo + soft band).
    if (Math.abs(m - n) > 3) return 99;
    /** @type {number[][]} */
    const d = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[m][n];
  }

  /**
   * Edit budget by token length (Algolia/Meilisearch-style).
   * Equal-length short tokens (len 2–3) allow 1 edit so "od"↔"of".
   * @param {string} qTok
   * @param {string} nameTok
   * @param {boolean} allowFuzzyTier
   * @returns {boolean}
   */
  function tokensFuzzyEqual(qTok, nameTok, allowFuzzyTier) {
    if (qTok === nameTok) return true;
    if (!allowFuzzyTier) return false;
    const qLen = qTok.length;
    const nLen = nameTok.length;
    const len = Math.min(qLen, nLen);
    if (len <= 3) {
      return qLen === nLen && len >= 2 && damerauDistance(qTok, nameTok) <= 1;
    }
    const maxEdit = len >= 8 ? 2 : 1;
    return damerauDistance(qTok, nameTok) <= maxEdit;
  }

  /**
   * @param {string} qTok
   * @param {string[]} nameCanon
   * @param {boolean} allowFuzzyTier
   * @returns {{ hit: boolean, exact: boolean }}
   */
  function fuzzyTokenHit(qTok, nameCanon, allowFuzzyTier) {
    if (nameCanon.includes(qTok)) return { hit: true, exact: true };
    for (const n of nameCanon) {
      if (tokensFuzzyEqual(qTok, n, allowFuzzyTier)) return { hit: true, exact: false };
    }
    return { hit: false, exact: false };
  }

  /**
   * @param {string[]} qCanon
   * @param {string[]} nameCanon
   * @param {boolean} allowFuzzyTier
   * @returns {boolean}
   */
  function fuzzyPhraseMatch(qCanon, nameCanon, allowFuzzyTier) {
    if (qCanon.length < 2) return false;
    let i = 0;
    for (let j = 0; j < nameCanon.length && i < qCanon.length; j++) {
      if (
        qCanon[i] === nameCanon[j] ||
        tokensFuzzyEqual(qCanon[i], nameCanon[j], allowFuzzyTier)
      ) {
        i += 1;
      }
    }
    return i === qCanon.length;
  }

  /**
   * @param {object} meta
   * @returns {number}
   */
  function metaYear(meta) {
    const raw = String(meta?.releaseInfo || meta?.year || '').split(/[-–—]/)[0];
    const y = parseInt(raw, 10);
    return Number.isFinite(y) ? y : 0;
  }

  /**
   * @param {object} meta
   * @returns {number}
   */
  function metaRating(meta) {
    const r = parseFloat(String(meta?.imdbRating || meta?.rating || ''));
    return Number.isFinite(r) ? r : 0;
  }

  /**
   * Higher is better. Exact/prefix/near-title > sequence > bag-of-words; popularity secondary.
   * @param {string} query
   * @param {object} meta
   * @param {boolean} allowFuzzyTier
   * @returns {number}
   */
  function relevanceScore(query, meta, allowFuzzyTier) {
    const q = normalizeQuery(query);
    if (!q) return 0;
    const name = normalizeQuery(meta?.name || '');
    const release = normalizeQuery(
      String(meta?.releaseInfo || meta?.year || '').split(/[-–—]/)[0] || ''
    );
    const hay = `${name} ${release}`.trim();
    if (!hay) return 0;

    const qCanon = canonicalTokens(q);
    const nameCanon = canonicalTokens(name);
    const nameSet = new Set(nameCanon);
    const qWordTokens = qCanon.filter((t) => !/^\d+$/.test(t));
    const wordHits = qWordTokens.map((t) => fuzzyTokenHit(t, nameCanon, allowFuzzyTier));
    const matchedWords = wordHits.filter((h) => h.hit);
    const fuzzyPenalty = wordHits.filter((h) => h.hit && !h.exact).length;
    const matchedDigits = qCanon.filter((t) => /^\d+$/.test(t) && nameSet.has(t));
    // Same-length token sequence (exact or fuzzy), not "tokens appear somewhere".
    const allExactSequence =
      qCanon.length > 0 &&
      nameCanon.length === qCanon.length &&
      qCanon.every(
        (t, i) => t === nameCanon[i] || tokensFuzzyEqual(t, nameCanon[i], allowFuzzyTier)
      );
    const allTokensPresent =
      qWordTokens.length > 0 &&
      wordHits.every((h) => h.hit) &&
      qCanon.filter((t) => /^\d+$/.test(t)).every((t) => nameSet.has(t));

    let score = 0;
    if (name === q) score += 1200;
    else if (name.startsWith(q + ' ') || name.startsWith(q)) {
      score += 900;
      // Prefer titles closer to the typed prefix (shorter remaining suffix).
      score += Math.max(0, 200 - (name.length - q.length) * 8);
    } else if (nameCanon[0] === qCanon[0] && qCanon.length === 1) score += 750;
    else if (hay.startsWith(q)) score += 650;
    else if (name.includes(q) || hay.includes(q)) score += 280;

    // Full-title near-match: "game od thrones" → "game of thrones" (d=1).
    // Independent of token fuzzy tier so typos win before Making-of supersets.
    if (name !== q && qCanon.length && nameCanon.length) {
      const qJoined = qCanon.join(' ');
      const nJoined = nameCanon.join(' ');
      const d = damerauDistance(qJoined, nJoined);
      const maxD = qJoined.length >= 12 ? 2 : 1;
      if (d <= maxD) score += 1000 - 80 * d;
      else if (d <= maxD + 1 && nameCanon.length <= qCanon.length + 1) score += 700;
    }

    if (allExactSequence) score += 500;
    else if (allTokensPresent) score += 120;

    // Partial last-token completion: "me" → "men" (not "questions").
    // Query token i is a real prefix of title token i (strict, not full drop).
    if (qCanon.length >= 1 && nameCanon.length >= qCanon.length) {
      let prefixAligned = true;
      for (let i = 0; i < qCanon.length - 1; i++) {
        if (qCanon[i] !== nameCanon[i]) {
          prefixAligned = false;
          break;
        }
      }
      if (prefixAligned) {
        const lastQ = qCanon[qCanon.length - 1];
        const lastN = nameCanon[qCanon.length - 1];
        if (lastN && lastQ && lastN !== lastQ && lastN.startsWith(lastQ)) {
          score += 450;
        }
      }
    }

    if (qCanon.length >= 2) {
      const needle = qCanon.join(' ');
      if (nameCanon.join(' ').includes(needle)) score += 420;
      else if (fuzzyPhraseMatch(qCanon, nameCanon, allowFuzzyTier)) score += 360;
    }

    if (qWordTokens.length > 0) {
      const wordRatio = matchedWords.length / qWordTokens.length;
      if (wordRatio < 0.5) {
        score = Math.min(score, 40);
        if (matchedDigits.length && matchedWords.length === 0) score -= 100;
        return score;
      }
      score += Math.round(wordRatio * 300);
      score -= 40 * fuzzyPenalty;
      // Prefer short titles that cover the query (Algolia attribute-length style).
      if (nameCanon.length > 0) {
        score += Math.round((matchedWords.length / nameCanon.length) * 250);
      }
      score -= Math.max(0, nameCanon.length - qCanon.length) * 60;
    } else if (matchedDigits.length && qCanon.length === matchedDigits.length) {
      score += 80;
    }

    if (matchedDigits.length) score += 40 * matchedDigits.length;

    const overlap =
      wordHits.filter((h) => h.hit).length +
      qCanon.filter((t) => /^\d+$/.test(t) && nameSet.has(t)).length;
    if (qCanon.length) score += Math.round((overlap / qCanon.length) * 100);

    // Secondary rank only: popularity must not override text relevance.
    const popularity = metaRating(meta);
    if (score >= 800) score += Math.min(150, popularity * 15);
    else score += Math.min(25, popularity * 2);
    score += Math.min(20, Math.max(0, metaYear(meta) - 1990) / 4);

    return score;
  }

  /**
   * Best score across query expansions.
   * @param {string[]} queries
   * @param {object} meta
   * @param {boolean} allowFuzzyTier
   * @returns {number}
   */
  function bestScore(queries, meta, allowFuzzyTier) {
    let best = 0;
    for (const q of queries) {
      best = Math.max(best, relevanceScore(q, meta, allowFuzzyTier));
    }
    return best;
  }

  /**
   * @returns {object[]}
   */
  function loadRecent() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((m) => m && m.id) : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * @param {object} meta
   */
  function saveRecent(meta) {
    if (!meta?.id) return;
    const next = [
      {
        id: meta.id,
        type: meta.type || 'movie',
        name: meta.name || meta.id,
        poster: meta.poster || '',
        year: meta.releaseInfo || meta.year || '',
      },
      ...loadRecent().filter((m) => String(m.id).toLowerCase() !== String(meta.id).toLowerCase()),
    ].slice(0, MAX_RECENT);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch (_) {}
  }

  /**
   * @param {string} query
   * @returns {Promise<object[]>}
   */
  async function fetchCatalogMetas(query) {
    const q = encodeURIComponent(query.trim());
    const urls = [
      `${CINEMETA_CATALOG}/movie/top/search=${q}.json`,
      `${CINEMETA_CATALOG}/series/top/search=${q}.json`,
    ];
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await fetch(url);
          if (!res.ok) return [];
          const json = await res.json();
          return Array.isArray(json?.metas) ? json.metas : [];
        } catch (_) {
          return [];
        }
      })
    );
    return [...(results[0] || []), ...(results[1] || [])];
  }

  /**
   * Tiered: rank without fuzzy first; enable fuzzy only if < STRONG_MIN strong hits.
   * @param {string} query
   * @returns {Promise<object[]>}
   */
  async function searchCinemeta(query) {
    const queries = expandSearchQueries(query);
    // Fetch with expansions (broader catalog), but score only the full user query
    // so a partial last token like "me" still prefers "Men" over "Questions".
    const scoreQueries = [String(query || '').trim()].filter(Boolean);
    const pools = await Promise.all(queries.map((q) => fetchCatalogMetas(q)));
    const seen = new Set();
    const merged = [];
    for (const list of pools) {
      for (const meta of list) {
        const id = String(meta?.id || '').toLowerCase();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(meta);
      }
    }

    const strictRanked = merged
      .map((meta) => ({ meta, score: bestScore(scoreQueries, meta, false) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (metaRating(b.meta) !== metaRating(a.meta)) {
          return metaRating(b.meta) - metaRating(a.meta);
        }
        return metaYear(b.meta) - metaYear(a.meta);
      });

    const strongCount = strictRanked.filter((r) => r.score >= STRONG_SCORE).length;
    const useFuzzy = strongCount < STRONG_MIN;

    const ranked = useFuzzy
      ? merged
          .map((meta) => ({ meta, score: bestScore(scoreQueries, meta, true) }))
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (metaRating(b.meta) !== metaRating(a.meta)) {
              return metaRating(b.meta) - metaRating(a.meta);
            }
            return metaYear(b.meta) - metaYear(a.meta);
          })
      : strictRanked;

    return ranked
      .filter((r) => r.score > 40)
      .slice(0, MAX_RESULTS)
      .map((r) => r.meta);
  }

  /**
   * @param {object} meta
   */
  function openMeta(meta) {
    const id = String(meta?.id || '');
    const type = String(meta?.type || 'movie').toLowerCase() === 'series' ? 'series' : 'movie';
    if (!id) return;
    saveRecent({
      id,
      type,
      name: meta.name || id,
      poster: meta.poster || '',
      year: meta.releaseInfo || meta.year || '',
    });
    hide();
    window.location.hash = `#/detail/${type}/${id}/${id}`;
  }

  /**
   * @param {number} index
   * @param {{ scroll?: boolean }} [opts] — scrollIntoView only for keyboard nav (hover must not scroll).
   */
  function setActiveIndex(index, opts) {
    const scroll = Boolean(opts && opts.scroll);
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const items = [...root.querySelectorAll('.mss-item')];
    if (!items.length) {
      activeIndex = -1;
      return;
    }
    activeIndex = ((index % items.length) + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
    if (scroll) items[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }

  /**
   * @param {HTMLInputElement} input
   * @param {object[]} metas
   * @param {{ recent?: boolean }} [opts]
   */
  function render(input, metas, opts) {
    const root = ensureRoot();
    positionRoot(input);
    currentMetas = metas;
    activeIndex = -1;
    if (!metas.length) {
      root.innerHTML = `<div class="mss-empty">Keine Treffer</div>`;
      root.classList.add('open');
      return;
    }
    const section = opts?.recent
      ? `<div class="mss-section">Zuletzt</div>`
      : '';
    root.innerHTML =
      section +
      metas
        .map((meta) => {
          const type = String(meta.type || 'movie');
          const year = meta.releaseInfo || meta.year || '';
          const poster = meta.poster
            ? `<img class="mss-poster" src="${esc(meta.poster)}" alt="" loading="lazy" />`
            : `<div class="mss-poster"></div>`;
          return `<button type="button" class="mss-item" role="option" data-id="${esc(meta.id)}" data-type="${esc(type)}">
          ${poster}
          <span class="mss-meta">
            <span class="mss-title">${esc(meta.name || meta.id)}</span>
            <span class="mss-sub">${esc(type)}${year ? ` · ${esc(year)}` : ''}</span>
          </span>
        </button>`;
        })
        .join('');
    root.classList.add('open');
    root.querySelectorAll('.mss-item').forEach((btn, i) => {
      btn.addEventListener('mouseenter', () => setActiveIndex(i, { scroll: false }));
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openMeta({
          id: btn.getAttribute('data-id'),
          type: btn.getAttribute('data-type'),
          name: currentMetas[i]?.name,
          poster: currentMetas[i]?.poster,
          year: currentMetas[i]?.releaseInfo || currentMetas[i]?.year,
        });
      });
    });
  }

  /**
   * @param {HTMLInputElement} input
   */
  async function onQuery(input) {
    const query = String(input.value || '').trim();
    activeInput = input;
    if (query.length < MIN_QUERY) {
      const recent = loadRecent();
      if (recent.length) render(input, recent, { recent: true });
      else hide();
      return;
    }
    const gen = ++requestGen;
    const metas = await searchCinemeta(query);
    if (gen !== requestGen || activeInput !== input) return;
    render(input, metas);
  }

  /**
   * @param {HTMLInputElement} input
   * @param {KeyboardEvent} event
   */
  function onKeyDown(input, event) {
    const root = document.getElementById(ROOT_ID);
    const open = root?.classList.contains('open');
    const items = open ? root.querySelectorAll('.mss-item') : [];

    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        hide();
      }
      return;
    }

    if (!open || !items.length) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(activeIndex < 0 ? 0 : activeIndex + 1, { scroll: true });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(activeIndex < 0 ? items.length - 1 : activeIndex - 1, {
        scroll: true,
      });
      return;
    }
    if (event.key === 'Enter' && activeIndex >= 0 && currentMetas[activeIndex]) {
      event.preventDefault();
      event.stopPropagation();
      openMeta(currentMetas[activeIndex]);
    }
  }

  /**
   * @param {HTMLInputElement} input
   */
  function bindInput(input) {
    if (!input || boundInputs.has(input)) return;
    boundInputs.add(input);
    input.addEventListener('input', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => onQuery(input), DEBOUNCE_MS);
    });
    input.addEventListener('keydown', (event) => onKeyDown(input, event));
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (!document.getElementById(ROOT_ID)?.contains(document.activeElement)) hide();
      }, 160);
    });
    input.addEventListener('focus', () => {
      const q = String(input.value || '').trim();
      if (q.length >= MIN_QUERY) onQuery(input);
      else {
        const recent = loadRecent();
        if (recent.length) render(input, recent, { recent: true });
      }
    });
  }

  function scan() {
    document
      .querySelectorAll(
        '.search-bar-container-asfq1 input, .search-input-IQ0ZW, input[class*="search-input"], [class*="search-input"]'
      )
      .forEach((el) => {
        if (el instanceof HTMLInputElement) bindInput(el);
      });
  }

  /**
   * @param {Event} [event]
   */
  function onReposition(event) {
    const root = document.getElementById(ROOT_ID);
    if (!activeInput || !root?.classList.contains('open')) return;
    // Ignore scrolls inside the suggestions panel (hover must not reposition).
    if (
      event?.target &&
      (event.target === root || (event.target instanceof Node && root.contains(event.target)))
    ) {
      return;
    }
    if (positionRaf) cancelAnimationFrame(positionRaf);
    positionRaf = requestAnimationFrame(() => {
      positionRaf = null;
      if (activeInput) positionRoot(activeInput);
    });
  }

  document.addEventListener(
    'pointerdown',
    (event) => {
      const root = document.getElementById(ROOT_ID);
      if (!root?.classList.contains('open')) return;
      if (root.contains(event.target) || activeInput?.contains?.(event.target)) return;
      hide();
    },
    true
  );
  window.addEventListener('resize', onReposition);
  window.addEventListener('scroll', onReposition, true);

  const observer = new MutationObserver(() => scan());
  function start() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', start, { once: true });
      return;
    }
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scan();
  }
  start();
})();
