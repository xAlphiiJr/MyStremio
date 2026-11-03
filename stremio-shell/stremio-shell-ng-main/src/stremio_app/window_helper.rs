use std::{cmp, mem};
use winapi::ctypes::c_void;
use winapi::shared::minwindef::DWORD;
use winapi::shared::windef::{HWND, RECT};
use winapi::um::dwmapi::DwmSetWindowAttribute;
use winapi::um::wingdi::CreateSolidBrush;
use winapi::um::winuser::{
    GetForegroundWindow, GetMonitorInfoA, GetSystemMetrics, GetWindowLongA, GetWindowPlacement,
    GetWindowRect, InvalidateRect, IsIconic, IsZoomed, MonitorFromWindow, RedrawWindow,
    SendMessageW, SetClassLongPtrW, SetForegroundWindow, SetWindowLongA, SetWindowPlacement,
    SetWindowPos, ShowWindow, UpdateWindow, GCLP_HBRBACKGROUND, GWL_EXSTYLE, GWL_STYLE,
    HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST, MONITORINFO, MONITOR_DEFAULTTONEAREST, RDW_ALLCHILDREN,
    RDW_ERASE, RDW_FRAME, RDW_INVALIDATE, RDW_UPDATENOW, SM_CXSCREEN, SM_CYSCREEN,
    SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOREDRAW, SWP_NOSIZE, SWP_NOZORDER,
    SWP_SHOWWINDOW, SW_HIDE, SW_MINIMIZE, SW_RESTORE, SW_SHOWMAXIMIZED, SW_SHOWNORMAL,
    WINDOWPLACEMENT, WM_SETREDRAW, WS_CAPTION, WS_EX_CLIENTEDGE, WS_EX_DLGMODALFRAME,
    WS_EX_STATICEDGE, WS_EX_TOPMOST, WS_EX_WINDOWEDGE, WS_MAXIMIZE, WS_OVERLAPPEDWINDOW,
    WS_THICKFRAME, WS_VISIBLE,
};

/// SetWindowPos during a chrome transition — FRAMECHANGED without painting yet.
const SWP_CHROME: u32 = (SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_NOREDRAW) as u32;

/// Same chrome bits stock stremio-shell-ng clears for fullscreen (proven on Windows).
const STOCK_CHROME_STYLE_BITS: i32 = (WS_CAPTION | WS_THICKFRAME) as i32;
/// Pixel slack when comparing window outer rect to monitor bounds.
const MONITOR_COVER_TOLERANCE_PX: i32 = 4;
/// Extended styles that draw a visible window edge around the client area.
const CHROME_EXSTYLE_BITS: i32 =
    (WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE) as i32;

/// Win10/11 dark NC + Win11 caption/border colors (never COLOR_NONE).
const DWMWA_USE_IMMERSIVE_DARK_MODE: DWORD = 20;
const DWMWA_WINDOW_CORNER_PREFERENCE: DWORD = 33;
const DWMWA_BORDER_COLOR: DWORD = 34;
const DWMWA_CAPTION_COLOR: DWORD = 35;
const DWMWA_TEXT_COLOR: DWORD = 36;
const DWMWCP_DONOTROUND: DWORD = 1;
const PIP_WIDTH: i32 = 480;
const PIP_HEIGHT: i32 = 270;
const PIP_MARGIN: i32 = 16;
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

/**
 * Native window chrome mode.
 *
 * - `Framed`: normal caption + resize frame
 * - `Borderless`: player session without chrome (windowed size kept)
 * - `Fullscreen`: monitor-covering, no `WS_OVERLAPPEDWINDOW` chrome
 */
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WindowMode {
    #[default]
    Framed,
    Borderless,
    Fullscreen,
}

#[derive(Clone)]
pub struct WindowStyle {
    pub mode: WindowMode,
    /// Compatibility mirror of `mode == Fullscreen` for existing callers.
    pub full_screen: bool,
    /// Player-session preference: after leaving fullscreen, return to Borderless.
    pub borderless: bool,
    /// Window was maximized when player borderless started — restore that on leave.
    was_maximized_before_borderless: bool,
    pub pos: (i32, i32),
    pub size: (i32, i32),
    /// Last known framed (overlapped) styles for restore.
    pub style: i32,
    pub ex_style: i32,
    /// Placement captured when entering fullscreen (Raymond Chen pattern).
    fs_placement: WINDOWPLACEMENT,
    has_fs_placement: bool,
}

