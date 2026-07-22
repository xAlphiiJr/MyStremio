use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use serde_json::Value;

const ANISKIP_API_BASE: &str = "https://api.aniskip.com";
const KITSU_API_BASE: &str = "https://kitsu.io/api/edge";
const JIKAN_API_BASE: &str = "https://api.jikan.moe/v4";
const USER_AGENT_VALUE: &str = "MyStremio Intro Skip Plugin";

fn default_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(USER_AGENT_VALUE),
    );
    headers
}

fn kitsu_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.api+json"),
    );
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(USER_AGENT_VALUE),
    );
    headers
}

/// Fetch AniSkip skip times for a MAL anime + episode.
///
/// Uses **v1** (no `episodeLength` required). Falls back to **v2** with
/// `episodeLength` when provided and v1 returns no results.
///
/// # Arguments
/// * `mal_id` - MyAnimeList anime ID.
/// * `episode` - 1-based episode number (MAL / Kitsu episode index).
/// * `episode_length` - Optional episode duration in seconds (helps v2).
///
/// # Errors
/// Returns an error string for invalid input or non-success HTTP failures.
pub fn get_skip_times(
    mal_id: u64,
    episode: u64,
    episode_length: Option<f64>,
) -> Result<Value, String> {
    if mal_id == 0 || episode == 0 {
        return Err("AniSkip lookup requires malId and episode.".to_string());
    }

    let client = Client::new();

    // v1 does not require episodeLength and returns snake_case intervals.
    let v1_url = format!(
        "{ANISKIP_API_BASE}/v1/skip-times/{mal_id}/{episode}?types=op&types=ed&types=recap"
    );
    let v1_response = client
        .get(&v1_url)
        .headers(default_headers())
        .send()
        .map_err(|error| format!("AniSkip v1 request failed: {error}"))?;

    if v1_response.status().as_u16() == 404 {
        return Ok(serde_json::json!({ "found": false, "results": [] }));
    }

    if v1_response.status().is_success() {
        let payload = v1_response
            .json::<Value>()
            .map_err(|error| format!("AniSkip v1 response was not valid JSON: {error}"))?;
        if payload.get("found").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Ok(payload);
        }
        // Empty v1 → try v2 when we have a duration.
        if episode_length.is_none() {
            return Ok(payload);
        }
    } else if episode_length.is_none() {
        return Err(format!(
            "AniSkip v1 request failed with status {}",
            v1_response.status()
        ));
    }

    let length = episode_length.unwrap_or(0.0).max(0.0);
    let v2_url = format!(
        "{ANISKIP_API_BASE}/v2/skip-times/{mal_id}/{episode}?types=op&types=ed&types=recap&episodeLength={length}"
    );
    let v2_response = client
        .get(v2_url)
        .headers(default_headers())
        .send()
        .map_err(|error| format!("AniSkip v2 request failed: {error}"))?;

    if v2_response.status().as_u16() == 404 {
        return Ok(serde_json::json!({ "found": false, "results": [] }));
    }

    if !v2_response.status().is_success() {
        return Err(format!(
            "AniSkip v2 request failed with status {}",
            v2_response.status()
        ));
    }

    v2_response
        .json::<Value>()
        .map_err(|error| format!("AniSkip v2 response was not valid JSON: {error}"))
}

/// Resolve a MyAnimeList ID from a Kitsu anime ID via Kitsu mappings.
///
/// # Arguments
/// * `kitsu_id` - Numeric Kitsu anime ID.
///
/// # Errors
/// Returns an error string for transport failures.
pub fn resolve_mal_from_kitsu(kitsu_id: u64) -> Result<Option<u64>, String> {
    if kitsu_id == 0 {
        return Ok(None);
    }

    let client = Client::new();
    let url = format!("{KITSU_API_BASE}/anime/{kitsu_id}/mappings");
    let response = client
        .get(url)
        .headers(kitsu_headers())
        .send()
        .map_err(|error| format!("Kitsu mappings request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Kitsu mappings request failed with status {}",
            response.status()
        ));
    }

    let payload = response
        .json::<Value>()
        .map_err(|error| format!("Kitsu mappings response was not valid JSON: {error}"))?;

    let Some(entries) = payload.get("data").and_then(|v| v.as_array()) else {
        return Ok(None);
    };

    for entry in entries {
        let attrs = entry.get("attributes");
        let site = attrs
            .and_then(|a| a.get("externalSite"))
            .or_else(|| attrs.and_then(|a| a.get("external_site")))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !site.eq_ignore_ascii_case("myanimelist/anime")
            && !site.eq_ignore_ascii_case("myanimelist")
        {
            continue;
        }
        let external_id = attrs
            .and_then(|a| a.get("externalId"))
            .or_else(|| attrs.and_then(|a| a.get("external_id")))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if let Ok(mal_id) = external_id.parse::<u64>() {
            if mal_id > 0 {
                return Ok(Some(mal_id));
            }
        }
    }

    Ok(None)
}

/// Resolve a MyAnimeList ID by title search via Jikan (same approach as stremio-aniskip).
///
/// # Arguments
/// * `title` - Anime title to search.
///
/// # Errors
/// Returns an error string for transport failures.
pub fn resolve_mal_from_jikan(title: &str) -> Result<Option<u64>, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let client = Client::new();
    let url = format!(
        "{JIKAN_API_BASE}/anime?q={}&limit=1",
        urlencoding_encode(trimmed)
    );
    let response = client
        .get(url)
        .headers(default_headers())
        .send()
        .map_err(|error| format!("Jikan request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Jikan request failed with status {}",
            response.status()
        ));
    }

    let payload = response
        .json::<Value>()
        .map_err(|error| format!("Jikan response was not valid JSON: {error}"))?;

    let mal_id = payload
        .get("data")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|entry| entry.get("mal_id"))
        .and_then(|v| v.as_u64());

    Ok(mal_id.filter(|id| *id > 0))
}

/// Resolve a MyAnimeList ID by searching Kitsu by title, then reading mappings.
///
/// Useful when Jikan/MAL is down and the user is on IMDb catalog titles.
///
/// # Arguments
/// * `title` - Anime title to search on Kitsu.
///
/// # Errors
/// Returns an error string for transport failures.
pub fn resolve_mal_from_kitsu_title(title: &str) -> Result<Option<u64>, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let client = Client::new();
    let url = format!(
        "{KITSU_API_BASE}/anime?filter[text]={}&page[limit]=5",
        urlencoding_encode(trimmed)
    );
    let response = client
        .get(url)
        .headers(kitsu_headers())
        .send()
        .map_err(|error| format!("Kitsu search request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Kitsu search request failed with status {}",
            response.status()
        ));
    }

    let payload = response
        .json::<Value>()
        .map_err(|error| format!("Kitsu search response was not valid JSON: {error}"))?;

    let Some(entries) = payload.get("data").and_then(|v| v.as_array()) else {
        return Ok(None);
    };

    for entry in entries {
        let kitsu_id = entry
            .get("id")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u64>().ok())
            .or_else(|| entry.get("id").and_then(|v| v.as_u64()))
            .unwrap_or(0);
        if kitsu_id == 0 {
            continue;
        }
        if let Some(mal_id) = resolve_mal_from_kitsu(kitsu_id)? {
            return Ok(Some(mal_id));
        }
    }

    Ok(None)
}

/// Minimal URL-encoding for query values (space → `+`, otherwise percent-encode unsafe bytes).
fn urlencoding_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
