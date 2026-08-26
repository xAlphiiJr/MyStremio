//! Multi-source title/episode ratings with deep links for the Meta ratings bar.
//!
//! Scores come from Aggregator, Cinemeta, MDBList, TMDB, Trakt, Jikan, and (episodes)
//! TVMaze. Each rating may include a `url` pointing at the real source page.

use super::api_keys;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const AGGREGATOR_BASE: &str = "https://rating-aggregator.elfhosted.com";
const CINEMETA_BASE: &str = "https://v3-cinemeta.strem.io/meta";
const TRAKT_BASE: &str = "https://api.trakt.tv";
const JIKAN_BASE: &str = "https://api.jikan.moe/v4";
const TMDB_BASE: &str = "https://api.themoviedb.org/3";
const TVMAZE_BASE: &str = "https://api.tvmaze.com";
const USER_AGENT_VALUE: &str = "MyStremio Ratings Proxy";
/// Per-request HTTP timeout — keep short so a hung source cannot stall the worker.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
/// Soft overall budget for the whole fan-out (IPC reply still async).
const OVERALL_BUDGET: Duration = Duration::from_millis(2000);
/// In-process ratings cache so opening the same title twice is instant.
const CACHE_TTL: Duration = Duration::from_secs(600);

struct CachedRatings {
    at: Instant,
    payload: Value,
}

fn ratings_cache() -> &'static Mutex<HashMap<String, CachedRatings>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedRatings>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_lookup(key: &str) -> Option<Value> {
    let cache = ratings_cache().lock().ok()?;
    let entry = cache.get(key)?;
    if entry.at.elapsed() < CACHE_TTL {
        Some(entry.payload.clone())
    } else {
        None
    }
}

fn cache_store(key: String, payload: &Value) {
    if let Ok(mut cache) = ratings_cache().lock() {
        cache.insert(
            key,
            CachedRatings {
                at: Instant::now(),
                payload: payload.clone(),
            },
        );
        if cache.len() > 256 {
            cache.retain(|_, item| item.at.elapsed() < CACHE_TTL);
        }
    }
}

fn merge_ratings(dst: &mut Map<String, Value>, src: Map<String, Value>) {
    for (key, value) in src {
        if !dst.contains_key(&key) {
            dst.insert(key, value);
        }
    }
}

/// Resolved external identifiers used to build deep links and episode lookups.
#[derive(Debug, Default, Clone)]
struct ResolvedIds {
    imdb: String,
    title: String,
    episode_name: String,
    episode_imdb: Option<String>,
    tmdb: Option<u64>,
    trakt_slug: Option<String>,
    trakt_id: Option<u64>,
    mal: Option<u64>,
}

fn merge_ids(dst: &mut ResolvedIds, src: ResolvedIds) {
    if dst.title.is_empty() {
        dst.title = src.title;
    }
    if dst.episode_name.is_empty() {
        dst.episode_name = src.episode_name;
    }
    if dst.episode_imdb.is_none() {
        dst.episode_imdb = src.episode_imdb;
    }
    if dst.tmdb.is_none() {
        dst.tmdb = src.tmdb;
    }
    if dst.trakt_slug.is_none() {
        dst.trakt_slug = src.trakt_slug;
    }
    if dst.trakt_id.is_none() {
        dst.trakt_id = src.trakt_id;
    }
    if dst.mal.is_none() {
        dst.mal = src.mal;
    }
}

fn default_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
    headers
}

fn normalize_imdb_id(imdb_id: &str) -> Option<String> {
    let trimmed = imdb_id.trim().to_ascii_lowercase();
    if trimmed.len() >= 9
        && trimmed.starts_with("tt")
        && trimmed[2..].chars().all(|c| c.is_ascii_digit())
    {
        Some(trimmed)
    } else {
        None
    }
}

fn normalize_media_type(media_type: &str) -> Option<&'static str> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "movie" | "film" => Some("movie"),
        "series" | "tv" | "show" => Some("series"),
        _ => None,
    }
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("Ratings client init failed: {error}"))
}

fn insert_rating(out: &mut Map<String, Value>, key: &str, label: &str, kind: &str, value: &str) {
    if out.contains_key(key) || value.is_empty() {
        return;
    }
    out.insert(
        key.to_string(),
        json!({
            "key": key,
            "label": label,
            "kind": kind,
            "value": value,
        }),
    );
}

fn set_rating_url(out: &mut Map<String, Value>, key: &str, url: &str) {
    if url.is_empty() {
        return;
    }
    if let Some(Value::Object(obj)) = out.get_mut(key) {
        obj.insert("url".to_string(), json!(url));
    }
}

fn slugify(input: &str, sep: char) -> String {
    let mut out = String::new();
    let mut last_sep = true;
    for ch in input.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            last_sep = false;
        } else if !last_sep {
            out.push(sep);
            last_sep = true;
        }
    }
    out.trim_matches(sep).to_string()
}

