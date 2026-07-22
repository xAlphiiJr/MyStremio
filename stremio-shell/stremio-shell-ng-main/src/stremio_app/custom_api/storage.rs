use super::paths::{plugins_dir, resolve_asset_path, themes_dir, walk_files};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    fs,
    path::Path,
};

const PLUGIN_CONFIG_EXT: &str = ".plugin.json";
const PLUGIN_SCHEMA_EXT: &str = ".plugin.schema.json";
const THEME_EXT: &str = ".theme.css";
const PLUGIN_EXT: &str = ".plugin.js";
const PREFERENCES_FILE: &str = "mystremio-settings.json";
const AUTOSKIP_FILE: &str = "mystremio-autoskip.json";
const PLAYER_VOLUME_FILE: &str = "mystremio-player-volume.json";

pub type RegisteredSchemas = HashMap<String, Value>;

pub fn list_plugin_files() -> Vec<String> {
    walk_files(&plugins_dir(), PLUGIN_EXT)
}

pub fn list_theme_files() -> Vec<String> {
    walk_files(&themes_dir(), THEME_EXT)
}

pub fn read_theme_css(file_name: &str) -> Option<String> {
    let path = themes_dir().join(file_name);
    fs::read_to_string(path).ok()
}

pub fn read_plugin_source(file_ref: &str) -> Option<String> {
    resolve_asset_path(file_ref).and_then(|path| fs::read_to_string(path).ok())
}

pub fn read_asset_metadata(relative_path: &str) -> Value {
    let path = resolve_asset_path(relative_path).or_else(|| {
        let plugin_path = plugins_dir().join(relative_path);
        if plugin_path.exists() {
            Some(plugin_path)
        } else {
            let theme_path = themes_dir().join(relative_path);
            if theme_path.exists() {
                Some(theme_path)
            } else {
                None
            }
        }
    });

    let Some(path) = path else {
        return json!(null);
    };

    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => return json!(null),
    };

    let read_tag = |tag: &str| -> Option<String> {
        let marker = format!("@{tag} ");
        for line in content.lines().take(40) {
            let trimmed = line.trim();
            for candidate in [
                trimmed,
                trimmed.strip_prefix("// ").unwrap_or(trimmed),
                trimmed.strip_prefix("* ").unwrap_or(trimmed),
            ] {
                if let Some(value) = candidate.strip_prefix(&marker) {
                    return Some(value.trim().to_string());
                }
            }
        }
        None
    };

    json!({
        "name": read_tag("name").unwrap_or_else(|| path.file_name().unwrap_or_default().to_string_lossy().to_string()),
        "description": read_tag("description").unwrap_or_default(),
        "version": read_tag("version").unwrap_or_else(|| "0.0.0".to_string()),
        "author": read_tag("author").unwrap_or_else(|| "Unknown".to_string()),
        "category": read_tag("category").unwrap_or_default(),
    })
}

pub fn read_user_preferences() -> Value {
    let path = preferences_path();
    if !path.exists() {
        return default_preferences();
    }

    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .map(normalize_preferences)
        .unwrap_or_else(default_preferences)
}

pub fn save_user_preferences(preferences: &Value) {
    // Many JS callers (persistUserPreferences) omit apiKeys. Preserve the vault
    // from disk whenever the key is absent so shared keys are not wiped.
    let mut merged = preferences.clone();
    if merged.get("apiKeys").is_none() {
        if let Some(existing_keys) = read_api_keys_from_disk_raw() {
            if let Some(obj) = merged.as_object_mut() {
                obj.insert("apiKeys".to_string(), existing_keys);
            }
        }
    }
    let normalized = normalize_preferences(merged);
    if let Some(parent) = preferences_path().parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(&normalized) {
        let _ = fs::write(preferences_path(), content);
    }
}

/// Reads `apiKeys` from the preferences file without full normalize (no recursion).
fn read_api_keys_from_disk_raw() -> Option<Value> {
    let path = preferences_path();
    if !path.exists() {
        return None;
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|value| value.get("apiKeys").cloned())
}

pub fn read_autoskip_settings() -> Value {
    let path = autoskip_path();
    if !path.exists() {
        let defaults = default_autoskip_preferences();
        save_autoskip_settings(&defaults);
        return defaults;
    }

    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .map(|value| normalize_autoskip_preferences(Some(&value)))
        .unwrap_or_else(default_autoskip_preferences)
}

