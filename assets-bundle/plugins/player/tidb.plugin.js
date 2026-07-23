/**
 * @name Intro Skip
 * @description Skip intros, recaps, credits, and previews using TheIntroDB, IntroDB, and AniSkip
 * @version 2.2.0
 * @author MyStremio
 */
/* jshint esversion: 11, browser: true, devel: true */
/* global StremioEnhancedAPI */

(function() {
	"use strict";

	const PLUGIN_VERSION = "2.2.0";
	const LOG_PREFIX = "[IntroSkip]";
	const CONTRIBUTE_TOAST_ID = "tidb-contribute-toast";
	const PLUGIN_ID = "tidb";
	const THEINTRODB_SERVER_URL = "https://api.theintrodb.org/v3";
	const INTRODB_SERVER_URL = "https://api.introdb.app";
	const ACTIVE_BTN_ID = "tidb-active-btn";
	const CONTRIBUTE_BTN_ID = "tidb-contribute-btn";
	const CONTRIBUTE_PANEL_ID = "tidb-contribute-panel";
	const CONTRIBUTE_STYLE_ID = "tidb-contribute-styles";
	const CONTRIBUTE_BTN_CLASS = "tidb-contribute-control-btn";
	const CONTRIBUTE_ICON_SIZE = "2.0rem";
	const CONTRIBUTE_OVERLAY_LOCK_CLASS = "tidb-contribute-overlay-lock";
	const MAX_RETRIES = 3;
	const RETRY_DELAY = 2000;
	const TIDB_API_KEY_SETTING = "tidb_api_key";
	const INTRODB_API_KEY_SETTING = "introdb_api_key";
	const USE_THEINTRODB_SETTING = "use_theintrodb";
	const USE_INTRODB_SETTING = "use_introdb";
	const USE_ANISKIP_SETTING = "use_aniskip";
	const ANALYTICS_SETTING = "anonymous_usage_reporting";
	const PLUGIN_USER_AGENT = "MyStremio Intro Skip Plugin";
	const SUBMIT_TARGET_THEINTRODB = "theintrodb";
	const SUBMIT_TARGET_INTRODB = "introdb";
	const SUBMIT_TARGET_BOTH = "both";
	const ANISKIP_TYPE_MAP = {
		op: "intro",
		ed: "credits",
		recap: "recap"
	};

	const THEMES = {
		default: {
            background: "#0f0d20",
            hover: "#1b192b",
            border: "none",
            backdropFilter: "none",
            borderRadius: "6px",
            fontSize: "24px",
            padding: "16px",
			iconSize: "24"
        },
        glass: {
            background: "rgba(70, 70, 70, 0.22)",
            hover: "rgba(90, 90, 90, 0.32)",
            border: "1px solid rgba(255, 255, 255, 0.04)",
            backdropFilter: "none",
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.2), 0 4px 16px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.15), inset 0 -1px 0 rgba(0, 0, 0, 0.1)",
            borderRadius: "50px",
            fontSize: "15px",
            padding: "8px 16px",
			iconSize: "20"
        }
	};

	const SEGMENT_BUTTON_SETTINGS = {
		intro: "show_intro_button",
		recap: "show_recap_button",
		credits: "show_credits_button",
		preview: "show_preview_button"
	};
	const SEGMENT_TYPES = Object.keys(SEGMENT_BUTTON_SETTINGS);

	function isLiquidGlassThemeActive() {
		try {
			const appTheme = localStorage.getItem("currentTheme") || "";
			return appTheme.includes("liquid-glass");
		} catch {
			return false;
		}
	}

	function resolveThemeName() {
		if (isLiquidGlassThemeActive()) {
			return "glass";
		}
		return "default";
	}

	const AUTOSKIP_STORAGE_KEYS = {
		intro: "stremio-custom-autoskip-intro",
		credits: "stremio-custom-autoskip-credits",
		recap: "stremio-custom-autoskip-recap",
		preview: "stremio-custom-autoskip-preview"
	};

	function isAutoSkipEnabled(segmentType) {
		if (window.StremioCustomAutoskip?.isEnabled) {
			return window.StremioCustomAutoskip.isEnabled(segmentType);
		}
		const storageKey = AUTOSKIP_STORAGE_KEYS[segmentType];
		if (!storageKey) {
			return false;
		}
		try {
			return localStorage.getItem(storageKey) === "true";
		} catch {
			return false;
		}
	}
	const SEGMENT_LABELS = Object.freeze({
		intro: "Skip Intro",
		recap: "Skip Recap",
		credits: "Skip Credits",
		preview: "Skip Preview"
	});
	const SEGMENT_SUBMIT_LABELS = Object.freeze({
		intro: "Intro",
		recap: "Recap",
		credits: "Credits",
		preview: "Preview"
	});
	const SEGMENT_COLORS = Object.freeze({
		intro: "rgba(255, 217, 0, 0.6)",
		recap: "rgba(255, 165, 0, 0.6)",
		credits: "rgba(100, 149, 237, 0.6)",
		preview: "rgba(144, 238, 144, 0.6)"
	});
	const HIDE_TIMEOUT = 5000;

	const APTABASE_APP_KEY = "A-SH-3524453842";
	const APTABASE_HOST = "https://analytics.theintrodb.org";
	const APTABASE_SDK_VERSION = "aptabase-web@userscript";
	const APTABASE_SESSION_TIMEOUT_SEC = 1 * 60 * 60;

	let _aptabaseAppKey = "";
	let _aptabaseApiUrl = null;
	let _aptabaseAppVersion = "";
	let _aptabaseIsDebug = null;
	let _aptabaseLocale = null;
	let _aptabaseSessionId = null;
	let _aptabaseLastTouched = 0;

	function aptabaseNewSessionId() {
		const epochInSeconds = Math.floor(Date.now() / 1000).toString();
		const random = Math.floor(Math.random() * 100000000).toString().padStart(8, "0");
		return epochInSeconds + random;
	}

	function aptabaseInMemorySessionId(timeoutSec) {
		const now = Date.now();
		const diffInSec = Math.floor((now - _aptabaseLastTouched) / 1000);
		if (!_aptabaseSessionId || diffInSec > timeoutSec) {
			_aptabaseSessionId = aptabaseNewSessionId();
		}
		_aptabaseLastTouched = now;
		return _aptabaseSessionId;
	}

	function aptabaseGetBrowserLocale() {
		if (_aptabaseLocale) return _aptabaseLocale;
		if (typeof navigator === "undefined") return undefined;
		_aptabaseLocale = (navigator.languages && navigator.languages.length > 0) ? navigator.languages[0] : navigator.language;
		return _aptabaseLocale;
	}

	function aptabaseGetIsDebug() {
		if (_aptabaseIsDebug !== null) return _aptabaseIsDebug;
		if (typeof location === "undefined") {
			_aptabaseIsDebug = false;
			return _aptabaseIsDebug;
		}
		_aptabaseIsDebug = location.hostname === "localhost";
		return _aptabaseIsDebug;
	}

	function aptabaseValidateAppKey(appKey) {
		const parts = String(appKey || "").split("-");
		return parts.length === 3 && ["US", "EU", "DEV", "SH"].includes(parts[1]);
	}

	function aptabaseGetApiUrl(appKey, options) {
		const region = String(appKey || "").split("-")[1];
		if (region === "SH") {
			if (!options || !options.host) return null;
			return `${options.host}/api/v0/event`;
		}
		const hosts = {
			US: "https://us.aptabase.com",
			EU: "https://eu.aptabase.com",
			DEV: "https://localhost:3000"
		};
		const host = (options && options.host) ? options.host : hosts[region];
		return host ? `${host}/api/v0/event` : null;
	}

	function aptabaseInit(appKey, options) {
		if (!aptabaseValidateAppKey(appKey)) return false;
		_aptabaseApiUrl = (options && options.apiUrl) ? options.apiUrl : aptabaseGetApiUrl(appKey, options);
		if (!_aptabaseApiUrl) return false;
		_aptabaseAppKey = appKey;
		_aptabaseAppVersion = (options && options.appVersion) ? String(options.appVersion) : "";
		return true;
	}

	async function aptabaseSendEvent(eventName, props) {
		if (typeof fetch !== "function" || !_aptabaseApiUrl || !_aptabaseAppKey) return;
		try {
			const sessionId = aptabaseInMemorySessionId(APTABASE_SESSION_TIMEOUT_SEC);
			const response = await fetch(_aptabaseApiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"App-Key": _aptabaseAppKey
				},
				credentials: "omit",
				body: JSON.stringify({
					timestamp: new Date().toISOString(),
					sessionId,
					eventName,
					systemProps: {
						locale: aptabaseGetBrowserLocale(),
						isDebug: aptabaseGetIsDebug(),
						appVersion: _aptabaseAppVersion,
						sdkVersion: APTABASE_SDK_VERSION
					},
					props
				})
			});
			if (response.status >= 300) {
				const responseBody = await response.text();
				console.warn(`Failed to send event "${eventName}": ${response.status} ${responseBody}`);
			}
		} catch (e) {
			console.warn(`Failed to send event "${eventName}"`);
			console.warn(e);
		}
	}

	function aptabaseTrackEvent(eventName, props) {
		aptabaseSendEvent(eventName, props);
	}

	function initAnalyticsOnce() {
		if (window.__tidbAnalyticsInitialized) return;
		const ok = aptabaseInit(APTABASE_APP_KEY, {
			host: APTABASE_HOST,
			appVersion: PLUGIN_VERSION
		});
		if (!ok) return;
		window.__tidbAnalyticsInitialized = true;
		aptabaseTrackEvent("plugin_started", {
			version: PLUGIN_VERSION
		});
	}

	function capitalize(value) {
		const str = String(value || "");
		return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
	}

	function emptySegments() {
		return Object.fromEntries(SEGMENT_TYPES.map((type) => [type, []]));
	}

	/**
	 * Normalize a TheIntroDB API key (`theintrodb:user_…:…`).
	 *
	 * @param {unknown} value Raw setting value.
	 * @returns {string} Normalized key or empty string.
	 */
	function normalizeTheIntroDbApiKey(value) {
		const raw = typeof value === "string" ? value.trim() : "";
		if (!raw) return "";

		const unquoted = raw.replace(/^["']|["']$/g, "");
		if (/^theintrodb:user_/i.test(unquoted)) {
			return unquoted;
		}

		return unquoted;
	}

	/**
	 * Normalize an IntroDB API key (`idb_…`).
	 *
	 * @param {unknown} value Raw setting value.
	 * @returns {string} Normalized key or empty string.
	 */
	function normalizeIntroDbApiKey(value) {
		const raw = typeof value === "string" ? value.trim() : "";
		if (!raw) return "";

		const unquoted = raw.replace(/^["']|["']$/g, "");
		const idbMatch = unquoted.match(/idb_[A-Za-z0-9_-]+/);
		if (idbMatch) return idbMatch[0];

		return /^idb_/i.test(unquoted) ? unquoted : "";
	}

	function formatTheIntroDbApiKeyHint() {
		return "Copy the full key from theintrodb.org Docs/API (theintrodb:user_…:…). Do not paste only the part after the colon.";
	}

	function formatIntroDbApiKeyHint() {
		return "Copy your API key from introdb.app (format: idb_…).";
	}

	/**
	 * Convert a provider segment object to seconds for the unified player model.
	 *
	 * @param {{start_ms?: number|null, end_ms?: number|null, start_sec?: number|null, end_sec?: number|null}|null|undefined} segment
	 * @returns {{start: number, end: number|null}|null}
	 */
	function segmentObjectToSeconds(segment) {
		if (!segment || typeof segment !== "object") return null;

		let start = null;
		if (segment.start_sec != null && Number.isFinite(segment.start_sec)) {
			start = segment.start_sec;
		} else if (segment.start_ms != null && Number.isFinite(segment.start_ms)) {
			start = segment.start_ms / 1000;
		}

		let end = null;
		if (segment.end_sec != null && Number.isFinite(segment.end_sec)) {
			end = segment.end_sec;
		} else if (segment.end_ms != null && Number.isFinite(segment.end_ms)) {
			end = segment.end_ms / 1000;
		}

		if (start == null || !Number.isFinite(start)) return null;
		return { start, end: end != null && Number.isFinite(end) ? end : null };
	}

	/**
	 * Average two segment ranges when both providers returned timestamps.
	 *
	 * @param {{start: number, end: number|null}} left
	 * @param {{start: number, end: number|null}} right
	 * @returns {{start: number, end: number|null}}
	 */
	function averageSegmentRanges(left, right) {
		const start = (left.start + right.start) / 2;
		let end = null;
		if (left.end != null && right.end != null) {
			end = (left.end + right.end) / 2;
		} else if (left.end != null) {
			end = left.end;
		} else if (right.end != null) {
			end = right.end;
		}
		return { start, end };
	}

	/**
	 * Merge segment lists from both providers. When both have data, use the average.
	 *
	 * @param {Array<{start: number, end: number|null}>} leftSegments
	 * @param {Array<{start: number, end: number|null}>} rightSegments
	 * @returns {Array<{start: number, end: number|null}>}
	 */
	function mergeSegmentLists(leftSegments, rightSegments) {
		if (!leftSegments.length && !rightSegments.length) return [];
		if (!leftSegments.length) return rightSegments.slice();
		if (!rightSegments.length) return leftSegments.slice();
		return [averageSegmentRanges(leftSegments[0], rightSegments[0])];
	}

	/**
	 * Merge TheIntroDB and IntroDB segment maps into one player-facing map.
	 *
	 * @param {Record<string, Array<{start: number, end: number|null}>>} theIntroDbSegments
	 * @param {Record<string, Array<{start: number, end: number|null}>>} introDbSegments
	 * @returns {Record<string, Array<{start: number, end: number|null}>>}
	 */
	function mergeProviderSegments(theIntroDbSegments, introDbSegments) {
		const merged = emptySegments();
		for (const segmentType of SEGMENT_TYPES) {
			merged[segmentType] = mergeSegmentLists(
				theIntroDbSegments[segmentType] || [],
				introDbSegments[segmentType] || []
			);
		}
		return merged;
	}

	/**
	 * Merge a third provider map into an already-merged segment map.
	 *
	 * @param {Record<string, Array<{start: number, end: number|null}>>} baseSegments
	 * @param {Record<string, Array<{start: number, end: number|null}>>} extraSegments
	 * @returns {Record<string, Array<{start: number, end: number|null}>>}
	 */
	function mergeExtraProviderSegments(baseSegments, extraSegments) {
		return mergeProviderSegments(baseSegments || emptySegments(), extraSegments || emptySegments());
	}

	/**
	 * Extract a numeric Kitsu anime ID from a catalog / episode id.
	 *
	 * @param {string|null|undefined} value
	 * @returns {number|null}
	 */
	function extractKitsuId(value) {
		if (!value) return null;
		const match = String(value).match(/(?:^|:|\/|\\)kitsu:(\d+)/i);
		if (!match) return null;
		const id = Number(match[1]);
		return Number.isFinite(id) && id > 0 ? id : null;
	}

	/**
	 * Extract a MyAnimeList ID from meta links / ids when present.
	 *
	 * @param {object|null|undefined} meta
	 * @returns {number|null}
	 */
	function extractMalIdFromMeta(meta) {
		if (!meta) return null;
		const candidates = [meta.mal_id, meta.malId, meta.id];
		if (Array.isArray(meta.links)) {
			for (const link of meta.links) {
				candidates.push(link.url, link.name, link.id);
			}
		}
		if (Array.isArray(meta.extra)) {
			for (const item of meta.extra) {
				candidates.push(item.id, item.url, item.name);
			}
		}
		for (const candidate of candidates) {
			if (candidate == null) continue;
			const str = String(candidate);
			const malUrl = str.match(/myanimelist\.net\/anime\/(\d+)/i);
			if (malUrl) {
				const id = Number(malUrl[1]);
				if (Number.isFinite(id) && id > 0) return id;
			}
			const malPrefix = str.match(/(?:^|:|\/|\\)mal:(\d+)/i);
			if (malPrefix) {
				const id = Number(malPrefix[1]);
				if (Number.isFinite(id) && id > 0) return id;
			}
		}
		return null;
	}

	/**
	 * Call a shell-side AniSkip helper (bypasses browser CORS).
	 *
	 * @param {string} method
	 * @param {object} params
	 * @returns {Promise<*>}
	 */
	async function invokeAniSkipProxy(method, params) {
		const api = window.StremioCustomAPI || window.StremioEnhancedAPI;
		if (!api || typeof api.invoke !== "function") {
			throw new Error("AniSkip proxy is unavailable in this shell.");
		}
		return api.invoke(method, params);
	}

	/**
	 * Map the plugin segment type to IntroDB's submit enum.
	 *
	 * @param {string} segmentType Plugin segment type.
	 * @returns {string|null} IntroDB segment type or null when unsupported.
	 */
	function mapSegmentTypeToIntroDb(segmentType) {
		if (segmentType === "credits") return "outro";
		if (segmentType === "intro" || segmentType === "recap") return segmentType;
		return null;
	}

	/**
	 * Call the shell-side IntroDB proxy (bypasses browser CORS restrictions).
	 *
	 * @param {string} method Custom API method name.
	 * @param {object} params Request parameters.
	 * @returns {Promise<*>}
	 */
	async function invokeIntroDbProxy(method, params) {
		const api = window.StremioCustomAPI || window.StremioEnhancedAPI;
		if (!api || typeof api.invoke !== "function") {
			throw new Error("IntroDB proxy is unavailable in this shell.");
		}
		return api.invoke(method, params);
	}

	function parseSubmissionResponse(responseJson) {
		if (!responseJson || !Array.isArray(responseJson.submissions)) {
			return { ok: false, count: 0, statuses: [] };
		}
		const submissions = responseJson.submissions;
		const statuses = submissions.map((entry) => entry.status || entry.state || "unknown");
		return {
			ok: submissions.length > 0,
			count: submissions.length,
			statuses
		};
	}

	function formatSubmissionSuccessMessage(result, targetLabel) {
		const pending = result.statuses.filter((status) => String(status).toLowerCase() === "pending").length;
		if (pending > 0) {
			return `Submitted to ${targetLabel} (${pending} pending).`;
		}
		return `Timestamp submitted successfully to ${targetLabel}.`;
	}

	function formatCombinedSubmissionSuccessMessage(results) {
		const labels = results.map((entry) => entry.label).join(" and ");
		const pending = results.reduce((count, entry) => {
			return count + entry.statuses.filter((status) => String(status).toLowerCase() === "pending").length;
		}, 0);
		if (pending > 0) {
			return `Submitted to ${labels} (${pending} pending).`;
		}
		return `Timestamp submitted successfully to ${labels}.`;
	}

	function parseIntroDbSubmissionResponse(responseJson) {
		if (!responseJson || responseJson.ok !== true) {
			return { ok: false, statuses: [] };
		}
		const status = responseJson.submission?.status || "pending";
		return { ok: true, statuses: [status] };
	}

	function extractImdbId(value) {
		if (!value) return null;
		const str = String(value);
		const ttMatch = str.match(/tt\d{7,8}/i);
		if (ttMatch) return ttMatch[0].toLowerCase();
		const imdbPrefixMatch = str.match(/\bimdb(\d{7,8})\b/i);
		if (imdbPrefixMatch) return `tt${imdbPrefixMatch[1]}`;
		return null;
	}

	function collectImdbFromMeta(meta, seriesInfo, state) {
		const candidates = [];
		if (meta) {
			candidates.push(meta.imdb_id, meta.imdbId, meta.id);
			if (Array.isArray(meta.links)) {
				for (const link of meta.links) {
					candidates.push(link.url, link.name, link.id);
				}
			}
			if (Array.isArray(meta.extra)) {
				for (const item of meta.extra) {
					candidates.push(item.id, item.url, item.name);
				}
			}
		}
		if (seriesInfo) {
			candidates.push(seriesInfo.id, seriesInfo.imdb_id, seriesInfo.imdbId);
		}
		if (state) {
			const libraryMeta =
				state.libraryItem?.content ||
				state.libraryItem?.state?.meta ||
				state.libraryItem?.meta;
			if (libraryMeta) {
				candidates.push(libraryMeta.id, libraryMeta.imdb_id, libraryMeta.imdbId);
			}
			if (state.selected) {
				candidates.push(state.selected.id, state.selected.imdb_id, state.selected.imdbId);
			}
		}
		for (const candidate of candidates) {
			const imdbId = extractImdbId(candidate);
			if (imdbId) return imdbId;
		}
		return null;
	}

	function extractTmdbIdFromCatalogId(value) {
		if (!value) return null;
		const str = String(value);
		const prefixMatch = str.match(/(?:^|:|\/|\\)tmdb:(\d+)/i);
		if (prefixMatch && isValidTmdbId(prefixMatch[1])) {
			return Number(prefixMatch[1]);
		}
		return null;
	}

	function readExplicitTmdbId(value) {
		if (value == null || value === "") return null;
		if (isValidTmdbId(value)) return Number(value);
		return extractTmdbIdFromCatalogId(value);
	}

	function extractTmdbId(value) {
		return extractTmdbIdFromCatalogId(value);
	}

	function pickSeriesImdbId(seriesInfo, state) {
		const candidates = [];
		if (seriesInfo) {
			candidates.push(seriesInfo.id, seriesInfo.imdb_id, seriesInfo.imdbId);
		}
		if (state) {
			const libraryMeta =
				state.libraryItem?.content ||
				state.libraryItem?.state?.meta ||
				state.libraryItem?.meta;
			if (libraryMeta) {
				candidates.push(libraryMeta.id, libraryMeta.imdb_id, libraryMeta.imdbId);
			}
		}
		for (const candidate of candidates) {
			const imdbId = extractImdbId(candidate);
			if (imdbId) return imdbId;
		}
		return null;
	}

	function readTmdbIdField(value) {
		if (value == null || value === "") return null;
		return isValidTmdbId(value) ? Number(value) : null;
	}

	function isPlausibleSeason(value) {
		const season = Number(value);
		return Number.isInteger(season) && season >= 1 && season <= 250;
	}

	function isPlausibleEpisode(value) {
		const episode = Number(value);
		return Number.isInteger(episode) && episode >= 1 && episode <= 500;
	}

	function parseTvEpisodeId(episodeId) {
		const parts = String(episodeId || "").split(":");
		if (parts.length < 3) return null;

		if (parts[0].toLowerCase() === "tmdb" && parts.length >= 4) {
			const tmdbId = readTmdbIdField(parts[1]);
			const season = Number(parts[2]);
			const episode = Number(parts[3]);
			return {
				idPart: `tmdb:${parts[1]}`,
				tmdbId,
				season: isPlausibleSeason(season) ? season : null,
				episode: isPlausibleEpisode(episode) ? episode : null
			};
		}

		const season = Number(parts[1]);
		const episode = Number(parts[2]);
		return {
			idPart: parts[0],
			tmdbId: extractTmdbIdFromCatalogId(parts[0]),
			imdbId: extractImdbId(parts[0]),
			season: isPlausibleSeason(season) ? season : null,
			episode: isPlausibleEpisode(episode) ? episode : null
		};
	}

	function collectTmdbFromMeta(meta, seriesInfo, state, isTv) {
		const fieldValues = [];
		const catalogIds = [];

		const pushObject = (obj) => {
			if (!obj) return;
			fieldValues.push(obj.tmdb_id, obj.tmdbId);
			catalogIds.push(obj.id);
		};

		if (isTv && seriesInfo) {
			pushObject(seriesInfo);
		}
		if (meta) {
			pushObject(meta);
			if (Array.isArray(meta.links)) {
				for (const link of meta.links) {
					catalogIds.push(link.url, link.name, link.id);
				}
			}
			if (Array.isArray(meta.extra)) {
				for (const item of meta.extra) {
					catalogIds.push(item.id, item.url, item.name);
				}
			}
		}
		if (seriesInfo && !isTv) {
			pushObject(seriesInfo);
		}
		if (state) {
			const libraryMeta =
				state.libraryItem?.content ||
				state.libraryItem?.state?.meta ||
				state.libraryItem?.meta;
			pushObject(libraryMeta);
			pushObject(state.selected);
		}

		for (const value of fieldValues) {
			const tmdbId = readTmdbIdField(value);
			if (tmdbId) return tmdbId;
		}
		for (const value of catalogIds) {
			const tmdbId = extractTmdbIdFromCatalogId(value);
			if (tmdbId) return tmdbId;
		}
		return null;
	}

	function buildTvEpisodeId(seriesInfo, state, meta) {
		if (!seriesInfo || seriesInfo.season == null || seriesInfo.episode == null) {
			return null;
		}
		const seriesImdbId = pickSeriesImdbId(seriesInfo, state);
		const seriesTmdbId = collectTmdbFromMeta(meta, seriesInfo, state, true);
		const seriesPart =
			seriesImdbId ||
			(seriesTmdbId ? `tmdb:${seriesTmdbId}` : null) ||
			(meta && extractImdbId(meta.id)) ||
			(meta && extractTmdbIdFromCatalogId(meta.id) ? `tmdb:${extractTmdbIdFromCatalogId(meta.id)}` : null);
		if (!seriesPart) return null;
		return `${seriesPart}:${seriesInfo.season}:${seriesInfo.episode}`;
	}

	function isValidTmdbId(value) {
		const numeric = Number(value);
		return Number.isInteger(numeric) && numeric >= 1 && numeric <= 10000000;
	}

	function normalizeToggleValue(value) {
		return value !== false;
	}

	function getVideoDurationMs(video) {
		const playbackDuration = window.StremioCustomPlayback?.getDuration?.();
		if (Number.isFinite(playbackDuration) && playbackDuration > 0) {
			return Math.round(playbackDuration * 1000);
		}
		const durationSec = video && typeof video.duration === "number" ? video.duration : NaN;
		if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
		const durationMs = Math.round(durationSec * 1000);
		return durationMs > 0 ? durationMs : null;
	}

	function formatClockTime(seconds) {
		if (seconds == null || !Number.isFinite(seconds)) return "";
		const total = Math.max(0, Math.round(seconds * 1000) / 1000);
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = Math.floor(total % 60);
		if (h > 0) {
			return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
		}
		return `${m}:${String(s).padStart(2, "0")}`;
	}

	function parseTimeInput(value) {
		const raw = String(value || "").trim();
		if (!raw) return null;
		if (/^\d+(\.\d+)?$/.test(raw)) {
			return Math.max(0, parseFloat(raw));
		}
		const parts = raw.split(":").map((part) => Number(part));
		if (parts.some((part) => !Number.isFinite(part))) return null;
		if (parts.length === 2) return parts[0] * 60 + parts[1];
		if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
		return null;
	}

	function readTimeFromSeekBarDom() {
		const labels = document.querySelectorAll('[class*="seek-bar-container"] [class*="label"]');
		for (const label of labels) {
			const text = (label.textContent || "").trim();
			if (!/^\d/.test(text) || text.startsWith("-")) continue;
			const parsed = parseTimeInput(text);
			if (parsed != null && Number.isFinite(parsed)) return parsed;
		}
		return null;
	}

	function readDurationFromSeekBarDom() {
		const labels = Array.from(document.querySelectorAll('[class*="seek-bar-container"] [class*="label"]'));
		const times = labels
			.map((label) => parseTimeInput((label.textContent || "").trim()))
			.filter((value) => value != null && Number.isFinite(value));
		if (times.length >= 2) return Math.max(...times);
		return null;
	}

	function resolvePlaybackTimeSec() {
		const api = window.StremioCustomPlayback;
		const snap = api?.getMpvSnapshot?.();
		const domTime = readTimeFromSeekBarDom();

		if (snap?.timeFresh && Number.isFinite(snap.position)) {
			if (domTime != null && domTime > snap.position + 1.5) {
				return domTime;
			}
			return snap.position;
		}

		if (domTime != null) return domTime;

		const shimTime = api?.getCurrentTime?.();
		if (Number.isFinite(shimTime) && shimTime > 0) return shimTime;

		const video =
			api?.getVideo?.() ||
			document.querySelector('[class*="player-container"] video') ||
			document.querySelector("video");
		if (video && Number.isFinite(video.currentTime) && video.currentTime > 0) {
			return video.currentTime;
		}

		return Number.isFinite(shimTime) ? shimTime : 0;
	}

	function resolvePlaybackDurationSec() {
		const api = window.StremioCustomPlayback;
		const domDuration = readDurationFromSeekBarDom();
		const shimDuration = api?.getDuration?.();
		if (Number.isFinite(shimDuration) && shimDuration > 0) {
			if (domDuration != null && domDuration > shimDuration + 1) {
				return domDuration;
			}
			return shimDuration;
		}
		if (domDuration != null && domDuration > 0) return domDuration;
		const video =
			api?.getVideo?.() ||
			document.querySelector('[class*="player-container"] video') ||
			document.querySelector("video");
		if (video && Number.isFinite(video.duration) && video.duration > 0) {
			return video.duration;
		}
		return null;
	}

	function getContributeButtonTemplate() {
		const container = document.querySelector(
			'[class*="player-container"] [class*="control-bar-buttons-container"]'
		);
		if (!container) return null;
		return container.querySelector('[class*="control-bar-button"]:not([class*="menu"])');
	}

	function buildContributeIconSvg(className) {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "1.5");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		svg.setAttribute("aria-hidden", "true");
		if (className) {
			svg.setAttribute("class", className);
		}

		const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		circle.setAttribute("cx", "12");
		circle.setAttribute("cy", "12");
		circle.setAttribute("r", "9");
		svg.appendChild(circle);

		const handPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
		handPath.setAttribute("d", "M12 7v5l3 2");
		svg.appendChild(handPath);

		const sparkPath1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
		sparkPath1.setAttribute("d", "M16 3l2 2");
		svg.appendChild(sparkPath1);

		const sparkPath2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
		sparkPath2.setAttribute("d", "M18 5l-2 2");
		svg.appendChild(sparkPath2);

		return svg;
	}

	function replaceContributeIcon(button) {
		const iconWrap = button.querySelector('[class*="icon"]');
		const refSvg = button.querySelector("svg");
		const svgClass = refSvg?.getAttribute("class") || "";
		const svg = buildContributeIconSvg(svgClass);

		if (iconWrap) {
			iconWrap.replaceChildren(svg);
			return;
		}
		if (refSvg) {
			refSvg.replaceWith(svg);
			return;
		}
		button.appendChild(svg);
	}

	function isStaleContributeButton(button) {
		if (!button) return true;
		return !button.className.includes("control-bar-button");
	}

	function injectContributeStyles() {
		let style = document.getElementById(CONTRIBUTE_STYLE_ID);
		if (!style) {
			style = document.createElement("style");
			style.id = CONTRIBUTE_STYLE_ID;
			(document.head || document.documentElement).appendChild(style);
		}
		style.textContent = `
			#${CONTRIBUTE_BTN_ID} {
				display: flex !important;
				align-items: center !important;
				justify-content: center !important;
				margin: 0 !important;
				padding: 0 !important;
				flex: none !important;
			}
			#${CONTRIBUTE_BTN_ID} [class*="button-container"] {
				display: none !important;
			}
			#${CONTRIBUTE_BTN_ID} [class*="icon"],
			#${CONTRIBUTE_BTN_ID} svg {
				display: flex !important;
				align-items: center !important;
				justify-content: center !important;
				width: ${CONTRIBUTE_ICON_SIZE} !important;
				height: ${CONTRIBUTE_ICON_SIZE} !important;
				min-width: ${CONTRIBUTE_ICON_SIZE} !important;
				min-height: ${CONTRIBUTE_ICON_SIZE} !important;
				margin: 0 !important;
				padding: 0 !important;
				line-height: 0 !important;
			}
			#${CONTRIBUTE_BTN_ID} svg {
				flex: none !important;
				fill: none !important;
				stroke: currentColor !important;
				pointer-events: none !important;
			}
			#${CONTRIBUTE_PANEL_ID} {
				position: fixed;
				z-index: 2147483000;
				width: min(22rem, calc(100vw - 2rem));
				padding: 0.85rem 0.95rem 0.95rem;
				border-radius: 16px;
				border: 1px solid rgba(255, 255, 255, 0.14);
				background: rgba(42, 42, 46, 0.58);
				backdrop-filter: none;
				-webkit-backdrop-filter: none;
				box-shadow: 0 8px 32px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.18);
				color: #fff;
				font-family: inherit;
				font-size: 0.82rem;
				line-height: 1.35;
				display: none;
			}
			#${CONTRIBUTE_PANEL_ID}.open {
				display: block;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 0.5rem;
				margin-bottom: 0.65rem;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-title {
				font-size: 0.9rem;
				font-weight: 600;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-close {
				border: none;
				background: transparent;
				color: rgba(255, 255, 255, 0.75);
				font-size: 1.2rem;
				line-height: 1;
				cursor: pointer;
				padding: 0.15rem 0.35rem;
				border-radius: 8px;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-close:hover {
				background: rgba(255, 255, 255, 0.1);
				color: #fff;
			}
			#${CONTRIBUTE_PANEL_ID} label {
				display: block;
				font-size: 0.72rem;
				font-weight: 600;
				color: rgba(255, 255, 255, 0.72);
				margin-bottom: 0.3rem;
				text-transform: uppercase;
				letter-spacing: 0.04em;
			}
			#${CONTRIBUTE_PANEL_ID} select,
			#${CONTRIBUTE_PANEL_ID} input[type="text"] {
				width: 100%;
				box-sizing: border-box;
				border: 1px solid rgba(255, 255, 255, 0.14);
				border-radius: 10px;
				background: rgba(0, 0, 0, 0.28);
				color: #fff;
				padding: 0.45rem 0.55rem;
				font-size: 0.84rem;
				margin-bottom: 0.55rem;
				line-height: 1.2;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-segment-row {
				display: flex;
				flex-wrap: wrap;
				gap: 0.4rem;
				margin-bottom: 0.65rem;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-segment-row .tidb-contribute-chip {
				flex: 1 1 calc(50% - 0.25rem);
				min-width: 6.5rem;
				text-align: center;
				font-size: 0.82rem;
				font-weight: 600;
				color: #fff;
				background: rgba(255, 255, 255, 0.08);
				border: 1px solid rgba(255, 255, 255, 0.16);
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-segment-row .tidb-contribute-chip.active {
				background: rgba(255, 255, 255, 0.22);
				border-color: rgba(255, 255, 255, 0.42);
				box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-time-block {
				display: grid;
				gap: 0.55rem;
				margin-bottom: 0.55rem;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-time-input-row {
				display: flex;
				align-items: stretch;
				gap: 0.35rem;
				margin-bottom: 0.55rem;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-time-input-row input[type="text"] {
				flex: 1 1 auto;
				min-width: 0;
				width: auto;
				height: 2.2rem;
				margin-bottom: 0 !important;
				padding: 0 0.55rem;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-pm {
				flex: none;
				align-self: stretch;
				width: 2.2rem;
				height: 2.2rem;
				min-height: 2.2rem;
				padding: 0;
				margin: 0;
				border-radius: 10px;
				border: 1px solid rgba(255, 255, 255, 0.14);
				background: rgba(0, 0, 0, 0.28);
				color: rgba(255, 255, 255, 0.88);
				font-size: 1.05rem;
				font-weight: 600;
				line-height: 1;
				cursor: pointer;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				box-sizing: border-box;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-pm:hover {
				background: rgba(255, 255, 255, 0.12);
				border-color: rgba(255, 255, 255, 0.2);
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-chip-row {
				display: flex;
				flex-wrap: wrap;
				gap: 0.35rem;
				margin-bottom: 0.15rem;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-chip {
				border: 1px solid rgba(255, 255, 255, 0.14);
				background: rgba(255, 255, 255, 0.06);
				color: #fff;
				border-radius: 999px;
				padding: 0.28rem 0.62rem;
				font-size: 0.74rem;
				cursor: pointer;
				transition: background 0.15s ease, border-color 0.15s ease;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-chip:hover {
				background: rgba(255, 255, 255, 0.14);
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-chip.active {
				border-color: rgba(255, 255, 255, 0.45);
				background: rgba(255, 255, 255, 0.2);
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-mark-hint {
				font-size: 0.72rem;
				color: rgba(255, 217, 0, 0.9);
				margin: -0.2rem 0 0.35rem;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-status {
				font-size: 0.76rem;
				color: rgba(255, 255, 255, 0.78);
				margin-bottom: 0.55rem;
				min-height: 1rem;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-status.error {
				color: #ff8f8f;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-status.success {
				color: #9be49b;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-submit {
				width: 100%;
				border: none;
				border-radius: 12px;
				padding: 0.55rem 0.75rem;
				font-size: 0.84rem;
				font-weight: 600;
				cursor: pointer;
				color: #fff;
				background: rgba(255, 255, 255, 0.18);
				border: 1px solid rgba(255, 255, 255, 0.2);
				transition: background 0.15s ease;
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-submit:hover:not(:disabled) {
				background: rgba(255, 255, 255, 0.28);
			}
			#${CONTRIBUTE_PANEL_ID} .tidb-contribute-submit:disabled {
				opacity: 0.55;
				cursor: not-allowed;
			}
			html.${CONTRIBUTE_OVERLAY_LOCK_CLASS} [class*="player-container"] {
				cursor: default !important;
			}
			html.${CONTRIBUTE_OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="nav-bar-layer"],
			html.${CONTRIBUTE_OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="control-bar-layer"],
			html.${CONTRIBUTE_OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="menu-layer"],
			html.${CONTRIBUTE_OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="side-drawer-button-layer"],
			html.${CONTRIBUTE_OVERLAY_LOCK_CLASS} [class*="player-container"] [class*="seek-bar-container"] {
				opacity: 1 !important;
				visibility: visible !important;
				pointer-events: auto !important;
			}
			#${CONTRIBUTE_TOAST_ID} {
				position: fixed;
				left: 50%;
				bottom: 5.5rem;
				transform: translateX(-50%);
				z-index: 2147483646;
				max-width: min(28rem, calc(100vw - 2rem));
				padding: 0.7rem 1rem;
				border-radius: 12px;
				border: 1px solid rgba(255, 255, 255, 0.14);
				background: rgba(28, 28, 32, 0.95);
				color: #fff;
				font-size: 0.82rem;
				line-height: 1.4;
				box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
				display: none;
				pointer-events: none;
			}
			#${CONTRIBUTE_TOAST_ID}.visible {
				display: block;
			}
			#${CONTRIBUTE_TOAST_ID}.success {
				border-color: rgba(74, 222, 128, 0.45);
			}
			#${CONTRIBUTE_TOAST_ID}.error {
				border-color: rgba(248, 113, 113, 0.45);
			}
		`;
	}

	class IntroSkipPlugin {
		constructor() {
			this.video = null;
			this.episodeId = null;
			this.title = null;
			this.segments = emptySegments();
			this.activeSegment = null;
			this.displayedSegmentType = null;
			this.skipButtonTimeout = null;
			this.overlayObserver = null;
			this.userApiKey = "";
			this.introDbApiKey = "";
			this.useTheIntroDb = true;
			this.useIntroDb = true;
			this.useAniSkip = true;
			this.analyticsEnabled = true;
			this.theme = "glass";
			this.segmentButtonVisibility = Object.fromEntries(SEGMENT_TYPES.map((type) => [type, true]));
			this.onTimeUpdate = null;
			this.onSeekedHandler = null;
			this.onMouseMoveHandler = null;
			this.onLoadedMetadataHandler = null;
			this.settingsReady = this.initializeSettings();
			this._checkingPlayback = false;
			this._lastSeenUrl = null;
			this._lastStateContext = null;
			this._lastStateCheckAt = 0;
			this._lastVideoSource = null;
			this._lastFetchedDurationMs = null;
			this._checkTimer = null;
			this._observer = null;
			this._autoSkippedKeys = new Set();
			this._fetchGeneration = 0;
			this._segmentsLoadedEpisodeId = null;
			this.mediaImdbId = null;
			this.seriesImdbId = null;
			this.playbackSeason = null;
			this.playbackEpisode = null;
			this.resolvedTmdbId = null;
			this.contributePanelOpen = false;
			this.contributeMarkedStartSec = null;
			this.contributeSelectedSegment = "intro";
			this.contributeSubmitTarget = SUBMIT_TARGET_THEINTRODB;
			this.contributeSubmitting = false;
			this.contributeOutsideHandler = null;
			this.contributeKeyHandler = null;
			this.contributeDismissGuardUntil = 0;
			this.contributeFormDraft = null;
			this.contributeResumeOnClose = false;
			this.contributeOverlayTimer = null;
			this.contributeToastTimer = null;
			this.contributeUiWatcher = null;
			this.init();
		}

		init() {
			this.startDomObserver();
			this._checkTimer = setInterval(() => this.checkPlaybackChange(), 700);
			document.addEventListener("stremio-custom-route-change", () => {
				this._lastSeenUrl = null;
				setTimeout(() => {
					this.checkPlaybackChange();
					this.ensureContributeUi();
				}, 80);
			});
			this.checkPlaybackChange();
			this.settingsReady.then(() => this.loadSettings()).then(() => {
				this.ensureContributeUi();
				this.startContributeUiWatcher();
			}).catch(() => {});
		}

		startDomObserver() {
			if (this._observer || typeof MutationObserver === "undefined") return;
			this._observer = new MutationObserver(() => {
				if (!this.isOnPlayerRoute()) return;
				this.checkPlaybackChange();
			});
			this._observer.observe(document.body, {
				childList: true,
				subtree: true
			});
		}

		stopDomObserver() {
			if (!this._observer) return;
			this._observer.disconnect();
			this._observer = null;
		}

		/**
		 * @returns {boolean}
		 */
		isOverlayHidden() {
			const el = document.querySelector('[class*="player-container"]');
			if (!el) return false;
			for (const className of el.classList) {
				if (String(className).includes("overlayHidden")) return true;
			}
			return false;
		}

		startContributeUiWatcher() {
			if (this.contributeUiWatcher) return;
			this.contributeUiWatcher = window.setInterval(() => {
				if (!this.isOnPlayerRoute()) return;
				if (!this.hasAnySubmitApiKey()) return;
				if (this.isOverlayHidden()) return;
				this.ensureContributeUi();
			}, 1000);
		}

		stopContributeUiWatcher() {
			if (!this.contributeUiWatcher) return;
			window.clearInterval(this.contributeUiWatcher);
			this.contributeUiWatcher = null;
		}

		async initializeSettings() {
			const api = window.StremioCustomAPI || window.StremioEnhancedAPI;
			if (!api) {
				return;
			}

			if (window.__tidbSettingsRegistered) {
				return;
			}

			try {
				const schema = [{
						key: USE_THEINTRODB_SETTING,
						type: "toggle",
						label: "TheIntroDB",
						description:
							"Load intro, recap, credits, and preview segments from TheIntroDB. Disable to ignore this provider entirely.",
						defaultValue: true
					},
					{
						key: TIDB_API_KEY_SETTING,
						type: "input",
						label: "API Key",
						description:
							"Copy your full API key from theintrodb.org Docs/API (format: theintrodb:user_…:…). Required for TheIntroDB submissions.",
						defaultValue: ""
					},
					{
						key: USE_INTRODB_SETTING,
						type: "toggle",
						label: "IntroDB",
						description:
							"Load intro, recap, and credits segments from IntroDB. Disable to ignore this provider entirely.",
						defaultValue: true
					},
					{
						key: INTRODB_API_KEY_SETTING,
						type: "input",
						label: "API Key",
						description:
							"Copy your API key from introdb.app (format: idb_…). Required for IntroDB submissions.",
						defaultValue: ""
					},
					{
						key: USE_ANISKIP_SETTING,
						type: "toggle",
						label: "AniSkip",
						description:
							"Load opening/ending/recap skip times from AniSkip (best with Kitsu titles). Fetch-only — no submit.",
						defaultValue: true
					}
				];

				for (const segmentType of SEGMENT_TYPES) {
					schema.push({
						key: SEGMENT_BUTTON_SETTINGS[segmentType],
						type: "toggle",
						label: `Show ${capitalize(segmentType)} Button`,
						defaultValue: true
					});
				}

				schema.push({
					key: ANALYTICS_SETTING,
					type: "toggle",
					label: "Anonymous usage reporting",
					description: "Send anonymous feature usage events (e.g. button shown/clicked) to help improve the plugin. No media IDs or titles are sent.",
					defaultValue: true
				});

				await api.registerSettings(PLUGIN_ID, schema);
				window.__tidbSettingsRegistered = true;
				if (api.onSettingsSaved) {
					api.onSettingsSaved(PLUGIN_ID, () => {
						this.loadSettings().then(() => {
							this.ensureContributeUi();
							this.updateContributeSubmitTargetVisibility();
							if (this.isOnPlayerRoute() && this.episodeId) {
								this.fetchData().catch(() => {});
							}
						}).catch(() => {});
					});
				}
			} catch (err) {
				const message = err && err.message ? String(err.message) : "";
				if (message.includes("settings schema registered")) {
					window.__tidbSettingsRegistered = true;
					return;
				}
				console.warn(`${LOG_PREFIX} Failed to register settings:`, err);
			}
		}

		getSettingsApi() {
			return window.StremioCustomAPI || window.StremioEnhancedAPI || null;
		}

		getSetting(key) {
			const api = this.getSettingsApi();
			return api ? api.getSetting(PLUGIN_ID, key) : Promise.resolve(null);
		}

		getCrossPluginSetting(pluginId, key) {
			const api = this.getSettingsApi();
			return api ? api.getSetting(pluginId, key) : Promise.resolve(null);
		}

		async loadSettings() {
			const api = this.getSettingsApi();
			if (!api) return;

			this.theme = resolveThemeName();
			this.useTheIntroDb = normalizeToggleValue(await this.getSetting(USE_THEINTRODB_SETTING));
			this.useIntroDb = normalizeToggleValue(await this.getSetting(USE_INTRODB_SETTING));
			this.useAniSkip = normalizeToggleValue(await this.getSetting(USE_ANISKIP_SETTING));
			this.userApiKey = normalizeTheIntroDbApiKey(await this.getSetting(TIDB_API_KEY_SETTING));
			this.introDbApiKey = normalizeIntroDbApiKey(await this.getSetting(INTRODB_API_KEY_SETTING));
			this.analyticsEnabled = normalizeToggleValue(await this.getSetting(ANALYTICS_SETTING));
			if (this.analyticsEnabled) initAnalyticsOnce();

			const visibility = {};
			for (const [segmentType, settingKey] of Object.entries(SEGMENT_BUTTON_SETTINGS)) {
				visibility[segmentType] = normalizeToggleValue(await this.getSetting(settingKey));
			}
			this.segmentButtonVisibility = visibility;
			if (this.isOnPlayerRoute()) {
				this.ensureContributeUi();
			}
		}

		track(eventName, props) {
			if (!this.analyticsEnabled) return;
			initAnalyticsOnce();
			aptabaseTrackEvent(eventName, props);
		}

		isSegmentButtonEnabled(segmentType) {
			if (!this.segmentButtonVisibility || !(segmentType in this.segmentButtonVisibility)) {
				return true;
			}
			return this.segmentButtonVisibility[segmentType] !== false;
		}

		getPlaybackVideo() {
			return (
				window.StremioCustomPlayback?.getVideo?.() ||
				document.querySelector('[class*="player-container"] video') ||
				document.querySelector("video")
			);
		}

		findActiveSegment(currentTime, duration) {
			if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) {
				return null;
			}

			for (const segmentType of SEGMENT_TYPES) {
				const segmentList = this.segments[segmentType] || [];
				for (const segment of segmentList) {
					const end = segment.end != null ? segment.end : duration;
					if (currentTime >= segment.start && currentTime < end) {
						return {
							type: segmentType,
							start: segment.start,
							end
						};
					}
				}
			}

			return null;
		}

		getAutoSkipKey(seg) {
			return `${this.episodeId || "unknown"}:${seg.type}:${seg.start}`;
		}

		tryAutoSkip(video, seg) {
			if (seg.end == null || !Number.isFinite(seg.end)) {
				return false;
			}

			const skipKey = this.getAutoSkipKey(seg);
			if (this._autoSkippedKeys.has(skipKey)) {
				this.removeActiveButton();
				this.displayedSegmentType = null;
				return true;
			}

			if (this.getPlaybackCurrentTime(video) < seg.start || this.getPlaybackCurrentTime(video) >= seg.end) {
				return false;
			}

			video.currentTime = seg.end;
			this._autoSkippedKeys.add(skipKey);
			this.removeActiveButton();
			this.displayedSegmentType = null;
			console.log(`${LOG_PREFIX} Auto-skipped ${seg.type}: targetTime=${seg.end}`);
			this.track("auto_skip", {
				segment: seg.type
			});
			return true;
		}

		getPlaybackCurrentTime(video) {
			return resolvePlaybackTimeSec();
		}

		syncSkipButton() {
			const video = this.getPlaybackVideo();
			const duration = window.StremioCustomPlayback?.getDuration?.() || video?.duration;
			if (!video || !Number.isFinite(duration) || duration <= 0) {
				this.removeActiveButton();
				this.activeSegment = null;
				this.displayedSegmentType = null;
				return;
			}

			if (!this.episodeId || this._segmentsLoadedEpisodeId !== this.episodeId) {
				this.removeActiveButton();
				this.activeSegment = null;
				this.displayedSegmentType = null;
				return;
			}

			this.video = video;
			const currentTime = this.getPlaybackCurrentTime(video);
			let seg = this.findActiveSegment(currentTime, duration);
			this.activeSegment = seg;

			if (!seg) {
				this.removeActiveButton();
				this.displayedSegmentType = null;
				return;
			}

			if (this._autoSkippedKeys.has(this.getAutoSkipKey(seg))) {
				this.removeActiveButton();
				this.displayedSegmentType = null;
				return;
			}

			if (isAutoSkipEnabled(seg.type)) {
				if (this.tryAutoSkip(video, seg)) {
					const timeAfterSkip = this.getPlaybackCurrentTime(video);
					seg = this.findActiveSegment(timeAfterSkip, duration);
					this.activeSegment = seg;
					if (!seg || this._autoSkippedKeys.has(this.getAutoSkipKey(seg))) {
						this.removeActiveButton();
						this.displayedSegmentType = null;
						return;
					}
				}
			}

			if (!this.isSegmentButtonEnabled(seg.type)) {
				this.removeActiveButton();
				this.displayedSegmentType = null;
				return;
			}

			const existing = document.getElementById(ACTIVE_BTN_ID);
			if (existing && existing.getAttribute("data-segment-type") === seg.type) {
				return;
			}

			this.showSkipButton(seg);
			this.displayedSegmentType = seg.type;
		}

		startSegmentWatcher() {
			if (this.segmentWatcher) clearInterval(this.segmentWatcher);
			this.syncSkipButton();
			this.segmentWatcher = setInterval(() => {
				if (this.isOverlayHidden()) return;
				this.syncSkipButton();
			}, 300);
		}

		stopSegmentWatcher() {
			if (this.segmentWatcher) {
				clearInterval(this.segmentWatcher);
				this.segmentWatcher = null;
			}
		}

		hasTheIntroDbApiKey() {
			return Boolean(this.userApiKey);
		}

		hasIntroDbApiKey() {
			return Boolean(this.introDbApiKey);
		}

		isTheIntroDbServiceEnabled() {
			return this.useTheIntroDb !== false;
		}

		isIntroDbServiceEnabled() {
			return this.useIntroDb !== false;
		}

		isAniSkipServiceEnabled() {
			return this.useAniSkip !== false;
		}

		canLoadFromAnyProvider() {
			return (
				this.isTheIntroDbServiceEnabled() ||
				this.isIntroDbServiceEnabled() ||
				this.isAniSkipServiceEnabled()
			);
		}

		canSubmitToTheIntroDb() {
			return this.isTheIntroDbServiceEnabled() && this.hasTheIntroDbApiKey();
		}

		canSubmitToIntroDb() {
			return this.isIntroDbServiceEnabled() && this.hasIntroDbApiKey();
		}

		hasAnySubmitApiKey() {
			return this.canSubmitToTheIntroDb() || this.canSubmitToIntroDb();
		}

		canChooseSubmitTarget() {
			return this.canSubmitToTheIntroDb() && this.canSubmitToIntroDb();
		}

		/**
		 * Resolve the effective submit target from the panel selection and configured keys.
		 *
		 * @param {string} selectedValue Panel selection value.
		 * @returns {string|null} `theintrodb`, `introdb`, `both`, or null when no provider is available.
		 */
		resolveSubmitTarget(selectedValue) {
			if (this.canChooseSubmitTarget()) {
				if (selectedValue === SUBMIT_TARGET_INTRODB || selectedValue === SUBMIT_TARGET_BOTH) {
					return selectedValue;
				}
				return SUBMIT_TARGET_THEINTRODB;
			}
			if (this.canSubmitToTheIntroDb()) return SUBMIT_TARGET_THEINTRODB;
			if (this.canSubmitToIntroDb()) return SUBMIT_TARGET_INTRODB;
			return null;
		}

		isSegmentSupportedByIntroDb(segmentType) {
			return mapSegmentTypeToIntroDb(segmentType) != null;
		}

		getTidbHeaders() {
			const headers = {
				"User-Agent": PLUGIN_USER_AGENT
			};

			if (this.userApiKey) {
				headers.Authorization = `Bearer ${this.userApiKey}`;
			}

			return headers;
		}

		getIntroDbHeaders() {
			return {
				"User-Agent": PLUGIN_USER_AGENT,
				"X-API-Key": this.introDbApiKey,
				Accept: "application/json",
				"Content-Type": "application/json"
			};
		}

		async validateApiKey() {
			if (!this.userApiKey) return false;
			try {
				const res = await fetch(`${THEINTRODB_SERVER_URL}/user/stats`, {
					headers: {
						...this.getTidbHeaders(),
						Accept: "application/json"
					},
					credentials: "omit"
				});
				return res.ok;
			} catch (_) {
				return false;
			}
		}

		formatSubmitAuthError(apiMessage, provider) {
			const message = String(apiMessage || "").trim();
			if (provider === SUBMIT_TARGET_INTRODB) {
				if (message.toLowerCase().includes("invalid api key")) {
					return `${message}. ${formatIntroDbApiKeyHint()}`;
				}
				return message;
			}
			if (
				message.toLowerCase().includes("invalid or expired token") ||
				message.toLowerCase().includes("invalid api key") ||
				message.toLowerCase().includes("missing authorization")
			) {
				return `${message}. ${formatTheIntroDbApiKeyHint()}`;
			}
			return message;
		}

		getVideoSource(video) {
			return video ? (video.currentSrc || video.src || video.getAttribute("src") || null) : null;
		}

		extractTitleFromDocument() {
			const raw = document && document.title ? String(document.title).trim() : "";
			if (!raw) {
				return null;
			}
			const cleaned = raw.replace(/\s+-\s+Stremio.*$/i, "").trim();
			return cleaned || raw;
		}

		async resolvePlaybackContext(urlChanged, sourceChanged) {
			const now = Date.now();
			const routeIds = this.extractIdsFromPlayerRoute();
			const urlEpisodeId = routeIds && routeIds.episodeId ? routeIds.episodeId : this.extractEpisodeIdFromUrl();
			const parsedUrl = urlEpisodeId ? parseTvEpisodeId(urlEpisodeId) : null;
			const urlContext = urlEpisodeId
				? {
					episodeId: urlEpisodeId,
					title: this.extractTitleFromDocument(),
					imdbId: (routeIds && routeIds.imdbId) || extractImdbId(urlEpisodeId) || parsedUrl?.imdbId || null,
					season: parsedUrl?.season ?? null,
					episode: parsedUrl?.episode ?? null
				}
				: null;

			const shouldRefreshState = sourceChanged || urlChanged || now - this._lastStateCheckAt > 5000 || !this._lastStateContext;
			if (!shouldRefreshState && !urlChanged) {
				return this._lastStateContext || urlContext;
			}

			if (shouldRefreshState) {
				this._lastStateCheckAt = now;
				this._lastStateContext = await this.getPlaybackContextFromState();
			}

			return this._lastStateContext || urlContext;
		}

		isOnPlayerRoute() {
			return /#\/player/.test(window.location.href);
		}

		async checkPlaybackChange() {
			if (this._checkingPlayback) return;
			this._checkingPlayback = true;

			const video = this.getPlaybackVideo();
			try {
				if (!video) return;
				const currentUrl = window.location.href;
				const urlChanged = currentUrl !== this._lastSeenUrl;
				const videoChanged = video !== this.video;
				const currentVideoSource = this.getVideoSource(video);
				const sourceChanged = Boolean(currentVideoSource && currentVideoSource !== this._lastVideoSource);
				this._lastSeenUrl = currentUrl;
				this._lastVideoSource = currentVideoSource;

				const context = await this.resolvePlaybackContext(urlChanged, sourceChanged);
				const nextEpisodeId = context && context.episodeId ? context.episodeId : null;
				if (!nextEpisodeId) {
					if (this.isOnPlayerRoute()) {
						this.removeActiveButton();
						this.ensureContributeUi();
					} else {
						this.removeContributeUi();
					}
					return;
				}

				const episodeChanged = nextEpisodeId !== this.episodeId;
				if (episodeChanged || videoChanged || sourceChanged) {
					this.removeActiveButton();
				}
				if (!episodeChanged && !videoChanged && !urlChanged) {
					const durationMs = getVideoDurationMs(video);
					if (durationMs != null && durationMs !== this._lastFetchedDurationMs) {
						await this.fetchData();
					}
					if (!this.segmentWatcher && Object.values(this.segments).flat().length > 0) {
						this.startSegmentWatcher();
					}
					this.ensureContributeUi();
					return;
				}
				if (this.video || this.episodeId) this.cleanup();

				this.video = video;
				this.episodeId = nextEpisodeId;
				this.title = context.title || null;
				this.mediaImdbId = context.imdbId || extractImdbId(nextEpisodeId) || null;
				this.seriesImdbId = context.seriesImdbId || null;
				this.playbackSeason = context.season ?? null;
				this.playbackEpisode = context.episode ?? null;
				this.resolvedTmdbId = context.tmdbId || null;

				if (!this.onLoadedMetadataHandler) this.onLoadedMetadataHandler = () => this.checkPlaybackChange();
				this.video.removeEventListener("loadedmetadata", this.onLoadedMetadataHandler);
				this.video.addEventListener("loadedmetadata", this.onLoadedMetadataHandler);

				await this.settingsReady;
				this.loadSettings().catch(() => {});

				console.log(`${LOG_PREFIX} \nEpisode ID: ${this.episodeId}, \nTitle: ${this.title || "Unknown Title"}`);
				await this.fetchData();
				this.attachUiObservers();
				this.ensureContributeUi();
			} finally {
				this._checkingPlayback = false;
			}
		}

		extractEpisodeIdFromUrl() {
			const routeIds = this.extractIdsFromPlayerRoute();
			if (routeIds && routeIds.episodeId) {
				return routeIds.episodeId;
			}

			const url = window.location.href;
			let m = url.match(/\/detail\/series\/([^/?#]+)\/(\d+)\/(\d+)/);
			if (m) {
				const episodeId = `${m[1]}:${m[2]}:${m[3]}`;
				return episodeId;
			}
			m = url.match(/\/detail\/series\/([^/?#]+)/);
			if (m) {
				const s = url.match(/[?&]season=(\d+)/),
					e = url.match(/[?&]episode=(\d+)/);
				if (s && e) {
					const episodeId = `${m[1]}:${s[1]}:${e[1]}`;
					return episodeId;
				}
			}
			m = url.match(/\/detail\/movie\/([^/?#]+)/);
			if (m) {
				const episodeId = m[1].split(":")[0];
				return episodeId;
			}

			try {
				const decoded = decodeURIComponent(url);

				m = decoded.match(/\/series\/[^/]+\/([^/?#]+)/);
				if (m) {
					const parts = m[1].split(":");
					if (parts.length >= 3) {
						const episodeId = `${parts[0]}:${parts[1]}:${parts[2]}`;
						return episodeId;
					}
				}

				m = decoded.match(/\/movie\/([^/]+)\/([^/?#]+)/);
				if (m) {
					for (const candidate of [m[2], m[1]]) {
						if (!candidate) continue;
						const imdbMatch = String(candidate).match(/tt\d{7,8}/);
						if (imdbMatch) {
							return imdbMatch[0];
						}
						const raw = String(candidate).split(":")[0];
						if (/^\d+$/.test(raw)) {
							return raw;
						}
						if (raw) {
							return raw;
						}
					}
				}
			} catch (_) {}

			return null;
		}

		extractIdsFromPlayerRoute() {
			const sources = [
				window.location.hash || "",
				decodeURIComponent(window.location.hash || ""),
				window.location.href
			];
			for (const source of sources) {
				const tvMatch = source.match(/(tt\d{7,8})[:/](\d{1,3})[:/](\d{1,3})/i);
				if (tvMatch) {
					const imdbId = tvMatch[1].toLowerCase();
					return {
						episodeId: `${imdbId}:${tvMatch[2]}:${tvMatch[3]}`,
						imdbId
					};
				}
				const imdbMatch = source.match(/(tt\d{7,8})/i);
				if (imdbMatch) {
					const imdbId = imdbMatch[1].toLowerCase();
					return {
						episodeId: imdbId,
						imdbId
					};
				}
			}
			return null;
		}

		async getPlaybackContextFromState() {
			const state = await this.waitForPlayerState();
			const meta =
				state && state.metaItem && state.metaItem.content
					? state.metaItem.content
					: state && state.meta
						? state.meta
						: state && state.selected && state.selected.meta
							? state.selected.meta
							: null;
			if (!meta || !meta.id) return null;

			const seriesInfo = state.seriesInfo;
			const isTv = seriesInfo && seriesInfo.season != null && seriesInfo.episode != null;
			const episodeId = isTv
				? buildTvEpisodeId(seriesInfo, state, meta) || String(meta.id)
				: String(meta.id);

			let title = meta.name ? String(meta.name) : null;
			if (title && isTv) {
				title = `${title} S${String(seriesInfo.season).padStart(2, "0")}E${String(seriesInfo.episode).padStart(2, "0")}`;
			}

			const seriesImdbId = isTv ? pickSeriesImdbId(seriesInfo, state) : null;
			const imdbId = seriesImdbId || collectImdbFromMeta(meta, seriesInfo, state);
			const tmdbId = collectTmdbFromMeta(meta, seriesInfo, state, isTv);

			return {
				episodeId,
				title,
				imdbId,
				seriesImdbId,
				tmdbId,
				season: isTv ? Number(seriesInfo.season) : null,
				episode: isTv ? Number(seriesInfo.episode) : null
			};
		}

		async prepareSubmissionMediaContext(durationMs) {
			const stateContext = await this.getPlaybackContextFromState();
			if (stateContext) {
				if (stateContext.episodeId) this.episodeId = stateContext.episodeId;
				if (stateContext.imdbId) this.mediaImdbId = stateContext.imdbId;
				if (stateContext.seriesImdbId) this.seriesImdbId = stateContext.seriesImdbId;
				if (stateContext.title) this.title = stateContext.title;
				if (stateContext.season != null) this.playbackSeason = stateContext.season;
				if (stateContext.episode != null) this.playbackEpisode = stateContext.episode;
				if (stateContext.tmdbId && isValidTmdbId(stateContext.tmdbId)) {
					this.resolvedTmdbId = Number(stateContext.tmdbId);
				}
			}

			const routeIds = this.extractIdsFromPlayerRoute();
			if (routeIds && !stateContext) {
				if (routeIds.imdbId) {
					this.mediaImdbId = routeIds.imdbId;
					if (String(this.episodeId || "").split(":").length >= 3) {
						this.seriesImdbId = routeIds.imdbId;
					}
				}
				if (routeIds.episodeId) {
					this.episodeId = routeIds.episodeId;
					const parsedRoute = parseTvEpisodeId(routeIds.episodeId);
					if (parsedRoute?.season) this.playbackSeason = parsedRoute.season;
					if (parsedRoute?.episode) this.playbackEpisode = parsedRoute.episode;
				}
			} else if (routeIds && stateContext) {
				if (routeIds.imdbId && !this.seriesImdbId) {
					this.mediaImdbId = routeIds.imdbId;
					this.seriesImdbId = routeIds.imdbId;
				}
			}

			let media = this.parseMediaContext();
			if (!media) return null;

			let tmdbId = null;
			if (media.submissionImdbId || media.imdbId) {
				tmdbId = await this.fetchTmdbIdFromMediaApi(media, durationMs);
			}
			if (!tmdbId) {
				tmdbId = await this.fetchTmdbIdViaTmdbFind(
					media.submissionImdbId || media.imdbId,
					media.type
				);
			}
			if (!tmdbId && media.tmdbId && isValidTmdbId(media.tmdbId)) {
				const catalogPart = String(this.episodeId || "").split(":")[0];
				if (extractTmdbIdFromCatalogId(catalogPart)) {
					tmdbId = Number(media.tmdbId);
				}
			}
			if (tmdbId) {
				this.resolvedTmdbId = tmdbId;
				media = this.parseMediaContext();
			} else {
				this.resolvedTmdbId = null;
				media = this.parseMediaContext();
			}

			return media;
		}

		async fetchTmdbIdViaTmdbFind(imdbId, type) {
			if (!imdbId) return null;
			const api = this.getSettingsApi();
			let apiKey = null;
			if (api?.getApiKey) {
				apiKey = await api.getApiKey("tmdb");
			}
			if (!apiKey && api?.getSetting) {
				apiKey = await api.getSetting(PLUGIN_ID, "tmdbApiKey");
			}
			if (!apiKey) return null;
			try {
				const res = await fetch(
					`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id`,
					{ credentials: "omit" }
				);
				if (!res.ok) return null;
				const data = await res.json();
				if (type === "tv" && data.tv_results && data.tv_results[0] && isValidTmdbId(data.tv_results[0].id)) {
					return Number(data.tv_results[0].id);
				}
				if (type === "movie" && data.movie_results && data.movie_results[0] && isValidTmdbId(data.movie_results[0].id)) {
					return Number(data.movie_results[0].id);
				}
				if (data.tv_results && data.tv_results[0] && isValidTmdbId(data.tv_results[0].id)) {
					return Number(data.tv_results[0].id);
				}
				if (data.movie_results && data.movie_results[0] && isValidTmdbId(data.movie_results[0].id)) {
					return Number(data.movie_results[0].id);
				}
			} catch (_) {}
			return null;
		}

		parseTmdbIdFromMediaResponse(res) {
			if (res.status === 204) return null;
			if (!res.ok) return null;
			return res
				.text()
				.then((text) => {
					if (!text) return null;
					try {
						const json = JSON.parse(text);
						return isValidTmdbId(json.tmdb_id) ? Number(json.tmdb_id) : null;
					} catch (_) {
						return null;
					}
				})
				.catch(() => null);
		}

		async fetchTmdbIdFromMediaApi(media, durationMs) {
			if (!media) return null;
			const queryParams = new URLSearchParams();
			const lookupImdbId = media.submissionImdbId || media.imdbId;
			if (lookupImdbId) {
				queryParams.set("imdb_id", lookupImdbId);
			} else if (media.tmdbId && isValidTmdbId(media.tmdbId)) {
				queryParams.set("tmdb_id", String(media.tmdbId));
			} else {
				return null;
			}
			if (media.type === "tv") {
				queryParams.set("season", String(media.season));
				queryParams.set("episode", String(media.episode));
			}

			const durationAttempts = [];
			if (durationMs != null) durationAttempts.push(durationMs);
			durationAttempts.push(null);

			for (const attemptDuration of durationAttempts) {
				const params = new URLSearchParams(queryParams);
				if (attemptDuration != null) {
					params.set("duration_ms", String(attemptDuration));
				}
				try {
					const res = await fetch(`${THEINTRODB_SERVER_URL}/media?${params}`, {
						headers: this.getTidbHeaders()
					});
					const tmdbId = await this.parseTmdbIdFromMediaResponse(res);
					if (tmdbId) return tmdbId;
				} catch (_) {}
			}
			return null;
		}

		async waitForPlayerState() {
			for (let i = 0; i < 30; i++) {
				let state = null;
				if (window.core && typeof window.core.getState === "function") {
					try {
						state = await window.core.getState("player");
					} catch (_) {}
				}
				if (!state || !state.metaItem) {
					state = await this.evalInPage(
						"window.services && window.services.core && window.services.core.transport && window.services.core.transport.getState('player')"
					);
				}
				const meta =
					state && state.metaItem && state.metaItem.content
						? state.metaItem.content
						: state && state.meta
							? state.meta
							: state && state.selected && state.selected.meta
								? state.selected.meta
								: null;
				if (state && meta && meta.id) return state;
				await new Promise((resolve) => setTimeout(resolve, i < 8 ? 80 : 180));
			}
			return null;
		}

		evalInPage(js) {
			return new Promise((resolve) => {
				const event = "stremio-enhanced-" + Math.random().toString(36).slice(2);
				const script = document.createElement("script");

				window.addEventListener(event, (browserEvent) => {
					script.remove();
					resolve(browserEvent.detail);
				}, {
					once: true
				});

				script.textContent = `(async()=>{try{const out=await (${js});window.dispatchEvent(new CustomEvent("${event}",{detail:out}));}catch(err){console.error(err);window.dispatchEvent(new CustomEvent("${event}",{detail:null}));}})();`;

				document.head.appendChild(script);
			});
		}

		/**
		 * Fetch segment data from TheIntroDB for the current episode.
		 *
		 * @param {object} query Query parameters for `/media`.
		 * @returns {Promise<{segments: Record<string, Array<{start: number, end: number|null}>>, tmdbId: number|null}>}
		 */
		async fetchTheIntroDbSegments(query) {
			const params = new URLSearchParams();
			if (query.imdbId) {
				params.set("imdb_id", query.imdbId);
			} else if (query.tmdbId) {
				params.set("tmdb_id", String(query.tmdbId));
			} else {
				return { segments: emptySegments(), tmdbId: null };
			}
			if (query.isTvShow) {
				params.set("season", String(query.season));
				params.set("episode", String(query.episode));
			}
			if (query.durationMs != null) {
				params.set("duration_ms", String(query.durationMs));
			}

			const res = await fetch(`${THEINTRODB_SERVER_URL}/media?${params}`, {
				headers: this.getTidbHeaders()
			});

			if (res.status === 204 || res.status === 404 || !res.ok) {
				return { segments: emptySegments(), tmdbId: null };
			}

			const json = await res.json();
			const segments = emptySegments();
			for (const segmentType of SEGMENT_TYPES) {
				if (json[segmentType] && json[segmentType].length > 0) {
					segments[segmentType] = json[segmentType].map((segment) => ({
						start: segment.start_ms == null ? 0 : segment.start_ms / 1000,
						end: segment.end_ms == null ? null : segment.end_ms / 1000
					}));
				}
			}

			return {
				segments,
				tmdbId: isValidTmdbId(json.tmdb_id) ? Number(json.tmdb_id) : null
			};
		}

		/**
		 * Fetch segment data from IntroDB for the current TV episode.
		 *
		 * @param {string} imdbId Series IMDb ID.
		 * @param {number} season Season number.
		 * @param {number} episode Episode number.
		 * @returns {Promise<Record<string, Array<{start: number, end: number|null}>>>}
		 */
		async fetchIntroDbSegments(imdbId, season, episode) {
			if (!imdbId || !isPlausibleSeason(season) || !isPlausibleEpisode(episode)) {
				return emptySegments();
			}

			try {
				const json = await invokeIntroDbProxy("introdb-get-segments", {
					imdbId,
					season: Number(season),
					episode: Number(episode)
				});
				if (!json || typeof json !== "object") {
					return emptySegments();
				}

				const segments = emptySegments();
				const intro = segmentObjectToSeconds(json.intro);
				const recap = segmentObjectToSeconds(json.recap);
				const outro = segmentObjectToSeconds(json.outro);

				if (intro) segments.intro = [intro];
				if (recap) segments.recap = [recap];
				if (outro) segments.credits = [outro];

				return segments;
			} catch (error) {
				console.warn(`${LOG_PREFIX} IntroDB segment proxy failed:`, error);
				return emptySegments();
			}
		}

		/**
		 * Resolve a MAL ID for AniSkip (meta links → Kitsu mappings → Jikan title search).
		 *
		 * @param {object} options
		 * @param {string|null} options.episodeId
		 * @param {object|null} options.meta
		 * @param {string|null} options.title
		 * @returns {Promise<number|null>}
		 */
		async resolveMalIdForAniSkip(options) {
			const meta = options.meta || null;
			const fromMeta = extractMalIdFromMeta(meta);
			if (fromMeta) return fromMeta;

			const kitsuId =
				extractKitsuId(options.episodeId) ||
				extractKitsuId(meta && meta.id) ||
				extractKitsuId(this.seriesImdbId) ||
				null;
			if (kitsuId) {
				try {
					const payload = await invokeAniSkipProxy("aniskip-resolve-mal-kitsu", {
						kitsuId
					});
					const malId = Number(payload && payload.malId);
					if (Number.isFinite(malId) && malId > 0) return malId;
				} catch (error) {
					console.warn(`${LOG_PREFIX} Kitsu→MAL resolve failed:`, error);
				}
			}

			const title = String(options.title || (meta && meta.name) || this.title || "").trim();
			if (!title) return null;

			try {
				const payload = await invokeAniSkipProxy("aniskip-resolve-mal-jikan", { title });
				const malId = Number(payload && payload.malId);
				if (Number.isFinite(malId) && malId > 0) return malId;
			} catch (error) {
				console.warn(`${LOG_PREFIX} Jikan→MAL resolve failed:`, error);
			}

			try {
				const payload = await invokeAniSkipProxy("aniskip-resolve-mal-kitsu-title", {
					title
				});
				const malId = Number(payload && payload.malId);
				if (Number.isFinite(malId) && malId > 0) return malId;
			} catch (error) {
				console.warn(`${LOG_PREFIX} Kitsu-title→MAL resolve failed:`, error);
			}
			return null;
		}

		/**
		 * Fetch AniSkip segments (seconds) and map op/ed/recap into Intro Skip types.
		 *
		 * @param {number} malId
		 * @param {number} episode
		 * @param {number|null} [episodeLengthSecs]
		 * @returns {Promise<Record<string, Array<{start: number, end: number|null}>>>}
		 */
		async fetchAniSkipSegments(malId, episode, episodeLengthSecs) {
			if (!malId || !episode) return emptySegments();
			try {
				const params = { malId, episode };
				if (Number.isFinite(episodeLengthSecs) && episodeLengthSecs > 0) {
					params.episodeLength = episodeLengthSecs;
				}
				const payload = await invokeAniSkipProxy("aniskip-get-skip-times", params);
				const segments = emptySegments();
				if (!payload || payload.found !== true || !Array.isArray(payload.results)) {
					return segments;
				}
				for (const entry of payload.results) {
					const skipType = String(
						entry.skipType || entry.skip_type || ""
					).toLowerCase();
					const mapped = ANISKIP_TYPE_MAP[skipType];
					if (!mapped) continue;
					const interval = entry.interval || {};
					const start = Number(
						interval.startTime != null ? interval.startTime : interval.start_time
					);
					const end = Number(
						interval.endTime != null ? interval.endTime : interval.end_time
					);
					if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
					segments[mapped].push({ start, end });
				}
				return segments;
			} catch (error) {
				console.warn(`${LOG_PREFIX} AniSkip segment fetch failed:`, error);
				return emptySegments();
			}
		}

		async fetchData() {
			const video = this.video;
			const episodeId = this.episodeId;
			if (!video || !episodeId) {
				return null;
			}

			if (!this.canLoadFromAnyProvider()) {
				this.segments = emptySegments();
				this._segmentsLoadedEpisodeId = episodeId;
				this.stopSegmentWatcher();
				this.removeActiveButton();
				this.displayedSegmentType = null;
				this.activeSegment = null;
				console.log(`${LOG_PREFIX} All segment providers disabled for episode ${episodeId}`);
				return null;
			}

			const fetchGeneration = ++this._fetchGeneration;
			const parsedEpisode = parseTvEpisodeId(episodeId);
			const id = parsedEpisode?.idPart || String(episodeId).split(":")[0];
			const season =
				isPlausibleSeason(this.playbackSeason) ? this.playbackSeason : parsedEpisode?.season;
			const episode =
				isPlausibleEpisode(this.playbackEpisode) ? this.playbackEpisode : parsedEpisode?.episode;
			const isTvShow = isPlausibleSeason(season) && isPlausibleEpisode(episode);

			for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
				console.log(`${LOG_PREFIX} Fetching segments for episode ${episodeId} (attempt ${attempt})`);

				try {
					const imdbId =
						extractImdbId(id) ||
						this.seriesImdbId ||
						this.mediaImdbId ||
						extractImdbId(episodeId);
					const tmdbFromId = extractTmdbIdFromCatalogId(id);
					const durationMs = getVideoDurationMs(video);
					this._lastFetchedDurationMs = durationMs;

					const loadTheIntroDb =
						this.isTheIntroDbServiceEnabled() && Boolean(imdbId || tmdbFromId);
					const loadIntroDb = this.isIntroDbServiceEnabled() && isTvShow && imdbId;
					const loadAniSkip = this.isAniSkipServiceEnabled();

					if (!loadTheIntroDb && !loadIntroDb && !loadAniSkip) {
						console.warn(
							`${LOG_PREFIX} No provider can load for episode ${episodeId} (missing IMDB/TMDB and AniSkip off)`
						);
						return null;
					}

					const aniSkipEpisode =
						isPlausibleEpisode(episode)
							? episode
							: isPlausibleEpisode(this.playbackEpisode)
								? this.playbackEpisode
								: null;

					const [theIntroDbResult, introDbResult, aniSkipResult] = await Promise.allSettled([
						loadTheIntroDb
							? this.fetchTheIntroDbSegments({
								imdbId,
								tmdbId: tmdbFromId,
								isTvShow,
								season,
								episode,
								durationMs
							})
							: Promise.resolve({ segments: emptySegments(), tmdbId: null }),
						loadIntroDb
							? this.fetchIntroDbSegments(imdbId, season, episode)
							: Promise.resolve(emptySegments()),
						loadAniSkip && aniSkipEpisode
							? (async () => {
								const meta =
									(this._lastStateContext &&
										this._lastStateContext.metaItem &&
										this._lastStateContext.metaItem.content) ||
									null;
								const malId = await this.resolveMalIdForAniSkip({
									episodeId,
									meta,
									title: this.title
								});
								if (!malId) {
									console.log(`${LOG_PREFIX} AniSkip: could not resolve MAL id`);
									return emptySegments();
								}
								console.log(
									`${LOG_PREFIX} AniSkip: fetching MAL ${malId} episode ${aniSkipEpisode}`
								);
								const durationSecs =
									Number.isFinite(durationMs) && durationMs > 0
										? durationMs / 1000
										: null;
								return this.fetchAniSkipSegments(
									malId,
									aniSkipEpisode,
									durationSecs
								);
							})()
							: Promise.resolve(emptySegments())
					]);

					if (fetchGeneration !== this._fetchGeneration || this.episodeId !== episodeId) {
						return null;
					}

					const theIntroDbPayload =
						theIntroDbResult.status === "fulfilled"
							? theIntroDbResult.value
							: { segments: emptySegments(), tmdbId: null };
					const introDbSegments =
						introDbResult.status === "fulfilled" ? introDbResult.value : emptySegments();
					const aniSkipSegments =
						aniSkipResult.status === "fulfilled" ? aniSkipResult.value : emptySegments();

					if (theIntroDbPayload.tmdbId) {
						this.resolvedTmdbId = theIntroDbPayload.tmdbId;
					} else if (imdbId) {
						const resolved = await this.fetchTmdbIdViaTmdbFind(imdbId, isTvShow ? "tv" : "movie");
						if (resolved) this.resolvedTmdbId = resolved;
					}

					this.segments = mergeExtraProviderSegments(
						mergeProviderSegments(theIntroDbPayload.segments, introDbSegments),
						aniSkipSegments
					);

					for (const segmentType of SEGMENT_TYPES) {
						if (this.segments[segmentType].length > 0) {
							console.log(
								`${LOG_PREFIX} Loaded ${this.segments[segmentType].length} merged ${segmentType} segment(s)`
							);
						}
					}

					if (Object.values(this.segments).flat().length === 0) {
						console.log(`${LOG_PREFIX} No segment data found for episode ${episodeId}`);
					}

					this._segmentsLoadedEpisodeId = episodeId;
					this.waitAndHighlight();
					this.startSegmentWatcher();
					this.track("segments_loaded", {
						has_intro: this.segments.intro && this.segments.intro.length > 0,
						has_recap: this.segments.recap && this.segments.recap.length > 0,
						has_credits: this.segments.credits && this.segments.credits.length > 0,
						has_preview: this.segments.preview && this.segments.preview.length > 0,
						total: Object.values(this.segments).reduce((acc, list) => acc + (list ? list.length : 0), 0)
					});
					return null;
				} catch (err) {
					console.error(`${LOG_PREFIX} Error fetching segments for ${episodeId}:`, err);

					if (attempt < MAX_RETRIES) {
						await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
					} else {
						return null;
					}
				}
			}

			return null;
		}

		waitAndHighlight() {
			let tries = 50;
			const attempt = () => {
				if (!this.video || !this.video.duration) {
					const playbackDuration = window.StremioCustomPlayback?.getDuration?.();
					if (Number.isFinite(playbackDuration) && playbackDuration > 0) {
						this.highlightRangeOnBar();
						this.syncSkipButton();
						return;
					}
					if (tries-- > 0) setTimeout(attempt, 180);
					return;
				}
				this.highlightRangeOnBar();
				this.syncSkipButton();
				setTimeout(() => {
					this.highlightRangeOnBar();
					this.syncSkipButton();
				}, 250);
			};
			attempt();
		}

		getSeekSliderContainer() {
			const seekBar = document.querySelector('[class*="seek-bar-container"]');
			return seekBar?.querySelector('[class*="slider-container"]') || null;
		}

		getSeekTrack(slider) {
			const tracks = slider.querySelectorAll('[class*="track"]');
			for (let i = 0; i < tracks.length; i += 1) {
				const className = tracks[i].className || "";
				if (className.includes("track-before") || className.includes("track-after")) continue;
				return tracks[i];
			}
			return null;
		}

		clearVolumeIndicatorHighlights() {
			document
				.querySelectorAll('[class*="volume-change-indicator"] .segment-highlight')
				.forEach((highlight) => highlight.remove());
		}

		highlightRangeOnBar() {
			const slider = this.getSeekSliderContainer();
			if (!slider || !this.video || !this.video.duration) return;
			this.clearVolumeIndicatorHighlights();
			slider.querySelectorAll(".segment-highlight").forEach((highlight) => highlight.remove());

			const trackEl = this.getSeekTrack(slider) || slider.querySelector(".track-gItfW");
			if (!trackEl) return;

			const thumbEl = slider.querySelector(".thumb-PiTF5") || slider.querySelector('[class*="thumb-"]');
			const thumbLayer = thumbEl && thumbEl.parentNode;
			const duration = this.video.duration;

			for (const [segmentType, segmentList] of Object.entries(this.segments)) {
				for (const segment of segmentList) {
					const highlight = document.createElement("div");
					const startPct = (segment.start / duration) * 100;
					const segmentEnd = segment.end != null ? segment.end : duration;
					const rawWidthPct = ((segmentEnd - segment.start) / duration) * 100;
					const widthPct = Math.max(rawWidthPct, segmentType === "credits" ? 2.5 : segmentType === "intro" ? 2 : 0.8);
					let leftPct = startPct;
					if (leftPct + widthPct > 100) leftPct = Math.max(0, 100 - widthPct);

					highlight.className = `segment-highlight segment-${segmentType}`;
					Object.assign(highlight.style, {
						position: "absolute",
						top: "50%",
						left: `${leftPct}%`,
						width: `${widthPct}%`,
						minWidth: segmentType === "credits" ? "16px" : "6px",
						borderRadius: "4px",
						height: `${trackEl.clientHeight || 4}px`,
						transform: "translateY(-50%)",
						background: SEGMENT_COLORS[segmentType],
						pointerEvents: "none",
						zIndex: "1"
					});

					slider.insertBefore(highlight, thumbLayer && slider.contains(thumbLayer) ? thumbLayer : slider.firstChild);
				}
			}

			this.syncSkipButton();
		}

		ensureHighlightsPresent() {
			this.clearVolumeIndicatorHighlights();
			const slider = this.getSeekSliderContainer();
			if (!slider || !this.video || !this.video.duration) return;
			if (slider.querySelector(".segment-highlight")) return;
			if (Object.values(this.segments).flat().length === 0) return;
			this.highlightRangeOnBar();
		}

		attachUiObservers() {
			const playerContainer = this.getPlaybackVideo()?.closest('[class*="player-container"]');
			if (!playerContainer) return;

			if (this.overlayObserver) this.overlayObserver.disconnect();
			this.overlayObserver = new MutationObserver(() => {
				this.clearVolumeIndicatorHighlights();
				this.ensureHighlightsPresent();
				this.syncSkipButton();
				this.ensureContributeUi();
			});
			this.overlayObserver.observe(playerContainer, {
				attributes: true,
				attributeFilter: ["class"],
				childList: true,
				subtree: true
			});

			const seekBar = document.querySelector('[class*="seek-bar-container"]');
			if (seekBar) {
				if (this.seekBarObserver) this.seekBarObserver.disconnect();
				this.seekBarObserver = new MutationObserver(() => {
					this.ensureHighlightsPresent();
					this.syncSkipButton();
				});
				this.seekBarObserver.observe(seekBar, { childList: true, subtree: true });
			}
		}

		removeActiveButton() {
			document.getElementById(ACTIVE_BTN_ID)?.remove();
			document.querySelectorAll(".tidb-skip-btn").forEach((button) => button.remove());
			this.displayedSegmentType = null;
		}

		showSkipButton(segment) {
			const segmentType = segment.type;
			const theme = THEMES[this.theme] || THEMES.default;

			if (!this.isSegmentButtonEnabled(segmentType)) return;
			this.removeActiveButton();
			this.track("skip_button_shown", {
				segment: segmentType
			});

			const skipBtn = document.createElement("button");
			const icon = document.createElement("img");

			skipBtn.id = ACTIVE_BTN_ID;
			skipBtn.setAttribute("data-segment-type", segmentType);
			skipBtn.className = this.theme === "glass" || isLiquidGlassThemeActive()
				? "tidb-skip-btn tidb-theme-glass"
				: "tidb-skip-btn tidb-theme-default";
			skipBtn.textContent = SEGMENT_LABELS[segmentType] || "Skip Segment";

			icon.src = "https://www.svgrepo.com/show/471906/skip-forward.svg";
			icon.alt = "Skip icon";
			icon.width = theme.iconSize;
			icon.height = theme.iconSize;
			icon.style.filter = "brightness(0) invert(1)";
			icon.style.pointerEvents = "none";

			Object.assign(skipBtn.style, {
				position: "fixed",
				bottom: "140px",
				left: "max(24px, 8vw)",
				padding: theme.padding,
				background: theme.background,
				color: "#fff",
				border: theme.border,
				borderRadius: theme.borderRadius,
				cursor: "pointer",
				fontSize: theme.fontSize,
				zIndex: "2147483647",
				display: "flex",
				alignItems: "center",
				gap: "8px",
				opacity: "1",
				visibility: "visible",
				pointerEvents: "auto",
				transition: "background 0.2s ease, box-shadow 0.2s ease",
				backdropFilter: theme.backdropFilter,
				WebkitBackdropFilter: theme.backdropFilter,
				boxShadow: theme.boxShadow || "none"
			});

			skipBtn.prepend(icon);

			skipBtn.onmouseover = () => {
				skipBtn.style.background = theme.hover;
			};
			skipBtn.onmouseout = () => {
				skipBtn.style.background = theme.background;
			};
			skipBtn.onclick = (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.track("skip_clicked", {
					segment: segmentType
				});
				const video = this.getPlaybackVideo();
				if (video) {
					video.currentTime = segment.end;
					console.log(`${LOG_PREFIX} Skipping ${segmentType}: targetTime=${segment.end}`);
				}
				skipBtn.remove();
				this.displayedSegmentType = null;
			};

			document.body.appendChild(skipBtn);
		}

		getPlaybackTimeSec() {
			return resolvePlaybackTimeSec();
		}

		getPlaybackDurationSec() {
			return resolvePlaybackDurationSec();
		}

		parseMediaContext() {
			if (!this.episodeId) return null;
			const parsedEpisode = parseTvEpisodeId(this.episodeId);
			const id = parsedEpisode?.idPart || String(this.episodeId).split(":")[0];
			const season =
				isPlausibleSeason(this.playbackSeason) ? this.playbackSeason : parsedEpisode?.season;
			const episode =
				isPlausibleEpisode(this.playbackEpisode) ? this.playbackEpisode : parsedEpisode?.episode;
			const isTv = isPlausibleSeason(season) && isPlausibleEpisode(episode);

			const context = {
				type: isTv ? "tv" : "movie"
			};
			if (isTv) {
				context.season = Number(season);
				context.episode = Number(episode);
			}

			const itemImdbId =
				extractImdbId(id) ||
				parsedEpisode?.imdbId ||
				this.mediaImdbId ||
				extractImdbId(this.episodeId);
			const seriesImdbId = isTv ? this.seriesImdbId : null;
			const submissionImdbId = isTv && seriesImdbId ? seriesImdbId : itemImdbId;

			if (itemImdbId) {
				context.imdbId = itemImdbId;
			}
			if (submissionImdbId) {
				context.submissionImdbId = submissionImdbId;
			}

			const tmdbCandidate =
				this.resolvedTmdbId && isValidTmdbId(this.resolvedTmdbId)
					? Number(this.resolvedTmdbId)
					: parsedEpisode?.tmdbId || extractTmdbIdFromCatalogId(id);
			if (tmdbCandidate) {
				context.tmdbId = tmdbCandidate;
			}

			if (context.imdbId || context.tmdbId) {
				return context;
			}

			return null;
		}

		normalizeSubmissionTimes(segment, startSec, endSec, durationSec) {
			let start = startSec;
			let end = endSec;
			if (segment === "intro" || segment === "recap") {
				if (start == null || !Number.isFinite(start)) start = 0;
			}
			if (segment === "credits" || segment === "preview") {
				if (end == null || !Number.isFinite(end)) end = null;
			}
			if (start != null && end != null && Number.isFinite(start) && Number.isFinite(end) && end < start) {
				return { error: "End time must be after start time." };
			}
			if (durationSec != null && start != null && Number.isFinite(start) && start > durationSec) {
				return { error: "Start time is beyond the episode duration." };
			}
			return { start, end };
		}

		buildIntroDbSubmissionBody(segment, startSec, endSec, mediaContext, durationSec) {
			const media = mediaContext || this.parseMediaContext();
			if (!media) return null;

			const introDbSegment = mapSegmentTypeToIntroDb(segment);
			if (!introDbSegment) return null;
			if (media.type !== "tv") return null;

			const imdbId = media.submissionImdbId || media.imdbId;
			if (!imdbId) return null;
			if (!isPlausibleSeason(media.season) || !isPlausibleEpisode(media.episode)) {
				return null;
			}
			if (startSec == null || !Number.isFinite(startSec)) return null;

			let resolvedEndSec = endSec;
			if (
				(segment === "credits" || introDbSegment === "outro") &&
				(resolvedEndSec == null || !Number.isFinite(resolvedEndSec)) &&
				durationSec != null &&
				Number.isFinite(durationSec)
			) {
				resolvedEndSec = durationSec;
			}
			if (resolvedEndSec == null || !Number.isFinite(resolvedEndSec)) return null;

			const body = {
				segment_type: introDbSegment,
				imdb_id: imdbId,
				season: Number(media.season),
				episode: Number(media.episode),
				start_sec: startSec,
				end_sec: resolvedEndSec
			};
			if (media.tmdbId != null && isValidTmdbId(media.tmdbId)) {
				body.tmdb_id = Number(media.tmdbId);
			}
			return body;
		}

		buildSubmissionBody(segment, startSec, endSec, durationMs, mediaContext) {
			const media = mediaContext || this.parseMediaContext();
			if (!media) return null;
			const body = {
				type: media.type,
				segment,
				video_duration_ms: durationMs
			};
			if (media.imdbId) {
				body.imdb_id = media.submissionImdbId || media.imdbId;
			}
			if (media.tmdbId != null && isValidTmdbId(media.tmdbId)) {
				body.tmdb_id = Number(media.tmdbId);
			}
			if (!body.tmdb_id) return null;
			if (!body.imdb_id && !body.tmdb_id) return null;
			if (media.type === "tv") {
				if (!isPlausibleSeason(media.season) || !isPlausibleEpisode(media.episode)) {
					return null;
				}
				body.season = Number(media.season);
				body.episode = Number(media.episode);
			}
			if (startSec != null && Number.isFinite(startSec)) {
				body.start_ms = Math.round(startSec * 1000);
			}
			if (endSec != null && Number.isFinite(endSec)) {
				body.end_ms = Math.round(endSec * 1000);
			}
			return body;
		}

		ensureContributePanelOpen() {
			const panel = document.getElementById(CONTRIBUTE_PANEL_ID);
			if (!panel) return;
			panel.classList.add("open");
			this.contributePanelOpen = true;
		}

		hideContributeToast() {
			if (this.contributeToastTimer) {
				window.clearTimeout(this.contributeToastTimer);
				this.contributeToastTimer = null;
			}
			const toast = document.getElementById(CONTRIBUTE_TOAST_ID);
			if (!toast) return;
			toast.className = "";
			toast.textContent = "";
		}

		showContributeToast(message, kind) {
			if (!message) return;
			injectContributeStyles();
			let toast = document.getElementById(CONTRIBUTE_TOAST_ID);
			if (!toast) {
				toast = document.createElement("div");
				toast.id = CONTRIBUTE_TOAST_ID;
				document.body.appendChild(toast);
			}
			toast.textContent = message;
			toast.className = "visible" + (kind ? ` ${kind}` : "");
			if (this.contributeToastTimer) {
				window.clearTimeout(this.contributeToastTimer);
			}
			this.contributeToastTimer = window.setTimeout(() => {
				this.hideContributeToast();
			}, 5000);
		}

		setContributeStatus(message, kind) {
			if (kind === "success") {
				this.closeContributePanel();
				this.showContributeToast(message, kind);
			} else if (kind === "error") {
				this.ensureContributePanelOpen();
				this.showContributeToast(message, kind);
			}
			const panel = document.getElementById(CONTRIBUTE_PANEL_ID);
			if (!panel) return;
			const status = panel.querySelector(".tidb-contribute-status");
			if (!status) return;
			status.textContent = message || "";
			status.classList.remove("error", "success");
			if (kind) status.classList.add(kind);
		}

		/**
		 * Native player menus use `.menu-layer { right: 4rem }` (2.5rem in narrow portrait).
		 * @returns {number} inset in CSS pixels
		 */
		getNativeMenuRightInsetPx() {
			const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
			const narrowPortrait =
				window.matchMedia("(orientation: portrait) and (max-width: 640px)").matches;
			return Math.round((narrowPortrait ? 2.5 : 4) * rootFont);
		}

		/**
		 * Places the contribute panel above the seek bar, right-aligned like native menus.
		 */
		positionContributePanel() {
			const panel = document.getElementById(CONTRIBUTE_PANEL_ID);
			if (!panel) return;

			const panelWidth = panel.offsetWidth || 320;
			const panelHeight = panel.offsetHeight || 360;
			const margin = 14;
			const seekBar = document.querySelector('[class*="player-container"] [class*="seek-bar-container"]');
			const rightInset = this.getNativeMenuRightInsetPx();
			const left = Math.min(
				Math.max(margin, window.innerWidth - panelWidth - rightInset),
				window.innerWidth - panelWidth - margin
			);

			panel.style.left = `${left}px`;
			panel.style.right = "auto";

			if (seekBar) {
				const seekRect = seekBar.getBoundingClientRect();
				const top = seekRect.top - panelHeight - margin;
				if (top >= margin) {
					panel.style.top = `${top}px`;
					panel.style.bottom = "auto";
				} else {
					panel.style.top = `${margin}px`;
					panel.style.bottom = "auto";
				}
			} else {
				panel.style.top = "auto";
				panel.style.bottom = `${margin + 120}px`;
			}
		}

		sendMpvPause(paused) {
			if (!window.chrome?.webview?.postMessage) return;
			try {
				window.chrome.webview.postMessage(
					JSON.stringify({
						id: Date.now(),
						args: ["mpv-set-prop", ["pause", Boolean(paused)]]
					})
				);
			} catch (_) {}
		}

		shouldSuppressPlayerPointerEvent(event) {
			if (this.contributeDismissGuardUntil && Date.now() < this.contributeDismissGuardUntil) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				return true;
			}
			return false;
		}

		isContributeOutsidePointer(event) {
			const panelEl = document.getElementById(CONTRIBUTE_PANEL_ID);
			const btnEl = document.getElementById(CONTRIBUTE_BTN_ID);
			if (!this.contributePanelOpen || !panelEl) return false;
			const target = event.target;
			if (!(target instanceof Node)) return false;
			if (panelEl.contains(target) || (btnEl && btnEl.contains(target))) return false;
			return true;
		}

		handleContributeOutsidePointer(event) {
			if (this.shouldSuppressPlayerPointerEvent(event)) return;
			if (this.contributeSubmitting) return;
			if (!this.isContributeOutsidePointer(event)) return;

			this.contributeDismissGuardUntil = Date.now() + 500;
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			this.closeContributePanel();
		}

		pausePlaybackForContribute() {
			this.contributeResumeOnClose = true;
			const video = this.getPlaybackVideo();
			if (video && typeof video.pause === "function") {
				video.pause();
			} else {
				this.sendMpvPause(true);
			}
		}

		resumePlaybackForContribute() {
			if (!this.contributeResumeOnClose) return;
			this.contributeResumeOnClose = false;
			this.sendMpvPause(false);
		}

		lockPlayerOverlay() {
			document.documentElement.classList.add(CONTRIBUTE_OVERLAY_LOCK_CLASS);
			const playerContainer = document.querySelector('[class*="player-container"]');
			if (playerContainer) {
				playerContainer.classList.forEach((className) => {
					if (className.includes("overlayHidden")) {
						playerContainer.classList.remove(className);
					}
				});
			}
		}

		unlockPlayerOverlay() {
			document.documentElement.classList.remove(CONTRIBUTE_OVERLAY_LOCK_CLASS);
			this.stopContributeOverlayKeepAlive();
		}

		stopContributeOverlayKeepAlive() {
			if (this.contributeOverlayTimer) {
				window.clearInterval(this.contributeOverlayTimer);
				this.contributeOverlayTimer = null;
			}
			if (this.contributeOverlayObserver) {
				this.contributeOverlayObserver.disconnect();
				this.contributeOverlayObserver = null;
			}
		}

		startContributeOverlayKeepAlive() {
			this.stopContributeOverlayKeepAlive();
			if (!this.contributePanelOpen) return;
			this.lockPlayerOverlay();
			this.positionContributePanel();
			const playerContainer = document.querySelector('[class*="player-container"]');
			if (!playerContainer) return;
			this.contributeOverlayObserver = new MutationObserver(() => {
				if (!this.contributePanelOpen) {
					this.stopContributeOverlayKeepAlive();
					return;
				}
				this.lockPlayerOverlay();
				this.positionContributePanel();
			});
			this.contributeOverlayObserver.observe(playerContainer, {
				attributes: true,
				attributeFilter: ['class'],
			});
		}

		saveContributeFormDraft() {
			const fields = this.getContributePanelFields();
			if (!fields) return;
			this.contributeFormDraft = {
				segment: fields.segmentSelect.value,
				startValue: fields.startInput.value,
				endValue: fields.endInput.value,
				markedStartSec: this.contributeMarkedStartSec,
				submitTarget: fields.targetSelect ? fields.targetSelect.value : this.contributeSubmitTarget
			};
			this.contributeSelectedSegment = fields.segmentSelect.value;
		}

		restoreContributeFormDraft() {
			const fields = this.getContributePanelFields();
			if (!fields) return;
			if (this.contributeFormDraft) {
				fields.segmentSelect.value = this.contributeFormDraft.segment;
				fields.panel.querySelectorAll("[data-tidb-segment-value]").forEach((chip) => {
					chip.classList.toggle(
						"active",
						chip.getAttribute("data-tidb-segment-value") === this.contributeFormDraft.segment
					);
				});
				fields.startInput.value = this.contributeFormDraft.startValue;
				fields.endInput.value = this.contributeFormDraft.endValue;
				if (fields.targetSelect && this.contributeFormDraft.submitTarget) {
					fields.targetSelect.value = this.contributeFormDraft.submitTarget;
					fields.panel.querySelectorAll("[data-tidb-target-value]").forEach((chip) => {
						chip.classList.toggle(
							"active",
							chip.getAttribute("data-tidb-target-value") === this.contributeFormDraft.submitTarget
						);
					});
					this.contributeSubmitTarget = this.contributeFormDraft.submitTarget;
				}
				this.contributeSelectedSegment = this.contributeFormDraft.segment;
				this.contributeMarkedStartSec =
					this.contributeFormDraft.markedStartSec != null &&
					Number.isFinite(this.contributeFormDraft.markedStartSec)
						? this.contributeFormDraft.markedStartSec
						: null;
				this.refreshContributeMarkHint();
				return;
			}
			this.applyContributeDefaults(this.contributeSelectedSegment, { resetMarkedStart: true });
		}

		getContributePanelFields() {
			const panel = document.getElementById(CONTRIBUTE_PANEL_ID);
			if (!panel) return null;
			return {
				panel,
				targetRow: panel.querySelector("[data-tidb-target-row]"),
				targetSelect: panel.querySelector("[data-tidb-target]"),
				segmentSelect: panel.querySelector("[data-tidb-segment]"),
				startInput: panel.querySelector("[data-tidb-start]"),
				endInput: panel.querySelector("[data-tidb-end]"),
				markHint: panel.querySelector(".tidb-contribute-mark-hint"),
				submitBtn: panel.querySelector("[data-tidb-submit]")
			};
		}

		updateContributeSubmitTargetVisibility() {
			const fields = this.getContributePanelFields();
			if (!fields || !fields.targetRow || !fields.targetSelect) return;

			const canChoose = this.canChooseSubmitTarget();
			fields.targetRow.hidden = !canChoose;
			fields.targetRow.style.display = canChoose ? "" : "none";

			if (!canChoose) {
				fields.targetSelect.value = this.resolveSubmitTarget(fields.targetSelect.value) || SUBMIT_TARGET_THEINTRODB;
				this.contributeSubmitTarget = fields.targetSelect.value;
				return;
			}

			const current = fields.targetSelect.value || this.contributeSubmitTarget || SUBMIT_TARGET_THEINTRODB;
			fields.targetSelect.value = current;
			fields.panel.querySelectorAll("[data-tidb-target-value]").forEach((chip) => {
				chip.classList.toggle(
					"active",
					chip.getAttribute("data-tidb-target-value") === current
				);
			});
			this.contributeSubmitTarget = current;
		}

		refreshContributeMarkHint() {
			const fields = this.getContributePanelFields();
			if (!fields || !fields.markHint) return;
			if (this.contributeMarkedStartSec == null) {
				fields.markHint.textContent = "";
				return;
			}
			fields.markHint.textContent = `Start marked at ${formatClockTime(this.contributeMarkedStartSec)} — keep watching, then press "Set as end".`;
		}

		applyContributeDefaults(segmentType, options = {}) {
			const fields = this.getContributePanelFields();
			if (!fields) return;
			const resetMarkedStart = Boolean(options.resetMarkedStart);
			const current = this.getPlaybackTimeSec();
			const duration = this.getPlaybackDurationSec();
			if (segmentType === "intro" || segmentType === "recap") {
				fields.startInput.value = formatClockTime(0);
				fields.endInput.value = formatClockTime(current);
			} else {
				fields.startInput.value = formatClockTime(current);
				fields.endInput.value = duration != null ? formatClockTime(duration) : "";
			}
			if (resetMarkedStart) {
				this.contributeMarkedStartSec = null;
				this.refreshContributeMarkHint();
			}
		}

		openContributePanel() {
			if (this.contributePanelOpen) {
				this.positionContributePanel();
				return;
			}

			injectContributeStyles();
			let panel = document.getElementById(CONTRIBUTE_PANEL_ID);
			if (!panel) {
				panel = document.createElement("div");
				panel.id = CONTRIBUTE_PANEL_ID;
				panel.innerHTML = `
					<div class="tidb-contribute-header">
						<div class="tidb-contribute-title">Submit timestamp</div>
						<button type="button" class="tidb-contribute-close" data-tidb-close aria-label="Close">×</button>
					</div>
					<div class="tidb-contribute-target-row" data-tidb-target-row hidden>
						<label>Submit to</label>
						<div class="tidb-contribute-segment-row" role="tablist" aria-label="Submit target">
							<button type="button" class="tidb-contribute-chip active" data-tidb-target-value="theintrodb">TheIntroDB</button>
							<button type="button" class="tidb-contribute-chip" data-tidb-target-value="introdb">IntroDB</button>
							<button type="button" class="tidb-contribute-chip" data-tidb-target-value="both">Both</button>
						</div>
						<input type="hidden" data-tidb-target value="theintrodb" />
					</div>
					<label>Segment</label>
					<div class="tidb-contribute-segment-row" data-tidb-segment-row role="tablist" aria-label="Segment">
						<button type="button" class="tidb-contribute-chip active" data-tidb-segment-value="intro">Intro</button>
						<button type="button" class="tidb-contribute-chip" data-tidb-segment-value="recap">Recap</button>
						<button type="button" class="tidb-contribute-chip" data-tidb-segment-value="credits">Credits</button>
						<button type="button" class="tidb-contribute-chip" data-tidb-segment-value="preview">Preview</button>
					</div>
					<input type="hidden" id="tidb-contribute-segment" data-tidb-segment value="intro" />
					<div class="tidb-contribute-time-block">
						<div>
							<label for="tidb-contribute-start">Start time</label>
							<div class="tidb-contribute-time-input-row">
								<button type="button" class="tidb-contribute-pm" data-tidb-start-minus aria-label="Decrease start by 1 second">−</button>
								<input id="tidb-contribute-start" data-tidb-start type="text" placeholder="e.g. 0:00 or 90" />
								<button type="button" class="tidb-contribute-pm" data-tidb-start-plus aria-label="Increase start by 1 second">+</button>
							</div>
							<div class="tidb-contribute-chip-row">
								<button type="button" class="tidb-contribute-chip" data-tidb-start-current>Current position</button>
								<button type="button" class="tidb-contribute-chip" data-tidb-start-begin>Episode start</button>
								<button type="button" class="tidb-contribute-chip" data-tidb-mark-start>Mark start</button>
							</div>
						</div>
						<div>
							<label for="tidb-contribute-end">End time</label>
							<div class="tidb-contribute-time-input-row">
								<button type="button" class="tidb-contribute-pm" data-tidb-end-minus aria-label="Decrease end by 1 second">−</button>
								<input id="tidb-contribute-end" data-tidb-end type="text" placeholder="empty = until episode end" />
								<button type="button" class="tidb-contribute-pm" data-tidb-end-plus aria-label="Increase end by 1 second">+</button>
							</div>
							<div class="tidb-contribute-chip-row">
								<button type="button" class="tidb-contribute-chip" data-tidb-end-current>Current position</button>
								<button type="button" class="tidb-contribute-chip" data-tidb-end-finish>Episode end</button>
								<button type="button" class="tidb-contribute-chip" data-tidb-end-marked>Set as end</button>
							</div>
						</div>
					</div>
					<div class="tidb-contribute-mark-hint"></div>
					<div class="tidb-contribute-status"></div>
					<button type="button" class="tidb-contribute-submit" data-tidb-submit>Submit</button>
				`;
				document.body.appendChild(panel);

				panel.querySelector("[data-tidb-close]").addEventListener("click", () => this.closeContributePanel());
				panel.querySelectorAll("[data-tidb-target-value]").forEach((button) => {
					button.addEventListener("click", () => {
						const value = button.getAttribute("data-tidb-target-value");
						if (!value) return;
						const hidden = panel.querySelector("[data-tidb-target]");
						if (hidden) hidden.value = value;
						this.contributeSubmitTarget = value;
						panel.querySelectorAll("[data-tidb-target-value]").forEach((chip) => {
							chip.classList.toggle("active", chip === button);
						});
						this.saveContributeFormDraft();
					});
				});
				panel.querySelectorAll("[data-tidb-segment-value]").forEach((button) => {
					button.addEventListener("click", () => {
						const value = button.getAttribute("data-tidb-segment-value");
						if (!value) return;
						this.contributeSelectedSegment = value;
						const hidden = panel.querySelector("[data-tidb-segment]");
						if (hidden) hidden.value = value;
						panel.querySelectorAll("[data-tidb-segment-value]").forEach((chip) => {
							chip.classList.toggle("active", chip === button);
						});
						this.applyContributeDefaults(this.contributeSelectedSegment, { resetMarkedStart: true });
					});
				});
				/**
				 * Adjusts a contribute time input by ±1 second.
				 * @param {HTMLInputElement|null} input
				 * @param {number} deltaSec
				 */
				const nudgeTimeInput = (input, deltaSec) => {
					if (!input) return;
					const current = parseTimeInput(input.value);
					const base = current != null && Number.isFinite(current) ? current : 0;
					const next = Math.max(0, base + deltaSec);
					input.value = formatClockTime(next);
					this.saveContributeFormDraft();
				};
				panel.querySelector("[data-tidb-start-minus]")?.addEventListener("click", () => {
					nudgeTimeInput(this.getContributePanelFields()?.startInput, -1);
				});
				panel.querySelector("[data-tidb-start-plus]")?.addEventListener("click", () => {
					nudgeTimeInput(this.getContributePanelFields()?.startInput, 1);
				});
				panel.querySelector("[data-tidb-end-minus]")?.addEventListener("click", () => {
					nudgeTimeInput(this.getContributePanelFields()?.endInput, -1);
				});
				panel.querySelector("[data-tidb-end-plus]")?.addEventListener("click", () => {
					nudgeTimeInput(this.getContributePanelFields()?.endInput, 1);
				});
				panel.querySelector("[data-tidb-start-current]").addEventListener("click", () => {
					const fields = this.getContributePanelFields();
					if (fields) fields.startInput.value = formatClockTime(this.getPlaybackTimeSec());
				});
				panel.querySelector("[data-tidb-start-begin]").addEventListener("click", () => {
					const fields = this.getContributePanelFields();
					if (fields) fields.startInput.value = formatClockTime(0);
				});
				panel.querySelector("[data-tidb-mark-start]").addEventListener("click", () => {
					this.contributeMarkedStartSec = this.getPlaybackTimeSec();
					const fields = this.getContributePanelFields();
					if (fields) fields.startInput.value = formatClockTime(this.contributeMarkedStartSec);
					this.refreshContributeMarkHint();
					this.saveContributeFormDraft();
				});
				panel.querySelector("[data-tidb-end-current]").addEventListener("click", () => {
					const fields = this.getContributePanelFields();
					if (fields) fields.endInput.value = formatClockTime(this.getPlaybackTimeSec());
				});
				panel.querySelector("[data-tidb-end-finish]").addEventListener("click", () => {
					const duration = this.getPlaybackDurationSec();
					const fields = this.getContributePanelFields();
					if (!fields) return;
					fields.endInput.value = duration != null ? formatClockTime(duration) : "";
				});
				panel.querySelector("[data-tidb-end-marked]").addEventListener("click", () => {
					const fields = this.getContributePanelFields();
					if (!fields) return;
					fields.endInput.value = formatClockTime(this.getPlaybackTimeSec());
					if (this.contributeMarkedStartSec != null) {
						fields.startInput.value = formatClockTime(this.contributeMarkedStartSec);
					}
					this.contributeMarkedStartSec = null;
					this.refreshContributeMarkHint();
				});
				panel.querySelector("[data-tidb-submit]").addEventListener("click", () => {
					this.submitContributeTimestamp();
				});
			}

			this.restoreContributeFormDraft();
			this.updateContributeSubmitTargetVisibility();

			panel.classList.add("open");
			this.contributePanelOpen = true;
			this.setContributeStatus("");
			window.StremioCustomPlayback?.suppressAutoPlay?.();
			this.pausePlaybackForContribute();
			this.lockPlayerOverlay();
			this.startContributeOverlayKeepAlive();
			this.positionContributePanel();
			requestAnimationFrame(() => {
				if (this.contributePanelOpen) this.positionContributePanel();
			});

			if (!this.contributeOutsideHandler) {
				this.contributeOutsideHandler = (event) => {
					this.handleContributeOutsidePointer(event);
				};
				document.addEventListener("pointerdown", this.contributeOutsideHandler, true);
				document.addEventListener("mousedown", this.contributeOutsideHandler, true);
				document.addEventListener("click", this.contributeOutsideHandler, true);
			}
			if (!this.contributeKeyHandler) {
				this.contributeKeyHandler = (event) => {
					if (event.key === "Escape") this.closeContributePanel();
				};
				document.addEventListener("keydown", this.contributeKeyHandler);
			}
		}

		closeContributePanel() {
			const wasOpen = this.contributePanelOpen;
			if (this.contributePanelOpen) {
				this.saveContributeFormDraft();
			}
			const panel = document.getElementById(CONTRIBUTE_PANEL_ID);
			if (panel) panel.classList.remove("open");
			this.contributePanelOpen = false;
			this.resumePlaybackForContribute();
			this.unlockPlayerOverlay();
			if (wasOpen) {
				window.StremioCustomPlayback?.releaseAutoPlay?.();
			}
		}

		toggleContributePanel() {
			if (this.contributePanelOpen) {
				this.closeContributePanel();
			} else {
				this.openContributePanel();
			}
		}

		removeContributeUi() {
			this.hideContributeToast();
			this.closeContributePanel();
			this.resumePlaybackForContribute();
			this.unlockPlayerOverlay();
			document.getElementById(CONTRIBUTE_BTN_ID)?.remove();
			document.getElementById(CONTRIBUTE_PANEL_ID)?.remove();
			if (this.contributeOutsideHandler) {
				document.removeEventListener("pointerdown", this.contributeOutsideHandler, true);
				document.removeEventListener("mousedown", this.contributeOutsideHandler, true);
				document.removeEventListener("click", this.contributeOutsideHandler, true);
				this.contributeOutsideHandler = null;
			}
			if (this.contributeKeyHandler) {
				document.removeEventListener("keydown", this.contributeKeyHandler);
				this.contributeKeyHandler = null;
			}
			this.contributeFormDraft = null;
			this.contributeMarkedStartSec = null;
		}

		ensureContributeUi() {
			injectContributeStyles();
			if (!this.hasAnySubmitApiKey() || !this.isOnPlayerRoute()) {
				this.removeContributeUi();
				return;
			}

			const container = document.querySelector('[class*="player-container"] [class*="control-bar-buttons-container"]');
			if (!container) return;

			let button = document.getElementById(CONTRIBUTE_BTN_ID);
			if (button && isStaleContributeButton(button)) {
				button.remove();
				button = null;
			}
			if (!button) {
				const template = getContributeButtonTemplate();
				if (template) {
					button = template.cloneNode(true);
					button.classList.remove("disabled");
					button.removeAttribute("tabindex");
					button.querySelectorAll('[class*="button-container"]').forEach((el) => el.remove());
				} else {
					button = document.createElement("button");
					button.type = "button";
				}
				button.id = CONTRIBUTE_BTN_ID;
				button.classList.add(CONTRIBUTE_BTN_CLASS);
				button.title = "Submit intro timestamp";
				button.setAttribute("aria-label", "Submit intro timestamp");
				replaceContributeIcon(button);
				button.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					this.toggleContributePanel();
				});
				const menuButton = container.querySelector('[class*="control-bar-buttons-menu-button"]');
				if (menuButton) {
					container.insertBefore(button, menuButton);
				} else {
					container.appendChild(button);
				}
			}

			this.updateContributeSubmitTargetVisibility();

			if (this.contributePanelOpen) {
				this.positionContributePanel();
			}
		}

		async submitToTheIntroDb(segment, startSec, endSec, durationMs, mediaContext) {
			const body = this.buildSubmissionBody(segment, startSec, endSec, durationMs, mediaContext);
			if (!body) {
				const hasTmdbKey = Boolean(
					(this.getSettingsApi()?.getApiKey
						? await this.getSettingsApi().getApiKey("tmdb")
						: null) ||
						(await this.getSetting("tmdbApiKey"))
				);
				const badSeason =
					mediaContext &&
					mediaContext.type === "tv" &&
					(!isPlausibleSeason(mediaContext.season) || !isPlausibleEpisode(mediaContext.episode));
				return {
					ok: false,
					label: "TheIntroDB",
					message: badSeason
						? "Could not resolve season/episode for this title. Pause playback briefly and try again."
						: hasTmdbKey
							? "Could not resolve TMDB ID for this episode (required for TheIntroDB submit). Wait a moment and try again."
							: "Could not resolve TMDB ID. Add a TMDB API key in Settings > MyStremio > API Keys or use a Cinemeta/IMDB source."
				};
			}

			console.log(`${LOG_PREFIX} TheIntroDB submit payload:`, body);
			const res = await fetch(`${THEINTRODB_SERVER_URL}/submit`, {
				method: "POST",
				headers: {
					...this.getTidbHeaders(),
					"Content-Type": "application/json",
					Accept: "application/json"
				},
				credentials: "omit",
				body: JSON.stringify(body)
			});

			const responseText = await res.text();
			let responseJson = null;
			try {
				responseJson = responseText ? JSON.parse(responseText) : null;
			} catch (_) {}

			console.log(`${LOG_PREFIX} TheIntroDB submit response:`, res.status, responseJson || responseText);

			if (!res.ok) {
				const apiMessage = responseJson && (responseJson.message || responseJson.error);
				return {
					ok: false,
					label: "TheIntroDB",
					message: apiMessage
						? this.formatSubmitAuthError(apiMessage, SUBMIT_TARGET_THEINTRODB)
						: `TheIntroDB submission failed (${res.status}).`
				};
			}

			const submissionResult = parseSubmissionResponse(responseJson);
			if (!submissionResult.ok) {
				return {
					ok: false,
					label: "TheIntroDB",
					message: "TheIntroDB accepted the request but did not return a submission."
				};
			}

			return {
				ok: true,
				label: "TheIntroDB",
				statuses: submissionResult.statuses
			};
		}

		async submitToIntroDb(segment, startSec, endSec, mediaContext, durationSec) {
			const body = this.buildIntroDbSubmissionBody(segment, startSec, endSec, mediaContext, durationSec);
			if (!body) {
				if (segment === "preview") {
					return {
						ok: false,
						label: "IntroDB",
						message: "Preview segments can only be submitted to TheIntroDB."
					};
				}
				if (!mediaContext || mediaContext.type !== "tv") {
					return {
						ok: false,
						label: "IntroDB",
						message: "IntroDB submissions require a TV episode with a valid IMDb ID."
					};
				}
				return {
					ok: false,
					label: "IntroDB",
					message: "Could not build an IntroDB submission for this episode."
				};
			}

			console.log(`${LOG_PREFIX} IntroDB submit payload:`, body);
			let proxyResult;
			try {
				proxyResult = await invokeIntroDbProxy("introdb-submit", {
					apiKey: this.introDbApiKey,
					body
				});
			} catch (error) {
				console.error(`${LOG_PREFIX} IntroDB submit proxy failed:`, error);
				return {
					ok: false,
					label: "IntroDB",
					message: error && error.message
						? String(error.message)
						: "IntroDB submission failed due to a network error."
				};
			}

			const status = Number(proxyResult && proxyResult.status);
			const responseJson = proxyResult && proxyResult.body ? proxyResult.body : null;

			console.log(`${LOG_PREFIX} IntroDB submit response:`, status, responseJson);

			if (!Number.isFinite(status) || status < 200 || status >= 300) {
				const apiMessage = responseJson && (responseJson.message || responseJson.error);
				return {
					ok: false,
					label: "IntroDB",
					message: apiMessage
						? this.formatSubmitAuthError(apiMessage, SUBMIT_TARGET_INTRODB)
						: `IntroDB submission failed (${status || "unknown"}).`
				};
			}

			const submissionResult = parseIntroDbSubmissionResponse(responseJson);
			if (!submissionResult.ok) {
				return {
					ok: false,
					label: "IntroDB",
					message: "IntroDB accepted the request but did not return a submission."
				};
			}

			return {
				ok: true,
				label: "IntroDB",
				statuses: submissionResult.statuses
			};
		}

		async submitContributeTimestamp() {
			if (this.contributeSubmitting) return;

			const fields = this.getContributePanelFields();
			if (!fields) return;

			const submitTarget = this.resolveSubmitTarget(
				fields.targetSelect ? fields.targetSelect.value : this.contributeSubmitTarget
			);
			if (!submitTarget) {
				this.setContributeStatus(
					"Enable at least one provider and add its API key in the plugin settings.",
					"error"
				);
				return;
			}

			const wantsTheIntroDb =
				submitTarget === SUBMIT_TARGET_THEINTRODB || submitTarget === SUBMIT_TARGET_BOTH;
			let wantsIntroDb =
				submitTarget === SUBMIT_TARGET_INTRODB || submitTarget === SUBMIT_TARGET_BOTH;

			if (wantsTheIntroDb && !this.canSubmitToTheIntroDb()) {
				this.setContributeStatus(
					"TheIntroDB is disabled or missing an API key in the plugin settings.",
					"error"
				);
				return;
			}
			if (wantsIntroDb && !this.canSubmitToIntroDb()) {
				this.setContributeStatus(
					"IntroDB is disabled or missing an API key in the plugin settings.",
					"error"
				);
				return;
			}

			const segment = fields.segmentSelect.value;
			const durationSec = this.getPlaybackDurationSec();
			const durationMs = getVideoDurationMs(this.getPlaybackVideo());
			if (durationMs == null) {
				this.setContributeStatus("Episode duration not available yet — please wait a moment.", "error");
				return;
			}

			const startRaw = fields.startInput.value.trim();
			const endRaw = fields.endInput.value.trim();
			let startSec = startRaw ? parseTimeInput(startRaw) : null;
			let endSec = endRaw ? parseTimeInput(endRaw) : null;

			if (startRaw && startSec == null) {
				this.setContributeStatus("Invalid start time. Use seconds or mm:ss.", "error");
				return;
			}
			if (endRaw && endSec == null) {
				this.setContributeStatus("Invalid end time. Use seconds or mm:ss.", "error");
				return;
			}
			if ((segment === "intro" || segment === "recap") && (endSec == null || !Number.isFinite(endSec))) {
				this.setContributeStatus("Intro and recap require an end time.", "error");
				return;
			}
			if ((segment === "credits" || segment === "preview") && (startSec == null || !Number.isFinite(startSec))) {
				this.setContributeStatus("Credits and preview require a start time.", "error");
				return;
			}

			const normalized = this.normalizeSubmissionTimes(segment, startSec, endSec, durationSec);
			if (normalized.error) {
				this.setContributeStatus(normalized.error, "error");
				return;
			}
			startSec = normalized.start;
			endSec = normalized.end;

			if (wantsIntroDb && !this.isSegmentSupportedByIntroDb(segment)) {
				if (!wantsTheIntroDb) {
					this.setContributeStatus("Preview segments can only be submitted to TheIntroDB.", "error");
					return;
				}
				wantsIntroDb = false;
			}

			const mediaContext = await this.prepareSubmissionMediaContext(durationMs);
			if (!mediaContext || (!mediaContext.imdbId && !mediaContext.tmdbId)) {
				this.setContributeStatus(
					"Could not resolve a valid IMDB or TMDB ID for this title. Use a Cinemeta/IMDB-linked source.",
					"error"
				);
				return;
			}

			this.contributeSubmitting = true;
			fields.submitBtn.disabled = true;
			this.setContributeStatus("Submitting…");

			try {
				const results = [];
				const errors = [];

				if (wantsTheIntroDb) {
					const result = await this.submitToTheIntroDb(
						segment,
						startSec,
						endSec,
						durationMs,
						mediaContext
					);
					if (result.ok) {
						results.push(result);
					} else {
						errors.push(result.message);
					}
				}

				if (wantsIntroDb) {
					const result = await this.submitToIntroDb(
						segment,
						startSec,
						endSec,
						mediaContext,
						durationSec
					);
					if (result.ok) {
						results.push(result);
					} else {
						errors.push(result.message);
					}
				}

				if (results.length === 0) {
					this.setContributeStatus(errors[0] || "Submission failed.", "error");
					return;
				}

				this.track("timestamp_submitted", {
					segment,
					target: submitTarget
				});

				const successMessage =
					results.length === 1
						? formatSubmissionSuccessMessage(results[0], results[0].label)
						: formatCombinedSubmissionSuccessMessage(results);

				if (errors.length > 0) {
					this.setContributeStatus(`${successMessage} However: ${errors.join(" ")}`, "success");
				} else {
					this.setContributeStatus(successMessage, "success");
					this.contributeFormDraft = null;
					this.contributeMarkedStartSec = null;
					this.refreshContributeMarkHint();
				}
				await this.fetchData();
			} catch (error) {
				console.error(`${LOG_PREFIX} Submit failed:`, error);
				this.setContributeStatus("Network error while submitting.", "error");
			} finally {
				this.contributeSubmitting = false;
				fields.submitBtn.disabled = false;
			}
		}

		cleanup() {
			console.log(`${LOG_PREFIX} Cleaning up previous media...`);

			if (this.video && this.onLoadedMetadataHandler) {
				this.video.removeEventListener("loadedmetadata", this.onLoadedMetadataHandler);
			}

			this.stopSegmentWatcher();

			if (this.overlayObserver) {
				this.overlayObserver.disconnect();
				this.overlayObserver = null;
			}
			if (this.seekBarObserver) {
				this.seekBarObserver.disconnect();
				this.seekBarObserver = null;
			}
			this.removeActiveButton();
			this.removeContributeUi();
			this._fetchGeneration += 1;
			this._segmentsLoadedEpisodeId = null;
			if (this._autoSkippedKeys) {
				this._autoSkippedKeys.clear();
			}
			Object.assign(this, {
				video: null,
				episodeId: null,
				title: null,
				segments: emptySegments(),
				activeSegment: null,
				displayedSegmentType: null,
				_lastFetchedDurationMs: null,
				mediaImdbId: null,
				seriesImdbId: null,
				playbackSeason: null,
				playbackEpisode: null,
				resolvedTmdbId: null
			});
		}

		destroy() {
			this.removeContributeUi();
			this.cleanup();
			if (this._observer) {
				this._observer.disconnect();
				this._observer = null;
			}
			if (this._checkTimer) {
				clearInterval(this._checkTimer);
				this._checkTimer = null;
			}
		}
	}

	if (window.tidbPlugin && typeof window.tidbPlugin.destroy === "function") {
		window.tidbPlugin.destroy();
	}

	window.tidbPlugin = new IntroSkipPlugin();
	window.__stremioTidbSuspend = function () {
		try {
			const plugin = window.tidbPlugin;
			if (!plugin) return;
			plugin.closeContributePanel?.();
			plugin.unlockPlayerOverlay?.();
			plugin.stopContributeOverlayKeepAlive?.();
			plugin.cleanup?.();
			plugin.stopContributeUiWatcher?.();
			plugin.stopDomObserver?.();
			if (plugin.contributeOverlayTimer) {
				window.clearInterval(plugin.contributeOverlayTimer);
				plugin.contributeOverlayTimer = null;
			}
			if (plugin.contributeOverlayObserver) {
				plugin.contributeOverlayObserver.disconnect();
				plugin.contributeOverlayObserver = null;
			}
			if (plugin.segmentWatcher) {
				window.clearInterval(plugin.segmentWatcher);
				plugin.segmentWatcher = null;
			}
			if (plugin._checkTimer) {
				window.clearInterval(plugin._checkTimer);
				plugin._checkTimer = null;
			}
		} catch (_) {}
	};
	/**
	 * Hard unload for live disable — destroys instance so re-inject can recreate.
	 */
	window.__stremioTidbUnload = function () {
		try {
			window.__stremioTidbSuspend?.();
			if (window.tidbPlugin && typeof window.tidbPlugin.destroy === 'function') {
				window.tidbPlugin.destroy();
			}
		} catch (_) {}
		window.tidbPlugin = null;
	};
	document.addEventListener('stremio-custom-playback-stopped', () => {
		window.__stremioTidbSuspend?.();
	});
	document.addEventListener('stremio-custom-route-change', () => {
		if (!/#\/player/.test(location.hash || '')) {
			window.__stremioTidbSuspend?.();
			return;
		}
		const plugin = window.tidbPlugin;
		if (plugin && !plugin._checkTimer) {
			plugin._checkTimer = setInterval(() => plugin.checkPlaybackChange?.(), 700);
		}
		plugin?.startDomObserver?.();
		plugin?.startContributeUiWatcher?.();
	});
	if (!window.__tidbBeforeUnloadInstalled) {
		window.__tidbBeforeUnloadInstalled = true;
		window.addEventListener("beforeunload", () => {
			localStorage.removeItem("updateReminder");
		});
	}
})();