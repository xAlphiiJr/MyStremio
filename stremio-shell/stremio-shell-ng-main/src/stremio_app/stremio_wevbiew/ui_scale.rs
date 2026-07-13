use crate::stremio_app::custom_api::read_ui_scale;
use webview2::Controller;
use winapi::shared::windef::HWND;

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
        let dpi = winapi::um::winuser::GetDpiForWindow(hwnd);
        let dpi = if dpi == 0 { 96 } else { dpi };
        dpi as f64 / 96.0
    }
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

/// Applies the persisted UI scale to the WebView controller.
pub fn apply_ui_scale(controller: &Controller, hwnd: HWND) {
    let percent = read_ui_scale();
    let zoom = compute_zoom_factor(hwnd, percent);
    controller.put_zoom_factor(zoom).ok();
}
