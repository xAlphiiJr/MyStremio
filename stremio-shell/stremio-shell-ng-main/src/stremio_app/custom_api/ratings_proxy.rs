//! Multi-source title/episode ratings with deep links for the Meta ratings bar.
//!
//! Scores come from Aggregator, Cinemeta, MDBList, TMDB, Trakt, Jikan, TVMaze
//! (show + episode), and Cinemeta TVDB (`meta.rating` / `videos[].rating`).
//! Each rating may include a `url` pointing at the real source page.

use super::api_keys;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const AGGREGATOR_BASE: &str = "https://rating-aggregator.elfhosted.com";
const IMDB_RATINGS_ADDON: &str = "https://imdbratings.kgenovz.com";
const CINEMETA_BASE: &str = "https://v3-cinemeta.strem.io/meta";
const TRAKT_BASE: &str = "https://api.trakt.tv";
const JIKAN_BASE: &str = "https://api.jikan.moe/v4";
const TMDB_BASE: &str = "https://api.themoviedb.org/3";
const TVMAZE_BASE: &str = "https://api.tvmaze.com";
const USER_AGENT_VALUE: &str = "MyStremio Ratings Proxy";
/// Per-request HTTP timeout — keep short so a hung source cannot stall the worker.
///
/// The episode path is a chain of dependent hops (TMDB id, season lengths, season
/// episode list, episode, Cinemeta episode `tt`), each of which normally answers in a
/// few hundred milliseconds. Keeping the per-hop cap low is what bounds the total.
const REQUEST_TIMEOUT: Duration = Duration::from_millis(2500);
/// Connect budget inside [`REQUEST_TIMEOUT`]: an unreachable host fails fast.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
/// Budget for *optional* extras only (Jikan, TVMaze, retry candidates).
///
/// Never gates a scored source: dropping whole phases on a slow network was what
/// made providers appear only on the third or fourth attempt.
const EXTRAS_BUDGET: Duration = Duration::from_millis(6000);
/// In-process ratings cache so opening the same title twice is instant.
const CACHE_TTL: Duration = Duration::from_secs(600);
/// Empty / FSK-only results must not poison the process for 10 minutes (Ctrl+R would still miss).
const NEGATIVE_TTL: Duration = Duration::from_secs(15);
/// A result with an unreachable source: long enough to dedupe a request burst,
/// short enough that the next user action retries for real.
const INCOMPLETE_TTL: Duration = Duration::from_secs(5);

const SCORE_KEYS: &[&str] = &[
    "imdb",
    "tmdb",
    "rt",
    "metacritic",
    "trakt",
    "mcusers",
    "letterboxd",
    "mal",
    "tvmaze",
    "tvdb",
];

struct CachedRatings {
    at: Instant,
    payload: Value,
    ttl: Duration,
}

fn ratings_cache() -> &'static Mutex<HashMap<String, CachedRatings>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedRatings>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn clear_ratings_cache() {
    if let Ok(mut cache) = ratings_cache().lock() {
        cache.clear();
    }
}

#[cfg(test)]
fn cache_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

