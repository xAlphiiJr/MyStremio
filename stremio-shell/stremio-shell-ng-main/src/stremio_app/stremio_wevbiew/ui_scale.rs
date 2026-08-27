use crate::stremio_app::custom_api::{
    read_ui_scale, resolve_ui_scale_for_monitor, take_ui_scale_user_bind,
};
use std::mem;
use webview2::Controller;
use winapi::shared::windef::HWND;
use winapi::um::winuser::{
    GetDpiForWindow, GetMonitorInfoA, MonitorFromWindow, MONITORINFOEXA, MONITOR_DEFAULTTONEAREST,
};

const ALLOWED_UI_SCALE_PERCENTS: [u32; 6] = [75, 100, 125, 150, 175, 200];

/// Snaps a UI scale percentage to the nearest supported 25% step.
pub fn normalize_ui_scale_percent(value: u32) -> u32 {
    ALLOWED_UI_SCALE_PERCENTS
        .iter()
        .copied()
        .min_by_key(|allowed| allowed.abs_diff(value))
        .unwrap_or(100)
}

/// Returns the Windows DPI scale for the window (1.0 = 100% / 96 DPI).
fn window_dpi_scale(hwnd: HWND) -> f64 {
    unsafe {
        let dpi = GetDpiForWindow(hwnd);
        let dpi = if dpi == 0 { 96 } else { dpi };
        dpi as f64 / 96.0
    }
}

/// Returns the Windows scaling percent for the window's current monitor (snapped to 75–200).
fn windows_scale_percent(hwnd: HWND) -> u32 {
    let raw = (window_dpi_scale(hwnd) * 100.0).round() as u32;
    normalize_ui_scale_percent(raw)
}

/// Device key for the monitor that currently hosts `hwnd` (e.g. `\\.\DISPLAY1`).
fn monitor_device_key(hwnd: HWND) -> Option<String> {
    if hwnd.is_null() {
        return None;
    }
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return None;
        }
        let mut info: MONITORINFOEXA = mem::zeroed();
        info.cbSize = mem::size_of::<MONITORINFOEXA>() as u32;
        if GetMonitorInfoA(monitor, &mut info as *mut _ as *mut _) == 0 {
            return None;
        }
        let device = std::ffi::CStr::from_ptr(info.szDevice.as_ptr())
            .to_string_lossy()
            .trim_end_matches('\0')
            .trim()
            .to_string();
        if device.is_empty() {
            None
        } else {
            Some(device)
        }
    }
}

/// Syncs resolved scale into WebView localStorage and notifies the settings UI.
fn sync_ui_scale_to_webview(controller: &Controller, percent: u32) {
    let Ok(webview) = controller.get_webview() else {
        return;
    };
    let script = format!(
        concat!(
            "(function(){{try{{",
            "localStorage.setItem('stremio-custom-ui-scale-percent','{p}');",
            "document.dispatchEvent(new CustomEvent('stremio-custom-ui-scale-changed',",
            "{{detail:{{percent:{p},source:'monitor'}}}}));",
            "}}catch(_){{}}}})();"
        ),
        p = percent
    );
    let _ = webview.execute_script(&script, |_| Ok(()));
}

/// Computes the WebView2 zoom factor for a user-selected UI scale on the current monitor.
///
/// User scale is absolute (100% = design baseline). Windows DPI is compensated so that
/// e.g. 100% in settings on a 125% display yields zoom 0.8.
pub fn compute_zoom_factor(hwnd: HWND, ui_scale_percent: u32) -> f64 {
    let user_scale = normalize_ui_scale_percent(ui_scale_percent) as f64 / 100.0;
    let dpi_scale = if hwnd.is_null() {
        1.0
    } else {
        window_dpi_scale(hwnd).max(0.25)
    };
    (user_scale / dpi_scale).clamp(0.25, 4.0)
}

/// Applies the per-monitor UI scale to the WebView controller.
///
/// Slider writes bind only the current monitor. HDMI unplug restores that
/// monitor's stored percent, or seeds Windows DPI on first visit.
pub fn apply_ui_scale(controller: &Controller, hwnd: HWND) {
    let previous = read_ui_scale();
    let pending_user = take_ui_scale_user_bind();
    let percent = match monitor_device_key(hwnd) {
        Some(key) => resolve_ui_scale_for_monitor(&key, windows_scale_percent(hwnd), pending_user),
        None => pending_user.unwrap_or(previous),
    };
    let zoom = compute_zoom_factor(hwnd, percent);
    controller.put_zoom_factor(zoom).ok();
    if percent != previous || pending_user.is_some() {
        sync_ui_scale_to_webview(controller, percent);
    }
}
