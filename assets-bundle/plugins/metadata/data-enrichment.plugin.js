/**
 * @name Data Enrichment
 * @description Enriches movie and TV show details with TMDB data including enhanced cast, similar titles, collections, and ratings.
 * @version 2.0.0
 * @category metadata
 * @author MrBlu03
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
            this.isEnriching = false;
            this.checkDebounceTimer = null;
            this.enrichRetryTimer = null;
            this.pendingFetchId = null;
            this.pendingFetch = null;
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
                this.checkForDetailPage();
            });
        }

        scheduleDetailCheck(delayMs = 80) {
            if (this.enrichRetryTimer) {
                clearTimeout(this.enrichRetryTimer);
            }
            this.enrichRetryTimer = setTimeout(() => {
                this.enrichRetryTimer = null;
                this.checkForDetailPage();
            }, delayMs);
        }

        findDetailMountPoint() {
            const selectors = [
                '.meta-details-container',
                '[class*="meta-info-container"]',
                '[class*="meta-preview-container"]',
                '[class*="details-container"]',
                '[class*="side-drawer"]',
            ];

            for (const selector of selectors) {
                const element = document.querySelector(selector);
                if (element && !element.closest('[class*="player-container"], [class*="control-bar-layer"], [class*="subtitles-menu-container"]')) return element;
            }

            return null;
        }

        hasActiveEnrichment(imdbId) {
            const container = document.querySelector('.data-enrichment-container');
            return Boolean(
                container &&
                this.enrichedImdbId === imdbId &&
                container.dataset.imdbId === imdbId
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
            if (!imdbId || (this.pendingFetchId === imdbId && this.pendingFetch)) return;

            this.pendingFetchId = imdbId;
            this.pendingFetch = this.settingsReady
                .then(() => {
                    if (!this.config.tmdbApiKey) return null;
                    return this.fetchTMDBData(imdbId);
                })
                .catch(() => null);
        }
        
        init() {
            console.log('[DataEnrichment] Plugin loaded successfully v2.0.0');
            this.setupObserver();
            this.setupHashChangeListener();

            this.settingsReady
                .then(() => {
                    const imdbMatch = window.location.hash.match(/tt\d+/);
                    if (imdbMatch) this.prefetchTMDBData(imdbMatch[0]);
                    this.checkForDetailPage();
                })
                .catch(() => {
                    this.config = this.loadLegacyConfig();
                    this.checkForDetailPage();
                });
        }

        setupHashChangeListener() {
            this.lastHash = window.location.hash;
            
            const handleHashChange = () => {
                const newHash = window.location.hash;
                const isDetailRoute = /#\/(detail|meta)\//.test(newHash);
                const oldImdbMatch = this.lastHash.match(/tt\d+/);
                const newImdbMatch = newHash.match(/tt\d+/);

                if (!isDetailRoute) {
                    this.cleanup(true);
                } else if (!newImdbMatch) {
                    this.cleanup(true);
                } else if (oldImdbMatch && newImdbMatch && oldImdbMatch[0] !== newImdbMatch[0]) {
                    this.cleanup(true);
                    this.prefetchTMDBData(newImdbMatch[0]);
                    this.scheduleDetailCheck(60);
                }
                
                this.lastHash = newHash;
            };
            
            window.addEventListener('hashchange', handleHashChange);
        }

        setupObserver() {
            this.observer = new MutationObserver((mutations) => {
                if (this.isEnriching) return;
                
                if (this.checkDebounceTimer) {
                    clearTimeout(this.checkDebounceTimer);
                }
                this.checkDebounceTimer = setTimeout(() => {
                    this.checkForDetailPage();
                    this.checkForPosters();
                }, 120);
            });

            this.observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        checkForDetailPage() {
            if (this.isEnriching) return;

            const hash = window.location.hash || '';
            const isDetailRoute = /#\/(detail|meta)\//.test(hash);
            if (!isDetailRoute) {
                this.cleanup(true);
                return;
            }

            const urlHasImdbId = hash.match(/tt\d+/);
            if (!urlHasImdbId) return;

            const metaInfoContainer = this.findDetailMountPoint();
            if (!metaInfoContainer) {
                this.scheduleDetailCheck(150);
                return;
            }

            const imdbId = this.extractImdbId();
            if (!imdbId) return;

            if (this.hasActiveEnrichment(imdbId)) return;

            this.prefetchTMDBData(imdbId);
            this.enrichDetailPage(imdbId, metaInfoContainer);
        }
        
        cleanup(force = false) {
            if (!force) return;
            const container = document.querySelector('.data-enrichment-container');
            if (container) container.remove();
            const badge = document.querySelector('.enhanced-tmdb-badge');
            if (badge) badge.remove();
            this.enrichedImdbId = null;
            this.pendingFetchId = null;
            this.pendingFetch = null;
        }

        extractImdbId() {
            const match = (window.location.hash || window.location.href).match(/tt\d+/);
            if (match) return match[0];

            const imdbLink = document.querySelector('a[href*="imdb.com/title/tt"]');
            if (imdbLink) {
                const linkMatch = imdbLink.href.match(/tt\d+/);
                if (linkMatch) return linkMatch[0];
            }
            
            const metaElements = document.querySelectorAll('[data-imdbid], [data-imdb-id]');
            for (const el of metaElements) {
                const id = el.dataset.imdbid || el.dataset.imdbId;
                if (id && id.match(/tt\d+/)) return id;
            }
            
            const allLinks = document.querySelectorAll('a[href*="imdb"]');
            for (const link of allLinks) {
                const idMatch = link.href.match(/tt\d+/);
                if (idMatch) return idMatch[0];
            }

            return null;
        }

        async enrichDetailPage(imdbId, container) {
            await this.settingsReady.catch(() => {});

            if (!this.config.tmdbApiKey) {
                this.scheduleDetailCheck(600);
                return;
            }

            this.isEnriching = true;

            try {
                let data = null;
                if (this.pendingFetchId === imdbId && this.pendingFetch) {
                    data = await this.pendingFetch;
                }
                if (!data) {
                    data = await this.fetchTMDBData(imdbId);
                }

                if (!data) {
                    this.scheduleDetailCheck(800);
                    return;
                }

                const oldContainer = document.querySelector('.data-enrichment-container');
                if (oldContainer) oldContainer.remove();
                const oldBadge = document.querySelector('.enhanced-tmdb-badge');
                if (oldBadge) oldBadge.remove();
                
                const currentUrlImdbId = window.location.hash.match(/tt\d+/);
                if (!currentUrlImdbId || currentUrlImdbId[0] !== imdbId) {
                    return;
                }

                const enrichmentContainer = this.createEnrichmentContainer();
                if (!enrichmentContainer) {
                    this.scheduleDetailCheck(180);
                    return;
                }
                
                enrichmentContainer.dataset.imdbId = imdbId;

                if (this.config.enhancedCast && data.credits) {
                    this.injectEnhancedCast(data.credits, enrichmentContainer);
                }

                if (this.config.similarTitles) {
                    let similarItems = [];
                    
                    if (data.recommendations?.results?.length > 0) {
                        similarItems = data.recommendations.results.slice(0, 15);
                    } else if (data.similar?.results?.length > 0) {
                        similarItems = data.similar.results.slice(0, 15);
                    }

                    if (similarItems.length > 0) {
                        this.injectSimilarTitles({ results: similarItems }, enrichmentContainer);
                    }
                }

                if (this.config.showCollection && data.belongs_to_collection) {
                    this.injectCollection(data.belongs_to_collection, enrichmentContainer).catch(() => {});
                }

                this.enrichedImdbId = imdbId;
                this.lastEnrichmentTime = Date.now();

            } catch (error) {
                console.error('[DataEnrichment] Error enriching page:', error);
                this.scheduleDetailCheck(800);
            } finally {
                this.isEnriching = false;
            }
        }

        createEnrichmentContainer() {
            const existing = document.querySelector('.data-enrichment-container');
            if (existing) return existing;

            const mount = this.findDetailMountPoint();
            if (!mount) return null;

            const enrichmentContainer = document.createElement('div');
            enrichmentContainer.className = 'data-enrichment-container';
            mount.appendChild(enrichmentContainer);
            return enrichmentContainer;
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
                
                const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${apiKey}&append_to_response=credits,similar,recommendations,external_ids,content_ratings,release_dates,images&include_image_language=en,null`;
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

        injectEnhancedCast(credits, container) {
            const cast = credits.cast?.slice(0, 15) || [];
            if (cast.length === 0) return;

            const section = document.createElement('div');
            section.className = 'enhanced-cast-section enhanced-carousel';
            section.innerHTML = `
                <div class="enhanced-section-header">Cast</div>
                <div class="enhanced-carousel-wrapper">
                    <button class="enhanced-scroll-btn enhanced-scroll-left" aria-label="Scroll left">‹</button>
                    <div class="enhanced-cast-container enhanced-scroll-container">
                        ${cast.map(actor => `
                            <div class="enhanced-cast-item">
                                <div class="enhanced-cast-image-container">
                                    ${actor.profile_path 
                                        ? `<img class="enhanced-cast-image" src="https://image.tmdb.org/t/p/w185${actor.profile_path}" alt="${actor.name}" loading="lazy">`
                                        : `<div class="enhanced-cast-placeholder"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></div>`
                                    }
                                </div>
                                <div class="enhanced-cast-info">
                                    <div class="enhanced-cast-name">${actor.name}</div>
                                    <div class="enhanced-cast-character">${actor.character || ''}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                    <button class="enhanced-scroll-btn enhanced-scroll-right" aria-label="Scroll right">›</button>
                </div>
            `;
            
            container.appendChild(section);
            this.setupScrollButtons(section);
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
                        window.location.hash = `#/detail/${stremioType}/${imdbId}`;
                        
                    } catch (error) {
                        console.error('[DataEnrichment] Error navigating to item:', error);
                    } finally {
                        item.style.opacity = '';
                        item.style.pointerEvents = '';
                    }
                });
            });
        }

        checkForPosters() {
            if (!this.config.showRatingsOnPosters || !this.config.rpdbApiKey) return;

            const posters = document.querySelectorAll('.meta-item-container-Tj0Ib:not([data-rpdb-enriched]), [class*="meta-item-container"]:not([data-rpdb-enriched]), .poster-container:not([data-rpdb-enriched]), .enhanced-poster-item:not([data-rpdb-enriched])');
            
            posters.forEach(poster => {
                poster.dataset.rpdbEnriched = 'true';
                
                const imgElement = poster.querySelector('img');
                if (!imgElement) return;

                let mediaId = null;
                let idType = 'imdb';

                if (poster.classList.contains('enhanced-poster-item')) {
                    const rawId = poster.dataset.id;
                    idType = 'tmdb';
                    mediaId = poster.dataset.mediaType === 'tv' ? `series-${rawId}` : `movie-${rawId}`;
                } else {
                    const linkElement = poster.tagName === 'A' ? poster : poster.querySelector('a');
                    if (!linkElement || !linkElement.href) return;

                    const imdbMatch = linkElement.href.match(/(tt\d+)/);
                    if (imdbMatch) {
                        mediaId = imdbMatch[1];
                        idType = 'imdb';
                    } else {
                        const tmdbMatch = linkElement.href.match(/tmdb[:\/](\d+)/);
                        if (tmdbMatch) {
                            idType = 'tmdb';
                            mediaId = linkElement.href.includes('series') ? `series-${tmdbMatch[1]}` : `movie-${tmdbMatch[1]}`;
                        }
                    }
                }

                if (mediaId) {
                    const rpdbKey = this.config.rpdbApiKey;
                    const rpdbUrl = `https://api.ratingposterdb.com/${rpdbKey}/${idType}/poster-default/${mediaId}.jpg?fallback=true`;

                    const tempImg = new Image();
                    tempImg.onload = () => {
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
                }
            });
        }

        destroy() {
            if (this.observer) {
                this.observer.disconnect();
            }
            if (this.enrichRetryTimer) {
                clearTimeout(this.enrichRetryTimer);
            }
        }
    }

    // Initialize plugin
    if (document.body) {
        new DataEnrichment();
    } else {
        const checkBody = () => {
            if (document.body) {
                new DataEnrichment();
            } else {
                setTimeout(checkBody, 50);
            }
        };
        checkBody();
    }
})();