pub fn save_autoskip_settings(settings: &Value) {
    let normalized = normalize_autoskip_preferences(Some(settings));
    if let Some(parent) = autoskip_path().parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(&normalized) {
        let _ = fs::write(autoskip_path(), content);
    }
}

pub fn read_player_volume() -> Value {
    let path = player_volume_path();
    if !path.exists() {
        return default_player_volume();
    }

    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .map(normalize_player_volume)
        .unwrap_or_else(default_player_volume)
}

pub fn save_player_volume(settings: &Value) {
    let normalized = normalize_player_volume(settings.clone());
    if let Some(parent) = player_volume_path().parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(&normalized) {
        let _ = fs::write(player_volume_path(), content);
    }
}

pub fn get_plugin_config(plugin_base_name: &str) -> Value {
    let path = plugin_config_path(plugin_base_name);
    let config = read_json_object(&path);
    if plugin_base_name == "data-enrichment" {
        return repair_data_enrichment_config(config, &path);
    }
    config
}

pub fn get_plugin_setting(plugin_base_name: &str, key: &str) -> Value {
    let config = get_plugin_config(plugin_base_name);
    config.get(key).cloned().unwrap_or(Value::Null)
}

pub fn save_plugin_setting(plugin_base_name: &str, key: &str, value: Value) -> Value {
    let path = plugin_config_path(plugin_base_name);
    let mut config = read_json_object(&path);
    if let Value::Object(ref mut map) = config {
        map.insert(key.to_string(), value);
    }
    write_json_object(&path, &config);
    config
}

pub fn register_plugin_schema(
    schemas: &std::sync::Mutex<RegisteredSchemas>,
    plugin_base_name: &str,
    schema: Value,
) -> bool {
    if plugin_base_name.is_empty() || !schema.is_array() {
        return false;
    }

    if let Ok(mut guard) = schemas.lock() {
        guard.insert(plugin_base_name.to_string(), schema.clone());
    }

    let path = plugin_schema_path(plugin_base_name);
    if let Ok(content) = serde_json::to_string_pretty(&schema) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, content);
    }
    true
}

pub fn get_registered_schema(
    schemas: &std::sync::Mutex<RegisteredSchemas>,
    plugin_base_name: &str,
) -> Value {
    schemas
        .lock()
        .ok()
        .and_then(|guard| guard.get(plugin_base_name).cloned())
        .unwrap_or(Value::Null)
}

pub fn clear_registered_schema(
    schemas: &std::sync::Mutex<RegisteredSchemas>,
    plugin_base_name: &str,
) -> bool {
    schemas
        .lock()
        .ok()
        .and_then(|mut guard| guard.remove(plugin_base_name))
        .is_some()
}

pub fn load_registered_schemas() -> RegisteredSchemas {
    let mut schemas = RegisteredSchemas::new();
    for file in walk_files(&plugins_dir(), PLUGIN_SCHEMA_EXT) {
        let base_name = Path::new(&file)
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.trim_end_matches(PLUGIN_SCHEMA_EXT).to_string());
        let Some(base_name) = base_name else {
            continue;
        };
        let path = plugins_dir().join(&file);
        if let Ok(content) = fs::read_to_string(path) {
            let normalized = content.trim_start_matches('\u{feff}');
            if let Ok(schema) = serde_json::from_str::<Value>(normalized) {
                schemas.insert(base_name, schema);
            }
        }
    }
    schemas
}

fn repair_data_enrichment_config(config: Value, path: &Path) -> Value {
    if config
        .get("tmdbApiKey")
        .and_then(|v| v.as_str())
        .is_some()
    {
        // Respect explicit user choice, including an intentionally empty key.
        return config;
    }

    if let Some(existing) = config
        .get("tmdbApiKey")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if looks_like_api_key(existing) {
            return config;
        }
    }

    let mistaken_path = plugins_dir().join("tmdbApiKey.plugin.json");
    let mistaken = read_json_object(&mistaken_path);
    let Some(mistaken_map) = mistaken.as_object() else {
        return config;
    };

    for (key, value) in mistaken_map {
        let candidate = value
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| key.trim());
        if !looks_like_api_key(candidate) {
            continue;
        }
        let mut repaired = config;
        if let Value::Object(ref mut map) = repaired {
            map.insert(
                "tmdbApiKey".to_string(),
                Value::String(candidate.to_string()),
            );
            write_json_object(path, &repaired);
        }
        return repaired;
    }

    config
}

