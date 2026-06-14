use crate::stremio_app::constants::APP_DATA_DIR;
use std::{
    env,
    fs,
    path::{Path, PathBuf},
};

const PLUGIN_EXT: &str = ".plugin.js";
const THEME_EXT: &str = ".theme.css";

pub fn app_data_dir() -> PathBuf {
    env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
        .join(APP_DATA_DIR)
}

pub fn plugins_dir() -> PathBuf {
    app_data_dir().join("plugins")
}

pub fn themes_dir() -> PathBuf {
    app_data_dir().join("themes")
}

pub fn bundled_root() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|mut path| {
            path.pop();
            Some(path)
        })
        .unwrap_or_else(env::temp_dir)
}

pub fn bundled_plugins_dir() -> PathBuf {
    bundled_root().join("plugins")
}

pub fn bundled_themes_dir() -> PathBuf {
    bundled_root().join("themes")
}

pub fn ensure_asset_dirs() {
    let _ = fs::create_dir_all(plugins_dir());
    let _ = fs::create_dir_all(themes_dir());
    sync_bundled_assets(&bundled_plugins_dir(), &plugins_dir(), PLUGIN_EXT);
    sync_bundled_assets(&bundled_themes_dir(), &themes_dir(), THEME_EXT);
}

fn sync_bundled_assets(source: &Path, target: &Path, extension: &str) {
    if !source.exists() {
        return;
    }

    let _ = fs::create_dir_all(target);
    copy_tree(source, target, extension);
}

fn copy_tree(source: &Path, target: &Path, extension: &str) {
    let entries = match fs::read_dir(source) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let child_target = target.join(entry.file_name());
            let _ = fs::create_dir_all(&child_target);
            copy_tree(&path, &child_target, extension);
            continue;
        }

        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(extension))
        {
            let destination = target.join(entry.file_name());
            if !destination.exists() {
                let _ = fs::copy(&path, &destination);
            }
        }
    }
}

pub fn walk_files(dir: &Path, extension: &str) -> Vec<String> {
    if !dir.exists() {
        return Vec::new();
    }

    let mut files = Vec::new();
    walk_files_inner(dir, dir, extension, &mut files);
    files.sort();
    files
}

fn walk_files_inner(root: &Path, current: &Path, extension: &str, files: &mut Vec<String>) {
    let entries = match fs::read_dir(current) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files_inner(root, &path, extension, files);
            continue;
        }

        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| format!(".{ext}") == extension || path.to_string_lossy().ends_with(extension))
        {
            if let Ok(relative) = path.strip_prefix(root) {
                files.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

pub fn resolve_asset_path(relative_path: &str) -> Option<PathBuf> {
    let normalized = relative_path.replace('\\', "/");
    if normalized.is_empty() {
        return None;
    }

    let direct = plugins_dir().join(&normalized);
    if direct.exists() {
        return Some(direct);
    }

    let theme_direct = themes_dir().join(&normalized);
    if theme_direct.exists() {
        return Some(theme_direct);
    }

    let file_name = Path::new(&normalized)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())?;

    for file in walk_files(&plugins_dir(), PLUGIN_EXT) {
        if file.ends_with(&file_name) {
            return Some(plugins_dir().join(&file));
        }
    }

    for file in walk_files(&themes_dir(), THEME_EXT) {
        if file.ends_with(&file_name) {
            return Some(themes_dir().join(&file));
        }
    }

    None
}