fn urlencoding_lite(input: &str) -> String {
    let mut out = String::new();
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn clean_rating_line(line: &str) -> String {
    let mut out = line.trim().to_string();
    for prefix in [
        "⭐", "🎥", "Ⓜ️", "👤", "🍅", "👶", "👪", "📺", "🔞", "✅", "🎯",
    ] {
        if let Some(rest) = out.strip_prefix(prefix) {
            out = rest.trim_start().to_string();
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn capture_after_label(text: &str, label: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let label_l = label.to_ascii_lowercase();
    if !lower.starts_with(&label_l) {
        return None;
    }
    let rest = text[label.len()..].trim_start();
    let rest = rest.strip_prefix(':').unwrap_or(rest).trim_start();
    let num: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if num.is_empty() {
        None
    } else {
        Some(num)
    }
}

fn capture_mc_users(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    if !lower.starts_with("mc") {
        return None;
    }
    let after_mc = text[2..].trim_start();
    if !after_mc.to_ascii_lowercase().starts_with("users") {
        return None;
    }
    let rest = after_mc[5..].trim_start();
    let rest = rest.strip_prefix(':').unwrap_or(rest).trim_start();
    let num: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if num.is_empty() {
        None
    } else {
        Some(num)
    }
}

fn parse_aggregator_description(text: &str, out: &mut Map<String, Value>) {
    for raw in text.lines() {
        let line = clean_rating_line(raw.trim());
        if line.is_empty() || line.chars().all(|c| c == '─' || c == '-') {
            continue;
        }
        if line.chars().all(|c| c.is_ascii_digit() || c == '+')
            && line.chars().filter(|c| c.is_ascii_digit()).count() <= 2
            && !line.is_empty()
        {
            let age = if line.ends_with('+') {
                line
            } else {
                format!("{line}+")
            };
            insert_rating(out, "fsk", "FSK", "age", &age);
            continue;
        }
        if let Some(caps) = capture_after_label(&line, "imdb") {
            if let Ok(v) = caps.parse::<f64>() {
                insert_rating(out, "imdb", "IMDb", "score", &format!("{v:.1}"));
            }
            continue;
        }
        if let Some(caps) = capture_after_label(&line, "tmdb") {
            if let Ok(v) = caps.parse::<f64>() {
                insert_rating(
                    out,
                    "tmdb",
                    "TMDB",
                    "percent",
                    &format!("{}%", (v * 10.0).round() as i32),
                );
            }
            continue;
        }
        if let Some(caps) = capture_mc_users(&line) {
            if let Ok(v) = caps.parse::<f64>() {
                insert_rating(out, "mcusers", "MC Users", "score", &format!("{v:.1}"));
            }
            continue;
        }
        if let Some(caps) = capture_after_label(&line, "mc") {
            insert_rating(out, "metacritic", "Metacritic", "score", &caps);
            continue;
        }
        if let Some(caps) = capture_after_label(&line, "rt") {
            insert_rating(out, "rt", "Rotten Tomatoes", "percent", &format!("{caps}%"));
        }
    }
}

fn fetch_aggregator(client: &Client, imdb_id: &str, kind: &str, out: &mut Map<String, Value>) {
    let url = format!("{AGGREGATOR_BASE}/stream/{kind}/{imdb_id}.json");
    let Ok(response) = client.get(&url).headers(default_headers()).send() else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    let Ok(payload) = response.json::<Value>() else {
        return;
    };
    let Some(streams) = payload.get("streams").and_then(|v| v.as_array()) else {
        return;
    };
    for stream in streams {
        if let Some(desc) = stream.get("description").and_then(|v| v.as_str()) {
            parse_aggregator_description(desc, out);
        }
        if let Some(name) = stream.get("name").and_then(|v| v.as_str()) {
            parse_aggregator_description(name, out);
        }
    }
}

fn json_u32(value: &Value) -> Option<u32> {
    let n = value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| if n >= 0 { Some(n as u64) } else { None }))
        .or_else(|| {
            value.as_f64().and_then(|n| {
                if n >= 0.0 && n.fract() == 0.0 {
                    Some(n as u64)
                } else {
                    None
                }
            })
        })
        .or_else(|| value.as_str()?.parse().ok())?;
    if n > u32::MAX as u64 {
        None
    } else {
        Some(n as u32)
    }
}

/// Parses Cinemeta-style `tt0409591:3:3` (show IMDb + season + episode).
fn parse_tt_season_episode_id(id: &str) -> Option<(u32, u32)> {
    let rest = id
        .trim()
        .strip_prefix("tt")
        .or_else(|| id.trim().strip_prefix("TT"))?;
    let mut parts = rest.split(':');
    let digits = parts.next()?;
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let season: u32 = parts.next()?.parse().ok()?;
    let episode: u32 = parts.next()?.parse().ok()?;
    if season > 0 && episode > 0 {
        Some((season, episode))
    } else {
        None
    }
}

fn video_season_episode(video: &Value) -> Option<(u32, u32)> {
    if let (Some(season), Some(episode)) = (
        video.get("season").and_then(json_u32),
        video.get("episode").and_then(json_u32),
    ) {
        if season > 0 && episode > 0 {
            return Some((season, episode));
        }
    }
    video
        .get("id")
        .and_then(|value| value.as_str())
        .and_then(parse_tt_season_episode_id)
}

fn cinemeta_season_lengths(videos: &[Value]) -> Vec<u32> {
    let mut counts: HashMap<u32, u32> = HashMap::new();
    let mut max_season = 0u32;
    for video in videos {
        let Some((season, _)) = video_season_episode(video) else {
            continue;
        };
        *counts.entry(season).or_insert(0) += 1;
        max_season = max_season.max(season);
    }
    if max_season == 0 {
        return Vec::new();
    }
    (1..=max_season)
        .map(|season| *counts.get(&season).unwrap_or(&0))
        .collect()
}

fn find_cinemeta_video(videos: &[Value], season: u32, episode: u32) -> Option<&Value> {
    videos
        .iter()
        .find(|video| video_season_episode(video) == Some((season, episode)))
}

/// Mapped S/E first, then catalog order by absolute index when the row has no S/E fields.
fn find_cinemeta_video_for_mapped(
    videos: &[Value],
    season: u32,
    episode: u32,
    absolute: u32,
) -> Option<&Value> {
    if let Some(video) = find_cinemeta_video(videos, season, episode) {
        return Some(video);
    }
    if absolute == 0 {
        return None;
    }
    let mut indexed: Vec<&Value> = videos
        .iter()
        .filter(|video| video_season_episode(video).is_some())
        .collect();
    if indexed.is_empty() {
        return videos.get((absolute as usize).saturating_sub(1));
    }
    indexed.sort_by_key(|video| video_season_episode(video).unwrap_or((u32::MAX, u32::MAX)));
    indexed.get((absolute as usize).saturating_sub(1)).copied()
}

fn season_length(lengths: &[u32], season: u32) -> u32 {
    if season < 1 {
        return 0;
    }
    *lengths.get((season as usize) - 1).unwrap_or(&0)
}

fn absolute_from_season_episode(lengths: &[u32], season: u32, episode: u32) -> Option<u32> {
    if episode < 1 {
        return None;
    }
    let mut absolute = episode;
    for i in 0..season.saturating_sub(1) {
        absolute = absolute.saturating_add(*lengths.get(i as usize).unwrap_or(&0));
    }
    Some(absolute)
}

fn season_episode_from_absolute(lengths: &[u32], absolute: u32) -> Option<(u32, u32)> {
    if absolute < 1 || lengths.is_empty() {
        return None;
    }
    let mut remaining = absolute;
    for (index, count) in lengths.iter().enumerate() {
        if remaining <= *count {
            return Some((index as u32 + 1, remaining));
        }
        remaining = remaining.saturating_sub(*count);
    }
    None
}

#[derive(Clone, Copy)]
struct MappedEpisode {
    cinemeta: (u32, u32),
    tmdb: (u32, u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EpisodeLayout {
    Auto,
    Tmdb,
    Cinemeta,
    Absolute,
}

impl EpisodeLayout {
    fn cache_key(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Tmdb => "tmdb",
            Self::Cinemeta => "cinemeta",
            Self::Absolute => "absolute",
        }
    }
}

fn parse_episode_layout(raw: Option<&str>, exact_cinemeta: Option<bool>) -> EpisodeLayout {
    match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("tmdb") => EpisodeLayout::Tmdb,
        Some("cinemeta") => EpisodeLayout::Cinemeta,
        Some("absolute") => EpisodeLayout::Absolute,
        _ => match exact_cinemeta {
            Some(true) => EpisodeLayout::Cinemeta,
            Some(false) => EpisodeLayout::Absolute,
            None => EpisodeLayout::Auto,
        },
    }
}

fn map_episode_layout(
    season: u32,
    episode: u32,
    cinemeta_lengths: &[u32],
    tmdb_lengths: &[u32],
    layout: EpisodeLayout,
) -> MappedEpisode {
    let requested = (season, episode);
    match layout {
        EpisodeLayout::Cinemeta => {
            let tmdb = absolute_from_season_episode(cinemeta_lengths, season, episode)
                .and_then(|absolute| season_episode_from_absolute(tmdb_lengths, absolute))
                .unwrap_or(requested);
            MappedEpisode {
                cinemeta: requested,
                tmdb,
            }
        }
        EpisodeLayout::Absolute => {
            let cinemeta =
                season_episode_from_absolute(cinemeta_lengths, episode).unwrap_or(requested);
            let tmdb = season_episode_from_absolute(tmdb_lengths, episode).unwrap_or(requested);
            MappedEpisode { cinemeta, tmdb }
        }
        EpisodeLayout::Tmdb => {
            if tmdb_lengths.is_empty() {
                return map_episode_layout(
                    season,
                    episode,
                    cinemeta_lengths,
                    tmdb_lengths,
                    EpisodeLayout::Auto,
                );
            }
            let tmdb_len = season_length(tmdb_lengths, season);
            if tmdb_len > 0 && episode > tmdb_len {
                let cinemeta =
                    season_episode_from_absolute(cinemeta_lengths, episode).unwrap_or(requested);
                let tmdb = season_episode_from_absolute(tmdb_lengths, episode).unwrap_or(requested);
                return MappedEpisode { cinemeta, tmdb };
            }
            let cinemeta = absolute_from_season_episode(tmdb_lengths, season, episode)
                .and_then(|absolute| season_episode_from_absolute(cinemeta_lengths, absolute))
                .unwrap_or(requested);
            MappedEpisode {
                cinemeta,
                tmdb: requested,
            }
        }
        EpisodeLayout::Auto => {
            let cine_len = season_length(cinemeta_lengths, season);
            let tmdb_len = season_length(tmdb_lengths, season);
            let cine_overflow = cine_len > 0 && episode > cine_len;
            let tmdb_overflow = tmdb_len > 0 && episode > tmdb_len;
            let as_absolute = (cine_overflow || cine_len == 0)
                && (tmdb_overflow || tmdb_len == 0)
                && (cine_overflow || tmdb_overflow);

            if as_absolute {
                let cinemeta =
                    season_episode_from_absolute(cinemeta_lengths, episode).unwrap_or(requested);
                let tmdb = season_episode_from_absolute(tmdb_lengths, episode).unwrap_or(requested);
                return MappedEpisode { cinemeta, tmdb };
            }

            if tmdb_len > 0 && episode <= tmdb_len && (cine_len == 0 || episode > cine_len) {
                let cinemeta = absolute_from_season_episode(tmdb_lengths, season, episode)
                    .and_then(|absolute| season_episode_from_absolute(cinemeta_lengths, absolute))
                    .unwrap_or(requested);
                return MappedEpisode {
                    cinemeta,
                    tmdb: requested,
                };
            }

            let tmdb = absolute_from_season_episode(cinemeta_lengths, season, episode)
                .and_then(|absolute| season_episode_from_absolute(tmdb_lengths, absolute))
                .unwrap_or(requested);
            MappedEpisode {
                cinemeta: requested,
                tmdb,
            }
        }
    }
}

/// Map a catalog season/episode onto Cinemeta and TMDB layouts.
///
/// Used by Skip Intro so TMDB overflow numbering (Naruto S2E86) becomes
/// Cinemeta/IntroDB S3E3 without a gated `window.fetch` of Cinemeta `/meta/`.
pub fn map_tv_episode_layout(
    imdb_id: &str,
    season: u32,
    episode: u32,
    tmdb_lengths_hint: Option<&[u32]>,
) -> Result<Value, String> {
    let id = normalize_imdb_id(imdb_id)
        .ok_or_else(|| "Episode layout mapping requires a valid IMDb id (tt…).".to_string())?;
    if season == 0 || episode == 0 {
        return Err("Episode layout mapping requires season and episode.".to_string());
    }

    let client = http_client()?;
    let mut dummy_out = Map::new();
    let mut ids = ResolvedIds {
        imdb: id.clone(),
        ..ResolvedIds::default()
    };
    let videos = fetch_cinemeta_title(&client, &id, "series", &mut dummy_out, &mut ids);
    let cinemeta_lengths = cinemeta_season_lengths(&videos);

    let tmdb_lengths = if let Some(hint) = tmdb_lengths_hint {
        if !hint.is_empty() {
            hint.to_vec()
        } else {
            resolve_tmdb_id(&client, &id, "series", &mut ids);
            fetch_tmdb_season_lengths(&client, &ids)
        }
    } else {
        resolve_tmdb_id(&client, &id, "series", &mut ids);
        fetch_tmdb_season_lengths(&client, &ids)
    };

    let mapped = map_episode_layout(
        season,
        episode,
        &cinemeta_lengths,
        &tmdb_lengths,
        EpisodeLayout::Auto,
    );
    let absolute = absolute_from_season_episode(
        &cinemeta_lengths,
        mapped.cinemeta.0,
        mapped.cinemeta.1,
    )
    .or_else(|| absolute_from_season_episode(&tmdb_lengths, mapped.tmdb.0, mapped.tmdb.1))
    .unwrap_or(episode);

    Ok(json!({
        "cinemetaSeason": mapped.cinemeta.0,
        "cinemetaEpisode": mapped.cinemeta.1,
        "tmdbSeason": mapped.tmdb.0,
        "tmdbEpisode": mapped.tmdb.1,
        "absolute": absolute,
    }))
}

fn fetch_cinemeta_title(
    client: &Client,
    imdb_id: &str,
    kind: &str,
    out: &mut Map<String, Value>,
    ids: &mut ResolvedIds,
) -> Vec<Value> {
    let url = format!("{CINEMETA_BASE}/{kind}/{imdb_id}.json");
    let Ok(response) = client.get(&url).headers(default_headers()).send() else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    let Ok(payload) = response.json::<Value>() else {
        return Vec::new();
    };
    let meta = payload.get("meta").unwrap_or(&payload);
    if let Some(name) = meta
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        ids.title = name.to_string();
    }
    let imdb_score = meta
        .get("imdbRating")
        .and_then(|v| {
            v.as_f64().or_else(|| {
                v.as_str()
                    .and_then(|s| s.trim().replace(',', ".").parse::<f64>().ok())
            })
        })
        .filter(|v| *v > 0.0);
    if let Some(v) = imdb_score {
        insert_rating(out, "imdb", "IMDb", "score", &format!("{v:.1}"));
    }
    meta.get("videos")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

fn fetch_cinemeta_episode_imdb(client: &Client, episode_imdb: &str, out: &mut Map<String, Value>) {
    let url = format!("{CINEMETA_BASE}/movie/{episode_imdb}.json");
    let Ok(response) = client.get(&url).headers(default_headers()).send() else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    let Ok(payload) = response.json::<Value>() else {
        return;
    };
    let meta = payload.get("meta").unwrap_or(&payload);
    let imdb_score = meta
        .get("imdbRating")
        .and_then(|v| {
            v.as_f64().or_else(|| {
                v.as_str()
                    .and_then(|s| s.trim().replace(',', ".").parse::<f64>().ok())
            })
        })
        .filter(|v| *v > 0.0);
    if let Some(v) = imdb_score {
        // Prefer episode IMDb over show-level.
        out.remove("imdb");
        insert_rating(out, "imdb", "IMDb", "score", &format!("{v:.1}"));
    }
}

/// Reads episode IMDb score / episode id from already-fetched Cinemeta `videos[]`.
fn apply_cinemeta_episode_from_videos(
    videos: &[Value],
    season: u32,
    episode: u32,
    absolute: u32,
    ids: &mut ResolvedIds,
    out: &mut Map<String, Value>,
) {
    let Some(video) = find_cinemeta_video_for_mapped(videos, season, episode, absolute) else {
        return;
    };
    if ids.episode_name.is_empty() {
        if let Some(name) = video
            .get("title")
            .or_else(|| video.get("name"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            ids.episode_name = name.to_string();
        }
    }
    if ids.episode_imdb.is_none() {
        ids.episode_imdb = video
            .get("id")
            .and_then(|v| v.as_str())
            .and_then(normalize_imdb_id)
            .or_else(|| {
                video
                    .get("imdb_id")
                    .and_then(|v| v.as_str())
                    .and_then(normalize_imdb_id)
            });
    }
    let imdb_score = video
        .get("imdbRating")
        .and_then(|v| {
            v.as_f64().or_else(|| {
                v.as_str()
                    .and_then(|s| s.trim().replace(',', ".").parse::<f64>().ok())
            })
        })
        .filter(|v| *v > 0.0);
    if let Some(v) = imdb_score {
        out.remove("imdb");
        insert_rating(out, "imdb", "IMDb", "score", &format!("{v:.1}"));
    }
}

fn trakt_headers() -> Option<HeaderMap> {
    let client_id = {
        let from_env = std::env::var("MYSTREMIO_TRAKT_CLIENT_ID").unwrap_or_default();
        if !from_env.trim().is_empty() {
            from_env.trim().to_string()
        } else {
            api_keys::get_api_key("trakt")
        }
    };
    if client_id.is_empty() {
        return None;
    }
    let mut headers = default_headers();
    if let Ok(value) = HeaderValue::from_str(&client_id) {
        headers.insert("trakt-api-key", value);
    }
    headers.insert("trakt-api-version", HeaderValue::from_static("2"));
    Some(headers)
}

fn resolve_trakt_ids(client: &Client, imdb_id: &str, kind: &str, ids: &mut ResolvedIds) {
    let Some(headers) = trakt_headers() else {
        return;
    };
    let media = if kind == "series" { "show" } else { "movie" };
    let search_url = format!("{TRAKT_BASE}/search/imdb/{imdb_id}?type={media}");
    let Ok(response) = client.get(&search_url).headers(headers).send() else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    let Ok(payload) = response.json::<Value>() else {
        return;
    };
    let Some(first) = payload.as_array().and_then(|a| a.first()) else {
        return;
    };
    let Some(media_obj) = first.get(media) else {
        return;
    };
    if ids.title.is_empty() {
        if let Some(name) = media_obj.get("title").and_then(|v| v.as_str()) {
            ids.title = name.to_string();
        }
    }
    if let Some(media_ids) = media_obj.get("ids") {
        if ids.trakt_slug.is_none() {
            ids.trakt_slug = media_ids
                .get("slug")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
        if ids.trakt_id.is_none() {
            ids.trakt_id = media_ids.get("trakt").and_then(|v| v.as_u64());
        }
        if ids.tmdb.is_none() {
            ids.tmdb = media_ids.get("tmdb").and_then(|v| v.as_u64());
        }
    }
}

fn fetch_trakt_title(client: &Client, kind: &str, ids: &ResolvedIds, out: &mut Map<String, Value>) {
    let Some(headers) = trakt_headers() else {
        return;
    };
    let id = ids
        .trakt_slug
        .clone()
        .or_else(|| ids.trakt_id.map(|n| n.to_string()));
    let Some(id) = id else {
        return;
    };
    let path = if kind == "series" {
        format!("{TRAKT_BASE}/shows/{id}/ratings")
    } else {
        format!("{TRAKT_BASE}/movies/{id}/ratings")
    };
    let Ok(response) = client.get(&path).headers(headers).send() else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    let Ok(payload) = response.json::<Value>() else {
        return;
    };
    if let Some(rating) = payload.get("rating").and_then(|v| v.as_f64()) {
        insert_rating(
            out,
            "trakt",
            "Trakt",
            "percent",
            &format!("{}%", (rating * 10.0).round() as i32),
        );
    }
}

fn fetch_trakt_episode(
    client: &Client,
    ids: &mut ResolvedIds,
    season: u32,
    episode: u32,
    out: &mut Map<String, Value>,
) {
    let Some(headers) = trakt_headers() else {
        return;
    };
    let id = ids
        .trakt_slug
        .clone()
        .or_else(|| ids.trakt_id.map(|n| n.to_string()));
    let Some(id) = id else {
        return;
    };
    let path = format!(
        "{TRAKT_BASE}/shows/{id}/seasons/{season}/episodes/{episode}?extended=full"
    );
    let Ok(response) = client.get(&path).headers(headers).send() else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    let Ok(payload) = response.json::<Value>() else {
        return;
    };
    if ids.episode_name.is_empty() {
        if let Some(name) = payload.get("title").and_then(|v| v.as_str()) {
            ids.episode_name = name.to_string();
        }
    }
    if ids.episode_imdb.is_none() {
        ids.episode_imdb = payload
            .get("ids")
            .and_then(|v| v.get("imdb"))
            .and_then(|v| v.as_str())
            .and_then(normalize_imdb_id);
    }
    if let Some(rating) = payload.get("rating").and_then(|v| v.as_f64()).filter(|v| *v > 0.0)
    {
        out.remove("trakt");
        insert_rating(
            out,
            "trakt",
            "Trakt",
            "percent",
            &format!("{}%", (rating * 10.0).round() as i32),
        );
    }
}

fn fetch_jikan_mal(client: &Client, title: &str, out: &mut Map<String, Value>, ids: &mut ResolvedIds) {
    if title.is_empty() || out.contains_key("mal") {
        return;
    }
    let encoded = urlencoding_lite(title);
    let url = format!("{JIKAN_BASE}/anime?q={encoded}&limit=5");
    let Ok(response) = client.get(&url).headers(default_headers()).send() else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    let Ok(payload) = response.json::<Value>() else {
        return;
    };
    let Some(data) = payload.get("data").and_then(|v| v.as_array()) else {
        return;
    };
    let title_l = title.to_ascii_lowercase();
    let best = data.iter().find(|item| {
        let names = [
            item.get("title").and_then(|v| v.as_str()).unwrap_or(""),
            item.get("title_english")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        ];
        names.iter().any(|n| {
            let n = n.to_ascii_lowercase();
            !n.is_empty() && (n == title_l || n.contains(&title_l) || title_l.contains(&n))
        })
    });
    let Some(item) = best else {
        return;
    };
    if let Some(mal_id) = item.get("mal_id").and_then(|v| v.as_u64()) {
        ids.mal = Some(mal_id);
    }
    if let Some(score) = item.get("score").and_then(|v| v.as_f64()) {
        insert_rating(
            out,
            "mal",
            "MyAnimeList",
            "score",
            &format!("{}", score.round() as i32),
        );
    }
}

fn resolve_tmdb_id(client: &Client, imdb_id: &str, kind: &str, ids: &mut ResolvedIds) {
    if ids.tmdb.is_some() {
        return;
    }
    let api_key = api_keys::get_api_key("tmdb");
    if api_key.is_empty() {
        return;
    }
    let find_url = format!(
        "{TMDB_BASE}/find/{imdb_id}?api_key={api_key}&external_source=imdb_id"
    );
    let Ok(response) = client.get(&find_url).headers(default_headers()).send() else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    let Ok(payload) = response.json::<Value>() else {
        return;
    };
    let primary = if kind == "series" {
        "tv_results"
    } else {
        "movie_results"
    };
    let alt = if kind == "series" {
        "movie_results"
    } else {
        "tv_results"
    };
    let first = payload
        .get(primary)
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .or_else(|| {
            payload
                .get(alt)
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
        });
    if let Some(item) = first {
        ids.tmdb = item.get("id").and_then(|v| v.as_u64());
        if ids.title.is_empty() {
            if let Some(name) = item
                .get("name")
                .or_else(|| item.get("title"))
                .and_then(|v| v.as_str())
            {
                ids.title = name.to_string();
            }
        }
    }
}

fn fetch_tmdb_title(client: &Client, kind: &str, ids: &ResolvedIds, out: &mut Map<String, Value>) {
    if out.contains_key("tmdb") {
        return;
    }
    let api_key = api_keys::get_api_key("tmdb");
    let Some(tmdb_id) = ids.tmdb else {
        return;
    };
    if api_key.is_empty() {
        return;
    }
    let path = if kind == "series" { "tv" } else { "movie" };
    let url = format!("{TMDB_BASE}/{path}/{tmdb_id}?api_key={api_key}");
    let Ok(response) = client.get(&url).headers(default_headers()).send() else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    let Ok(payload) = response.json::<Value>() else {
        return;
    };
    if let Some(vote) = payload
        .get("vote_average")
        .and_then(|v| v.as_f64())
        .filter(|v| *v > 0.0)
    {
        insert_rating(
            out,
            "tmdb",
            "TMDB",
            "percent",
            &format!("{}%", (vote * 10.0).round() as i32),
        );
    }
}

fn fetch_tmdb_season_lengths(client: &Client, ids: &ResolvedIds) -> Vec<u32> {
    let api_key = api_keys::get_api_key("tmdb");
    let Some(tmdb_id) = ids.tmdb else {
        return Vec::new();
    };
    if api_key.is_empty() {
        return Vec::new();
    }
    let url = format!("{TMDB_BASE}/tv/{tmdb_id}?api_key={api_key}");
    let Ok(response) = client.get(&url).headers(default_headers()).send() else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    let Ok(payload) = response.json::<Value>() else {
        return Vec::new();
    };
    let Some(seasons) = payload.get("seasons").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut counts: HashMap<u32, u32> = HashMap::new();
    let mut max_season = 0u32;
    for season in seasons {
        let Some(number) = season.get("season_number").and_then(json_u32) else {
            continue;
        };
        if number < 1 {
            continue;
        }
        let count = season.get("episode_count").and_then(json_u32).unwrap_or(0);
        counts.insert(number, count);
        max_season = max_season.max(number);
    }
    if max_season == 0 {
        return Vec::new();
    }
    (1..=max_season)
        .map(|season| *counts.get(&season).unwrap_or(&0))
        .collect()
}

fn fetch_tmdb_episode(
    client: &Client,
    ids: &mut ResolvedIds,
    season: u32,
    episode: u32,
    out: &mut Map<String, Value>,
) -> bool {
    let api_key = api_keys::get_api_key("tmdb");
    let Some(tmdb_id) = ids.tmdb else {
        return false;
    };
    if api_key.is_empty() {
        return false;
    }
    let url = format!(
        "{TMDB_BASE}/tv/{tmdb_id}/season/{season}/episode/{episode}?api_key={api_key}&append_to_response=external_ids"
    );
    let Ok(response) = client.get(&url).headers(default_headers()).send() else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(payload) = response.json::<Value>() else {
        return false;
    };
    if ids.episode_name.is_empty() {
        if let Some(name) = payload.get("name").and_then(|v| v.as_str()) {
            ids.episode_name = name.to_string();
        }
    }
    if ids.episode_imdb.is_none() {
        ids.episode_imdb = payload
            .get("external_ids")
            .and_then(|v| v.get("imdb_id"))
            .and_then(|v| v.as_str())
            .and_then(normalize_imdb_id);
    }
    if let Some(vote) = payload
        .get("vote_average")
        .and_then(|v| v.as_f64())
        .filter(|v| *v > 0.0)
    {
        out.remove("tmdb");
        insert_rating(
            out,
            "tmdb",
            "TMDB",
            "percent",
            &format!("{}%", (vote * 10.0).round() as i32),
        );
    }
    true
}

fn fetch_mdblist(client: &Client, imdb_id: &str, kind: &str, out: &mut Map<String, Value>, ids: &mut ResolvedIds) {
    let api_key = api_keys::get_api_key("mdblist");
    if api_key.is_empty() {
        return;
    }
    let media = if kind == "series" { "show" } else { "movie" };
    let url = format!("https://api.mdblist.com/imdb/{media}/{imdb_id}?apikey={api_key}");
    let Ok(response) = client.get(&url).headers(default_headers()).send() else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    let Ok(payload) = response.json::<Value>() else {
        return;
    };
    if ids.title.is_empty() {
        if let Some(title) = payload.get("title").and_then(|v| v.as_str()) {
            ids.title = title.to_string();
        }
    }
    if let Some(media_ids) = payload.get("ids").or_else(|| payload.get("id")) {
        if ids.tmdb.is_none() {
            ids.tmdb = media_ids
                .get("tmdb")
                .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()));
        }
        if ids.trakt_id.is_none() {
            ids.trakt_id = media_ids
                .get("trakt")
                .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()));
        }
        if ids.mal.is_none() {
            ids.mal = media_ids
                .get("mal")
                .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()));
        }
    }
    let Some(ratings) = payload.get("ratings").and_then(|v| v.as_array()) else {
        return;
    };
    for entry in ratings {
        let source = entry
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let value = entry.get("value").and_then(|v| v.as_f64());
        let score = entry.get("score").and_then(|v| v.as_f64());
        match source.as_str() {
            "imdb" => {
                if let Some(v) = value.filter(|v| *v > 0.0) {
                    insert_rating(out, "imdb", "IMDb", "score", &format!("{v:.1}"));
                }
            }
            "tmdb" => {
                if let Some(s) = score.filter(|v| *v > 0.0) {
                    insert_rating(out, "tmdb", "TMDB", "percent", &format!("{}%", s.round() as i32));
                } else if let Some(v) = value.filter(|v| *v > 0.0) {
                    insert_rating(
                        out,
                        "tmdb",
                        "TMDB",
                        "percent",
                        &format!("{}%", (v * 10.0).round() as i32),
                    );
                }
            }
            "metacritic" => {
                if let Some(s) = score.filter(|v| *v > 0.0) {
                    insert_rating(
                        out,
                        "metacritic",
                        "Metacritic",
                        "score",
                        &format!("{}", s.round() as i32),
                    );
                } else if let Some(v) = value.filter(|v| *v > 0.0) {
                    let n = if v <= 10.0 { v * 10.0 } else { v };
                    insert_rating(
                        out,
                        "metacritic",
                        "Metacritic",
                        "score",
                        &format!("{}", n.round() as i32),
                    );
                }
            }
            "metacriticuser" => {
                if let Some(v) = value.filter(|v| *v > 0.0) {
                    insert_rating(out, "mcusers", "MC Users", "score", &format!("{v:.1}"));
                }
            }
            "tomatoes" | "rottentomatoes" | "rt" => {
                if let Some(s) = score.filter(|v| *v > 0.0) {
                    insert_rating(
                        out,
                        "rt",
                        "Rotten Tomatoes",
                        "percent",
                        &format!("{}%", s.round() as i32),
                    );
                } else if let Some(v) = value.filter(|v| *v > 0.0) {
                    let n = if v <= 10.0 { v * 10.0 } else { v };
                    insert_rating(
                        out,
                        "rt",
                        "Rotten Tomatoes",
                        "percent",
                        &format!("{}%", n.round() as i32),
                    );
                }
            }
            "trakt" => {
                if let Some(s) = score.filter(|v| *v > 0.0) {
                    insert_rating(
                        out,
                        "trakt",
                        "Trakt",
                        "percent",
                        &format!("{}%", s.round() as i32),
                    );
                } else if let Some(v) = value.filter(|v| *v > 0.0) {
                    let n = if v <= 10.0 { v * 10.0 } else { v };
                    insert_rating(
                        out,
                        "trakt",
                        "Trakt",
                        "percent",
                        &format!("{}%", n.round() as i32),
                    );
                }
            }
            "mal" | "myanimelist" => {
                if let Some(v) = value.filter(|v| *v > 0.0) {
                    insert_rating(
                        out,
                        "mal",
                        "MyAnimeList",
                        "score",
                        &format!("{}", v.round() as i32),
                    );
                } else if let Some(s) = score.filter(|v| *v > 0.0) {
                    insert_rating(
                        out,
                        "mal",
                        "MyAnimeList",
                        "score",
                        &format!("{}", s.round() as i32),
                    );
                }
            }
            "letterboxd" | "letterbox" => {
                if let Some(v) = value.filter(|v| *v > 0.0 && *v <= 5.0) {
                    insert_rating(out, "letterboxd", "Letterboxd", "score", &format!("{v:.1}"));
                } else if let Some(s) = score.filter(|v| *v > 0.0) {
                    let stars = if s > 5.0 { s / 20.0 } else { s };
                    if stars > 0.0 {
                        insert_rating(
                            out,
                            "letterboxd",
                            "Letterboxd",
                            "score",
                            &format!("{stars:.1}"),
                        );
                    }
                }
            }
            _ => {}
        }
    }
}

