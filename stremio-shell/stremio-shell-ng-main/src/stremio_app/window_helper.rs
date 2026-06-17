use std::{cmp, mem};
use winapi::ctypes::c_void;
use winapi::shared::minwindef::DWORD;
use winapi::shared::windef::HWND;
use winapi::um::dwmapi::DwmSetWindowAttribute;
use winapi::um::winuser::{
    GetForegroundWindow, GetMonitorInfoA, GetSystemMetrics, GetWindowLongA, GetWindowRect,
    IsIconic, IsZoomed, MonitorFromWindow, SetForegroundWindow, SetWindowLongA, SetWindowPlacement,
    SetWindowPos, GWL_EXSTYLE, GWL_STYLE, HWND_NOTOPMOST, HWND_TOPMOST, MONITORINFO,
    MONITOR_DEFAULTTONEAREST, SM_CXSCREEN, SM_CYSCREEN, SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE,
    WINDOWPLACEMENT, WS_CAPTION, WS_EX_CLIENTEDGE, WS_EX_DLGMODALFRAME, WS_EX_STATICEDGE,
    WS_EX_TOPMOST, WS_EX_WINDOWEDGE, WS_THICKFRAME,
};

const DWMWA_CAPTION_COLOR: DWORD = 35;
const DWMWA_TEXT_COLOR: DWORD = 36;
const DWMWA_BORDER_COLOR: DWORD = 34;
const STREMIO_CAPTION_COLOR: DWORD = colorref(20, 20, 20);
const WHITE_TEXT_COLOR: DWORD = colorref(0xff, 0xff, 0xff);

const fn colorref(red: DWORD, green: DWORD, blue: DWORD) -> DWORD {
    red | (green << 8) | (blue << 16)
}

// https://doc.qt.io/qt-5/qt.html#WindowState-enum
bitflags! {
    struct WindowState: u8 {
        const MINIMIZED = 0x01;
        const MAXIMIZED = 0x02;
        const FULL_SCREEN = 0x04;
        const ACTIVE = 0x08;
    }
}

#[derive(Default, Clone)]
pub struct WindowStyle {
    pub full_screen: bool,
    pub pip_mode: bool,
    pub pip_restore_pos: (i32, i32),
    pub pip_restore_size: (i32, i32),
    pub pos: (i32, i32),
    pub size: (i32, i32),
    pub style: i32,
    pub ex_style: i32,
}

