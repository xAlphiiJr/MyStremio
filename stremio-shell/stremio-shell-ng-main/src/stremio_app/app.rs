use native_windows_derive::NwgUi;
use native_windows_gui as nwg;
use std::{
    cell::RefCell,
    io::Read,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{self, Command},
    str,
    sync::{Arc, Mutex},
    thread, time,
};
use winapi::um::{winbase::CREATE_BREAKAWAY_FROM_JOB, winuser::WS_EX_TOPMOST};

use crate::stremio_app::{
    constants::{APP_NAME, ENABLE_AUTOUPDATER, UPDATE_INTERVAL, WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH},
    custom_api,
    ipc::{RPCRequest, RPCResponse},
    splash::SplashImage,
    stremio_player::Player,
    stremio_wevbiew::{apply_ui_scale, WebView},
    systray::SystemTray,
    updater,
    window_helper::WindowStyle,
    window_settings::WindowSettings,
    PipeServer,
};

use super::stremio_server::StremioServer;

#[derive(Default, NwgUi)]
pub struct MainWindow {
    pub command: String,
    pub commands_path: Option<String>,
    pub webui_url: String,
    pub no_splash: bool,
    pub dev_tools: bool,
    pub start_hidden: bool,
    pub force_update: bool,
    pub release_candidate: bool,
    pub autoupdater_setup_file: Arc<Mutex<Option<PathBuf>>>,
    pub requested_fullscreen: Arc<Mutex<Option<bool>>>,
    pub requested_borderless: Arc<Mutex<Option<bool>>>,
    /// Pending in-app window chrome action: "min" | "max" | "close".
    pub requested_window_chrome: Arc<Mutex<Option<String>>>,
    /// Pending WebView2 DefaultBackgroundColor transparency (MPV punch-through).
    pub requested_webview_transparent: Arc<Mutex<Option<bool>>>,
    pub saved_window_style: RefCell<WindowStyle>,
    #[nwg_resource]
    pub embed: nwg::EmbedResource,
    #[nwg_resource(source_embed: Some(&data.embed), source_embed_str: Some("MAINICON"))]
    pub window_icon: nwg::Icon,
    #[nwg_control(icon: Some(&data.window_icon), title: APP_NAME, flags: "MAIN_WINDOW")]
    #[nwg_events(
        OnWindowClose: [Self::on_quit(SELF, EVT_DATA)],
        OnInit: [Self::on_init],
        OnPaint: [Self::on_paint],
        OnMinMaxInfo: [Self::on_min_max(SELF, EVT_DATA)],
        OnWindowMinimize: [Self::transmit_window_state_change],
        OnWindowMaximize: [Self::on_window_state_changed],
        OnWindowFocus: [Self::on_window_focus],
        OnResizeEnd: [Self::save_window_settings],
    )]
    pub window: nwg::Window,
    #[nwg_partial(parent: window)]
    #[nwg_events(
        (tray, MousePressLeftUp): [Self::on_show],
        (tray_exit, OnMenuItemSelected): [Self::on_exit],
        (tray_show_hide, OnMenuItemSelected): [Self::on_show_hide],
        (tray_topmost, OnMenuItemSelected): [Self::on_toggle_topmost],
    )]
    pub tray: SystemTray,
    #[nwg_partial(parent: window)]
    pub splash_screen: SplashImage,
    #[nwg_partial(parent: window)]
    pub server: StremioServer,
    #[nwg_partial(parent: window)]
    pub player: Player,
    #[nwg_partial(parent: window)]
    pub webview: WebView,
    #[nwg_control]
    #[nwg_events(OnNotice: [Self::on_toggle_fullscreen_notice] )]
    pub toggle_fullscreen_notice: nwg::Notice,
    #[nwg_control]
    #[nwg_events(OnNotice: [Self::on_toggle_borderless_notice] )]
    pub toggle_borderless_notice: nwg::Notice,
    #[nwg_control]
    #[nwg_events(OnNotice: [Self::on_window_chrome_notice] )]
    pub window_chrome_notice: nwg::Notice,
    #[nwg_control]
    #[nwg_events(OnNotice: [Self::on_webview_background_notice] )]
    pub webview_background_notice: nwg::Notice,
    #[nwg_control]
    #[nwg_events(OnNotice: [nwg::stop_thread_dispatch()] )]
    pub quit_notice: nwg::Notice,
    #[nwg_control]
    #[nwg_events(OnNotice: [Self::on_hide_splash_notice] )]
    pub hide_splash_notice: nwg::Notice,
    #[nwg_control]
    #[nwg_events(OnNotice: [Self::on_focus_notice] )]
    pub focus_notice: nwg::Notice,
    #[nwg_control]
    #[nwg_events(OnNotice: [Self::on_toggle_pip_notice] )]
    pub toggle_pip_notice: nwg::Notice,
    #[nwg_control]
    #[nwg_events(OnNotice: [Self::on_apply_ui_scale_notice] )]
    pub apply_ui_scale_notice: nwg::Notice,
}

