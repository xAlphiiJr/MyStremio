//! Multi-source title/episode ratings with deep links for the Meta ratings bar.
//!
//! Scores come from Aggregator, Cinemeta, MDBList, TMDB, Trakt, Jikan, and (episodes)
//! TVMaze. Each rating may include a `url` pointing at the real source page.

use super::api_keys;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use serde_json::{json, Map, Value};
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

fn fetch_cinemeta_title(
    client: &Client,
    imdb_id: &str,
    kind: &str,
    out: &mut Map<String, Value>,
    ids: &mut ResolvedIds,
) {
    let url = format!("{CINEMETA_BASE}/{kind}/{imdb_id}.json");
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

/// Reads episode IMDb score / episode id from Cinemeta series `videos[]` (S/E match).
fn fetch_cinemeta_episode_from_videos(
    client: &Client,
    show_imdb: &str,
    season: u32,
    episode: u32,
    ids: &mut ResolvedIds,
    out: &mut Map<String, Value>,
) {
    let url = format!("{CINEMETA_BASE}/series/{show_imdb}.json");
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
    let Some(videos) = meta.get("videos").and_then(|v| v.as_array()) else {
        return;
    };
    let Some(video) = videos.iter().find(|v| {
        let s = v
            .get("season")
            .and_then(|x| x.as_u64().or_else(|| x.as_str()?.parse().ok()))
            .unwrap_or(0) as u32;
        let e = v
            .get("episode")
            .and_then(|x| x.as_u64().or_else(|| x.as_str()?.parse().ok()))
            .unwrap_or(0) as u32;
        s == season && e == episode
    }) else {
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

fn fetch_tmdb_episode(
    client: &Client,
    ids: &mut ResolvedIds,
    season: u32,
    episode: u32,
    out: &mut Map<String, Value>,
) {
    let api_key = api_keys::get_api_key("tmdb");
    let Some(tmdb_id) = ids.tmdb else {
        return;
    };
    if api_key.is_empty() {
        return;
    }
    let url = format!(
        "{TMDB_BASE}/tv/{tmdb_id}/season/{season}/episode/{episode}?api_key={api_key}&append_to_response=external_ids"
    );
    let Ok(response) = client.get(&url).headers(default_headers()).send() else {
        return;
    };
    if !response.status().is_success() {
        return;
    }
    let Ok(payload) = response.json::<Value>() else {
        return;
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
    ];
    order
        .iter()
        .filter_map(|key| out.get(*key).cloned())
        .collect()
}

/// Aggregates multi-source title or episode ratings for the Meta ratings bar.
///
/// # Arguments
/// * `imdb_id` - Show/movie IMDb id (`tt…`).
/// * `media_type` - `movie` or `series`.
/// * `season` / `episode` - When both are set (>0) on a series, returns episode scores
///   and episode deep links.
///
/// # Returns
/// `{ "ratings": [ { key, label, kind, value, url? }, ... ] }`
pub fn get_title_ratings(
    imdb_id: &str,
    media_type: &str,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<Value, String> {
    let id = normalize_imdb_id(imdb_id)
        .ok_or_else(|| "Ratings lookup requires a valid IMDb id (tt…).".to_string())?;
    let kind = normalize_media_type(media_type)
        .ok_or_else(|| "Ratings lookup requires media type movie or series.".to_string())?;

    let episode_mode = kind == "series"
        && matches!((season, episode), (Some(s), Some(e)) if s > 0 && e > 0);
    let season_n = season.filter(|s| *s > 0);
    let episode_n = episode.filter(|e| *e > 0);

    let client = http_client()?;
    let mut out = Map::new();
    let mut ids = ResolvedIds {
        imdb: id.clone(),
        ..ResolvedIds::default()
    };
    let started = Instant::now();
    let within_budget = || started.elapsed() < OVERALL_BUDGET;

    // Fast path first: Cinemeta (+ Aggregator for title mode) cover most chips users see.
    fetch_cinemeta_title(&client, &id, kind, &mut out, &mut ids);
    if !episode_mode && within_budget() {
        fetch_aggregator(&client, &id, kind, &mut out);
    }

    if within_budget() {
        fetch_mdblist(&client, &id, kind, &mut out, &mut ids);
    }
    if within_budget() {
        resolve_tmdb_id(&client, &id, kind, &mut ids);
    }
    if within_budget() {
        resolve_trakt_ids(&client, &id, kind, &mut ids);
    }

    if episode_mode {
        let s = season_n.unwrap();
        let e = episode_n.unwrap();
        // Drop show-level scores that must be replaced by episode values.
        for key in ["imdb", "tmdb", "trakt", "rt", "metacritic", "mcusers", "fsk", "mal"] {
            out.remove(key);
        }
        if within_budget() {
            fetch_cinemeta_episode_from_videos(&client, &id, s, e, &mut ids, &mut out);
        }
        if within_budget() {
            fetch_tmdb_episode(&client, &mut ids, s, e, &mut out);
        }
        if within_budget() {
            fetch_trakt_episode(&client, &mut ids, s, e, &mut out);
        }
        if within_budget() {
            fetch_tvmaze_episode_meta(&client, &id, &mut ids, s, e);
        }
        if within_budget() {
            if let Some(ep_imdb) = ids.episode_imdb.clone() {
                fetch_cinemeta_episode_imdb(&client, &ep_imdb, &mut out);
            }
        }
        // Keep age rating from show aggregator only.
        if within_budget() {
            let mut age_out = Map::new();
            fetch_aggregator(&client, &id, kind, &mut age_out);
            if let Some(fsk) = age_out.get("fsk").cloned() {
                out.insert("fsk".to_string(), fsk);
            }
        }
    } else {
        // Aggregator already fetched above; fill remaining sources within budget.
        if within_budget() {
            fetch_tmdb_title(&client, kind, &ids, &mut out);
        }
        if within_budget() {
            fetch_trakt_title(&client, kind, &ids, &mut out);
        }
        let title_for_mal = ids.title.clone();
        if !title_for_mal.is_empty() && within_budget() {
            fetch_jikan_mal(&client, &title_for_mal, &mut out, &mut ids);
        }
    }

    attach_deep_links(&mut out, kind, &ids, season_n, episode_n);

    Ok(json!({ "ratings": ordered_ratings(&out) }))
}