fn looks_like_api_key(value: &str) -> bool {
    value.len() >= 16 && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn preferences_path() -> std::path::PathBuf {
    super::paths::app_data_dir().join(PREFERENCES_FILE)
}

fn autoskip_path() -> std::path::PathBuf {
    super::paths::app_data_dir().join(AUTOSKIP_FILE)
}

fn player_volume_path() -> std::path::PathBuf {
    super::paths::app_data_dir().join(PLAYER_VOLUME_FILE)
}

fn default_player_volume() -> Value {
    json!({
        "level": Value::Null,
        "muted": Value::Null
    })
}

fn normalize_player_volume(value: Value) -> Value {
    let Some(volume) = value.as_object() else {
        return default_player_volume();
    };

    let level = volume
        .get("level")
        .and_then(|v| v.as_f64())
        .map(|level| level.clamp(0.0, 100.0).round());

    json!({
        "level": level,
        "muted": volume.get("muted").and_then(|v| v.as_bool())
    })
}

fn plugin_config_path(plugin_base_name: &str) -> std::path::PathBuf {
    find_plugin_config_path(plugin_base_name)
        .unwrap_or_else(|| plugins_dir().join(format!("{plugin_base_name}{PLUGIN_CONFIG_EXT}")))
}

fn plugin_schema_path(plugin_base_name: &str) -> std::path::PathBuf {
    if let Some(config_path) = find_plugin_config_path(plugin_base_name) {
        let replaced = config_path
            .to_string_lossy()
            .replace(PLUGIN_CONFIG_EXT, PLUGIN_SCHEMA_EXT);
        return Path::new(&replaced).to_path_buf();
    }
    plugins_dir().join(format!("{plugin_base_name}{PLUGIN_SCHEMA_EXT}"))
}

fn find_plugin_config_path(plugin_base_name: &str) -> Option<std::path::PathBuf> {
    for file in walk_files(&plugins_dir(), PLUGIN_CONFIG_EXT) {
        if file.ends_with(&format!("{plugin_base_name}{PLUGIN_CONFIG_EXT}")) {
            return Some(plugins_dir().join(file));
        }
    }
    None
}

fn default_preferences() -> Value {
    json!({
        "enabledPlugins": [],
        "currentTheme": "liquid-glass.theme.css",
        "autoskip": default_autoskip_preferences(),
        "metadataAddon": "",
        "preload": "120",
        "volume": {
            "level": null,
            "muted": null
        },
        "discordPresence": {
            "enabled": false,
            "showPaused": true,
            "showMenu": true
        },
        "library": {
            "foldersRaw": "[]",
            "activeFolderId": ""
        },
        "language": {
            "favAudio": [],
            "activeAudio": "",
            "favSubs": [],
            "activeSubs": ""
        },
        "onboarding": {
            "tmdbNoticeShown": false,
            "defaultsApplied": false
        },
        "uiScale": 100,
        "uiScaleAdaptedMonitors": [],
        "apiKeys": {}
    })
}

fn default_autoskip_preferences() -> Value {
    json!({
        "intro": false,
        "credits": false,
        "recap": false
    })
}

fn normalize_autoskip_preferences(value: Option<&Value>) -> Value {
    let Some(autoskip) = value.and_then(|v| v.as_object()) else {
        return default_autoskip_preferences();
    };

    json!({
        "intro": autoskip.get("intro").and_then(|v| v.as_bool()).unwrap_or(false),
        "credits": autoskip.get("credits").and_then(|v| v.as_bool()).unwrap_or(false),
        "recap": autoskip.get("recap").and_then(|v| v.as_bool()).unwrap_or(false)
    })
}

fn normalize_preferences(value: Value) -> Value {
    let enabled = value
        .get("enabledPlugins")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let current_theme = value
        .get("currentTheme")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let autoskip = normalize_autoskip_preferences(value.get("autoskip"));
    let metadata_addon = value
        .get("metadataAddon")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let preload = value
        .get("preload")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "120".to_string());
    let volume = value
        .get("volume")
        .and_then(|v| v.as_object())
        .map(|vol| {
            let level = vol
                .get("level")
                .and_then(|v| v.as_f64())
                .map(|level| level.clamp(0.0, 100.0).round());
            json!({
                "level": level,
                "muted": vol.get("muted").and_then(|v| v.as_bool())
            })
        })
        .unwrap_or_else(|| {
            json!({
                "level": Value::Null,
                "muted": Value::Null
            })
        });
    let discord_presence = value
        .get("discordPresence")
        .and_then(|v| v.as_object())
        .map(|settings| {
            json!({
                "enabled": settings.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
                "showPaused": settings.get("showPaused").and_then(|v| v.as_bool()).unwrap_or(true),
                "showMenu": settings.get("showMenu").and_then(|v| v.as_bool()).unwrap_or(true)
            })
        })
        .unwrap_or_else(|| {
            json!({
                "enabled": false,
                "showPaused": true,
                "showMenu": true
            })
        });
    let library = value
        .get("library")
        .and_then(|v| v.as_object())
        .map(|state| {
            json!({
                "foldersRaw": state.get("foldersRaw").and_then(|v| v.as_str()).unwrap_or("[]"),
                "activeFolderId": state.get("activeFolderId").and_then(|v| v.as_str()).unwrap_or("")
            })
        })
        .unwrap_or_else(|| {
            json!({
                "foldersRaw": "[]",
                "activeFolderId": ""
            })
        });
    let language = value
        .get("language")
        .and_then(|v| v.as_object())
        .map(|lang| {
            json!({
                "favAudio": lang.get("favAudio").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
                "activeAudio": lang.get("activeAudio").and_then(|v| v.as_str()).unwrap_or(""),
                "favSubs": lang.get("favSubs").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
                "activeSubs": lang.get("activeSubs").and_then(|v| v.as_str()).unwrap_or("")
            })
        })
        .unwrap_or_else(|| {
            json!({
                "favAudio": [],
                "activeAudio": "",
                "favSubs": [],
                "activeSubs": ""
            })
        });
    let onboarding = value
        .get("onboarding")
        .and_then(|v| v.as_object())
        .map(|state| {
            json!({
                "tmdbNoticeShown": state.get("tmdbNoticeShown").and_then(|v| v.as_bool()).unwrap_or(false),
                "defaultsApplied": state.get("defaultsApplied").and_then(|v| v.as_bool()).unwrap_or(false)
            })
        })
        .unwrap_or_else(|| {
            json!({
                "tmdbNoticeShown": false,
                "defaultsApplied": false
            })
        });
    let auth_profile = value
        .get("authProfile")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_default();
    let ui_scale = normalize_ui_scale_percent(value.get("uiScale"));
    let ui_scale_adapted_monitors = normalize_ui_scale_adapted_monitors(value.get("uiScaleAdaptedMonitors"));
    let api_keys = super::api_keys::normalize_api_keys(value.get("apiKeys"));

    json!({
        "enabledPlugins": enabled,
        "currentTheme": current_theme,
        "autoskip": autoskip,
        "metadataAddon": metadata_addon,
        "preload": preload,
        "volume": volume,
        "discordPresence": discord_presence,
        "library": library,
        "language": language,
        "onboarding": onboarding,
        "authProfile": auth_profile,
        "uiScale": ui_scale,
        "uiScaleAdaptedMonitors": ui_scale_adapted_monitors,
        "apiKeys": api_keys
    })
}