/// Resolves episode title (for Metacritic slugs) via free TVMaze lookup.
fn fetch_tvmaze_episode_meta(
    client: &Client,
    imdb_id: &str,
    ids: &mut ResolvedIds,
    season: u32,
    episode: u32,
) {
    let lookup = format!("{TVMAZE_BASE}/lookup/shows?imdb={imdb_id}");
    let Ok(response) = client.get(&lookup).headers(default_headers()).send() else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    let Ok(show) = response.json::<Value>() else {
        return;
    };
    if ids.title.is_empty() {
        if let Some(name) = show.get("name").and_then(|v| v.as_str()) {
            ids.title = name.to_string();
        }
    }
    let Some(show_id) = show.get("id").and_then(|v| v.as_u64()) else {
        return;
    };
    let ep_url = format!(
        "{TVMAZE_BASE}/shows/{show_id}/episodebynumber?season={season}&number={episode}"
    );
    let Ok(response) = client.get(&ep_url).headers(default_headers()).send() else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    let Ok(ep) = response.json::<Value>() else {
        return;
    };
    if ids.episode_name.is_empty() {
        if let Some(name) = ep.get("name").and_then(|v| v.as_str()) {
            ids.episode_name = name.to_string();
        }
    }
}

fn attach_deep_links(
    out: &mut Map<String, Value>,
    kind: &str,
    ids: &ResolvedIds,
    season: Option<u32>,
    episode: Option<u32>,
) {
    let is_episode = matches!((season, episode), (Some(s), Some(e)) if s > 0 && e > 0);
    let rt_slug = slugify(&ids.title, '_');
    let mc_slug = slugify(&ids.title, '-');
    let ep_slug = slugify(&ids.episode_name, '-');

    // IMDb
    if is_episode {
        if let Some(ep_imdb) = ids.episode_imdb.as_deref() {
            set_rating_url(out, "imdb", &format!("https://www.imdb.com/title/{ep_imdb}/"));
        } else if let (Some(s), _) = (season, episode) {
            set_rating_url(
                out,
                "imdb",
                &format!("https://www.imdb.com/title/{}/episodes/?season={s}", ids.imdb),
            );
        }
    } else {
        set_rating_url(out, "imdb", &format!("https://www.imdb.com/title/{}/", ids.imdb));
    }

    // TMDB
    if let Some(tmdb_id) = ids.tmdb {
        if kind == "series" {
            if let (Some(s), Some(e)) = (season, episode) {
                if s > 0 && e > 0 {
                    set_rating_url(
                        out,
                        "tmdb",
                        &format!("https://www.themoviedb.org/tv/{tmdb_id}/season/{s}/episode/{e}"),
                    );
                } else {
                    set_rating_url(out, "tmdb", &format!("https://www.themoviedb.org/tv/{tmdb_id}"));
                }
            } else {
                set_rating_url(out, "tmdb", &format!("https://www.themoviedb.org/tv/{tmdb_id}"));
            }
        } else {
            set_rating_url(out, "tmdb", &format!("https://www.themoviedb.org/movie/{tmdb_id}"));
        }
    }

    // Trakt
    let trakt_key = ids
        .trakt_slug
        .clone()
        .or_else(|| ids.trakt_id.map(|n| n.to_string()));
    if let Some(key) = trakt_key {
        if kind == "series" {
            if let (Some(s), Some(e)) = (season, episode) {
                if s > 0 && e > 0 {
                    set_rating_url(
                        out,
                        "trakt",
                        &format!("https://trakt.tv/shows/{key}/seasons/{s}/episodes/{e}"),
                    );
                } else {
                    set_rating_url(out, "trakt", &format!("https://trakt.tv/shows/{key}"));
                }
            } else {
                set_rating_url(out, "trakt", &format!("https://trakt.tv/shows/{key}"));
            }
        } else {
            set_rating_url(out, "trakt", &format!("https://trakt.tv/movies/{key}"));
        }
    }

    // Rotten Tomatoes
    if !rt_slug.is_empty() {
        if kind == "series" {
            if let (Some(s), Some(e)) = (season, episode) {
                if s > 0 && e > 0 {
                    set_rating_url(
                        out,
                        "rt",
                        &format!("https://www.rottentomatoes.com/tv/{rt_slug}/s{s:02}/e{e:02}"),
                    );
                } else {
                    set_rating_url(out, "rt", &format!("https://www.rottentomatoes.com/tv/{rt_slug}"));
                }
            } else {
                set_rating_url(out, "rt", &format!("https://www.rottentomatoes.com/tv/{rt_slug}"));
            }
        } else {
            set_rating_url(out, "rt", &format!("https://www.rottentomatoes.com/m/{rt_slug}"));
        }
    }

    // Metacritic / MC Users
    if !mc_slug.is_empty() {
        if kind == "series" {
            if let (Some(s), Some(e)) = (season, episode) {
                if s > 0 && e > 0 {
                    let ep_url = if ep_slug.is_empty() {
                        format!("https://www.metacritic.com/tv/{mc_slug}/season-{s}/")
                    } else {
                        format!(
                            "https://www.metacritic.com/tv/{mc_slug}/season-{s}/episode-{e}-{ep_slug}/"
                        )
                    };
                    set_rating_url(out, "metacritic", &ep_url);
                    set_rating_url(out, "mcusers", &ep_url);
                } else {
                    let url = format!("https://www.metacritic.com/tv/{mc_slug}/");
                    set_rating_url(out, "metacritic", &url);
                    set_rating_url(out, "mcusers", &url);
                }
            } else {
                let url = format!("https://www.metacritic.com/tv/{mc_slug}/");
                set_rating_url(out, "metacritic", &url);
                set_rating_url(out, "mcusers", &url);
            }
        } else {
            let url = format!("https://www.metacritic.com/movie/{mc_slug}/");
            set_rating_url(out, "metacritic", &url);
            set_rating_url(out, "mcusers", &url);
        }
    }

    // MAL
    if let Some(mal_id) = ids.mal {
        set_rating_url(out, "mal", &format!("https://myanimelist.net/anime/{mal_id}"));
    }

    // Letterboxd — IMDb permalink when possible.
    if !ids.imdb.is_empty() {
        set_rating_url(out, "letterboxd", &format!("https://letterboxd.com/imdb/{}/", ids.imdb));
    }

    // FSK → IMDb parental guide (closest stable page)
    if is_episode {
        if let Some(ep_imdb) = ids.episode_imdb.as_deref() {
            set_rating_url(
                out,
                "fsk",
                &format!("https://www.imdb.com/title/{ep_imdb}/parentalguide"),
            );
        }
    } else {
        set_rating_url(
            out,
            "fsk",
            &format!("https://www.imdb.com/title/{}/parentalguide", ids.imdb),
        );
    }
}

