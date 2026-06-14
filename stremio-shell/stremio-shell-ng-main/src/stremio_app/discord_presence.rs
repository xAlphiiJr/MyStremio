use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, StatusDisplayType, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_APP_ID: &str = "997798118185771059";

struct DiscordState {
    client: Option<DiscordIpcClient>,
    connected_app_id: Option<String>,
}

static DISCORD: Mutex<DiscordState> = Mutex::new(DiscordState {
    client: None,
    connected_app_id: None,
});

fn playback_start_timestamp(current_time: &str) -> Option<i64> {
    let elapsed = parse_clock_label(current_time)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    Some(now.saturating_sub(elapsed))
}

fn parse_clock_label(raw: &str) -> Option<i64> {
    let parts: Vec<i64> = raw
        .split(':')
        .filter_map(|part| part.trim().parse().ok())
        .collect();
    match parts.len() {
        3 => Some(parts[0] * 3600 + parts[1] * 60 + parts[2]),
        2 => Some(parts[0] * 60 + parts[1]),
        1 => Some(parts[0]),
        _ => None,
    }
}

fn ensure_client(app_id: &str) -> Result<(), String> {
    let mut state = DISCORD
        .lock()
        .map_err(|_| "Discord presence lock poisoned".to_string())?;

    let needs_reconnect = state
        .connected_app_id
        .as_deref()
        .map(|connected| connected != app_id)
        .unwrap_or(true);

    if needs_reconnect {
        if let Some(mut client) = state.client.take() {
            let _ = client.close();
        }
        let mut client = DiscordIpcClient::new(app_id);
        client
            .connect()
            .map_err(|error| format!("Discord connect failed: {error}"))?;
        state.client = Some(client);
        state.connected_app_id = Some(app_id.to_string());
    }

    Ok(())
}

pub fn clear_presence() -> Result<(), String> {
    let mut state = DISCORD
        .lock()
        .map_err(|_| "Discord presence lock poisoned".to_string())?;
    if let Some(client) = state.client.as_mut() {
        client
            .clear_activity()
            .map_err(|error| format!("Discord clear failed: {error}"))?;
    }
    Ok(())
}

pub fn update_presence(payload: &Value) -> Result<(), String> {
    let app_id = payload
        .get("appId")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_APP_ID);

    ensure_client(app_id)?;

    let state_name = payload
        .get("state")
        .and_then(|value| value.as_str())
        .unwrap_or("menu");

    let title = payload
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("MyStremio");

    let subtitle = payload
        .get("subtitle")
        .and_then(|value| value.as_str())
        .unwrap_or("");

    let paused = payload
        .get("paused")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    let current_time = payload
        .get("currentTime")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let duration = payload
        .get("duration")
        .and_then(|value| value.as_str())
        .unwrap_or("");

    let mut activity = Activity::new()
        .activity_type(ActivityType::Watching)
        .status_display_type(StatusDisplayType::Details);

    if state_name == "player" {
        let details = if subtitle.is_empty() { title } else { subtitle };
        let state_text = if paused {
            "Paused".to_string()
        } else if subtitle.is_empty() {
            "Watching".to_string()
        } else {
            title.to_string()
        };

        activity = activity.name(title).details(details).state(state_text);

        if !paused {
            if let Some(start) = playback_start_timestamp(current_time) {
                let mut timestamps = Timestamps::new().start(start);
                if let Some(total) = parse_clock_label(duration) {
                    if total > 0 {
                        timestamps = timestamps.end(start + total);
                    }
                }
                activity = activity.timestamps(timestamps);
            }
        }
    } else if state_name == "idle" {
        activity = activity
            .name("MyStremio")
            .details("Idle")
            .state("Not browsing");
    } else {
        activity = activity
            .name("MyStremio")
            .details(title)
            .state(if subtitle.is_empty() {
                "Browsing".to_string()
            } else {
                subtitle.to_string()
            });
    }

    activity = activity.assets(
        Assets::new()
            .large_image("stremio")
            .large_text("MyStremio"),
    );

    let mut state = DISCORD
        .lock()
        .map_err(|_| "Discord presence lock poisoned".to_string())?;
    let client = state
        .client
        .as_mut()
        .ok_or_else(|| "Discord client not connected".to_string())?;
    client
        .set_activity(activity)
        .map_err(|error| format!("Discord activity failed: {error}"))?;

    Ok(())
}