fn read_json_object(path: &Path) -> Value {
    if !path.exists() {
        let empty = Value::Object(Map::new());
        write_json_object(path, &empty);
        return empty;
    }

    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(|| Value::Object(Map::new()))
}

pub fn read_language_names() -> Value {
    const LANGUAGE_NAMES: &str = include_str!("../../../assets/languageNames.json");
    serde_json::from_str(LANGUAGE_NAMES).unwrap_or_else(|_| json!({}))
}

/// localStorage keys mirrored from `mystremio-settings.json`.
///
/// These MUST stay in sync with the constants in `assets/custom_bootstrap.js`. WebView2
/// does not durably flush its localStorage write-ahead log when the app is closed while
/// the shell keeps running in the tray, so any setting written only at runtime is lost on
/// the next launch. Re-injecting every persisted value before `main.js` (put-if-absent)
/// makes settings survive restarts and updates without depending on the async JS hydrate.
fn collect_early_storage_pairs(prefs: &Value) -> Map<String, Value> {
    let mut pairs: Map<String, Value> = Map::new();
    let mut put = |key: &str, value: String| {
        pairs.insert(key.to_string(), Value::String(value));
    };

    if let Some(plugins) = prefs.get("enabledPlugins").and_then(|v| v.as_array()) {
        if let Ok(json) = serde_json::to_string(plugins) {
            put("enabledPlugins", json);
        }
    }
    if let Some(theme) = prefs
        .get("currentTheme")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        put("currentTheme", theme.to_string());
    }
    if let Some(addon) = prefs
        .get("metadataAddon")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        put("stremio-custom-metadata-addon", addon.to_string());
    }
    if let Some(preload) = prefs
        .get("preload")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        put("stremio-custom-preload-secs", preload.to_string());
    }
    put(
        "stremio-custom-ui-scale-percent",
        read_ui_scale_percent_from_value(&prefs).to_string(),
    );

    if let Some(volume) = prefs.get("volume") {
        if let Some(level) = volume.get("level").and_then(|v| v.as_f64()) {
            put(
                "stremio-custom-player-volume",
                (level.clamp(0.0, 100.0).round() as i64).to_string(),
            );
        }
        if let Some(muted) = volume.get("muted").and_then(|v| v.as_bool()) {
            put("stremio-custom-player-muted", muted.to_string());
        }
    }

    if let Some(autoskip) = prefs.get("autoskip") {
        for (id, key) in [
            ("intro", "stremio-custom-autoskip-intro"),
            ("credits", "stremio-custom-autoskip-credits"),
            ("recap", "stremio-custom-autoskip-recap"),
        ] {
            if let Some(value) = autoskip.get(id).and_then(|v| v.as_bool()) {
                put(key, value.to_string());
            }
        }
    }

    if let Some(discord) = prefs.get("discordPresence") {
        for (id, key) in [
            ("enabled", "stremio-custom-discord-rp-enabled"),
            ("showPaused", "stremio-custom-discord-rp-show-paused"),
            ("showMenu", "stremio-custom-discord-rp-show-menu"),
        ] {
            if let Some(value) = discord.get(id).and_then(|v| v.as_bool()) {
                put(key, value.to_string());
            }
        }
    }

    if let Some(library) = prefs.get("library") {
        if let Some(folders) = library
            .get("foldersRaw")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "[]")
        {
            put("stremio-custom-library-folders", folders.to_string());
        }
        if let Some(active) = library
            .get("activeFolderId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            put("stremio-custom-library-active-folder", active.to_string());
        }
    }

    if let Some(language) = prefs.get("language") {
        if let Some(fav) = language.get("favAudio").and_then(|v| v.as_array()) {
            if !fav.is_empty() {
                if let Ok(json) = serde_json::to_string(fav) {
                    put("stremio-custom-fav-audio", json);
                }
            }
        }
        if let Some(fav) = language.get("favSubs").and_then(|v| v.as_array()) {
            if !fav.is_empty() {
                if let Ok(json) = serde_json::to_string(fav) {
                    put("stremio-custom-fav-subs", json);
                }
            }
        }
        if let Some(active) = language
            .get("activeAudio")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            put("stremio-custom-active-audio", active.to_string());
        }
        if let Some(active) = language
            .get("activeSubs")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            put("stremio-custom-active-subs", active.to_string());
        }
    }

    if let Some(onboarding) = prefs.get("onboarding") {
        if onboarding
            .get("tmdbNoticeShown")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            put("stremio-custom-tmdb-notice-shown-v211d", "true".to_string());
        }
        if onboarding
            .get("defaultsApplied")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            put("stremio-custom-defaults-applied-v211a", "true".to_string());
        }
    }

    pairs
}

