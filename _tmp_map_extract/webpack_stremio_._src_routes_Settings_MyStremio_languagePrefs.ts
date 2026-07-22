"use strict";
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeJsonList = exports.readJsonList = exports.sanitizeFavorites = exports.normalizeLanguageCode = exports.getLanguageOptions = exports.MAX_FAVORITES = exports.NONE_VALUE = exports.LANGUAGE_KEYS = void 0;
var common_1 = require("stremio/common");
exports.LANGUAGE_KEYS = {
    favAudio: 'stremio-custom-fav-audio',
    activeAudio: 'stremio-custom-active-audio',
    favSubs: 'stremio-custom-fav-subs',
    activeSubs: 'stremio-custom-active-subs',
};
var ISO2_TO_ISO3 = {
    de: 'ger',
    en: 'eng',
    ja: 'jpn',
    fr: 'fre',
    es: 'spa',
    it: 'ita',
    pt: 'por',
    ru: 'rus',
    ko: 'kor',
    zh: 'zho',
    ar: 'ara',
    nl: 'nld',
    pl: 'pol',
    tr: 'tur',
};
exports.NONE_VALUE = 'none';
exports.MAX_FAVORITES = 6;
var getLanguageOptions = function (includeNone) {
    var runtimeLanguageNames = (window.__stremioLanguageNames || {});
    var source = Object.keys(runtimeLanguageNames).length ? runtimeLanguageNames : common_1.languageNames;
    var options = Object.entries(source)
        .map(function (_a) {
        var code = _a[0], label = _a[1];
        return ({ code: code, label: String(label || code) });
    })
        .sort(function (a, b) { return a.label.localeCompare(b.label, 'de'); });
    return includeNone ? __spreadArray([{ code: exports.NONE_VALUE, label: 'None' }], options, true) : options;
};
exports.getLanguageOptions = getLanguageOptions;
var normalizeLanguageCode = function (rawCode) {
    if (typeof rawCode !== 'string')
        return null;
    var trimmed = rawCode.trim().toLowerCase();
    if (!trimmed)
        return null;
    if (trimmed === exports.NONE_VALUE)
        return exports.NONE_VALUE;
    var mapped = ISO2_TO_ISO3[trimmed] || trimmed;
    var knownCodes = new Set((0, exports.getLanguageOptions)(true).map(function (entry) { return entry.code; }));
    return knownCodes.has(mapped) ? mapped : null;
};
exports.normalizeLanguageCode = normalizeLanguageCode;
var sanitizeFavorites = function (list, allowNone) {
    if (allowNone === void 0) { allowNone = false; }
    var seen = new Set();
    var result = [];
    for (var _i = 0, list_1 = list; _i < list_1.length; _i++) {
        var entry = list_1[_i];
        var code = (0, exports.normalizeLanguageCode)(entry);
        if (!code)
            continue;
        if (!allowNone && code === exports.NONE_VALUE)
            continue;
        if (seen.has(code))
            continue;
        seen.add(code);
        result.push(code);
        if (result.length >= exports.MAX_FAVORITES)
            break;
    }
    return result;
};
exports.sanitizeFavorites = sanitizeFavorites;
var readJsonList = function (key, allowNone) {
    if (allowNone === void 0) { allowNone = false; }
    try {
        var raw = localStorage.getItem(key);
        var parsed = raw ? JSON.parse(raw) : [];
        return (0, exports.sanitizeFavorites)(Array.isArray(parsed) ? parsed : [], allowNone);
    }
    catch (_a) {
        return [];
    }
};
exports.readJsonList = readJsonList;
var writeJsonList = function (key, list, allowNone) {
    var _a, _b, _c;
    if (allowNone === void 0) { allowNone = false; }
    var cleaned = (0, exports.sanitizeFavorites)(list, allowNone);
    if (cleaned.length)
        localStorage.setItem(key, JSON.stringify(cleaned));
    else
        localStorage.removeItem(key);
    try {
        document.dispatchEvent(new CustomEvent('stremio-custom-language-prefs-changed'));
        (_c = (_b = (_a = window.StremioCustom) === null || _a === void 0 ? void 0 : _a.helpers) === null || _b === void 0 ? void 0 : _b.persistUserPreferences) === null || _c === void 0 ? void 0 : _c.call(_b);
    }
    catch (_d) {
        // ignore
    }
    return cleaned;
};
exports.writeJsonList = writeJsonList;
