use crate::stremio_app::constants::SERVER_IPC_KEY;
use crate::stremio_app::custom_api::{build_early_storage_restore_script, webview_user_data_dir};
use crate::stremio_app::ipc;
use native_windows_gui::{self as nwg, PartialUi};
use once_cell::unsync::OnceCell;
use serde_json::json;
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::mem;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::thread;
use url::Url;
use urlencoding::decode;
use webview2::Controller;
use webview2_sys::ICoreWebView2Controller3;
use winapi::shared::minwindef::FALSE;
use winapi::shared::windef::HWND;
use winapi::um::winuser::{
    GetClientRect, GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST, VK_F7,
    WM_APPCOMMAND, WM_SETFOCUS,
};

const APPCOMMAND_MEDIA_NEXTTRACK: u32 = 11;
const APPCOMMAND_MEDIA_PREVIOUSTRACK: u32 = 12;
const APPCOMMAND_MEDIA_PLAY_PAUSE: u32 = 14;
const APPCOMMAND_MEDIA_PLAY: u32 = 46;
const APPCOMMAND_MEDIA_PAUSE: u32 = 47;

use super::constants::{WARNING_URL, WHITELISTED_HOSTS};

/// Display height (physical pixels) that maps to 100% UI scale.
const UI_SCALE_BASELINE_HEIGHT: f64 = 1080.0;
/// Never render below the 100% design.
const UI_SCALE_MIN: f64 = 1.0;
/// Upper bound to avoid absurd scaling on very high-resolution panels (e.g. 8K).
const UI_SCALE_MAX: f64 = 4.0;

/// Derive the WebView rasterization scale from the display resolution instead of
/// the Windows display-scaling setting.
///
/// The UI is designed for a 1080p baseline (= 100%). Pinning the scale to 1.0
/// keeps the app independent of the Windows scaling slider, but makes the UI tiny
/// on high-resolution panels (a 4K screen has 4x the pixels on the same area).
/// Scaling proportionally to the monitor height restores a consistent physical
/// size while still ignoring the user's Windows slider: because the process is
/// DPI-aware, `GetMonitorInfo` reports the true physical resolution regardless of
/// that slider.
///
/// # Arguments
/// * `hwnd` - Window handle used to pick the monitor the window currently sits on.
///
/// # Returns
/// A scale factor clamped to `[UI_SCALE_MIN, UI_SCALE_MAX]`. Falls back to
/// `UI_SCALE_MIN` (100%) if the monitor size cannot be determined.
fn resolution_rasterization_scale(hwnd: HWND) -> f64 {
    let height = unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return UI_SCALE_MIN;
        }
        let mut info: MONITORINFO = mem::zeroed();
        info.cbSize = mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return UI_SCALE_MIN;
        }
        f64::from(info.rcMonitor.bottom - info.rcMonitor.top)
    };

    if height <= 0.0 {
        return UI_SCALE_MIN;
    }

    (height / UI_SCALE_BASELINE_HEIGHT).clamp(UI_SCALE_MIN, UI_SCALE_MAX)
}

#[derive(Default)]
pub struct WebView {
    pub endpoint: Rc<OnceCell<String>>,
    pub dev_tools: Rc<OnceCell<bool>>,
    pub controller: Rc<OnceCell<Controller>>,
    pub channel: ipc::Channel,
    notice: nwg::Notice,
    compute: RefCell<Option<thread::JoinHandle<()>>>,
    message_queue: Arc<Mutex<VecDeque<String>>>,
}

impl WebView {
    pub fn fit_to_window(&self, hwnd: Option<HWND>) {
        if let Some(hwnd) = hwnd {
            unsafe {
                let mut rect = mem::zeroed();
                GetClientRect(hwnd, &mut rect);
                self.controller
                    .get()
                    .and_then(|controller| controller.put_bounds(rect).ok());
            }
        }
    }

    fn resize_to_window_bounds(controller: Option<&Controller>, hwnd: Option<HWND>) {
        if let (Some(controller), Some(hwnd)) = (controller, hwnd) {
            unsafe {
                let mut rect = mem::zeroed();
                GetClientRect(hwnd, &mut rect);
                controller.put_bounds(rect).ok();
            }
        }
    }
}