/// Injected before bundled main.js so login and all settings survive restarts and updates.
pub fn build_early_storage_restore_script() -> String {
    let prefs = read_user_preferences();
    let auth_profile = prefs
        .get("authProfile")
        .and_then(|value| value.as_str())
        .unwrap_or("");

    let auth_json = serde_json::to_string(auth_profile).unwrap_or_else(|_| "\"\"".to_string());
    let restore_json =
        serde_json::to_string(&collect_early_storage_pairs(&prefs)).unwrap_or_else(|_| "{}".to_string());

    format!(
        r#"(function(){{try{{
if(window.__stremioEarlyStorageRestore)return;
window.__stremioEarlyStorageRestore=true;
function hasAuthProfile(){{try{{var raw=localStorage.getItem('profile');if(!raw)return false;var p=JSON.parse(raw);return Boolean(p&&p.auth&&p.auth.key);}}catch(_){{return false;}}}}
var authProfile={auth_json};
if(authProfile&&!hasAuthProfile()){{try{{localStorage.setItem('profile',authProfile);}}catch(_){{}}}}
var restore={restore_json};
var forceRestoreKeys={{"stremio-custom-ui-scale-percent":true}};
Object.keys(restore).forEach(function(key){{try{{if(forceRestoreKeys[key]||localStorage.getItem(key)===null)localStorage.setItem(key,restore[key]);}}catch(_){{}}}});
}}catch(e){{console.warn('[StremioCustom] early storage restore failed',e);}}}})();"#
    )
}

