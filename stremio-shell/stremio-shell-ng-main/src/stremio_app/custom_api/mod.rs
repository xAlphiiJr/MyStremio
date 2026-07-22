mod aniskip_proxy;
mod api_keys;
mod introdb_proxy;
mod paths;
mod storage;

use crate::stremio_app::discord_presence;
use paths::{
    bundled_plugins_dir, bundled_root, bundled_themes_dir, ensure_asset_dirs,
    ensure_webview_user_data_dir, plugins_dir, themes_dir,
};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use storage::{
    clear_registered_schema, get_plugin_config, get_plugin_setting, get_registered_schema,
    list_plugin_files, list_theme_files, load_registered_schemas, read_asset_metadata,
    read_plugin_source, read_theme_css, read_autoskip_settings, read_player_volume,
    read_ui_scale_percent, read_user_preferences, register_plugin_schema, save_autoskip_settings,
    save_player_volume, save_plugin_setting, save_ui_scale_percent, save_user_preferences,
};

static REGISTERED_SCHEMAS: OnceLock<Mutex<storage::RegisteredSchemas>> = OnceLock::new();
static PIP_RESPONSE_TX: OnceLock<Mutex<Option<flume::Sender<bool>>>> = OnceLock::new();
static UI_SCALE_APPLY_TX: OnceLock<Mutex<Option<flume::Sender<()>>>> = OnceLock::new();

pub fn register_pip_response_sender(sender: flume::Sender<bool>) {
    let _ = PIP_RESPONSE_TX.set(Mutex::new(Some(sender)));
}

pub fn register_ui_scale_apply_sender(sender: flume::Sender<()>) {
    let _ = UI_SCALE_APPLY_TX.set(Mutex::new(Some(sender)));
}

pub fn request_ui_scale_apply() {
    if let Some(lock) = UI_SCALE_APPLY_TX.get() {
        if let Ok(guard) = lock.lock() {
            if let Some(sender) = guard.as_ref() {
                sender.send(()).ok();
            }
        }
    }
}

pub fn read_ui_scale() -> u32 {
    read_ui_scale_percent()
}

pub use storage::adapt_ui_scale_for_new_monitor;

pub fn complete_pip_toggle(active: bool) {
    if let Some(lock) = PIP_RESPONSE_TX.get() {
        if let Ok(guard) = lock.lock() {
            if let Some(sender) = guard.as_ref() {
                sender.send(active).ok();
            }
        }
    }
}

fn schemas() -> &'static Mutex<storage::RegisteredSchemas> {
    REGISTERED_SCHEMAS.get_or_init(|| Mutex::new(storage::load_registered_schemas()))
}

pub fn init() {
    ensure_asset_dirs();
    storage::migrate_root_plugin_litter();
    ensure_webview_user_data_dir();
}

pub fn webview_user_data_dir() -> std::path::PathBuf {
    paths::webview_user_data_dir()
}

pub fn build_early_storage_restore_script() -> String {
    storage::build_early_storage_restore_script()
}

