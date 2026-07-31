#![cfg_attr(all(not(test), not(debug_assertions)), windows_subsystem = "windows")]
#[macro_use]
extern crate bitflags;
use std::{io::Write, path::Path, process::exit};
use whoami::username;

use clap::Parser;
use native_windows_gui::{self as nwg, NativeUi};
mod stremio_app;
use crate::stremio_app::{
    constants::{
        DEV_ENDPOINT, IPC_PATH, SERVER_IPC_KEY, STA_ENDPOINT, STREMIO_SERVER_DEV_MODE, WEB_ENDPOINT,
    },
    MainWindow, PipeClient,
};

#[derive(Parser, Debug)]
#[clap(version)]
struct Opt {
    command: Option<String>,
    #[clap(
        long,
        help = "Start the app only in system tray and keep the window hidden"
    )]
    start_hidden: bool,
    #[clap(long, help = "Do not show the splash image")]
    no_splash: bool,
    #[clap(long, help = "Enable dev tools when pressing F12")]
    dev_tools: bool,
    #[clap(long, help = "Disable the server and load the WebUI from localhost")]
    development: bool,
    #[clap(long, help = "Shortcut for --webui-url=https://staging.strem.io/")]
    staging: bool,
    #[clap(long, default_value = WEB_ENDPOINT, help = "Override the WebUI URL")]
    webui_url: String,
    #[clap(long, help = "Forces reinstalling current version")]
    force_update: bool,
    #[clap(long, help = "Check for RC updates")]
    release_candidate: bool,
    #[clap(
        long,
        default_value = "",
        help = "Secret key for communication with the server. By default it is randomly generrated on startup"
    )]
    server_ipc_key: String,
}

fn normalize_launch_command(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if trimmed.starts_with("stremio://") || trimmed.starts_with("magnet:") {
        return trimmed.to_string();
    }

    if Path::new(trimmed).exists() {
        return format!("file:///{}", trimmed.replace('\\', "/"));
    }

    trimmed.to_string()
}

fn main() {
    // Per-monitor DPI v2 is declared in the application manifest (build.rs).
    // Do not call the deprecated System-DPI helper here; it would override PMv2.
    nwg::enable_visual_styles();

    // Must be set before WebView2 Environment/Controller creation. Microsoft docs:
    // API-only DefaultBackgroundColor can still white-flash; the env var applies first.
    // FF141414 = opaque rgb(20,20,20) matching liquid-glass / splash background.
    std::env::set_var("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF141414");

    let opt = Opt::parse();

    std::env::set_var(
        SERVER_IPC_KEY,
        if opt.server_ipc_key.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            opt.server_ipc_key.clone()
        },
    );

    let command = match opt.command {
        Some(file) => normalize_launch_command(&file),
        None => String::new(),
    };

    // Single application IPC
    let mut commands_path = IPC_PATH.to_string();
    // Append the username so it works per User
    commands_path.push_str(&username());
    let socket_path = Path::new(&commands_path);
    if let Ok(mut stream) = PipeClient::connect(socket_path) {
        let forwarded = stream
            .write_all(command.as_bytes())
            .and_then(|_| stream.flush())
            .is_ok();
        drop(stream);
        if forwarded {
            exit(0);
        }
        eprintln!("Failed to forward command to existing MyStremio instance; launching new instance");
    }
    // END IPC

    std::env::set_var(
        STREMIO_SERVER_DEV_MODE,
        if opt.development { "true" } else { "false" },
    );

    let webui_url = if opt.development && opt.webui_url == WEB_ENDPOINT {
        DEV_ENDPOINT.to_string()
    } else if opt.staging && opt.webui_url == WEB_ENDPOINT {
        STA_ENDPOINT.to_string()
    } else {
        opt.webui_url
    };

    nwg::init().expect("Failed to init Native Windows GUI");
    let _app = MainWindow::build_ui(MainWindow {
        command,
        commands_path: Some(commands_path),
        webui_url,
        no_splash: opt.no_splash,
        dev_tools: opt.development || opt.dev_tools,
        start_hidden: opt.start_hidden,
        force_update: opt.force_update,
        release_candidate: opt.release_candidate,
        ..Default::default()
    })
    .expect("Failed to build UI");
    nwg::dispatch_thread_events();
}