fn write_json_object(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(value) {
        let _ = fs::write(path, content);
    }
}

const ALLOWED_UI_SCALE_PERCENTS: [u32; 6] = [75, 100, 125, 150, 175, 200];

/// Snaps a UI scale percentage to the nearest supported 25% step.
pub fn normalize_ui_scale_percent(value: Option<&Value>) -> u32 {
    let raw = value
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_i64().map(|n| if n < 0 { 0 } else { n as u64 }))
                .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
        })
        .unwrap_or(100) as u32;
    ALLOWED_UI_SCALE_PERCENTS
        .iter()
        .copied()
        .min_by_key(|allowed| allowed.abs_diff(raw))
        .unwrap_or(100)
}

fn read_ui_scale_percent_from_value(prefs: &Value) -> u32 {
    normalize_ui_scale_percent(prefs.get("uiScale"))
}

/// Returns the persisted UI scale percentage (75–200 in 25% steps, default 100).
pub fn read_ui_scale_percent() -> u32 {
    read_ui_scale_percent_from_value(&read_user_preferences())
}

/// Persists the UI scale percentage and returns the normalized value.
pub fn save_ui_scale_percent(percent: u32) -> u32 {
    let normalized = normalize_ui_scale_percent(Some(&json!(percent)));
    let mut prefs = read_user_preferences();
    if let Some(obj) = prefs.as_object_mut() {
        obj.insert("uiScale".to_string(), json!(normalized));
        save_user_preferences(&prefs);
    }
    normalized
}

/// Normalizes the list of monitor device keys that already received one-shot UI scale adapt.
fn normalize_ui_scale_adapted_monitors(value: Option<&Value>) -> Vec<String> {
    let Some(arr) = value.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in arr {
        let Some(raw) = entry.as_str() else {
            continue;
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_string());
        }
    }
    out
}

/// One-shot: set `uiScale` to `windows_percent` and mark `monitor_key` as adapted.
///
/// Returns `Some(normalized)` when this monitor had not been adapted yet; `None` if already known.
///
/// # Arguments
/// * `monitor_key` - Device name from `MONITORINFOEX` (e.g. `\\.\DISPLAY1`).
/// * `windows_percent` - Windows DPI percent for that monitor (will be snapped to 75–200).
pub fn adapt_ui_scale_for_new_monitor(monitor_key: &str, windows_percent: u32) -> Option<u32> {
    let key = monitor_key.trim();
    if key.is_empty() {
        return None;
    }

    let mut prefs = read_user_preferences();
    let adapted = normalize_ui_scale_adapted_monitors(prefs.get("uiScaleAdaptedMonitors"));
    if adapted.iter().any(|existing| existing == key) {
        return None;
    }

    let normalized = normalize_ui_scale_percent(Some(&json!(windows_percent)));
    let mut next_adapted = adapted;
    next_adapted.push(key.to_string());

    if let Some(obj) = prefs.as_object_mut() {
        obj.insert("uiScale".to_string(), json!(normalized));
        obj.insert(
            "uiScaleAdaptedMonitors".to_string(),
            json!(next_adapted),
        );
        save_user_preferences(&prefs);
    }

    Some(normalized)
}