impl WindowStyle {
    pub fn get_window_state(self, hwnd: HWND) -> u32 {
        let mut state: WindowState = WindowState::empty();
        if 0 != unsafe { IsIconic(hwnd) } {
            state |= WindowState::MINIMIZED;
        }
        if 0 != unsafe { IsZoomed(hwnd) } {
            state |= WindowState::MAXIMIZED;
        }
        if hwnd == unsafe { GetForegroundWindow() } {
            state |= WindowState::ACTIVE
        }
        if self.full_screen {
            state |= WindowState::FULL_SCREEN;
        }
        state.bits() as u32
    }
    pub fn is_window_minimized(&self, hwnd: HWND) -> bool {
        0 != unsafe { IsIconic(hwnd) }
    }
    pub fn show_window_at(&self, hwnd: HWND, pos: HWND) {
        unsafe {
            SetWindowPos(
                hwnd,
                pos,
                self.pos.0,
                self.pos.1,
                self.size.0,
                self.size.1,
                SWP_FRAMECHANGED,
            );
        }
    }
    pub fn center_window(&mut self, hwnd: HWND, min_width: i32, min_height: i32) {
        let monitor_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
        let monitor_h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
        let small_side = cmp::min(monitor_w, monitor_h) * 70 / 100;
        self.size = (
            cmp::max(small_side * 16 / 9, min_width),
            cmp::max(small_side, min_height),
        );
        self.pos = ((monitor_w - self.size.0) / 2, (monitor_h - self.size.1) / 2);
        self.show_window_at(hwnd, HWND_NOTOPMOST);
    }
    pub fn restore_window_placement(&mut self, hwnd: HWND, placement: WINDOWPLACEMENT) {
        self.pos = (
            placement.rcNormalPosition.left,
            placement.rcNormalPosition.top,
        );
        self.size = (
            placement.rcNormalPosition.right - placement.rcNormalPosition.left,
            placement.rcNormalPosition.bottom - placement.rcNormalPosition.top,
        );
        unsafe {
            SetWindowPlacement(hwnd, &placement);
        }
    }
    pub fn set_title_bar_color(&self, hwnd: HWND) {
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_BORDER_COLOR,
                &STREMIO_CAPTION_COLOR as *const _ as *const c_void,
                mem::size_of_val(&STREMIO_CAPTION_COLOR) as DWORD,
            );
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_CAPTION_COLOR,
                &STREMIO_CAPTION_COLOR as *const _ as *const c_void,
                mem::size_of_val(&STREMIO_CAPTION_COLOR) as DWORD,
            );
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_TEXT_COLOR,
                &WHITE_TEXT_COLOR as *const _ as *const c_void,
                mem::size_of_val(&WHITE_TEXT_COLOR) as DWORD,
            );
        }
    }
    pub fn set_full_screen(&mut self, hwnd: HWND, full_screen: bool) {
        let current_style = unsafe { GetWindowLongA(hwnd, GWL_STYLE) };
        let current_ex_style = unsafe { GetWindowLongA(hwnd, GWL_EXSTYLE) };
        let has_caption = (current_style as u32 & WS_CAPTION) == WS_CAPTION;
        let has_frame = (current_style as u32 & WS_THICKFRAME) == WS_THICKFRAME;
        let currently_fullscreen = !has_caption && !has_frame;

        if !full_screen {
            if self.style == 0 {
                self.style = current_style | WS_CAPTION as i32 | WS_THICKFRAME as i32;
            }
            if self.ex_style == 0 {
                self.ex_style = current_ex_style;
            }
            let topmost = if self.ex_style as u32 & WS_EX_TOPMOST == WS_EX_TOPMOST {
                HWND_TOPMOST
            } else {
                HWND_NOTOPMOST
            };
            unsafe {
                SetWindowLongA(hwnd, GWL_STYLE, self.style);
                SetWindowLongA(hwnd, GWL_EXSTYLE, self.ex_style);
            }
            self.show_window_at(hwnd, topmost);
            self.full_screen = false;
        } else {
            if self.full_screen && currently_fullscreen {
                return;
            }
            unsafe {
                let mut rect = mem::zeroed();
                GetWindowRect(hwnd, &mut rect);
                self.pos = (rect.left, rect.top);
                self.size = ((rect.right - rect.left), (rect.bottom - rect.top));
                self.style = GetWindowLongA(hwnd, GWL_STYLE);
                self.ex_style = GetWindowLongA(hwnd, GWL_EXSTYLE);

                let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                let mut monitor_info: MONITORINFO = mem::zeroed();
                monitor_info.cbSize = mem::size_of_val(&monitor_info) as u32;
                if GetMonitorInfoA(monitor, &mut monitor_info) == 0 {
                    println!("GetMonitorInfoA failed");
                    return;
                }
                SetWindowLongA(
                    hwnd,
                    GWL_STYLE,
                    self.style & !(WS_CAPTION as i32 | WS_THICKFRAME as i32),
                );
                SetWindowLongA(
                    hwnd,
                    GWL_EXSTYLE,
                    self.ex_style
                        & !(WS_EX_DLGMODALFRAME as i32
                            | WS_EX_WINDOWEDGE as i32
                            | WS_EX_CLIENTEDGE as i32
                            | WS_EX_STATICEDGE as i32),
                );
                SetWindowPos(
                    hwnd,
                    HWND_NOTOPMOST,
                    monitor_info.rcMonitor.left,
                    monitor_info.rcMonitor.top,
                    monitor_info.rcMonitor.right - monitor_info.rcMonitor.left,
                    monitor_info.rcMonitor.bottom - monitor_info.rcMonitor.top,
                    SWP_FRAMECHANGED,
                );
            }
            self.full_screen = true;
        }
    }
    pub fn toggle_topmost(&mut self, hwnd: HWND) {
        let topmost = if unsafe { GetWindowLongA(hwnd, GWL_EXSTYLE) } as u32 & WS_EX_TOPMOST
            == WS_EX_TOPMOST
        {
            HWND_NOTOPMOST
        } else {
            HWND_TOPMOST
        };
        unsafe {
            SetWindowPos(
                hwnd,
                topmost,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED,
            );
        }
        self.ex_style = unsafe { GetWindowLongA(hwnd, GWL_EXSTYLE) };
    }
    pub fn toggle_pip_mode(&mut self, hwnd: HWND) -> bool {
        if !self.pip_mode {
            unsafe {
                let mut rect = mem::zeroed();
                GetWindowRect(hwnd, &mut rect);
                self.pip_restore_pos = (rect.left, rect.top);
                self.pip_restore_size = (rect.right - rect.left, rect.bottom - rect.top);
            }
            self.pip_mode = true;
            let target_x = self.pip_restore_pos.0 + (self.pip_restore_size.0 - 400).max(0);
            let target_y = self.pip_restore_pos.1 + 48;
            self.pos = (target_x, target_y);
            self.size = (400, 225);
            self.show_window_at(hwnd, HWND_TOPMOST);
            return true;
        }

        self.pip_mode = false;
        self.pos = self.pip_restore_pos;
        self.size = self.pip_restore_size;
        self.show_window_at(hwnd, HWND_NOTOPMOST);
        false
    }
    pub fn set_active(&mut self, hwnd: HWND) {
        unsafe {
            SetForegroundWindow(hwnd);
        }
    }
}
