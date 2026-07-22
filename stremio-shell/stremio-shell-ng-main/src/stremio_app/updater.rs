use std::{
    io::{Read, Write},
    path::PathBuf,
};

use anyhow::{anyhow, Context};
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use semver::{Version, VersionReq};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::stremio_app::constants::{APP_DATA_DIR, GITHUB_REPO, GITHUB_USER_AGENT};

#[derive(Debug, Clone)]
pub struct Update {
    pub version: Version,
    pub file: PathBuf,
}

#[derive(Debug)]
pub struct Updater {
    pub current_version: Version,
    pub next_version: VersionReq,
    pub force_update: bool,
    pub release_candidate: bool,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    prerelease: bool,
    draft: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    /// GitHub may provide `digest: "sha256:…"` on release assets.
    #[serde(default)]
    digest: Option<String>,
}

impl Updater {
    pub fn new(current_version: Version, force_update: bool, release_candidate: bool) -> Self {
        Self {
            next_version: VersionReq::parse(&format!(">{current_version}"))
                .expect("Version is type-safe"),
            current_version,
            force_update,
            release_candidate,
        }
    }

    pub fn check_for_update(&self) -> Result<Option<Update>, anyhow::Error> {
        println!(
            "Checking GitHub releases for MyStremio v{}",
            self.current_version
        );

        let client = github_client()?;
        let release = fetch_release(&client, self.release_candidate)?;
        if release.draft {
            return Ok(None);
        }

        let version = parse_release_version(&release.tag_name)?;
        if !self.force_update && !self.next_version.matches(&version) {
            println!("Already on latest release (v{version})");
            return Ok(None);
        }

        let installer_asset = find_installer_asset(&release.assets, &version)
            .context("Release is missing MyStremioSetup-v*_x64.exe asset")?;

        let expected_sha256 = resolve_expected_sha256(&client, &release.assets, installer_asset)
            .context("Could not resolve installer SHA256 checksum")?;

        let dest = download_installer(&client, installer_asset, &expected_sha256)?;

        println!("Update ready: v{version} ({})", dest.display());
        Ok(Some(Update {
            version,
            file: dest,
        }))
    }
}

fn github_client() -> Result<Client, anyhow::Error> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(GITHUB_USER_AGENT));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github+json"),
    );
    Client::builder()
        .default_headers(headers)
        .build()
        .context("Failed to build GitHub HTTP client")
}

fn fetch_release(
    client: &Client,
    release_candidate: bool,
) -> Result<GithubRelease, anyhow::Error> {
    if release_candidate {
        let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases");
        let releases: Vec<GithubRelease> = client.get(&url).send()?.json()?;
        return releases
            .into_iter()
            .find(|release| !release.draft && (release_candidate || !release.prerelease))
            .context("No published GitHub release found");
    }

    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");
    client
        .get(&url)
        .send()?
        .json::<GithubRelease>()
        .context("Failed to read latest GitHub release")
}

fn parse_release_version(tag_name: &str) -> Result<Version, anyhow::Error> {
    let trimmed = tag_name.trim().trim_start_matches(['v', 'V']);
    Version::parse(trimmed).with_context(|| format!("Invalid release tag: {tag_name}"))
}

fn find_installer_asset<'a>(
    assets: &'a [GithubAsset],
    version: &Version,
) -> Option<&'a GithubAsset> {
    let expected = format!("MyStremioSetup-v{version}_x64.exe");
    assets
        .iter()
        .find(|asset| asset.name == expected)
        .or_else(|| {
            assets.iter().find(|asset| {
                asset.name.starts_with("MyStremioSetup-v") && asset.name.ends_with("_x64.exe")
            })
        })
}

/// Strips UTF-8 BOM and whitespace so PowerShell-generated SHA256SUMS files still parse.
fn strip_bom_and_trim(value: &str) -> &str {
    value.trim().trim_start_matches('\u{feff}').trim()
}

/// Parses a GitHub asset digest field (`sha256:…`) into a lowercase hex string.
fn parse_asset_digest(digest: &str) -> Option<String> {
    let cleaned = strip_bom_and_trim(digest);
    let hash = cleaned
        .strip_prefix("sha256:")
        .or_else(|| cleaned.strip_prefix("SHA256:"))
        .unwrap_or(cleaned);
    let hash = hash.trim().to_ascii_lowercase();
    if hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(hash)
    } else {
        None
    }
}

