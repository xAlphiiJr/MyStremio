use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE, USER_AGENT};
use serde_json::{json, Value};
use std::time::Duration;

const INTRODB_API_BASE: &str = "https://api.introdb.app";
const USER_AGENT_VALUE: &str = "MyStremio Intro Skip Plugin";
const GET_TIMEOUT: Duration = Duration::from_secs(4);
const GET_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(25);
const SUBMIT_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

fn http_client(timeout: Duration, connect: Duration) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(connect)
        .timeout(timeout)
        .build()
        .map_err(|error| format!("IntroDB HTTP client failed: {error}"))
}

/// Fetch aggregated IntroDB.app segments for a TV episode.
///
/// The public IntroDB API only allows browser CORS from `https://introdb.app`, so
/// WebView2 requests from the local shell origin must be proxied through Rust.
///
/// # Arguments
/// * `imdb_id` - Series IMDb ID (`tt…`).
/// * `season` - 1-based season number.
/// * `episode` - 1-based episode number.
///
/// # Returns
/// Parsed JSON payload on success, `null` when the episode has no segments (404).
///
/// # Errors
/// Returns an error string for invalid input or non-404 HTTP failures.
pub fn get_segments(imdb_id: &str, season: u64, episode: u64) -> Result<Value, String> {
    if imdb_id.is_empty() || season == 0 || episode == 0 {
        return Err("IntroDB segment lookup requires imdbId, season and episode.".to_string());
    }

    let client = http_client(GET_TIMEOUT, GET_CONNECT_TIMEOUT)?;
    let url = format!(
        "{INTRODB_API_BASE}/segments?imdb_id={imdb_id}&season={season}&episode={episode}"
    );

    let response = client
        .get(url)
        .headers(default_headers(None))
        .send()
        .map_err(|error| format!("IntroDB segment request failed: {error}"))?;

    if response.status().as_u16() == 404 {
        return Ok(Value::Null);
    }

    if !response.status().is_success() {
        return Err(format!(
            "IntroDB segment request failed with status {}",
            response.status()
        ));
    }

    response
        .json::<Value>()
        .map_err(|error| format!("IntroDB segment response was not valid JSON: {error}"))
}

/// Submit a segment timestamp to IntroDB.app using the user's API key.
///
/// # Arguments
/// * `api_key` - IntroDB API key (`idb_…`).
/// * `body` - JSON body matching the IntroDB `/submit` schema.
///
/// # Returns
/// Object `{ status, body }` where `body` is parsed JSON when possible.
///
/// # Errors
/// Returns an error string for transport failures or invalid input.
pub fn submit_segment(api_key: &str, body: &Value) -> Result<Value, String> {
    if api_key.is_empty() {
        return Err("IntroDB API key is required.".to_string());
    }
    if !body.is_object() {
        return Err("IntroDB submit body must be a JSON object.".to_string());
    }

    let client = http_client(SUBMIT_TIMEOUT, SUBMIT_CONNECT_TIMEOUT)?;
    let response = client
        .post(format!("{INTRODB_API_BASE}/submit"))
        .headers(default_headers(Some(api_key)))
        .json(body)
        .send()
        .map_err(|error| format!("IntroDB submit request failed: {error}"))?;

    let status = response.status().as_u16();
    let text = response
        .text()
        .map_err(|error| format!("IntroDB submit response could not be read: {error}"))?;

    let parsed_body = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| {
        json!({
            "error": text
        })
    });

    Ok(json!({
        "status": status,
        "body": parsed_body
    }))
}

fn default_headers(api_key: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(USER_AGENT_VALUE),
    );
    if let Some(key) = api_key {
        if let Ok(value) = HeaderValue::from_str(key) {
            headers.insert("X-API-Key", value);
        }
    }
    if api_key.is_some() {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    headers
}
