//! Shared API-key vault and schema-based service discovery.
//!
//! Keys are stored once per **service** (e.g. `tmdb`) in `mystremio-settings.json`
//! under `apiKeys`. Plugin schema fields that look like API keys map onto those
//! services so every installed plugin that declares the same field reuses one value.

use super::paths::{plugins_dir, walk_files};
use super::storage::{
    get_plugin_config, load_registered_schemas, read_asset_metadata, read_user_preferences,
    save_user_preferences, RegisteredSchemas,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Mutex;

const PLUGIN_EXT: &str = ".plugin.js";

/// Returns true when a schema field key should be treated as an API key.
pub fn is_api_key_field(key: &str) -> bool {
    let normalized = key.to_lowercase();
    normalized.contains("apikey")
        || normalized.contains("api_key")
        || normalized.ends_with("token")
}

/// Maps a plugin setting field key onto a shared service id.
///
/// Known aliases: TMDB, RPDB, TheIntroDB, IntroDB. Unknown keys become a
/// normalized service id so future plugins still appear in the hub.
pub fn service_id_for_field_key(key: &str) -> String {
    let lower = key.to_lowercase();
    if lower.contains("tmdb") {
        return "tmdb".to_string();
    }
    if lower.contains("rpdb") {
        return "rpdb".to_string();
    }
    if lower == "tidb_api_key"
        || lower.contains("theintrodb")
        || (lower.contains("tidb") && lower.contains("api"))
    {
        return "theintrodb".to_string();
    }
    if lower.contains("introdb") {
        return "introdb".to_string();
    }

    let mut id = lower
        .replace("api_key", "")
        .replace("apikey", "")
        .replace('_', "")
        .replace('-', "");
    id = id.trim().to_string();
    if id.is_empty() {
        key.to_lowercase()
    } else {
        id
    }
}

fn service_label(service_id: &str) -> String {
    match service_id {
        "tmdb" => "TMDB API Key".to_string(),
        "rpdb" => "RPDB API Key".to_string(),
        "theintrodb" => "TheIntroDB API Key".to_string(),
        "introdb" => "IntroDB API Key".to_string(),
        other => format!("{} API Key", title_case(other)),
    }
}

/// Whether this service has a canonical display name (ignore schema "API Key").
fn is_known_service(service_id: &str) -> bool {
    matches!(service_id, "tmdb" | "rpdb" | "theintrodb" | "introdb")
}

/// Resolves the hub / status label for a service.
///
/// Known services always use [`service_label`]. Unknown services may use the schema
/// label unless it is the generic `"API Key"`.
fn resolve_service_label(service_id: &str, schema_label: Option<&str>) -> String {
    if is_known_service(service_id) {
        return service_label(service_id);
    }
    schema_label
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|s| !s.eq_ignore_ascii_case("API Key"))
        .map(|s| s.to_string())
        .unwrap_or_else(|| service_label(service_id))
}

fn service_docs_url(service_id: &str) -> &'static str {
    match service_id {
        "tmdb" => "https://www.themoviedb.org/settings/api",
        "rpdb" => "https://ratingposterdb.com/",
        "theintrodb" => "https://theintrodb.org/docs",
        "introdb" => "https://introdb.app/account",
        _ => "",
    }
}

