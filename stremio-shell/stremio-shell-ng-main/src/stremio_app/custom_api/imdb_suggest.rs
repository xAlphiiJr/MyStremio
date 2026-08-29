use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use serde_json::{json, Value};
use std::time::Duration;

const IMDB_SUGGEST_BASE: &str = "https://v3.sg.media-imdb.com/suggestion/titles";
const USER_AGENT_VALUE: &str = "MyStremio Search Suggestions";
const GET_TIMEOUT: Duration = Duration::from_secs(4);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

fn http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(GET_TIMEOUT)
        .build()
        .map_err(|error| format!("IMDb suggest HTTP client failed: {error}"))
}

fn headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
    headers
}

fn slugify(query: &str) -> String {
    query
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// IMDb title typeahead (same JSON as imdb.com search). Used when WebView CORS fails.
///
/// # Errors
/// Returns an error string for empty input or HTTP/JSON failures.
pub fn suggest(query: &str) -> Result<Value, String> {
    let slug = slugify(query);
    if slug.is_empty() || slug.chars().all(|c| c == '_') {
        return Ok(json!({ "d": [] }));
    }
    let first = slug.chars().next().unwrap_or('x');
    let url = format!("{IMDB_SUGGEST_BASE}/{first}/{slug}.json");
    let client = http_client()?;
    let response = client
        .get(url)
        .headers(headers())
        .send()
        .map_err(|error| format!("IMDb suggest request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "IMDb suggest request failed with status {}",
            response.status()
        ));
    }

    response
        .json::<Value>()
        .map_err(|error| format!("IMDb suggest response was not valid JSON: {error}"))
}
