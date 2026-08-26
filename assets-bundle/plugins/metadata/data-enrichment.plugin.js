/**
 * @name Data Enrichment
 * @description Enriches movie and TV show details with TMDB data including genres, cast, directors, similar titles, and collections.
 * @version 2.1.5
 * @category metadata
 * @author MrBlu03 edited by MyStremio
 */

(() => {
    // Prevent multiple injections from Stremio's Mod Manager
    if (window.__DataEnrichmentLoaded) return;
    window.__DataEnrichmentLoaded = true;

/**
     * Installs the Data Enrichment multi-ratings bar (detail + episode).
     * Hover ratings are owned by meta-hover-panel — this bar is not a shared UI.
     * Fetches via shell `get-title-ratings` (CORS-safe fan-out).
     */
    try {
    (function installRatingsBar() {
        if (window.__mystremioRatingsBar) return;

        const STYLE_ID = 'mystremio-ratings-bar-styles-v8';
        const BAR_CLASS = 'mystremio-ratings-bar';
        const ROW_CLASS = 'msb-ratings-row';
        const HIDDEN_IMDB_ATTR = 'data-mystremio-imdb-hidden';
        const CACHE_TTL_MS = 10 * 60 * 1000;
        /** @type {Map<string, { at: number, ratings: object[] }>} */
        const cache = new Map();
        /** @type {Map<string, Promise<object[]>>} */
        const pending = new Map();

        // Path-only icons (no SVG <text> â€” that clipped to "TMDI" / "MD").
        const RATING_ICONS = {
            rt: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#fa320a"/><ellipse cx="12" cy="13.2" rx="5" ry="4" fill="#7cb342"/></svg>`,
        };

        const VALUE_COLORS = {
            imdb: '#f5c518',
            mal: '#2ecc71',
            rt: '#fa320a',
            tmdb: '#01b4e4',
            metacritic: '#2ecc71',
            trakt: '#ed1c24',
            mcusers: '#b19cd9',
            letterboxd: '#00e054',
        };

        /**
         * @param {string} text
         * @returns {string}
         */
        function esc(text) {
            return String(text || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        /**
         * @param {string} imdbId
         * @returns {string|null}
         */
        function normalizeImdbId(imdbId) {
            const match = String(imdbId || '').match(/tt\d{7,8}/i);
            return match ? match[0].toLowerCase() : null;
        }

        /**
         * @returns {object|null}
         */
        function apiClient() {
            return window.StremioCustomAPI || window.StremioEnhancedAPI || null;
        }

        /**
         * @returns {string}
         */
        function extractPageTitle() {
            const logo = document
                .querySelector(
                    '[class*="meta-details"] img[class*="logo"][alt], [class*="metainfo"] img[alt]'
                )
                ?.getAttribute('alt');
            if (logo && logo.length > 1) return logo.trim();
            const name = document.querySelector(
                '[class*="meta-details"] [class*="title-name"], [class*="meta-info"] h1, [class*="name-container"] [class*="name-"]'
            )?.textContent;
            return String(name || '').replace(/\s+/g, ' ').trim();
        }

        /**
         * Synchronous cache peek for hover UI (avoids IMDbâ†’bar pop-in when warm).
         * @param {string} imdbId
         * @returns {object[]|null}
         */
        function peekCachedRatings(imdbId) {
            const id = normalizeImdbId(imdbId);
            if (!id) return null;
            const cached = cache.get(id);
            if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
                return cached.ratings.slice();
            }
            return null;
        }

        function orderRatings(ratings) {
            const order = ['fsk', 'imdb', 'mal', 'rt', 'tmdb', 'metacritic', 'trakt', 'mcusers', 'letterboxd'];
            const by = Object.fromEntries(
                (ratings || []).filter((r) => r?.key).map((r) => [r.key, r])
            );
            return order.filter((k) => by[k]).map((k) => by[k]);
        }

        function hintedMediaTypes(typeHint, isEpisode) {
            const hint = String(typeHint || '').toLowerCase();
            if (isEpisode) return { types: ['series'], typeKnown: true };
            if (hint === 'series' || hint === 'tv' || hint === 'show' || hint === 'anime') {
                return { types: ['series'], typeKnown: true };
            }
            if (hint === 'movie') return { types: ['movie'], typeKnown: true };
            return { types: ['movie'], typeKnown: false };
        }

        /**
         * @param {{ season?: number|null, episode?: number|null, exactCinemeta?: boolean, episodeLayout?: string }} [episodeRef]
         * @returns {string}
         */
        function episodeCacheSuffix(episodeRef) {
            const layout = String(episodeRef?.episodeLayout || '').toLowerCase();
            if (layout === 'tmdb' || layout === 'cinemeta' || layout === 'absolute') {
                return `:${layout}`;
            }
            if (episodeRef?.exactCinemeta === false) return ':abs';
            if (episodeRef?.exactCinemeta === true) return ':exact';
            return ':auto';
        }

        /**
         * @param {string} imdbId
         * @param {string|null} [typeHint]
         * @param {{ season?: number|null, episode?: number|null, exactCinemeta?: boolean, episodeLayout?: string }} [episodeRef]
         * @param {{ mode?: 'fast'|'full' }} [options]
         * @returns {Promise<object[]>}
         */
        async function fetchRatings(imdbId, typeHint = null, episodeRef = null, options = null) {
            const id = normalizeImdbId(imdbId);
            if (!id) return [];
            const season = Number(episodeRef?.season) || 0;
            const episode = Number(episodeRef?.episode) || 0;
            const isEpisode = season > 0 && episode > 0;
            const exactCinemeta = episodeRef?.exactCinemeta;
            const episodeLayout = String(episodeRef?.episodeLayout || '').toLowerCase();
            const mode = options?.mode === 'fast' ? 'fast' : 'full';
            const layoutKey = episodeCacheSuffix(episodeRef);
            const cacheKey = isEpisode ? `${id}:s${season}e${episode}${layoutKey}` : id;
            const pendingKey = `${cacheKey}:${mode}`;
            if (mode === 'full') {
                const cached = cache.get(cacheKey);
                if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ratings.slice();
            }
            if (pending.has(pendingKey)) return pending.get(pendingKey);

            const { types, typeKnown } = hintedMediaTypes(typeHint, isEpisode);

            const job = (async () => {
                const client = apiClient();
                let ratings = [];
                if (client?.invoke) {
                    const tryTypes = types.slice();
                    for (const type of tryTypes) {
                        try {
                            const payload = {
                                imdbId: id,
                                type,
                                mode,
                            };
                            if (isEpisode) {
                                payload.season = season;
                                payload.episode = episode;
                                if (exactCinemeta === false) payload.exactCinemeta = false;
                                if (exactCinemeta === true) payload.exactCinemeta = true;
                                if (
                                    episodeLayout === 'tmdb' ||
                                    episodeLayout === 'cinemeta' ||
                                    episodeLayout === 'absolute'
                                ) {
                                    payload.episodeLayout = episodeLayout;
                                }
                            }
                            const result = await client.invoke('get-title-ratings', payload);
                            if (Array.isArray(result?.ratings) && result.ratings.length) {
                                ratings = result.ratings;
                                break;
                            }
                        } catch (_) {
                            /* try next */
                        }
                    }
                    if (!ratings.length && !typeKnown && !isEpisode && mode === 'full') {
                        const fallback = types[0] === 'movie' ? 'series' : 'movie';
                        try {
                            const result = await client.invoke('get-title-ratings', {
                                imdbId: id,
                                type: fallback,
                                mode: 'full',
                            });
                            if (Array.isArray(result?.ratings) && result.ratings.length) {
                                ratings = result.ratings;
                            }
                        } catch (_) {}
                    }
                }
                const ordered = orderRatings(ratings);
                const ageOnly = new Set(['fsk', 'mpaa', 'age']);
                const hasScore = ordered.some((item) => !ageOnly.has(String(item?.key || '').toLowerCase()));
                if (isEpisode && !hasScore) return [];
                if (mode === 'full' && ordered.length && hasScore) {
                    cache.set(cacheKey, { at: Date.now(), ratings: ordered });
                }
                return ordered.slice();
            })().finally(() => pending.delete(pendingKey));

            pending.set(pendingKey, job);
            return job;
        }

        /**
         * @param {string} imdbId
         * @param {string|null} typeHint
         * @param {{ season?: number|null, episode?: number|null }|null} episodeRef
         * @param {(ratings: object[]) => void} [onPartial]
         * @returns {Promise<object[]>}
         */
        async function fetchRatingsProgressive(imdbId, typeHint, episodeRef, onPartial) {
            const fastPromise = fetchRatings(imdbId, typeHint, episodeRef, { mode: 'fast' });
            const fullPromise = fetchRatings(imdbId, typeHint, episodeRef, { mode: 'full' });
            let fast = [];
            try {
                fast = await fastPromise;
                if (fast.length) onPartial?.(fast);
            } catch (_) {}
            try {
                const full = await fullPromise;
                if (full.length) {
                    const merged = orderRatings([...(fast || []), ...(full || [])]);
                    const id = normalizeImdbId(imdbId);
                    const season = Number(episodeRef?.season) || 0;
                    const episode = Number(episodeRef?.episode) || 0;
                    const hasScore = merged.some((item) => {
                        const key = String(item?.key || '').toLowerCase();
                        return key && key !== 'fsk' && key !== 'mpaa' && key !== 'age';
                    });
                    if (id && hasScore) {
                        const layoutKey = episodeCacheSuffix(episodeRef);
                        const cacheKey =
                            season > 0 && episode > 0 ? `${id}:s${season}e${episode}${layoutKey}` : id;
                        cache.set(cacheKey, { at: Date.now(), ratings: merged });
                    }
                    return merged;
                }
            } catch (_) {}
            return fast;
        }

        function ensureStyles() {
            if (document.getElementById(STYLE_ID)) return;
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = `
              .${ROW_CLASS}{
                display:inline-flex;flex-direction:row;flex-wrap:nowrap;
                align-items:center;gap:8px;vertical-align:middle;max-width:100%;
              }
              .${BAR_CLASS}{
                display:inline-flex;flex-wrap:nowrap;align-items:center;gap:8px;
                vertical-align:middle;flex:0 1 auto;
              }
              .${BAR_CLASS} .msb-item{
                display:inline-flex;align-items:center;gap:7px;
                margin:0;padding:6px 10px;border:1px solid rgba(255,255,255,.12);
                background:rgba(0,0,0,.38);color:#fff;
                font:inherit;font-size:13px;font-weight:700;line-height:1;
                font-variant-numeric:tabular-nums;white-space:nowrap;
                cursor:pointer;border-radius:999px;
                box-shadow:0 1px 2px rgba(0,0,0,.25);
              }
              .${BAR_CLASS} .msb-item:hover{
                filter:brightness(1.08);
                border-color:rgba(255,255,255,.22);
                background:rgba(0,0,0,.5);
              }
              .${BAR_CLASS} .msb-item:focus-visible{outline:2px solid rgba(255,255,255,.35);outline-offset:2px}
              .${BAR_CLASS} .msb-item[data-msb-rating-key="fsk"]{
                padding:5px 9px;background:rgba(245,197,24,.16);border-color:rgba(245,197,24,.45);
              }
              .${BAR_CLASS} .msb-brand{
                display:inline-flex;align-items:center;justify-content:center;
                height:17px;padding:0 6px;border-radius:4px;
                font-size:10px;font-weight:800;letter-spacing:.02em;line-height:1;
                flex-shrink:0;
              }
              .${BAR_CLASS} .msb-brand-imdb{background:#f5c518;color:#111;min-width:34px}
              .${BAR_CLASS} .msb-brand-tmdb{background:#032541;color:#01b4e4;min-width:34px}
              .${BAR_CLASS} .msb-brand-mal{background:#2e51a2;color:#fff;min-width:28px}
              .${BAR_CLASS} .msb-brand-mc{background:#ffcc33;color:#111;min-width:26px;border-radius:4px}
              .${BAR_CLASS} .msb-brand-mcu{background:#6c5ce7;color:#fff;min-width:36px;border-radius:4px}
              .${BAR_CLASS} .msb-brand-trakt{background:#ed1c24;color:#fff;min-width:36px;border-radius:4px}
              .${BAR_CLASS} .msb-brand-lb{background:#14181c;color:#00e054;min-width:28px}
              .${BAR_CLASS} .msb-icon{width:15px;height:15px;display:inline-flex;align-items:center;flex-shrink:0}
              .${BAR_CLASS} .msb-icon svg{width:15px;height:15px;display:block}
              .${BAR_CLASS} .msb-value{font-weight:700}
              .${BAR_CLASS} .msb-age{
                min-width:28px;padding:2px 7px;border-radius:999px;
                background:#f5c518;color:#111;font-size:11px;font-weight:800;text-align:center;
              }
              .${BAR_CLASS}.msb-compact{gap:7px}
              .${BAR_CLASS}.msb-compact .msb-item{padding:5px 9px;gap:6px}
              .${BAR_CLASS}.msb-compact .msb-brand{height:16px;font-size:9px;padding:0 5px}
              .${BAR_CLASS}.msb-compact .msb-value{font-size:12px}
              .${BAR_CLASS}.msb-compact .msb-icon,.${BAR_CLASS}.msb-compact .msb-icon svg{width:13px;height:13px}
              .${BAR_CLASS}.msb-compact .msb-age{font-size:10px;padding:1px 6px}
              .${BAR_CLASS}[data-msb-host="episode"] .msb-ep-label{
                font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
                color:rgba(255,255,255,.5);margin-right:2px;
              }
              [${HIDDEN_IMDB_ATTR}="1"]{display:none!important}
            `;
            document.documentElement.appendChild(style);
        }

        /**
         * @param {object} rating
         * @returns {string}
         */
        function brandHtml(rating) {
            switch (rating.key) {
                case 'imdb':
                    return `<span class="msb-brand msb-brand-imdb">IMDb</span>`;
                case 'tmdb':
                    return `<span class="msb-brand msb-brand-tmdb">TMDb</span>`;
                case 'mal':
                    return `<span class="msb-brand msb-brand-mal">MAL</span>`;
                case 'metacritic':
                    return `<span class="msb-brand msb-brand-mc">MC</span>`;
                case 'mcusers':
                    return `<span class="msb-brand msb-brand-mcu">MC U</span>`;
                case 'trakt':
                    return `<span class="msb-brand msb-brand-trakt">Trakt</span>`;
                case 'letterboxd':
                    return `<span class="msb-brand msb-brand-lb">LB</span>`;
                case 'rt':
                    return `<span class="msb-icon">${RATING_ICONS.rt}</span>`;
                default:
                    return `<span class="msb-brand msb-brand-imdb">${esc(rating.label || '?')}</span>`;
            }
        }

        /**
         * Stable chip identity so cache-then-paint does not rewrite identical HTML.
         * @param {object[]} ratings
         * @returns {string}
         */
        function ratingsSignature(ratings) {
            return (ratings || [])
                .map((r) => `${r?.key || ''}:${r?.value || ''}:${r?.url || ''}`)
                .join('|');
        }

        /**
         * @param {object} rating
         * @returns {string}
         */
        function itemHtml(rating) {
            const key = esc(rating.key || '');
            const title = esc(rating.label || '');
            const urlAttr = rating.url
                ? ` data-msb-url="${esc(rating.url)}"`
                : '';
            if (rating.kind === 'age' || rating.key === 'fsk') {
                return `<button type="button" class="msb-item" data-msb-rating-key="${key}"${urlAttr} title="${title}"><span class="msb-age">${esc(rating.value)}</span></button>`;
            }
            const color = VALUE_COLORS[rating.key] || '#fff';
            const valueHtml = `<span class="msb-value" style="color:${color}">${esc(rating.value)}</span>`;
            return `<button type="button" class="msb-item" data-msb-rating-key="${key}"${urlAttr} title="${title}">${brandHtml(rating)}${valueHtml}</button>`;
        }

        /**
         * @param {object[]} ratings
         * @param {{ compact?: boolean }} [opts]
         * @returns {string}
         */
        function buildBarHtml(ratings, opts = {}) {
            if (!ratings?.length) return '';
            const compact = opts.compact ? ' msb-compact' : '';
            return `<div class="${BAR_CLASS}${compact}">${ratings.map(itemHtml).join('')}</div>`;
        }

        /**
         * @param {string} url
         * @returns {boolean}
         */
        function openExternalUrl(url) {
            if (!url) return false;
            const client = apiClient();
            if (client?.openExternalUrl) {
                Promise.resolve(client.openExternalUrl(url)).catch(() => {
                    window.open(url, '_blank', 'noopener,noreferrer');
                });
                return true;
            }
            if (client?.invoke) {
                Promise.resolve(client.invoke('open-external-url', { url })).catch(() => {
                    window.open(url, '_blank', 'noopener,noreferrer');
                });
                return true;
            }
            window.open(url, '_blank', 'noopener,noreferrer');
            return true;
        }

        /**
         * Builds a fallback external URL when the proxy did not attach `rating.url`.
         * Prefer proxy deep links â€” this is only a last resort.
         * @param {string} ratingKey
         * @param {{ imdbId: string|null, title: string, type: string, season?: number, episode?: number }} ctx
         * @returns {string|null}
         */
        function buildRatingSourceUrl(ratingKey, ctx) {
            const imdbId = ctx.imdbId;
            const title = String(ctx.title || '').trim();
            const isSeries =
                String(ctx.type || '').toLowerCase() === 'series' ||
                String(ctx.type || '').toLowerCase() === 'tv' ||
                String(ctx.type || '').toLowerCase() === 'show';
            const season = Number(ctx.season) || 0;
            const episode = Number(ctx.episode) || 0;

            switch (ratingKey) {
                case 'imdb':
                    if (imdbId) return `https://www.imdb.com/title/${imdbId}/`;
                    return null;
                case 'tmdb':
                    if (title) {
                        const path = isSeries ? 'tv' : 'movie';
                        return `https://www.themoviedb.org/search/${path}?query=${encodeURIComponent(title)}`;
                    }
                    return null;
                case 'rt': {
                    const slug = title
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '_')
                        .replace(/^_|_$/g, '');
                    if (!slug) return null;
                    if (isSeries && season > 0 && episode > 0) {
                        return `https://www.rottentomatoes.com/tv/${slug}/s${String(season).padStart(2, '0')}/e${String(episode).padStart(2, '0')}`;
                    }
                    return isSeries
                        ? `https://www.rottentomatoes.com/tv/${slug}`
                        : `https://www.rottentomatoes.com/m/${slug}`;
                }
                case 'metacritic':
                case 'mcusers': {
                    const slug = title
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-|-$/g, '');
                    if (!slug) return null;
                    return isSeries
                        ? `https://www.metacritic.com/tv/${slug}/`
                        : `https://www.metacritic.com/movie/${slug}/`;
                }
                case 'trakt':
                    if (title) return `https://trakt.tv/search?query=${encodeURIComponent(title)}`;
                    return null;
                case 'mal':
                    return title
                        ? `https://myanimelist.net/search/all?q=${encodeURIComponent(title)}`
                        : null;
                case 'fsk':
                    return imdbId
                        ? `https://www.imdb.com/title/${imdbId}/parentalguide`
                        : null;
                case 'letterboxd':
                    if (imdbId) return `https://letterboxd.com/imdb/${imdbId}/`;
                    return title
                        ? `https://letterboxd.com/search/${encodeURIComponent(title)}/`
                        : null;
                default:
                    return null;
            }
        }

        /**
         * @param {Element} host
         */
        function wireClicks(host) {
            if (!host || host.dataset.msbClickWired === '1') return;
            host.dataset.msbClickWired = '1';
            host.addEventListener(
                'click',
                (event) => {
                    const btn = event.target?.closest?.('[data-msb-rating-key]');
                    if (!btn || !host.contains(btn)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const key = btn.getAttribute('data-msb-rating-key');
                    const directUrl = btn.getAttribute('data-msb-url');
                    if (directUrl) {
                        openExternalUrl(directUrl);
                        return;
                    }
                    const title = host.dataset.title || extractPageTitle();
                    if (title && !host.dataset.title) host.dataset.title = title;
                    const ctx = {
                        imdbId: host.dataset.imdbId || null,
                        title,
                        type: host.dataset.mediaType || 'movie',
                        season: Number(host.dataset.season) || 0,
                        episode: Number(host.dataset.episode) || 0,
                    };
                    const url = buildRatingSourceUrl(key, ctx);
                    if (url) openExternalUrl(url);
                },
                true
            );
        }

        /**
         * @param {Element} el
         * @param {object[]} ratings
         * @param {{ compact?: boolean, imdbId?: string, title?: string, type?: string }} [opts]
         */
        function renderInto(el, ratings, opts = {}) {
            if (!el) return;
            ensureStyles();
            if (!ratings?.length) {
                el.innerHTML = '';
                el.hidden = true;
                return;
            }
            el.hidden = false;
            if (opts.imdbId) el.dataset.imdbId = opts.imdbId;
            if (opts.title) el.dataset.title = opts.title;
            if (opts.type) el.dataset.mediaType = opts.type;
            el.innerHTML = buildBarHtml(ratings, opts);
            const inner = el.querySelector(`.${BAR_CLASS}`) || el;
            if (opts.imdbId) inner.dataset.imdbId = opts.imdbId;
            if (opts.title) inner.dataset.title = opts.title;
            if (opts.type) inner.dataset.mediaType = opts.type;
            wireClicks(inner);
        }

        function hideNativeImdbButtons() {
            document.querySelectorAll('[class*="imdb-button-container"]').forEach((btn) => {
                if (
                    btn.closest(
                        '[class*="player-container"], [class*="control-bar-layer"], [class*="meta-preview-placeholder-container"]'
                    )
                ) {
                    return;
                }
                btn.setAttribute(HIDDEN_IMDB_ATTR, '1');
            });
        }

        function restoreNativeImdbButtons() {
            document.querySelectorAll(`[${HIDDEN_IMDB_ATTR}="1"]`).forEach((el) => {
                el.removeAttribute(HIDDEN_IMDB_ATTR);
            });
        }

        /**
         * IMDb control on the live MetaPreview (not stale StreamsList / player).
         * Accepts buttons we already hid — otherwise remount falls back above the logo.
         * @returns {Element|null}
         */
        function findVisibleImdbAnchor() {
            let best = null;
            let bestScore = 0;
            document.querySelectorAll('[class*="imdb-button-container"]').forEach((btn) => {
                if (
                    btn.closest(
                        '[class*="player-container"], [class*="control-bar-layer"], [class*="meta-preview-placeholder-container"]'
                    )
                ) {
                    return;
                }
                const underDetails = Boolean(
                    btn.closest(
                        '[class*="metadetails"], [class*="meta-details"], [class*="meta-preview"]'
                    )
                );
                const alreadyOurs = btn.getAttribute(HIDDEN_IMDB_ATTR) === '1';
                const rect = btn.getBoundingClientRect();
                const area = rect.width * rect.height;
                // Accept already-hidden native IMDb; only skip other zero-size nodes.
                if (!alreadyOurs && area <= 0) return;
                const score = (alreadyOurs ? 1e8 : area) + (underDetails ? 1e9 : 0);
                if (score > bestScore) {
                    bestScore = score;
                    best = btn;
                }
            });
            return best;
        }

        /**
         * @param {Element} el
         * @returns {boolean}
         */
        function isInReleaseInfoRow(el) {
            return Boolean(
                el?.closest?.('[class*="runtime-release-info"]') ||
                    el?.closest?.('[class*="duration-release-info"]')
            );
        }

        /**
         * Drop leftover 2.3.16 column wraps that broke the meta row.
         */
        function unwrapLegacyStacks() {
            document.querySelectorAll('.msb-detail-stack').forEach((wrap) => {
                const parent = wrap.parentElement;
                if (!parent) {
                    wrap.remove();
                    return;
                }
                while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
                wrap.remove();
            });
        }

        /**
         * Native runtime/year/IMDb row on the live details page.
         * @returns {Element|null}
         */
        function findReleaseInfoRow() {
            const meta =
                document.querySelector(
                    '[class*="metadetails"] [class*="meta-info-container"]'
                ) ||
                document.querySelector(
                    '[class*="meta-details"] [class*="meta-info-container"]'
                ) ||
                document.querySelector(
                    '[class*="meta-preview"] [class*="meta-info-container"]'
                ) ||
                document.querySelector('[class*="meta-info-container"]');
            if (!meta?.isConnected) return null;
            return (
                meta.querySelector('[class*="runtime-release-info"]') ||
                meta.querySelector('[class*="duration-release-info"]')
            );
        }

        /**
         * Horizontal group in the native meta row: series host + episode host.
         * @returns {Element|null}
         */
        function ensureRatingsRow() {
            ensureStyles();
            unwrapLegacyStacks();
            const anchor = findVisibleImdbAnchor();
            const rows = [...document.querySelectorAll(`.${ROW_CLASS}`)];
            const live = rows.find((el) => {
                if (!el?.isConnected) return false;
                if (anchor && el.previousElementSibling === anchor) return true;
                return isInReleaseInfoRow(el);
            });
            rows.forEach((el) => {
                if (el !== live) el.remove();
            });
            if (live) {
                if (anchor?.parentElement && live.previousElementSibling !== anchor) {
                    anchor.insertAdjacentElement('afterend', live);
                }
                return live;
            }
            const row = document.createElement('div');
            row.className = ROW_CLASS;
            if (anchor?.parentElement) {
                anchor.insertAdjacentElement('afterend', row);
                return row;
            }
            const releaseRow = findReleaseInfoRow();
            if (releaseRow) {
                releaseRow.appendChild(row);
                return row;
            }
            return null;
        }

        /**
         * @param {Element|null} el
         * @returns {boolean}
         */
        function hostHasChips(el) {
            return Boolean(el?.isConnected && !el.hidden && el.querySelector?.('.msb-item'));
        }

        /**
         * True when the series host sits in the live ratings row (same meta line as IMDb).
         * @param {Element|null} el
         * @returns {boolean}
         */
        function isLiveDetailHost(el) {
            if (!el?.isConnected || el.dataset?.msbHost !== 'detail') return false;
            const row = el.closest(`.${ROW_CLASS}`);
            if (!row?.isConnected) return false;
            const anchor = findVisibleImdbAnchor();
            if (anchor && row.previousElementSibling === anchor) return true;
            if (!isInReleaseInfoRow(row)) return false;
            return Boolean(
                row.closest(
                    '[class*="metadetails"], [class*="meta-details"], [class*="meta-preview"]'
                )
            );
        }

        /**
         * Series/movie host inside the ratings row (after IMDb).
         * @returns {Element|null}
         */
        function ensureDetailHost() {
            const row = ensureRatingsRow();
            if (!row) return null;
            document.querySelectorAll(`.${BAR_CLASS}[data-msb-host="detail"]`).forEach((el) => {
                if (!row.contains(el)) el.remove();
            });
            let host = row.querySelector(`.${BAR_CLASS}[data-msb-host="detail"]`);
            if (!host) {
                host = document.createElement('div');
                host.className = BAR_CLASS;
                host.dataset.msbHost = 'detail';
                host.hidden = true;
                const episode = row.querySelector(`.${BAR_CLASS}[data-msb-host="episode"]`);
                if (episode) row.insertBefore(host, episode);
                else row.appendChild(host);
            }
            return host;
        }

        /**
         * Episode host in the same ratings row. Does not wait for series chips.
         * @returns {Element|null}
         */
        function ensureEpisodeHost() {
            const row = ensureRatingsRow();
            if (!row) return null;
            document.querySelectorAll(`.${BAR_CLASS}[data-msb-host="episode"]`).forEach((el) => {
                if (!row.contains(el)) el.remove();
            });
            let host = row.querySelector(`.${BAR_CLASS}[data-msb-host="episode"]`);
            if (!host) {
                host = document.createElement('div');
                host.className = BAR_CLASS;
                host.dataset.msbHost = 'episode';
                host.hidden = true;
                row.appendChild(host);
            }
            const detail = row.querySelector(`.${BAR_CLASS}[data-msb-host="detail"]`);
            if (detail && host.previousElementSibling !== detail) {
                detail.insertAdjacentElement('afterend', host);
            }
            return host;
        }

        /**
         * @param {Element|null} host
         */
        function hideEpisodeHost(host) {
            if (!host?.isConnected) return;
            host.innerHTML = '';
            host.hidden = true;
            delete host.dataset.msbRendered;
            delete host.dataset.msbSignature;
        }

        function removeEpisodeHost() {
            document.querySelectorAll(`.${BAR_CLASS}[data-msb-host="episode"]`).forEach((el) => {
                hideEpisodeHost(el);
                el.remove();
            });
        }

        /**
         * Paint series/movie chips onto a live host and hide native IMDb only when chips exist.
         * @param {Element} liveHost
         * @param {object[]} ratings
         * @param {{ id: string, mediaType: string, mountToken: string, title: string }} ctx
         * @returns {Element|null}
         */
        function paintDetailHost(liveHost, ratings, ctx) {
            if (!liveHost?.isConnected || !ratings.length) return null;
            const liveTitle = extractPageTitle() || ctx.title;
            ensureStyles();
            liveHost.className = BAR_CLASS;
            liveHost.dataset.msbHost = 'detail';
            liveHost.dataset.imdbId = ctx.id;
            liveHost.dataset.mediaType = ctx.mediaType;
            liveHost.dataset.msbToken = ctx.mountToken;
            liveHost.dataset.msbRendered = ctx.mountToken;
            delete liveHost.dataset.season;
            delete liveHost.dataset.episode;
            if (liveTitle) liveHost.dataset.title = liveTitle;
            liveHost.hidden = false;
            const signature = ratingsSignature(ratings);
            if (liveHost.dataset.msbSignature !== signature) {
                liveHost.innerHTML = ratings.map(itemHtml).join('');
                liveHost.dataset.msbSignature = signature;
                wireClicks(liveHost);
            }
            let host = liveHost;
            if (!isLiveDetailHost(host)) {
                host = ensureDetailHost() || host;
            }
            if (isLiveDetailHost(host) && hostHasChips(host)) {
                hideNativeImdbButtons();
            } else {
                restoreNativeImdbButtons();
            }
            return host;
        }

        /**
         * Series/movie chip bar next to native IMDb (2.3.15 behavior).
         * Prefetches scores even when the IMDb anchor is not mounted yet.
         * @param {string} imdbId
         * @param {string|null} [typeHint]
         * @returns {Promise<void>}
         */
        async function mountOnDetail(imdbId, typeHint = null) {
            const id = normalizeImdbId(imdbId);
            if (!id) return;
            const mediaType =
                String(typeHint || '').toLowerCase() === 'series' ||
                String(typeHint || '').toLowerCase() === 'tv'
                    ? 'series'
                    : 'movie';
            const title = extractPageTitle();
            const mountToken = `${id}:s0e0`;
            const ctx = { id, mediaType, mountToken, title };
            const cached = peekCachedRatings(id);

            let host = ensureDetailHost();
            if (cached?.length && host) {
                paintDetailHost(isLiveDetailHost(host) ? host : ensureDetailHost() || host, cached, ctx);
            }

            const ratings = await fetchRatingsProgressive(id, typeHint, null, (partial) => {
                const live = isLiveDetailHost(host) ? host : ensureDetailHost();
                if (!live?.isConnected || !partial.length) return;
                paintDetailHost(live, partial, ctx);
            });
            const liveHost = isLiveDetailHost(host) ? host : ensureDetailHost();
            if (!liveHost?.isConnected) {
                if (!ratings.length) restoreNativeImdbButtons();
                return;
            }
            liveHost.dataset.imdbId = id;
            liveHost.dataset.mediaType = mediaType;
            liveHost.dataset.msbToken = mountToken;
            if (!ratings.length) {
                restoreNativeImdbButtons();
                liveHost.hidden = true;
                liveHost.innerHTML = '';
                delete liveHost.dataset.msbRendered;
                delete liveHost.dataset.msbSignature;
                return;
            }
            paintDetailHost(liveHost, ratings, ctx);
        }

        /**
         * Episode chips in the same ratings row as series scores. Never remounts the series host.
         * @param {string} imdbId
         * @param {string|null} [typeHint]
         * @param {{ season?: number|null, episode?: number|null, exactCinemeta?: boolean, episodeLayout?: string }} [episodeRef]
         * @returns {Promise<void>}
         */
        async function mountEpisodeRatings(imdbId, typeHint = null, episodeRef = null) {
            const id = normalizeImdbId(imdbId);
            if (!id) return;
            const season = Number(episodeRef?.season) || 0;
            const episode = Number(episodeRef?.episode) || 0;
            if (season <= 0 && episode <= 0) {
                removeEpisodeHost();
                return;
            }
            let host = ensureEpisodeHost();
            if (!host) return;
            const mediaType =
                String(typeHint || '').toLowerCase() === 'series' ||
                String(typeHint || '').toLowerCase() === 'tv' ||
                String(typeHint || '').toLowerCase() === 'anime'
                    ? 'series'
                    : 'movie';
            const title = extractPageTitle();
            const layoutKey = episodeCacheSuffix(episodeRef);
            const mountToken = `${id}:s${season}e${episode}${layoutKey}`;
            host.dataset.imdbId = id;
            host.dataset.mediaType = mediaType;
            host.dataset.msbToken = mountToken;
            host.dataset.season = String(season);
            host.dataset.episode = String(episode);
            if (title) host.dataset.title = title;
            if (host.dataset.msbRendered !== mountToken) {
                host.innerHTML = '';
                host.hidden = true;
                delete host.dataset.msbRendered;
                delete host.dataset.msbSignature;
            }
            const ratings = await fetchRatingsProgressive(id, typeHint, episodeRef, (partial) => {
                if (!host?.isConnected || !partial.length) return;
                const live = ensureEpisodeHost();
                if (live) host = live;
                ensureStyles();
                host.className = BAR_CLASS;
                host.dataset.msbHost = 'episode';
                host.hidden = false;
                const signature = `ep|${ratingsSignature(partial)}`;
                if (host.dataset.msbSignature !== signature) {
                    host.innerHTML = `<span class="msb-ep-label">Episode</span>${partial.map(itemHtml).join('')}`;
                    host.dataset.msbSignature = signature;
                    wireClicks(host);
                }
                host.dataset.msbRendered = mountToken;
            });
            if (!host.isConnected) {
                host = ensureEpisodeHost();
                if (!host) return;
            }
            if (!ratings.length) {
                hideEpisodeHost(host);
                return;
            }
            const liveTitle = extractPageTitle() || title;
            ensureStyles();
            host.className = BAR_CLASS;
            host.dataset.msbHost = 'episode';
            host.dataset.imdbId = id;
            host.dataset.mediaType = mediaType;
            host.dataset.msbToken = mountToken;
            host.dataset.season = String(season);
            host.dataset.episode = String(episode);
            if (liveTitle) host.dataset.title = liveTitle;
            host.hidden = false;
            const signature = `ep|${ratingsSignature(ratings)}`;
            if (host.dataset.msbSignature !== signature) {
                host.innerHTML = `<span class="msb-ep-label">Episode</span>${ratings.map(itemHtml).join('')}`;
                host.dataset.msbSignature = signature;
                wireClicks(host);
            }
            host.dataset.msbRendered = mountToken;
        }

        window.__mystremioRatingsBar = {
            fetchRatings,
            peekCachedRatings,
            buildBarHtml,
            renderInto,
            ensureStyles,
            hideNativeImdbButtons,
            restoreNativeImdbButtons,
            mountOnDetail,
            mountEpisodeRatings,
            removeEpisodeHost,
            isLiveDetailHost,
            normalizeImdbId,
            openExternalUrl,
            buildRatingSourceUrl,
        };
    })();
    } catch (err) {
        try {
            console.warn('[DataEnrichment] ratings bar install failed', err);
        } catch (_) {}
    }


    const PLUGIN_ID = 'data-enrichment';
    const LEGACY_CONFIG_KEY = 'dataEnrichmentConfig';
    const MIGRATION_DONE_KEY = 'dataEnrichmentMigrated';
    const SETTING_KEYS = {
        TMDB_API_KEY: 'tmdbApiKey',
        RPDB_API_KEY: 'rpdbApiKey',
        MDBLIST_API_KEY: 'mdblistApiKey',
        ENHANCED_CAST: 'enhancedCast',
        SIMILAR_TITLES: 'similarTitles',
        SHOW_COLLECTION: 'showCollection',
        POSTER_RATINGS: 'showRatingsOnPosters',
        EPISODE_RATINGS: 'showEpisodeRatings',
    };

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Normalizes a TMDB genre label for icon lookup.
     * @param {string} genreName
     * @returns {string}
     */
    function normalizeGenreKey(genreName) {
        return String(genreName || '')
            .toLowerCase()
            .replace(/&/g, ' and ')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim()
            .replace(/\s+/g, ' ');
    }
    
    /**
     * Resolves a stable icon key from TMDB genre id and/or name.
     * @param {string} genreName
     * @param {number|string|undefined|null} genreId
     * @returns {string|null}
     */
    function resolveGenreIconKey(genreName, genreId) {
        /** @type {Record<number, string>} */
        const byId = {
            28: 'action',
            12: 'adventure',
            16: 'animation',
            35: 'comedy',
            80: 'crime',
            99: 'documentary',
            18: 'drama',
            10751: 'family',
            14: 'fantasy',
            36: 'history',
            27: 'horror',
            10402: 'music',
            9648: 'mystery',
            10749: 'romance',
            878: 'scifi',
            10770: 'tv',
            53: 'thriller',
            10752: 'war',
            37: 'western',
            10759: 'action',
            10762: 'family',
            10763: 'documentary',
            10764: 'tv',
            10765: 'scifi',
            10766: 'drama',
            10767: 'talk',
            10768: 'war',
        };
    
        const idNum = Number(genreId);
        if (Number.isFinite(idNum) && byId[idNum]) return byId[idNum];
    
        const name = normalizeGenreKey(genreName);
        /** @type {Record<string, string>} */
        const byName = {
            action: 'action',
            adventure: 'adventure',
            animation: 'animation',
            comedy: 'comedy',
            crime: 'crime',
            documentary: 'documentary',
            drama: 'drama',
            family: 'family',
            fantasy: 'fantasy',
            history: 'history',
            horror: 'horror',
            music: 'music',
            mystery: 'mystery',
            romance: 'romance',
            'science fiction': 'scifi',
            'sci fi': 'scifi',
            scifi: 'scifi',
            'tv movie': 'tv',
            thriller: 'thriller',
            war: 'war',
            western: 'western',
            'action and adventure': 'action',
            'sci fi and fantasy': 'scifi',
            'war and politics': 'war',
            kids: 'family',
            news: 'documentary',
            reality: 'tv',
            soap: 'drama',
            talk: 'talk',
        };
        if (byName[name]) return byName[name];
    
        if (name.includes('horror')) return 'horror';
        if (name.includes('thriller')) return 'thriller';
        if (name.includes('comedy')) return 'comedy';
        if (name.includes('romance') || name.includes('love')) return 'romance';
        if (name.includes('western')) return 'western';
        if (name.includes('war') || name.includes('politic')) return 'war';
        if (name.includes('sci') || name.includes('fantasy')) return 'scifi';
        if (name.includes('action')) return 'action';
        if (name.includes('adventure')) return 'adventure';
        if (name.includes('animat')) return 'animation';
        if (name.includes('crime')) return 'crime';
        if (name.includes('document') || name.includes('news')) return 'documentary';
        if (name.includes('drama') || name.includes('soap')) return 'drama';
        if (name.includes('family') || name.includes('kids')) return 'family';
        if (name.includes('histor')) return 'history';
        if (name.includes('music')) return 'music';
        if (name.includes('myster')) return 'mystery';
        if (name.includes('talk')) return 'talk';
        if (name.includes('tv') || name.includes('reality')) return 'tv';
        return null;
    }
    
    /**
     * Returns a small inline SVG icon for a TMDB genre (no artwork).
     * Prefer genre id for TV compound names like "War & Politics".
     * @param {string} genreName
     * @param {number|string|undefined|null} [genreId]
     * @returns {string} SVG markup
     */
    function getGenreIconSvg(genreName, genreId) {
        const iconKey = resolveGenreIconKey(genreName, genreId);
        const bold = iconKey === 'crime' || iconKey === 'drama' || iconKey === 'war';
        const strokeW = bold ? '2.25' : '2';
        const attrs =
            `class="enhanced-genre-icon" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;

        /** Lucide-style stroke icons (readable at 28px). @type {Record<string, string>} */
        const icons = {
            action:
                '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
            adventure:
                '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
            animation:
                '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/><path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
            comedy:
                '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/>',
            /* Heroicons-style fingerprint (matches user ref image 3) */
            crime:
                '<path d="M7.864 4.243A7.5 7.5 0 0 1 19.5 10.5c0 2.92-.556 5.709-1.568 8.268"/><path d="M5.742 6.364A7.465 7.465 0 0 0 4.5 10.5a7.464 7.464 0 0 1-1.15 3.993"/><path d="M6.581 17.916A11.209 11.209 0 0 0 8.25 10.5a3.75 3.75 0 1 1 7.5 0c0 .527-.021 1.049-.064 1.565"/><path d="M12 10.5a14.94 14.94 0 0 1-3.6 9.75"/><path d="M15.033 15.654a18.666 18.666 0 0 1-2.485 5.33"/>',
            documentary:
                '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
            /* Theater comedy + tragedy masks (Lucide drama ÔÇö matches user ref) */
            drama:
                '<path d="M10 11h.01"/><path d="M14 6h.01"/><path d="M18 6h.01"/><path d="M6.5 13.1h.01"/><path d="M22 5c0 9-4 12-6 12s-6-3-6-12c0-2 2-3 6-3s6 1 6 3"/><path d="M17.4 9.9c-.8.8-2 .8-2.8 0"/><path d="M10.1 7.1C9 7.2 7.7 7.7 6 8.6c-3.5 2-4.7 3.9-3.7 5.6 4.5 7.8 9.5 8.4 11.2 7.4.9-.5 1.9-2.1 1.9-4.7"/><path d="M9.1 16.5c.3-1.1 1.4-1.7 2.4-1.4"/>',
            family:
                '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
            fantasy:
                '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
            history:
                '<line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
            horror:
                '<path d="M12 2c-4.2 0-7.5 2.8-7.5 6.5 0 2.4 1.2 4.2 2.6 5.4V16c0 .6.4 1 1 1h1.2l.6 3h3.2l.6-3H15c.6 0 1-.4 1-1v-2.1c1.4-1.2 2.6-3 2.6-5.4C18.5 4.8 15.2 2 12 2z"/><circle cx="9" cy="9.5" r="1.4"/><circle cx="15" cy="9.5" r="1.4"/><path d="M11.2 12.2h1.6l-.8 1.4z" fill="currentColor" stroke="none"/><path d="M9.5 16.5h5M10.2 19.5h.01M13.8 19.5h.01"/>',
            music:
                '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
            mystery:
                '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
            romance:
                '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
            scifi:
                '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
            tv: '<rect width="20" height="15" x="2" y="7" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/>',
            thriller:
                '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
            /* Crossed swords X ÔÇö tips up, crossguards, round pommels (user ref image 4) */
            war:
                '<circle cx="5" cy="20" r="1.65" fill="currentColor" stroke="none"/><path d="M6.3 18.7 9 15.5"/><path d="M7.5 13.2 11.5 16.6"/><path d="M10 14.6 19 3.5"/><circle cx="19" cy="20" r="1.65" fill="currentColor" stroke="none"/><path d="M17.7 18.7 15 15.5"/><path d="M12.5 16.6 16.5 13.2"/><path d="M14 14.6 5 3.5"/>',
            western:
                '<path d="M12 3l2.2 4.5 5 .7-3.6 3.5.9 5L12 14.8 7.5 16.7l.9-5L4.8 8.2l5-.7L12 3z"/><circle cx="12" cy="11" r="2"/>',
            talk:
                '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect width="4" height="10" x="10" y="2" rx="2"/>',
        };
    
        const fallback =
            '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>';

        const body = (iconKey && icons[iconKey]) || fallback;
        return `<svg ${attrs}>${body}</svg>`;
    }

    function getDefaultConfig() {
        return {
            tmdbApiKey: '',
            rpdbApiKey: '',
            enhancedCast: true,
            description: true,
            maturityRating: true,
            similarTitles: true,
            showCollection: true,
            showRatingsOnPosters: true,
            showEpisodeRatings: true,
        };
    }

    function normalizeString(value) {
        return value == null ? '' : String(value).trim();
    }

    function normalizeToggle(value, fallback = false) {
        if (value === true || value === 'true' || value === 1 || value === '1') return true;
        if (value === false || value === 'false' || value === 0 || value === '0') return false;
        return fallback;
    }

    class DataEnrichment {
        constructor() {
            this.config = getDefaultConfig();
            this.cache = new Map();
            this.observer = null;
            this.enrichedImdbId = null;
            this._activeMetaId = null;
            this.lastEnrichmentTime = 0;
            /** Monotonic session id ÔÇö bumped on every navigation to cancel stale enrich. */
            this.sessionId = 0;
            /** @type {AbortController|null} */
            this.enrichAbort = null;
            this.checkDebounceTimer = null;
            this.posterDebounceTimer = null;
            this.reconcileTimer = null;
            this._backupTimer = null;
            this._boundOnRouteChange = null;
            this._boundOnStreamsBack = null;
            this._boundOnEpisodeClick = null;
            /** @type {Element|null} Mount identity ÔÇö remount when React replaces meta-info. */
            this._mountEl = null;
            /** @type {string|null} `type/metaId/videoId` ÔÇö episodeÔåöoverview invalidates. */
            this._activeDetailKey = null;
            /** Bumped when leaving the episode surface so in-flight chip jobs cannot repaint leftover scores. */
            this._episodePaintGen = 0;
            /** @type {{ season: number, episode: number, episodeLayout?: string, exactCinemeta?: boolean }|null} */
            this._pendingEpisodeRef = null;
            this._episodeRetryTimer = null;
            this._episodeRetryCount = 0;
            /** @type {ReturnType<typeof setTimeout>[]} */
            this._remountTimers = [];
            /** @type {ReturnType<typeof setTimeout>|null} Coalesces route + streams-back. */
            this._forceRemountDebounce = null;
            this.pendingFetchId = null;
            this.pendingFetch = null;
            /** @type {Map<string, string>} Cinemeta imdbRating by tt id. */
            this.cinemetaRatingCache = new Map();
            /** @type {Map<string, Promise<string|null>>} */
            this.cinemetaRatingPending = new Map();
            this.settingsReady = this.bootstrapSettings();
            this.init();
        }

        getSettingsApi() {
            return window.StremioCustomAPI || window.StremioEnhancedAPI || null;
        }

        readSetting(key) {
            const api = this.getSettingsApi();
            return api ? api.getSetting(PLUGIN_ID, key) : Promise.resolve(null);
        }

        writeSetting(key, value) {
            const api = this.getSettingsApi();
            return api ? api.saveSetting(PLUGIN_ID, key, value) : Promise.resolve();
        }

        loadLegacyConfig() {
            try {
                const saved = localStorage.getItem(LEGACY_CONFIG_KEY);
                if (!saved) return getDefaultConfig();
                return { ...getDefaultConfig(), ...JSON.parse(saved) };
            } catch (_) {
                return getDefaultConfig();
            }
        }

        applyConfigFromPayload(payload = {}) {
            this.config = {
                ...getDefaultConfig(),
                tmdbApiKey: normalizeString(payload[SETTING_KEYS.TMDB_API_KEY] ?? this.config.tmdbApiKey),
                rpdbApiKey: normalizeString(payload[SETTING_KEYS.RPDB_API_KEY] ?? this.config.rpdbApiKey),
                enhancedCast: normalizeToggle(
                    payload[SETTING_KEYS.ENHANCED_CAST],
                    this.config.enhancedCast
                ),
                similarTitles: normalizeToggle(
                    payload[SETTING_KEYS.SIMILAR_TITLES],
                    this.config.similarTitles
                ),
                showCollection: normalizeToggle(
                    payload[SETTING_KEYS.SHOW_COLLECTION],
                    this.config.showCollection
                ),
                showRatingsOnPosters: normalizeToggle(
                    payload[SETTING_KEYS.POSTER_RATINGS],
                    this.config.showRatingsOnPosters
                ),
                showEpisodeRatings: normalizeToggle(
                    payload[SETTING_KEYS.EPISODE_RATINGS],
                    this.config.showEpisodeRatings
                ),
            };
        }

        async loadSettings() {
            const api = this.getSettingsApi();
            if (!api) {
                this.config = this.loadLegacyConfig();
                return;
            }

            if (api.getPluginConfig) {
                const payload = await api.getPluginConfig(PLUGIN_ID);
                if (payload && typeof payload === 'object') {
                    this.applyConfigFromPayload(payload);
                    return;
                }
            }

            const [
                tmdbApiKey,
                rpdbApiKey,
                enhancedCast,
                similarTitles,
                showCollection,
                showRatingsOnPosters,
                showEpisodeRatings,
            ] = await Promise.all([
                this.readSetting(SETTING_KEYS.TMDB_API_KEY),
                this.readSetting(SETTING_KEYS.RPDB_API_KEY),
                this.readSetting(SETTING_KEYS.ENHANCED_CAST),
                this.readSetting(SETTING_KEYS.SIMILAR_TITLES),
                this.readSetting(SETTING_KEYS.SHOW_COLLECTION),
                this.readSetting(SETTING_KEYS.POSTER_RATINGS),
                this.readSetting(SETTING_KEYS.EPISODE_RATINGS),
            ]);

            this.config = {
                ...getDefaultConfig(),
                tmdbApiKey: normalizeString(tmdbApiKey),
                rpdbApiKey: normalizeString(rpdbApiKey),
                enhancedCast: normalizeToggle(enhancedCast, true),
                similarTitles: normalizeToggle(similarTitles, true),
                showCollection: normalizeToggle(showCollection, true),
                showRatingsOnPosters: normalizeToggle(showRatingsOnPosters, true),
                showEpisodeRatings: normalizeToggle(showEpisodeRatings, true),
            };
        }

        async initializeSettings() {
            const api = this.getSettingsApi();
            if (!api || window.__dataEnrichmentSettingsRegistered) return;

            const schema = [
                {
                    key: SETTING_KEYS.TMDB_API_KEY,
                    type: 'input',
                    label: 'TMDB API Key',
                    placeholder: 'Enter your TMDB API key',
                    description: 'Get your free API key at themoviedb.org/settings/api',
                    defaultValue: '',
                },
                {
                    key: SETTING_KEYS.RPDB_API_KEY,
                    type: 'input',
                    label: 'RPDB API Key',
                    placeholder: 'Enter your RPDB API key',
                    description: 'Get your API key at ratingposterdb.com (https://ratingposterdb.com). Overlay needs a resolvable IMDb/TMDB id on the card; Cinemeta rows need an RPDB-capable addon or Default Poster Manager.',
                    defaultValue: '',
                },
                {
                    key: SETTING_KEYS.MDBLIST_API_KEY,
                    type: 'input',
                    label: 'MDBList API Key (Ratings)',
                    placeholder: 'Enter your MDBList API key',
                    description: 'Ratings (Detail + Meta Hover): Metacritic, Trakt, RT, MC Users and more via MDBList. Without a key: Aggregator + Cinemeta only. Free key: https://mdblist.com/preferences/',
                    defaultValue: '',
                },
                {
                    key: SETTING_KEYS.ENHANCED_CAST,
                    type: 'toggle',
                    label: 'Enhanced Cast Section',
                    defaultValue: true,
                },
                {
                    key: SETTING_KEYS.SIMILAR_TITLES,
                    type: 'toggle',
                    label: 'Similar Titles',
                    defaultValue: true,
                },
                {
                    key: SETTING_KEYS.SHOW_COLLECTION,
                    type: 'toggle',
                    label: 'Show Collection',
                    defaultValue: true,
                },
                {
                    key: SETTING_KEYS.POSTER_RATINGS,
                    type: 'toggle',
                    label: 'Ratings on Posters',
                    defaultValue: true,
                },
                {
                    key: SETTING_KEYS.EPISODE_RATINGS,
                    type: 'toggle',
                    label: 'Episode Ratings',
                    description:
                        'Second chip bar on episode pages (season/episode scores). Series scores stay in the title bar.',
                    defaultValue: true,
                },
            ];

            try {
                await api.registerSettings(PLUGIN_ID, schema);
                window.__dataEnrichmentSettingsRegistered = true;
            } catch (err) {
                const message = err && err.message ? String(err.message) : '';
                if (message.includes('settings schema registered')) {
                    window.__dataEnrichmentSettingsRegistered = true;
                } else {
                    console.warn('[DataEnrichment] Failed to register settings:', err);
                }
            }
        }

        async migrateLegacyConfig() {
            try {
                if (localStorage.getItem(MIGRATION_DONE_KEY) === '1') return;
            } catch (_) {}

            const api = this.getSettingsApi();
            if (!api) return;

            if (api.getPluginConfig) {
                const currentConfig = await api.getPluginConfig(PLUGIN_ID);
                if (normalizeString(currentConfig?.[SETTING_KEYS.TMDB_API_KEY])) {
                    try {
                        localStorage.setItem(MIGRATION_DONE_KEY, '1');
                    } catch (_) {}
                    return;
                }
            }

            const legacy = this.loadLegacyConfig();
            const migrations = [
                [SETTING_KEYS.ENHANCED_CAST, legacy.enhancedCast],
                [SETTING_KEYS.SIMILAR_TITLES, legacy.similarTitles],
                [SETTING_KEYS.SHOW_COLLECTION, legacy.showCollection],
                [SETTING_KEYS.POSTER_RATINGS, legacy.showRatingsOnPosters],
            ];

            let migrated = false;
            for (const [key, value] of migrations) {
                const current = await this.readSetting(key);
                const hasCurrent =
                    current !== null &&
                    current !== undefined &&
                    !(typeof current === 'string' && current.trim() === '');
                if (hasCurrent) continue;
                if (value === undefined || value === null || value === '') continue;
                await this.writeSetting(key, value);
                migrated = true;
            }

            if (migrated) {
                try {
                    localStorage.removeItem(LEGACY_CONFIG_KEY);
                } catch (_) {}
            }

            try {
                localStorage.setItem(MIGRATION_DONE_KEY, '1');
            } catch (_) {}
        }

        setupSettingsListener() {
            const api = this.getSettingsApi();
            if (!api?.onSettingsSaved) return;

            api.onSettingsSaved(PLUGIN_ID, (payload) => {
                this.applyConfigFromPayload(payload);
                this.cache.clear();
                this.pendingFetchId = null;
                this.pendingFetch = null;
                this.enrichedImdbId = null;
                this.reconcile();
                this.checkForPosters();
            });
        }

        /**
         * Extracts a normalized IMDb title id (ttÔÇª) from any raw string.
         * @param {string|null|undefined} raw
         * @returns {string|null}
         */
        normalizeImdbId(raw) {
            const match = String(raw || '').match(/tt\d+/i);
            return match ? match[0].toLowerCase() : null;
        }

        /**
         * Single source of truth for detail navigation intent.
         * videoId (Continue Watching / streams deep-link) does NOT block enrichment.
         * @param {string} [hash]
         * @returns {{
         *   surface: 'none'|'detail'|'player',
         *   type: string|null,
         *   metaId: string|null,
         *   videoId: string|null,
         *   imdbId: string|null,
         *   shouldEnrich: boolean
         * }}
         */
        parseDetailRoute(hash = window.location.hash) {
            const h = String(hash || '');
            const path = h.split('?')[0];

            if (/#\/player\b/i.test(h)) {
                return {
                    surface: 'player',
                    type: null,
                    metaId: null,
                    videoId: null,
                    imdbId: null,
                    shouldEnrich: false,
                };
            }

            const match = path.match(
                /#\/(?:detail|metadetails|meta)\/([^/]+)\/([^/]+)(?:\/([^/]+))?/i
            );
            if (!match) {
                return {
                    surface: 'none',
                    type: null,
                    metaId: null,
                    videoId: null,
                    imdbId: null,
                    shouldEnrich: false,
                };
            }

            const type = match[1] || null;
            const metaId = match[2] || null;
            const query = new URLSearchParams(h.includes('?') ? h.slice(h.indexOf('?') + 1) : '');
            const videoFromQuery =
                query.get('video') || query.get('videoId') || query.get('video_id') || null;
            let videoId = match[3] || videoFromQuery || null;
            if (!videoId && metaId) {
                const fromMeta = this.parseEpisodeRef({ videoId: metaId, metaId });
                if (fromMeta.episode) videoId = metaId;
            }
            const imdbId = this.normalizeImdbId(metaId) || this.normalizeImdbId(videoId);

            return {
                surface: 'detail',
                type,
                metaId,
                videoId,
                imdbId,
                shouldEnrich: true,
            };
        }

        /**
         * Stable identity for a detail navigation (episode Ôåö overview changes videoId).
         * @param {{ type?: string|null, metaId?: string|null, videoId?: string|null, surface?: string }} route
         * @returns {string|null}
         */
        detailKey(route) {
            if (!route || route.surface !== 'detail') return null;
            return `${route.type || ''}/${route.metaId || ''}/${route.videoId || ''}`;
        }

        /**
         * @param {string} [hash]
         * @returns {boolean}
         */
        isDetailRoute(hash = window.location.hash) {
            return this.parseDetailRoute(hash).surface === 'detail';
        }

        /**
         * @param {string|null|undefined} value
         * @returns {string}
         */
        decodeRouteId(value) {
            const raw = String(value || '').trim();
            if (!raw) return '';
            try {
                return decodeURIComponent(raw).trim();
            } catch (_) {
                return raw;
            }
        }

        /**
         * @param {string|null|undefined} metaId
         * @returns {{ raw: string, tmdbId: number|null, imdbId: string|null }}
         */
        parseCatalogMetaId(metaId) {
            const raw = this.decodeRouteId(metaId);
            const tmdb = raw.match(/^tmdb:(\d+)/i);
            if (tmdb) {
                return { raw, tmdbId: Number(tmdb[1]), imdbId: null };
            }
            return { raw, tmdbId: null, imdbId: this.normalizeImdbId(raw) };
        }

        /**
         * @param {string|null|undefined} typeHint
         * @returns {'tv'|'movie'}
         */
        tmdbMediaType(typeHint) {
            const type = String(typeHint || '').toLowerCase();
            return type === 'movie' ? 'movie' : 'tv';
        }

        /**
         * Visible series/movie details root — never the board/CW strip.
         * @param {Element|null} [mount]
         * @returns {Element|null}
         */
        detailsRoot(mount = null) {
            return (
                mount?.closest('[class*="meta-details"], [class*="meta-preview"]') ||
                document.querySelector(
                    '[class*="meta-details"]:not([class*="placeholder"])'
                ) ||
                null
            );
        }

        /**
         * IMDb only inside the current details tree.
         * @param {Element|null} root
         * @returns {string|null}
         */
        extractImdbIdFromRoot(root) {
            if (!root) return null;
            const imdbLink = root.querySelector('a[href*="imdb.com/title/tt"]');
            if (imdbLink) {
                const fromLink = this.normalizeImdbId(imdbLink.href || imdbLink.getAttribute('href'));
                if (fromLink) return fromLink;
            }
            const metaElements = root.querySelectorAll('[data-imdbid], [data-imdb-id]');
            for (const el of metaElements) {
                const fromData = this.normalizeImdbId(el.dataset.imdbid || el.dataset.imdbId);
                if (fromData) return fromData;
            }
            const links = root.querySelectorAll('a[href*="imdb"]');
            for (const link of links) {
                const fromHref = this.normalizeImdbId(link.href || link.getAttribute('href'));
                if (fromHref) return fromHref;
            }
            return null;
        }

        /**
         * Title of the open details page only.
         * @param {Element|null} root
         * @returns {string}
         */
        extractTitleFromRoot(root) {
            if (!root) return '';
            const logo = root.querySelector(
                'img[class*="logo"][alt], [class*="logo-container"] img[alt], [class*="meta-details"] img[alt]'
            )?.getAttribute('alt');
            if (logo && String(logo).trim().length > 1) return String(logo).trim();
            const name = root.querySelector(
                '[class*="title-name"], [class*="name-container"] [class*="name-"], [class*="title-container"], h1, h2'
            )?.textContent;
            return String(name || '').replace(/\s+/g, ' ').trim();
        }

        /**
         * IMDb from a TMDB payload (title-search path for kitsu: hashes).
         * @param {object|null} data
         * @returns {string|null}
         */
        imdbFromTmdbData(data) {
            return this.normalizeImdbId(data?.external_ids?.imdb_id || data?.imdb_id);
        }

        /**
         * Raster for a catalog video id: Cinemeta tt:s:e, TMDB tmdb:id:s:e, Kitsu ordinal.
         * @param {string|null|undefined} videoId
         * @param {string|null|undefined} [metaId]
         * @returns {'tmdb'|'cinemeta'|'absolute'|null}
         */
        episodeLayoutFromIds(videoId, metaId = null) {
            const ids = [this.decodeRouteId(videoId), this.decodeRouteId(metaId)].filter(Boolean);
            for (const id of ids) {
                if (/^kitsu:/i.test(id)) return 'absolute';
                if (/^tt\d+:\d+:\d+/i.test(id)) return 'cinemeta';
                if (/^tmdb:(?:tv|show|movie):/i.test(id) || /^tmdb:/i.test(id)) return 'tmdb';
                if (/^\d+:\d+:\d+(?:\b|$)/.test(id)) return 'tmdb';
            }
            const meta = this.decodeRouteId(metaId);
            const video = this.decodeRouteId(videoId);
            if (/^kitsu:/i.test(meta) && /^\d+:\d+$/.test(video)) return 'absolute';
            if (/^tt\d+:\d+$/i.test(video) && !/:\d+:\d+/.test(video)) return 'absolute';
            return null;
        }

        /**
         * Season/episode from the detail videoId (episode page only).
         * Accepts tmdb:tv|show:id:s:e, tmdb:id:s:e, bare id:s:e, tt…:s:e, and kitsu:id:ordinal.
         * @param {{ videoId?: string|null, metaId?: string|null }} route
         * @returns {{ season: number|null, episode: number|null, exactCinemeta?: boolean, absolute?: boolean, episodeLayout?: string }}
         */
        parseEpisodeRef(route) {
            const videoId = this.decodeRouteId(route?.videoId);
            if (!videoId) return { season: null, episode: null };
            const candidates = [videoId];
            const tail = videoId.split('/').pop();
            if (tail && tail !== videoId) candidates.push(tail);

            const metaIsKitsu = /^kitsu:/i.test(this.decodeRouteId(route?.metaId || ''));

            for (const id of candidates) {
                const kitsu = id.match(/^kitsu:(\d+):(\d{1,4})(?:\b|$)/i);
                if (kitsu) {
                    return {
                        season: 1,
                        episode: Number(kitsu[2]),
                        absolute: true,
                        exactCinemeta: false,
                        episodeLayout: 'absolute',
                    };
                }
                if (metaIsKitsu) {
                    const kitsuBare = id.match(/^(\d+):(\d{1,4})$/);
                    if (kitsuBare) {
                        return {
                            season: 1,
                            episode: Number(kitsuBare[2]),
                            absolute: true,
                            exactCinemeta: false,
                            episodeLayout: 'absolute',
                        };
                    }
                }
                const tt = id.match(/^(tt\d{7,8}):(\d{1,3}):(\d{1,4})(?:\b|$)/i);
                if (tt) {
                    return {
                        season: Number(tt[2]),
                        episode: Number(tt[3]),
                        episodeLayout: 'cinemeta',
                        exactCinemeta: true,
                    };
                }
                const ttAbsolute = id.match(/^(tt\d{7,8}):(\d{1,4})$/i);
                if (ttAbsolute) {
                    return {
                        season: 1,
                        episode: Number(ttAbsolute[2]),
                        absolute: true,
                        exactCinemeta: false,
                        episodeLayout: 'absolute',
                    };
                }
                const tmdbTyped = id.match(
                    /^tmdb:(?:tv|show|movie):(\d+):(\d{1,3}):(\d{1,4})(?:\b|$)/i
                );
                if (tmdbTyped) {
                    return {
                        season: Number(tmdbTyped[2]),
                        episode: Number(tmdbTyped[3]),
                        episodeLayout: 'tmdb',
                    };
                }
                const tmdbOrBare = id.match(/^(?:tmdb:)?(\d+):(\d{1,3}):(\d{1,4})(?:\b|$)/i);
                if (tmdbOrBare) {
                    return {
                        season: Number(tmdbOrBare[2]),
                        episode: Number(tmdbOrBare[3]),
                        episodeLayout: 'tmdb',
                    };
                }
                const tmdbTrailing = id.match(/^tmdb:.+:(\d{1,3}):(\d{1,4})$/i);
                if (tmdbTrailing) {
                    return {
                        season: Number(tmdbTrailing[1]),
                        episode: Number(tmdbTrailing[2]),
                        episodeLayout: 'tmdb',
                    };
                }
            }
            return { season: null, episode: null };
        }

        /**
         * @param {string} selector
         * @returns {boolean}
         */
        isLivePanel(selector) {
            const el = document.querySelector(selector);
            if (!el?.isConnected || el.hidden) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            return el.getBoundingClientRect().height > 8;
        }

        /**
         * Episode/streams page only. Series overview never qualifies, even when Core
         * still holds the previously opened episode.
         * @param {{ videoId?: string|null, metaId?: string|null }} [route]
         * @returns {boolean}
         */
        isEpisodeDetailSurface(route) {
            const videoId = this.decodeRouteId(route?.videoId);
            const metaId = this.decodeRouteId(route?.metaId);
            if (videoId && videoId.toLowerCase() !== metaId.toLowerCase()) return true;
            const fromMeta = this.parseEpisodeRef({
                videoId: route?.metaId,
                metaId: route?.metaId,
            });
            if (fromMeta.episode) return true;
            if (this.isLivePanel('[class*="streams-list"], [class*="streams-container"]')) return true;
            return Boolean(this._pendingEpisodeRef && !this.isLivePanel('[class*="videos-list"]'));
        }

        /**
         * Episode id buried in the hash when the path parser missed tmdb:tv:…:s:e.
         * @returns {string}
         */
        episodeIdFromHash() {
            const hash = this.decodeRouteId(window.location.hash || '');
            const match =
                hash.match(/tmdb:(?:tv|show|movie):\d+:\d{1,3}:\d{1,4}/i) ||
                hash.match(/tmdb:\d+:\d{1,3}:\d{1,4}/i) ||
                hash.match(/kitsu:\d+:\d{1,4}/i) ||
                hash.match(/tt\d{7,8}:\d{1,3}:\d{1,4}/i);
            return match ? match[0] : '';
        }

        /**
         * Drop leftover episode chips without touching the series host.
         * @param {object|null} [bar]
         */
        dropStaleEpisodePaint(bar = window.__mystremioRatingsBar) {
            const host = document.querySelector('.mystremio-ratings-bar[data-msb-host="episode"]');
            let hadEpJob = false;
            if (this._pinInFlight) {
                for (const key of [...this._pinInFlight.keys()]) {
                    if (String(key).startsWith('ep:')) {
                        hadEpJob = true;
                        this._pinInFlight.delete(key);
                    }
                }
            }
            if (!host && !hadEpJob) return;
            this._episodePaintGen = (this._episodePaintGen || 0) + 1;
            bar?.removeEpisodeHost?.();
        }

        videosFromMetaState(node) {
            if (!node || typeof node !== 'object') return [];
            if (Array.isArray(node.videos)) return node.videos;
            if (node.metaItem) {
                const nested = this.videosFromMetaState(node.metaItem);
                if (nested.length) return nested;
            }
            const content = node.content;
            if (content && typeof content === 'object') {
                if (Array.isArray(content.videos)) return content.videos;
                if (Array.isArray(content.content?.videos)) return content.content.videos;
                return this.videosFromMetaState(content);
            }
            return [];
        }

        /**
         * @param {object|null} node
         * @returns {boolean}
         */
        isLoadingMetaNode(node) {
            if (!node || typeof node !== 'object') return false;
            const type = String(node.type || '').toLowerCase();
            if (type === 'loading') return true;
            if (node.metaItem) return this.isLoadingMetaNode(node.metaItem);
            if (node.content && !Array.isArray(node.content)) {
                return this.isLoadingMetaNode(node.content);
            }
            return false;
        }

        extraField(path, name) {
            const extra = path?.extra;
            if (!Array.isArray(extra)) return null;
            const hit = extra.find(
                (entry) => String(entry?.name || '').toLowerCase() === String(name).toLowerCase()
            );
            if (!hit) return null;
            return hit.value ?? hit.id ?? null;
        }

        /**
         * Core selected stream path + optional seriesInfo from meta_details.
         * @param {object|null} node
         * @returns {{ videoId: string|null, season: number|null, episode: number|null }|null}
         */
        selectedFromMetaState(node) {
            if (!node || typeof node !== 'object') return null;
            const selected = node.selected;
            if (selected && typeof selected === 'object') {
                const seriesInfo = selected.seriesInfo || selected.series_info || {};
                const streamPath = selected.streamPath || selected.stream_path || null;
                const metaPath = selected.metaPath || selected.meta_path || null;
                const pathId =
                    typeof streamPath === 'string'
                        ? streamPath
                        : streamPath?.id ||
                          streamPath?.video_id ||
                          streamPath?.videoId ||
                          this.extraField(streamPath, 'videoId') ||
                          this.extraField(streamPath, 'video') ||
                          null;
                const season = Number(
                    seriesInfo.season ??
                        selected.season ??
                        this.extraField(streamPath, 'season') ??
                        this.extraField(metaPath, 'season')
                );
                const episode = Number(
                    seriesInfo.episode ??
                        selected.episode ??
                        this.extraField(streamPath, 'episode') ??
                        this.extraField(metaPath, 'episode')
                );
                return {
                    videoId:
                        pathId ||
                        selected.video_id ||
                        selected.videoId ||
                        null,
                    season: Number.isInteger(season) && season > 0 ? season : null,
                    episode: Number.isInteger(episode) && episode > 0 ? episode : null,
                };
            }
            if (node.metaItem) {
                const nested = this.selectedFromMetaState(node.metaItem);
                if (nested) return nested;
            }
            if (node.content && typeof node.content === 'object' && !Array.isArray(node.content)) {
                return this.selectedFromMetaState(node.content);
            }
            return null;
        }

        /**
         * Page-eval fallback when this script cannot see window.core (same pattern as TIDB).
         * @param {string} model
         * @returns {Promise<object|null>}
         */
        evalCoreState(model) {
            const name = String(model || '').replace(/[^a-zA-Z0-9_]/g, '');
            if (!name) return Promise.resolve(null);
            return new Promise((resolve) => {
                const event = `mystremio-de-state-${Math.random().toString(36).slice(2)}`;
                const script = document.createElement('script');
                const done = (detail) => {
                    script.remove();
                    resolve(detail && typeof detail === 'object' ? detail : null);
                };
                window.addEventListener(
                    event,
                    (browserEvent) => done(browserEvent.detail),
                    { once: true }
                );
                script.textContent = `(async()=>{try{const g=(window.core&&window.core.getState)||(window.services&&window.services.core&&window.services.core.transport&&window.services.core.transport.getState);const out=typeof g==='function'?await g('${name}'):null;window.dispatchEvent(new CustomEvent('${event}',{detail:out}));}catch(err){window.dispatchEvent(new CustomEvent('${event}',{detail:null}));}})();`;
                (document.head || document.documentElement).appendChild(script);
            });
        }

        /**
         * @param {string} model
         * @returns {Promise<object|null>}
         */
        async getCoreState(model) {
            const tryGet = async (getState) => {
                if (typeof getState !== 'function') return null;
                try {
                    return await getState(model);
                } catch (_) {
                    return null;
                }
            };
            const direct =
                (await tryGet(window.core?.getState)) ||
                (await tryGet(window.services?.core?.transport?.getState));
            if (direct) return direct;
            return this.evalCoreState(model);
        }

        /**
         * @param {boolean} [retry]
         * @returns {Promise<object|null>}
         */
        async loadDetailState(retry = true) {
            let state =
                (await this.getCoreState('meta_details')) ||
                (await this.getCoreState('metaDetails'));
            if (retry && this.isLoadingMetaNode(state)) {
                await new Promise((resolve) => setTimeout(resolve, 220));
                state =
                    (await this.getCoreState('meta_details')) ||
                    (await this.getCoreState('metaDetails'));
            }
            return state;
        }

        async loadDetailVideos() {
            const state = await this.loadDetailState(true);
            return this.videosFromMetaState(state);
        }

        videoIdsMatch(left, right) {
            const a = this.decodeRouteId(left).toLowerCase();
            const b = this.decodeRouteId(right).toLowerCase();
            if (!a || !b) return false;
            if (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)) return true;
            const stripPrefix = (id) =>
                id.replace(/^(?:tmdb:(?:tv|show|movie):|tmdb:|kitsu:)/i, '');
            const sa = stripPrefix(a);
            const sb = stripPrefix(b);
            return sa === sb || a.endsWith(`:${sb}`) || b.endsWith(`:${sa}`);
        }

        episodeRefFromVideo(video) {
            if (!video) return null;
            const parsed = this.parseEpisodeRef({
                videoId: video.id || video.episode_id,
                metaId: video.id,
            });
            const layout =
                parsed.episodeLayout ||
                this.episodeLayoutFromIds(video.id || video.episode_id, video.id);
            if (parsed.absolute && parsed.episode) {
                return {
                    season: parsed.season || 1,
                    episode: parsed.episode,
                    exactCinemeta: false,
                    episodeLayout: 'absolute',
                    fromVideos: true,
                };
            }
            const season = Number(parsed.season) || Number(video.season);
            const episode = Number(parsed.episode) || Number(video.episode);
            if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) {
                return null;
            }
            return {
                season,
                episode,
                fromVideos: true,
                episodeLayout: layout || undefined,
                exactCinemeta: layout === 'cinemeta' ? true : parsed.exactCinemeta,
            };
        }

        seasonFromVideosBar() {
            const scopes = document.querySelectorAll(
                '[class*="videos-list"], [class*="series-content"], [class*="seasons"]'
            );
            for (const scope of scopes) {
                const nodes = scope.querySelectorAll(
                    'button, [class*="label"], [class*="selected"], [class*="select"]'
                );
                for (const el of nodes) {
                    const match = String(el.textContent || '').match(/(?:season|staffel)\s*(\d+)/i);
                    if (!match) continue;
                    const num = Number(match[1]);
                    if (Number.isInteger(num) && num > 0) return num;
                }
            }
            return null;
        }

        episodeRefFromVideoRow(row) {
            if (!row?.isConnected) return null;
            const title =
                row.querySelector('[class*="title-container"], [class*="video-title"]')?.textContent ||
                '';
            const epMatch = String(title).trim().match(/^(\d{1,4})\s*[.:]/);
            if (!epMatch) return null;
            const episode = Number(epMatch[1]);
            if (!Number.isInteger(episode) || episode < 1) return null;
            const season = this.seasonFromVideosBar();
            const route = this.parseDetailRoute();
            return {
                season: season || 1,
                episode,
                fromClick: true,
                episodeLayout: this.episodeLayoutFromIds(route.videoId, route.metaId) || undefined,
            };
        }

        rememberClickedEpisode(event) {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest('[class*="streams-list"]')) return;
            const row = target.closest(
                '[class*="video-container"], [class*="videos-list"] [class*="video"]'
            );
            if (!row || !row.closest('[class*="videos-list"]')) return;
            const ref = this.episodeRefFromVideoRow(row);
            if (!ref) return;
            this._pendingEpisodeRef = ref;
            this.loadDetailVideos()
                .then((videos) => {
                    const match = videos.find((video) => {
                        if (Number(video?.episode) !== ref.episode) return false;
                        if (ref.season && Number(video?.season) && Number(video.season) !== ref.season) {
                            return false;
                        }
                        return true;
                    });
                    const fromVideo = this.episodeRefFromVideo(match);
                    if (fromVideo) this._pendingEpisodeRef = fromVideo;
                })
                .catch(() => {});
        }

        isSeriesOverviewSurface() {
            return (
                this.isLivePanel('[class*="videos-list"]') &&
                !this.isLivePanel('[class*="streams-list"], [class*="streams-container"]')
            );
        }

        /**
         * Hash / video id first, then Core videos on the episode surface only.
         * Never uses leftover Core selected or the season-list UI (series overview).
         * @param {{ videoId?: string|null, metaId?: string|null }} route
         * @returns {Promise<{ season: number|null, episode: number|null, exactCinemeta?: boolean, episodeLayout?: string }>}
         */
        async resolveEpisodeRef(route) {
            if (!this.isEpisodeDetailSurface(route)) {
                return { season: null, episode: null };
            }
            let parsed = this.parseEpisodeRef(route);
            if (!parsed.episode) {
                const fromHash = this.episodeIdFromHash();
                if (fromHash) {
                    parsed = this.parseEpisodeRef({
                        videoId: fromHash,
                        metaId: route?.metaId,
                    });
                }
            }
            if (parsed.absolute && parsed.episode) {
                return {
                    season: parsed.season || 1,
                    episode: parsed.episode,
                    exactCinemeta: false,
                    episodeLayout: 'absolute',
                };
            }
            if (parsed.season && parsed.episode) return parsed;

            let state = await this.loadDetailState(true);
            let selected = this.selectedFromMetaState(state);
            let videos = this.videosFromMetaState(state);
            const videoId = this.decodeRouteId(route?.videoId || selected?.videoId);

            if (videoId && (this.isLoadingMetaNode(state) || videos.length === 0)) {
                await new Promise((resolve) => setTimeout(resolve, 220));
                if (!this.isEpisodeDetailSurface(this.parseDetailRoute())) {
                    return { season: null, episode: null };
                }
                state = await this.loadDetailState(false);
                selected = this.selectedFromMetaState(state) || selected;
                videos = this.videosFromMetaState(state);
            }

            if (videoId && videos.length) {
                const match = videos.find(
                    (video) =>
                        this.videoIdsMatch(video?.id, videoId) ||
                        this.videoIdsMatch(video?.episode_id, videoId)
                );
                const fromVideo = this.episodeRefFromVideo(match);
                if (fromVideo) return fromVideo;
            }

            if (videoId) {
                const fromPath = this.parseEpisodeRef({
                    videoId,
                    metaId: route?.metaId,
                });
                if (fromPath.absolute && fromPath.episode) {
                    return {
                        season: fromPath.season || 1,
                        episode: fromPath.episode,
                        exactCinemeta: false,
                        episodeLayout: 'absolute',
                    };
                }
                if (fromPath.season && fromPath.episode) return fromPath;
            }

            const layoutHint = this.episodeLayoutFromIds(videoId || route?.videoId, route?.metaId);

            if (selected?.season && selected?.episode) {
                return {
                    season: selected.season,
                    episode: selected.episode,
                    fromSelection: true,
                    episodeLayout: layoutHint || undefined,
                };
            }

            if (this._pendingEpisodeRef?.episode) {
                return {
                    ...this._pendingEpisodeRef,
                    episodeLayout:
                        this._pendingEpisodeRef.episodeLayout || layoutHint || undefined,
                };
            }

            const header = document.querySelector(
                '[class*="streams-list"] [class*="episode-title"], [class*="streams-container"] [class*="episode-title"]'
            );
            const headerText = String(header?.textContent || '').replace(/\s+/g, ' ').trim();
            const headerSe =
                headerText.match(/S(?:eason)?\s*(\d+)\s*[:.\-x×]?\s*E(?:p(?:isode)?)?\s*(\d+)/i) ||
                headerText.match(/\b(\d{1,2})\s*[x×]\s*(\d{1,3})\b/);
            if (headerSe) {
                return {
                    season: Number(headerSe[1]),
                    episode: Number(headerSe[2]),
                    episodeLayout: layoutHint || undefined,
                };
            }

            return parsed;
        }

        tmdbSeasonLengths(data) {
            const seasons = Array.isArray(data?.seasons) ? data.seasons : [];
            const counts = new Map();
            let maxSeason = 0;
            for (const entry of seasons) {
                const number = Number(entry?.season_number);
                if (!Number.isInteger(number) || number < 1) continue;
                counts.set(number, Number(entry?.episode_count) || 0);
                maxSeason = Math.max(maxSeason, number);
            }
            if (!maxSeason) return [];
            const lengths = [];
            for (let season = 1; season <= maxSeason; season++) {
                lengths.push(counts.get(season) || 0);
            }
            return lengths;
        }

        mapTmdbSeason(data, episodeRef) {
            const season = Number(episodeRef?.season) || 0;
            const episode = Number(episodeRef?.episode) || 0;
            if (season < 1) return null;
            const lengths = this.tmdbSeasonLengths(data);
            const length = lengths[season - 1] || 0;
            if (length > 0 && episode > length) {
                let remaining = episode;
                for (let i = 0; i < lengths.length; i++) {
                    const count = lengths[i] || 0;
                    if (remaining <= count) return i + 1;
                    remaining -= count;
                }
            }
            return season;
        }

        async fetchSeasonAggregateCredits(tmdbId, season) {
            const id = Number(tmdbId);
            const seasonN = Number(season);
            if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(seasonN) || seasonN < 1) {
                return null;
            }
            const cacheKey = `tmdb-season-cast:${id}:${seasonN}`;
            if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
            const apiKey = this.config.tmdbApiKey;
            if (!apiKey) return null;
            try {
                const url = `https://api.themoviedb.org/3/tv/${id}/season/${seasonN}/aggregate_credits?api_key=${encodeURIComponent(apiKey)}`;
                const response = await fetch(url);
                if (!response.ok) return null;
                const json = await response.json();
                this.cache.set(cacheKey, json);
                return json;
            } catch (_) {
                return null;
            }
        }

        async withSeasonCast(data, route) {
            if (!data || data.media_type !== 'tv') return data;
            const episodeRef = await this.resolveEpisodeRef(route);
            const mappedSeason = this.mapTmdbSeason(data, episodeRef);
            if (!mappedSeason) return data;
            const seasonCredits = await this.fetchSeasonAggregateCredits(data.id, mappedSeason);
            if (!Array.isArray(seasonCredits?.cast) || !seasonCredits.cast.length) return data;
            return { ...data, aggregate_credits: seasonCredits, _castSeason: mappedSeason };
        }

        /**
         * Identity for the series/movie currently in the hash — never CW posters.
         * @param {{ type?: string|null, metaId?: string|null, imdbId?: string|null }} route
         * @param {Element|null} [mount]
         * @returns {{ metaId: string, tmdbId: number|null, imdbId: string|null, type: string|null, title: string }}
         */
        resolveDetailIdentity(route, mount = null) {
            const parsed = this.parseCatalogMetaId(route?.metaId);
            const root = this.detailsRoot(mount);
            const scopedImdb = this.extractImdbIdFromRoot(root);
            return {
                metaId: parsed.raw,
                tmdbId: parsed.tmdbId,
                imdbId: parsed.imdbId || scopedImdb || null,
                type: route?.type || null,
                title: this.extractTitleFromRoot(root),
            };
        }

        /**
         * Meta-info mount aligned with detail-slogan.
         * Prefers a visible meta-info under meta-details (post MetaPreview remount).
         * @returns {Element|null}
         */
        findMetaInfoContainer() {
            const selectors = [
                '[class*="meta-info-container"]',
                '[class*="meta-preview-container"] [class*="meta-info"]',
                '[class*="meta-details-container"] [class*="meta-info"]',
            ];

            /** @type {Element[]} */
            const candidates = [];
            for (const selector of selectors) {
                for (const el of document.querySelectorAll(selector)) {
                    if (
                        el.closest(
                            '[class*="player-container"], [class*="control-bar-layer"], [class*="subtitles-menu-container"]'
                        )
                    ) {
                        continue;
                    }
                    if (el.closest('[class*="meta-preview-placeholder-container"]')) {
                        continue;
                    }
                    if (!el.isConnected) continue;
                    candidates.push(el);
                }
            }
            if (!candidates.length) return null;

            const isVisible = (el) => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };

            const underDetails = candidates.filter(
                (el) => el.closest('[class*="meta-details"]') && isVisible(el)
            );
            if (underDetails.length) return underDetails[0];

            const visible = candidates.filter(isVisible);
            if (visible.length) return visible[0];

            return candidates[0];
        }

        /**
         * @param {Element} mount
         * @param {string} metaId
         * @returns {boolean}
         */
        isPaintedInMount(mount, metaId) {
            const id = this.decodeRouteId(metaId);
            if (!mount || !id) return false;
            const container = mount.querySelector('.data-enrichment-container');
            return Boolean(
                container &&
                    container.isConnected &&
                    this.decodeRouteId(container.dataset.metaId) === id &&
                    container.querySelector(
                        '.enhanced-franchise-section, .enhanced-genres-section, .enhanced-directors-section, .enhanced-cast-section, .enhanced-similar-section, .enhanced-collection-section'
                    )
            );
        }

        async bootstrapSettings() {
            const api = this.getSettingsApi();
            if (!api) {
                this.config = this.loadLegacyConfig();
                return;
            }

            await Promise.all([
                this.initializeSettings(),
                this.migrateLegacyConfig(),
            ]);
            await this.loadSettings();
            this.setupSettingsListener();
        }

        prefetchTMDBData(imdbId) {
            const normalized = this.normalizeImdbId(imdbId);
            if (!normalized || (this.pendingFetchId === normalized && this.pendingFetch)) return;

            this.pendingFetchId = normalized;
            this.pendingFetch = this.settingsReady
                .then(() => {
                    if (!this.config.tmdbApiKey) return null;
                    return this.fetchTMDBData(normalized);
                })
                .catch(() => null)
                .then((data) => {
                    if (!data && this.pendingFetchId === normalized) {
                        this.pendingFetchId = null;
                        this.pendingFetch = null;
                    }
                    return data;
                });
        }

        /**
         * Starts a new navigation session (cancels in-flight fetch completions).
         */
        beginNewSession() {
            this.sessionId += 1;
            if (this.enrichAbort) {
                try {
                    this.enrichAbort.abort();
                } catch (_) {}
            }
            this.enrichAbort = new AbortController();
            return this.sessionId;
        }

        /**
         * @param {number} [delayMs]
         */
        scheduleReconcile(delayMs = 80) {
            // Ladder owns the remount window ÔÇö avoid stacking extra timers.
            if (this._remountTimers.length > 0) return;
            if (this.reconcileTimer) {
                clearTimeout(this.reconcileTimer);
            }
            this.reconcileTimer = setTimeout(() => {
                this.reconcileTimer = null;
                this.reconcile();
            }, delayMs);
        }

        /**
         * Fetch/cache only ÔÇö no DOM writes.
         * @param {string} imdbId
         * @param {AbortSignal|null} signal
         * @returns {Promise<object|null>}
         */
        async ensureData(imdbId, signal) {
            await this.settingsReady.catch(() => {});
            if (signal?.aborted) return null;

            imdbId = this.normalizeImdbId(imdbId);
            if (!imdbId) return null;
            if (!this.config.tmdbApiKey) return null;

            if (this.cache.has(imdbId)) {
                return this.cache.get(imdbId);
            }

            try {
                let data = null;
                if (this.pendingFetchId === imdbId && this.pendingFetch) {
                    data = await this.pendingFetch;
                }
                if (!data) {
                    data = await this.fetchTMDBData(imdbId);
                }
                if (signal?.aborted) return null;
                if (!data && this.pendingFetchId === imdbId) {
                    this.pendingFetchId = null;
                    this.pendingFetch = null;
                }
                return data || null;
            } catch (_) {
                if (this.pendingFetchId === imdbId) {
                    this.pendingFetchId = null;
                    this.pendingFetch = null;
                }
                return null;
            }
        }

        /**
         * @param {{ metaId?: string, tmdbId?: number|null, imdbId?: string|null }} identity
         * @returns {string|null}
         */
        identityCacheKey(identity) {
            const metaId = this.decodeRouteId(identity?.metaId);
            if (identity?.tmdbId) return `tmdb:${identity.tmdbId}`;
            if (identity?.imdbId) return this.normalizeImdbId(identity.imdbId);
            return metaId ? `meta:${metaId}` : null;
        }

        /**
         * Numeric Kitsu anime id from a catalog metaId (`kitsu:1555` / `kitsu:1555:12`).
         * @param {string|null|undefined} metaId
         * @returns {number|null}
         */
        parseKitsuId(metaId) {
            const raw = this.decodeRouteId(metaId);
            const match = raw.match(/^kitsu:(\d+)/i);
            if (!match) return null;
            const id = Number(match[1]);
            return Number.isFinite(id) && id > 0 ? id : null;
        }

        /**
         * Series titles + optional IMDb from Kitsu — never the episode DOM string.
         * @param {number} kitsuId
         * @returns {Promise<{ titles: string[], imdbId: string|null }>}
         */
        async fetchKitsuSeriesInfo(kitsuId) {
            const cacheKey = `kitsu-info:${kitsuId}`;
            if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
            const titles = [];
            const seen = new Set();
            const pushTitle = (value) => {
                const title = String(value || '').replace(/\s+/g, ' ').trim();
                if (!title || title.length < 2 || seen.has(title.toLowerCase())) return;
                seen.add(title.toLowerCase());
                titles.push(title);
            };
            let imdbId = null;
            try {
                const animeRes = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}`, {
                    headers: { Accept: 'application/vnd.api+json' },
                });
                if (animeRes.ok) {
                    const json = await animeRes.json();
                    const attrs = json?.data?.attributes || {};
                    pushTitle(attrs.canonicalTitle);
                    const named = attrs.titles || {};
                    pushTitle(named.en);
                    pushTitle(named.en_us);
                    pushTitle(named.en_jp);
                    pushTitle(named.ja_jp);
                }
            } catch (_) {}
            try {
                const mapRes = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}/mappings`, {
                    headers: { Accept: 'application/vnd.api+json' },
                });
                if (mapRes.ok) {
                    const json = await mapRes.json();
                    const entries = Array.isArray(json?.data) ? json.data : [];
                    for (const entry of entries) {
                        const site = String(entry?.attributes?.externalSite || entry?.attributes?.external_site || '');
                        const externalId = String(entry?.attributes?.externalId || entry?.attributes?.external_id || '');
                        if (/imdb/i.test(site)) {
                            imdbId = this.normalizeImdbId(externalId) || imdbId;
                        }
                    }
                }
            } catch (_) {}
            const info = { titles, imdbId };
            this.cache.set(cacheKey, info);
            return info;
        }

        /**
         * TMDB payload for this detail page (tmdb id, imdb, or title of THIS page).
         * @param {{ metaId: string, tmdbId?: number|null, imdbId?: string|null, type?: string|null, title?: string }} identity
         * @param {AbortSignal|null} signal
         * @returns {Promise<object|null>}
         */
        async ensureDataForIdentity(identity, signal) {
            await this.settingsReady.catch(() => {});
            if (signal?.aborted) return null;
            if (!this.config.tmdbApiKey) return null;

            const cacheKey = this.identityCacheKey(identity);
            if (cacheKey && this.cache.has(cacheKey)) {
                return this.cache.get(cacheKey);
            }
            if (identity?.imdbId && this.cache.has(identity.imdbId)) {
                return this.cache.get(identity.imdbId);
            }

            let data = null;
            if (identity?.tmdbId) {
                data = await this.fetchTMDBDataByTmdbId(identity.tmdbId, this.tmdbMediaType(identity.type));
            }
            if (!data && identity?.imdbId) {
                data = await this.ensureData(identity.imdbId, signal);
            }
            const kitsuId = this.parseKitsuId(identity?.metaId);
            if (!data && kitsuId) {
                const kitsu = await this.fetchKitsuSeriesInfo(kitsuId);
                if (signal?.aborted) return null;
                if (kitsu.imdbId) {
                    identity.imdbId = identity.imdbId || kitsu.imdbId;
                    data = await this.ensureData(kitsu.imdbId, signal);
                }
                if (!data) {
                    for (const title of kitsu.titles) {
                        data = await this.searchTmdbByTitle(title, identity.type);
                        if (!data) data = await this.searchTmdbByTitle(title, 'tv');
                        if (!data) data = await this.searchTmdbByTitle(title, 'movie');
                        if (data) break;
                    }
                }
            }
            if (!data) {
                const title = String(identity?.title || '').trim();
                if (title) {
                    data = await this.searchTmdbByTitle(title, identity.type);
                    if (!data && kitsuId) {
                        data = await this.searchTmdbByTitle(title, 'tv');
                        if (!data) data = await this.searchTmdbByTitle(title, 'movie');
                    }
                }
            }
            if (signal?.aborted) return null;
            if (data && cacheKey) this.cache.set(cacheKey, data);
            if (data && identity?.metaId) this.cache.set(`meta:${this.decodeRouteId(identity.metaId)}`, data);
            return data || null;
        }

        /**
         * Synchronous DOM paint from already-fetched TMDB data (slogan-style re-bind).
         * @param {Element} mount
         * @param {{ metaId: string, imdbId?: string|null }} identity
         * @param {object} data
         * @returns {boolean}
         */
        paint(mount, identity, data) {
            const metaId = this.decodeRouteId(identity?.metaId);
            const imdbId = this.normalizeImdbId(identity?.imdbId) || this.imdbFromTmdbData(data);
            if (!mount?.isConnected || !metaId || !data) return false;

            const liveRoute = this.parseDetailRoute();
            if (this.decodeRouteId(liveRoute.metaId) !== metaId) return false;

            if (this.isPaintedInMount(mount, metaId)) {
                this.hideNativeMetaSections(mount);
                this.enrichedImdbId = imdbId;
                this._activeMetaId = metaId;
                if (imdbId) this.pinImdbRating(imdbId, liveRoute.type);
                return true;
            }

            // Drop orphan containers outside this mount
            document.querySelectorAll('.data-enrichment-container').forEach((el) => {
                if (!mount.contains(el)) el.remove();
            });

            let container = mount.querySelector('.data-enrichment-container');
            if (!container) {
                container = document.createElement('div');
                container.className = 'data-enrichment-container';
                mount.appendChild(container);
            } else {
                container.innerHTML = '';
            }

            if (!container.isConnected) return false;

            container.dataset.metaId = metaId;
            if (imdbId) container.dataset.imdbId = imdbId;
            else delete container.dataset.imdbId;
            if (data?._castSeason) container.dataset.castSeason = String(data._castSeason);
            else delete container.dataset.castSeason;

            const oldBadge = document.querySelector('.enhanced-tmdb-badge');
            if (oldBadge) oldBadge.remove();

            const franchiseLinks = this.collectNativeFranchiseLinks(mount);
            this.injectEnhancedFranchise(franchiseLinks, container);
            this.injectEnhancedGenres(data.genres, container);
            this.injectEnhancedDirectors(this.resolveDirectors(data), container);

            if (this.config.enhancedCast) {
                const castCredits = this.resolveCastCredits(data);
                if (castCredits.cast?.length) {
                    this.injectEnhancedCast(castCredits, container);
                }
            }

            if (this.config.similarTitles) {
                let similarItems = [];
                if (data.recommendations?.results?.length > 0) {
                    similarItems = data.recommendations.results.slice(0, 15);
                } else if (data.similar?.results?.length > 0) {
                    similarItems = data.similar.results.slice(0, 15);
                }
                if (similarItems.length > 0) {
                    this.injectSimilarTitles({ results: similarItems }, container);
                }
            }

            if (this.config.showCollection && data.belongs_to_collection) {
                this.injectCollection(data.belongs_to_collection, container).catch(() => {});
            }

            if (!container.isConnected) {
                this.restoreNativeMetaSections();
                return false;
            }

            const hasInjectedSections = Boolean(
                container.querySelector(
                    '.enhanced-franchise-section, .enhanced-genres-section, .enhanced-directors-section, .enhanced-cast-section, .enhanced-similar-section, .enhanced-collection-section'
                )
            );

            if (hasInjectedSections) {
                this.hideNativeMetaSections(mount);
                this.enrichedImdbId = imdbId;
                this._activeMetaId = metaId;
                this._mountEl = mount;
                this.lastEnrichmentTime = Date.now();
                if (imdbId) this.pinImdbRating(imdbId, liveRoute.type);
                return true;
            }

            this.restoreNativeMetaSections();
            return false;
        }

        /**
         * Paints after swapping in season aggregate credits on episode pages.
         * @param {Element} mount
         * @param {{ metaId: string, imdbId?: string|null }} identity
         * @param {object} data
         * @returns {Promise<boolean>}
         */
        async paintWithCast(mount, identity, data) {
            const route = this.parseDetailRoute();
            const next = await this.withSeasonCast(data, route);
            if (this.decodeRouteId(this.parseDetailRoute().metaId) !== this.decodeRouteId(identity?.metaId)) {
                return false;
            }
            const liveMount = this.findMetaInfoContainer() || mount;
            return this.paint(liveMount, identity, next);
        }

        /**
         * Clears pending forceRemount retry timers.
         */
        clearRemountTimers() {
            for (const id of this._remountTimers) {
                clearTimeout(id);
            }
            this._remountTimers = [];
        }

        /**
         * Debounced remount ÔÇö coalesces route change + streams-back click.
         */
        forceRemount() {
            if (this._forceRemountDebounce) {
                clearTimeout(this._forceRemountDebounce);
            }
            this._forceRemountDebounce = setTimeout(() => {
                this._forceRemountDebounce = null;
                this.forceRemountNow();
            }, 80);
        }

        /**
         * Hard remount: new session, wipe stale paint, thin retry ladder.
         */
        forceRemountNow() {
            this.clearRemountTimers();
            this.beginNewSession();
            this.cleanup(true);
            this._mountEl = null;

            const route = this.parseDetailRoute();
            this._activeDetailKey = this.detailKey(route);
            const identity = this.resolveDetailIdentity(route);
            this._activeMetaId = identity.metaId || null;
            if (identity.imdbId) {
                this.prefetchTMDBData(identity.imdbId);
                this.pinImdbRating(identity.imdbId, route.type);
            }
            if (route.surface !== 'detail') return;

            const run = () => this.reconcile();
            run();
            requestAnimationFrame(run);
            for (const ms of [80, 250, 600]) {
                const id = setTimeout(() => {
                    this._remountTimers = this._remountTimers.filter((t) => t !== id);
                    run();
                }, ms);
                this._remountTimers.push(id);
            }
        }

        /**
         * Desired-state reconciler: sync re-paint from cache when React remounts.
         */
        reconcile() {
            const route = this.parseDetailRoute();

            if (route.surface !== 'detail' || !route.shouldEnrich) {
                this.dropStaleEpisodePaint();
                this.cleanup(true);
                this._mountEl = null;
                this._activeDetailKey = null;
                this._activeMetaId = null;
                return;
            }

            if (!this.isEpisodeDetailSurface(route)) {
                if (this.isSeriesOverviewSurface()) {
                    this._pendingEpisodeRef = null;
                    this.dropStaleEpisodePaint();
                }
            }

            const key = this.detailKey(route);
            if (key && this._activeDetailKey && key !== this._activeDetailKey) {
                this.beginNewSession();
                this.cleanup(true);
                this._mountEl = null;
            }
            this._activeDetailKey = key;

            const mount = this.findMetaInfoContainer();
            if (!mount) {
                const identity = this.resolveDetailIdentity(route);
                if (identity.imdbId) this.pinImdbRating(identity.imdbId, route.type);
                this.scheduleReconcile(120);
                return;
            }

            const identity = this.resolveDetailIdentity(route, mount);
            if (!identity.metaId) {
                if (identity.imdbId) this.pinImdbRating(identity.imdbId, route.type);
                this.scheduleReconcile(200);
                return;
            }
            this._activeMetaId = identity.metaId;

            const cacheKey = this.identityCacheKey(identity);
            const cached =
                (cacheKey && this.cache.get(cacheKey)) ||
                (identity.imdbId && this.cache.get(identity.imdbId)) ||
                this.cache.get(`meta:${identity.metaId}`);
            const resolvedImdb = identity.imdbId || this.imdbFromTmdbData(cached);
            if (resolvedImdb) {
                this.pinImdbRating(resolvedImdb, route.type);
            }

            const mountChanged = Boolean(this._mountEl && this._mountEl !== mount);
            if (mountChanged) {
                this._mountEl = null;
            }

            if (!mountChanged && this.isPaintedInMount(mount, identity.metaId)) {
                this.hideNativeMetaSections(mount);
                this.enrichedImdbId = resolvedImdb;
                this._mountEl = mount;
                return;
            }

            if (cached) {
                void this.paintWithCast(mount, identity, cached);
                return;
            }

            const sessionId = this.sessionId;
            const signal = this.enrichAbort?.signal || null;
            if (identity.imdbId) this.prefetchTMDBData(identity.imdbId);

            this.ensureDataForIdentity(identity, signal).then((data) => {
                if (sessionId !== this.sessionId || signal?.aborted) return;
                if (!data) {
                    this.restoreNativeMetaSections();
                    this.scheduleReconcile(800);
                    return;
                }
                const live = this.parseDetailRoute();
                if (this.decodeRouteId(live.metaId) !== identity.metaId) return;
                const remount = this.findMetaInfoContainer();
                if (!remount) {
                    this.scheduleReconcile(180);
                    return;
                }
                this.paintWithCast(remount, this.resolveDetailIdentity(live, remount), data);
            });
        }

        init() {
            console.log('[DataEnrichment] Plugin loaded successfully v2.2.0');
            this.beginNewSession();
            this.setupObserver();
            this.setupRouteListener();
            this.setupReconcileBackup();

        this.settingsReady
            .then(() => {
                const route = this.parseDetailRoute();
                if (route.imdbId) this.prefetchTMDBData(route.imdbId);
                this.reconcile();
                this.checkForPosters();
                if (window.stremioCustomSuspendBackground?.()) this.suspendBackground();
            })
                .catch(() => {
                    this.config = this.loadLegacyConfig();
                    this.reconcile();
                    this.checkForPosters();
                });
        }

        /**
         * Slow backup: if detail wants enrichment but none is painted, reconcile.
         */
        setupReconcileBackup() {
            if (this._backgroundSuspended) return;
            if (this._backupTimer) clearInterval(this._backupTimer);
            this._backupTimer = setInterval(() => {
                if (this._remountTimers.length > 0) return;
                const route = this.parseDetailRoute();
                if (!route.shouldEnrich) return;

                const mount = this.findMetaInfoContainer();
                const identity = this.resolveDetailIdentity(route, mount);
                if (!mount || !identity.metaId) return;

                if (!this.isPaintedInMount(mount, identity.metaId)) {
                    this.reconcile();
                } else if (identity.imdbId) {
                    this.pinImdbRating(identity.imdbId, route.type);
                }
            }, 8000);
        }

        setupRouteListener() {
            // Custom bus already covers hashchange ÔÇö do not also bind hashchange (double remount).
            /**
             * Smart remount: clean on player; remount detail only when key/mount needs it.
             * @param {CustomEvent} [event]
             */
            this._boundOnRouteChange = (event) => {
                const next = event?.detail?.next ?? window.location.hash ?? '';
                const route = this.parseDetailRoute(next);

                if (!this.isEpisodeDetailSurface(route)) {
                    if (this.isSeriesOverviewSurface()) {
                        this._pendingEpisodeRef = null;
                        this._episodeRetryCount = 0;
                        this.dropStaleEpisodePaint();
                    }
                }

                // Entering player ÔÇö drop enrichment paint, do not forceRemount (avoids ghost panels).
                if (/#\/player(?:\/|$|\?|#)/.test(next)) {
                    this.clearRemountTimers();
                    if (this._forceRemountDebounce) {
                        clearTimeout(this._forceRemountDebounce);
                        this._forceRemountDebounce = null;
                    }
                    this.cleanup(true);
                    this._mountEl = null;
                    return;
                }

                if (route.surface !== 'detail' || !route.shouldEnrich) {
                    this.clearRemountTimers();
                    if (this._forceRemountDebounce) {
                        clearTimeout(this._forceRemountDebounce);
                        this._forceRemountDebounce = null;
                    }
                    this.cleanup(true);
                    this._mountEl = null;
                    this._activeDetailKey = null;
                    return;
                }

                const key = this.detailKey(route);
                const mount = this.findMetaInfoContainer();
                const identity = this.resolveDetailIdentity(route, mount);

                if (
                    key &&
                    key === this._activeDetailKey &&
                    mount &&
                    identity.metaId &&
                    this.isPaintedInMount(mount, identity.metaId)
                ) {
                    this._mountEl = mount;
                    if (identity.imdbId) this.pinImdbRating(identity.imdbId, route.type);
                    return;
                }

                this.forceRemount();
            };

            /**
             * Streams sidebar back ÔÇö only remount if route/mount actually needs it.
             * Route-change usually handles hash updates; this covers delayed DOM swap.
             * @param {MouseEvent} event
             */
            this._boundOnStreamsBack = (event) => {
                const target = event.target;
                if (!(target instanceof Element)) return;
                const back = target.closest('[class*="back-button"]');
                if (!back) return;
                if (
                    !back.closest('[class*="streams-list"]') &&
                    !back.closest('[class*="meta-streams"]')
                ) {
                    return;
                }

                window.setTimeout(() => {
                    const route = this.parseDetailRoute();
                    if (route.surface !== 'detail') return;
                    if (!this.isEpisodeDetailSurface(route)) {
                        if (this.isSeriesOverviewSurface()) {
                            this._pendingEpisodeRef = null;
                            this.dropStaleEpisodePaint();
                        }
                    }
                    this.forceRemount();
                }, 120);
            };

            document.addEventListener('stremio-custom-route-change', this._boundOnRouteChange);
            document.addEventListener('click', this._boundOnStreamsBack, true);
            if (!this._boundOnEpisodeClick) {
                this._boundOnEpisodeClick = (event) => this.rememberClickedEpisode(event);
                document.addEventListener('click', this._boundOnEpisodeClick, true);
            }
        }

        setupObserver() {
            if (this.observer) {
                this.observer.disconnect();
            }
            this.observer = new MutationObserver((mutations) => {
                const route = this.parseDetailRoute();
                if (route.surface !== 'detail') return;

                const isEnrichmentRoot = (node) => {
                    if (!node || node.nodeType !== 1) return false;
                    return Boolean(
                        node.classList?.contains('data-enrichment-container') ||
                            node.querySelector?.('.data-enrichment-container')
                    );
                };

                const isEnrichmentNode = (node) => {
                    if (!node || node.nodeType !== 1) return false;
                    return Boolean(
                        node.classList?.contains('data-enrichment-container') ||
                            node.closest?.('.data-enrichment-container')
                    );
                };

                let relevant = false;
                let enrichmentEvicted = false;
                let imdbRatingTouched = false;
                let streamsAppeared = false;

                const isStreamsNode = (node) => {
                    if (!node || node.nodeType !== 1) return false;
                    return Boolean(
                        node.matches?.('[class*="streams-list"]') ||
                            node.querySelector?.('[class*="streams-list"]')
                    );
                };

                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (isStreamsNode(node)) streamsAppeared = true;
                    }
                }

                const touchesImdbRating = (mutation) => {
                    const inImdb = (node) => {
                        if (!node) return false;
                        if (node.nodeType === Node.TEXT_NODE) {
                            return Boolean(
                                node.parentElement?.closest?.('[class*="imdb-button-container"]')
                            );
                        }
                        if (node.nodeType !== Node.ELEMENT_NODE) return false;
                        return Boolean(
                            node.closest?.('[class*="imdb-button-container"]') ||
                                node.querySelector?.('[class*="imdb-button-container"]')
                        );
                    };
                    if (inImdb(mutation.target)) return true;
                    for (const node of mutation.addedNodes) {
                        if (inImdb(node)) return true;
                    }
                    for (const node of mutation.removedNodes) {
                        if (inImdb(node)) return true;
                    }
                    return false;
                };

                const isRatingsBarNode = (node) => {
                    if (!node) return false;
                    if (node.nodeType === Node.TEXT_NODE) {
                        return Boolean(node.parentElement?.closest?.('.mystremio-ratings-bar'));
                    }
                    if (node.nodeType !== 1) return false;
                    return Boolean(
                        node.classList?.contains('mystremio-ratings-bar') ||
                            node.closest?.('.mystremio-ratings-bar') ||
                            node.querySelector?.('.mystremio-ratings-bar')
                    );
                };

                const isRatingsBarMutation = (mutation) => {
                    if (isRatingsBarNode(mutation.target)) return true;
                    const elements = [...mutation.addedNodes, ...mutation.removedNodes].filter(
                        (node) => node.nodeType === 1
                    );
                    if (!elements.length) return false;
                    return elements.every(isRatingsBarNode);
                };

                for (const mutation of mutations) {
                    if (isRatingsBarMutation(mutation)) continue;
                    if (touchesImdbRating(mutation)) {
                        imdbRatingTouched = true;
                    }
                    for (const node of mutation.removedNodes) {
                        if (isEnrichmentRoot(node)) {
                            enrichmentEvicted = true;
                            relevant = true;
                            break;
                        }
                    }
                    if (enrichmentEvicted) break;

                    if (isEnrichmentNode(mutation.target)) continue;
                    for (const node of mutation.addedNodes) {
                        if (isStreamsNode(node)) streamsAppeared = true;
                        if (!isEnrichmentNode(node)) {
                            relevant = true;
                            break;
                        }
                    }
                    if (relevant) break;
                    for (const node of mutation.removedNodes) {
                        if (!isEnrichmentNode(node)) {
                            relevant = true;
                            break;
                        }
                    }
                    if (relevant) break;
                    if (
                        mutation.type === 'childList' &&
                        mutation.addedNodes.length === 0 &&
                        mutation.removedNodes.length === 0
                    ) {
                        continue;
                    }
                    if (!isEnrichmentNode(mutation.target)) {
                        relevant = true;
                        break;
                    }
                }

                if (imdbRatingTouched) {
                    const identity = this.resolveDetailIdentity(route, this.findMetaInfoContainer());
                    const imdbId = identity.imdbId || this.imdbFromTmdbData(
                        this.cache.get(this.identityCacheKey(identity)) ||
                            (identity.imdbId && this.cache.get(identity.imdbId)) ||
                            this.cache.get(`meta:${identity.metaId}`)
                    );
                    const normId = this.normalizeImdbId(imdbId);
                    const token = normId ? `${normId}:s0e0` : '';
                    const host = document.querySelector('.mystremio-ratings-bar[data-msb-host="detail"]');
                    const barReady =
                        Boolean(token) &&
                        host?.isConnected &&
                        host.dataset.msbRendered === token;
                    if (!barReady && imdbId) this.pinImdbRating(imdbId, route.type);
                }

                if (streamsAppeared) {
                    const identity = this.resolveDetailIdentity(route, this.findMetaInfoContainer());
                    if (identity.imdbId) this.pinImdbRating(identity.imdbId, route.type);
                }

                if (!relevant) return;

                if (enrichmentEvicted || this.enrichedImdbId) {
                    const container = document.querySelector('.data-enrichment-container');
                    if (!container || !container.isConnected) {
                        this.enrichedImdbId = null;
                        this._mountEl = null;
                        this.restoreNativeMetaSections();
                    }
                }

                // Eviction: reconcile immediately (no debounce) so cache re-paint wins the race.
                if (enrichmentEvicted) {
                    this.reconcile();
                } else {
                    if (this.checkDebounceTimer) {
                        clearTimeout(this.checkDebounceTimer);
                    }
                    this.checkDebounceTimer = setTimeout(() => {
                        this.reconcile();
                    }, 120);
                }

                if (this.posterDebounceTimer) {
                    clearTimeout(this.posterDebounceTimer);
                }
                this.posterDebounceTimer = setTimeout(() => {
                    this.checkForPosters();
                }, 400);
            });

            // Prefer meta roots when present (avoids Discover catalog churn); else body
            const metaRoots = document.querySelectorAll(
                '[class*="meta-details"], [class*="meta-preview"]'
            );
            if (metaRoots.length > 0) {
                metaRoots.forEach((root) => {
                    this.observer.observe(root, {
                        childList: true,
                        subtree: true,
                        characterData: true,
                    });
                });
            }
            // Always watch body lightly for mount appearance after navigation
            this.observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
            });
            if (this._backgroundSuspended) this.observer.disconnect();
        }

        suspendBackground() {
            this._backgroundSuspended = true;
            this.observer?.disconnect();
            if (this._backupTimer) {
                clearInterval(this._backupTimer);
                this._backupTimer = null;
            }
        }

        resumeBackground() {
            this._backgroundSuspended = false;
            this.setupObserver();
            this.setupReconcileBackup();
        }

        cleanup(force = false) {
            if (!force) return;
            const container = document.querySelector('.data-enrichment-container');
            if (container) container.remove();
            const badge = document.querySelector('.enhanced-tmdb-badge');
            if (badge) badge.remove();
            this.restoreNativeMetaSections();
            this.enrichedImdbId = null;
            this._activeMetaId = null;
            this._mountEl = null;
        }

        /**
         * Labels for native meta-link blocks that Enrichment replaces.
         * @param {string} label
         * @returns {boolean}
         */
        isReplacedNativeMetaLabel(label) {
            const text = String(label || '').trim().toLowerCase();
            if (!text) return false;
            return (
                /^(genres?|cast|actors?|directors?|director|creators?|created by|regie|regisseur|darsteller|franchise|sequel|prequel|related)$/i.test(
                    text
                ) ||
                /^(genre|cast|director|creator|regie|franchise|sequel|prequel|related)/i.test(text)
            );
        }

        ensureDeHideStyles() {
            const id = 'mystremio-de-hide-native';
            if (document.getElementById(id)) return;
            const style = document.createElement('style');
            style.id = id;
            style.textContent = `
                [class*="meta-details"].mystremio-de-active [class*="meta-links-container"]:not([class*="enhanced-"]),
                [class*="meta-preview"].mystremio-de-active [class*="meta-links-container"]:not([class*="enhanced-"]) {
                    display: none !important;
                }
            `;
            document.documentElement.appendChild(style);
        }

        markDeActive(mount, active) {
            const root = this.detailsRoot(mount);
            if (!root) return;
            root.classList.toggle('mystremio-de-active', Boolean(active));
        }

        collectNativeFranchiseLinks(mount) {
            const root = this.detailsRoot(mount);
            if (!root) return [];
            const links = [];
            const seen = new Set();
            root.querySelectorAll('[class*="meta-links-container"]').forEach((section) => {
                if (section.closest('.data-enrichment-container')) return;
                const label = String(
                    section.querySelector('[class*="label-container"]')?.textContent || ''
                ).trim();
                if (!/franchise|sequel|prequel|related/i.test(label)) return;
                section.querySelectorAll('a').forEach((anchor) => {
                    const name = String(anchor.textContent || '').replace(/\s+/g, ' ').trim();
                    const href = String(anchor.getAttribute('href') || '').trim();
                    if (!name || seen.has(name.toLowerCase())) return;
                    seen.add(name.toLowerCase());
                    links.push({ name, href });
                });
            });
            return links;
        }

        /**
         * Hides native Genres / Cast / Directors within the detail meta tree.
         * @param {Element|null} [mount]
         */
        hideNativeMetaSections(mount = null) {
            const painted =
                (mount && mount.querySelector?.('.data-enrichment-container')) ||
                document.querySelector('.data-enrichment-container');
            if (
                !painted?.querySelector?.(
                    '.enhanced-franchise-section, .enhanced-genres-section, .enhanced-directors-section, .enhanced-cast-section, .enhanced-similar-section, .enhanced-collection-section'
                )
            ) {
                return;
            }
            this.ensureDeHideStyles();
            this.markDeActive(mount, true);
            const detailsRoot =
                mount?.closest('[class*="meta-details"], [class*="meta-preview"]') || null;
            const sections = document.querySelectorAll(
                '[class*="meta-links-container"]'
            );
            sections.forEach((section) => {
                if (section.closest('.data-enrichment-container')) return;
                if (String(section.className || '').includes('enhanced-')) return;
                if (detailsRoot && !detailsRoot.contains(section)) return;

                const labelEl = section.querySelector('[class*="label-container"]');
                const label = labelEl?.textContent || '';
                if (!this.isReplacedNativeMetaLabel(label)) return;

                section.style.display = 'none';
                section.dataset.mystremioEnrichedHidden = '1';
            });

            const nativeGenres = (detailsRoot || document).querySelectorAll('[class*="genres-container"]');
            nativeGenres.forEach((section) => {
                if (section.closest('.data-enrichment-container')) return;
                if (String(section.className || '').includes('enhanced-')) return;
                if (detailsRoot && !detailsRoot.contains(section)) return;
                section.style.display = 'none';
                section.dataset.mystremioEnrichedHidden = '1';
            });
        }

        /**
         * Restores native meta sections hidden by {@link hideNativeMetaSections}.
         */
        restoreNativeMetaSections() {
            this.markDeActive(null, false);
            document.querySelectorAll('.mystremio-de-active').forEach((root) => {
                root.classList.remove('mystremio-de-active');
            });
            document
                .querySelectorAll('[data-mystremio-enriched-hidden="1"]')
                .forEach((section) => {
                    section.style.display = '';
                    delete section.dataset.mystremioEnrichedHidden;
                });
        }

        extractImdbId(mount = null) {
            const route = this.parseDetailRoute();
            return this.resolveDetailIdentity(route, mount || this.findMetaInfoContainer()).imdbId;
        }

        /**
         * Finds the MetaPreview IMDb score label next to the IMDb icon.
         * @returns {Element|null}
         */
        findImdbRatingLabel() {
            const buttons = document.querySelectorAll('[class*="imdb-button-container"]');
            for (const btn of buttons) {
                if (
                    btn.closest(
                        '[class*="player-container"], [class*="control-bar-layer"], [class*="meta-preview-placeholder-container"]'
                    )
                ) {
                    continue;
                }
                const label = btn.querySelector('[class*="label"]');
                if (label?.isConnected) return label;
            }
            return null;
        }

        /**
         * Normalizes a rating string for comparison (e.g. "7.90" ÔåÆ "7.9").
         * @param {string|number|null|undefined} raw
         * @returns {string|null}
         */
        normalizeRatingLabel(raw) {
            const text = String(raw ?? '').trim();
            if (!text) return null;
            const num = Number.parseFloat(text.replace(',', '.'));
            if (!Number.isFinite(num)) return text;
            // Keep one decimal when present (IMDb style); strip trailing zeros via parseFloat.
            return String(num);
        }

        /**
         * Fetches Cinemeta imdbRating for a title (not TMDB vote_average).
         * @param {string} imdbId
         * @param {string|null} [typeHint]
         * @returns {Promise<string|null>}
         */
        async fetchCinemetaRating(imdbId, typeHint = null) {
            const id = this.normalizeImdbId(imdbId);
            if (!id) return null;
            if (this.cinemetaRatingCache.has(id)) {
                return this.cinemetaRatingCache.get(id);
            }
            if (this.cinemetaRatingPending.has(id)) {
                return this.cinemetaRatingPending.get(id);
            }

            const types = [];
            const hint = String(typeHint || '').toLowerCase();
            if (hint === 'series' || hint === 'tv') types.push('series');
            else if (hint === 'movie') types.push('movie');
            else {
                types.push('movie', 'series');
            }
            if (!types.includes('movie')) types.push('movie');
            if (!types.includes('series')) types.push('series');

            const pending = (async () => {
                for (const type of types) {
                    try {
                        const url = `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`;
                        const res = await fetch(url);
                        if (!res.ok) continue;
                        const json = await res.json();
                        const rating = this.normalizeRatingLabel(
                            json?.meta?.imdbRating ?? json?.imdbRating
                        );
                        if (rating) {
                            this.cinemetaRatingCache.set(id, rating);
                            return rating;
                        }
                    } catch (_) {
                        /* try next type */
                    }
                }
                return null;
            })().finally(() => {
                this.cinemetaRatingPending.delete(id);
            });

            this.cinemetaRatingPending.set(id, pending);
            return pending;
        }

        /**
         * Episode chips next to series scores, only on the episode/streams page.
         * Series overview never keeps leftover chips from the previously open episode.
         * @param {string} id
         * @param {string} type
         * @param {{ videoId?: string|null, metaId?: string|null }} route
         * @param {object} bar
         * @returns {Promise<void>}
         */
        async mountEpisodeRatingsBar(id, type, route, bar) {
            if (!this.config.showEpisodeRatings) {
                this.dropStaleEpisodePaint(bar);
                return;
            }
            if (!this.isEpisodeDetailSurface(route)) {
                if (this.isSeriesOverviewSurface()) this.dropStaleEpisodePaint(bar);
                return;
            }
            const paintGen = this._episodePaintGen;
            const episodeRef = await this.resolveEpisodeRef(route);
            if (paintGen !== this._episodePaintGen) return;
            if (!this.isEpisodeDetailSurface(this.parseDetailRoute())) {
                if (this.isSeriesOverviewSurface()) this.dropStaleEpisodePaint(bar);
                return;
            }
            if (!episodeRef.season && !episodeRef.episode) {
                if (this._episodeRetryCount >= 12) {
                    bar.removeEpisodeHost?.();
                    return;
                }
                this._episodeRetryCount += 1;
                if (this._episodeRetryTimer) clearTimeout(this._episodeRetryTimer);
                this._episodeRetryTimer = setTimeout(() => {
                    this._episodeRetryTimer = null;
                    if (!this.isEpisodeDetailSurface(this.parseDetailRoute())) return;
                    this.mountEpisodeRatingsBar(id, type, this.parseDetailRoute(), bar);
                }, 200);
                return;
            }
            this._episodeRetryCount = 0;
            const layout = String(episodeRef.episodeLayout || '').toLowerCase();
            const layoutKey =
                layout === 'tmdb' || layout === 'cinemeta' || layout === 'absolute'
                    ? `:${layout}`
                    : episodeRef.exactCinemeta === false
                      ? ':abs'
                      : episodeRef.exactCinemeta === true
                        ? ':exact'
                        : ':auto';
            const epToken = `${id}:s${episodeRef.season || 0}e${episodeRef.episode || 0}${layoutKey}`;
            const epHost = document.querySelector(
                '.mystremio-ratings-bar[data-msb-host="episode"]'
            );
            if (
                epHost?.isConnected &&
                epHost.dataset.msbRendered === epToken &&
                epHost.querySelector('.msb-item')
            ) {
                return Promise.resolve();
            }
            if (!bar.mountEpisodeRatings) {
                bar.removeEpisodeHost?.();
                return Promise.resolve();
            }
            if (paintGen !== this._episodePaintGen) return;
            if (!this.isEpisodeDetailSurface(this.parseDetailRoute())) {
                this.dropStaleEpisodePaint(bar);
                return;
            }
            return Promise.resolve(bar.mountEpisodeRatings(id, type, episodeRef));
        }

        /**
         * Mounts multi-ratings bar (preferred) or pins Cinemeta IMDb text (GitHub fallback).
         * When the bar path is active, never write IMDb label text (avoids observer loops).
         * @param {string} imdbId
         * @param {string|null} [typeHint]
         * @returns {Promise<void>}
         */
        async pinImdbRating(imdbId, typeHint = null) {
            const id = this.normalizeImdbId(imdbId);
            if (!id) return;

            const route = this.parseDetailRoute();
            // Title bar is always series/movie scores (old DE chip bar).
            const token = `${id}:s0e0`;

            const bar = window.__mystremioRatingsBar;
            if (bar?.mountOnDetail) {
                const host = document.querySelector('.mystremio-ratings-bar[data-msb-host="detail"]');
                const live =
                    typeof bar.isLiveDetailHost === 'function'
                        ? bar.isLiveDetailHost(host)
                        : Boolean(
                              host?.isConnected &&
                                  host.previousElementSibling?.matches?.(
                                      '[class*="imdb-button-container"]'
                                  )
                          );
                const seriesDone = live && host.dataset.msbRendered === token;
                if (!this._pinInFlight) this._pinInFlight = new Map();

                const routeType = String(typeHint || route.type || '').toLowerCase();
                const isSeriesFamily =
                    routeType === 'series' ||
                    routeType === 'tv' ||
                    routeType === 'anime' ||
                    routeType === 'show';
                const type = isSeriesFamily
                    ? 'series'
                    : routeType === 'movie'
                      ? 'movie'
                      : typeHint || route.type || 'movie';

                const liveRoute = this.parseDetailRoute();
                const mountEpisode = () =>
                    this.mountEpisodeRatingsBar(id, type, this.parseDetailRoute(), bar);
                const epKey = `ep:${this.detailKey(this.parseDetailRoute()) || token}`;

                if (!seriesDone && !this._pinInFlight.has(token)) {
                    if (typeof bar.fetchRatings === 'function') {
                        bar.fetchRatings(id, type, null);
                    }
                    const seriesJob = Promise.resolve(bar.mountOnDetail(id, type))
                        .catch(() => {})
                        .finally(() => {
                            this._pinInFlight?.delete(token);
                        });
                    this._pinInFlight.set(token, seriesJob);
                }

                if (!this.isEpisodeDetailSurface(liveRoute)) {
                    if (this.isSeriesOverviewSurface()) {
                        this._pendingEpisodeRef = null;
                        this.dropStaleEpisodePaint(bar);
                    }
                    return this._pinInFlight.get(token);
                }

                if (this._pinInFlight.has(epKey)) {
                    return this._pinInFlight.get(epKey);
                }
                const epJob = Promise.resolve(mountEpisode())
                    .catch(() => {})
                    .finally(() => {
                        this._pinInFlight?.delete(epKey);
                    });
                this._pinInFlight.set(epKey, epJob);
                return epJob;
            }

            const sessionId = this.sessionId;
            const type = typeHint || route.type;

            const rating = await this.fetchCinemetaRating(id, type);
            if (sessionId !== this.sessionId || !rating) return;

            const currentId = this.resolveDetailIdentity(route, this.findMetaInfoContainer()).imdbId;
            if (this.normalizeImdbId(currentId) !== id) return;

            const label = this.findImdbRatingLabel();
            if (!label) return;

            const current = this.normalizeRatingLabel(label.textContent);
            if (current === rating) return;

            label.textContent = rating;
            const link = label.closest('[class*="imdb-button-container"]');
            if (link && link.getAttribute('title')) {
                link.setAttribute('title', rating);
            }
        }

        async fetchTMDBData(imdbId) {
            if (this.cache.has(imdbId)) {
                return this.cache.get(imdbId);
            }

            const apiKey = this.config.tmdbApiKey;
            if (!apiKey) return null;
            
            try {
                const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id`;
                const findResponse = await fetch(findUrl);
                
                if (!findResponse.ok) return null;
                
                const findData = await findResponse.json();

                let tmdbId, mediaType;
                if (findData.movie_results && findData.movie_results.length > 0) {
                    tmdbId = findData.movie_results[0].id;
                    mediaType = 'movie';
                } else if (findData.tv_results && findData.tv_results.length > 0) {
                    tmdbId = findData.tv_results[0].id;
                    mediaType = 'tv';
                } else {
                    return null;
                }

                const data = await this.fetchTMDBDataByTmdbId(tmdbId, mediaType);
                if (data) this.cache.set(imdbId, data);
                return data;
            } catch (error) {
                console.error('[DataEnrichment] Fetch error:', error);
                return null;
            }
        }

        /**
         * @param {number} tmdbId
         * @param {'tv'|'movie'} mediaType
         * @returns {Promise<object|null>}
         */
        async fetchTMDBDataByTmdbId(tmdbId, mediaType) {
            const id = Number(tmdbId);
            if (!Number.isFinite(id) || id <= 0) return null;
            const cacheKey = `tmdb:${id}`;
            if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

            const apiKey = this.config.tmdbApiKey;
            if (!apiKey) return null;

            const type = mediaType === 'movie' ? 'movie' : 'tv';
            const append =
                type === 'tv'
                    ? 'credits,aggregate_credits,similar,recommendations,external_ids,content_ratings,release_dates,images'
                    : 'credits,similar,recommendations,external_ids,content_ratings,release_dates,images';
            try {
                const detailUrl = `https://api.themoviedb.org/3/${type}/${id}?api_key=${apiKey}&append_to_response=${append}&include_image_language=en,null`;
                const detailResponse = await fetch(detailUrl);
                if (!detailResponse.ok) return null;
                const data = await detailResponse.json();
                data.media_type = type;
                this.cache.set(cacheKey, data);
                const imdb = this.normalizeImdbId(data.external_ids?.imdb_id);
                if (imdb) this.cache.set(imdb, data);
                return data;
            } catch (error) {
                console.error('[DataEnrichment] TMDB id fetch error:', error);
                return null;
            }
        }

        /**
         * Title search scoped to the open details page — never CW posters.
         * @param {string} title
         * @param {string|null} [typeHint]
         * @returns {Promise<object|null>}
         */
        async searchTmdbByTitle(title, typeHint = null) {
            const query = String(title || '').trim();
            if (!query) return null;
            const apiKey = this.config.tmdbApiKey;
            if (!apiKey) return null;
            const mediaType = this.tmdbMediaType(typeHint);
            try {
                const url = `https://api.themoviedb.org/3/search/${mediaType}?api_key=${apiKey}&query=${encodeURIComponent(query)}`;
                const res = await fetch(url);
                if (!res.ok) return null;
                const json = await res.json();
                const hit = Array.isArray(json?.results) ? json.results[0] : null;
                if (!hit?.id) return null;
                return this.fetchTMDBDataByTmdbId(hit.id, mediaType);
            } catch (error) {
                console.error('[DataEnrichment] TMDB search error:', error);
                return null;
            }
        }

        /**
         * Picks the richest cast list for display (aggregate Series Cast for TV).
         * @param {object} data TMDB detail payload
         * @returns {{ cast: Array<object> }}
         */
        resolveCastCredits(data) {
            if (data?.media_type === 'tv' && Array.isArray(data.aggregate_credits?.cast) && data.aggregate_credits.cast.length) {
                const cast = data.aggregate_credits.cast
                    .map((actor) => ({
                        ...actor,
                        character:
                            actor.character ||
                            actor.roles?.[0]?.character ||
                            (Array.isArray(actor.roles)
                                ? actor.roles.map((role) => role.character).filter(Boolean).join(' / ')
                                : '') ||
                            '',
                        total_episode_count: Number(actor.total_episode_count || actor.roles?.[0]?.episode_count || 0),
                    }))
                    .sort((a, b) => b.total_episode_count - a.total_episode_count);
                return { cast };
            }
            return data?.credits || { cast: [] };
        }

        /**
         * Resolves directors / creators with profile photos from TMDB credits.
         * @param {object} data TMDB detail payload
         * @returns {Array<{ name: string, job: string, profile_path: string|null }>}
         */
        resolveDirectors(data) {
            /** @type {Map<string, { name: string, job: string, profile_path: string|null }>} */
            const byId = new Map();

            const addPerson = (person, job) => {
                if (!person?.name) return;
                const key = String(person.id || person.name);
                if (byId.has(key)) return;
                byId.set(key, {
                    name: person.name,
                    job: job || person.job || 'Director',
                    profile_path: person.profile_path || null,
                });
            };

            if (Array.isArray(data?.created_by)) {
                data.created_by.forEach((person) => addPerson(person, 'Creator'));
            }

            const crewLists = [
                data?.credits?.crew,
                data?.aggregate_credits?.crew,
            ];
            for (const crew of crewLists) {
                if (!Array.isArray(crew)) continue;
                crew
                    .filter((person) => {
                        const job = String(person.job || '').toLowerCase();
                        return job === 'director' || job === 'co-director';
                    })
                    .forEach((person) => addPerson(person, person.job || 'Director'));
            }

            return Array.from(byId.values());
        }

        /**
         * Injects native franchise / sequel links as DE chips.
         * @param {Array<{ name: string, href?: string }>} links
         * @param {HTMLElement} container
         */
        injectEnhancedFranchise(links, container) {
            const list = Array.isArray(links) ? links.filter((item) => item && item.name) : [];
            if (!list.length) return;

            const icon = `<svg class="enhanced-genre-icon" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>`;
            const section = document.createElement('div');
            section.className = 'enhanced-franchise-section enhanced-genres-section enhanced-carousel';
            section.innerHTML = `
                <div class="enhanced-section-header">Franchise</div>
                <div class="enhanced-carousel-wrapper">
                    <button type="button" class="enhanced-scroll-btn enhanced-scroll-left" aria-label="Scroll left"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 6 9 12 15 18"></polyline></svg></button>
                    <div class="enhanced-cast-container enhanced-scroll-container enhanced-genres-container">
                        ${list
                            .map(
                                (item) => `
                            <a class="enhanced-cast-item enhanced-genre-pill" href="${escapeHtml(item.href || '#')}" data-franchise-name="${escapeHtml(item.name)}">
                                <div class="enhanced-cast-image-container enhanced-genre-icon-circle">
                                    ${icon}
                                </div>
                                <div class="enhanced-cast-info">
                                    <div class="enhanced-cast-name">${escapeHtml(item.name)}</div>
                                </div>
                            </a>
                        `
                            )
                            .join('')}
                    </div>
                    <button type="button" class="enhanced-scroll-btn enhanced-scroll-right" aria-label="Scroll right"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg></button>
                </div>
            `;
            container.appendChild(section);
            this.setupScrollButtons(section);
        }

        /**
         * Injects TMDB genres as glass chips (TMDB has no genre images).
         * @param {Array<{ id?: number, name?: string }>|undefined} genres
         * @param {HTMLElement} container
         */
        injectEnhancedGenres(genres, container) {
            const list = (Array.isArray(genres) ? genres : [])
                .map((g) => {
                    if (!g || !g.name) return null;
                    const name = String(g.name).trim();
                    if (!name) return null;
                    return { name, id: g.id };
                })
                .filter(Boolean);
            if (!list.length) return;

            const section = document.createElement('div');
            section.className = 'enhanced-genres-section enhanced-carousel';
            section.innerHTML = `
                <div class="enhanced-section-header">Genres</div>
                <div class="enhanced-carousel-wrapper">
                    <button type="button" class="enhanced-scroll-btn enhanced-scroll-left" aria-label="Scroll left"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 6 9 12 15 18"></polyline></svg></button>
                    <div class="enhanced-cast-container enhanced-scroll-container enhanced-genres-container">
                        ${list
                            .map(
                                (g) => `
                            <div class="enhanced-cast-item enhanced-genre-pill" data-genre-name="${escapeHtml(g.name)}" role="button" tabindex="0">
                                <div class="enhanced-cast-image-container enhanced-genre-icon-circle">
                                    ${getGenreIconSvg(g.name, g.id)}
                                </div>
                                <div class="enhanced-cast-info">
                                    <div class="enhanced-cast-name">${escapeHtml(g.name)}</div>
                                </div>
                            </div>
                        `
                            )
                            .join('')}
                    </div>
                    <button type="button" class="enhanced-scroll-btn enhanced-scroll-right" aria-label="Scroll right"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg></button>
                </div>
            `;
            container.appendChild(section);
            this.setupScrollButtons(section);

            section.querySelectorAll('.enhanced-genre-pill').forEach((pill) => {
                const go = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const name = pill.dataset.genreName;
                    if (!name) return;
                    // Official Stremio: genre → Discover with genre filter (not Search).
                    window.location.hash = this.buildDiscoverGenreHash(name);
                };
                pill.addEventListener('click', go);
                pill.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') go(e);
                });
            });
        }

        /**
         * Discover deep-link for a genre (Cinemeta top catalog), matching stock Stremio.
         * @param {string} genreName
         * @returns {string} location.hash value including leading #
         */
        buildDiscoverGenreHash(genreName) {
            const CINEMETA_MANIFEST = 'https://v3-cinemeta.strem.io/manifest.json';
            const route = this.parseDetailRoute();
            const type =
                route.type === 'series' || route.type === 'movie' ? route.type : 'movie';
            const catalogPath = [
                encodeURIComponent(CINEMETA_MANIFEST),
                encodeURIComponent(type),
                'top',
            ].join('/');
            return `#/discover/${catalogPath}?genre=${encodeURIComponent(genreName)}`;
        }

        /**
         * Injects directors/creators carousel with headshots (same layout as cast).
         * @param {Array<{ name: string, job: string, profile_path: string|null }>} directors
         * @param {HTMLElement} container
         */
        injectEnhancedDirectors(directors, container) {
            const list = Array.isArray(directors) ? directors.slice(0, 12) : [];
            if (!list.length) return;

            const section = document.createElement('div');
            section.className = 'enhanced-directors-section enhanced-carousel';
            section.innerHTML = `
                <div class="enhanced-section-header">Directors</div>
                <div class="enhanced-carousel-wrapper">
                    <button type="button" class="enhanced-scroll-btn enhanced-scroll-left" aria-label="Scroll left"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 6 9 12 15 18"></polyline></svg></button>
                    <div class="enhanced-cast-container enhanced-scroll-container">
                        ${list
                            .map(
                                (person) => `
                            <div class="enhanced-cast-item" data-actor-name="${escapeHtml(person.name)}">
                                <div class="enhanced-cast-image-container">
                                    ${
                                        person.profile_path
                                            ? `<img class="enhanced-cast-image" src="https://image.tmdb.org/t/p/w185${person.profile_path}" alt="${escapeHtml(person.name)}" loading="lazy">`
                                            : `<div class="enhanced-cast-placeholder"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></div>`
                                    }
                                </div>
                                <div class="enhanced-cast-info">
                                    <div class="enhanced-cast-name">${escapeHtml(person.name)}</div>
                                    <div class="enhanced-cast-character">${escapeHtml(person.job || 'Director')}</div>
                                </div>
                            </div>
                        `
                            )
                            .join('')}
                    </div>
                    <button type="button" class="enhanced-scroll-btn enhanced-scroll-right" aria-label="Scroll right"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg></button>
                </div>
            `;

            container.appendChild(section);
            this.setupScrollButtons(section);
            this.setupCastClickHandlers(section);
        }

        injectEnhancedCast(credits, container) {
            const cast = credits.cast?.slice(0, 20) || [];
            if (cast.length === 0) return;

            const section = document.createElement('div');
            section.className = 'enhanced-cast-section enhanced-carousel';
            section.innerHTML = `
                <div class="enhanced-section-header">Cast</div>
                <div class="enhanced-carousel-wrapper">
                    <button type="button" class="enhanced-scroll-btn enhanced-scroll-left" aria-label="Scroll left"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 6 9 12 15 18"></polyline></svg></button>
                    <div class="enhanced-cast-container enhanced-scroll-container">
                        ${cast.map(actor => `
                            <div class="enhanced-cast-item" data-actor-name="${escapeHtml(actor.name)}">
                                <div class="enhanced-cast-image-container">
                                    ${actor.profile_path 
                                        ? `<img class="enhanced-cast-image" src="https://image.tmdb.org/t/p/w185${actor.profile_path}" alt="${escapeHtml(actor.name)}" loading="lazy">`
                                        : `<div class="enhanced-cast-placeholder"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></div>`
                                    }
                                </div>
                                <div class="enhanced-cast-info">
                                    <div class="enhanced-cast-name">${escapeHtml(actor.name)}</div>
                                    <div class="enhanced-cast-character">${escapeHtml(actor.character || '')}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                    <button type="button" class="enhanced-scroll-btn enhanced-scroll-right" aria-label="Scroll right"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg></button>
                </div>
            `;
            
            container.appendChild(section);
            this.setupScrollButtons(section);
            this.setupCastClickHandlers(section);
        }

        injectSimilarTitles(similar, container) {
            const titles = similar.results?.slice(0, 15) || [];
            if (titles.length === 0) return;

            const mediaType = similar.results[0]?.media_type || (similar.results[0]?.first_air_date ? 'tv' : 'movie');

            const section = document.createElement('div');
            section.className = 'enhanced-similar-section enhanced-carousel';
            section.innerHTML = `
                <div class="enhanced-section-header">More like this</div>
                <div class="enhanced-carousel-wrapper">
                    <button type="button" class="enhanced-scroll-btn enhanced-scroll-left" aria-label="Scroll left"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 6 9 12 15 18"></polyline></svg></button>
                    <div class="enhanced-similar-container enhanced-scroll-container">
                        ${titles.map(item => `
                            <div class="enhanced-similar-item enhanced-poster-item" data-id="${item.id}" data-media-type="${item.media_type || mediaType}">
                                ${item.poster_path 
                                    ? `<img class="enhanced-similar-poster" src="https://image.tmdb.org/t/p/w342${item.poster_path}" alt="${item.title || item.name}" loading="lazy">`
                                    : `<div class="enhanced-similar-placeholder">${item.title || item.name}</div>`
                                }
                                <div class="enhanced-poster-title">${item.title || item.name}</div>
                            </div>
                        `).join('')}
                    </div>
                    <button type="button" class="enhanced-scroll-btn enhanced-scroll-right" aria-label="Scroll right"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg></button>
                </div>
            `;
            
            container.appendChild(section);
            this.setupScrollButtons(section);
            this.setupPosterClickHandlers(section);
        }

        async injectCollection(collection, container) {
            const collectionUrl = `https://api.themoviedb.org/3/collection/${collection.id}?api_key=${this.config.tmdbApiKey}`;
            const response = await fetch(collectionUrl);
            const collectionData = await response.json();

            const parts = collectionData.parts || [];
            if (parts.length <= 1) return;

            parts.sort((a, b) => new Date(a.release_date) - new Date(b.release_date));

            const section = document.createElement('div');
            section.className = 'enhanced-collection-section enhanced-carousel';
            section.innerHTML = `
                <div class="enhanced-section-header">${collectionData.name}</div>
                <div class="enhanced-carousel-wrapper">
                    <button type="button" class="enhanced-scroll-btn enhanced-scroll-left" aria-label="Scroll left"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 6 9 12 15 18"></polyline></svg></button>
                    <div class="enhanced-collection-container enhanced-scroll-container">
                        ${parts.map(item => `
                            <div class="enhanced-collection-item enhanced-poster-item" data-id="${item.id}" data-media-type="movie">
                                ${item.poster_path 
                                    ? `<img class="enhanced-collection-poster" src="https://image.tmdb.org/t/p/w342${item.poster_path}" alt="${item.title}" loading="lazy">`
                                    : `<div class="enhanced-collection-placeholder">${item.title}</div>`
                                }
                                <div class="enhanced-poster-title">${item.title}</div>
                            </div>
                        `).join('')}
                    </div>
                    <button type="button" class="enhanced-scroll-btn enhanced-scroll-right" aria-label="Scroll right"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg></button>
                </div>
            `;
            
            container.appendChild(section);
            this.setupScrollButtons(section);
            this.setupPosterClickHandlers(section);
        }

        setupScrollButtons(section) {
            const container = section.querySelector('.enhanced-scroll-container');
            const leftBtn = section.querySelector('.enhanced-scroll-left');
            const rightBtn = section.querySelector('.enhanced-scroll-right');
            
            if (!container || !leftBtn || !rightBtn) return;
            
            const scrollAmount = 400;
            
            const updateButtonVisibility = () => {
                leftBtn.style.opacity = container.scrollLeft > 10 ? '1' : '0';
                leftBtn.style.pointerEvents = container.scrollLeft > 10 ? 'auto' : 'none';
                
                const maxScroll = container.scrollWidth - container.clientWidth - 10;
                rightBtn.style.opacity = container.scrollLeft < maxScroll ? '1' : '0';
                rightBtn.style.pointerEvents = container.scrollLeft < maxScroll ? 'auto' : 'none';
            };
            
            leftBtn.addEventListener('click', () => {
                container.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
            });
            
            rightBtn.addEventListener('click', () => {
                container.scrollBy({ left: scrollAmount, behavior: 'smooth' });
            });
            
            container.addEventListener('scroll', updateButtonVisibility);
            setTimeout(updateButtonVisibility, 100);
        }

        setupCastClickHandlers(section) {
            section.querySelectorAll('.enhanced-cast-item').forEach((item) => {
                item.style.cursor = 'pointer';
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const name = item.dataset.actorName;
                    if (!name) return;
                    window.location.hash = `#/search?search=${encodeURIComponent(name)}`;
                });
            });
        }

        setupPosterClickHandlers(section) {
            const posterItems = section.querySelectorAll('.enhanced-poster-item');
            
            posterItems.forEach(item => {
                item.style.cursor = 'pointer';
                
                item.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    const tmdbId = item.dataset.id;
                    const mediaType = item.dataset.mediaType || 'movie';
                    
                    if (!tmdbId) return;
                    
                    item.style.opacity = '0.6';
                    item.style.pointerEvents = 'none';
                    
                    try {
                        const externalIdsUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/external_ids?api_key=${this.config.tmdbApiKey}`;
                        const response = await fetch(externalIdsUrl);
                        
                        if (!response.ok) return;
                        
                        const externalIds = await response.json();
                        const imdbId = externalIds.imdb_id;
                        
                        if (!imdbId) return;
                        
                        const stremioType = mediaType === 'tv' ? 'series' : 'movie';
                        // Cinemeta-style deep link (metaId + videoId) so movies open StreamsList
                        window.location.hash = `#/detail/${stremioType}/${imdbId}/${imdbId}`;
                        
                    } catch (error) {
                        console.error('[DataEnrichment] Error navigating to item:', error);
                    } finally {
                        item.style.opacity = '';
                        item.style.pointerEvents = '';
                    }
                });
            });
        }

        /**
         * Href on a catalog/detail poster card.
         * @param {HTMLElement} poster
         * @returns {string}
         */
        posterHref(poster) {
            const link =
                poster.tagName === 'A'
                    ? poster
                    : poster.querySelector('a[href]');
            return String(link?.href || poster.getAttribute('href') || '');
        }

        /**
         * Resolve a stable media id for a poster/card (IMDb or TMDB).
         * @param {HTMLElement} poster
         * @returns {{ mediaId: string, idType: string }|null}
         */
        resolvePosterMediaId(poster) {
            if (poster.classList.contains('enhanced-poster-item')) {
                const rawId = String(poster.dataset.id || '').replace(/\D/g, '');
                if (!rawId) return null;
                return { mediaId: rawId, idType: 'tmdb' };
            }

            const href = this.posterHref(poster);
            if (!href) return null;

            const imdbMatch = href.match(/tt\d{7,8}/i);
            if (imdbMatch) {
                return { mediaId: imdbMatch[0].toLowerCase(), idType: 'imdb' };
            }

            const tmdbPrefixed = href.match(/tmdb[:/\-](\d+)/i);
            if (tmdbPrefixed) {
                return { mediaId: tmdbPrefixed[1], idType: 'tmdb' };
            }

            const detail = href.match(/#?\/detail\/(movie|series|tv)\/([^/?#]+)/i);
            if (detail) {
                let raw = detail[2];
                try {
                    raw = decodeURIComponent(raw);
                } catch (_) {}
                const imdbInRaw = raw.match(/tt\d{7,8}/i);
                if (imdbInRaw) {
                    return { mediaId: imdbInRaw[0].toLowerCase(), idType: 'imdb' };
                }
                const tmdbInRaw = raw.match(/tmdb[:/\-]?(\d+)/i);
                if (tmdbInRaw) {
                    return { mediaId: tmdbInRaw[1], idType: 'tmdb' };
                }
                if (/^\d+$/.test(raw)) {
                    return { mediaId: raw, idType: 'tmdb' };
                }
            }

            return null;
        }

        /**
         * @param {string} idType
         * @param {string} mediaId
         * @returns {string}
         */
        buildRpdbUrl(idType, mediaId) {
            const key = this.config.rpdbApiKey;
            return `https://api.ratingposterdb.com/${encodeURIComponent(key)}/${idType}/poster-default/${mediaId}.jpg?fallback=true`;
        }

        /**
         * Clear RPDB enrichment so a reused card can be rebound to a new title.
         * @param {HTMLElement} poster
         */
        resetRpdbPoster(poster) {
            const gen = String((Number(poster.dataset.rpdbGen) || 0) + 1);
            poster.dataset.rpdbGen = gen;
            delete poster.dataset.rpdbEnriched;
            delete poster.dataset.rpdbId;

            const imgElement = poster.querySelector('img');
            if (imgElement && imgElement.dataset.rpdbOriginalSrc) {
                imgElement.src = imgElement.dataset.rpdbOriginalSrc;
                imgElement.style.removeProperty('content');
                delete imgElement.dataset.rpdbOriginalSrc;
            }
            const bgContainer = poster.querySelector('.poster-image-container, .poster-image');
            if (bgContainer) {
                bgContainer.style.removeProperty('background-image');
            }
        }

        resetAllRpdbPosters() {
            document
                .querySelectorAll('[data-rpdb-id], [data-rpdb-enriched]')
                .forEach((el) => this.resetRpdbPoster(el));
        }

        /**
         * @param {HTMLElement} poster
         */
        enrichRpdbPoster(poster) {
            if (poster.closest?.('[class*="continue-watching"]')) return;
            const resolved = this.resolvePosterMediaId(poster);
            if (!resolved) return;

            const { mediaId, idType } = resolved;
            const imgElement = poster.querySelector('img');
            if (!imgElement) return;

            const storedId = poster.dataset.rpdbId || '';
            const rpdbUrl = this.buildRpdbUrl(idType, mediaId);
            const currentSrc = imgElement.getAttribute('src') || '';

            if (poster.dataset.rpdbEnriched === 'true' && storedId === mediaId) {
                if (currentSrc === rpdbUrl || currentSrc.includes('ratingposterdb.com')) {
                    return;
                }
            }

            if (storedId && storedId !== mediaId) {
                this.resetRpdbPoster(poster);
            }

            const gen = String((Number(poster.dataset.rpdbGen) || 0) + 1);
            poster.dataset.rpdbGen = gen;
            poster.dataset.rpdbId = mediaId;
            delete poster.dataset.rpdbEnriched;
            if (!imgElement.dataset.rpdbOriginalSrc && !currentSrc.includes('ratingposterdb.com')) {
                imgElement.dataset.rpdbOriginalSrc = imgElement.src;
            }

            const tempImg = new Image();
            tempImg.onload = () => {
                if (poster.dataset.rpdbGen !== gen || poster.dataset.rpdbId !== mediaId) return;
                imgElement.src = rpdbUrl;
                imgElement.removeAttribute('srcset');
                imgElement.style.setProperty('content', `url("${rpdbUrl}")`, 'important');
                imgElement.style.setProperty('object-fit', 'cover', 'important');
                const bgContainer = poster.querySelector('.poster-image-container, .poster-image');
                if (bgContainer) {
                    bgContainer.style.setProperty('background-image', `url("${rpdbUrl}")`, 'important');
                }
                poster.dataset.rpdbEnriched = 'true';
            };
            tempImg.onerror = () => {
                if (poster.dataset.rpdbGen !== gen) return;
                delete poster.dataset.rpdbEnriched;
                console.debug(`[RPDB] Failed to load poster for ${idType}:${mediaId}`);
            };
            tempImg.src = rpdbUrl;
        }

        checkForPosters() {
            if (!this.config.showRatingsOnPosters || !this.config.rpdbApiKey) {
                this.resetAllRpdbPosters();
                return;
            }

            const posters = document.querySelectorAll(
                '.meta-item-container-Tj0Ib, [class*="meta-item-container"], .poster-container, .enhanced-poster-item'
            );
            posters.forEach((poster) => {
                if (poster.closest?.('[class*="continue-watching"]')) return;
                this.enrichRpdbPoster(poster);
            });
        }

        destroy() {
            this.beginNewSession();
            this.clearRemountTimers();
            if (this._forceRemountDebounce) {
                clearTimeout(this._forceRemountDebounce);
                this._forceRemountDebounce = null;
            }
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }
            if (this.reconcileTimer) {
                clearTimeout(this.reconcileTimer);
                this.reconcileTimer = null;
            }
            if (this.checkDebounceTimer) {
                clearTimeout(this.checkDebounceTimer);
                this.checkDebounceTimer = null;
            }
            if (this.posterDebounceTimer) {
                clearTimeout(this.posterDebounceTimer);
                this.posterDebounceTimer = null;
            }
            if (this._backupTimer) {
                clearInterval(this._backupTimer);
                this._backupTimer = null;
            }
            if (this._boundOnRouteChange) {
                document.removeEventListener(
                    'stremio-custom-route-change',
                    this._boundOnRouteChange
                );
                this._boundOnRouteChange = null;
            }
            if (this._boundOnStreamsBack) {
                document.removeEventListener('click', this._boundOnStreamsBack, true);
                this._boundOnStreamsBack = null;
            }
            if (this._boundOnEpisodeClick) {
                document.removeEventListener('click', this._boundOnEpisodeClick, true);
                this._boundOnEpisodeClick = null;
            }
            if (this._episodeRetryTimer) {
                clearTimeout(this._episodeRetryTimer);
                this._episodeRetryTimer = null;
            }
            this._activeDetailKey = null;
            this.cleanup(true);
        }
    }

    // Initialize plugin
    let enrichmentInstance = null;
    function bootEnrichment() {
        enrichmentInstance = new DataEnrichment();
        window.__stremioDataEnrichmentInstance = enrichmentInstance;
    }

    /**
     * Hard unload for live disable ÔÇö clears DOM, observers, and Loaded gate.
     */
    window.__stremioDataEnrichmentUnload = function () {
        try {
            const instance = enrichmentInstance || window.__stremioDataEnrichmentInstance;
            if (instance) {
                instance.destroy();
                instance.cleanup(true);
            }
        } catch (_) {}
        enrichmentInstance = null;
        window.__stremioDataEnrichmentInstance = null;
        try {
            delete window.__DataEnrichmentLoaded;
        } catch (_) {
            window.__DataEnrichmentLoaded = false;
        }
        try {
            delete window.__mystremioRatingsBar;
        } catch (_) {
            window.__mystremioRatingsBar = null;
        }
        try {
            document.getElementById('mystremio-ratings-bar-styles-v5')?.remove();
            document.getElementById('mystremio-ratings-bar-styles-v6')?.remove();
            document.getElementById('mystremio-ratings-bar-styles-v7')?.remove();
            document.getElementById('mystremio-ratings-bar-styles-v8')?.remove();
            document.querySelectorAll('.msb-detail-stack, .msb-ratings-row, .mystremio-ratings-bar').forEach((el) => {
                el.remove();
            });
        } catch (_) {}
    };

    window.__stremioDataEnrichmentSuspend = function () {
        try {
            const instance = enrichmentInstance || window.__stremioDataEnrichmentInstance;
            instance?.suspendBackground?.();
        } catch (_) {}
    };

    window.__stremioDataEnrichmentResume = function () {
        try {
            const instance = enrichmentInstance || window.__stremioDataEnrichmentInstance;
            instance?.resumeBackground?.();
        } catch (_) {}
    };

    if (document.body) {
        bootEnrichment();
    } else {
        const checkBody = () => {
            if (document.body) {
                bootEnrichment();
            } else {
                setTimeout(checkBody, 50);
            }
        };
        checkBody();
    }
})();