fn title_case(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Normalizes the `apiKeys` object from preferences.
pub fn normalize_api_keys(value: Option<&Value>) -> Value {
    let mut out = Map::new();
    if let Some(obj) = value.and_then(|v| v.as_object()) {
        for (key, raw) in obj {
            let trimmed = raw
                .as_str()
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            out.insert(key.clone(), json!(trimmed));
        }
    }
    Value::Object(out)
}

fn read_api_keys_map() -> Map<String, Value> {
    read_user_preferences()
        .get("apiKeys")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

fn write_api_keys_map(map: Map<String, Value>) {
    let mut prefs = read_user_preferences();
    if let Some(obj) = prefs.as_object_mut() {
        obj.insert("apiKeys".to_string(), Value::Object(map));
        save_user_preferences(&prefs);
    }
}

/// Returns the shared key for a service, or empty string.
pub fn get_api_key(service_id: &str) -> String {
    ensure_api_keys_migrated();
    read_api_keys_map()
        .get(service_id)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

/// Persists a shared API key for a service id.
pub fn set_api_key(service_id: &str, value: &str) -> String {
    ensure_api_keys_migrated();
    let trimmed = value.trim().to_string();
    let mut map = read_api_keys_map();
    map.insert(service_id.to_string(), json!(trimmed));
    write_api_keys_map(map);
    trimmed
}

/// Resolves a plugin setting through the shared vault when the field is an API key.
pub fn resolve_plugin_setting(plugin_base_name: &str, key: &str, schemas: &Mutex<RegisteredSchemas>) -> Option<Value> {
    if !is_api_key_field(key) {
        return None;
    }
    if !plugin_declares_key(plugin_base_name, key, schemas) {
        // Still allow known shared keys even if schema cache is stale.
        if service_id_for_field_key(key).is_empty() {
            return None;
        }
    }
    let service = service_id_for_field_key(key);
    let value = get_api_key(&service);
    Some(if value.is_empty() {
        Value::Null
    } else {
        json!(value)
    })
}

/// Saves an API-key plugin setting into the shared vault.
pub fn save_shared_plugin_setting(key: &str, value: &Value) -> Option<String> {
    if !is_api_key_field(key) {
        return None;
    }
    let service = service_id_for_field_key(key);
    let raw = value.as_str().unwrap_or("").trim();
    Some(set_api_key(&service, raw))
}

fn plugin_declares_key(
    plugin_base_name: &str,
    key: &str,
    schemas: &Mutex<RegisteredSchemas>,
) -> bool {
    let schema = schemas
        .lock()
        .ok()
        .and_then(|guard| guard.get(plugin_base_name).cloned())
        .or_else(|| {
            // Fall back to disk scan if in-memory cache misses.
            load_registered_schemas().get(plugin_base_name).cloned()
        });
    let Some(Value::Array(fields)) = schema else {
        return false;
    };
    fields.iter().any(|field| {
        field
            .get("key")
            .and_then(|v| v.as_str())
            .map(|k| k == key)
            .unwrap_or(false)
    })
}

fn plugin_display_name(plugin_base_name: &str) -> String {
    for file in walk_files(&plugins_dir(), PLUGIN_EXT) {
        let base = Path::new(&file)
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.trim_end_matches(PLUGIN_EXT).to_string());
        if base.as_deref() != Some(plugin_base_name) {
            continue;
        }
        let meta = read_asset_metadata(&file);
        if let Some(name) = meta.get("name").and_then(|v| v.as_str()) {
            if !name.trim().is_empty() {
                return name.trim().to_string();
            }
        }
    }
    plugin_base_name.to_string()
}

/// Discovers API-key services from all installed plugin schemas.
pub fn list_api_key_services(schemas: &Mutex<RegisteredSchemas>) -> Value {
    ensure_api_keys_migrated();

    // Refresh from disk so newly installed plugins appear without restart.
    let disk_schemas = load_registered_schemas();
    if let Ok(mut guard) = schemas.lock() {
        *guard = disk_schemas.clone();
    }

    let vault = read_api_keys_map();
    let mut services: BTreeMap<String, ServiceAccum> = BTreeMap::new();

    for (plugin_base, schema) in disk_schemas.iter() {
        let Value::Array(fields) = schema else {
            continue;
        };
        let display = plugin_display_name(plugin_base);
        for field in fields {
            let Some(key) = field.get("key").and_then(|v| v.as_str()) else {
                continue;
            };
            if !is_api_key_field(key) {
                continue;
            }
            let service_id = service_id_for_field_key(key);
            let entry = services.entry(service_id.clone()).or_insert_with(|| {
                let label = resolve_service_label(
                    &service_id,
                    field.get("label").and_then(|v| v.as_str()),
                );
                ServiceAccum {
                    label,
                    docs_url: service_docs_url(&service_id).to_string(),
                    field_keys: Vec::new(),
                    used_by: Vec::new(),
                }
            });
            if !entry.field_keys.iter().any(|k| k == key) {
                entry.field_keys.push(key.to_string());
            }
            if !entry.used_by.iter().any(|p| p == &display) {
                entry.used_by.push(display.clone());
            }
            if entry.docs_url.is_empty() {
                if let Some(desc) = field.get("description").and_then(|v| v.as_str()) {
                    if let Some(url) = extract_http_url(desc) {
                        entry.docs_url = url;
                    }
                }
            }
        }
    }

    let list: Vec<Value> = services
        .into_iter()
        .map(|(id, accum)| {
            let value = vault
                .get(&id)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            json!({
                "id": id,
                "label": accum.label,
                "docsUrl": accum.docs_url,
                "fieldKeys": accum.field_keys,
                "usedBy": accum.used_by,
                "value": value,
                "isSet": !value.trim().is_empty(),
            })
        })
        .collect();

    json!(list)
}

struct ServiceAccum {
    label: String,
    docs_url: String,
    field_keys: Vec<String>,
    used_by: Vec<String>,
}

fn extract_http_url(text: &str) -> Option<String> {
    let start = text.find("https://").or_else(|| text.find("http://"))?;
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == ')' || c == ']' || c == '"' || c == '\'')
        .unwrap_or(rest.len());
    Some(rest[..end].trim_end_matches(['.', ',', ';']).to_string())
}

/// One-time migration: seed shared vault from per-plugin config files.
pub fn ensure_api_keys_migrated() {
    static MIGRATED: std::sync::Once = std::sync::Once::new();
    MIGRATED.call_once(|| {
        let mut map = read_api_keys_map();
        let mut changed = false;

        let candidates: &[(&str, &str)] = &[
            ("data-enrichment", "tmdbApiKey"),
            ("cast-overlay", "tmdbApiKey"),
            ("data-enrichment", "rpdbApiKey"),
            ("tidb", "tidb_api_key"),
            ("tidb", "introdb_api_key"),
            ("meta-hover-panel", "tmdbApiKey"),
            ("detail-slogan", "tmdbApiKey"),
        ];

        for (plugin, key) in candidates {
            let service = service_id_for_field_key(key);
            let existing = map
                .get(&service)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("");
            if !existing.is_empty() {
                continue;
            }
            let from_plugin = get_plugin_config(plugin)
                .get(*key)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            if from_plugin.is_empty() {
                continue;
            }
            map.insert(service, json!(from_plugin));
            changed = true;
        }

        // Also scan every installed schema for any leftover keys.
        for (plugin_base, schema) in load_registered_schemas() {
            let Value::Array(fields) = schema else {
                continue;
            };
            let config = get_plugin_config(&plugin_base);
            for field in fields {
                let Some(key) = field.get("key").and_then(|v| v.as_str()) else {
                    continue;
                };
                if !is_api_key_field(key) {
                    continue;
                }
                let service = service_id_for_field_key(key);
                let existing = map
                    .get(&service)
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .unwrap_or("");
                if !existing.is_empty() {
                    continue;
                }
                let from_plugin = config
                    .get(key)
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .unwrap_or("")
                    .to_string();
                if from_plugin.is_empty() {
                    continue;
                }
                map.insert(service, json!(from_plugin));
                changed = true;
            }
        }

        if changed {
            write_api_keys_map(map);
        }
    });
}

/// Status rows for a single plugin's API-key fields (for plugin settings UI).
pub fn plugin_api_key_status(
    plugin_base_name: &str,
    schemas: &Mutex<RegisteredSchemas>,
) -> Value {
    ensure_api_keys_migrated();
    let schema = schemas
        .lock()
        .ok()
        .and_then(|guard| guard.get(plugin_base_name).cloned())
        .or_else(|| load_registered_schemas().get(plugin_base_name).cloned());
    let Some(Value::Array(fields)) = schema else {
        return json!([]);
    };

    let mut seen = HashMap::new();
    let mut rows = Vec::new();
    for field in fields {
        let Some(key) = field.get("key").and_then(|v| v.as_str()) else {
            continue;
        };
        if !is_api_key_field(key) {
            continue;
        }
        let service = service_id_for_field_key(key);
        if seen.contains_key(&service) {
            continue;
        }
        seen.insert(service.clone(), true);
        let value = get_api_key(&service);
        let label = resolve_service_label(&service, field.get("label").and_then(|v| v.as_str()));
        rows.push(json!({
            "serviceId": service,
            "fieldKey": key,
            "label": label,
            "isSet": !value.trim().is_empty(),
        }));
    }
    json!(rows)
}
