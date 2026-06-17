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
    let normalized = normalize_preferences(preferences.clone());
    if let Some(parent) = preferences_path().parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(&normalized) {
        let _ = fs::write(preferences_path(), content);
    }
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
        }
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

    json!({
        "enabledPlugins": enabled,
        "currentTheme": current_theme,
        "autoskip": autoskip,
        "metadataAddon": metadata_addon,
        "preload": preload,
        "discordPresence": discord_presence,
        "library": library,
        "language": language,
        "onboarding": onboarding
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

fn write_json_object(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(value) {
        let _ = fs::write(path, content);
    }
}