impl MainWindow {
    fn transmit_window_visibility_change(&self) {
        if let (Ok(web_channel), Ok(style)) = (
            self.webview.channel.try_borrow(),
            self.saved_window_style.try_borrow(),
        ) {
            let (web_tx, _) = web_channel
                .as_ref()
                .expect("Cannont obtain communication channel for the Web UI");
            let web_tx_app = web_tx.clone();
            web_tx_app
                .send(RPCResponse::visibility_change(
                    self.window.visible(),
                    style.full_screen as u32,
                    style.full_screen,
                ))
                .ok();
        } else {
            eprintln!("Cannot obtain communication channel or window style");
        }
    }
    fn transmit_window_state_change(&self) {
        if let (Some(hwnd), Ok(web_channel), Ok(style)) = (
            self.window.handle.hwnd(),
            self.webview.channel.try_borrow(),
            self.saved_window_style.try_borrow(),
        ) {
            let state = style.clone().get_window_state(hwnd);
            drop(style);
            let (web_tx, _) = web_channel
                .as_ref()
                .expect("Cannont obtain communication channel for the Web UI");
            let web_tx_app = web_tx.clone();
            web_tx_app.send(RPCResponse::state_change(state)).ok();
        } else {
            eprintln!("Cannot obtain window handle or communication channel");
        }
    }

