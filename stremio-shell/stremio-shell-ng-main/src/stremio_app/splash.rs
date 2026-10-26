use crate::stremio_app::constants::{WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH};
use native_windows_derive::NwgPartial;
use native_windows_gui as nwg;
use std::mem;
use winapi::shared::windef::HWND;
use winapi::um::winuser::{GetClientRect, SetWindowPos, HWND_TOP, SWP_SHOWWINDOW};

#[derive(Default, NwgPartial)]
pub struct SplashImage {
    #[nwg_resource]
    embed: nwg::EmbedResource,
    #[nwg_resource(size: Some((300,300)), source_embed: Some(&data.embed), source_embed_str: Some("SPLASHIMAGE"))]
    splash_image: nwg::Bitmap,
    #[nwg_layout(spacing: 0, min_size: [WINDOW_MIN_WIDTH as u32, WINDOW_MIN_HEIGHT as u32])]
    grid: nwg::GridLayout,
    #[nwg_control(background_color: Some(Self::BG_COLOR), bitmap: Some(&data.splash_image))]
    #[nwg_layout_item(layout: grid, col: 0, row: 0)]
    splash: nwg::ImageFrame,
}

impl SplashImage {
    /// Liquid Glass theme background (`--background: rgb(20, 20, 20)`).
    const BG_COLOR: [u8; 3] = [20, 20, 20];
    pub fn visible(&self) -> bool {
        self.splash.visible()
    }
    pub fn hide(&self) {
        self.splash.set_visible(false);
    }

    /// Stretch the splash frame over the whole client so the hero cannot show above it.
    pub fn cover_client(&self, parent: HWND) {
        let Some(hwnd) = self.hwnd() else {
            return;
        };
        unsafe {
            let mut rect = mem::zeroed();
            if GetClientRect(parent, &mut rect) == 0 {
                return;
            }
            SetWindowPos(
                hwnd,
                HWND_TOP,
                0,
                0,
                rect.right - rect.left,
                rect.bottom - rect.top,
                SWP_SHOWWINDOW,
            );
        }
    }

    /// HWND of the native splash ImageFrame (for z-order / UpdateWindow).
    pub fn hwnd(&self) -> Option<winapi::shared::windef::HWND> {
        self.splash.handle.hwnd()
    }
}