fn ordered_ratings(out: &Map<String, Value>) -> Vec<Value> {
    let order = [
        "fsk",
        "imdb",
        "mal",
        "rt",
        "tmdb",
        "metacritic",
        "trakt",
        "mcusers",
        "letterboxd",
    ];
    order
        .iter()
        .filter_map(|key| out.get(*key).cloned())
        .collect()
}

/// Aggregates multi-source title or episode ratings for the Meta ratings bar.
///
/// `mode` is `"fast"` (Cinemeta + Aggregator only) or `"full"` (remaining sources).
pub fn get_title_ratings(
    imdb_id: &str,
    media_type: &str,
    season: Option<u32>,
    episode: Option<u32>,
    mode: &str,
    exact_cinemeta: Option<bool>,
    episode_layout: Option<&str>,
) -> Result<Value, String> {
    let id = normalize_imdb_id(imdb_id)
        .ok_or_else(|| "Ratings lookup requires a valid IMDb id (tt…).".to_string())?;
    let kind = normalize_media_type(media_type)
        .ok_or_else(|| "Ratings lookup requires media type movie or series.".to_string())?;

    let fast_only = mode.eq_ignore_ascii_case("fast");
    let episode_mode = kind == "series"
        && matches!((season, episode), (Some(s), Some(e)) if s > 0 && e > 0);
    let season_n = season.filter(|s| *s > 0);
    let episode_n = episode.filter(|e| *e > 0);
    let layout = parse_episode_layout(episode_layout, exact_cinemeta);
    let cache_key = format!(
        "{id}:{kind}:{}:{}:{}:{}",
        season_n.unwrap_or(0),
        episode_n.unwrap_or(0),
        if fast_only { "fast" } else { "full" },
        layout.cache_key()
    );
    if let Some(cached) = cache_lookup(&cache_key) {
        return Ok(cached);
    }

    let client = http_client()?;
    let mut out = Map::new();
    let mut ids = ResolvedIds {
        imdb: id.clone(),
        ..ResolvedIds::default()
    };
    let mut cinemeta_videos = Vec::new();

    std::thread::scope(|scope| {
        let client_cin = client.clone();
        let id_cin = id.clone();
        let kind_cin = kind.to_string();
        let cin_h = scope.spawn(move || {
            let mut local = Map::new();
            let mut local_ids = ResolvedIds {
                imdb: id_cin.clone(),
                ..ResolvedIds::default()
            };
            let videos = fetch_cinemeta_title(&client_cin, &id_cin, &kind_cin, &mut local, &mut local_ids);
            (videos, local, local_ids)
        });
        let agg_h = if fast_only {
            let client_agg = client.clone();
            let id_agg = id.clone();
            let kind_agg = kind.to_string();
            let fsk_only = episode_mode;
            Some(scope.spawn(move || {
                let mut local = Map::new();
                fetch_aggregator(&client_agg, &id_agg, &kind_agg, &mut local);
                if fsk_only {
                    local.retain(|key, _| key == "fsk");
                }
                local
            }))
        } else {
            None
        };

        match cin_h.join() {
            Ok((videos, cin_out, cin_ids)) => {
                cinemeta_videos = videos;
                merge_ratings(&mut out, cin_out);
                merge_ids(&mut ids, cin_ids);
            }
            Err(_) => {}
        }
        if let Some(handle) = agg_h {
            if let Ok(agg_out) = handle.join() {
                merge_ratings(&mut out, agg_out);
            }
        }
    });

    if episode_mode {
        for key in [
            "imdb",
            "tmdb",
            "trakt",
            "rt",
            "metacritic",
            "mcusers",
            "mal",
            "letterboxd",
        ] {
            out.remove(key);
        }
    }

    let mut mapped_season = season_n;
    let mut mapped_episode = episode_n;

    if fast_only {
        attach_deep_links(&mut out, kind, &ids, mapped_season, mapped_episode);
        let payload = json!({ "ratings": ordered_ratings(&out) });
        cache_store(cache_key, &payload);
        return Ok(payload);
    }

    let started = Instant::now();
    let within_budget = || started.elapsed() < OVERALL_BUDGET;

    if episode_mode {
        std::thread::scope(|scope| {
            let client_tmdb = client.clone();
            let id_tmdb = id.clone();
            let kind_tmdb = kind.to_string();
            let tmdb_h = scope.spawn(move || {
                let mut local = ResolvedIds {
                    imdb: id_tmdb.clone(),
                    ..ResolvedIds::default()
                };
                resolve_tmdb_id(&client_tmdb, &id_tmdb, &kind_tmdb, &mut local);
                local
            });
            let client_trakt = client.clone();
            let id_trakt = id.clone();
            let kind_trakt = kind.to_string();
            let trakt_h = scope.spawn(move || {
                let mut local = ResolvedIds {
                    imdb: id_trakt.clone(),
                    ..ResolvedIds::default()
                };
                resolve_trakt_ids(&client_trakt, &id_trakt, &kind_trakt, &mut local);
                local
            });
            let client_mdb = client.clone();
            let id_mdb = id.clone();
            let kind_mdb = kind.to_string();
            let mdb_h = scope.spawn(move || {
                let mut id_only = Map::new();
                let mut local_ids = ResolvedIds {
                    imdb: id_mdb.clone(),
                    ..ResolvedIds::default()
                };
                fetch_mdblist(&client_mdb, &id_mdb, &kind_mdb, &mut id_only, &mut local_ids);
                local_ids
            });

            if let Ok(extra) = tmdb_h.join() {
                merge_ids(&mut ids, extra);
            }
            if let Ok(extra) = trakt_h.join() {
                merge_ids(&mut ids, extra);
            }
            if let Ok(extra) = mdb_h.join() {
                merge_ids(&mut ids, extra);
            }
        });

        let s = season_n.unwrap();
        let e = episode_n.unwrap();
        let cinemeta_lengths = cinemeta_season_lengths(&cinemeta_videos);
        let tmdb_lengths = fetch_tmdb_season_lengths(&client, &ids);
        let mapped = map_episode_layout(s, e, &cinemeta_lengths, &tmdb_lengths, layout);
        mapped_season = Some(mapped.cinemeta.0);
        mapped_episode = Some(mapped.cinemeta.1);
        let absolute = absolute_from_season_episode(
            &cinemeta_lengths,
            mapped.cinemeta.0,
            mapped.cinemeta.1,
        )
        .or_else(|| absolute_from_season_episode(&tmdb_lengths, mapped.tmdb.0, mapped.tmdb.1))
        .unwrap_or(e);
        apply_cinemeta_episode_from_videos(
            &cinemeta_videos,
            mapped.cinemeta.0,
            mapped.cinemeta.1,
            absolute,
            &mut ids,
            &mut out,
        );

        let cin_season = mapped.cinemeta.0;
        let cin_episode = mapped.cinemeta.1;
        let tmdb_season = mapped.tmdb.0;
        let tmdb_episode = mapped.tmdb.1;
        std::thread::scope(|scope| {
            let client_ep = client.clone();
            let mut ids_tmdb = ids.clone();
            let tmdb_h = scope.spawn(move || {
                let mut local = Map::new();
                let ok = fetch_tmdb_episode(
                    &client_ep,
                    &mut ids_tmdb,
                    tmdb_season,
                    tmdb_episode,
                    &mut local,
                );
                if !ok && (cin_season, cin_episode) != (tmdb_season, tmdb_episode) {
                    fetch_tmdb_episode(
                        &client_ep,
                        &mut ids_tmdb,
                        cin_season,
                        cin_episode,
                        &mut local,
                    );
                }
                (local, ids_tmdb)
            });
            let client_trakt = client.clone();
            let mut ids_trakt = ids.clone();
            let trakt_h = scope.spawn(move || {
                let mut local = Map::new();
                fetch_trakt_episode(&client_trakt, &mut ids_trakt, cin_season, cin_episode, &mut local);
                (local, ids_trakt)
            });
            let client_fsk = client.clone();
            let id_fsk = id.clone();
            let kind_fsk = kind.to_string();
            let already_fsk = out.contains_key("fsk");
            let fsk_h = if already_fsk {
                None
            } else {
                Some(scope.spawn(move || {
                    let mut local = Map::new();
                    fetch_aggregator(&client_fsk, &id_fsk, &kind_fsk, &mut local);
                    local.remove("fsk")
                }))
            };
            let client_tv = client.clone();
            let id_tv = id.clone();
            let mut ids_tv = ids.clone();
            let tv_h = scope.spawn(move || {
                fetch_tvmaze_episode_meta(&client_tv, &id_tv, &mut ids_tv, cin_season, cin_episode);
                ids_tv
            });

            if let Ok((local, extra)) = tmdb_h.join() {
                merge_ratings(&mut out, local);
                merge_ids(&mut ids, extra);
            }
            if let Ok((local, extra)) = trakt_h.join() {
                merge_ratings(&mut out, local);
                merge_ids(&mut ids, extra);
            }
            if let Some(handle) = fsk_h {
                if let Ok(Some(fsk)) = handle.join() {
                    out.insert("fsk".to_string(), fsk);
                }
            }
            if let Ok(extra) = tv_h.join() {
                merge_ids(&mut ids, extra);
            }
        });

        if within_budget() {
            if let Some(ep_imdb) = ids.episode_imdb.clone() {
                if normalize_imdb_id(&ep_imdb).is_some() && !out.contains_key("imdb") {
                    fetch_cinemeta_episode_imdb(&client, &ep_imdb, &mut out);
                }
            }
        }
    } else if within_budget() {
        std::thread::scope(|scope| {
            let client_tmdb = client.clone();
            let id_tmdb = id.clone();
            let kind_tmdb = kind.to_string();
            let tmdb_h = scope.spawn(move || {
                let mut local = ResolvedIds {
                    imdb: id_tmdb.clone(),
                    ..ResolvedIds::default()
                };
                resolve_tmdb_id(&client_tmdb, &id_tmdb, &kind_tmdb, &mut local);
                local
            });
            let client_trakt = client.clone();
            let id_trakt = id.clone();
            let kind_trakt = kind.to_string();
            let trakt_h = scope.spawn(move || {
                let mut local = ResolvedIds {
                    imdb: id_trakt.clone(),
                    ..ResolvedIds::default()
                };
                resolve_trakt_ids(&client_trakt, &id_trakt, &kind_trakt, &mut local);
                local
            });
            let client_mdb = client.clone();
            let id_mdb = id.clone();
            let kind_mdb = kind.to_string();
            let mdb_h = scope.spawn(move || {
                let mut local_out = Map::new();
                let mut local_ids = ResolvedIds {
                    imdb: id_mdb.clone(),
                    ..ResolvedIds::default()
                };
                fetch_mdblist(&client_mdb, &id_mdb, &kind_mdb, &mut local_out, &mut local_ids);
                (local_out, local_ids)
            });

            if let Ok(extra) = tmdb_h.join() {
                merge_ids(&mut ids, extra);
            }
            if let Ok(extra) = trakt_h.join() {
                merge_ids(&mut ids, extra);
            }
            if let Ok((mdb_out, extra)) = mdb_h.join() {
                merge_ratings(&mut out, mdb_out);
                merge_ids(&mut ids, extra);
            }
        });

        if within_budget() {
            std::thread::scope(|scope| {
                let client_tmdb = client.clone();
                let kind_tmdb = kind.to_string();
                let ids_tmdb = ids.clone();
                let tmdb_h = scope.spawn(move || {
                    let mut local = Map::new();
                    fetch_tmdb_title(&client_tmdb, &kind_tmdb, &ids_tmdb, &mut local);
                    local
                });
                let client_trakt = client.clone();
                let kind_trakt = kind.to_string();
                let ids_trakt = ids.clone();
                let trakt_h = scope.spawn(move || {
                    let mut local = Map::new();
                    fetch_trakt_title(&client_trakt, &kind_trakt, &ids_trakt, &mut local);
                    local
                });
                let title_for_mal = ids.title.clone();
                let jikan_h = if !title_for_mal.is_empty() {
                    let client_jikan = client.clone();
                    Some(scope.spawn(move || {
                        let mut local = Map::new();
                        let mut local_ids = ResolvedIds::default();
                        fetch_jikan_mal(&client_jikan, &title_for_mal, &mut local, &mut local_ids);
                        (local, local_ids)
                    }))
                } else {
                    None
                };

                if let Ok(local) = tmdb_h.join() {
                    merge_ratings(&mut out, local);
                }
                if let Ok(local) = trakt_h.join() {
                    merge_ratings(&mut out, local);
                }
                if let Some(handle) = jikan_h {
                    if let Ok((local, extra)) = handle.join() {
                        merge_ratings(&mut out, local);
                        merge_ids(&mut ids, extra);
                    }
                }
            });
        }
    }

    attach_deep_links(&mut out, kind, &ids, mapped_season, mapped_episode);
    let payload = json!({ "ratings": ordered_ratings(&out) });
    cache_store(cache_key, &payload);
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naruto_s2e87_maps_absolute_to_cinemeta_s3e4() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 52];
        let mapped = map_episode_layout(2, 87, &cinemeta, &tmdb, EpisodeLayout::Auto);
        assert_eq!(mapped.cinemeta, (3, 4));
        assert_eq!(mapped.tmdb, (2, 35));
    }

    #[test]
    fn naruto_s2e86_maps_absolute_to_cinemeta_s3e3() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 52];
        let mapped = map_episode_layout(2, 86, &cinemeta, &tmdb, EpisodeLayout::Auto);
        assert_eq!(mapped.cinemeta, (3, 3));
        assert_eq!(mapped.tmdb, (2, 34));
    }

    #[test]
    fn exact_cinemeta_s1e1_stays() {
        let cinemeta = vec![7, 13, 13, 13, 16];
        let tmdb = vec![7, 13, 13, 13, 16];
        let mapped = map_episode_layout(1, 1, &cinemeta, &tmdb, EpisodeLayout::Cinemeta);
        assert_eq!(mapped.cinemeta, (1, 1));
        assert_eq!(mapped.tmdb, (1, 1));
    }

    #[test]
    fn tmdb_valid_overflows_cinemeta_maps_via_absolute() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 64];
        let mapped = map_episode_layout(4, 62, &cinemeta, &tmdb, EpisodeLayout::Auto);
        assert_eq!(mapped.tmdb, (4, 62));
        assert_eq!(mapped.cinemeta, (5, 39));
    }

    #[test]
    fn naruto_tmdb_s3e3_is_not_cinemeta_s3e3() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 52];
        let mapped = map_episode_layout(3, 3, &cinemeta, &tmdb, EpisodeLayout::Tmdb);
        assert_eq!(mapped.tmdb, (3, 3));
        assert_ne!(mapped.cinemeta, (3, 3));
        assert_eq!(mapped.cinemeta, (3, 24));
    }

    #[test]
    fn naruto_tmdb_s2e86_maps_to_cinemeta_s3e3() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 52];
        let mapped = map_episode_layout(2, 86, &cinemeta, &tmdb, EpisodeLayout::Tmdb);
        assert_eq!(mapped.cinemeta, (3, 3));
        assert_eq!(mapped.tmdb, (2, 34));
    }

    #[test]
    fn naruto_layout_cinemeta_s1e1_stays() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 52];
        let mapped = map_episode_layout(1, 1, &cinemeta, &tmdb, EpisodeLayout::Cinemeta);
        assert_eq!(mapped.cinemeta, (1, 1));
        assert_eq!(mapped.tmdb, (1, 1));
    }

    #[test]
    fn naruto_tt_colon_id_counts_as_s3e3() {
        let video = json!({ "id": "tt0409591:3:3" });
        assert_eq!(video_season_episode(&video), Some((3, 3)));
        let with_fields = json!({ "id": "tt0409591:3:3", "season": 0, "episode": 0 });
        assert_eq!(video_season_episode(&with_fields), Some((3, 3)));
        let lengths = cinemeta_season_lengths(&[video]);
        assert_eq!(lengths.get(2), Some(&1));
    }
}
