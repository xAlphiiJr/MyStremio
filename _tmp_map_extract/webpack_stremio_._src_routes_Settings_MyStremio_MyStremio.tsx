"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = __importStar(require("react"));
var components_1 = require("stremio/components");
var components_2 = require("../components");
var CollapsibleDropdown_1 = __importDefault(require("./CollapsibleDropdown"));
var MyStremio_less_1 = __importDefault(require("./MyStremio.less"));
var PRELOAD_OPTIONS = [
    { value: '10', label: 'Standard (10s)' },
    { value: '60', label: 'Extended (60s)' },
    { value: '120', label: 'Extreme (120s)' },
    { value: 'full', label: 'Full (entire stream)' },
];
var PRELOAD_SECS_KEY = 'stremio-custom-preload-secs';
var DISCORD_KEYS = {
    enabled: 'stremio-custom-discord-rp-enabled',
    showPaused: 'stremio-custom-discord-rp-show-paused',
    showMenu: 'stremio-custom-discord-rp-show-menu',
};
var PLUGIN_CATEGORIES = [
    { id: 'player', label: 'Player' },
    { id: 'interface', label: 'Interface' },
    { id: 'metadata', label: 'Metadata' },
    { id: 'addons', label: 'Addons' },
    { id: 'utilities', label: 'Utilities' },
];
var API_KEY_FIELD_LINKS = {
    tmdbApiKey: { label: 'TMDB', url: 'https://www.themoviedb.org/settings/api' },
    rpdbApiKey: { label: 'RPDB', url: 'https://ratingposterdb.com/api-key/' },
    tidb_api_key: { label: 'TheIntroDB', url: 'https://theintrodb.org/docs' },
};
var safeString = function (value, fallback) {
    if (fallback === void 0) { fallback = ''; }
    if (typeof value === 'string')
        return value;
    if (value == null)
        return fallback;
    return String(value);
};
var isSecretSettingField = function (field) {
    var key = String(field.key || '').toLowerCase();
    return key.includes('apikey') || key.includes('api_key') || key.endsWith('token');
};
var getApiKeyLinkForField = function (field) {
    if (field.type !== 'input' || !isSecretSettingField(field))
        return null;
    var mapped = API_KEY_FIELD_LINKS[field.key];
    if (!mapped)
        return null;
    return __assign({ key: field.key }, mapped);
};
var readBoolean = function (key, fallback) {
    try {
        var value = localStorage.getItem(key);
        if (value == null)
            return fallback;
        return value === 'true';
    }
    catch (_a) {
        return fallback;
    }
};
var parsePluginBaseName = function (fileRef) { var _a; return ((_a = String(fileRef || '').replace(/\\/g, '/').split('/').pop()) === null || _a === void 0 ? void 0 : _a.replace(/\.plugin\.js$/i, '')) || ''; };
var parsePluginCategory = function (fileRef, metadata) {
    var metadataCategory = String((metadata === null || metadata === void 0 ? void 0 : metadata.category) || '').toLowerCase();
    if (metadataCategory)
        return metadataCategory;
    var parts = String(fileRef || '').replace(/\\/g, '/').split('/');
    return String(parts[0] || 'utilities').toLowerCase();
};
var normalizeLibraryFolders = function (foldersRaw) {
    var parsed = [];
    try {
        var value = typeof foldersRaw === 'string' ? JSON.parse(foldersRaw) : foldersRaw;
        parsed = Array.isArray(value) ? value : [];
    }
    catch (_a) {
        parsed = [];
    }
    return parsed
        .map(function (folder) {
        var id = safeString(folder === null || folder === void 0 ? void 0 : folder.id).trim();
        var name = safeString(folder === null || folder === void 0 ? void 0 : folder.name).trim();
        if (!id || !name)
            return null;
        var items = Array.isArray(folder === null || folder === void 0 ? void 0 : folder.items)
            ? folder.items.map(function (item) { return safeString(item).trim(); }).filter(Boolean)
            : [];
        return { id: id, name: name, items: items };
    })
        .filter(Boolean);
};
var getBridge = function () {
    var scopedWindow = window;
    if (!scopedWindow.StremioCustomAPI || !scopedWindow.StremioCustom)
        return null;
    return {
        api: scopedWindow.StremioCustomAPI,
        helpers: scopedWindow.StremioCustom.helpers || {},
        plugins: scopedWindow.StremioCustom.plugins || {},
    };
};
var MyStremio = (0, react_1.forwardRef)(function (_, ref) {
    var _a = (0, react_1.useState)(true), loading = _a[0], setLoading = _a[1];
    var _b = (0, react_1.useState)(null), error = _b[0], setError = _b[1];
    var _c = (0, react_1.useState)(''), pluginsPath = _c[0], setPluginsPath = _c[1];
    var _d = (0, react_1.useState)([]), plugins = _d[0], setPlugins = _d[1];
    var _e = (0, react_1.useState)([]), enabledPlugins = _e[0], setEnabledPlugins = _e[1];
    var _f = (0, react_1.useState)({}), openPluginGroups = _f[0], setOpenPluginGroups = _f[1];
    var _g = (0, react_1.useState)({}), openPluginSettings = _g[0], setOpenPluginSettings = _g[1];
    var _h = (0, react_1.useState)('10'), preload = _h[0], setPreload = _h[1];
    var _j = (0, react_1.useState)(false), discordEnabled = _j[0], setDiscordEnabled = _j[1];
    var _k = (0, react_1.useState)(true), discordShowPaused = _k[0], setDiscordShowPaused = _k[1];
    var _l = (0, react_1.useState)(true), discordShowMenu = _l[0], setDiscordShowMenu = _l[1];
    var _m = (0, react_1.useState)(false), discordOpen = _m[0], setDiscordOpen = _m[1];
    var _o = (0, react_1.useState)({
        foldersRaw: '[]',
        activeFolderId: '',
    }), library = _o[0], setLibrary = _o[1];
    var bridgeRef = (0, react_1.useRef)(null);
    var inputTimersRef = (0, react_1.useRef)({});
    var pluginToggleBusyRef = (0, react_1.useRef)(false);
    var refreshFromBridge = (0, react_1.useCallback)(function () { return __awaiter(void 0, void 0, void 0, function () {
        var bridge, paths, pluginFiles, nextPlugins, _i, pluginFiles_1, fileRef, metadata, baseName, schemaRaw, schema, config, fetchError_1;
        var _a, _b, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    bridge = getBridge();
                    if (!bridge) {
                        setError('MyStremio bridge is not available yet.');
                        setLoading(false);
                        return [2 /*return*/];
                    }
                    bridgeRef.current = bridge;
                    setError(null);
                    _e.label = 1;
                case 1:
                    _e.trys.push([1, 10, 11, 12]);
                    return [4 /*yield*/, bridge.api.getPaths()];
                case 2:
                    paths = _e.sent();
                    return [4 /*yield*/, bridge.api.listPlugins()];
                case 3:
                    pluginFiles = _e.sent();
                    nextPlugins = [];
                    _i = 0, pluginFiles_1 = pluginFiles;
                    _e.label = 4;
                case 4:
                    if (!(_i < pluginFiles_1.length)) return [3 /*break*/, 9];
                    fileRef = pluginFiles_1[_i];
                    return [4 /*yield*/, bridge.api.getMetadata(fileRef)];
                case 5:
                    metadata = (_e.sent()) || {};
                    baseName = parsePluginBaseName(fileRef);
                    return [4 /*yield*/, bridge.api.getRegisteredSettings(baseName)];
                case 6:
                    schemaRaw = _e.sent();
                    schema = Array.isArray(schemaRaw) ? schemaRaw : [];
                    return [4 /*yield*/, bridge.api.getPluginConfig(baseName)];
                case 7:
                    config = (_e.sent()) || {};
                    nextPlugins.push({
                        fileRef: fileRef,
                        baseName: baseName,
                        category: parsePluginCategory(fileRef, metadata),
                        label: safeString(metadata.name, fileRef),
                        version: safeString(metadata.version),
                        author: safeString(metadata.author),
                        schema: schema,
                        config: config,
                    });
                    _e.label = 8;
                case 8:
                    _i++;
                    return [3 /*break*/, 4];
                case 9:
                    setPluginsPath(safeString(paths === null || paths === void 0 ? void 0 : paths.pluginsPath));
                    setPlugins(nextPlugins);
                    setEnabledPlugins(((_b = (_a = bridge.helpers).getEnabledPlugins) === null || _b === void 0 ? void 0 : _b.call(_a)) || []);
                    setPreload(safeString(localStorage.getItem(PRELOAD_SECS_KEY) || '10'));
                    setDiscordEnabled(readBoolean(DISCORD_KEYS.enabled, false));
                    setDiscordShowPaused(readBoolean(DISCORD_KEYS.showPaused, true));
                    setDiscordShowMenu(readBoolean(DISCORD_KEYS.showMenu, true));
                    setLibrary(((_d = (_c = bridge.helpers).getLibraryPreferences) === null || _d === void 0 ? void 0 : _d.call(_c)) || {
                        foldersRaw: '[]',
                        activeFolderId: '',
                    });
                    return [3 /*break*/, 12];
                case 10:
                    fetchError_1 = _e.sent();
                    setError(fetchError_1 instanceof Error ? fetchError_1.message : 'Failed to load MyStremio settings.');
                    return [3 /*break*/, 12];
                case 11:
                    setLoading(false);
                    return [7 /*endfinally*/];
                case 12: return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () {
        refreshFromBridge();
        return function () {
            Object.values(inputTimersRef.current).forEach(clearTimeout);
        };
    }, [refreshFromBridge]);
    var pluginGroups = (0, react_1.useMemo)(function () {
        var grouped = new Map();
        plugins.forEach(function (plugin) {
            if (!grouped.has(plugin.category))
                grouped.set(plugin.category, []);
            grouped.get(plugin.category).push(plugin);
        });
        var result = PLUGIN_CATEGORIES
            .map(function (category) { return ({
            id: category.id,
            label: category.label,
            plugins: (grouped.get(category.id) || []).sort(function (a, b) { return a.label.localeCompare(b.label, 'de'); }),
        }); })
            .filter(function (entry) { return entry.plugins.length > 0; });
        var _loop_1 = function (id, entries) {
            if (result.some(function (entry) { return entry.id === id; }))
                return "continue";
            result.push({
                id: id,
                label: id.charAt(0).toUpperCase() + id.slice(1),
                plugins: entries.sort(function (a, b) { return a.label.localeCompare(b.label, 'de'); }),
            });
        };
        for (var _i = 0, _a = grouped.entries(); _i < _a.length; _i++) {
            var _b = _a[_i], id = _b[0], entries = _b[1];
            _loop_1(id, entries);
        }
        return result;
    }, [plugins]);
    var togglePlugin = (0, react_1.useCallback)(function (fileRef, nextEnabled) { return __awaiter(void 0, void 0, void 0, function () {
        var bridge, resolved, normalizedRef_1, current, fileName_1, without, next, loaded, toggleError_1;
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
        return __generator(this, function (_r) {
            switch (_r.label) {
                case 0:
                    bridge = bridgeRef.current;
                    if (!bridge || pluginToggleBusyRef.current)
                        return [2 /*return*/];
                    pluginToggleBusyRef.current = true;
                    _r.label = 1;
                case 1:
                    _r.trys.push([1, 8, 9, 10]);
                    return [4 /*yield*/, ((_b = (_a = bridge.plugins).resolvePluginRef) === null || _b === void 0 ? void 0 : _b.call(_a, fileRef))];
                case 2:
                    resolved = _r.sent();
                    if (!resolved)
                        return [2 /*return*/];
                    normalizedRef_1 = String(resolved).replace(/\\/g, '/');
                    current = (((_d = (_c = bridge.helpers).getEnabledPlugins) === null || _d === void 0 ? void 0 : _d.call(_c)) || []).map(function (entry) {
                        return String(entry || '').replace(/\\/g, '/');
                    });
                    fileName_1 = normalizedRef_1.split('/').pop();
                    without = current.filter(function (entry) { return entry !== normalizedRef_1 && entry.split('/').pop() !== fileName_1; });
                    next = nextEnabled ? __spreadArray(__spreadArray([], without, true), [normalizedRef_1], false) : without;
                    if (!nextEnabled) return [3 /*break*/, 4];
                    return [4 /*yield*/, ((_f = (_e = bridge.plugins).loadPlugin) === null || _f === void 0 ? void 0 : _f.call(_e, normalizedRef_1))];
                case 3:
                    loaded = _r.sent();
                    if (!loaded)
                        return [2 /*return*/];
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, ((_h = (_g = bridge.plugins).unloadPlugin) === null || _h === void 0 ? void 0 : _h.call(_g, normalizedRef_1))];
                case 5:
                    _r.sent();
                    _r.label = 6;
                case 6:
                    (_k = (_j = bridge.helpers).setEnabledPlugins) === null || _k === void 0 ? void 0 : _k.call(_j, next);
                    setEnabledPlugins(next);
                    if (!nextEnabled && /hero[-_]?div\.plugin\.js$/i.test(normalizedRef_1)) {
                        document.dispatchEvent(new CustomEvent('stremio-custom-enabled-plugins-changed'));
                    }
                    return [4 /*yield*/, ((_m = (_l = bridge.plugins).migrateEnabledPlugins) === null || _m === void 0 ? void 0 : _m.call(_l))];
                case 7:
                    _r.sent();
                    return [3 /*break*/, 10];
                case 8:
                    toggleError_1 = _r.sent();
                    console.error('[MyStremio] plugin toggle failed', toggleError_1);
                    setEnabledPlugins(((_q = (_o = bridgeRef.current) === null || _o === void 0 ? void 0 : (_p = _o.helpers).getEnabledPlugins) === null || _q === void 0 ? void 0 : _q.call(_p)) || []);
                    return [3 /*break*/, 10];
                case 9:
                    pluginToggleBusyRef.current = false;
                    return [7 /*endfinally*/];
                case 10: return [2 /*return*/];
            }
        });
    }); }, []);
    var updatePluginConfigState = (0, react_1.useCallback)(function (baseName, key, value) {
        setPlugins(function (prev) {
            return prev.map(function (plugin) {
                var _a;
                return plugin.baseName === baseName
                    ? __assign(__assign({}, plugin), { config: __assign(__assign({}, plugin.config), (_a = {}, _a[key] = value, _a)) }) : plugin;
            });
        });
    }, []);
    var persistPluginSetting = (0, react_1.useCallback)(function (baseName, key, value) { return __awaiter(void 0, void 0, void 0, function () {
        var bridge;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    bridge = bridgeRef.current;
                    if (!bridge)
                        return [2 /*return*/];
                    updatePluginConfigState(baseName, key, value);
                    return [4 /*yield*/, bridge.api.saveSetting(baseName, key, value)];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); }, [updatePluginConfigState]);
    var persistPreload = (0, react_1.useCallback)(function (value) {
        var _a, _b, _c, _d, _e;
        setPreload(value);
        localStorage.setItem(PRELOAD_SECS_KEY, value);
        (_b = (_a = window.StremioCustomPlayback) === null || _a === void 0 ? void 0 : _a.applyPreloadSettings) === null || _b === void 0 ? void 0 : _b.call(_a);
        document.dispatchEvent(new CustomEvent('stremio-custom-preload-changed'));
        (_e = (_c = bridgeRef.current) === null || _c === void 0 ? void 0 : (_d = _c.helpers).persistUserPreferences) === null || _e === void 0 ? void 0 : _e.call(_d);
    }, []);
    var clearStreamCache = (0, react_1.useCallback)(function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, ((_b = (_a = window.StremioCustomStreamCache) === null || _a === void 0 ? void 0 : _a.clearStreamCache) === null || _b === void 0 ? void 0 : _b.call(_a))];
                case 1:
                    _c.sent();
                    return [2 /*return*/];
            }
        });
    }); }, []);
    var openExternalUrl = (0, react_1.useCallback)(function (url) { return __awaiter(void 0, void 0, void 0, function () {
        var bridge, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    bridge = bridgeRef.current;
                    if (!((_b = bridge === null || bridge === void 0 ? void 0 : bridge.api) === null || _b === void 0 ? void 0 : _b.openExternalUrl)) {
                        window.open(url, '_blank', 'noopener,noreferrer');
                        return [2 /*return*/];
                    }
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, bridge.api.openExternalUrl(url)];
                case 2:
                    _c.sent();
                    return [3 /*break*/, 4];
                case 3:
                    _a = _c.sent();
                    window.open(url, '_blank', 'noopener,noreferrer');
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    }); }, []);
    var updateDiscordPreference = (0, react_1.useCallback)(function (key, value) {
        var _a, _b, _c;
        localStorage.setItem(key, value ? 'true' : 'false');
        (_c = (_a = bridgeRef.current) === null || _a === void 0 ? void 0 : (_b = _a.helpers).persistUserPreferences) === null || _c === void 0 ? void 0 : _c.call(_b);
    }, []);
    var toggleDiscordEnabled = (0, react_1.useCallback)(function (value) {
        var _a, _b, _c, _d;
        setDiscordEnabled(value);
        updateDiscordPreference(DISCORD_KEYS.enabled, value);
        if (value)
            (_b = (_a = window.StremioCustomDiscordPresence) === null || _a === void 0 ? void 0 : _a.startPolling) === null || _b === void 0 ? void 0 : _b.call(_a);
        else
            (_d = (_c = window.StremioCustomDiscordPresence) === null || _c === void 0 ? void 0 : _c.clearPresence) === null || _d === void 0 ? void 0 : _d.call(_c);
    }, [updateDiscordPreference]);
    var exportLibrary = (0, react_1.useCallback)(function () {
        var folders = normalizeLibraryFolders(library.foldersRaw);
        var activeFolderId = folders.some(function (folder) { return folder.id === library.activeFolderId; })
            ? library.activeFolderId
            : '';
        var payload = {
            type: 'mystremio-library-backup',
            version: 1,
            exportedAt: new Date().toISOString(),
            library: {
                foldersRaw: JSON.stringify(folders),
                activeFolderId: activeFolderId,
            },
        };
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        var link = document.createElement('a');
        var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        link.href = URL.createObjectURL(blob);
        link.download = "mystremio-library-".concat(stamp, ".json");
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
    }, [library]);
    var importLibrary = (0, react_1.useCallback)(function () {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', function () {
            var _a;
            var file = (_a = input.files) === null || _a === void 0 ? void 0 : _a[0];
            if (!file)
                return;
            var reader = new FileReader();
            reader.onload = function () {
                var _a, _b, _c, _d, _e, _f, _g, _h;
                try {
                    var parsed = JSON.parse(String(reader.result || '{}'));
                    var source = parsed.library && typeof parsed.library === 'object' ? parsed.library : parsed;
                    var normalized = {
                        foldersRaw: JSON.stringify(normalizeLibraryFolders((_b = (_a = source.foldersRaw) !== null && _a !== void 0 ? _a : source.folders) !== null && _b !== void 0 ? _b : source)),
                        activeFolderId: safeString(source.activeFolderId),
                    };
                    setLibrary(normalized);
                    (_e = (_c = bridgeRef.current) === null || _c === void 0 ? void 0 : (_d = _c.helpers).applyLibraryPreferences) === null || _e === void 0 ? void 0 : _e.call(_d, normalized);
                    (_h = (_f = bridgeRef.current) === null || _f === void 0 ? void 0 : (_g = _f.helpers).persistUserPreferences) === null || _h === void 0 ? void 0 : _h.call(_g);
                }
                catch (_j) {
                    // Ignore invalid import files
                }
            };
            reader.readAsText(file);
        });
        input.click();
    }, []);
    var renderPluginField = (0, react_1.useCallback)(function (plugin, field, compact) {
        var _a, _b, _c;
        if (compact === void 0) { compact = false; }
        var currentValue = (_a = plugin.config[field.key]) !== null && _a !== void 0 ? _a : field.defaultValue;
        var label = field.label || field.key;
        var apiKeyLink = getApiKeyLinkForField(field);
        var renderFieldLabel = function () {
            if (!apiKeyLink) {
                return react_1.default.createElement("span", { className: MyStremio_less_1.default['plugin-setting-label'] }, label);
            }
            return (react_1.default.createElement("span", { className: MyStremio_less_1.default['plugin-setting-label-row'] },
                react_1.default.createElement("span", { className: MyStremio_less_1.default['plugin-setting-label'] }, label),
                react_1.default.createElement("button", { type: 'button', className: MyStremio_less_1.default['api-key-link'], title: apiKeyLink.url, onClick: function (event) {
                        event.stopPropagation();
                        openExternalUrl(apiKeyLink.url);
                    } }, 'Get API Key')));
        };
        if (compact) {
            if (field.type === 'toggle') {
                return (react_1.default.createElement("div", { key: field.key, className: MyStremio_less_1.default['plugin-setting-row'] },
                    react_1.default.createElement("span", { className: MyStremio_less_1.default['plugin-setting-label'] }, label),
                    react_1.default.createElement(components_1.Toggle, { tabIndex: -1, checked: Boolean(currentValue), onMouseDown: function (event) { return event.stopPropagation(); }, onClick: function (event) {
                            event.stopPropagation();
                            persistPluginSetting(plugin.baseName, field.key, !Boolean(currentValue));
                        } })));
            }
            if (field.type === 'select' && Array.isArray(field.options) && field.options.length > 0) {
                var options = field.options.map(function (entry) { return ({
                    value: String(entry.value),
                    label: safeString(entry.label || entry.value),
                }); });
                var activeValue = safeString(currentValue, safeString((_b = options[0]) === null || _b === void 0 ? void 0 : _b.value, ''));
                return (react_1.default.createElement("div", { key: field.key, className: MyStremio_less_1.default['plugin-setting-row-stacked'] },
                    renderFieldLabel(),
                    react_1.default.createElement(components_1.MultiselectMenu, { className: 'multiselect', options: options, value: activeValue, onSelect: function (value) { return persistPluginSetting(plugin.baseName, field.key, value); } })));
            }
            return (react_1.default.createElement("div", { key: field.key, className: MyStremio_less_1.default['plugin-setting-row-stacked'] },
                renderFieldLabel(),
                react_1.default.createElement("input", { className: MyStremio_less_1.default['plugin-setting-input'], type: isSecretSettingField(field) ? 'password' : field.inputType || 'text', value: safeString(currentValue), placeholder: field.placeholder || '', autoComplete: 'off', onChange: function (event) {
                        var nextValue = event.currentTarget.value;
                        updatePluginConfigState(plugin.baseName, field.key, nextValue);
                        var timerKey = "".concat(plugin.baseName, ":").concat(field.key);
                        if (inputTimersRef.current[timerKey])
                            clearTimeout(inputTimersRef.current[timerKey]);
                        inputTimersRef.current[timerKey] = setTimeout(function () {
                            persistPluginSetting(plugin.baseName, field.key, nextValue);
                        }, 300);
                    } })));
        }
        if (field.type === 'toggle') {
            return (react_1.default.createElement(components_2.Option, { key: field.key, className: MyStremio_less_1.default['plugin-setting-option'], label: field.label || field.key },
                react_1.default.createElement(components_1.Toggle, { tabIndex: -1, checked: Boolean(currentValue), onMouseDown: function (event) { return event.stopPropagation(); }, onClick: function (event) {
                        event.stopPropagation();
                        persistPluginSetting(plugin.baseName, field.key, !Boolean(currentValue));
                    } })));
        }
        if (field.type === 'select' && Array.isArray(field.options) && field.options.length > 0) {
            var options = field.options.map(function (entry) { return ({
                value: String(entry.value),
                label: safeString(entry.label || entry.value),
            }); });
            var activeValue = safeString(currentValue, safeString((_c = options[0]) === null || _c === void 0 ? void 0 : _c.value, ''));
            return (react_1.default.createElement(components_2.Option, { key: field.key, className: MyStremio_less_1.default['plugin-setting-option'], label: field.label || field.key },
                react_1.default.createElement(components_1.MultiselectMenu, { className: 'multiselect', options: options, value: activeValue, onSelect: function (value) { return persistPluginSetting(plugin.baseName, field.key, value); } })));
        }
        return (react_1.default.createElement(components_2.Option, { key: field.key, className: MyStremio_less_1.default['plugin-setting-option'], label: field.label || field.key },
            react_1.default.createElement("input", { className: MyStremio_less_1.default['plugin-setting-input'], type: isSecretSettingField(field) ? 'password' : field.inputType || 'text', value: safeString(currentValue), placeholder: field.placeholder || '', autoComplete: 'off', onChange: function (event) {
                    var nextValue = event.currentTarget.value;
                    updatePluginConfigState(plugin.baseName, field.key, nextValue);
                    var timerKey = "".concat(plugin.baseName, ":").concat(field.key);
                    if (inputTimersRef.current[timerKey])
                        clearTimeout(inputTimersRef.current[timerKey]);
                    inputTimersRef.current[timerKey] = setTimeout(function () {
                        persistPluginSetting(plugin.baseName, field.key, nextValue);
                    }, 300);
                } })));
    }, [openExternalUrl, persistPluginSetting, updatePluginConfigState]);
    if (loading) {
        return (react_1.default.createElement(components_2.Section, { ref: ref, label: 'MyStremio' },
            react_1.default.createElement("div", { className: MyStremio_less_1.default['status'] }, "Loading MyStremio settings\u2026")));
    }
    if (error) {
        return (react_1.default.createElement(components_2.Section, { ref: ref, label: 'MyStremio' },
            react_1.default.createElement("div", { className: MyStremio_less_1.default['status'] }, error),
            react_1.default.createElement(components_1.Button, { className: 'button', title: 'Retry', tabIndex: -1, onClick: refreshFromBridge }, 'Retry')));
    }
    return (react_1.default.createElement(components_2.Section, { ref: ref, label: 'MyStremio' },
        react_1.default.createElement(components_2.Category, { icon: 'play', label: 'Plugins' },
            pluginGroups.map(function (group) {
                var open = Boolean(openPluginGroups[group.id]);
                var enabledCount = group.plugins.filter(function (plugin) {
                    return enabledPlugins.some(function (entry) {
                        var normalizedEntry = String(entry || '').replace(/\\/g, '/');
                        var normalizedPlugin = String(plugin.fileRef || '').replace(/\\/g, '/');
                        return normalizedEntry === normalizedPlugin || normalizedEntry.split('/').pop() === normalizedPlugin.split('/').pop();
                    });
                }).length;
                return (react_1.default.createElement("div", { key: group.id, className: MyStremio_less_1.default['plugin-group'] },
                    react_1.default.createElement(components_2.Option, { label: group.label },
                        react_1.default.createElement(CollapsibleDropdown_1.default, { summary: "".concat(enabledCount, " / ").concat(group.plugins.length), open: open, onToggle: function () { return setOpenPluginGroups(function (prev) {
                                var _a;
                                return (__assign(__assign({}, prev), (_a = {}, _a[group.id] = !open, _a)));
                            }); }, panelFit: true }, group.plugins.map(function (plugin) {
                            var pluginEnabled = enabledPlugins.some(function (entry) {
                                var normalizedEntry = String(entry || '').replace(/\\/g, '/');
                                var normalizedPlugin = String(plugin.fileRef || '').replace(/\\/g, '/');
                                return normalizedEntry === normalizedPlugin || normalizedEntry.split('/').pop() === normalizedPlugin.split('/').pop();
                            });
                            var expanded = Boolean(openPluginSettings[plugin.baseName]);
                            return (react_1.default.createElement("div", { key: plugin.fileRef, className: MyStremio_less_1.default['plugin-block'] },
                                react_1.default.createElement("div", { className: MyStremio_less_1.default['plugin-row'] },
                                    react_1.default.createElement("div", { className: MyStremio_less_1.default['plugin-title'] },
                                        react_1.default.createElement("div", { className: MyStremio_less_1.default['plugin-name'] }, plugin.label),
                                        (plugin.version || plugin.author) && (react_1.default.createElement("div", { className: MyStremio_less_1.default['plugin-meta'] }, [plugin.version ? "v".concat(plugin.version) : null, plugin.author || null]
                                            .filter(Boolean)
                                            .join(' · ')))),
                                    react_1.default.createElement("div", { className: MyStremio_less_1.default['plugin-actions'] },
                                        plugin.schema.length > 0 && (react_1.default.createElement("button", { type: 'button', className: MyStremio_less_1.default['gear-button'], title: expanded ? 'Hide settings' : 'Settings', onClick: function () { return setOpenPluginSettings(function (prev) {
                                                var _a;
                                                return (__assign(__assign({}, prev), (_a = {}, _a[plugin.baseName] = !expanded, _a)));
                                            }); } }, '⚙')),
                                        react_1.default.createElement(components_1.Toggle, { tabIndex: -1, checked: pluginEnabled, onMouseDown: function (event) { return event.stopPropagation(); }, onClick: function (event) {
                                                event.stopPropagation();
                                                togglePlugin(plugin.fileRef, !pluginEnabled);
                                            } }))),
                                expanded && (react_1.default.createElement("div", { className: MyStremio_less_1.default['plugin-settings'] }, plugin.schema.map(function (field) { return renderPluginField(plugin, field, true); })))));
                        })))));
            }),
            react_1.default.createElement(components_2.Option, { label: 'Plugins folder' },
                react_1.default.createElement(components_1.Button, { className: 'button', title: 'Open plugins folder', tabIndex: -1, onClick: function () { var _a; return (_a = bridgeRef.current) === null || _a === void 0 ? void 0 : _a.api.openFolder(pluginsPath); } }, 'Open plugins folder'))),
        react_1.default.createElement(components_2.Category, { icon: 'clock', label: 'Preload' },
            react_1.default.createElement(components_2.Option, { label: 'Buffer ahead' },
                react_1.default.createElement(components_1.MultiselectMenu, { className: 'multiselect', options: PRELOAD_OPTIONS, value: preload, onSelect: persistPreload })),
            react_1.default.createElement(components_2.Option, { label: 'Stream cache' },
                react_1.default.createElement(components_1.Button, { className: 'button', title: 'Clear stream cache', tabIndex: -1, onClick: clearStreamCache }, 'Clear stream cache'))),
        react_1.default.createElement(components_2.Category, { icon: 'library', label: 'Library' },
            react_1.default.createElement(components_2.Option, { label: 'Library backup' },
                react_1.default.createElement("div", { className: MyStremio_less_1.default['library-actions'] },
                    react_1.default.createElement(components_1.Button, { className: 'button', title: 'Export library JSON', tabIndex: -1, onClick: exportLibrary }, 'Export library JSON'),
                    react_1.default.createElement(components_1.Button, { className: 'button', title: 'Import library JSON', tabIndex: -1, onClick: importLibrary }, 'Import library JSON')))),
        react_1.default.createElement(components_2.Category, { icon: 'discord', label: 'Discord Rich Presence' },
            react_1.default.createElement(components_2.Option, { label: 'Settings' },
                react_1.default.createElement(CollapsibleDropdown_1.default, { summary: discordEnabled ? 'Enabled' : 'Disabled', open: discordOpen, onToggle: function () { return setDiscordOpen(function (prev) { return !prev; }); }, panelFit: true },
                    react_1.default.createElement("div", { className: MyStremio_less_1.default['panel-toggle-row'] },
                        react_1.default.createElement("span", { className: MyStremio_less_1.default['panel-toggle-label'] }, "Enable Discord Rich Presence"),
                        react_1.default.createElement(components_1.Toggle, { tabIndex: -1, checked: discordEnabled, onClick: function () { return toggleDiscordEnabled(!discordEnabled); } })),
                    react_1.default.createElement("div", { className: MyStremio_less_1.default['panel-toggle-row'] },
                        react_1.default.createElement("span", { className: MyStremio_less_1.default['panel-toggle-label'] }, "Show paused state"),
                        react_1.default.createElement(components_1.Toggle, { tabIndex: -1, checked: discordShowPaused, onClick: function () {
                                var next = !discordShowPaused;
                                setDiscordShowPaused(next);
                                updateDiscordPreference(DISCORD_KEYS.showPaused, next);
                            } })),
                    react_1.default.createElement("div", { className: MyStremio_less_1.default['panel-toggle-row'] },
                        react_1.default.createElement("span", { className: MyStremio_less_1.default['panel-toggle-label'] }, "Show browsing state"),
                        react_1.default.createElement(components_1.Toggle, { tabIndex: -1, checked: discordShowMenu, onClick: function () {
                                var next = !discordShowMenu;
                                setDiscordShowMenu(next);
                                updateDiscordPreference(DISCORD_KEYS.showMenu, next);
                            } })))))));
});
exports.default = MyStremio;