fn parse_sha256sums(content: &str, file_name: &str) -> Result<String, anyhow::Error> {
    let content = strip_bom_and_trim(content);
    for line in content.lines() {
        let line = strip_bom_and_trim(line);
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let hash = strip_bom_and_trim(parts.next().context("Malformed SHA256SUMS line")?)
            .to_ascii_lowercase();
        let name = strip_bom_and_trim(parts.next().context("Malformed SHA256SUMS line")?);
        if name == file_name {
            if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(anyhow!("Invalid SHA256 hash for {file_name} in SHA256SUMS.txt"));
            }
            return Ok(hash);
        }
    }
    Err(anyhow!(
        "Checksum not found for {file_name} in SHA256SUMS.txt"
    ))
}

/// Prefer SHA256SUMS.txt; fall back to the installer asset `digest` from the Releases API.
fn resolve_expected_sha256(
    client: &Client,
    assets: &[GithubAsset],
    installer_asset: &GithubAsset,
) -> Result<String, anyhow::Error> {
    if let Some(checksums_asset) = assets.iter().find(|asset| asset.name == "SHA256SUMS.txt") {
        match client
            .get(&checksums_asset.browser_download_url)
            .send()
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.text())
        {
            Ok(checksums) => match parse_sha256sums(&checksums, &installer_asset.name) {
                Ok(hash) => {
                    println!("Using checksum from SHA256SUMS.txt");
                    return Ok(hash);
                }
                Err(err) => {
                    eprintln!("SHA256SUMS.txt parse failed: {err:#}");
                }
            },
            Err(err) => {
                eprintln!("Failed to download SHA256SUMS.txt: {err:#}");
            }
        }
    } else {
        eprintln!("Release is missing SHA256SUMS.txt; trying asset digest fallback");
    }

    if let Some(digest) = installer_asset
        .digest
        .as_deref()
        .and_then(parse_asset_digest)
    {
        println!("Using checksum from GitHub asset digest");
        return Ok(digest);
    }

    Err(anyhow!(
        "No usable checksum for {} (SHA256SUMS.txt missing/invalid and asset digest unavailable)",
        installer_asset.name
    ))
}

fn download_installer(
    client: &Client,
    installer_asset: &GithubAsset,
    expected_sha256: &str,
) -> Result<PathBuf, anyhow::Error> {
    let file_name = installer_asset.name.clone();
    // Prefer AppData cache over TEMP so AV sees fewer ephemeral EXE drops.
    let cache_dir = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(APP_DATA_DIR)
        .join("updates");
    let _ = std::fs::create_dir_all(&cache_dir);
    let dest = cache_dir.join(&file_name);
    let temp_dest = std::env::temp_dir().join(&file_name);

    if dest.is_file() && file_sha256(&dest).as_deref() == Some(expected_sha256) {
        println!(
            "Reusing cached installer (checksum match): {}",
            dest.display()
        );
        return Ok(dest);
    }
    if temp_dest.is_file() && file_sha256(&temp_dest).as_deref() == Some(expected_sha256) {
        println!(
            "Reusing temp installer (checksum match): {}",
            temp_dest.display()
        );
        let _ = std::fs::copy(&temp_dest, &dest);
        return Ok(if dest.is_file() { dest } else { temp_dest });
    }

    println!(
        "Downloading {} to {}",
        installer_asset.browser_download_url,
        dest.display()
    );

    let mut installer_response = client.get(&installer_asset.browser_download_url).send()?;
    let size = installer_response.content_length();
    let mut downloaded: u64 = 0;
    let mut sha256 = Sha256::new();

    let mut chunk = [0u8; 8192];
    let mut file = std::fs::File::create(&dest)?;
    loop {
        let chunk_size = installer_response.read(&mut chunk)?;
        if chunk_size == 0 {
            break;
        }
        sha256.update(&chunk[..chunk_size]);
        file.write_all(&chunk[..chunk_size])?;
        if let Some(size) = size {
            downloaded += chunk_size as u64;
            print!("\rProgress: {}%", downloaded * 100 / size);
        } else {
            print!(".");
        }
        std::io::stdout().flush().ok();
    }
    println!();

    let actual_sha256 = format!("{:x}", sha256.finalize());
    if actual_sha256 != expected_sha256 {
        std::fs::remove_file(&dest).ok();
        return Err(anyhow!(
            "Checksum verification failed for {file_name} (expected {expected_sha256}, got {actual_sha256})"
        ));
    }

    println!("Checksum verified.");
    Ok(dest)
}

/// Computes the lowercase hex SHA-256 of a file on disk.
fn file_sha256(path: &PathBuf) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}