impl Default for WindowStyle {
    fn default() -> Self {
        Self {
            mode: WindowMode::Framed,
            full_screen: false,
            borderless: false,
            was_maximized_before_borderless: false,
            pos: (0, 0),
            size: (0, 0),
            style: 0,
            ex_style: 0,
            fs_placement: unsafe { mem::zeroed() },
            has_fs_placement: false,
        }
    }
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

    /// Minimize the shell window (in-app chrome replacement while borderless).
    pub fn minimize_window(&self, hwnd: HWND) {
        unsafe {
            ShowWindow(hwnd, SW_MINIMIZE);
        }
    }

    /// Toggle maximize/restore without going through OS caption buttons.
    pub fn toggle_maximize_window(&self, hwnd: HWND) {
        unsafe {
            if IsZoomed(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            } else {
                ShowWindow(hwnd, SW_SHOWMAXIMIZED);
            }
        }
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

    /**
     * Apply saved geometry without showing the window (Zaarrg-style: never present
     * a white client before the native splash has painted).
     *
     * @returns Intended showCmd (`SW_SHOWNORMAL` / `SW_SHOWMAXIMIZED`) for the later reveal.
     */
    pub fn restore_window_placement_hidden(
        &mut self,
        hwnd: HWND,
        mut placement: WINDOWPLACEMENT,
    ) -> u32 {
        let intended_show = if placement.showCmd == SW_SHOWMAXIMIZED as u32 {
            SW_SHOWMAXIMIZED as u32
        } else {
            SW_SHOWNORMAL as u32
        };
        self.pos = (
            placement.rcNormalPosition.left,
            placement.rcNormalPosition.top,
        );
        self.size = (
            placement.rcNormalPosition.right - placement.rcNormalPosition.left,
            placement.rcNormalPosition.bottom - placement.rcNormalPosition.top,
        );
        placement.showCmd = SW_HIDE as u32;
        unsafe {
            SetWindowPlacement(hwnd, &placement);
        }
        intended_show
    }

    /**
     * Paint the Win32 window background dark so gaps around WebView2 never flash white.
     *
     * @param hwnd Target window.
     */
    pub fn set_dark_window_background(&self, hwnd: HWND) {
        unsafe {
            let brush = CreateSolidBrush(STREMIO_CAPTION_COLOR);
            if !brush.is_null() {
                SetClassLongPtrW(hwnd, GCLP_HBRBACKGROUND, brush as isize);
            }
            InvalidateRect(hwnd, std::ptr::null(), 1);
        }
    }

    /**
     * End a chrome/FS transition: unlock paint after the caller has fitted WebView2.
     * Must pair every successful `set_full_screen` / `set_borderless` that returned true.
     */
    pub fn finish_chrome_transition(hwnd: HWND) {
        unsafe {
            SendMessageW(hwnd, WM_SETREDRAW, 1, 0);
            RedrawWindow(
                hwnd,
                std::ptr::null(),
                std::ptr::null_mut(),
                RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN | RDW_UPDATENOW,
            );
        }
    }

    /**
     * Force a synchronous paint of the host client (dark brush) before first show.
     *
     * @param hwnd Target window.
     */
    pub fn update_window_now(&self, hwnd: HWND) {
        unsafe {
            InvalidateRect(hwnd, std::ptr::null(), 1);
            UpdateWindow(hwnd);
        }
    }

    /**
     * Raise a child HWND above siblings (splash over empty client).
     *
     * @param child Splash or other covering control.
     */
    pub fn bring_child_to_top(&self, child: HWND) {
        if child.is_null() {
            return;
        }
        unsafe {
            SetWindowPos(
                child,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            );
            InvalidateRect(child, std::ptr::null(), 1);
            UpdateWindow(child);
        }
    }

    /**
     * Reveal the main window after splash is ready (geometry already applied hidden).
     *
     * @param hwnd Target window.
     * @param show_cmd `SW_SHOWNORMAL` or `SW_SHOWMAXIMIZED`.
     */
    pub fn show_window_after_splash(&self, hwnd: HWND, show_cmd: u32) {
        unsafe {
            let cmd = if show_cmd == SW_SHOWMAXIMIZED as u32 {
                SW_SHOWMAXIMIZED
            } else {
                SW_SHOWNORMAL
            };
            ShowWindow(hwnd, cmd);
            UpdateWindow(hwnd);
        }
    }

    /// Force Win11-style dark caption (keeps min/max/close). Call before and after
    /// any style change that repaints the non-client area.
    pub fn set_title_bar_color(&self, hwnd: HWND) {
        let dark: i32 = 1;
        let corner = DWMWCP_DONOTROUND;
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                &dark as *const _ as *const c_void,
                mem::size_of_val(&dark) as DWORD,
            );
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
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &corner as *const _ as *const c_void,
                mem::size_of_val(&corner) as DWORD,
            );
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED,
            );
        }
    }

    fn hwnd_has_caption(hwnd: HWND) -> bool {
        let style = unsafe { GetWindowLongA(hwnd, GWL_STYLE) } as u32;
        (style & WS_CAPTION) == WS_CAPTION
    }

    /**
     * Work area (`rcWork`) of the monitor nearest to `hwnd`.
     *
     * @returns `None` if `GetMonitorInfoA` fails.
     */
    fn monitor_work_area(hwnd: HWND) -> Option<RECT> {
        unsafe {
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut info: MONITORINFO = mem::zeroed();
            info.cbSize = mem::size_of_val(&info) as u32;
            if GetMonitorInfoA(monitor, &mut info) == 0 {
                return None;
            }
            Some(info.rcWork)
        }
    }

    /**
     * Full monitor rect (`rcMonitor`) nearest to `hwnd`.
     *
     * @returns `None` if `GetMonitorInfoA` fails.
     */
    fn monitor_full_area(hwnd: HWND) -> Option<RECT> {
        unsafe {
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut info: MONITORINFO = mem::zeroed();
            info.cbSize = mem::size_of_val(&info) as u32;
            if GetMonitorInfoA(monitor, &mut info) == 0 {
                return None;
            }
            Some(info.rcMonitor)
        }
    }

    /**
     * Clamp an outer window rect so it stays inside the monitor work area.
     * Prevents Win10/11 maximized-overhang from becoming visible after chrome strip.
     *
     * @param hwnd Window used to pick the monitor.
     * @param outer Desired outer rect before clamp.
     * @returns Clamped rect (or `outer` if monitor info is unavailable).
     */
    fn clamp_rect_to_work_area(hwnd: HWND, outer: RECT) -> RECT {
        let Some(work) = Self::monitor_work_area(hwnd) else {
            return outer;
        };
        let mut w = cmp::max(1, outer.right - outer.left);
        let mut h = cmp::max(1, outer.bottom - outer.top);
        let work_w = cmp::max(1, work.right - work.left);
        let work_h = cmp::max(1, work.bottom - work.top);
        w = cmp::min(w, work_w);
        h = cmp::min(h, work_h);
        let mut left = outer.left;
        let mut top = outer.top;
        if left < work.left {
            left = work.left;
        }
        if top < work.top {
            top = work.top;
        }
        if left + w > work.right {
            left = work.right - w;
        }
        if top + h > work.bottom {
            top = work.bottom - h;
        }
        RECT {
            left,
            top,
            right: left + w,
            bottom: top + h,
        }
    }

    /**
     * Whether the window outer rect already covers the full monitor (fullscreen geometry).
     */
    fn hwnd_covers_monitor(hwnd: HWND) -> bool {
        let Some(monitor) = Self::monitor_full_area(hwnd) else {
            return false;
        };
        let mut outer = unsafe { mem::zeroed() };
        if unsafe { GetWindowRect(hwnd, &mut outer) } == 0 {
            return false;
        }
        let tol = MONITOR_COVER_TOLERANCE_PX;
        (outer.left - monitor.left).abs() <= tol
            && (outer.top - monitor.top).abs() <= tol
            && (outer.right - monitor.right).abs() <= tol
            && (outer.bottom - monitor.bottom).abs() <= tol
    }

    /**
     * True if Win32-maximized or the outer rect already fills the monitor work area.
     */
    fn hwnd_is_maximized_or_fills_work(hwnd: HWND) -> bool {
        if unsafe { IsZoomed(hwnd) } != 0 {
            return true;
        }
        let Some(work) = Self::monitor_work_area(hwnd) else {
            return false;
        };
        let mut outer = unsafe { mem::zeroed() };
        if unsafe { GetWindowRect(hwnd, &mut outer) } == 0 {
            return false;
        }
        let tol = MONITOR_COVER_TOLERANCE_PX;
        (outer.left - work.left).abs() <= tol
            && (outer.top - work.top).abs() <= tol
            && (outer.right - work.right).abs() <= tol
            && (outer.bottom - work.bottom).abs() <= tol
    }

    /**
     * Latch session maximize intent. Never clears — only stream-end restore clears it.
     *
     * Re-applying borderless after `SW_RESTORE` must not wipe this flag (that bug made
     * fullscreen exit restore the small pre-maximize WINDOWPLACEMENT rect).
     */
    fn latch_maximized_session_state(&mut self, hwnd: HWND) {
        if Self::hwnd_is_maximized_or_fills_work(hwnd) {
            self.was_maximized_before_borderless = true;
        }
    }

    /**
     * Restore the pre-player maximized footprint.
     *
     * Borderless cannot use `SW_SHOWMAXIMIZED` (caption buttons stick on Win11),
     * so fill `rcWork` instead. Framed uses real maximize.
     */
    fn restore_maximized_footprint(&self, hwnd: HWND, borderless: bool) {
        if borderless {
            if let Some(work) = Self::monitor_work_area(hwnd) {
                unsafe {
                    SetWindowPos(
                        hwnd,
                        HWND_NOTOPMOST,
                        work.left,
                        work.top,
                        work.right - work.left,
                        work.bottom - work.top,
                        SWP_CHROME,
                    );
                }
            }
        } else {
            unsafe {
                ShowWindow(hwnd, SW_SHOWMAXIMIZED);
            }
        }
    }

    fn capture_framed_styles_if_needed(&mut self, hwnd: HWND) {
        let current_style = unsafe { GetWindowLongA(hwnd, GWL_STYLE) };
        let current_ex_style = unsafe { GetWindowLongA(hwnd, GWL_EXSTYLE) };
        if Self::hwnd_has_caption(hwnd) || self.style == 0 {
            self.style = if Self::hwnd_has_caption(hwnd) {
                current_style
            } else {
                current_style | WS_OVERLAPPEDWINDOW as i32
            };
            // Never persist maximized into the restore style.
            self.style &= !(WS_MAXIMIZE as i32);
            self.ex_style = current_ex_style;
        }
    }

    /**
     * Strip caption/thickframe like stock shell-ng while keeping the visible footprint.
     *
     * If maximized, size to the monitor work area without a framed `SW_RESTORE`
     * intermediate (that flash looked like a classic Windows title bar). Redraw is
     * locked around the style change so non-client chrome never paints mid-transition.
     */
    fn apply_borderless_styles(&self, hwnd: HWND) {
        self.set_dark_window_background(hwnd);
        let mut outer = unsafe { mem::zeroed() };
        unsafe {
            GetWindowRect(hwnd, &mut outer);
        }
        let was_zoomed = unsafe { IsZoomed(hwnd) } != 0;
        if was_zoomed {
            // Maximized outer rect extends past the visible monitor; use work area instead.
            if let Some(work) = Self::monitor_work_area(hwnd) {
                outer = work;
            }
        } else {
            outer = Self::clamp_rect_to_work_area(hwnd, outer);
        }

        let current = unsafe { GetWindowLongA(hwnd, GWL_STYLE) };
        let base = if self.style != 0 { self.style } else { current };
        let next_style =
            (base & !STOCK_CHROME_STYLE_BITS & !(WS_MAXIMIZE as i32)) | WS_VISIBLE as i32;
        let next_ex = if self.ex_style != 0 {
            self.ex_style & !CHROME_EXSTYLE_BITS
        } else {
            (unsafe { GetWindowLongA(hwnd, GWL_EXSTYLE) }) & !CHROME_EXSTYLE_BITS
        };

        unsafe {
            SendMessageW(hwnd, WM_SETREDRAW, 0, 0);
            // Strip chrome before any size change — never ShowWindow(SW_RESTORE) while framed.
            SetWindowLongA(hwnd, GWL_STYLE, next_style);
            SetWindowLongA(hwnd, GWL_EXSTYLE, next_ex);
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                outer.left,
                outer.top,
                outer.right - outer.left,
                outer.bottom - outer.top,
                SWP_CHROME,
            );
        }
        self.set_title_bar_color(hwnd);
        // Caller fits WebView2, then `finish_chrome_transition`.
    }

    fn apply_framed_styles(&self, hwnd: HWND) {
        self.set_dark_window_background(hwnd);
        // DWM colors before caption bits — otherwise one legacy Aero NC paint sticks.
        self.set_title_bar_color(hwnd);
        let style = if self.style != 0 {
            (self.style | WS_OVERLAPPEDWINDOW as i32 | WS_VISIBLE as i32) & !(WS_MAXIMIZE as i32)
        } else {
            ((unsafe { GetWindowLongA(hwnd, GWL_STYLE) })
                | WS_OVERLAPPEDWINDOW as i32
                | WS_VISIBLE as i32)
                & !(WS_MAXIMIZE as i32)
        };
        let ex_style = if self.ex_style != 0 {
            self.ex_style
        } else {
            unsafe { GetWindowLongA(hwnd, GWL_EXSTYLE) }
        };
        unsafe {
            SendMessageW(hwnd, WM_SETREDRAW, 0, 0);
            SetWindowLongA(hwnd, GWL_STYLE, style);
            SetWindowLongA(hwnd, GWL_EXSTYLE, ex_style);
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_CHROME | SWP_NOMOVE | SWP_NOSIZE,
            );
        }
        self.set_title_bar_color(hwnd);
        // Caller fits WebView2, then `finish_chrome_transition`.
    }

    fn sync_mode_flags(&mut self) {
        self.full_screen = self.mode == WindowMode::Fullscreen;
    }

    /**
     * Strip or restore window caption/frame without changing position or size.
     *
     * Used for player sessions so MPV video never shows through framed chrome.
     * When fullscreen is active, only the preference is updated; exit-fullscreen
     * restores Borderless if the preference is still set.
     *
     * @returns `true` when paint is locked — caller must fit WebView2 then
     *          `finish_chrome_transition`.
     */
    pub fn set_borderless(&mut self, hwnd: HWND, enabled: bool) -> bool {
        self.borderless = enabled;

        if self.mode == WindowMode::Fullscreen {
            // Preference only; chrome stays off until fullscreen exits.
            // Still latch maximize if the user was filling the work area.
            self.latch_maximized_session_state(hwnd);
            return false;
        }

        if enabled {
            // Latch BEFORE any SW_RESTORE — and never clear on re-apply.
            self.latch_maximized_session_state(hwnd);
            // Re-apply when caption is still visible (e.g. maximized left DWM buttons).
            if self.mode == WindowMode::Borderless && !Self::hwnd_has_caption(hwnd) {
                if self.was_maximized_before_borderless {
                    self.restore_maximized_footprint(hwnd, true);
                }
                self.sync_mode_flags();
                return false;
            }
            self.capture_framed_styles_if_needed(hwnd);
            self.apply_borderless_styles(hwnd);
            if self.was_maximized_before_borderless {
                self.restore_maximized_footprint(hwnd, true);
            }
            self.mode = WindowMode::Borderless;
            self.sync_mode_flags();
            return true;
        }

        // Already framed: still re-assert modern caption (MPV/stream start can reset NC theme).
        if self.mode == WindowMode::Framed && Self::hwnd_has_caption(hwnd) {
            self.set_title_bar_color(hwnd);
            if self.was_maximized_before_borderless {
                self.restore_maximized_footprint(hwnd, false);
                self.was_maximized_before_borderless = false;
            }
            self.sync_mode_flags();
            return false;
        }
        self.capture_framed_styles_if_needed(hwnd);
        self.apply_framed_styles(hwnd);
        if self.was_maximized_before_borderless {
            self.restore_maximized_footprint(hwnd, false);
            self.was_maximized_before_borderless = false;
        }
        self.mode = WindowMode::Framed;
        self.sync_mode_flags();
        true
    }

    /**
     * Fullscreen exactly as stock stremio-shell-ng: save/restore style bits, no DWM
     * border tricks, no placement reconstruction. That overengineering caused the Win7 frame.
     *
     * @returns `true` when geometry changed — caller should fit WebView2.
     */
    pub fn set_full_screen(&mut self, hwnd: HWND, full_screen: bool) -> bool {
        if self.full_screen == full_screen {
            return false;
        }

        if !full_screen {
            let topmost = if self.ex_style as u32 & WS_EX_TOPMOST == WS_EX_TOPMOST {
                HWND_TOPMOST
            } else {
                HWND_NOTOPMOST
            };
            // Lock paint: set Win11 caption colors, then restore caption+controls together.
            self.set_title_bar_color(hwnd);
            unsafe {
                SendMessageW(hwnd, WM_SETREDRAW, 0, 0);
                SetWindowLongA(hwnd, GWL_STYLE, self.style);
                SetWindowLongA(hwnd, GWL_EXSTYLE, self.ex_style);
            }
            self.show_window_at(hwnd, topmost);
            self.set_title_bar_color(hwnd);
            unsafe {
                SendMessageW(hwnd, WM_SETREDRAW, 1, 0);
                RedrawWindow(
                    hwnd,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN | RDW_UPDATENOW,
                );
            }
            self.full_screen = false;
            self.mode = WindowMode::Framed;
            self.borderless = false;
            return true;
        }

        self.set_dark_window_background(hwnd);
        unsafe {
            let mut rect = mem::zeroed();
            GetWindowRect(hwnd, &mut rect);
            self.pos = (rect.left, rect.top);
            self.size = (rect.right - rect.left, rect.bottom - rect.top);
            self.style = GetWindowLongA(hwnd, GWL_STYLE);
            self.ex_style = GetWindowLongA(hwnd, GWL_EXSTYLE);

            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut monitor_info: MONITORINFO = mem::zeroed();
            monitor_info.cbSize = mem::size_of_val(&monitor_info) as u32;
            if GetMonitorInfoA(monitor, &mut monitor_info) == 0 {
                eprintln!("GetMonitorInfoA failed");
                return false;
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
        self.mode = WindowMode::Fullscreen;
        true
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

    pub fn set_active(&mut self, hwnd: HWND) {
        unsafe {
            SetForegroundWindow(hwnd);
        }
    }
}

pub(crate) fn work_area(hwnd: HWND) -> Option<(i32, i32, i32, i32)> {
    WindowStyle::monitor_work_area(hwnd)
        .map(|work| (work.left, work.top, work.right - work.left, work.bottom - work.top))
}

/// Outer size and bottom-right origin of the PiP window, in physical pixels.
pub fn pip_placement(hwnd: HWND) -> (i32, i32, i32, i32) {
    let (x, y) = match WindowStyle::monitor_work_area(hwnd) {
        Some(work) => pip_origin(work.left, work.top, work.right, work.bottom),
        None => (PIP_MARGIN, PIP_MARGIN),
    };
    (x, y, PIP_WIDTH, PIP_HEIGHT)
}

fn pip_origin(work_left: i32, work_top: i32, work_right: i32, work_bottom: i32) -> (i32, i32) {
    (
        (work_right - PIP_WIDTH - PIP_MARGIN).max(work_left),
        (work_bottom - PIP_HEIGHT - PIP_MARGIN).max(work_top),
    )
}

#[cfg(test)]
mod tests {
    use super::pip_origin;

    #[test]
    fn pip_sits_in_the_bottom_right_of_the_work_area() {
        assert_eq!(pip_origin(0, 0, 1920, 1080), (1424, 794));
        assert_eq!(pip_origin(10, 20, 100, 80), (10, 20));
    }
}