fn rating_key(item: &Value) -> String {
    item.get("key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn payload_score_count(payload: &Value) -> usize {
    let Some(ratings) = payload.get("ratings").and_then(|v| v.as_array()) else {
        return 0;
    };
    ratings
        .iter()
        .filter(|item| SCORE_KEYS.iter().any(|score| *score == rating_key(item)))
        .count()
}

fn payload_has_score(payload: &Value) -> bool {
    payload_score_count(payload) > 0
}

/// Whether every source answered.
///
/// A source that answers "no value for this title" is complete; a source that timed
/// out or returned 5xx/429 is not. Only complete results earn the long TTL.
fn payload_is_complete(payload: &Value) -> bool {
    payload
        .get("complete")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// `kind` is the type the result was actually resolved under, which may differ from the
/// requested one. The frontend keys its cache on it so a guessed type cannot occupy the
/// slot the resolved type reads from.
/// `typeVerified` tells the frontend that `type` came from TMDB's `/find`, not from the
/// caller's guess. Without it the hover has to try the other type as well, which costs a
/// second full backend round for every card.
fn build_payload(out: &Map<String, Value>, complete: bool, kind: &str, type_verified: bool) -> Value {
    json!({
        "ratings": ordered_ratings(out),
        "complete": complete,
        "type": kind,
        "typeVerified": type_verified,
    })
}

fn api_key_fingerprint() -> String {
    let mut hasher = DefaultHasher::new();
    for service in ["tmdb", "mdblist", "trakt"] {
        api_keys::get_api_key(service).hash(&mut hasher);
    }
    format!("{:x}", hasher.finish())
}

fn cache_lookup(key: &str) -> Option<Value> {
    let cache = ratings_cache().lock().ok()?;
    let entry = cache.get(key)?;
    if entry.at.elapsed() < entry.ttl {
        Some(entry.payload.clone())
    } else {
        None
    }
}

#[cfg(test)]
fn cache_store(key: String, payload: &Value) {
    cache_store_inner(key, payload, false);
}

fn cache_store_inner(key: String, payload: &Value, is_episode: bool) {
    let complete = payload_is_complete(payload);
    let ttl = if !payload_has_score(payload) {
        if is_episode {
            Duration::from_secs(2)
        } else {
            NEGATIVE_TTL
        }
    } else if complete {
        CACHE_TTL
    } else {
        // A source was unreachable: hold the result only long enough to absorb a
        // request burst, never long enough to look permanently broken.
        INCOMPLETE_TTL
    };
    let new_count = payload_score_count(payload);
    if let Ok(mut cache) = ratings_cache().lock() {
        if let Some(existing) = cache.get(&key) {
            if existing.at.elapsed() < existing.ttl {
                let old_complete = payload_is_complete(&existing.payload);
                if old_complete && !complete {
                    return;
                }
                let old_count = payload_score_count(&existing.payload);
                if old_count > new_count && old_complete == complete {
                    return;
                }
                if old_count == new_count && existing.ttl == CACHE_TTL && ttl == NEGATIVE_TTL {
                    return;
                }
            }
        }
        cache.insert(
            key,
            CachedRatings {
                at: Instant::now(),
                payload: payload.clone(),
                ttl,
            },
        );
        if cache.len() > 256 {
            cache.retain(|_, item| item.at.elapsed() < item.ttl);
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
    /// Which TMDB namespace `tmdb` belongs to.
    ///
    /// TMDB ids are only unique per namespace: 46260 is the series Naruto but also the
    /// movie "Saps at Sea". Querying the wrong one returns an unrelated title with a
    /// plausible score, so the namespace travels with the id instead of being derived
    /// from the caller's (possibly guessed) media type.
    tmdb_is_tv: Option<bool>,
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
        dst.tmdb_is_tv = src.tmdb_is_tv;
    } else if dst.tmdb_is_tv.is_none() {
        dst.tmdb_is_tv = src.tmdb_is_tv;
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

/// Counts sources that did not answer, so the cache can tell a missing value
/// ("this title has no RT score") from a lost race ("RT timed out").
///
/// Split by class on purpose: Jikan answers 504 for days at a time and Trakt is
/// unreachable without a key. Letting those mark every result incomplete pinned the
/// whole cache to [`INCOMPLETE_TTL`], which is what made providers appear only on the
/// third or fourth attempt.
#[derive(Debug, Default)]
struct FailureLog {
    required: std::sync::atomic::AtomicU32,
    optional: std::sync::atomic::AtomicU32,
}

type Failures = std::sync::Arc<FailureLog>;

/// Whether a source's silence should count against payload completeness.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceClass {
    /// Aggregator, Cinemeta, MDBList, TMDB — expected to carry the visible scores.
    Required,
    /// Jikan, TVMaze, Trakt — nice to have, never a reason to distrust the result.
    Optional,
}

fn new_failures() -> Failures {
    std::sync::Arc::new(FailureLog::default())
}

fn failure_count(failures: &Failures) -> u32 {
    failures.required.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(test)]
fn optional_failure_count(failures: &Failures) -> u32 {
    failures.optional.load(std::sync::atomic::Ordering::Relaxed)
}

fn note_failure_as(failures: &Failures, class: SourceClass) {
    let counter = match class {
        SourceClass::Required => &failures.required,
        SourceClass::Optional => &failures.optional,
    };
    counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// GET + JSON with failure accounting.
///
/// Transport errors, 5xx and 429 mean "source did not answer" and make the result
/// incomplete. A 404 or a plain missing field is a definitive "no value" and does not.
fn get_json(client: &Client, url: &str, headers: HeaderMap, failures: &Failures) -> Option<Value> {
    get_json_as(client, url, headers, failures, SourceClass::Required)
}

/// As [`get_json`], but a silent source does not make the payload incomplete.
fn get_json_optional(
    client: &Client,
    url: &str,
    headers: HeaderMap,
    failures: &Failures,
) -> Option<Value> {
    get_json_as(client, url, headers, failures, SourceClass::Optional)
}

fn get_json_as(
    client: &Client,
    url: &str,
    headers: HeaderMap,
    failures: &Failures,
    class: SourceClass,
) -> Option<Value> {
    let response = match client.get(url).headers(headers).send() {
        Ok(response) => response,
        Err(_) => {
            note_failure_as(failures, class);
            return None;
        }
    };
    let status = response.status();
    if status.is_server_error() || status.as_u16() == 429 {
        note_failure_as(failures, class);
        return None;
    }
    if !status.is_success() {
        return None;
    }
    match response.json::<Value>() {
        Ok(payload) => Some(payload),
        Err(_) => {
            note_failure_as(failures, class);
            None
        }
    }
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
        "series" | "tv" | "show" | "anime" => Some("series"),
        _ => None,
    }
}

/// One pooled client for the whole process.
///
/// A per-request client re-did DNS/TCP/TLS for every source, so on a cold start the
/// slower providers regularly lost the race against [`REQUEST_TIMEOUT`].
fn http_client() -> Result<Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                .pool_idle_timeout(Duration::from_secs(90))
                .pool_max_idle_per_host(4)
                .tcp_keepalive(Duration::from_secs(60))
                .build()
                .map_err(|error| format!("Ratings client init failed: {error}"))
        })
        .clone()
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

/// Show-level scores and age rating.
///
/// The aggregator ignores an `tt…:s:e` suffix and answers with series values
/// (verified: GoT S1E1 and S1E9 return the same numbers), so episode callers must
/// only take the age rating from here.
fn fetch_aggregator(
    client: &Client,
    imdb_id: &str,
    kind: &str,
    out: &mut Map<String, Value>,
    failures: &Failures,
) {
    let url = format!("{AGGREGATOR_BASE}/stream/{kind}/{imdb_id}.json");
    let Some(payload) = get_json(client, &url, default_headers(), failures) else {
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

/// Mapped S/E first, then the same absolute index in the Cinemeta calendar.
/// Positional catalog order is only used when videos have no season/episode fields.
fn find_cinemeta_video_for_mapped(
    videos: &[Value],
    season: u32,
    episode: u32,
    absolute: Option<u32>,
) -> Option<&Value> {
    if let Some(video) = find_cinemeta_video(videos, season, episode) {
        return Some(video);
    }
    let Some(absolute) = absolute.filter(|n| *n > 0) else {
        return None;
    };
    let lengths = cinemeta_season_lengths(videos);
    if let Some((mapped_season, mapped_episode)) = season_episode_from_absolute(&lengths, absolute)
    {
        if let Some(video) = find_cinemeta_video(videos, mapped_season, mapped_episode) {
            return Some(video);
        }
    }
    let has_numbered = videos.iter().any(|video| video_season_episode(video).is_some());
    if has_numbered {
        return None;
    }
    videos.get((absolute as usize).saturating_sub(1))
}

fn mapped_absolute(
    mapped: &MappedEpisode,
    cinemeta_lengths: &[u32],
    tmdb_lengths: &[u32],
) -> Option<u32> {
    if mapped.absolute > 0 {
        return Some(mapped.absolute);
    }
    absolute_from_season_episode(cinemeta_lengths, mapped.cinemeta.0, mapped.cinemeta.1).or_else(
        || absolute_from_season_episode(tmdb_lengths, mapped.tmdb.0, mapped.tmdb.1),
    )
}

/// Whether the episode was identified at a source that addresses episodes by number.
///
/// Deliberately narrower than [`ratings_map_has_score`]: TVDB and TVmaze are read from
/// rows the route points at directly, so they are present for nearly every series and
/// would mask a failed IMDb/TMDb lookup.
fn has_mapped_episode_score(out: &Map<String, Value>) -> bool {
    out.contains_key("imdb") || out.contains_key("tmdb")
}

fn episode_in_bounds(lengths: &[u32], season: u32, episode: u32) -> bool {
    episode >= 1 && season_length(lengths, season) >= episode
}

fn tmdb_coords_usable(lengths: &[u32], season: u32, episode: u32) -> bool {
    !lengths.is_empty() && episode_in_bounds(lengths, season, episode)
}

/// Whether a mapped coordinate may be trusted across provider calendars.
///
/// A direct calendar hit needs no cross-check. Anything reached through the absolute
/// index is only the same episode when both providers know the same number of regular
/// episodes: Cinemeta and TMDB both list 220 for Naruto, so index 87 is one episode in
/// both. If the totals disagree, the index means different episodes and the chip is
/// dropped rather than guessed.
///
/// Deliberately not title-based: the same Naruto episode is "Will Power! Break the
/// Water Balloon!!!" on Cinemeta, "Keep on Training: Pop Goes the Water Balloon!" on
/// TMDB and "Konjou!!! Warero mizufuusen" under its own IMDb id.
fn absolute_join_allowed(
    requested: (u32, u32),
    mapped: (u32, u32),
    cinemeta_lengths: &[u32],
    provider_total: u32,
) -> bool {
    if mapped == requested {
        return true;
    }
    let cinemeta_total: u32 = cinemeta_lengths.iter().sum();
    if cinemeta_total == 0 || provider_total == 0 {
        // Nothing to contradict the mapping.
        return true;
    }
    cinemeta_total == provider_total
}

fn episode_layout_order(layout: EpisodeLayout, season: u32) -> Vec<EpisodeLayout> {
    let mut layouts = vec![
        layout,
        EpisodeLayout::Absolute,
        EpisodeLayout::Tmdb,
        EpisodeLayout::Auto,
        EpisodeLayout::Cinemeta,
    ];
    if season > 1 && layout != EpisodeLayout::Absolute {
        layouts.retain(|item| *item != EpisodeLayout::Absolute);
    }
    let mut unique = Vec::new();
    for item in layouts {
        if !unique.contains(&item) {
            unique.push(item);
        }
    }
    unique
}

fn episode_layout_candidates(
    season: u32,
    episode: u32,
    cinemeta_lengths: &[u32],
    tmdb_lengths: &[u32],
    layout: EpisodeLayout,
) -> Vec<MappedEpisode> {
    let mut out = Vec::new();
    for item in episode_layout_order(layout, season) {
        let mapped = map_episode_layout(season, episode, cinemeta_lengths, tmdb_lengths, item);
        if !out.iter().any(|existing: &MappedEpisode| {
            existing.cinemeta == mapped.cinemeta && existing.tmdb == mapped.tmdb
        }) {
            out.push(mapped);
        }
    }
    out
}

/// Layout hint first, then the other calendars. Prefer a Cinemeta row that
/// actually carries an IMDb score so empty rows do not lock the mapping.
fn resolve_episode_against_videos(
    season: u32,
    episode: u32,
    videos: &[Value],
    cinemeta_lengths: &[u32],
    tmdb_lengths: &[u32],
    layout: EpisodeLayout,
) -> MappedEpisode {
    let candidates = episode_layout_candidates(
        season,
        episode,
        cinemeta_lengths,
        tmdb_lengths,
        layout,
    );
    let fallback = candidates
        .first()
        .copied()
        .unwrap_or_else(|| map_episode_layout(season, episode, cinemeta_lengths, tmdb_lengths, layout));
    if videos.is_empty() {
        return fallback;
    }

    // Cinemeta `videos[]` carries no IMDb score (its `rating` field is a TVDB value),
    // so the only signal a row gives us is whether it exists at all.
    for mapped in &candidates {
        let found = find_cinemeta_video_for_mapped(
            videos,
            mapped.cinemeta.0,
            mapped.cinemeta.1,
            Some(mapped.absolute).filter(|n| *n > 0).or_else(|| {
                mapped_absolute(mapped, cinemeta_lengths, tmdb_lengths)
            }),
        );
        if found.is_some() {
            return *mapped;
        }
    }
    fallback
}

fn season_length(lengths: &[u32], season: u32) -> u32 {
    if season < 1 {
        return 0;
    }
    *lengths.get((season as usize) - 1).unwrap_or(&0)
}

fn absolute_from_season_episode(lengths: &[u32], season: u32, episode: u32) -> Option<u32> {
    if !episode_in_bounds(lengths, season, episode) {
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

/// Join key: 1-based running episode number. Each provider maps this to its own S/E.
fn resolve_episode_absolute(
    season: u32,
    episode: u32,
    cinemeta_lengths: &[u32],
    tmdb_lengths: &[u32],
    layout: EpisodeLayout,
) -> u32 {
    if episode < 1 {
        return 0;
    }
    let from_cine = absolute_from_season_episode(cinemeta_lengths, season, episode);
    let from_tmdb = absolute_from_season_episode(tmdb_lengths, season, episode);
    match layout {
        EpisodeLayout::Absolute if season <= 1 => episode,
        EpisodeLayout::Absolute => resolve_episode_absolute(
            season,
            episode,
            cinemeta_lengths,
            tmdb_lengths,
            EpisodeLayout::Auto,
        ),
        EpisodeLayout::Cinemeta => from_cine.or(from_tmdb).unwrap_or(episode),
        EpisodeLayout::Tmdb => from_tmdb.or(from_cine).unwrap_or(episode),
        EpisodeLayout::Auto => from_cine.or(from_tmdb).unwrap_or(episode),
    }
}

fn cinemeta_from_absolute(lengths: &[u32], absolute: u32, requested: (u32, u32)) -> (u32, u32) {
    if absolute > 0 && season_length(lengths, 1) >= absolute {
        return (1, absolute);
    }
    season_episode_from_absolute(lengths, absolute).unwrap_or(requested)
}

fn tmdb_from_absolute(lengths: &[u32], absolute: u32) -> (u32, u32) {
    season_episode_from_absolute(lengths, absolute).unwrap_or((0, 0))
}

#[derive(Clone, Copy)]
struct MappedEpisode {
    cinemeta: (u32, u32),
    tmdb: (u32, u32),
    absolute: u32,
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
    let absolute =
        resolve_episode_absolute(season, episode, cinemeta_lengths, tmdb_lengths, layout);
    MappedEpisode {
        cinemeta: cinemeta_from_absolute(cinemeta_lengths, absolute, requested),
        tmdb: tmdb_from_absolute(tmdb_lengths, absolute),
        absolute,
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
    let failures = new_failures();
    let mut dummy_out = Map::new();
    let mut ids = ResolvedIds {
        imdb: id.clone(),
        ..ResolvedIds::default()
    };
    let videos = fetch_cinemeta_title(
        &client,
        &id,
        "series",
        &mut dummy_out,
        &mut ids,
        &failures,
    );
    let cinemeta_lengths = cinemeta_season_lengths(&videos);

    let tmdb_lengths = if let Some(hint) = tmdb_lengths_hint.filter(|hint| !hint.is_empty()) {
        hint.to_vec()
    } else {
        resolve_tmdb_id(&client, &id, "series", &mut ids, &failures);
        fetch_tmdb_season_lengths(&client, &ids, &failures)
    };

    let mapped = resolve_episode_against_videos(
        season,
        episode,
        &videos,
        &cinemeta_lengths,
        &tmdb_lengths,
        EpisodeLayout::Auto,
    );
    let absolute = mapped_absolute(&mapped, &cinemeta_lengths, &tmdb_lengths).unwrap_or(episode);

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
    failures: &Failures,
) -> Vec<Value> {
    let url = format!("{CINEMETA_BASE}/{kind}/{imdb_id}.json");
    let Some(payload) = get_json(client, &url, default_headers(), failures) else {
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
    if kind == "series" {
        apply_cinemeta_series_tvdb(meta, out);
    }
    meta.get("videos")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

/// Series-level TVDB score from Cinemeta `meta.rating` (same field as `videos[].rating`).
///
/// Cinemeta often has only `tvdb_id` and no series score — then no chip is added.
/// Never invent a series score from episode averages.
fn apply_cinemeta_series_tvdb(meta: &Value, out: &mut Map<String, Value>) {
    let Some(score) = parse_score_10(meta.get("rating")) else {
        return;
    };
    insert_rating(out, "tvdb", "TVDB", "score", &format!("{score:.1}"));
    if let Some(tvdb_id) = meta.get("tvdb_id").and_then(json_u32) {
        set_rating_url(
            out,
            "tvdb",
            &format!("https://thetvdb.com/dereferrer/series/{tvdb_id}"),
        );
    }
}

/// IMDb score from the public IMDb Ratings addon (`stream/movie/{folgen-tt}`).
///
/// Same host and lookup the addon uses for an episode `tt` (title.ratings). TMDB
/// already supplied that `tt` via `external_ids`; we do not ask `series/{show}:s:e`
/// (IMDb calendar ≠ Cinemeta/TMDB for shows like Naruto).
fn parse_imdb_ratings_addon_score(text: &str) -> Option<f64> {
    for raw in text.lines() {
        let line = clean_rating_line(raw.trim());
        if line.is_empty() || line.chars().all(|c| c == '─' || c == '-') {
            continue;
        }
        if let Some(caps) = capture_after_label(&line, "imdb") {
            if let Ok(v) = caps.parse::<f64>() {
                if v > 0.0 && v <= 10.0 {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// Fill the episode IMDb chip from the episode's own `tt`. Does not insert a series score.
fn fetch_episode_imdb_score(
    client: &Client,
    episode_imdb: &str,
    out: &mut Map<String, Value>,
    failures: &Failures,
) -> bool {
    let Some(ep) = normalize_imdb_id(episode_imdb) else {
        return false;
    };
    let url = format!("{IMDB_RATINGS_ADDON}/stream/movie/{ep}.json");
    let Some(payload) = get_json(client, &url, default_headers(), failures) else {
        return false;
    };
    let Some(streams) = payload.get("streams").and_then(|v| v.as_array()) else {
        return false;
    };
    for stream in streams {
        let desc = stream.get("description").and_then(|v| v.as_str()).unwrap_or("");
        let name = stream.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let Some(v) = parse_imdb_ratings_addon_score(&format!("{desc}\n{name}")) else {
            continue;
        };
        out.remove("imdb");
        insert_rating(out, "imdb", "IMDb", "score", &format!("{v:.1}"));
        if let Some(ext) = stream
            .get("externalUrl")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            set_rating_url(out, "imdb", ext);
        } else {
            set_rating_url(out, "imdb", &format!("https://www.imdb.com/title/{ep}/"));
        }
        return true;
    }
    false
}

/// Reads the episode title and TVDB score from already-fetched Cinemeta `videos[]`.
///
/// The row's `rating` is a TVDB value, not IMDb (Band of Brothers S1E9 is `8.6` there
/// but `9.5` on IMDb), so it is labelled TVDB and never merged into the IMDb chip. It
/// is the one episode score that needs no mapping and no request: it comes from the
/// very row the route points at.
///
/// The row's `id` is the composite `tt…:s:e`, never the episode's own `tt`, so no IMDb
/// id can be taken from here.
fn apply_cinemeta_episode_from_videos(
    videos: &[Value],
    season: u32,
    episode: u32,
    absolute: u32,
    ids: &mut ResolvedIds,
    out: &mut Map<String, Value>,
) {
    let Some(video) = find_cinemeta_video_for_mapped(videos, season, episode, Some(absolute).filter(|n| *n > 0)) else {
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
    if let Some(score) = parse_score_10(video.get("rating")) {
        insert_rating(out, "tvdb", "TVDB", "score", &format!("{score:.1}"));
        // The row carries the episode's TVDB id, and the dereferrer resolves it without
        // needing the series slug. Still zero extra requests.
        if let Some(tvdb_id) = video.get("tvdb_id").and_then(json_u32) {
            set_rating_url(
                out,
                "tvdb",
                &format!("https://thetvdb.com/dereferrer/episode/{tvdb_id}"),
            );
        }
    }
}

/// Parses a 0..10 score that may arrive as a JSON number or a string.
fn parse_score_10(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(|v| {
            v.as_f64().or_else(|| {
                v.as_str()
                    .and_then(|s| s.trim().replace(',', ".").parse::<f64>().ok())
            })
        })
        .filter(|v| *v > 0.0 && *v <= 10.0)
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

fn resolve_trakt_ids(
    client: &Client,
    imdb_id: &str,
    kind: &str,
    ids: &mut ResolvedIds,
    failures: &Failures,
) {
    let Some(headers) = trakt_headers() else {
        return;
    };
    let media = if kind == "series" { "show" } else { "movie" };
    let search_url = format!("{TRAKT_BASE}/search/imdb/{imdb_id}?type={media}");
    let Some(payload) = get_json_optional(client, &search_url, headers, failures) else {
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

fn fetch_trakt_title(
    client: &Client,
    kind: &str,
    ids: &ResolvedIds,
    out: &mut Map<String, Value>,
    failures: &Failures,
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
    let path = if kind == "series" {
        format!("{TRAKT_BASE}/shows/{id}/ratings")
    } else {
        format!("{TRAKT_BASE}/movies/{id}/ratings")
    };
    let Some(payload) = get_json_optional(client, &path, headers, failures) else {
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

/// Trakt episode lookup over its own calendar.
///
/// Trakt numbers episodes in aired order like Cinemeta, so the caller passes the
/// Cinemeta coordinates first and only falls back to the TMDB pair. Returns whether
/// Trakt answered with an episode payload.
fn fetch_trakt_episode(
    client: &Client,
    ids: &mut ResolvedIds,
    season: u32,
    episode: u32,
    out: &mut Map<String, Value>,
    failures: &Failures,
) -> bool {
    let Some(headers) = trakt_headers() else {
        return false;
    };
    if season < 1 || episode < 1 {
        return false;
    }
    let id = ids
        .trakt_slug
        .clone()
        .or_else(|| ids.trakt_id.map(|n| n.to_string()));
    let Some(id) = id else {
        return false;
    };
    let path = format!(
        "{TRAKT_BASE}/shows/{id}/seasons/{season}/episodes/{episode}?extended=full"
    );
    let Some(payload) = get_json_optional(client, &path, headers, failures) else {
        return false;
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
    true
}

fn fetch_jikan_mal(
    client: &Client,
    title: &str,
    out: &mut Map<String, Value>,
    ids: &mut ResolvedIds,
    failures: &Failures,
) {
    if title.is_empty() || out.contains_key("mal") {
        return;
    }
    let encoded = urlencoding_lite(title);
    let url = format!("{JIKAN_BASE}/anime?q={encoded}&limit=5");
    let Some(payload) = get_json_optional(client, &url, default_headers(), failures) else {
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

fn fetch_jikan_episode(
    client: &Client,
    mal_id: u64,
    episode: u32,
    out: &mut Map<String, Value>,
    failures: &Failures,
) {
    if mal_id == 0 || episode == 0 || out.contains_key("mal") {
        return;
    }
    let url = format!("{JIKAN_BASE}/anime/{mal_id}/episodes/{episode}");
    let Some(payload) = get_json_optional(client, &url, default_headers(), failures) else {
        return;
    };
    let score = payload
        .get("data")
        .and_then(|data| data.get("score"))
        .and_then(|v| v.as_f64())
        .filter(|v| *v > 0.0);
    if let Some(score) = score {
        insert_rating(out, "mal", "MyAnimeList", "score", &format!("{score:.1}"));
    }
}

fn resolve_mal_id(kitsu_id: Option<u64>, title: &str, ids: &mut ResolvedIds) {
    if ids.mal.is_some() {
        return;
    }
    if let Some(kitsu) = kitsu_id.filter(|id| *id > 0) {
        if let Ok(Some(mal)) = super::aniskip_proxy::resolve_mal_from_kitsu(kitsu) {
            ids.mal = Some(mal);
            return;
        }
    }
    if title.is_empty() {
        return;
    }
    if let Ok(Some(mal)) = super::aniskip_proxy::resolve_mal_from_jikan(title, None) {
        ids.mal = Some(mal);
    }
}

fn resolve_tmdb_id(
    client: &Client,
    imdb_id: &str,
    kind: &str,
    ids: &mut ResolvedIds,
    failures: &Failures,
) {
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
    let Some(payload) = get_json(client, &find_url, default_headers(), failures) else {
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
    let pick = |field: &str| {
        payload
            .get(field)
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
    };
    // Track which array answered: the alt fallback used to hand back an id from the
    // other namespace, which later got queried under the requested kind.
    let (first, is_tv) = match pick(primary) {
        Some(item) => (Some(item), primary == "tv_results"),
        None => (pick(alt), alt == "tv_results"),
    };
    if let Some(item) = first {
        ids.tmdb = item.get("id").and_then(|v| v.as_u64());
        ids.tmdb_is_tv = Some(is_tv);
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

/// TMDB path segment for `ids.tmdb`.
///
/// Prefers the namespace the id actually came from; only falls back to the caller's
/// media type when the id arrived from Trakt or MDBList, which report it untagged.
fn tmdb_path(ids: &ResolvedIds, kind: &str) -> &'static str {
    match ids.tmdb_is_tv {
        Some(true) => "tv",
        Some(false) => "movie",
        None => {
            if kind == "series" {
                "tv"
            } else {
                "movie"
            }
        }
    }
}

/// The media type TMDB's `/find` proves, when it contradicts the caller.
///
/// `/find` is keyed by IMDb id and answers in exactly one namespace, so a hint of
/// "movie" answered from `tv_results` is provably wrong. Worth acting on because the
/// hover panel has to guess the type from a board poster and defaults to "movie": the
/// aggregator then returns no streams at all and MDBList finds nothing, which is how a
/// series ended up showing two chips instead of six.
fn corrected_media_type(kind: &str, ids: &ResolvedIds) -> Option<&'static str> {
    match (kind, ids.tmdb_is_tv) {
        ("movie", Some(true)) => Some("series"),
        ("series", Some(false)) => Some("movie"),
        _ => None,
    }
}

fn fetch_tmdb_title(
    client: &Client,
    kind: &str,
    ids: &ResolvedIds,
    out: &mut Map<String, Value>,
    failures: &Failures,
) {
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
    let path = tmdb_path(ids, kind);
    let url = format!("{TMDB_BASE}/{path}/{tmdb_id}?api_key={api_key}");
    let Some(payload) = get_json(client, &url, default_headers(), failures) else {
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

fn fetch_tmdb_season_lengths(
    client: &Client,
    ids: &ResolvedIds,
    failures: &Failures,
) -> Vec<u32> {
    let api_key = api_keys::get_api_key("tmdb");
    let Some(tmdb_id) = ids.tmdb else {
        return Vec::new();
    };
    if api_key.is_empty() || ids.tmdb_is_tv == Some(false) {
        return Vec::new();
    }
    let url = format!("{TMDB_BASE}/tv/{tmdb_id}?api_key={api_key}");
    let Some(payload) = get_json(client, &url, default_headers(), failures) else {
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

/// Real `episode_number` values of a TMDB season, in list order.
type TmdbSeasonCache = Mutex<HashMap<(u64, u32), Vec<u32>>>;

fn tmdb_season_cache() -> &'static TmdbSeasonCache {
    static CACHE: OnceLock<TmdbSeasonCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Episode numbers TMDB actually lists for a season, in list order. Cached per season.
fn tmdb_season_numbers(
    client: &Client,
    tmdb_id: u64,
    season: u32,
    failures: &Failures,
) -> Option<Vec<u32>> {
    if season < 1 {
        return None;
    }
    if let Ok(cache) = tmdb_season_cache().lock() {
        if let Some(numbers) = cache.get(&(tmdb_id, season)) {
            return Some(numbers.clone());
        }
    }
    let api_key = api_keys::get_api_key("tmdb");
    if api_key.is_empty() {
        return None;
    }
    let url = format!("{TMDB_BASE}/tv/{tmdb_id}/season/{season}?api_key={api_key}");
    let payload = get_json(client, &url, default_headers(), failures)?;
    let episodes = payload.get("episodes").and_then(|v| v.as_array())?;
    let numbers: Vec<u32> = episodes
        .iter()
        .filter_map(|item| item.get("episode_number").and_then(json_u32))
        .collect();
    if numbers.len() != episodes.len() {
        return None;
    }
    if let Ok(mut cache) = tmdb_season_cache().lock() {
        if cache.len() > 128 {
            cache.clear();
        }
        cache.insert((tmdb_id, season), numbers.clone());
    }
    Some(numbers)
}

/// Everything a TMDB episode lookup may use to identify the episode.
struct TmdbEpisodeRef {
    /// The route's own season/episode label. `(0, 0)` skips the label stage.
    requested: (u32, u32),
    /// Season plus 1-based position inside it, derived from the absolute index.
    mapped: (u32, u32),
    /// The season length that produced `mapped.1`.
    mapped_season_len: u32,
    /// Whether the absolute index is a legitimate join across the two calendars.
    allow_absolute_join: bool,
}

/// TMDB's real season and episode number for a request.
///
/// Season/episode is a **canonical label**, not a position derived from counts:
/// Cinemeta, TMDB, Trakt and IMDb all call the same episode S3E4. So the label is tried
/// first, and it is accepted purely on TMDB listing that number in that season — no
/// count has to agree with anything. That matters because `/tv/{id}` and
/// `/tv/{id}/season/{n}` routinely disagree by an episode on running shows, and gating
/// on that agreement is what dropped the TMDb chip (and with it the episode IMDb id)
/// for normally numbered series.
///
/// The absolute index is only a **bridge for a different numbering scheme**: TMDB runs
/// Naruto continuously, so season 3 lists 105..158 and the requested "4" is simply not
/// there. Only then is the position used, and only under both rails.
///
/// `season_numbers` is a lazy lookup so the second season list is never fetched when
/// the label already matched.
fn resolve_tmdb_episode_number<F>(
    reference: &TmdbEpisodeRef,
    mut season_numbers: F,
) -> Option<(u32, u32)>
where
    F: FnMut(u32) -> Option<Vec<u32>>,
{
    let (req_season, req_episode) = reference.requested;
    let label_checked = if req_season >= 1 && req_episode >= 1 {
        match season_numbers(req_season) {
            Some(numbers) => {
                if numbers.contains(&req_episode) {
                    return Some((req_season, req_episode));
                }
                true
            }
            None => false,
        }
    } else {
        false
    };

    if !reference.allow_absolute_join {
        return None;
    }
    let (season, position) = reference.mapped;
    if season < 1 || position < 1 {
        return None;
    }
    if label_checked && (season, position) == (req_season, req_episode) {
        // Already rejected as a label above; the same pair cannot become a position.
        return None;
    }
    let numbers = season_numbers(season)?;
    if reference.mapped_season_len > 0 && numbers.len() != reference.mapped_season_len as usize {
        return None;
    }
    let number = *numbers.get((position as usize) - 1)?;
    Some((season, number))
}

/// TMDB episode: gives the TMDb chip **and** the episode's own IMDb id via
/// `external_ids`, which is what unlocks the real IMDb episode score.
fn fetch_tmdb_episode(
    client: &Client,
    ids: &mut ResolvedIds,
    reference: &TmdbEpisodeRef,
    out: &mut Map<String, Value>,
    failures: &Failures,
) -> bool {
    let api_key = api_keys::get_api_key("tmdb");
    let Some(tmdb_id) = ids.tmdb else {
        return false;
    };
    if api_key.is_empty() || ids.tmdb_is_tv == Some(false) {
        return false;
    }
    let resolved = resolve_tmdb_episode_number(reference, |season| {
        tmdb_season_numbers(client, tmdb_id, season, failures)
    });
    let Some((season, episode)) = resolved else {
        return false;
    };
    let url = format!(
        "{TMDB_BASE}/tv/{tmdb_id}/season/{season}/episode/{episode}?api_key={api_key}&append_to_response=external_ids"
    );
    let Some(payload) = get_json(client, &url, default_headers(), failures) else {
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

fn fetch_mdblist(
    client: &Client,
    imdb_id: &str,
    kind: &str,
    out: &mut Map<String, Value>,
    ids: &mut ResolvedIds,
    failures: &Failures,
) {
    let api_key = api_keys::get_api_key("mdblist");
    if api_key.is_empty() {
        return;
    }
    let media = if kind == "series" { "show" } else { "movie" };
    let url = format!("https://api.mdblist.com/imdb/{media}/{imdb_id}?apikey={api_key}");
    let Some(payload) = get_json(client, &url, default_headers(), failures) else {
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
/// Index into TVMaze's episode list for an absolute episode number.
///
/// Only a join when TVMaze lists exactly as many episodes as Cinemeta; otherwise the
/// same index is a different episode on each side.
fn tvmaze_absolute_index(
    listed: usize,
    cinemeta_total: u32,
    absolute: u32,
) -> Option<usize> {
    if absolute < 1 || cinemeta_total == 0 || listed != cinemeta_total as usize {
        return None;
    }
    Some((absolute as usize) - 1)
}

/// TVMaze episode title and score.
///
/// Fetches the whole episode list instead of `episodebynumber`, because TVMaze numbers
/// long-running anime by broadcast year — Naruto's episodes sit on seasons 2002..2007,
/// so asking for season 3 episode 4 never matched anything. The list is in aired order,
/// excludes specials, and every entry carries `rating.average`.
///
/// The absolute index is only used as a join when TVMaze knows exactly as many episodes
/// as Cinemeta; otherwise the index would point at a different episode.
/// TVmaze show-level score from `/lookup/shows?imdb=`.
///
/// The lookup payload already carries `rating.average` and the show URL; no extra hop.
fn apply_tvmaze_show_rating(show: &Value, ids: &mut ResolvedIds, out: &mut Map<String, Value>) {
    if ids.title.is_empty() {
        if let Some(name) = show.get("name").and_then(|v| v.as_str()) {
            ids.title = name.to_string();
        }
    }
    if let Some(score) = parse_score_10(show.get("rating").and_then(|v| v.get("average"))) {
        insert_rating(out, "tvmaze", "TVmaze", "score", &format!("{score:.1}"));
        if let Some(url) = show
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| s.starts_with("https://"))
        {
            set_rating_url(out, "tvmaze", url);
        }
    }
}

fn fetch_tvmaze_show_rating(
    client: &Client,
    imdb_id: &str,
    ids: &mut ResolvedIds,
    out: &mut Map<String, Value>,
    failures: &Failures,
) {
    let lookup = format!("{TVMAZE_BASE}/lookup/shows?imdb={imdb_id}");
    let Some(show) = get_json_optional(client, &lookup, default_headers(), failures) else {
        return;
    };
    apply_tvmaze_show_rating(&show, ids, out);
}

fn fetch_tvmaze_episode_meta(
    client: &Client,
    imdb_id: &str,
    ids: &mut ResolvedIds,
    season: u32,
    episode: u32,
    absolute: u32,
    cinemeta_total: u32,
    out: &mut Map<String, Value>,
    failures: &Failures,
) {
    if season < 1 || episode < 1 {
        return;
    }
    let lookup = format!("{TVMAZE_BASE}/lookup/shows?imdb={imdb_id}");
    let Some(show) = get_json_optional(client, &lookup, default_headers(), failures) else {
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
    let list_url = format!("{TVMAZE_BASE}/shows/{show_id}/episodes");
    let Some(list) = get_json_optional(client, &list_url, default_headers(), failures) else {
        return;
    };
    let Some(episodes) = list.as_array() else {
        return;
    };
    let exact = episodes.iter().find(|item| {
        item.get("season").and_then(json_u32) == Some(season)
            && item.get("number").and_then(json_u32) == Some(episode)
    });
    let picked = match exact {
        Some(item) => Some(item),
        None => tvmaze_absolute_index(episodes.len(), cinemeta_total, absolute)
            .and_then(|index| episodes.get(index)),
    };
    let Some(ep) = picked else {
        return;
    };
    if ids.episode_name.is_empty() {
        if let Some(name) = ep.get("name").and_then(|v| v.as_str()) {
            ids.episode_name = name.to_string();
        }
    }
    if let Some(score) = parse_score_10(ep.get("rating").and_then(|v| v.get("average"))) {
        insert_rating(out, "tvmaze", "TVmaze", "score", &format!("{score:.1}"));
        if let Some(url) = ep
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| s.starts_with("https://"))
        {
            set_rating_url(out, "tvmaze", url);
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
        "tvmaze",
        "tvdb",
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
    kitsu_id: Option<u64>,
) -> Result<Value, String> {
    let id = normalize_imdb_id(imdb_id)
        .ok_or_else(|| "Ratings lookup requires a valid IMDb id (tt…).".to_string())?;
    // May be corrected mid-flight once TMDB's `/find` proves the namespace.
    let mut kind = normalize_media_type(media_type)
        .ok_or_else(|| "Ratings lookup requires media type movie or series.".to_string())?;

    let fast_only = mode.eq_ignore_ascii_case("fast");
    let episode_mode = kind == "series"
        && matches!((season, episode), (Some(s), Some(e)) if s > 0 && e > 0);
    let season_n = season.filter(|s| *s > 0);
    let episode_n = episode.filter(|e| *e > 0);
    let layout = parse_episode_layout(episode_layout, exact_cinemeta);
    let cache_key = format!(
        "{id}:{kind}:{}:{}:{}:{}:{}:{}",
        season_n.unwrap_or(0),
        episode_n.unwrap_or(0),
        if fast_only { "fast" } else { "full" },
        layout.cache_key(),
        kitsu_id.unwrap_or(0),
        api_key_fingerprint()
    );
    if let Some(cached) = cache_lookup(&cache_key) {
        return Ok(cached);
    }

    let client = http_client()?;
    let failures = new_failures();
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
        let fail_cin = failures.clone();
        let cin_h = scope.spawn(move || {
            let mut local = Map::new();
            let mut local_ids = ResolvedIds {
                imdb: id_cin.clone(),
                ..ResolvedIds::default()
            };
            let videos = fetch_cinemeta_title(
                &client_cin,
                &id_cin,
                &kind_cin,
                &mut local,
                &mut local_ids,
                &fail_cin,
            );
            (videos, local, local_ids)
        });
        let agg_h = if episode_mode && !fast_only {
            None
        } else {
            let client_agg = client.clone();
            let id_agg = id.clone();
            let kind_agg = kind.to_string();
            let fail_agg = failures.clone();
            let fsk_only = episode_mode;
            Some(scope.spawn(move || {
                let mut local = Map::new();
                fetch_aggregator(&client_agg, &id_agg, &kind_agg, &mut local, &fail_agg);
                if fsk_only {
                    local.retain(|key, _| key == "fsk");
                }
                local
            }))
        };
        // The two id lookups depend on nothing, so they ride along here instead of
        // costing their own round trip. Skipped in fast mode, which stays as cheap as
        // it is. Resolving the TMDB id this early is also what lets every later source
        // start out with a proven media type instead of the caller's guess.
        let (tmdb_id_h, trakt_id_h) = if fast_only {
            (None, None)
        } else {
            let client_tmdb = client.clone();
            let id_tmdb = id.clone();
            let kind_tmdb = kind.to_string();
            let fail_tmdb = failures.clone();
            let tmdb_h = scope.spawn(move || {
                let mut local = ResolvedIds {
                    imdb: id_tmdb.clone(),
                    ..ResolvedIds::default()
                };
                resolve_tmdb_id(&client_tmdb, &id_tmdb, &kind_tmdb, &mut local, &fail_tmdb);
                local
            });
            let client_trakt = client.clone();
            let id_trakt = id.clone();
            let kind_trakt = kind.to_string();
            let fail_trakt = failures.clone();
            let trakt_h = scope.spawn(move || {
                let mut local = ResolvedIds {
                    imdb: id_trakt.clone(),
                    ..ResolvedIds::default()
                };
                resolve_trakt_ids(&client_trakt, &id_trakt, &kind_trakt, &mut local, &fail_trakt);
                local
            });
            (Some(tmdb_h), Some(trakt_h))
        };

        // Cinemeta first: its name is the one the deep links and the MAL search use.
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
        if let Some(handle) = tmdb_id_h {
            if let Ok(extra) = handle.join() {
                merge_ids(&mut ids, extra);
            }
        }
        if let Some(handle) = trakt_id_h {
            if let Ok(extra) = handle.join() {
                merge_ids(&mut ids, extra);
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
        // Fast mode never calls `/find`, so the type stays a guess by definition.
        let payload = build_payload(&out, failure_count(&failures) == 0, kind, false);
        cache_store_inner(cache_key, &payload, episode_mode);
        return Ok(payload);
    }

    let started = Instant::now();
    // Extras only — scored sources are never skipped, see EXTRAS_BUDGET.
    let extras_budget = || started.elapsed() < EXTRAS_BUDGET;

    if episode_mode {
        let mut tmdb_lengths = Vec::new();
        let mut lengths_tried = false;
        std::thread::scope(|scope| {
            // The TMDB id already came out of phase 1, so the season calendar is one
            // request now rather than /find followed by /tv.
            let client_tmdb = client.clone();
            let ids_tmdb = ids.clone();
            let fail_tmdb = failures.clone();
            let tmdb_h = scope.spawn(move || {
                let tried = ids_tmdb.tmdb.is_some();
                let lengths = fetch_tmdb_season_lengths(&client_tmdb, &ids_tmdb, &fail_tmdb);
                (lengths, tried)
            });
            let client_mdb = client.clone();
            let id_mdb = id.clone();
            let kind_mdb = kind.to_string();
            let fail_mdb = failures.clone();
            let mdb_h = scope.spawn(move || {
                let mut id_only = Map::new();
                let mut local_ids = ResolvedIds {
                    imdb: id_mdb.clone(),
                    ..ResolvedIds::default()
                };
                fetch_mdblist(
                    &client_mdb,
                    &id_mdb,
                    &kind_mdb,
                    &mut id_only,
                    &mut local_ids,
                    &fail_mdb,
                );
                local_ids
            });

            if let Ok((lengths, tried)) = tmdb_h.join() {
                tmdb_lengths = lengths;
                lengths_tried = tried;
            }
            if let Ok(extra) = mdb_h.join() {
                merge_ids(&mut ids, extra);
            }
        });

        let s = season_n.unwrap();
        let e = episode_n.unwrap();
        let cinemeta_lengths = cinemeta_season_lengths(&cinemeta_videos);
        // Only worth a second look if Trakt or MDBList supplied the TMDB id we lacked.
        if !lengths_tried && ids.tmdb.is_some() {
            tmdb_lengths = fetch_tmdb_season_lengths(&client, &ids, &failures);
        }
        let mapped = resolve_episode_against_videos(
            s,
            e,
            &cinemeta_videos,
            &cinemeta_lengths,
            &tmdb_lengths,
            layout,
        );
        mapped_season = Some(mapped.cinemeta.0);
        mapped_episode = Some(mapped.cinemeta.1);
        let absolute = mapped.absolute.max(mapped_absolute(&mapped, &cinemeta_lengths, &tmdb_lengths).unwrap_or(e));
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
        let cinemeta_total: u32 = cinemeta_lengths.iter().sum();
        let tmdb_total: u32 = tmdb_lengths.iter().sum();
        // Only the absolute bridge needs this; the label stage stands on its own.
        let allow_absolute_join = tmdb_coords_usable(&tmdb_lengths, tmdb_season, tmdb_episode)
            && absolute_join_allowed(
                (s, e),
                (tmdb_season, tmdb_episode),
                &cinemeta_lengths,
                tmdb_total,
            );
        let tmdb_reference = TmdbEpisodeRef {
            requested: (s, e),
            mapped: (tmdb_season, tmdb_episode),
            mapped_season_len: season_length(&tmdb_lengths, tmdb_season),
            allow_absolute_join,
        };
        let jikan_episode = if kitsu_id.filter(|id| *id > 0).is_some() || layout == EpisodeLayout::Absolute
        {
            e
        } else {
            absolute.max(1)
        };
        let title_for_mal = ids.title.clone();
        resolve_mal_id(kitsu_id, &title_for_mal, &mut ids);
        std::thread::scope(|scope| {
            let client_ep = client.clone();
            let fail_ep = failures.clone();
            let mut ids_tmdb = ids.clone();
            let tmdb_h = scope.spawn(move || {
                let mut local = Map::new();
                fetch_tmdb_episode(
                    &client_ep,
                    &mut ids_tmdb,
                    &tmdb_reference,
                    &mut local,
                    &fail_ep,
                );
                (local, ids_tmdb)
            });
            // Trakt keeps its own aired-order calendar, which matches Cinemeta — so ask
            // with the Cinemeta pair first and only fall back to the TMDB pair.
            let client_trakt = client.clone();
            let fail_trakt = failures.clone();
            let mut ids_trakt = ids.clone();
            let trakt_h = scope.spawn(move || {
                let mut local = Map::new();
                let answered = fetch_trakt_episode(
                    &client_trakt,
                    &mut ids_trakt,
                    cin_season,
                    cin_episode,
                    &mut local,
                    &fail_trakt,
                );
                if !answered && (tmdb_season, tmdb_episode) != (cin_season, cin_episode) {
                    fetch_trakt_episode(
                        &client_trakt,
                        &mut ids_trakt,
                        tmdb_season,
                        tmdb_episode,
                        &mut local,
                        &fail_trakt,
                    );
                }
                (local, ids_trakt)
            });
            let client_fsk = client.clone();
            let id_fsk = id.clone();
            let kind_fsk = kind.to_string();
            let fail_fsk = failures.clone();
            let already_fsk = out.contains_key("fsk");
            let fsk_h = if already_fsk {
                None
            } else {
                Some(scope.spawn(move || {
                    let mut local = Map::new();
                    fetch_aggregator(&client_fsk, &id_fsk, &kind_fsk, &mut local, &fail_fsk);
                    local.remove("fsk")
                }))
            };
            let client_tv = client.clone();
            let id_tv = id.clone();
            let fail_tv = failures.clone();
            let mut ids_tv = ids.clone();
            let tv_h = scope.spawn(move || {
                let mut local = Map::new();
                fetch_tvmaze_episode_meta(
                    &client_tv,
                    &id_tv,
                    &mut ids_tv,
                    cin_season,
                    cin_episode,
                    absolute,
                    cinemeta_total,
                    &mut local,
                    &fail_tv,
                );
                (local, ids_tv)
            });

            let client_jikan = client.clone();
            let fail_jikan = failures.clone();
            let mal_id = ids.mal;
            let jikan_h = if mal_id.filter(|id| *id > 0).is_some() && jikan_episode > 0 {
                Some(scope.spawn(move || {
                    let mut local = Map::new();
                    if let Some(mal) = mal_id {
                        fetch_jikan_episode(
                            &client_jikan,
                            mal,
                            jikan_episode,
                            &mut local,
                            &fail_jikan,
                        );
                    }
                    local
                }))
            } else {
                None
            };

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
            if let Ok((local, extra)) = tv_h.join() {
                merge_ratings(&mut out, local);
                merge_ids(&mut ids, extra);
            }
            if let Some(handle) = jikan_h {
                if let Ok(local) = handle.join() {
                    merge_ratings(&mut out, local);
                }
            }
        });

        // The one verified IMDb-per-episode path. Never budget-gated: skipping it is
        // exactly why the bar showed TMDb without IMDb.
        let mut imdb_from_episode = false;
        if let Some(ep_imdb) = ids.episode_imdb.clone() {
            if normalize_imdb_id(&ep_imdb).is_some() {
                imdb_from_episode =
                    fetch_episode_imdb_score(&client, &ep_imdb, &mut out, &failures);
            }
        }

        // Gated on the two sources that identify the episode by number. TVDB and TVmaze
        // come from rows that need no mapping, so counting them here would satisfy the
        // check on almost every series and silently disable the ladder below.
        if !has_mapped_episode_score(&out) && extras_budget() {
            let candidates = episode_layout_candidates(s, e, &cinemeta_lengths, &tmdb_lengths, layout);
            for next in candidates {
                if next.cinemeta == (cin_season, cin_episode) && next.tmdb == (tmdb_season, tmdb_episode)
                {
                    continue;
                }
                apply_cinemeta_episode_from_videos(
                    &cinemeta_videos,
                    next.cinemeta.0,
                    next.cinemeta.1,
                    next.absolute,
                    &mut ids,
                    &mut out,
                );
                if tmdb_coords_usable(&tmdb_lengths, next.tmdb.0, next.tmdb.1)
                    && absolute_join_allowed((s, e), next.tmdb, &cinemeta_lengths, tmdb_total)
                {
                    let mut local = Map::new();
                    let mut tmdb_ids = ids.clone();
                    let before = tmdb_ids.episode_imdb.clone();
                    // The route's label was already tried on the first attempt, so this
                    // ladder only explores alternative positions.
                    let next_reference = TmdbEpisodeRef {
                        requested: (0, 0),
                        mapped: next.tmdb,
                        mapped_season_len: season_length(&tmdb_lengths, next.tmdb.0),
                        allow_absolute_join: true,
                    };
                    fetch_tmdb_episode(
                        &client,
                        &mut tmdb_ids,
                        &next_reference,
                        &mut local,
                        &failures,
                    );
                    let fresh_ep_imdb = tmdb_ids
                        .episode_imdb
                        .clone()
                        .filter(|found| Some(found) != before.as_ref());
                    merge_ids(&mut ids, tmdb_ids);
                    merge_ratings(&mut out, local);
                    if let Some(ep_imdb) = fresh_ep_imdb {
                        if !imdb_from_episode {
                            imdb_from_episode = fetch_episode_imdb_score(
                                &client,
                                &ep_imdb,
                                &mut out,
                                &failures,
                            );
                        }
                    }
                }
                if has_mapped_episode_score(&out) {
                    mapped_season = Some(next.cinemeta.0);
                    mapped_episode = Some(next.cinemeta.1);
                    break;
                }
            }
        }
        if !out.contains_key("mal") && extras_budget() {
            let title_for_mal = ids.title.clone();
            resolve_mal_id(kitsu_id, &title_for_mal, &mut ids);
            if let Some(mal) = ids.mal {
                fetch_jikan_episode(&client, mal, jikan_episode, &mut out, &failures);
            }
        }
    } else {
        // Phase 1 already proved the media type, so correcting it is no longer an extra
        // round: the repeat of Cinemeta and the aggregator simply joins this phase.
        let retype = corrected_media_type(kind, &ids);
        if let Some(corrected) = retype {
            kind = corrected;
            // Whatever the wrong type produced has to go, or `merge_ratings` would keep
            // it and the corrected values would never be seen.
            out.retain(|key, _| !SCORE_KEYS.contains(&key.as_str()));
        }

        std::thread::scope(|scope| {
            let client_mdb = client.clone();
            let id_mdb = id.clone();
            let kind_mdb = kind.to_string();
            let fail_mdb = failures.clone();
            let mdb_h = scope.spawn(move || {
                let mut local_out = Map::new();
                let mut local_ids = ResolvedIds {
                    imdb: id_mdb.clone(),
                    ..ResolvedIds::default()
                };
                fetch_mdblist(
                    &client_mdb,
                    &id_mdb,
                    &kind_mdb,
                    &mut local_out,
                    &mut local_ids,
                    &fail_mdb,
                );
                (local_out, local_ids)
            });
            let client_tmdb = client.clone();
            let kind_tmdb = kind.to_string();
            let ids_tmdb = ids.clone();
            let fail_tmdb = failures.clone();
            let tmdb_h = scope.spawn(move || {
                let mut local = Map::new();
                fetch_tmdb_title(&client_tmdb, &kind_tmdb, &ids_tmdb, &mut local, &fail_tmdb);
                local
            });
            let client_trakt = client.clone();
            let kind_trakt = kind.to_string();
            let ids_trakt = ids.clone();
            let fail_trakt = failures.clone();
            let trakt_h = scope.spawn(move || {
                let mut local = Map::new();
                fetch_trakt_title(&client_trakt, &kind_trakt, &ids_trakt, &mut local, &fail_trakt);
                local
            });
            let title_for_mal = ids.title.clone();
            let jikan_h = if !title_for_mal.is_empty() && extras_budget() {
                let client_jikan = client.clone();
                let fail_jikan = failures.clone();
                Some(scope.spawn(move || {
                    let mut local = Map::new();
                    let mut local_ids = ResolvedIds::default();
                    fetch_jikan_mal(
                        &client_jikan,
                        &title_for_mal,
                        &mut local,
                        &mut local_ids,
                        &fail_jikan,
                    );
                    (local, local_ids)
                }))
            } else {
                None
            };
            let tvmaze_h = if kind == "series" {
                let client_tv = client.clone();
                let id_tv = id.clone();
                let fail_tv = failures.clone();
                let mut ids_tv = ids.clone();
                Some(scope.spawn(move || {
                    let mut local = Map::new();
                    fetch_tvmaze_show_rating(
                        &client_tv,
                        &id_tv,
                        &mut ids_tv,
                        &mut local,
                        &fail_tv,
                    );
                    (local, ids_tv)
                }))
            } else {
                None
            };
            let retype_h = retype.map(|corrected| {
                let client_cin = client.clone();
                let id_cin = id.clone();
                let fail_cin = failures.clone();
                let client_agg = client.clone();
                let id_agg = id.clone();
                let fail_agg = failures.clone();
                let cin_h = scope.spawn(move || {
                    let mut local = Map::new();
                    let mut local_ids = ResolvedIds {
                        imdb: id_cin.clone(),
                        ..ResolvedIds::default()
                    };
                    fetch_cinemeta_title(
                        &client_cin,
                        &id_cin,
                        corrected,
                        &mut local,
                        &mut local_ids,
                        &fail_cin,
                    );
                    (local, local_ids)
                });
                let agg_h = scope.spawn(move || {
                    let mut local = Map::new();
                    fetch_aggregator(&client_agg, &id_agg, corrected, &mut local, &fail_agg);
                    local
                });
                (cin_h, agg_h)
            });

            // Corrected Cinemeta and aggregator first: they are the authority on the
            // name and the age rating that everything below is joined against.
            if let Some((cin_h, agg_h)) = retype_h {
                if let Ok((local, extra)) = cin_h.join() {
                    if !extra.title.is_empty() {
                        ids.title = extra.title.clone();
                    }
                    merge_ratings(&mut out, local);
                    merge_ids(&mut ids, extra);
                }
                if let Ok(local) = agg_h.join() {
                    merge_ratings(&mut out, local);
                }
            }
            if let Ok((mdb_out, extra)) = mdb_h.join() {
                merge_ratings(&mut out, mdb_out);
                merge_ids(&mut ids, extra);
            }
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
            if let Some(handle) = tvmaze_h {
                if let Ok((local, extra)) = handle.join() {
                    merge_ratings(&mut out, local);
                    merge_ids(&mut ids, extra);
                }
            }
        });
    }

    attach_deep_links(&mut out, kind, &ids, mapped_season, mapped_episode);
    let payload = build_payload(
        &out,
        failure_count(&failures) == 0,
        kind,
        ids.tmdb_is_tv.is_some(),
    );
    cache_store_inner(cache_key, &payload, episode_mode);
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_has_score_ignores_age_only() {
        assert!(!payload_has_score(&json!({ "ratings": [] })));
        assert!(!payload_has_score(&json!({
            "ratings": [{ "key": "fsk", "value": "16" }]
        })));
        assert!(payload_has_score(&json!({
            "ratings": [{ "key": "imdb", "value": "8.1" }]
        })));
    }

    #[test]
    fn empty_ratings_use_negative_ttl() {
        let _guard = cache_test_lock();
        clear_ratings_cache();
        cache_store(
            "empty-test".to_string(),
            &json!({ "ratings": [] }),
        );
        let cache = ratings_cache().lock().expect("ratings cache");
        let entry = cache.get("empty-test").expect("stored empty");
        assert_eq!(entry.ttl, NEGATIVE_TTL);
    }

    #[test]
    fn incomplete_ratings_use_short_ttl() {
        let _guard = cache_test_lock();
        clear_ratings_cache();
        cache_store(
            "incomplete-title".to_string(),
            &json!({
                "complete": false,
                "ratings": [
                    { "key": "imdb", "value": "7.5" },
                    { "key": "tmdb", "value": "48%" }
                ]
            }),
        );
        let cache = ratings_cache().lock().expect("ratings cache");
        let entry = cache.get("incomplete-title").expect("stored incomplete");
        assert_eq!(entry.ttl, INCOMPLETE_TTL);
    }

    #[test]
    fn complete_thin_ratings_keep_full_ttl() {
        let _guard = cache_test_lock();
        clear_ratings_cache();
        cache_store(
            "complete-thin-title".to_string(),
            &json!({
                "complete": true,
                "ratings": [
                    { "key": "imdb", "value": "7.5" },
                    { "key": "tmdb", "value": "48%" },
                    { "key": "fsk", "value": "16" }
                ]
            }),
        );
        let cache = ratings_cache().lock().expect("ratings cache");
        let entry = cache
            .get("complete-thin-title")
            .expect("a title without RT/MC is still a complete answer");
        assert_eq!(entry.ttl, CACHE_TTL);
    }

    #[test]
    fn incomplete_ratings_do_not_overwrite_complete() {
        let _guard = cache_test_lock();
        clear_ratings_cache();
        cache_store(
            "downgrade-test".to_string(),
            &json!({
                "complete": true,
                "ratings": [
                    { "key": "imdb", "value": "8.4" },
                    { "key": "rt", "value": "91%" }
                ]
            }),
        );
        cache_store(
            "downgrade-test".to_string(),
            &json!({
                "complete": false,
                "ratings": [
                    { "key": "imdb", "value": "8.4" },
                    { "key": "rt", "value": "91%" },
                    { "key": "trakt", "value": "80%" }
                ]
            }),
        );
        let cache = ratings_cache().lock().expect("ratings cache");
        let entry = cache.get("downgrade-test").expect("kept complete");
        assert_eq!(entry.ttl, CACHE_TTL);
        assert_eq!(payload_score_count(&entry.payload), 2);
    }

    #[test]
    fn rich_title_ratings_use_full_ttl() {
        let _guard = cache_test_lock();
        clear_ratings_cache();
        cache_store(
            "rich-title".to_string(),
            &json!({
                "ratings": [
                    { "key": "imdb", "value": "8.1" },
                    { "key": "rt", "value": "84%" },
                    { "key": "tmdb", "value": "74%" }
                ]
            }),
        );
        let cache = ratings_cache().lock().expect("ratings cache");
        let entry = cache.get("rich-title").expect("stored rich");
        assert_eq!(entry.ttl, CACHE_TTL);
    }

    #[test]
    fn empty_episode_ratings_use_short_ttl() {
        let _guard = cache_test_lock();
        clear_ratings_cache();
        cache_store_inner(
            "empty-episode".to_string(),
            &json!({ "ratings": [] }),
            true,
        );
        let cache = ratings_cache().lock().expect("ratings cache");
        let entry = cache.get("empty-episode").expect("stored empty episode");
        assert_eq!(entry.ttl, Duration::from_secs(2));
    }

    #[test]
    fn episode_imdb_tmdb_keeps_full_ttl() {
        let _guard = cache_test_lock();
        clear_ratings_cache();
        cache_store_inner(
            "episode-thin-ok".to_string(),
            &json!({
                "ratings": [
                    { "key": "imdb", "value": "8.4" },
                    { "key": "tmdb", "value": "82%" }
                ]
            }),
            true,
        );
        let cache = ratings_cache().lock().expect("ratings cache");
        let entry = cache.get("episode-thin-ok").expect("stored episode");
        assert_eq!(entry.ttl, CACHE_TTL);
    }

    #[test]
    fn parse_imdb_ratings_addon_score_reads_episode_tt_payload() {
        let score = parse_imdb_ratings_addon_score(
            "────────────────\n⭐ IMDb: 8.9/10\n (81,271 votes)\n────────────────",
        );
        assert_eq!(score, Some(8.9));
        assert!(parse_imdb_ratings_addon_score("⭐ TMDb : 8.7/10").is_none());
    }

    #[test]
    fn episode_imdb_chip_from_addon_payload() {
        let mut out = Map::new();
        let payload = json!({
            "streams": [{
                "name": "IMDb Rating",
                "description": "⭐ IMDb: 8.9/10",
                "externalUrl": "https://www.imdb.com/title/tt1480055/"
            }]
        });
        let streams = payload.get("streams").and_then(|v| v.as_array()).unwrap();
        let stream = &streams[0];
        let desc = stream.get("description").and_then(|v| v.as_str()).unwrap();
        let v = parse_imdb_ratings_addon_score(desc).expect("score");
        insert_rating(&mut out, "imdb", "IMDb", "score", &format!("{v:.1}"));
        set_rating_url(
            &mut out,
            "imdb",
            stream.get("externalUrl").and_then(|u| u.as_str()).unwrap(),
        );
        assert_eq!(out.get("imdb").and_then(|c| c.get("value")).and_then(|v| v.as_str()), Some("8.9"));
        assert_eq!(
            out.get("imdb").and_then(|c| c.get("url")).and_then(|v| v.as_str()),
            Some("https://www.imdb.com/title/tt1480055/")
        );
    }

    #[test]
    fn episode_out_has_no_imdb_without_an_episode_score() {
        let mut out = Map::new();
        insert_rating(&mut out, "imdb", "IMDb", "score", "9.3");
        insert_rating(&mut out, "tmdb", "TMDB", "percent", "86%");
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
        assert!(!out.contains_key("imdb"));
        assert!(parse_imdb_ratings_addon_score("").is_none());
    }

    #[test]
    fn richer_cache_is_not_replaced_by_thinner() {
        let _guard = cache_test_lock();
        clear_ratings_cache();
        cache_store(
            "replace-test".to_string(),
            &json!({
                "ratings": [
                    { "key": "imdb", "value": "8.1" },
                    { "key": "rt", "value": "90%" },
                    { "key": "trakt", "value": "77%" }
                ]
            }),
        );
        cache_store(
            "replace-test".to_string(),
            &json!({
                "ratings": [
                    { "key": "imdb", "value": "7.5" },
                    { "key": "tmdb", "value": "48%" }
                ]
            }),
        );
        let cache = ratings_cache().lock().expect("ratings cache");
        let entry = cache.get("replace-test").expect("kept rich");
        assert_eq!(payload_score_count(&entry.payload), 3);
        assert_eq!(entry.ttl, CACHE_TTL);
    }

    #[test]
    fn split_calendar_absolute_87_maps_to_cinemeta_s3e4() {
        // Synthetic split-season calendars; not claimed to be any specific show.
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 52];
        let mapped = map_episode_layout(2, 87, &cinemeta, &tmdb, EpisodeLayout::Auto);
        assert_eq!(mapped.cinemeta, (3, 4));
        assert_eq!(mapped.tmdb, (2, 35));
    }

    #[test]
    fn split_calendar_absolute_86_maps_to_cinemeta_s3e3() {
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
    fn tmdb_s3e3_differs_from_cinemeta_s3e3_on_split_calendars() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 52];
        let mapped = map_episode_layout(3, 3, &cinemeta, &tmdb, EpisodeLayout::Tmdb);
        assert_eq!(mapped.tmdb, (3, 3));
        assert_ne!(mapped.cinemeta, (3, 3));
        assert_eq!(mapped.cinemeta, (3, 24));
    }

    #[test]
    fn tmdb_s2e86_maps_to_cinemeta_s3e3_on_split_calendars() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 52];
        let mapped = map_episode_layout(2, 86, &cinemeta, &tmdb, EpisodeLayout::Tmdb);
        assert_eq!(mapped.cinemeta, (3, 3));
        assert_eq!(mapped.tmdb, (2, 34));
    }

    #[test]
    fn split_calendar_cinemeta_s1e1_stays() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 52];
        let mapped = map_episode_layout(1, 1, &cinemeta, &tmdb, EpisodeLayout::Cinemeta);
        assert_eq!(mapped.cinemeta, (1, 1));
        assert_eq!(mapped.tmdb, (1, 1));
    }

    #[test]
    fn composite_video_id_counts_as_s3e3() {
        let video = json!({ "id": "tt0409591:3:3" });
        assert_eq!(video_season_episode(&video), Some((3, 3)));
        let with_fields = json!({ "id": "tt0409591:3:3", "season": 0, "episode": 0 });
        assert_eq!(video_season_episode(&with_fields), Some((3, 3)));
        let lengths = cinemeta_season_lengths(&[video]);
        assert_eq!(lengths.get(2), Some(&1));
    }

    fn videos_for_lengths(lengths: &[u32]) -> Vec<Value> {
        lengths
            .iter()
            .enumerate()
            .flat_map(|(index, count)| {
                let season = index as u32 + 1;
                (1..=*count).map(move |episode| {
                    json!({
                        "id": format!("tt0409591:{season}:{episode}"),
                        "season": season,
                        "episode": episode
                    })
                })
            })
            .collect()
    }

    #[test]
    fn kitsu_absolute_86_hits_cinemeta_s3e3() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 52];
        let videos = videos_for_lengths(&cinemeta);
        let mapped = resolve_episode_against_videos(
            1,
            86,
            &videos,
            &cinemeta,
            &tmdb,
            EpisodeLayout::Absolute,
        );
        assert_eq!(mapped.cinemeta, (3, 3));
    }

    #[test]
    fn cinemeta_s3e3_missing_maps_via_tmdb_to_single_season() {
        let cinemeta = vec![220];
        let tmdb = vec![52, 52, 52, 52];
        let videos = videos_for_lengths(&cinemeta);
        let mapped = resolve_episode_against_videos(
            3,
            3,
            &videos,
            &cinemeta,
            &tmdb,
            EpisodeLayout::Cinemeta,
        );
        assert_eq!(mapped.cinemeta, (1, 107));
        assert_eq!(mapped.tmdb, (3, 3));
        assert!(find_cinemeta_video(&videos, 1, 107).is_some());
        assert!(find_cinemeta_video(&videos, 3, 3).is_none());
    }

    #[test]
    fn tmdb_s3e3_maps_when_cinemeta_is_split_seasons() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 52];
        let videos = videos_for_lengths(&cinemeta);
        let mapped = resolve_episode_against_videos(
            3,
            3,
            &videos,
            &cinemeta,
            &tmdb,
            EpisodeLayout::Tmdb,
        );
        assert_eq!(mapped.tmdb, (3, 3));
        assert_eq!(mapped.cinemeta, (3, 24));
        assert!(find_cinemeta_video(&videos, 3, 24).is_some());
    }

    #[test]
    fn absolute_layout_with_season_does_not_use_episode_as_index() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 52];
        let mapped = map_episode_layout(3, 3, &cinemeta, &tmdb, EpisodeLayout::Absolute);
        assert_ne!(mapped.cinemeta, (1, 3));
    }

    #[test]
    fn anime_normalizes_as_series() {
        assert_eq!(normalize_media_type("anime"), Some("series"));
        assert_eq!(normalize_media_type("Anime"), Some("series"));
    }

    #[test]
    fn kitsu_absolute_86_is_a_cinemeta_s3e3_candidate() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 52, 52];
        let candidates =
            episode_layout_candidates(1, 86, &cinemeta, &tmdb, EpisodeLayout::Absolute);
        assert!(
            candidates.iter().any(|mapped| mapped.cinemeta == (3, 3)),
            "absolute 86 must remain a Cinemeta S3E3 candidate"
        );
        assert!(!candidates.iter().any(|mapped| mapped.cinemeta == (1, 3)));
    }

    #[test]
    fn existing_cinemeta_row_wins_over_missing_row() {
        let cinemeta = vec![220];
        let tmdb = vec![52, 52, 52, 52];
        let videos = videos_for_lengths(&cinemeta);
        let mapped = resolve_episode_against_videos(
            3,
            3,
            &videos,
            &cinemeta,
            &tmdb,
            EpisodeLayout::Cinemeta,
        );
        // S3E3 has no row on a single-season calendar, so the absolute match must win.
        assert_eq!(mapped.cinemeta, (1, 107));
        assert!(find_cinemeta_video(&videos, 3, 3).is_none());
    }

    /// Cinemeta `videos[].rating` is a TVDB value (Band of Brothers S1E9: `8.6`
    /// there vs `9.5` on IMDb). It is shown as TVDB and must never become an IMDb chip.
    #[test]
    fn cinemeta_video_rating_is_a_tvdb_chip_never_imdb() {
        let videos = vec![json!({
            "id": "tt0185906:1:9",
            "season": 1,
            "episode": 9,
            "title": "Why We Fight",
            "rating": "8.6"
        })];
        let mut ids = ResolvedIds {
            imdb: "tt0185906".to_string(),
            ..ResolvedIds::default()
        };
        let mut out = Map::new();
        apply_cinemeta_episode_from_videos(&videos, 1, 9, 9, &mut ids, &mut out);
        assert_eq!(ids.episode_name, "Why We Fight");
        assert!(
            ids.episode_imdb.is_none(),
            "a composite tt…:s:e id is not an episode tt"
        );
        assert!(!out.contains_key("imdb"), "TVDB must not be labelled IMDb");
        assert_eq!(
            out.get("tvdb").and_then(|v| v.get("value")),
            Some(&json!("8.6"))
        );
        assert_eq!(
            out.get("tvdb").and_then(|v| v.get("label")),
            Some(&json!("TVDB"))
        );
    }

    #[test]
    fn matching_calendars_keep_s2e5() {
        let cinemeta = vec![12, 12];
        let tmdb = vec![12, 12];
        let mapped = map_episode_layout(2, 5, &cinemeta, &tmdb, EpisodeLayout::Auto);
        assert_eq!(mapped.cinemeta, (2, 5));
        assert_eq!(mapped.tmdb, (2, 5));
        assert_eq!(mapped.absolute, 17);
    }

    #[test]
    fn synthetic_single_season_absolute_keeps_s1_tmdb_uses_split() {
        // Synthetic: a provider that lists one long season vs. one that splits it.
        let cinemeta = vec![220];
        let tmdb = vec![35, 48, 48, 48, 41];
        let mapped = map_episode_layout(1, 86, &cinemeta, &tmdb, EpisodeLayout::Absolute);
        assert_eq!(mapped.cinemeta, (1, 86));
        assert_eq!(mapped.tmdb, (3, 3));
        assert_eq!(mapped.absolute, 86);
    }

    #[test]
    fn empty_tmdb_lengths_do_not_invent_coords() {
        let cinemeta = vec![220];
        let tmdb: Vec<u32> = Vec::new();
        let mapped = map_episode_layout(1, 86, &cinemeta, &tmdb, EpisodeLayout::Absolute);
        assert_eq!(mapped.cinemeta, (1, 86));
        assert_eq!(mapped.tmdb, (0, 0));
        assert!(!tmdb_coords_usable(&tmdb, mapped.tmdb.0, mapped.tmdb.1));
    }

    #[test]
    fn imdb_style_videos_absolute_hits_s1e86() {
        let cinemeta = vec![220];
        let tmdb = vec![35, 48, 48, 48, 41];
        let videos = videos_for_lengths(&cinemeta);
        let mapped = resolve_episode_against_videos(
            1,
            86,
            &videos,
            &cinemeta,
            &tmdb,
            EpisodeLayout::Absolute,
        );
        assert_eq!(mapped.cinemeta, (1, 86));
        assert_eq!(mapped.tmdb, (3, 3));
        assert!(find_cinemeta_video(&videos, 1, 86).is_some());
    }

    /// A TMDB calendar as `season -> listed episode numbers`, plus a record of which
    /// seasons were actually requested so laziness can be asserted.
    fn season_lookup(
        seasons: Vec<(u32, Vec<u32>)>,
        asked: &std::cell::RefCell<Vec<u32>>,
    ) -> impl FnMut(u32) -> Option<Vec<u32>> + '_ {
        move |season| {
            asked.borrow_mut().push(season);
            seasons
                .iter()
                .find(|(number, _)| *number == season)
                .map(|(_, numbers)| numbers.clone())
        }
    }

    /// The regression: TMDB's `/tv/{id}` said 10 episodes while `/tv/{id}/season/2`
    /// listed 11. The old count rail refused, which cost the TMDb chip and the episode
    /// IMDb id. The label S2E5 is listed, so it must be used regardless of any count.
    #[test]
    fn label_hit_ignores_a_disagreeing_episode_count() {
        let asked = std::cell::RefCell::new(Vec::new());
        let reference = TmdbEpisodeRef {
            requested: (2, 5),
            mapped: (2, 4),
            mapped_season_len: 10,
            allow_absolute_join: false,
        };
        let resolved = resolve_tmdb_episode_number(
            &reference,
            season_lookup(vec![(2, (1..=11).collect())], &asked),
        );
        assert_eq!(resolved, Some((2, 5)));
        assert_eq!(
            asked.into_inner(),
            vec![2],
            "the label hit must not fetch a second season list"
        );
    }

    /// Outer Banks season 2 is 1..10: the label is the number, nothing else runs.
    #[test]
    fn aligned_series_resolves_by_label() {
        let asked = std::cell::RefCell::new(Vec::new());
        let reference = TmdbEpisodeRef {
            requested: (2, 3),
            mapped: (2, 3),
            mapped_season_len: 10,
            allow_absolute_join: true,
        };
        let resolved = resolve_tmdb_episode_number(
            &reference,
            season_lookup(vec![(2, (1..=10).collect())], &asked),
        );
        assert_eq!(resolved, Some((2, 3)));
    }

    /// Naruto: TMDB season 3 lists 105..158, so the requested "4" is simply not there
    /// and the absolute bridge takes over — season 2, position 35, real number 87.
    #[test]
    fn naruto_falls_through_the_label_to_the_absolute_bridge() {
        let asked = std::cell::RefCell::new(Vec::new());
        let reference = TmdbEpisodeRef {
            requested: (3, 4),
            mapped: (2, 35),
            mapped_season_len: 52,
            allow_absolute_join: true,
        };
        let resolved = resolve_tmdb_episode_number(
            &reference,
            season_lookup(
                vec![(2, (53..=104).collect()), (3, (105..=158).collect())],
                &asked,
            ),
        );
        assert_eq!(resolved, Some((2, 87)));
        assert_eq!(asked.into_inner(), vec![3, 2], "label first, then the bridge");
    }

    /// Same shape, but reached through a Kitsu absolute route.
    #[test]
    fn kitsu_absolute_route_reaches_the_bridge() {
        let asked = std::cell::RefCell::new(Vec::new());
        let reference = TmdbEpisodeRef {
            requested: (1, 87),
            mapped: (2, 35),
            mapped_season_len: 52,
            allow_absolute_join: true,
        };
        let resolved = resolve_tmdb_episode_number(
            &reference,
            season_lookup(
                vec![(1, (1..=52).collect()), (2, (53..=104).collect())],
                &asked,
            ),
        );
        assert_eq!(resolved, Some((2, 87)));
    }

    /// Differing totals disable the bridge, so a label miss yields no value at all.
    #[test]
    fn bridge_refused_leaves_no_episode_number() {
        let asked = std::cell::RefCell::new(Vec::new());
        let reference = TmdbEpisodeRef {
            requested: (3, 4),
            mapped: (2, 35),
            mapped_season_len: 52,
            allow_absolute_join: false,
        };
        let resolved = resolve_tmdb_episode_number(
            &reference,
            season_lookup(vec![(3, (105..=158).collect())], &asked),
        );
        assert_eq!(resolved, None);
    }

    /// The bridge keeps its own rail: a season list of a different size than the count
    /// that produced the position means the position cannot be trusted.
    #[test]
    fn bridge_still_checks_the_reported_season_length() {
        let asked = std::cell::RefCell::new(Vec::new());
        let reference = TmdbEpisodeRef {
            requested: (3, 4),
            mapped: (2, 35),
            mapped_season_len: 52,
            allow_absolute_join: true,
        };
        let resolved = resolve_tmdb_episode_number(
            &reference,
            season_lookup(
                vec![(3, (105..=158).collect()), (2, (53..=100).collect())],
                &asked,
            ),
        );
        assert_eq!(resolved, None, "48 listed vs 52 reported");
    }

    /// A pair rejected as a label cannot come back as a position.
    #[test]
    fn rejected_label_is_not_retried_as_a_position() {
        let asked = std::cell::RefCell::new(Vec::new());
        let reference = TmdbEpisodeRef {
            requested: (2, 5),
            mapped: (2, 5),
            mapped_season_len: 0,
            allow_absolute_join: true,
        };
        let resolved = resolve_tmdb_episode_number(
            &reference,
            season_lookup(vec![(2, vec![101, 102, 103, 104, 105, 106])], &asked),
        );
        assert_eq!(resolved, None);
        assert_eq!(asked.into_inner(), vec![2], "no second fetch for the same pair");
    }

    /// TVDB and TVmaze must not satisfy the ladder gate, or a failed IMDb/TMDb lookup
    /// would never be retried with another layout.
    #[test]
    fn tvdb_and_tvmaze_do_not_count_as_a_mapped_episode_score() {
        let mut out = Map::new();
        insert_rating(&mut out, "tvdb", "TVDB", "score", "8.1");
        insert_rating(&mut out, "tvmaze", "TVmaze", "score", "8.3");
        assert!(!has_mapped_episode_score(&out));
        insert_rating(&mut out, "tmdb", "TMDB", "percent", "68%");
        assert!(has_mapped_episode_score(&out));
    }

    /// Naruto: Cinemeta splits 35/48/48/48/41 and TMDB splits 52/52/54/62, but both
    /// know 220 regular episodes, so absolute index 87 is the same episode in both.
    #[test]
    fn absolute_join_allowed_when_totals_match() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        let tmdb = vec![52, 52, 54, 62];
        assert_eq!(cinemeta.iter().sum::<u32>(), 220);
        assert_eq!(tmdb.iter().sum::<u32>(), 220);
        let mapped = map_episode_layout(1, 87, &cinemeta, &tmdb, EpisodeLayout::Absolute);
        assert_eq!(mapped.absolute, 87);
        assert_eq!(mapped.cinemeta, (3, 4));
        assert_eq!(mapped.tmdb, (2, 35));
        assert!(absolute_join_allowed((1, 87), mapped.tmdb, &cinemeta, 220));
    }

    /// Differing totals make the absolute index point at different episodes, so the
    /// chip is dropped instead of guessed.
    #[test]
    fn absolute_join_refused_when_totals_differ() {
        let cinemeta = vec![35, 48, 48, 48, 41];
        assert!(!absolute_join_allowed((1, 87), (2, 35), &cinemeta, 224));
        // A direct calendar hit needs no cross-check.
        assert!(absolute_join_allowed((2, 35), (2, 35), &cinemeta, 224));
        // Nothing to cross-check against.
        assert!(absolute_join_allowed((1, 87), (2, 35), &[], 224));
    }

    /// TMDB ids are namespaced: 46260 is the series Naruto and the movie "Saps at Sea".
    /// A guessed media type must not pick the wrong namespace.
    #[test]
    fn tmdb_path_follows_the_id_namespace_not_the_hint() {
        let tv = ResolvedIds {
            tmdb: Some(46260),
            tmdb_is_tv: Some(true),
            ..ResolvedIds::default()
        };
        assert_eq!(tmdb_path(&tv, "movie"), "tv");
        assert_eq!(tmdb_path(&tv, "series"), "tv");
        let movie = ResolvedIds {
            tmdb: Some(46260),
            tmdb_is_tv: Some(false),
            ..ResolvedIds::default()
        };
        assert_eq!(tmdb_path(&movie, "series"), "movie");
        // Untagged (Trakt/MDBList supplied it): fall back to the requested type.
        let untagged = ResolvedIds {
            tmdb: Some(46260),
            ..ResolvedIds::default()
        };
        assert_eq!(tmdb_path(&untagged, "series"), "tv");
        assert_eq!(tmdb_path(&untagged, "movie"), "movie");
    }

    #[test]
    fn find_result_namespace_corrects_a_guessed_media_type() {
        let series = ResolvedIds {
            tmdb_is_tv: Some(true),
            ..ResolvedIds::default()
        };
        assert_eq!(corrected_media_type("movie", &series), Some("series"));
        assert_eq!(corrected_media_type("series", &series), None);
        let movie = ResolvedIds {
            tmdb_is_tv: Some(false),
            ..ResolvedIds::default()
        };
        assert_eq!(corrected_media_type("series", &movie), Some("movie"));
        assert_eq!(corrected_media_type("movie", &movie), None);
        assert_eq!(
            corrected_media_type("movie", &ResolvedIds::default()),
            None,
            "no /find answer is no proof"
        );
    }

    /// Jikan answers 504 for days at a time. Letting that mark results incomplete
    /// pinned every anime lookup to the 5 s TTL and forced a refetch per navigation.
    #[test]
    fn optional_source_failure_keeps_the_payload_complete() {
        let failures = new_failures();
        note_failure_as(&failures, SourceClass::Optional);
        note_failure_as(&failures, SourceClass::Optional);
        assert_eq!(failure_count(&failures), 0);
        assert_eq!(optional_failure_count(&failures), 2);
        let payload = build_payload(&Map::new(), failure_count(&failures) == 0, "series", true);
        assert!(payload_is_complete(&payload));

        note_failure_as(&failures, SourceClass::Required);
        assert_eq!(failure_count(&failures), 1);
        let payload = build_payload(&Map::new(), failure_count(&failures) == 0, "series", true);
        assert!(!payload_is_complete(&payload));
    }

    /// A TVDB-only or TVmaze-only episode still carries a real score, so it must earn
    /// the long TTL instead of being treated as an empty result.
    #[test]
    fn episode_only_scores_count_as_scores() {
        assert!(payload_has_score(&json!({
            "ratings": [{ "key": "tvdb", "value": "8.1" }]
        })));
        assert!(payload_has_score(&json!({
            "ratings": [{ "key": "tvmaze", "value": "8.3" }]
        })));
    }

    /// TVMaze numbers Naruto by broadcast year, so only the absolute index can join —
    /// and only while both sides list 220 episodes.
    #[test]
    fn tvmaze_absolute_join_needs_equal_episode_counts() {
        assert_eq!(tvmaze_absolute_index(220, 220, 87), Some(86));
        assert_eq!(tvmaze_absolute_index(220, 220, 1), Some(0));
        assert_eq!(tvmaze_absolute_index(220, 220, 220), Some(219));
        assert_eq!(tvmaze_absolute_index(224, 220, 87), None, "counts differ");
        assert_eq!(tvmaze_absolute_index(220, 0, 87), None, "no Cinemeta total");
        assert_eq!(tvmaze_absolute_index(220, 220, 0), None, "no absolute index");
    }

    #[test]
    fn payload_reports_the_resolved_media_type() {
        let payload = build_payload(&Map::new(), true, "series", true);
        assert_eq!(payload.get("type").and_then(|v| v.as_str()), Some("series"));
    }

    /// `typeVerified` mirrors whether `/find` answered. Only an unproven type may cost
    /// the hover a second backend round.
    #[test]
    fn type_verified_mirrors_the_find_result() {
        let proven = ResolvedIds {
            tmdb: Some(46260),
            tmdb_is_tv: Some(true),
            ..ResolvedIds::default()
        };
        let payload = build_payload(&Map::new(), true, "series", proven.tmdb_is_tv.is_some());
        assert_eq!(
            payload.get("typeVerified").and_then(|v| v.as_bool()),
            Some(true)
        );

        let guessed = ResolvedIds::default();
        let payload = build_payload(&Map::new(), true, "series", guessed.tmdb_is_tv.is_some());
        assert_eq!(
            payload.get("typeVerified").and_then(|v| v.as_bool()),
            Some(false)
        );
    }

    /// The TVDB deep link comes out of the row the route already points at.
    #[test]
    fn tvdb_score_carries_a_dereferrer_link() {
        let videos = vec![json!({
            "season": 2,
            "episode": 5,
            "rating": 8.4,
            "tvdb_id": 4239123
        })];
        let mut ids = ResolvedIds::default();
        let mut out = Map::new();
        apply_cinemeta_episode_from_videos(&videos, 2, 5, 0, &mut ids, &mut out);
        assert_eq!(
            out.get("tvdb")
                .and_then(|v| v.get("url"))
                .and_then(|v| v.as_str()),
            Some("https://thetvdb.com/dereferrer/episode/4239123")
        );
    }

    /// A row without a TVDB id still yields the score, just no link.
    #[test]
    fn tvdb_score_without_an_id_has_no_link() {
        let videos = vec![json!({ "season": 2, "episode": 5, "rating": 8.4 })];
        let mut ids = ResolvedIds::default();
        let mut out = Map::new();
        apply_cinemeta_episode_from_videos(&videos, 2, 5, 0, &mut ids, &mut out);
        assert!(out.contains_key("tvdb"));
        assert!(out.get("tvdb").and_then(|v| v.get("url")).is_none());
    }

    #[test]
    fn cinemeta_series_rating_is_a_tvdb_chip_with_series_link() {
        let meta = json!({
            "name": "Game of Thrones",
            "imdbRating": "9.2",
            "rating": "8.4",
            "tvdb_id": 121361
        });
        let mut out = Map::new();
        apply_cinemeta_series_tvdb(&meta, &mut out);
        assert_eq!(
            out.get("tvdb").and_then(|v| v.get("value")),
            Some(&json!("8.4"))
        );
        assert_eq!(
            out.get("tvdb").and_then(|v| v.get("label")),
            Some(&json!("TVDB"))
        );
        assert!(!out.contains_key("imdb"), "series TVDB must not become IMDb");
        assert_eq!(
            out.get("tvdb")
                .and_then(|v| v.get("url"))
                .and_then(|v| v.as_str()),
            Some("https://thetvdb.com/dereferrer/series/121361")
        );
    }

    #[test]
    fn cinemeta_series_without_rating_has_no_tvdb_chip() {
        let meta = json!({
            "imdbRating": "9.2",
            "tvdb_id": 121361
        });
        let mut out = Map::new();
        apply_cinemeta_series_tvdb(&meta, &mut out);
        assert!(!out.contains_key("tvdb"));
    }

    #[test]
    fn tvmaze_show_rating_is_a_series_chip() {
        let show = json!({
            "name": "Game of Thrones",
            "url": "https://www.tvmaze.com/shows/82/game-of-thrones",
            "rating": { "average": 8.9 }
        });
        let mut ids = ResolvedIds::default();
        let mut out = Map::new();
        apply_tvmaze_show_rating(&show, &mut ids, &mut out);
        assert_eq!(ids.title, "Game of Thrones");
        assert_eq!(
            out.get("tvmaze").and_then(|v| v.get("value")),
            Some(&json!("8.9"))
        );
        assert_eq!(
            out.get("tvmaze").and_then(|v| v.get("label")),
            Some(&json!("TVmaze"))
        );
        assert_eq!(
            out.get("tvmaze")
                .and_then(|v| v.get("url"))
                .and_then(|v| v.as_str()),
            Some("https://www.tvmaze.com/shows/82/game-of-thrones")
        );
    }
}
