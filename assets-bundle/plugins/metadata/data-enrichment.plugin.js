/**
 * @name Data Enrichment
 * @description Enriches movie and TV show details with TMDB data including genres, cast, directors, similar titles, and collections.
 * @version 2.1.0
 * @category metadata
 * @author MrBlu03 edited by MyStremio
 */

(() => {
    // Prevent multiple injections from Stremio's Mod Manager
    if (window.__DataEnrichmentLoaded) return;
    window.__DataEnrichmentLoaded = true;

    const PLUGIN_ID = 'data-enrichment';
    const LEGACY_CONFIG_KEY = 'dataEnrichmentConfig';
    const MIGRATION_DONE_KEY = 'dataEnrichmentMigrated';
    const SETTING_KEYS = {
        TMDB_API_KEY: 'tmdbApiKey',
        RPDB_API_KEY: 'rpdbApiKey',
        ENHANCED_CAST: 'enhancedCast',
        SIMILAR_TITLES: 'similarTitles',
        SHOW_COLLECTION: 'showCollection',
        POSTER_RATINGS: 'showRatingsOnPosters',
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
            /* Theater comedy + tragedy masks (Lucide drama — matches user ref) */
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
            /* Crossed swords X — tips up, crossguards, round pommels (user ref image 4) */
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
            this.lastEnrichmentTime = 0;
            /** Monotonic session id — bumped on every navigation to cancel stale enrich. */
            this.sessionId = 0;
            /** @type {AbortController|null} */
            this.enrichAbort = null;
            this.checkDebounceTimer = null;
            this.posterDebounceTimer = null;
            this.reconcileTimer = null;
            this._backupTimer = null;
            this._boundOnRouteChange = null;
            this._boundOnStreamsBack = null;
            /** @type {Element|null} Mount identity — remount when React replaces meta-info. */
            this._mountEl = null;
            /** @type {string|null} `type/metaId/videoId` — episode↔overview invalidates. */
            this._activeDetailKey = null;
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
            ] = await Promise.all([
                this.readSetting(SETTING_KEYS.TMDB_API_KEY),
                this.readSetting(SETTING_KEYS.RPDB_API_KEY),
                this.readSetting(SETTING_KEYS.ENHANCED_CAST),
                this.readSetting(SETTING_KEYS.SIMILAR_TITLES),
                this.readSetting(SETTING_KEYS.SHOW_COLLECTION),
                this.readSetting(SETTING_KEYS.POSTER_RATINGS),
            ]);

            this.config = {
                ...getDefaultConfig(),
                tmdbApiKey: normalizeString(tmdbApiKey),
                rpdbApiKey: normalizeString(rpdbApiKey),
                enhancedCast: normalizeToggle(enhancedCast, true),
                similarTitles: normalizeToggle(similarTitles, true),
                showCollection: normalizeToggle(showCollection, true),
                showRatingsOnPosters: normalizeToggle(showRatingsOnPosters, true),
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
                    description: 'Get your API key at ratingposterdb.com (https://ratingposterdb.com)',
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
            });
        }

        /**
         * Extracts a normalized IMDb title id (tt…) from any raw string.
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
            const videoId = match[3] || null;
            const imdbId = this.normalizeImdbId(h);

            return {
                surface: 'detail',
                type,
                metaId,
                videoId,
                imdbId,
                // Detail surface always; IMDb may come from hash or DOM (Discover handoff).
                shouldEnrich: true,
            };
        }

        /**
         * Stable identity for a detail navigation (episode ↔ overview changes videoId).
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
         * @param {string} imdbId
         * @returns {boolean}
         */
        isPaintedInMount(mount, imdbId) {
            const normalized = this.normalizeImdbId(imdbId);
            if (!mount || !normalized) return false;
            const container = mount.querySelector('.data-enrichment-container');
            return Boolean(
                container &&
                    container.isConnected &&
                    this.normalizeImdbId(container.dataset.imdbId) === normalized &&
                    container.querySelector(
                        '.enhanced-genres-section, .enhanced-directors-section, .enhanced-cast-section, .enhanced-similar-section, .enhanced-collection-section'
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
            // Ladder owns the remount window — avoid stacking extra timers.
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
         * Fetch/cache only — no DOM writes.
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
         * Synchronous DOM paint from already-fetched TMDB data (slogan-style re-bind).
         * @param {Element} mount
         * @param {string} imdbId
         * @param {object} data
         * @returns {boolean}
         */
        paint(mount, imdbId, data) {
            imdbId = this.normalizeImdbId(imdbId);
            if (!mount?.isConnected || !imdbId || !data) return false;

            if (this.isPaintedInMount(mount, imdbId)) {
                this.hideNativeMetaSections(mount);
                this.enrichedImdbId = imdbId;
                this.pinImdbRating(imdbId);
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

            container.dataset.imdbId = imdbId;

            const oldBadge = document.querySelector('.enhanced-tmdb-badge');
            if (oldBadge) oldBadge.remove();

            // Order: Genres → Directors → Cast → Similar → Collection
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
                    '.enhanced-genres-section, .enhanced-directors-section, .enhanced-cast-section, .enhanced-similar-section, .enhanced-collection-section'
                )
            );

            if (hasInjectedSections) {
                this.hideNativeMetaSections(mount);
                this.enrichedImdbId = imdbId;
                this._mountEl = mount;
                this.lastEnrichmentTime = Date.now();
                this.pinImdbRating(imdbId);
                return true;
            }

            this.restoreNativeMetaSections();
            return false;
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
         * Debounced remount — coalesces route change + streams-back click.
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
            if (route.imdbId) {
                this.prefetchTMDBData(route.imdbId);
                this.pinImdbRating(route.imdbId, route.type);
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
                this.cleanup(true);
                this._mountEl = null;
                this._activeDetailKey = null;
                return;
            }

            const key = this.detailKey(route);
            if (key && this._activeDetailKey && key !== this._activeDetailKey) {
                // Same IMDb, different videoId (episode → overview) — treat as remount.
                this.beginNewSession();
                this.cleanup(true);
                this._mountEl = null;
            }
            this._activeDetailKey = key;

            const mount = this.findMetaInfoContainer();
            if (!mount) {
                this.scheduleReconcile(120);
                return;
            }

            const imdbId = route.imdbId || this.extractImdbId();
            if (!imdbId) {
                this.scheduleReconcile(200);
                return;
            }

            // Always re-assert Cinemeta IMDb score (meta-addon race).
            this.pinImdbRating(imdbId, route.type);

            // Mount identity: painted on a stale node does not count.
            const mountChanged = Boolean(this._mountEl && this._mountEl !== mount);
            if (mountChanged) {
                this._mountEl = null;
            }

            if (!mountChanged && this.isPaintedInMount(mount, imdbId)) {
                this.hideNativeMetaSections(mount);
                this.enrichedImdbId = imdbId;
                this._mountEl = mount;
                return;
            }

            // Cache hit → synchronous paint (survives episode↔overview / Discover overlay remounts)
            if (this.cache.has(imdbId)) {
                this.paint(mount, imdbId, this.cache.get(imdbId));
                return;
            }

            const sessionId = this.sessionId;
            const signal = this.enrichAbort?.signal || null;
            this.prefetchTMDBData(imdbId);

            this.ensureData(imdbId, signal).then((data) => {
                if (sessionId !== this.sessionId || signal?.aborted) return;
                if (!data) {
                    this.restoreNativeMetaSections();
                    this.scheduleReconcile(800);
                    return;
                }
                const remount = this.findMetaInfoContainer();
                if (!remount) {
                    this.scheduleReconcile(180);
                    return;
                }
                this.paint(remount, imdbId, data);
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
                })
                .catch(() => {
                    this.config = this.loadLegacyConfig();
                    this.reconcile();
                });
        }

        /**
         * Slow backup: if detail wants enrichment but none is painted, reconcile.
         */
        setupReconcileBackup() {
            if (this._backupTimer) clearInterval(this._backupTimer);
            this._backupTimer = setInterval(() => {
                if (this._remountTimers.length > 0) return;
                const route = this.parseDetailRoute();
                if (!route.shouldEnrich) return;

                const mount = this.findMetaInfoContainer();
                const imdbId = route.imdbId || this.extractImdbId();
                if (!mount || !imdbId) return;

                if (!this.isPaintedInMount(mount, imdbId)) {
                    this.reconcile();
                } else {
                    this.pinImdbRating(imdbId, route.type);
                }
            }, 8000);
        }

        setupRouteListener() {
            // Custom bus already covers hashchange — do not also bind hashchange (double remount).
            /**
             * Smart remount: clean on player; remount detail only when key/mount needs it.
             * @param {CustomEvent} [event]
             */
            this._boundOnRouteChange = (event) => {
                const next = event?.detail?.next ?? window.location.hash ?? '';
                const route = this.parseDetailRoute(next);

                // Entering player — drop enrichment paint, do not forceRemount (avoids ghost panels).
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
                const imdbId = route.imdbId || this.extractImdbId();

                // Same detail after Player→Back: already painted on live mount → skip wipe.
                if (
                    key &&
                    key === this._activeDetailKey &&
                    mount &&
                    imdbId &&
                    this.isPaintedInMount(mount, imdbId)
                ) {
                    this._mountEl = mount;
                    this.pinImdbRating(imdbId, route.type);
                    return;
                }

                this.forceRemount();
            };

            /**
             * Streams sidebar back — only remount if route/mount actually needs it.
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

                const keyBefore = this._activeDetailKey;
                window.setTimeout(() => {
                    const route = this.parseDetailRoute();
                    if (route.surface !== 'detail') return;
                    const key = this.detailKey(route);
                    const mount = this.findMetaInfoContainer();
                    const imdbId = route.imdbId || this.extractImdbId();
                    if (
                        key &&
                        key === keyBefore &&
                        mount &&
                        imdbId &&
                        this.isPaintedInMount(mount, imdbId)
                    ) {
                        return;
                    }
                    if (!mount || !imdbId || !this.isPaintedInMount(mount, imdbId)) {
                        this.forceRemount();
                    }
                }, 120);
            };

            document.addEventListener('stremio-custom-route-change', this._boundOnRouteChange);
            document.addEventListener('click', this._boundOnStreamsBack, true);
        }

        setupObserver() {
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

                for (const mutation of mutations) {
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
                    const imdbId = route.imdbId || this.extractImdbId();
                    if (imdbId) this.pinImdbRating(imdbId, route.type);
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
        }

        cleanup(force = false) {
            if (!force) return;
            const container = document.querySelector('.data-enrichment-container');
            if (container) container.remove();
            const badge = document.querySelector('.enhanced-tmdb-badge');
            if (badge) badge.remove();
            this.restoreNativeMetaSections();
            this.enrichedImdbId = null;
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
                /^(genres?|cast|actors?|directors?|director|creators?|created by|regie|regisseur|darsteller)$/i.test(text) ||
                /^(genre|cast|director|creator|regie)/i.test(text)
            );
        }

        /**
         * Hides native Genres / Cast / Directors within the detail meta tree.
         * @param {Element|null} [mount]
         */
        hideNativeMetaSections(mount = null) {
            const detailsRoot =
                mount?.closest('[class*="meta-details"], [class*="meta-preview"]') || null;
            const sections = document.querySelectorAll(
                '[class*="meta-links-container"], [class*="genres-container"]'
            );
            sections.forEach((section) => {
                if (section.closest('.data-enrichment-container')) return;
                if (detailsRoot && !detailsRoot.contains(section)) return;

                // Dedicated genres container (no meta-links label)
                if (String(section.className || '').includes('genres-container')) {
                    section.style.display = 'none';
                    section.dataset.mystremioEnrichedHidden = '1';
                    return;
                }

                const labelEl = section.querySelector('[class*="label-container"]');
                const label = labelEl?.textContent || '';
                if (!this.isReplacedNativeMetaLabel(label)) return;

                section.style.display = 'none';
                section.dataset.mystremioEnrichedHidden = '1';
            });
        }

        /**
         * Restores native meta sections hidden by {@link hideNativeMetaSections}.
         */
        restoreNativeMetaSections() {
            document
                .querySelectorAll('[data-mystremio-enriched-hidden="1"]')
                .forEach((section) => {
                    section.style.display = '';
                    delete section.dataset.mystremioEnrichedHidden;
                });
        }

        extractImdbId() {
            const fromHash = this.normalizeImdbId(window.location.hash || window.location.href);
            if (fromHash) return fromHash;

            const imdbLink = document.querySelector('a[href*="imdb.com/title/tt"]');
            if (imdbLink) {
                const fromLink = this.normalizeImdbId(imdbLink.href);
                if (fromLink) return fromLink;
            }

            const metaElements = document.querySelectorAll('[data-imdbid], [data-imdb-id]');
            for (const el of metaElements) {
                const fromData = this.normalizeImdbId(el.dataset.imdbid || el.dataset.imdbId);
                if (fromData) return fromData;
            }

            const allLinks = document.querySelectorAll('a[href*="imdb"]');
            for (const link of allLinks) {
                const fromHref = this.normalizeImdbId(link.href);
                if (fromHref) return fromHref;
            }

            return null;
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
         * Normalizes a rating string for comparison (e.g. "7.90" → "7.9").
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
         * Applies Cinemeta rating to the DOM IMDb label when an addon overwrote it.
         * @param {string} imdbId
         * @param {string|null} [typeHint]
         * @returns {Promise<void>}
         */
        async pinImdbRating(imdbId, typeHint = null) {
            const id = this.normalizeImdbId(imdbId);
            if (!id) return;
            const sessionId = this.sessionId;
            const route = this.parseDetailRoute();
            const type = typeHint || route.type;

            const rating = await this.fetchCinemetaRating(id, type);
            if (sessionId !== this.sessionId || !rating) return;

            const currentId = route.imdbId || this.extractImdbId();
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
                
                // TV Series Cast needs aggregate_credits; plain credits is often only a handful of people.
                const append =
                    mediaType === 'tv'
                        ? 'credits,aggregate_credits,similar,recommendations,external_ids,content_ratings,release_dates,images'
                        : 'credits,similar,recommendations,external_ids,content_ratings,release_dates,images';
                const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${apiKey}&append_to_response=${append}&include_image_language=en,null`;
                const detailResponse = await fetch(detailUrl);
                
                if (!detailResponse.ok) return null;
                
                const data = await detailResponse.json();
                data.media_type = mediaType;

                this.cache.set(imdbId, data);
                return data;
            } catch (error) {
                console.error('[DataEnrichment] Fetch error:', error);
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
                    <button class="enhanced-scroll-btn enhanced-scroll-left" aria-label="Scroll left">‹</button>
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
                    <button class="enhanced-scroll-btn enhanced-scroll-right" aria-label="Scroll right">›</button>
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
                    window.location.hash = `#/search?search=${encodeURIComponent(name)}`;
                };
                pill.addEventListener('click', go);
                pill.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') go(e);
                });
            });
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
                    <button class="enhanced-scroll-btn enhanced-scroll-left" aria-label="Scroll left">‹</button>
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
                    <button class="enhanced-scroll-btn enhanced-scroll-right" aria-label="Scroll right">›</button>
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
                    <button class="enhanced-scroll-btn enhanced-scroll-left" aria-label="Scroll left">‹</button>
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
                    <button class="enhanced-scroll-btn enhanced-scroll-right" aria-label="Scroll right">›</button>
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
                    <button class="enhanced-scroll-btn enhanced-scroll-left" aria-label="Scroll left">‹</button>
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
                    <button class="enhanced-scroll-btn enhanced-scroll-right" aria-label="Scroll right">›</button>
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
                    <button class="enhanced-scroll-btn enhanced-scroll-left" aria-label="Scroll left">‹</button>
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
                    <button class="enhanced-scroll-btn enhanced-scroll-right" aria-label="Scroll right">›</button>
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
         * Resolve a stable media id for a poster/card (IMDb or TMDB).
         * @param {HTMLElement} poster
         * @returns {{ mediaId: string, idType: string }|null}
         */
        resolvePosterMediaId(poster) {
            let mediaId = null;
            let idType = 'imdb';

            if (poster.classList.contains('enhanced-poster-item')) {
                const rawId = poster.dataset.id;
                idType = 'tmdb';
                mediaId = poster.dataset.mediaType === 'tv' ? `series-${rawId}` : `movie-${rawId}`;
            } else {
                const linkElement = poster.tagName === 'A' ? poster : poster.querySelector('a');
                if (!linkElement || !linkElement.href) return null;

                const imdbMatch = linkElement.href.match(/(tt\d+)/);
                if (imdbMatch) {
                    mediaId = imdbMatch[1];
                    idType = 'imdb';
                } else {
                    const tmdbMatch = linkElement.href.match(/tmdb[:\/](\d+)/);
                    if (tmdbMatch) {
                        idType = 'tmdb';
                        mediaId = linkElement.href.includes('series')
                            ? `series-${tmdbMatch[1]}`
                            : `movie-${tmdbMatch[1]}`;
                    }
                }
            }

            if (!mediaId) return null;
            return { mediaId, idType };
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

        checkForPosters() {
            if (!this.config.showRatingsOnPosters || !this.config.rpdbApiKey) return;

            const posters = document.querySelectorAll(
                '.meta-item-container-Tj0Ib, [class*="meta-item-container"], .poster-container, .enhanced-poster-item'
            );

            posters.forEach((poster) => {
                const resolved = this.resolvePosterMediaId(poster);
                if (!resolved) return;

                const { mediaId, idType } = resolved;
                const storedId = poster.dataset.rpdbId || '';

                // Card reused for another title — clear stale RPDB artwork
                if (poster.dataset.rpdbEnriched === 'true' && storedId && storedId !== mediaId) {
                    this.resetRpdbPoster(poster);
                }

                if (poster.dataset.rpdbEnriched === 'true' && storedId === mediaId) {
                    return;
                }

                const imgElement = poster.querySelector('img');
                if (!imgElement) return;

                const gen = String((Number(poster.dataset.rpdbGen) || 0) + 1);
                poster.dataset.rpdbGen = gen;
                poster.dataset.rpdbEnriched = 'true';
                poster.dataset.rpdbId = mediaId;
                if (!imgElement.dataset.rpdbOriginalSrc) {
                    imgElement.dataset.rpdbOriginalSrc = imgElement.src;
                }

                const rpdbKey = this.config.rpdbApiKey;
                const rpdbUrl = `https://api.ratingposterdb.com/${rpdbKey}/${idType}/poster-default/${mediaId}.jpg?fallback=true`;

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
                };

                tempImg.onerror = () => {
                    console.debug(`[RPDB] Failed to load poster for ${mediaId}`);
                };

                tempImg.src = rpdbUrl;
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
     * Hard unload for live disable — clears DOM, observers, and Loaded gate.
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
