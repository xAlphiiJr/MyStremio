mod introdb_proxy;
mod paths;
mod storage;

use crate::stremio_app::discord_presence;
use paths::{
    bundled_plugins_dir, bundled_themes_dir, ensure_asset_dirs, ensure_webview_user_data_dir,
    plugins_dir, themes_dir,
};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use storage::{
    clear_registered_schema, get_plugin_config, get_plugin_setting, get_registered_schema,
    list_plugin_files, list_theme_files, read_asset_metadata, read_plugin_source, read_theme_css,
    read_autoskip_settings, read_player_volume, read_ui_scale_percent, read_user_preferences,
    register_plugin_schema, save_autoskip_settings, save_player_volume, save_plugin_setting,
    save_ui_scale_percent, save_user_preferences,
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
            json!(get_plugin_setting(plugin, key))
        }
        "get-plugin-config" => {
            let plugin = params.get("pluginBaseName").and_then(|v| v.as_str()).unwrap_or("");
            json!(get_plugin_config(plugin))
        }
        "save-plugin-setting" => {
            let plugin = params.get("pluginBaseName").and_then(|v| v.as_str()).unwrap_or("");
            let key = params.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let value = params.get("value").cloned().unwrap_or(Value::Null);
            let config = save_plugin_setting(plugin, key, value);
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

