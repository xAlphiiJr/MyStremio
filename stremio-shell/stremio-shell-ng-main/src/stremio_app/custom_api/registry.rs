use super::paths::{plugins_dir, themes_dir, walk_files};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

const REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/REVENGE977/stremio-enhanced-registry/main/registry.json";
const PLUGIN_EXT: &str = ".plugin.js";
const THEME_EXT: &str = ".theme.css";
const PLUGIN_CATEGORIES: [&str; 5] = ["player", "interface", "metadata", "addons", "utilities"];

pub fn fetch_registry() -> Result<Value, String> {
    let response = reqwest::blocking::get(REGISTRY_URL).map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Registry request failed ({})", response.status()));
    }
    response.json::<Value>().map_err(|e| e.to_string())
}

pub fn find_installed_item(item_type: &str, download_url: &str, fallback_name: &str) -> Option<String> {
    let extension = extension_for_type(item_type);
    let expected_name = derive_file_name(download_url, item_type, fallback_name);
    let files = walk_files(&target_dir(item_type), extension);
    let expected_base = Path::new(&expected_name)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())?;

    files
        .iter()
        .find(|file| **file == expected_name || Path::new(file).file_name().is_some_and(|name| name == expected_base.as_str()))
        .cloned()
}

pub fn install_registry_item(
    download_url: &str,
    item_type: &str,
    fallback_name: &str,
    registry_category: Option<&str>,
) -> Result<Value, String> {
    let response = reqwest::blocking::get(download_url).map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Download failed ({})", response.status()));
    }
    let content = response.text().map_err(|e| e.to_string())?;
    let file_name = derive_file_name(download_url, item_type, fallback_name);
    let target_dir = target_dir(item_type);

    let relative_path = if item_type == "plugin" {
        let category = registry_category
            .and_then(normalize_plugin_category)
            .or_else(|| read_category_from_content(&content))
            .unwrap_or_else(|| infer_plugin_category(&content, download_url, fallback_name));
        let category_dir = target_dir.join(&category);
        fs::create_dir_all(&category_dir).map_err(|e| e.to_string())?;
        let absolute = category_dir.join(&file_name);
        fs::write(&absolute, &content).map_err(|e| e.to_string())?;
        format!("{category}/{file_name}")
    } else {
        fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
        let absolute = target_dir.join(&file_name);
        fs::write(&absolute, &content).map_err(|e| e.to_string())?;
        file_name.clone()
    };

    Ok(json!({
        "fileName": file_name,
        "relativePath": relative_path.replace('\\', "/"),
        "absolutePath": target_dir.join(&relative_path).to_string_lossy(),
    }))
}

pub fn uninstall_registry_item(item_type: &str, file_ref: &str) -> bool {
    let extension = extension_for_type(item_type);
    let files = walk_files(&target_dir(item_type), extension);
    let normalized = file_ref.replace('\\', "/");
    let base_name = Path::new(&normalized)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();

    let Some(matched) = files
        .iter()
        .find(|file| **file == normalized || Path::new(file).file_name().is_some_and(|name| name == base_name.as_str()))
    else {
        return false;
    };

    let target_path = target_dir(item_type).join(matched);
    if target_path.exists() {
        fs::remove_file(target_path).is_ok()
    } else {
        false
    }
}

pub fn open_external_url(url: &str) -> bool {
    if url.starts_with("https://") || url.starts_with("http://") {
        open::that(url).is_ok()
    } else {
        false
    }
}

fn target_dir(item_type: &str) -> PathBuf {
    if item_type == "theme" {
        themes_dir()
    } else {
        plugins_dir()
    }
}

fn extension_for_type(item_type: &str) -> &'static str {
    if item_type == "theme" {
        THEME_EXT
    } else {
        PLUGIN_EXT
    }
}

fn derive_file_name(download_url: &str, item_type: &str, fallback_name: &str) -> String {
    let extension = extension_for_type(item_type);
    let mut file_name = url::Url::parse(download_url)
        .ok()
        .and_then(|parsed| {
            parsed
                .path_segments()
                .and_then(|segments| segments.last().map(|segment| segment.to_string()))
        })
        .map(|segment| urlencoding::decode(&segment).map(|value| value.into_owned()).unwrap_or(segment))
        .unwrap_or_default();

    if file_name.is_empty() || file_name == "/" || !file_name.contains('.') {
        let safe_name = fallback_name
            .to_lowercase()
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .collect::<String>()
            .trim_matches('-')
            .to_string();
        file_name = format!("{safe_name}{extension}");
    }

    if !file_name.ends_with(extension) {
        let stem = file_name.trim_end_matches(".js").trim_end_matches(".css");
        file_name = format!("{stem}{extension}");
    }

    file_name
}

fn normalize_plugin_category(raw: &str) -> Option<String> {
    let normalized = raw.to_lowercase();
    if PLUGIN_CATEGORIES.contains(&normalized.as_str()) {
        return Some(normalized);
    }
    if normalized.contains("player") {
        return Some("player".to_string());
    }
    if normalized.contains("interface") || normalized.contains("ui") {
        return Some("interface".to_string());
    }
    if normalized.contains("metadata") || normalized.contains("meta") {
        return Some("metadata".to_string());
    }
    if normalized.contains("addon") {
        return Some("addons".to_string());
    }
    if normalized.contains("util") {
        return Some("utilities".to_string());
    }
    None
}

fn read_category_from_content(content: &str) -> Option<String> {
    for line in content.lines().take(40) {
        if let Some(value) = line.strip_prefix("@category ") {
            return normalize_plugin_category(value.trim());
        }
    }
    None
}

fn infer_plugin_category(content: &str, download_url: &str, fallback_name: &str) -> String {
    let haystack = format!(
        "{} {} {}",
        download_url.to_lowercase(),
        fallback_name.to_lowercase(),
        content.chars().take(1200).collect::<String>().to_lowercase()
    );

    if regex_like_player(&haystack) {
        return "player".to_string();
    }
    if haystack.contains("addon-manager") || haystack.contains("stremio-addon-manager") {
        return "addons".to_string();
    }
    if regex_like_interface(&haystack) {
        return "interface".to_string();
    }
    if regex_like_metadata(&haystack) {
        return "metadata".to_string();
    }
    if haystack.contains("dom-inspector") || haystack.contains("utilities") {
        return "utilities".to_string();
    }
    "utilities".to_string()
}

fn regex_like_player(haystack: &str) -> bool {
    [
        "aniskip",
        "tidb",
        "skip-intro",
        "skip_intro",
        "filter-stream",
        "picture-in-picture",
        "enhanced-player",
        "stream-quality",
        "external-player",
        "intro.?skip",
    ]
    .iter()
    .any(|needle| haystack.contains(needle))
}

fn regex_like_interface(haystack: &str) -> bool {
    [
        "slash",
        "search",
        "navigation",
        "titlebar",
        "title-bar",
        "hero",
        "covers",
        "initializer",
        "glass",
        "context-menu",
        "enhancements",
        "horizontal-navigation",
    ]
    .iter()
    .any(|needle| haystack.contains(needle))
}

fn regex_like_metadata(haystack: &str) -> bool {
    [
        "meta-hover",
        "trending",
        "playback-preview",
        "data-enrichment",
        "card-hover",
        "hover-panel",
        "hover-info",
    ]
    .iter()
    .any(|needle| haystack.contains(needle))
}