pub fn handle_request(message: &Value) -> Option<String> {
    let method = message.get("method")?.as_str()?;
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    let result = match method {
        "get-paths" => json!({
            "pluginsPath": plugins_dir().to_string_lossy(),
            "themesPath": themes_dir().to_string_lossy(),
            "bundledPluginsPath": bundled_plugins_dir().to_string_lossy(),
            "bundledThemesPath": bundled_themes_dir().to_string_lossy(),
            "shadersPath": bundled_root().join("shaders").to_string_lossy(),
        }),
        "open-folder" => {
            let folder = params
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !folder.is_empty() {
                open::that(folder).ok();
            }
            json!(true)
        }
        "list-plugins" => json!(list_plugin_files()),
        "list-themes" => json!(list_theme_files()),
        "read-theme" => {
            let file_name = params.get("fileName").and_then(|v| v.as_str()).unwrap_or("");
            json!(read_theme_css(file_name))
        }
        "read-plugin" => {
            let file_ref = params.get("fileRef").and_then(|v| v.as_str()).unwrap_or("");
            json!(read_plugin_source(file_ref))
        }
        "get-metadata" => {
            let relative_path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
            json!(read_asset_metadata(relative_path))
        }
        "get-user-preferences" => json!(read_user_preferences()),
        "save-user-preferences" => {
            save_user_preferences(&params);
            json!(true)
        }
        "get-autoskip-settings" => json!(read_autoskip_settings()),
        "save-autoskip-settings" => {
            save_autoskip_settings(&params);
            json!(true)
        }
        "get-player-volume" => json!(read_player_volume()),
        "save-player-volume" => {
            save_player_volume(&params);
            json!(true)
        }
        "get-plugin-setting" => {
            let plugin = params.get("pluginBaseName").and_then(|v| v.as_str()).unwrap_or("");
            let key = params.get("key").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(shared) = api_keys::resolve_plugin_setting(plugin, key, schemas()) {
                json!(shared)
            } else {
                json!(get_plugin_setting(plugin, key))
            }
        }
        "get-plugin-config" => {
            let plugin = params.get("pluginBaseName").and_then(|v| v.as_str()).unwrap_or("");
            let mut config = get_plugin_config(plugin);
            // Overlay shared API keys so plugins that read full config still see vault values.
            let registered = get_registered_schema(schemas(), plugin);
            let schema = match registered {
                Value::Array(ref fields) if !fields.is_empty() => registered,
                _ => load_registered_schemas()
                    .get(plugin)
                    .cloned()
                    .unwrap_or_else(|| Value::Array(Vec::new())),
            };
            let fields = if let Value::Array(fields) = schema {
                fields
            } else {
                Vec::new()
            };
            if let Some(obj) = config.as_object_mut() {
                for field in fields {
                    let Some(key) = field.get("key").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    if !api_keys::is_api_key_field(key) {
                        continue;
                    }
                    let service = api_keys::service_id_for_field_key(key);
                    let value = api_keys::get_api_key(&service);
                    obj.insert(
                        key.to_string(),
                        if value.is_empty() {
                            Value::Null
                        } else {
                            json!(value)
                        },
                    );
                }
            }
            json!(config)
        }
        "save-plugin-setting" => {
            let plugin = params.get("pluginBaseName").and_then(|v| v.as_str()).unwrap_or("");
            let key = params.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let value = params.get("value").cloned().unwrap_or(Value::Null);
            let config = if let Some(saved) = api_keys::save_shared_plugin_setting(key, &value) {
                // Keep plugin JSON free of secrets; return overlayed config for listeners.
                let mut config = get_plugin_config(plugin);
                if let Some(obj) = config.as_object_mut() {
                    obj.insert(key.to_string(), json!(saved));
                }
                config
            } else {
                save_plugin_setting(plugin, key, value)
            };
            return Some(
                json!({
                    "stremioCustom": true,
                    "id": id,
                    "result": true,
                    "event": "on-settings-saved",
                    "pluginBaseName": plugin,
                    "payload": config,
                })
                .to_string(),
            );
        }
        "list-api-key-services" => api_keys::list_api_key_services(schemas()),
        "get-api-key" => {
            let service_id = params.get("serviceId").and_then(|v| v.as_str()).unwrap_or("");
            json!(api_keys::get_api_key(service_id))
        }
        "set-api-key" => {
            let service_id = params.get("serviceId").and_then(|v| v.as_str()).unwrap_or("");
            let value = params.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let saved = api_keys::set_api_key(service_id, value);
            // Collect plugin bases that use this service so the UI can refresh listeners.
            let mut plugin_bases = Vec::new();
            if let Ok(guard) = schemas().lock() {
                for (plugin_base, schema) in guard.iter() {
                    let Value::Array(fields) = schema else {
                        continue;
                    };
                    let uses = fields.iter().any(|field| {
                        field
                            .get("key")
                            .and_then(|v| v.as_str())
                            .map(|key| {
                                api_keys::is_api_key_field(key)
                                    && api_keys::service_id_for_field_key(key) == service_id
                            })
                            .unwrap_or(false)
                    });
                    if uses {
                        plugin_bases.push(plugin_base.clone());
                    }
                }
            }
            return Some(
                json!({
                    "stremioCustom": true,
                    "id": id,
                    "result": saved,
                    "event": "on-api-key-saved",
                    "serviceId": service_id,
                    "pluginBaseNames": plugin_bases,
                    "payload": saved,
                })
                .to_string(),
            );
        }
        "get-plugin-api-key-status" => {
            let plugin = params.get("pluginBaseName").and_then(|v| v.as_str()).unwrap_or("");
            api_keys::plugin_api_key_status(plugin, schemas())
        }
        "register-plugin-settings" => {
            let plugin = params.get("pluginBaseName").and_then(|v| v.as_str()).unwrap_or("");
            let schema = params.get("schema").cloned().unwrap_or(Value::Null);
            let ok = register_plugin_schema(schemas(), plugin, schema);
            json!(ok)
        }
        "get-registered-settings" => {
            let plugin = params.get("pluginBaseName").and_then(|v| v.as_str()).unwrap_or("");
            json!(get_registered_schema(schemas(), plugin))
        }
        "read-language-names" => json!(storage::read_language_names()),
        "clear-registered-settings" => {
            let plugin = params.get("pluginBaseName").and_then(|v| v.as_str()).unwrap_or("");
            json!(clear_registered_schema(schemas(), plugin))
        }
        "open-external-url" => {
            let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let opened = if url.starts_with("https://") || url.starts_with("http://") {
                open::that(url).is_ok()
            } else {
                false
            };
            json!(opened)
        }
        "update-discord-presence" => {
            match discord_presence::update_presence(&params) {
                Ok(()) => json!(true),
                Err(error) => return Some(error_response(id, &error)),
            }
        }
        "clear-discord-presence" => {
            match discord_presence::clear_presence() {
                Ok(()) => json!(true),
                Err(error) => return Some(error_response(id, &error)),
            }
        }
        "introdb-get-segments" => {
            let imdb_id = params.get("imdbId").and_then(|v| v.as_str()).unwrap_or("");
            let season = params.get("season").and_then(|v| v.as_u64()).unwrap_or(0);
            let episode = params.get("episode").and_then(|v| v.as_u64()).unwrap_or(0);
            match introdb_proxy::get_segments(imdb_id, season, episode) {
                Ok(payload) => json!(payload),
                Err(error) => return Some(error_response(id, &error)),
            }
        }
        "introdb-submit" => {
            let api_key = params.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
            let body = params.get("body").cloned().unwrap_or(Value::Null);
            match introdb_proxy::submit_segment(api_key, &body) {
                Ok(payload) => json!(payload),
                Err(error) => return Some(error_response(id, &error)),
            }
        }
        "aniskip-get-skip-times" => {
            let mal_id = params.get("malId").and_then(|v| v.as_u64()).unwrap_or(0);
            let episode = params.get("episode").and_then(|v| v.as_u64()).unwrap_or(0);
            let episode_length = params
                .get("episodeLength")
                .and_then(|v| v.as_f64())
                .filter(|v| *v > 0.0);
            match aniskip_proxy::get_skip_times(mal_id, episode, episode_length) {
                Ok(payload) => json!(payload),
                Err(error) => return Some(error_response(id, &error)),
            }
        }
        "aniskip-resolve-mal-kitsu" => {
            let kitsu_id = params.get("kitsuId").and_then(|v| v.as_u64()).unwrap_or(0);
            match aniskip_proxy::resolve_mal_from_kitsu(kitsu_id) {
                Ok(mal_id) => json!({ "malId": mal_id }),
                Err(error) => return Some(error_response(id, &error)),
            }
        }
        "aniskip-resolve-mal-jikan" => {
            let title = params.get("title").and_then(|v| v.as_str()).unwrap_or("");
            match aniskip_proxy::resolve_mal_from_jikan(title) {
                Ok(mal_id) => json!({ "malId": mal_id }),
                Err(error) => return Some(error_response(id, &error)),
            }
        }
        "aniskip-resolve-mal-kitsu-title" => {
            let title = params.get("title").and_then(|v| v.as_str()).unwrap_or("");
            match aniskip_proxy::resolve_mal_from_kitsu_title(title) {
                Ok(mal_id) => json!({ "malId": mal_id }),
                Err(error) => return Some(error_response(id, &error)),
            }
        }
        "get-ui-scale" => json!(read_ui_scale_percent()),
        "apply-ui-scale" => {
            request_ui_scale_apply();
            json!(read_ui_scale_percent())
        }
        "set-ui-scale" => {
            let percent = params
                .get("percent")
                .and_then(|v| {
                    v.as_u64().or_else(|| {
                        v.as_i64().map(|n| if n < 0 { 0 } else { n as u64 })
                    })
                })
                .unwrap_or(100) as u32;
            let normalized = save_ui_scale_percent(percent);
            request_ui_scale_apply();
            json!(normalized)
        }
        _ => return None,
    };

    Some(
        json!({
            "stremioCustom": true,
            "id": id,
            "result": result,
        })
        .to_string(),
    )
}

fn error_response(id: Value, message: &str) -> String {
    json!({
        "stremioCustom": true,
        "id": id,
        "error": message,
    })
    .to_string()
}

pub fn player_volume() -> Value {
    read_player_volume()
}

pub fn is_custom_request(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.get("stremioCustom").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

