mod paths;
mod registry;
mod storage;

use crate::stremio_app::discord_presence;
use paths::{app_data_dir, bundled_plugins_dir, bundled_themes_dir, ensure_asset_dirs, plugins_dir, themes_dir};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use storage::{
    clear_registered_schema, get_plugin_config, get_plugin_setting, get_registered_schema,
    list_plugin_files, list_theme_files, read_asset_metadata, read_plugin_source, read_theme_css,
    read_autoskip_settings, read_user_preferences, register_plugin_schema, save_autoskip_settings,
    save_plugin_setting, save_user_preferences,
};

static REGISTERED_SCHEMAS: OnceLock<Mutex<storage::RegisteredSchemas>> = OnceLock::new();
static PIP_RESPONSE_TX: OnceLock<Mutex<Option<flume::Sender<bool>>>> = OnceLock::new();

pub fn register_pip_response_sender(sender: flume::Sender<bool>) {
    let _ = PIP_RESPONSE_TX.set(Mutex::new(Some(sender)));
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
        "fetch-registry" => match registry::fetch_registry() {
            Ok(registry) => registry,
            Err(error) => return Some(error_response(id, &error)),
        },
        "find-installed-registry-item" => {
            let item_type = params.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let download = params.get("download").and_then(|v| v.as_str()).unwrap_or("");
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            json!(registry::find_installed_item(item_type, download, name))
        }
        "install-registry-item" => {
            let download = params.get("download").and_then(|v| v.as_str()).unwrap_or("");
            let item_type = params.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let category = params.get("category").and_then(|v| v.as_str());
            match registry::install_registry_item(download, item_type, name, category) {
                Ok(result) => result,
                Err(error) => return Some(error_response(id, &error)),
            }
        }
        "uninstall-registry-item" => {
            let item_type = params.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let file_ref = params.get("fileRef").and_then(|v| v.as_str()).unwrap_or("");
            json!(registry::uninstall_registry_item(item_type, file_ref))
        }
        "open-external-url" => {
            let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");
            json!(registry::open_external_url(url))
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

pub fn is_custom_request(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.get("stremioCustom").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

pub fn settings_saved_event(plugin_base_name: &str, config: &Value) -> String {
    json!({
        "stremioCustom": true,
        "event": "on-settings-saved",
        "pluginBaseName": plugin_base_name,
        "payload": config,
    })
    .to_string()
}

pub fn app_data_root() -> std::path::PathBuf {
    app_data_dir()
}
