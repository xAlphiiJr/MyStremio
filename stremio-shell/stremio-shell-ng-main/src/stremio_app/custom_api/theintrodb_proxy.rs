use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde_json::{json, Value};
use std::time::Duration;

const THEINTRODB_API_BASE: &str = "https://api.theintrodb.org/v3";
const USER_AGENT_VALUE: &str = "MyStremio Intro Skip Plugin";
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(25);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

fn submit_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(SUBMIT_TIMEOUT)
        .build()
        .map_err(|error| format!("TheIntroDB HTTP client failed: {error}"))
}

/// Submit a segment timestamp to TheIntroDB.
///
/// Browser POST from the local WebView origin is CORS-blocked; GET `/media` is not.
/// The write path must go through this shell proxy.
///
/// # Arguments
/// * `api_key` - TheIntroDB bearer token.
/// * `body` - JSON body matching TheIntroDB `/submit` schema.
///
/// # Returns
/// Object `{ status, body }` where `body` is parsed JSON when possible.
///
/// # Errors
/// Returns an error string for transport failures or invalid input.
pub fn submit_segment(api_key: &str, body: &Value) -> Result<Value, String> {
    if api_key.is_empty() {
        return Err("TheIntroDB API key is required.".to_string());
    }
    if !body.is_object() {
        return Err("TheIntroDB submit body must be a JSON object.".to_string());
    }

    let client = submit_client()?;
    let response = client
        .post(format!("{THEINTRODB_API_BASE}/submit"))
        .headers(submit_headers(api_key)?)
        .json(body)
        .send()
        .map_err(|_| "TheIntroDB could not be reached. Try again.".to_string())?;

    let status = response.status().as_u16();
    let text = response
        .text()
        .map_err(|error| format!("TheIntroDB submit response could not be read: {error}"))?;

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

fn submit_headers(api_key: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
    let bearer = format!("Bearer {api_key}");
    let auth = HeaderValue::from_str(&bearer)
        .map_err(|_| "TheIntroDB API key contains invalid header characters.".to_string())?;
    headers.insert(AUTHORIZATION, auth);
    Ok(headers)
}