impl PartialUi for WebView {
    fn build_partial<W: Into<nwg::ControlHandle>>(
        data: &mut Self,
        parent: Option<W>,
    ) -> Result<(), nwg::NwgError> {
        println!("Building WebView");
        let (tx, rx) = flume::unbounded();
        let tx_drag_drop = tx.clone();
        let tx_media = tx.clone();
        let (tx_web, rx_web) = flume::unbounded();
        let tx_fs = tx_web.clone();
        data.channel = RefCell::new(Some((tx, rx_web)));

        let parent = parent.expect("No parent window").into();

        let hwnd = parent.hwnd().expect("Cannot obtain window handle");
        nwg::Notice::builder()
            .parent(parent)
            .build(&mut data.notice)
            .ok();
        let controller_clone = data.controller.clone();
        let endpoint = data.endpoint.clone();
        let dev_tools = data.dev_tools.clone();
        let webview_flags = concat!(
            "--autoplay-policy=no-user-gesture-required ",
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,",
            "OverlayScrollbar,msOverlayScrollbarWinStyle,msOverlayScrollbarWinStyleAnimation"
        );
        const CINEBYE_AUTO_LOGIN_SCRIPT: &str = r#"
(function () {
  try {
    if (!/cinebye\.elfhosted\.com$/i.test(location.hostname)) return;
    var params = new URLSearchParams(location.search);
    var authkey = (params.get('authkey') || params.get('authKey') || '').replace(/"/g, '').trim();
    if (!authkey) return;
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      if (attempts > 80) {
        clearInterval(timer);
        return;
      }
      var input = document.querySelector('.authkey-row input')
        || document.querySelector('input[placeholder*="AuthKey"]');
      if (!input) return;
      if (input.value !== authkey) {
        input.value = authkey;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      var loginBtn = document.querySelector('button.accent');
      if (loginBtn && loginBtn.textContent !== 'Logging in...' && loginBtn.textContent !== 'Logged in') {
        loginBtn.click();
        clearInterval(timer);
      }
    }, 250);
  } catch (_) {}
})();
"#;
        let user_data_folder = webview_user_data_dir();
        let result = webview2::EnvironmentBuilder::new()
            .with_additional_browser_arguments(webview_flags)
            .with_user_data_folder(&user_data_folder)
            .build(move |env| {
                let env = env.expect("Cannot obtain webview environment");
                env.create_controller(hwnd, move |controller| {
                        let controller = controller.expect("Cannot obtain webview controller");
                        if let Ok(controller2) = controller.get_controller2() {
                            controller2
                                .put_default_background_color(webview2_sys::Color {
                                    r: 255,
                                    g: 255,
                                    b: 255,
                                    a: 0,
                                })
                                .ok();
                        } else {
                            eprintln!("failed to get interface to controller2");
                        }

                        // Decouple the UI scale from the Windows display-scaling
                        // slider. By default the WebView follows the OS DPI
                        // (125/150/200%) and scales up. We instead derive the scale
                        // from the display resolution (1080p = 100% baseline) so the
                        // app keeps a consistent physical size: 1.0 on 1080p, ~1.33 on
                        // 1440p, 2.0 on 4K. Disabling monitor-scale detection stops the
                        // WebView from re-applying the OS scale on DPI changes.
                        if let Some(controller3) = controller
                            .as_inner()
                            .get_interface::<dyn ICoreWebView2Controller3>()
                        {
                            let scale = resolution_rasterization_scale(hwnd);
                            unsafe {
                                let _ = controller3.put_should_detect_monitor_scale_changes(FALSE);
                                let _ = controller3.put_rasterization_scale(scale);
                            }
                        } else {
                            eprintln!("failed to get interface to controller3 (DPI scale pin unavailable)");
                        }
                    let webview = controller
                            .get_webview()
                            .expect("Cannot obtain webview from controller");
                    let settings = webview.get_settings().unwrap();
                    settings.put_is_status_bar_enabled(false).ok();
                    settings.put_are_dev_tools_enabled(*dev_tools.get().unwrap()).ok();
                    settings.put_is_zoom_control_enabled(false).ok();
                    settings.put_is_built_in_error_page_enabled(false).ok();
                    settings.put_are_host_objects_allowed(false).ok();
                    settings.put_are_default_script_dialogs_enabled(false).ok();

                    webview
                        .add_script_to_execute_on_document_created(
                            build_early_storage_restore_script().as_str(),
                            |_| Ok(()),
                        )
                        .ok();

                    webview
                        .add_script_to_execute_on_document_created(
                            include_str!("../../../assets/custom_preboot.js"),
                            |_| Ok(()),
                        )
                        .ok();

                    webview
                        .add_script_to_execute_on_document_created(CINEBYE_AUTO_LOGIN_SCRIPT, |_| {
                            Ok(())
                        })
                        .ok();

                    // Handle window.open and href
                    webview.add_new_window_requested(move |_webview, event| {
                        if let Ok(uri) = event.get_uri() {
                            if let Ok(url) = Url::parse(&uri) {
                                let is_whitelisted = url.host().is_some_and(|host| {
                                    WHITELISTED_HOSTS.iter().any(|whitelisted_host| host.to_string().ends_with(whitelisted_host))
                                });

                                let final_url = if is_whitelisted {
                                    url.to_string()
                                } else {
                                    format!("{}{}", WARNING_URL, urlencoding::encode(url.as_ref()))
                                };

                                if let Err(e) = open::that(final_url) {
                                    eprintln!("Failed to open URL: {e}");
                                }
                            }
                        }

                        Ok(())
                    })?;

                    if let Some(endpoint) = endpoint.get() {
                        if webview
                            .navigate(endpoint.as_str()).is_err() {
                                tx_web.clone().send(ipc::RPCResponse::response_message(Some(json!(["app-error", format!("Cannot load WEB UI at '{}'", &endpoint)])))).ok();
                        };
                    }
                        webview.add_web_message_received(move |_w, msg| {
                            let msg = msg.try_get_web_message_as_string()?;
                            tx_web.send(msg).ok();
                            Ok(())
                        }).expect("Cannot add web message received");
                        webview.add_new_window_requested(move |_w, msg| {
                            if let Some(file) = msg.get_uri().ok().and_then(|str| {decode(str.as_str()).ok().map(Cow::into_owned)}) {
                                tx_drag_drop.send(ipc::RPCResponse::response_message(Some(json!(["dragdrop" ,[file]])))).ok();
                                msg.put_handled(true).ok();
                            }
                            Ok(())
                        }).expect("Cannot add D&D handler");
                        webview.add_contains_full_screen_element_changed(move |wv| {
                            if let Ok(visibility) = wv.get_contains_full_screen_element() {
                                tx_fs.send(ipc::RPCResponse::response_message(Some(json!(["win-set-visibility" , {"fullscreen": visibility}])))).ok();
                            }
                            Ok(())
                        }).expect("Cannot add full screen element changed");

                        webview.add_content_loading(move |wv, _| {
                            wv.execute_script(format!(
                                    "window.stremio_server_ipc_key='{}'",
                                    std::env::var(SERVER_IPC_KEY).unwrap_or_default()
                            ).as_str(), |_| Ok(())
                            ).expect("Cannot add SERVER_IPC_KEY to webview");

                            wv.execute_script(r##"
                            try{
                                /* Disable context menus */
                                document.addEventListener('contextmenu', (e) => {
                                    if(!(e.target.tagName == "INPUT" &&
                                    ['text', 'password', 'number', 'week', 'month', 'email'].includes(e.target.type.toLowerCase()))) {
                                        e.stopPropagation();e.preventDefault()
                                    }
                                    })
                            }catch(e){}

                            try{console.log('Shell JS injected');if(window.self === window.top) {
                                (function(){
                                    var webview = window.chrome && window.chrome.webview;
                                    if (!webview || !webview.postMessage) return;
                                    if (!webview.__stremioShellPostWrapped) {
                                        webview.__stremioShellPostWrapped = true;
                                        var nativePost = webview.postMessage.bind(webview);
                                        webview.postMessage = function(message) {
                                            try {
                                                document.dispatchEvent(new CustomEvent('stremio-shell-outgoing', { detail: message }));
                                            } catch (e) {}
                                            if (typeof window.__stremioRewriteShellOutgoing === 'function') {
                                                try {
                                                    message = window.__stremioRewriteShellOutgoing(message) || message;
                                                } catch (e) {}
                                            }
                                            return nativePost(message);
                                        };
                                    }
                                    if (!webview.__stremioShellIncomingCapture) {
                                        webview.__stremioShellIncomingCapture = true;
                                        webview.addEventListener('message', function(ev) {
                                            if (typeof window.__stremioRewriteShellIncoming !== 'function') return;
                                            try {
                                                var rewritten = window.__stremioRewriteShellIncoming(ev.data);
                                                if (rewritten != null && rewritten !== ev.data) {
                                                    Object.defineProperty(ev, 'data', { configurable: true, writable: true, value: rewritten });
                                                }
                                            } catch (e) {}
                                        }, true);
                                    }
                                    function relayShellSend(message) {
                                        return webview.postMessage(message);
                                    }
                                    window.qt = { webChannelTransport: { send: relayShellSend } };
                                    webview.addEventListener('message', function(ev) {
                                        if (window.qt && window.qt.webChannelTransport) {
                                            window.qt.webChannelTransport.onmessage && window.qt.webChannelTransport.onmessage(ev);
                                        }
                                    });
                                })();
                                }}catch(e){}
                            window.addEventListener("load", function() {
                                try { if (typeof initShellComm === 'function') initShellComm(); } catch(e) {}
                            }, false)
                            
                            "##, |_| Ok(())).expect("Cannot add script to webview");

                            for script in [
                                include_str!("../../../assets/custom_startup_guard.js"),
                                include_str!("../../../assets/custom_bootstrap.js"),
                                include_str!("../../../assets/custom_scroll_restore.js"),
                                include_str!("../../../assets/custom_scrollbar.js"),
                                include_str!("../../../assets/custom_player_glass.js"),
                                include_str!("../../../assets/custom_player_loading.js"),
                                include_str!("../../../assets/custom_liquid_glass_nav.js"),
                                include_str!("../../../assets/custom_hero_loading.js"),
                                include_str!("../../../assets/custom_deep_link.js"),
                                include_str!("../../../assets/custom_continue_watching_play.js"),
                                include_str!("../../../assets/custom_audio_sync.js"),
                                include_str!("../../../assets/custom_subtitle_sync.js"),
                                include_str!("../../../assets/custom_favorite_languages_page.js"),
                                include_str!("../../../assets/custom_favorite_languages.js"),
                                include_str!("../../../assets/custom_autoskip.js"),
                                include_str!("../../../assets/custom_library_folders.js"),
                                include_str!("../../../assets/custom_cinebye_addons.js"),
                                include_str!("../../../assets/custom_discord_presence.js"),
                                include_str!("../../../assets/custom_settings_ui.js"),
                                include_str!("../../../assets/custom_api_key_settings.js"),
                                include_str!("../../../assets/custom_playback_bootstrap.js"),
                                include_str!("../../../assets/custom_stream_cache.js"),
                                include_str!("../../../assets/custom_playback_api.js"),
                                include_str!("../../../assets/custom_seek_buffer.js"),
                                include_str!("../../../assets/custom_volume_persist.js"),
                                include_str!("../../../assets/custom_player_disable_hold_speed.js"),
                                include_str!("../../../assets/custom_player_brightness.js"),
                                include_str!("../../../assets/custom_track_label_fix.js"),
                            ] {
                                wv.execute_script(script, |_| Ok(()))
                                    .expect("Cannot add MyStremio module");
                            }

                            wv.execute_script(
                                r#"try{if(window.__stremioCustomDismissStartupOverlays)window.__stremioCustomDismissStartupOverlays();if(document.readyState!=='loading'&&window.runBootstrapOnce)window.runBootstrapOnce();if(window.__stremioCustomPlayerGlassEnsure)window.__stremioCustomPlayerGlassEnsure();if(window.__stremioCustomPlayerLoadingEnsure)window.__stremioCustomPlayerLoadingEnsure();if(window.__stremioCustomHeroLoadingEnsure)window.__stremioCustomHeroLoadingEnsure();if(window.__stremioCustomPlayerTransparencyEnsure)window.__stremioCustomPlayerTransparencyEnsure();if(window.__stremioCustomPlaybackEnsure)window.__stremioCustomPlaybackEnsure();if(window.__stremioCustomVolumePersistEnsure)window.__stremioCustomVolumePersistEnsure();if(window.__stremioDisableHoldSpeedEnsure)window.__stremioDisableHoldSpeedEnsure();if(window.__stremioCustomPlayerBrightnessEnsure)window.__stremioCustomPlayerBrightnessEnsure();if(window.__stremioCustomAudioSyncEnsure)window.__stremioCustomAudioSyncEnsure();if(window.__stremioCustomSubtitleSyncEnsure)window.__stremioCustomSubtitleSyncEnsure();if(window.__stremioCustomLibraryFoldersEnsure)window.__stremioCustomLibraryFoldersEnsure();if(window.__stremioCustomCinebyeAddonsEnsure)window.__stremioCustomCinebyeAddonsEnsure();if(window.__stremioCustomApiKeySettingsEnsure)window.__stremioCustomApiKeySettingsEnsure();if(window.__stremioCustomScrollbarEnsure)window.__stremioCustomScrollbarEnsure();}catch(e){console.error('[StremioCustom] post-inject failed',e);}"#,
                                |_| Ok(()),
                            )
                            .ok();
                            Ok(())
                        }).expect("Cannot add content loading");

                        WebView::resize_to_window_bounds(Some(&controller), Some(hwnd));
                        controller.put_is_visible(true).ok();
                        controller
                            .move_focus(webview2::MoveFocusReason::Programmatic)
                            .ok();
                        controller.add_accelerator_key_pressed(move |_, e| {
                            // Block F7, Ctrl+F, and Ctrl+G
                            let k = e.get_virtual_key()?;
                            if k == VK_F7 as u32  || k == 70 & 0x7F || k == 71 & 0x7F {
                                e.put_handled(true)
                            } else {
                                Ok(())
                            }
                        })
                        .unwrap();

                        controller_clone
                            .set(controller)
                            .expect("Cannot update the controller");
                        Ok(())
                    })
            });
        if let Err(e) = result {
            nwg::modal_fatal_message(
                parent,
                "Failed to Create WebView2 Environment",
                &format!("{e}"),
            );
        }

        let sender = data.notice.sender();
        let message = data.message_queue.clone();
        *data.compute.borrow_mut() = Some(thread::spawn(move || loop {
            if let Ok(msg) = rx.recv() {
                let mut message = message.lock().unwrap();
                message.push_back(msg);
                sender.notice();
            }
        }));

        // handler ids equal or smaller than 0xFFFF are reserved by NWG
        let handler_id = 0x10000;
        let controller_clone = data.controller.clone();
        nwg::bind_raw_event_handler(&parent, handler_id, move |_hwnd, msg, _w, l| {
            if msg == WM_SETFOCUS {
                controller_clone.get().and_then(|controller| {
                    controller
                        .move_focus(webview2::MoveFocusReason::Programmatic)
                        .ok()
                });
            } else if msg == WM_APPCOMMAND {
                let cmd = ((l >> 16) & 0xFFF) as u32;
                let action = match cmd {
                    APPCOMMAND_MEDIA_PLAY_PAUSE
                    | APPCOMMAND_MEDIA_PLAY
                    | APPCOMMAND_MEDIA_PAUSE => Some("play-pause"),
                    APPCOMMAND_MEDIA_NEXTTRACK => Some("next-track"),
                    APPCOMMAND_MEDIA_PREVIOUSTRACK => Some("previous-track"),
                    _ => None,
                };
                if let Some(action) = action {
                    tx_media.send(ipc::RPCResponse::media_key(action)).ok();
                    return Some(1);
                }
            }
            None
        })
        .ok();

        Ok(())
    }
    fn process_event<'a>(
        &self,
        evt: nwg::Event,
        _evt_data: &nwg::EventData,
        handle: nwg::ControlHandle,
    ) {
        use nwg::Event as E;
        if evt == E::OnNotice && handle == self.notice.handle {
            let message_queue = self.message_queue.clone();
            if let Some(controller) = self.controller.get() {
                let webview = controller.get_webview().expect("Cannot get vebview");
                let mut message_queue = message_queue.lock().unwrap();
                for msg in message_queue.drain(..) {
                    webview.post_web_message_as_string(msg.as_str()).ok();
                }
            }
        }
    }
}