    fn on_init(&self) {
        // Zaarrg/Community-style: never present a white HWND client before splash paints.
        // 1) dark class brush  2) geometry while hidden  3) splash topmost + UpdateWindow
        // 4) then ShowWindow. WebView stays visible under splash (dark bg) so Board LoadRange works.
        let mut intended_show = winapi::um::winuser::SW_SHOWNORMAL as u32;
        if let Some(hwnd) = self.window.handle.hwnd() {
            if let Ok(mut saved_style) = self.saved_window_style.try_borrow_mut() {
                saved_style.set_dark_window_background(hwnd);
                saved_style.set_title_bar_color(hwnd);
                if let Some(window_settings) = WindowSettings::load() {
                    intended_show = saved_style.restore_window_placement_hidden(
                        hwnd,
                        window_settings.to_window_placement(),
                    );
                } else {
                    saved_style.center_window(hwnd, WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT);
                }
                saved_style.update_window_now(hwnd);
                if let Some(splash_hwnd) = self.splash_screen.hwnd() {
                    saved_style.bring_child_to_top(splash_hwnd);
                }
                if !self.start_hidden {
                    saved_style.show_window_after_splash(hwnd, intended_show);
                    if let Some(splash_hwnd) = self.splash_screen.hwnd() {
                        saved_style.bring_child_to_top(splash_hwnd);
                    }
                    saved_style.update_window_now(hwnd);
                }
            }
        }

        self.tray.tray_show_hide.set_checked(!self.start_hidden);

        // Bounded wait after the splash is visible (server was spawned during UI build).
        self.server.wait_ready(time::Duration::from_secs(15));

        custom_api::init();
        self.webview.endpoint.set(self.webui_url.clone()).ok();
        self.webview.dev_tools.set(self.dev_tools).ok();
        if self.no_splash {
            // Controller may not exist yet; hide notice reveals WebView when ready.
            self.hide_splash_notice.sender().notice();
        } else {
            // Safety net only — normal hide is mystremio-ui-ready (~2.5s JS deadline).
            let hide_splash_sender = self.hide_splash_notice.sender();
            thread::spawn(move || {
                thread::sleep(time::Duration::from_secs(3));
                hide_splash_sender.notice();
            });
        }

        let player_channel = self.player.channel.borrow();
        let (player_tx, player_rx) = player_channel
            .as_ref()
            .expect("Cannont obtain communication channel for the Player");
        let player_tx = player_tx.clone();
        let player_rx = player_rx.clone();

        let web_channel = self.webview.channel.borrow();
        let (web_tx, web_rx) = web_channel
            .as_ref()
            .expect("Cannont obtain communication channel for the Web UI");
        let web_tx_player = web_tx.clone();
        let web_tx_web = web_tx.clone();
        let web_tx_arg = web_tx.clone();
        let web_tx_upd = web_tx.clone();
        let web_rx = web_rx.clone();

        let (updater_tx, updater_rx) = flume::unbounded::<String>();
        let updater_tx_web = updater_tx.clone();

        let command_clone = self.command.clone();

        // Single application IPC
        let socket_path = Path::new(
            self.commands_path
                .as_ref()
                .expect("Cannot initialie the single application IPC"),
        );

        let force_update = self.force_update;
        let release_candidate = self.release_candidate;
        let autoupdater_setup_file = self.autoupdater_setup_file.clone();

        if ENABLE_AUTOUPDATER {
            thread::spawn(move || {
                loop {
                    if let Ok(msg) = updater_rx.recv() {
                        if msg == "check_for_update" {
                            break;
                        }
                    }
                }

                loop {
                    let current_version = env!("CARGO_PKG_VERSION")
                        .parse()
                        .expect("Should always be valid");

                    let updater =
                        updater::Updater::new(current_version, force_update, release_candidate);
                    match updater.check_for_update() {
                        Ok(Some(update)) => {
                            println!("New version ready to install v{}", update.version);
                            let mut autoupdater_setup_file = autoupdater_setup_file.lock().unwrap();
                            *autoupdater_setup_file = Some(update.file.clone());
                            web_tx_upd.send(RPCResponse::update_available()).ok();
                        }
                        Ok(None) => println!("No new updates found"),
                        Err(e) => eprintln!("Failed to fetch updates: {e}"),
                    }

                    thread::sleep(time::Duration::from_secs(UPDATE_INTERVAL));
                }
            });
        }

        if let Ok(mut listener) = PipeServer::bind(socket_path) {
            let focus_sender = self.focus_notice.sender();
            thread::spawn(move || loop {
                if let Ok(mut stream) = listener.accept() {
                    let mut buf = vec![];
                    stream.read_to_end(&mut buf).ok();
                    if let Ok(s) = str::from_utf8(&buf) {
                        focus_sender.notice();
                        // ['open-media', url]
                        web_tx_arg.send(RPCResponse::open_media(s.to_string())).ok();
                        println!("{s}");
                    }
                }
            });
        }

        // Read message from player
        thread::spawn(move || loop {
            player_rx
                .iter()
                .map(|msg| web_tx_player.send(msg))
                .for_each(drop);
        }); // thread

        let toggle_fullscreen_sender = self.toggle_fullscreen_notice.sender();
        let toggle_borderless_sender = self.toggle_borderless_notice.sender();
        let window_chrome_sender = self.window_chrome_notice.sender();
        let webview_background_sender = self.webview_background_notice.sender();
        let toggle_pip_sender = self.toggle_pip_notice.sender();
        let (pip_response_tx, pip_response_rx) = flume::bounded::<bool>(1);
        custom_api::register_pip_response_sender(pip_response_tx);
        let (ui_scale_tx, ui_scale_rx) = flume::unbounded::<()>();
        custom_api::register_ui_scale_apply_sender(ui_scale_tx);
        let apply_ui_scale_sender = self.apply_ui_scale_notice.sender();
        thread::spawn(move || {
            while ui_scale_rx.recv().is_ok() {
                apply_ui_scale_sender.notice();
            }
        });
        let quit_sender = self.quit_notice.sender();
        let hide_splash_sender = self.hide_splash_notice.sender();
        let focus_sender = self.focus_notice.sender();
        let autoupdater_setup_mutex = self.autoupdater_setup_file.clone();
        let requested_fullscreen = self.requested_fullscreen.clone();
        let requested_borderless = self.requested_borderless.clone();
        let requested_window_chrome = self.requested_window_chrome.clone();
        let requested_webview_transparent = self.requested_webview_transparent.clone();
        thread::spawn(move || loop {
            let Ok(raw) = web_rx.recv() else {
                break;
            };

            if custom_api::is_custom_request(&raw) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if value.get("method").and_then(|method| method.as_str())
                        == Some("toggle-player-pip")
                    {
                        let id = value
                            .get("id")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        let _ = pip_response_rx.try_recv();
                        toggle_pip_sender.notice();
                        let active = pip_response_rx
                            .recv_timeout(time::Duration::from_millis(1500))
                            .unwrap_or(false);
                        web_tx_web
                            .send(
                                serde_json::json!({
                                    "stremioCustom": true,
                                    "id": id,
                                    "result": active,
                                })
                                .to_string(),
                            )
                            .ok();
                        continue;
                    }
                    // Ratings fan-out is slow (many HTTP calls) — never block the IPC loop.
                    if value.get("method").and_then(|method| method.as_str())
                        == Some("get-title-ratings")
                    {
                        custom_api::enqueue_title_ratings(value, web_tx_web.clone());
                        continue;
                    }
                    if let Some(response) = custom_api::handle_request(&value) {
                        web_tx_web.send(response).ok();
                    }
                }
                continue;
            }

            if let Some(msg) = serde_json::from_str::<RPCRequest>(&raw).ok() {
                match msg.get_method() {
                    // The handshake. Here we send some useful data to the WEB UI
                    None if msg.is_handshake() => {
                        web_tx_web.send(RPCResponse::get_handshake()).ok();
                    }
                    Some("win-set-visibility") => {
                        if let Some(fullscreen) = msg
                            .get_params()
                            .and_then(|params| params.get("fullscreen"))
                            .and_then(|value| value.as_bool())
                        {
                            *requested_fullscreen.lock().unwrap() = Some(fullscreen);
                            toggle_fullscreen_sender.notice();
                        }
                    }
                    Some("win-set-borderless") => {
                        if let Some(enabled) = msg
                            .get_params()
                            .and_then(|params| params.get("enabled"))
                            .and_then(|value| value.as_bool())
                        {
                            *requested_borderless.lock().unwrap() = Some(enabled);
                            toggle_borderless_sender.notice();
                        }
                    }
                    Some("win-minimize") => {
                        *requested_window_chrome.lock().unwrap() = Some("min".to_string());
                        window_chrome_sender.notice();
                    }
                    Some("win-maximize") => {
                        *requested_window_chrome.lock().unwrap() = Some("max".to_string());
                        window_chrome_sender.notice();
                    }
                    Some("win-close") => quit_sender.notice(),
                    Some("webview-set-background") => {
                        if let Some(transparent) = msg
                            .get_params()
                            .and_then(|params| params.get("transparent"))
                            .and_then(|value| value.as_bool())
                        {
                            *requested_webview_transparent.lock().unwrap() = Some(transparent);
                            webview_background_sender.notice();
                        }
                    }
                    Some("quit") => quit_sender.notice(),
                    Some("app-ready") => {
                        // Do NOT hide splash here — stock/web can fire this before plugins
                        // load (BAD cold-start). Splash drops on mystremio-ui-ready instead.
                        web_tx_web
                            .send(RPCResponse::visibility_change(true, 1, false))
                            .ok();
                        if ENABLE_AUTOUPDATER {
                            updater_tx_web
                                .send("check_for_update".to_owned())
                                .expect("Failed to send value to updater channel");
                        }

                        let command_ref = command_clone.clone();
                        if !command_ref.is_empty() {
                            web_tx_web.send(RPCResponse::open_media(command_ref)).ok();
                        }
                    }
                    Some("mystremio-ui-ready") => {
                        hide_splash_sender.notice();
                    }
                    Some("app-error") => {
                        hide_splash_sender.notice();
                        if let Some(arg) = msg.get_params() {
                            // TODO: Make this modal dialog
                            eprintln!("Web App Error: {arg}");
                        }
                    }
                    Some("open-external") => {
                        if let Some(arg) = msg.get_params() {
                            // FIXME: THIS IS NOT SAFE BY ANY MEANS
                            // open::that("calc").ok(); does exactly that
                            let arg = arg.as_str().unwrap_or("");
                            let arg_lc = arg.to_lowercase();
                            if arg_lc.starts_with("http://")
                                || arg_lc.starts_with("https://")
                                || arg_lc.starts_with("rtp://")
                                || arg_lc.starts_with("rtps://")
                                || arg_lc.starts_with("ftp://")
                                || arg_lc.starts_with("ipfs://")
                            {
                                open::that(arg).ok();
                            }
                        }
                    }
                    Some("play-external") => {
                        if let Some(arg) = msg.get_params() {
                            let arg = arg.as_str().unwrap_or("");
                            let arg_lc = arg.to_lowercase();
                            const ALLOWED_SCHEMES: &[&str] = &["mpv://", "vlc://", "potplayer://"];
                            let allowed = ALLOWED_SCHEMES.iter().any(|s| arg_lc.starts_with(s));
                            if !arg.is_empty() && allowed {
                                if let Some(stream_url) =
                                    arg_lc.starts_with("mpv://").then(|| &arg[6..])
                                {
                                    // `--` ends mpv's option parsing; the stream URL can't smuggle flags.
                                    let mpv_paths: Vec<String> = vec![
                                        std::env::var("ProgramFiles")
                                            .ok()
                                            .map(|v| format!("{v}\\mpv\\mpv.exe")),
                                        std::env::var("ProgramFiles(x86)")
                                            .ok()
                                            .map(|v| format!("{v}\\mpv\\mpv.exe")),
                                        std::env::var("LOCALAPPDATA")
                                            .ok()
                                            .map(|v| format!("{v}\\Programs\\mpv\\mpv.exe")),
                                        std::env::var("LOCALAPPDATA")
                                            .ok()
                                            .map(|v| format!("{v}\\mpv\\mpv.exe")),
                                        Some("mpv.exe".to_string()),
                                    ]
                                    .into_iter()
                                    .flatten()
                                    .collect();
                                    for path in &mpv_paths {
                                        if Command::new(path)
                                            .arg("--")
                                            .arg(stream_url)
                                            .creation_flags(CREATE_BREAKAWAY_FROM_JOB)
                                            .spawn()
                                            .is_ok()
                                        {
                                            break;
                                        }
                                    }
                                } else {
                                    open::that(arg).ok();
                                }
                            }
                        }
                    }
                    Some("win-focus") => {
                        focus_sender.notice();
                    }
                    Some("autoupdater-notif-clicked") => {
                        // We've shown the "Update Available" notification
                        // and the user clicked on "Restart And Update"
                        let autoupdater_setup_file =
                            autoupdater_setup_mutex.lock().unwrap().clone();
                        match autoupdater_setup_file {
                            Some(file_path) => {
                                println!("Running the setup at {file_path:?}");

                                let command = Command::new(file_path)
                                    .args([
                                        "/SILENT",
                                        "/NOCANCEL",
                                        "/FORCECLOSEAPPLICATIONS",
                                        "/TASKS=runapp",
                                    ])
                                    .creation_flags(CREATE_BREAKAWAY_FROM_JOB)
                                    .stdin(process::Stdio::null())
                                    .stdout(process::Stdio::null())
                                    .stderr(process::Stdio::null())
                                    .spawn();

                                match command {
                                    Ok(process) => {
                                        println!("Updater started. (PID {:?})", process.id());
                                        quit_sender.notice();
                                    }
                                    Err(err) => eprintln!("Updater couldn't be started: {err}"),
                                };
                            }
                            _ => {
                                println!("Cannot obtain the setup file path");
                            }
                        }
                    }
                    Some(player_command) if player_command.starts_with("mpv-") => {
                        let resp_json = serde_json::to_string(
                            &msg.args.expect("Cannot have method without args"),
                        )
                        .expect("Cannot build response");
                        player_tx.send(resp_json).ok();
                    }
                    Some(unknown) => {
                        eprintln!("Unsupported command {}({:?})", unknown, msg.get_params())
                    }
                    None => {}
                }
            } // parsed shell RPC
        }); // thread
    }
    fn on_min_max(&self, data: &nwg::EventData) {
        let data = data.on_min_max();
        data.set_min_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT);
    }
    fn on_paint(&self) {
        if !self.splash_screen.visible() {
            self.webview.fit_to_window(self.window.handle.hwnd());
        }
    }
    fn on_window_state_changed(&self) {
        self.save_window_settings();
        self.transmit_window_state_change();
    }
    fn on_window_focus(&self) {
        self.transmit_window_state_change();
        self.transmit_window_visibility_change();
    }
    fn save_window_settings(&self) {
        if self
            .saved_window_style
            .try_borrow()
            .map(|style| style.full_screen)
            .unwrap_or(false)
        {
            return;
        }
        if let Some(hwnd) = self.window.handle.hwnd() {
            if let Err(err) = WindowSettings::save(hwnd) {
                eprintln!("Cannot save window settings: {err}");
            }
        }
    }
    fn on_toggle_fullscreen_notice(&self) {
        if let Some(hwnd) = self.window.handle.hwnd() {
            if let Ok(mut saved_style) = self.saved_window_style.try_borrow_mut() {
                // Coalesce to the latest explicit target. Never toggle on empty notice —
                // a second notice after take() used to invert FS and cancel the click.
                let target = self.requested_fullscreen.lock().unwrap().take();
                if let Some(target) = target {
                    saved_style.set_full_screen(hwnd, target);
                    self.tray.tray_topmost.set_enabled(!saved_style.full_screen);
                    self.tray
                        .tray_topmost
                        .set_checked((saved_style.ex_style as u32 & WS_EX_TOPMOST) == WS_EX_TOPMOST);
                }
            }
            // Client area changes when chrome is stripped — keep WebView bounds in sync.
            self.webview.fit_to_window(Some(hwnd));
        }
        self.transmit_window_visibility_change();
    }

    /**
     * Applies a pending `win-set-borderless` request on the UI thread.
     *
     * Strips or restores window chrome without changing window size so MPV
     * video cannot flash framed borders during player load.
     */
    fn on_toggle_borderless_notice(&self) {
        if let Some(hwnd) = self.window.handle.hwnd() {
            if let Ok(mut saved_style) = self.saved_window_style.try_borrow_mut() {
                if let Some(enabled) = self.requested_borderless.lock().unwrap().take() {
                    saved_style.set_borderless(hwnd, enabled);
                }
            }
            // Critical: removing caption grows the client rect; without this, a white
            // ring of HWND background remains around the (still smaller) WebView2.
            self.webview.fit_to_window(Some(hwnd));
        }
    }

    /// Applies pending in-app min/max from player nav chrome (borderless has no OS caption).
    fn on_window_chrome_notice(&self) {
        let action = self.requested_window_chrome.lock().unwrap().take();
        let Some(hwnd) = self.window.handle.hwnd() else {
            return;
        };
        if let Ok(style) = self.saved_window_style.try_borrow() {
            match action.as_deref() {
                Some("min") => style.minimize_window(hwnd),
                Some("max") => {
                    style.toggle_maximize_window(hwnd);
                    self.webview.fit_to_window(Some(hwnd));
                }
                _ => {}
            }
        }
    }

    /// Apply pending WebView2 background opacity on the UI thread.
    fn on_webview_background_notice(&self) {
        if let Some(transparent) = self.requested_webview_transparent.lock().unwrap().take() {
            self.webview.set_background_transparent(transparent);
        }
    }
    fn dismiss_startup_overlays_in_webview(&self) {
        // Splash hide and safety timeout MUST clear boot seal — otherwise a hung
        // bootstrap leaves a permanent black screen that survives tray hide/show.
        self.webview.execute_script(
            r#"try{window.__stremioCustomDismissStartupOverlays&&window.__stremioCustomDismissStartupOverlays();window.__stremioCustomRemoveBootSeal&&window.__stremioCustomRemoveBootSeal();}catch(e){}"#,
        );
    }

    fn wake_webview_after_show(&self) {
        if let Some(hwnd) = self.window.handle.hwnd() {
            self.webview.fit_to_window(Some(hwnd));
        }
        self.webview.set_visible(true);
        // JS resume clears overlays only after bootstrap-ready (not during cold splash).
        self.webview.execute_script(
            r#"try{window.__stremioCustomOnWindowResumed&&window.__stremioCustomOnWindowResumed('shell-show');}catch(e){}"#,
        );
        if let Ok(web_channel) = self.webview.channel.try_borrow() {
            if let Some((web_tx, _)) = web_channel.as_ref() {
                web_tx.send(RPCResponse::window_resumed()).ok();
            }
        }
    }

    fn on_hide_splash_notice(&self) {
        self.splash_screen.hide();
        if let Some(hwnd) = self.window.handle.hwnd() {
            self.webview.fit_to_window(Some(hwnd));
        }
        self.webview.set_visible(true);
        self.dismiss_startup_overlays_in_webview();
        // Re-arm catalog LoadRange after splash hide (retries until Ready / timeout).
        self.webview.execute_script(
            r#"try{window.__stremioCustomNudgeBoardCatalogLoadRange&&window.__stremioCustomNudgeBoardCatalogLoadRange('splash-hide');}catch(e){}"#,
        );
    }
    fn on_focus_notice(&self) {
        self.window.set_visible(true);
        if let Some(hwnd) = self.window.handle.hwnd() {
            if let Ok(mut saved_style) = self.saved_window_style.try_borrow_mut() {
                saved_style.set_active(hwnd);
            }
        }
        self.wake_webview_after_show();
    }
    fn on_toggle_pip_notice(&self) {
        if let Some(hwnd) = self.window.handle.hwnd() {
            if let Ok(mut saved_style) = self.saved_window_style.try_borrow_mut() {
                let active = saved_style.toggle_pip_mode(hwnd);
                custom_api::complete_pip_toggle(active);
                return;
            }
        }
        custom_api::complete_pip_toggle(false);
    }
    fn on_apply_ui_scale_notice(&self) {
        if let (Some(hwnd), Some(controller)) = (
            self.window.handle.hwnd(),
            self.webview.controller.get(),
        ) {
            apply_ui_scale(controller, hwnd);
        }
    }
    fn on_toggle_topmost(&self) {
        if let Some(hwnd) = self.window.handle.hwnd() {
            if let Ok(mut saved_style) = self.saved_window_style.try_borrow_mut() {
                saved_style.toggle_topmost(hwnd);
                self.tray
                    .tray_topmost
                    .set_checked((saved_style.ex_style as u32 & WS_EX_TOPMOST) == WS_EX_TOPMOST);
            }
        }
    }
    fn on_show(&self) {
        self.window.set_visible(true);
        if let (Some(hwnd), Ok(mut saved_style)) = (
            self.window.handle.hwnd(),
            self.saved_window_style.try_borrow_mut(),
        ) {
            if saved_style.is_window_minimized(hwnd) {
                self.window.restore();
            }
            saved_style.set_active(hwnd);
        }
        self.tray.tray_show_hide.set_checked(self.window.visible());
        self.wake_webview_after_show();
        self.transmit_window_state_change();
        self.transmit_window_visibility_change();
    }
    fn on_show_hide(&self) {
        if self.window.visible() {
            self.window.set_visible(false);
            self.tray.tray_show_hide.set_checked(self.window.visible());
            self.transmit_window_state_change();
            self.transmit_window_visibility_change();
        } else {
            self.on_show();
        }
    }
    fn on_quit(&self, data: &nwg::EventData) {
        if let nwg::EventData::OnWindowClose(data) = data {
            data.close(false);
        }
        self.save_window_settings();
        self.window.set_visible(false);
        self.tray.tray_show_hide.set_checked(self.window.visible());
        self.transmit_window_visibility_change();
    }
    fn on_exit(&self) {
        self.save_window_settings();
        nwg::stop_thread_dispatch();
    }
}
