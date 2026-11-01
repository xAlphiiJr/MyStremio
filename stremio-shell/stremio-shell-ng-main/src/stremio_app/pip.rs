use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use libmpv2::Mpv;
use native_windows_gui as nwg;
use winapi::shared::windef::{HWND, POINT, SIZE};
use winapi::um::wingdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, AC_SRC_ALPHA,
    AC_SRC_OVER, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION, DIB_RGB_COLORS,
};
use winapi::um::winuser::{
    GetAsyncKeyState, GetClientRect, GetCursorPos, GetDC, GetWindow, GetWindowRect, IsIconic,
    IsWindowVisible, KillTimer, LoadCursorW, ReleaseDC, SetCursor, SetTimer, SetWindowPos,
    ShowWindow, UpdateLayeredWindow, GW_CHILD, GW_HWNDNEXT, HWND_TOPMOST, IDC_SIZENESW,
    IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
    SW_HIDE, SW_MINIMIZE, ULW_ALPHA, VK_LBUTTON, WM_CLOSE, WM_LBUTTONDOWN, WM_MOUSEACTIVATE,
    WM_TIMER, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, MA_NOACTIVATE,
};

use crate::stremio_app::{
    constants::APP_NAME,
    stremio_player::player::retarget_window,
    window_helper::{pip_placement, work_area},
};

const TOP_W: i32 = 126;
const TOP_H: i32 = 40;
const SEEK_H: i32 = 24;
const VOL_W: i32 = 36;
const SPEAKER: i32 = 20;
const SPEAKER_OY: i32 = 2;
const SPEAKER_MID: i32 = 7;
const MARGIN: i32 = 14;
const EDGE: i32 = 8;
const MIN_W: i32 = 320;
const MIN_H: i32 = 180;
const VOL_MAX: f64 = 200.0;
const VIDEO_HOOK: usize = 0x50_4950_01;
const TOOLS_HOOK: usize = 0x50_4950_02;
const BAR_HOOK: usize = 0x50_4950_03;
const VOL_HOOK: usize = 0x50_4950_04;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Slide {
    Seek,
    Volume,
}

#[derive(Clone, Copy, Debug)]
enum BarHit {
    Seek(f64),
    Volume(f64),
}

impl BarHit {
    fn slide(self) -> Slide {
        match self {
            BarHit::Seek(_) => Slide::Seek,
            BarHit::Volume(_) => Slide::Volume,
        }
    }
}

struct Live {
    drag: bool,
    grab: (i32, i32),
    origin: (i32, i32),
    maximized: bool,
    restore: (i32, i32, i32, i32),
    hold_until: Instant,
    seek: f64,
    volume: f64,
    sliding: Option<Slide>,
    resize: u8,
    resize_origin: (i32, i32, i32, i32),
    aspect: f64,
}

#[allow(dead_code)]
pub(crate) struct Session {
    video: nwg::Window,
    tools: nwg::Window,
    bar: nwg::Window,
    vol: nwg::Window,
    video_handler: nwg::RawEventHandler,
    tools_handler: nwg::RawEventHandler,
    bar_handler: nwg::RawEventHandler,
    vol_handler: nwg::RawEventHandler,
}

impl Session {
    pub(crate) fn disarm(&mut self) {
        if let Some(hwnd) = self.video.handle.hwnd() {
            unsafe { KillTimer(hwnd, 1) };
        }
        let _ = nwg::unbind_raw_event_handler(&self.video_handler);
        let _ = nwg::unbind_raw_event_handler(&self.tools_handler);
        let _ = nwg::unbind_raw_event_handler(&self.bar_handler);
        let _ = nwg::unbind_raw_event_handler(&self.vol_handler);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.disarm();
    }
}

pub(crate) fn open(main: HWND, mpv: Arc<Mpv>, close_notice: nwg::NoticeSender) -> Option<Session> {
    let (x, y, w, h) = pip_placement(main);
    let mut video = nwg::Window::default();
    nwg::Window::builder()
        .flags(nwg::WindowFlags::POPUP | nwg::WindowFlags::VISIBLE)
        .ex_flags(WS_EX_APPWINDOW)
        .size((w, h))
        .position((0, 0))
        .title(APP_NAME)
        .topmost(true)
        .build(&mut video)
        .ok()?;
    let video_hwnd = video.handle.hwnd()?;
    unsafe { SetWindowPos(video_hwnd, HWND_TOPMOST, x, y, w, h, SWP_SHOWWINDOW) };

    let mut tools = nwg::Window::default();
    let mut bar = nwg::Window::default();
    let mut vol = nwg::Window::default();
    chrome_window(&mut tools)?;
    chrome_window(&mut bar)?;
    chrome_window(&mut vol)?;
    let tools_hwnd = tools.handle.hwnd()?;
    let bar_hwnd = bar.handle.hwnd()?;
    let vol_hwnd = vol.handle.hwnd()?;
    if !retarget_window(&mpv, video_hwnd) {
        return None;
    }

    let live = Arc::new(Mutex::new(Live {
        drag: false,
        grab: (0, 0),
        origin: (x, y),
        maximized: false,
        restore: (x, y, w, h),
        hold_until: Instant::now(),
        seek: 0.0,
        volume: (volume_level(&mpv) / VOL_MAX).clamp(0.0, 1.0),
        sliding: None,
        resize: 0,
        resize_origin: (x, y, w, h),
        aspect: stream_aspect(&mpv),
    }));

    // full_bind subclasses mpv's child. Closing moves `wid`, mpv destroys that child, unbind panics.
    let video_handler = nwg::bind_raw_event_handler(&video.handle, VIDEO_HOOK, {
        let live = Arc::clone(&live);
        let mpv = Arc::clone(&mpv);
        let notice = close_notice;
        move |_hwnd, msg, w, _l| {
            if msg == WM_CLOSE {
                // Same-thread notice runs inside this wndproc and frees it.
                post_notice(notice);
                return Some(0);
            }
            if msg == WM_TIMER && w == 1 {
                tick(video_hwnd, tools_hwnd, bar_hwnd, vol_hwnd, &live, &mpv);
            }
            None
        }
    })
    .ok()?;
    let tools_handler = nwg::bind_raw_event_handler(&tools.handle, TOOLS_HOOK, {
        let live = Arc::clone(&live);
        let notice = close_notice;
        move |_hwnd, msg, _w, _l| {
            if let Some(answer) = keep_click(msg) {
                return Some(answer);
            }
            if msg == WM_LBUTTONDOWN {
                on_tool(video_hwnd, tools_hwnd, bar_hwnd, vol_hwnd, &live, notice);
            }
            None
        }
    })
    .ok()?;
    let bar_handler = nwg::bind_raw_event_handler(&bar.handle, BAR_HOOK, {
        let live = Arc::clone(&live);
        let mpv = Arc::clone(&mpv);
        move |_hwnd, msg, _w, _l| {
            if let Some(answer) = keep_click(msg) {
                return Some(answer);
            }
            if msg == WM_LBUTTONDOWN {
                on_bar(bar_hwnd, &live, &mpv);
            }
            None
        }
    })
    .ok()?;
    let vol_handler = nwg::bind_raw_event_handler(&vol.handle, VOL_HOOK, {
        let live = Arc::clone(&live);
        let mpv = Arc::clone(&mpv);
        move |_hwnd, msg, _w, _l| {
            if let Some(answer) = keep_click(msg) {
                return Some(answer);
            }
            if msg == WM_LBUTTONDOWN {
                on_vol(vol_hwnd, &live, &mpv);
            }
            None
        }
    })
    .ok()?;

    unsafe { SetTimer(video_hwnd, 1, 32, None) };
    Some(Session {
        video,
        tools,
        bar,
        vol,
        video_handler,
        tools_handler,
        bar_handler,
        vol_handler,
    })
}

fn chrome_window(window: &mut nwg::Window) -> Option<()> {
    nwg::Window::builder()
        .flags(nwg::WindowFlags::POPUP)
        .ex_flags(WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)
        .size((10, 10))
        .position((0, 0))
        .title("")
        .topmost(true)
        .build(window)
        .ok()?;
    window.handle.hwnd().map(|_| ())
}

fn post_notice(sender: nwg::NoticeSender) {
    thread::spawn(move || sender.notice());
}

fn keep_click(msg: u32) -> Option<isize> {
    // WS_EX_NOACTIVATE otherwise discards the click.
    if msg == WM_MOUSEACTIVATE {
        Some(MA_NOACTIVATE as isize)
    } else {
        None
    }
}

fn tick(video: HWND, tools: HWND, bar: HWND, vol: HWND, live: &Arc<Mutex<Live>>, mpv: &Mpv) {
    if unsafe { IsIconic(video) } != 0 {
        let mut state = live.lock().expect("pip state");
        state.drag = false;
        state.resize = 0;
        state.sliding = None;
        drop(state);
        hide(tools, bar, vol);
        return;
    }

    let cursor = cursor_pos();
    let over_tools = shown(tools) && hit(tools, cursor.x, cursor.y);
    let over_bar = shown(bar) && hit(bar, cursor.x, cursor.y);
    let over_vol = shown(vol) && hit(vol, cursor.x, cursor.y);
    let over_video = hit(video, cursor.x, cursor.y);
    let over_chrome = over_tools || over_bar || over_vol;
    let left = unsafe { GetAsyncKeyState(VK_LBUTTON) } as u16 & 0x8000 != 0;
    let rect = window_rect(video);
    let (maximized, resizing, dragging) = {
        let state = live.lock().expect("pip state");
        (state.maximized, state.resize != 0, state.drag)
    };
    let edges = if maximized { 0 } else { edge_at(rect, cursor.x, cursor.y) };
    let sliding = live.lock().expect("pip state").sliding;

    if left && sliding.is_some() {
        continue_slide(bar, vol, cursor, sliding.unwrap(), live, mpv);
    } else if left && !maximized && (resizing || (edges != 0 && !over_chrome && !dragging)) {
        resize_to(video, cursor, edges, live, mpv);
    } else if left && !maximized && ((over_video && !over_chrome && edges == 0) || dragging) {
        drag_to(video, cursor, live);
    } else if !left {
        let mut state = live.lock().expect("pip state");
        let was_resizing = state.resize != 0;
        state.drag = false;
        state.resize = 0;
        state.sliding = None;
        drop(state);
        // Once, not every tick: resizing mpv's child while it draws crashes the app.
        if was_resizing {
            fit_video_child(video);
        }
    }

    let dragging = live.lock().expect("pip state").drag;
    let resizing = live.lock().expect("pip state").resize != 0;
    if edges != 0 && !maximized {
        resize_cursor(edges);
    }
    if over_video || over_chrome || dragging || resizing {
        let mut state = live.lock().expect("pip state");
        let hold = state.hold_until > Instant::now();
        if state.sliding.is_none() && !hold {
            if let (Some(duration), Some(pos)) = (prop(mpv, "duration"), prop(mpv, "time-pos")) {
                if duration > 0.0 {
                    state.seek = (pos.max(0.0) / duration).clamp(0.0, 1.0);
                }
            }
            state.volume = (volume_level(mpv) / VOL_MAX).clamp(0.0, 1.0);
        }
        let seek = state.seek;
        let volume = state.volume;
        let maximized = state.maximized;
        drop(state);
        let hot_tool = if over_tools {
            tool_slot(local_x(tools, cursor.x), TOP_W)
        } else {
            None
        };
        paint(tools, bar, vol, video, seek, volume, maximized, over_bar, over_vol, hot_tool);
    } else {
        hide(tools, bar, vol);
    }
}

fn on_tool(video: HWND, tools: HWND, bar: HWND, vol: HWND, live: &Arc<Mutex<Live>>, notice: nwg::NoticeSender) {
    let cursor = cursor_pos();
    match tool_slot(local_x(tools, cursor.x), window_rect(tools).2) {
        Some(0) => {
            hide(tools, bar, vol);
            unsafe { ShowWindow(video, SW_MINIMIZE) };
        }
        Some(1) => toggle_max(video, live),
        Some(2) => post_notice(notice),
        _ => {}
    }
}

fn on_bar(bar: HWND, live: &Arc<Mutex<Live>>, mpv: &Mpv) {
    let width = window_rect(bar).2;
    if let Some(t) = seek_at(local_x(bar, cursor_pos().x), width) {
        apply_hit(mpv, BarHit::Seek(t), live);
    }
}

fn on_vol(vol: HWND, live: &Arc<Mutex<Live>>, mpv: &Mpv) {
    let track_h = window_rect(vol).3 - SPEAKER;
    if let Some(t) = volume_at(local_y(vol, cursor_pos().y), track_h) {
        apply_hit(mpv, BarHit::Volume(t), live);
    }
}

fn continue_slide(bar: HWND, vol: HWND, cursor: POINT, kind: Slide, live: &Arc<Mutex<Live>>, mpv: &Mpv) {
    let hit = match kind {
        Slide::Seek => seek_at(local_x(bar, cursor.x), window_rect(bar).2).map(BarHit::Seek),
        Slide::Volume => {
            volume_at(local_y(vol, cursor.y), window_rect(vol).3 - SPEAKER).map(BarHit::Volume)
        }
    };
    if let Some(hit) = hit {
        apply_hit(mpv, hit, live);
    }
}

fn apply_hit(mpv: &Mpv, hit: BarHit, live: &Arc<Mutex<Live>>) {
    {
        let mut state = live.lock().expect("pip state");
        match hit {
            BarHit::Seek(t) => state.seek = t,
            BarHit::Volume(t) => state.volume = t,
        }
        state.sliding = Some(hit.slide());
        state.hold_until = Instant::now() + Duration::from_millis(400);
    }
    match hit {
        BarHit::Seek(t) => {
            let Some(duration) = prop(mpv, "duration") else {
                return;
            };
            if duration <= 0.0 {
                return;
            }
            let seconds = duration * t;
            let text = format!("{seconds}");
            mpv.command("seek", &[&text, "absolute+exact"]).ok();
        }
        BarHit::Volume(t) => {
            mpv.set_property("volume", t * VOL_MAX).ok();
        }
    }
}

fn drag_to(video: HWND, cursor: POINT, live: &Arc<Mutex<Live>>) {
    let mut state = live.lock().expect("pip state");
    if !state.drag {
        let (x, y, _, _) = window_rect(video);
        state.drag = true;
        state.grab = (cursor.x, cursor.y);
        state.origin = (x, y);
    }
    let x = state.origin.0 + cursor.x - state.grab.0;
    let y = state.origin.1 + cursor.y - state.grab.1;
    drop(state);
    unsafe { SetWindowPos(video, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE) };
}

fn resize_to(video: HWND, cursor: POINT, edges_now: u8, live: &Arc<Mutex<Live>>, mpv: &Mpv) {
    let mut state = live.lock().expect("pip state");
    if state.resize == 0 {
        state.resize = edges_now;
        state.grab = (cursor.x, cursor.y);
        state.resize_origin = window_rect(video);
        state.drag = false;
        state.aspect = stream_aspect(mpv);
    }
    let edges = state.resize;
    let grab = state.grab;
    let origin = state.resize_origin;
    let aspect = state.aspect;
    drop(state);
    let (max_w, max_h) = work_area(video)
        .map(|(_, _, w, h)| (w.max(MIN_W), h.max(MIN_H)))
        .unwrap_or((i32::MAX, i32::MAX));
    let (x, y, w, h) = resized(origin, grab, (cursor.x, cursor.y), edges, max_w, max_h, aspect);
    unsafe { SetWindowPos(video, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE) };
}

fn stream_aspect(mpv: &Mpv) -> f64 {
    let w = mpv.get_property::<i64>("video-params/dw").ok();
    let h = mpv.get_property::<i64>("video-params/dh").ok();
    match (w, h) {
        (Some(w), Some(h)) if w > 0 && h > 0 => w as f64 / h as f64,
        // shortcut: no picture size yet, keep the 16:9 window we opened with
        _ => 16.0 / 9.0,
    }
}

fn toggle_max(video: HWND, live: &Arc<Mutex<Live>>) {
    let mut state = live.lock().expect("pip state");
    if state.maximized {
        let (x, y, w, h) = state.restore;
        state.maximized = false;
        drop(state);
        unsafe { SetWindowPos(video, HWND_TOPMOST, x, y, w, h, SWP_SHOWWINDOW) };
        fit_video_child(video);
        return;
    }
    let restore = window_rect(video);
    let Some((left, top, width, height)) = work_area(video) else {
        return;
    };
    state.restore = restore;
    state.maximized = true;
    drop(state);
    unsafe { SetWindowPos(video, HWND_TOPMOST, left, top, width, height, SWP_SHOWWINDOW) };
    fit_video_child(video);
}

fn paint(
    tools: HWND,
    bar: HWND,
    vol: HWND,
    video: HWND,
    seek: f64,
    volume: f64,
    maximized: bool,
    seek_hot: bool,
    vol_hot: bool,
    hot_tool: Option<i32>,
) {
    let (vx, vy, vw, vh) = window_rect(video);
    let (tools_at, seek_at_rect, vol_at) = chrome_pos(vx, vy, vw, vh);
    let mut top = pix(tools_at.2, tools_at.3);
    icons(&mut top, tools_at.2, tools_at.3, maximized, hot_tool);
    blit(tools, &top, tools_at.2, tools_at.3, tools_at.0, tools_at.1);

    let mut seek_px = pix(seek_at_rect.2, seek_at_rect.3);
    let thick = if seek_hot { 8 } else { 4 };
    let y = (seek_at_rect.3 - thick) / 2;
    track(&mut seek_px, seek_at_rect.2, seek_at_rect.3, 0, y, seek_at_rect.2, thick, seek);
    blit(bar, &seek_px, seek_at_rect.2, seek_at_rect.3, seek_at_rect.0, seek_at_rect.1);

    let mut vol_px = pix(vol_at.2, vol_at.3);
    let track_h = vol_at.3 - SPEAKER;
    let vol_thick = if vol_hot { 8 } else { 4 };
    vtrack(&mut vol_px, vol_at.2, vol_at.3, (vol_at.2 - vol_thick) / 2, 0, track_h, vol_thick, volume);
    speaker(&mut vol_px, vol_at.2, vol_at.3, (vol_at.2 - 16) / 2, track_h + SPEAKER_OY, wave_count(volume));
    blit(vol, &vol_px, vol_at.2, vol_at.3, vol_at.0, vol_at.1);
}

fn chrome_pos(vx: i32, vy: i32, vw: i32, vh: i32) -> ((i32, i32, i32, i32), (i32, i32, i32, i32), (i32, i32, i32, i32)) {
    let seek_w = (vw - MARGIN * 2 - VOL_W - 8).max(40);
    let full = (vh - MARGIN * 2 - TOP_H - SEEK_H - 24).max(72);
    let vol_h = (full / 2).max(72);
    let seek_y = vy + vh - MARGIN - SEEK_H;
    let vol_y = seek_y + SEEK_H / 2 - (vol_h - SPEAKER + SPEAKER_OY + SPEAKER_MID);
    (
        (vx + vw - MARGIN - TOP_W, vy + MARGIN, TOP_W, TOP_H),
        (vx + MARGIN, seek_y, seek_w, SEEK_H),
        (vx + vw - MARGIN - VOL_W, vol_y, VOL_W, vol_h),
    )
}

fn hide(tools: HWND, bar: HWND, vol: HWND) {
    unsafe {
        ShowWindow(tools, SW_HIDE);
        ShowWindow(bar, SW_HIDE);
        ShowWindow(vol, SW_HIDE);
    }
}

fn edge_at(rect: (i32, i32, i32, i32), x: i32, y: i32) -> u8 {
    let (left, top, w, h) = rect;
    let right = left + w;
    let bottom = top + h;
    if x < left || y < top || x >= right || y >= bottom {
        return 0;
    }
    let mut edges = 0u8;
    if x < left + EDGE {
        edges |= 1;
    }
    if x >= right - EDGE {
        edges |= 2;
    }
    if y < top + EDGE {
        edges |= 4;
    }
    if y >= bottom - EDGE {
        edges |= 8;
    }
    edges
}

fn resized(
    origin: (i32, i32, i32, i32),
    grab: (i32, i32),
    cursor: (i32, i32),
    edges: u8,
    max_w: i32,
    max_h: i32,
    aspect: f64,
) -> (i32, i32, i32, i32) {
    let (ox, oy, ow, oh) = origin;
    let dx = cursor.0 - grab.0;
    let dy = cursor.1 - grab.1;
    let mut w = ow;
    let mut h = oh;
    if edges & 1 != 0 {
        w -= dx;
    } else if edges & 2 != 0 {
        w += dx;
    }
    if edges & 4 != 0 {
        h -= dy;
    } else if edges & 8 != 0 {
        h += dy;
    }
    let aspect = if aspect > 0.05 { aspect } else { 16.0 / 9.0 };
    let horiz = edges & 3 != 0;
    let vert = edges & 12 != 0;
    if horiz && !vert {
        h = (w as f64 / aspect).round() as i32;
    } else if vert && !horiz {
        w = (h as f64 * aspect).round() as i32;
    } else if (w as f64) / aspect >= h as f64 {
        h = (w as f64 / aspect).round() as i32;
    } else {
        w = (h as f64 * aspect).round() as i32;
    }
    if w < MIN_W {
        w = MIN_W;
        h = (w as f64 / aspect).round() as i32;
    }
    if h < MIN_H {
        h = MIN_H;
        w = (h as f64 * aspect).round() as i32;
    }
    if w > max_w {
        w = max_w;
        h = (w as f64 / aspect).round() as i32;
    }
    if h > max_h {
        h = max_h;
        w = (h as f64 * aspect).round() as i32;
    }
    let x = if edges & 1 != 0 {
        ox + ow - w
    } else if edges & 2 != 0 {
        ox
    } else {
        ox + (ow - w) / 2
    };
    let y = if edges & 4 != 0 {
        oy + oh - h
    } else if edges & 8 != 0 {
        oy
    } else {
        oy + (oh - h) / 2
    };
    (x, y, w, h)
}

fn resize_cursor(edges: u8) {
    let id = match edges {
        1 | 2 => IDC_SIZEWE,
        4 | 8 => IDC_SIZENS,
        5 | 10 => IDC_SIZENWSE,
        6 | 9 => IDC_SIZENESW,
        _ => return,
    };
    unsafe {
        let cursor = LoadCursorW(std::ptr::null_mut(), id);
        if !cursor.is_null() {
            SetCursor(cursor);
        }
    }
}

fn fit_video_child(parent: HWND) {
    let mut rect = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(parent, &mut rect) };
    let mut child = unsafe { GetWindow(parent, GW_CHILD) };
    while !child.is_null() {
        unsafe {
            SetWindowPos(
                child,
                std::ptr::null_mut(),
                0,
                0,
                rect.right,
                rect.bottom,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
            child = GetWindow(child, GW_HWNDNEXT);
        }
    }
}

fn tool_slot(x: i32, width: i32) -> Option<i32> {
    if width <= 0 || x < 0 || x >= width {
        return None;
    }
    Some(x * 3 / width).filter(|slot| *slot < 3)
}

fn seek_at(x: i32, width: i32) -> Option<f64> {
    if width <= 0 || x < 0 || x > width {
        return None;
    }
    Some((x as f64 / width as f64).clamp(0.0, 1.0))
}

fn volume_at(y: i32, track_h: i32) -> Option<f64> {
    if track_h <= 0 || y < 0 || y > track_h {
        return None;
    }
    Some((1.0 - y as f64 / track_h as f64).clamp(0.0, 1.0))
}

fn pix(w: i32, h: i32) -> Vec<u32> {
    vec![0; (w.max(0) * h.max(0)) as usize]
}

fn wave_count(volume: f64) -> i32 {
    let level = volume * VOL_MAX;
    if level <= 0.0 {
        0
    } else if level < 30.0 {
        1
    } else if level < 70.0 {
        2
    } else {
        3
    }
}

fn icons(buf: &mut [u32], bw: i32, bh: i32, maximized: bool, hot: Option<i32>) {
    let slot = bw / 3;
    if let Some(index) = hot {
        if index >= 0 && index < 3 {
            fill_round(buf, bw, bh, index * slot + 6, 6, slot - 12, bh - 12, 8, 255, 255, 255, 31);
        }
    }
    for index in 0..3 {
        let cx = index * slot + slot / 2;
        let cy = bh / 2;
        if index == 0 {
            line(buf, bw, bh, cx - 6, cy, cx + 6, cy);
        } else if index == 1 && maximized {
            stroke_rect(buf, bw, bh, cx - 6, cy - 3, 9, 8);
            stroke_rect(buf, bw, bh, cx - 3, cy - 6, 9, 8);
        } else if index == 1 {
            stroke_rect(buf, bw, bh, cx - 6, cy - 5, 12, 10);
        } else {
            line(buf, bw, bh, cx - 5, cy - 5, cx + 5, cy + 5);
            line(buf, bw, bh, cx + 5, cy - 5, cx - 5, cy + 5);
        }
    }
}

fn vtrack(buf: &mut [u32], bw: i32, bh: i32, x: i32, y: i32, h: i32, thick: i32, fill: f64) {
    fill_round(buf, bw, bh, x, y, thick, h, thick / 2, 255, 255, 255, 71);
    let filled = ((h as f64) * fill.clamp(0.0, 1.0)).round() as i32;
    if filled > 0 {
        let drawn = filled.max(thick).min(h);
        fill_round(buf, bw, bh, x, y + h - drawn, thick, drawn, thick / 2, 255, 255, 255, 255);
    }
}

fn track(buf: &mut [u32], bw: i32, bh: i32, x: i32, y: i32, w: i32, thick: i32, fill: f64) {
    fill_round(buf, bw, bh, x, y, w, thick, thick / 2, 255, 255, 255, 71);
    let filled = ((w as f64) * fill.clamp(0.0, 1.0)).round() as i32;
    if filled > 0 {
        fill_round(buf, bw, bh, x, y, filled.max(thick), thick, thick / 2, 255, 255, 255, 255);
    }
}

fn speaker(buf: &mut [u32], bw: i32, bh: i32, ox: i32, oy: i32, waves: i32) {
    stroke_rect(buf, bw, bh, ox, oy + 4, 3, 6);
    line(buf, bw, bh, ox + 3, oy + 4, ox + 7, oy + 1);
    line(buf, bw, bh, ox + 7, oy + 1, ox + 7, oy + 13);
    line(buf, bw, bh, ox + 7, oy + 13, ox + 3, oy + 10);
    for index in 1..=waves {
        wave(buf, bw, bh, ox + 8, oy + 7, 2 + index * 2);
    }
}

fn wave(buf: &mut [u32], bw: i32, bh: i32, cx: i32, cy: i32, radius: i32) {
    let steps = 6;
    let mut prev = None;
    for step in 0..=steps {
        let angle = -1.05 + 2.1 * step as f64 / steps as f64;
        let x = cx + (radius as f64 * angle.cos()).round() as i32;
        let y = cy + (radius as f64 * angle.sin()).round() as i32;
        if let Some((px, py)) = prev {
            line(buf, bw, bh, px, py, x, y);
        }
        prev = Some((x, y));
    }
}

fn stroke_rect(buf: &mut [u32], bw: i32, bh: i32, x: i32, y: i32, w: i32, h: i32) {
    line(buf, bw, bh, x, y, x + w, y);
    line(buf, bw, bh, x, y + h, x + w, y + h);
    line(buf, bw, bh, x, y, x, y + h);
    line(buf, bw, bh, x + w, y, x + w, y + h);
}

fn line(buf: &mut [u32], bw: i32, bh: i32, x0: i32, y0: i32, x1: i32, y1: i32) {
    let steps = (x1 - x0).abs().max((y1 - y0).abs()).max(1);
    for step in 0..=steps {
        let x = x0 + (x1 - x0) * step / steps;
        let y = y0 + (y1 - y0) * step / steps;
        plot(buf, bw, bh, x, y, 255, 255, 255, 235);
        plot(buf, bw, bh, x + 1, y, 255, 255, 255, 235);
    }
}

fn fill_round(
    buf: &mut [u32],
    bw: i32,
    bh: i32,
    ox: i32,
    oy: i32,
    w: i32,
    h: i32,
    radius: i32,
    r: u8,
    g: u8,
    b: u8,
    a: u8,
) {
    if w <= 0 || h <= 0 {
        return;
    }
    for y in 0..h {
        for x in 0..w {
            if in_round(x, y, w, h, radius) {
                plot(buf, bw, bh, ox + x, oy + y, r, g, b, a);
            }
        }
    }
}

fn in_round(x: i32, y: i32, w: i32, h: i32, radius: i32) -> bool {
    if x < 0 || y < 0 || x >= w || y >= h {
        return false;
    }
    let radius = radius.max(0).min(w / 2).min(h / 2);
    let dx = if x < radius {
        radius - x
    } else if x >= w - radius {
        x - (w - radius - 1)
    } else {
        0
    };
    let dy = if y < radius {
        radius - y
    } else if y >= h - radius {
        y - (h - radius - 1)
    } else {
        0
    };
    dx * dx + dy * dy <= radius * radius
}

fn plot(buf: &mut [u32], bw: i32, bh: i32, x: i32, y: i32, r: u8, g: u8, b: u8, a: u8) {
    if a == 0 || x < 0 || y < 0 || x >= bw || y >= bh {
        return;
    }
    let index = (y * bw + x) as usize;
    let dst = buf[index];
    let sa = a as u32;
    let inv = 255 - sa;
    let out_a = sa + ((dst >> 24) & 255) * inv / 255;
    let out_r = r as u32 * sa / 255 + ((dst >> 16) & 255) * inv / 255;
    let out_g = g as u32 * sa / 255 + ((dst >> 8) & 255) * inv / 255;
    let out_b = b as u32 * sa / 255 + (dst & 255) * inv / 255;
    buf[index] = (out_a << 24) | (out_r << 16) | (out_g << 8) | out_b;
}

fn blit(hwnd: HWND, pixels: &[u32], w: i32, h: i32, x: i32, y: i32) {
    unsafe {
        let screen = GetDC(std::ptr::null_mut());
        let mem = CreateCompatibleDC(screen);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -h;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut bits = std::ptr::null_mut();
        let dib = CreateDIBSection(mem, &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
        if dib.is_null() || bits.is_null() {
            DeleteDC(mem);
            ReleaseDC(std::ptr::null_mut(), screen);
            return;
        }
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits as *mut u32, (w * h) as usize);
        let old = SelectObject(mem, dib as _);
        let mut origin = POINT { x, y };
        let mut size = SIZE { cx: w, cy: h };
        let mut src = POINT { x: 0, y: 0 };
        let mut blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA,
        };
        SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        UpdateLayeredWindow(
            hwnd,
            screen,
            &mut origin,
            &mut size,
            mem,
            &mut src,
            0,
            &mut blend,
            ULW_ALPHA,
        );
        SelectObject(mem, old);
        DeleteObject(dib as _);
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);
    }
}

fn shown(hwnd: HWND) -> bool {
    unsafe { IsWindowVisible(hwnd) != 0 }
}

fn cursor_pos() -> POINT {
    let mut cursor = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut cursor) };
    cursor
}

fn local_x(hwnd: HWND, screen_x: i32) -> i32 {
    screen_x - window_rect(hwnd).0
}

fn local_y(hwnd: HWND, screen_y: i32) -> i32 {
    screen_y - window_rect(hwnd).1
}

fn window_rect(hwnd: HWND) -> (i32, i32, i32, i32) {
    let mut rect = unsafe { std::mem::zeroed() };
    unsafe { GetWindowRect(hwnd, &mut rect) };
    (
        rect.left,
        rect.top,
        rect.right - rect.left,
        rect.bottom - rect.top,
    )
}

fn hit(hwnd: HWND, x: i32, y: i32) -> bool {
    let (left, top, w, h) = window_rect(hwnd);
    x >= left && y >= top && x < left + w && y < top + h
}

fn volume_level(mpv: &Mpv) -> f64 {
    prop(mpv, "volume").unwrap_or(100.0).clamp(0.0, VOL_MAX)
}

fn prop(mpv: &Mpv, name: &str) -> Option<f64> {
    mpv.get_property(name).ok()
}

#[cfg(test)]
mod tests {
    use super::{
        chrome_pos, edge_at, resized, seek_at, tool_slot, volume_at, wave_count, MIN_W,
        SPEAKER, SPEAKER_MID, SPEAKER_OY, VOL_W,
    };

    #[test]
    fn controls_sit_on_the_picture_and_volume_is_vertical() {
        let (tools, seek, vol) = chrome_pos(100, 100, 480, 270);
        assert!(tools.1 < vol.1);
        let speaker_mid = vol.1 + vol.3 - SPEAKER + SPEAKER_OY + SPEAKER_MID;
        assert_eq!(speaker_mid, seek.1 + seek.3 / 2);
        assert!(seek.0 + seek.2 <= vol.0);
        assert_eq!(vol.2, VOL_W);
        assert_eq!(vol.3, 77);
        assert!(vol.3 > seek.3);
        assert_eq!(tool_slot(0, 126), Some(0));
        assert_eq!(tool_slot(42, 126), Some(1));
        assert_eq!(tool_slot(84, 126), Some(2));
        assert!(matches!(seek_at(0, 200), Some(t) if t < 0.01));
        assert!(matches!(volume_at(0, 100), Some(t) if t > 0.99));
        assert!(matches!(volume_at(100, 100), Some(t) if t < 0.01));
        assert_eq!(wave_count(0.0), 0);
        assert_eq!(wave_count(20.0 / 200.0), 1);
        assert_eq!(wave_count(50.0 / 200.0), 2);
        assert_eq!(wave_count(100.0 / 200.0), 3);
    }

    #[test]
    fn dragging_an_edge_resizes_that_side_down_to_the_minimum() {
        let origin = (10, 20, 400, 300);
        let ratio = 4.0 / 3.0;
        assert_eq!(resized(origin, (410, 320), (450, 360), 2 | 8, 4000, 4000, ratio), (10, 20, 453, 340));
        assert_eq!(resized(origin, (10, 20), (0, 0), 1 | 4, 4000, 4000, ratio), (-17, 0, 427, 320));
        let shrunk = resized(origin, (410, 320), (0, 0), 2 | 8, 4000, 4000, ratio);
        assert_eq!(shrunk.2, MIN_W);
        assert_eq!(shrunk.3, 240);
        assert_eq!(resized(origin, (410, 320), (2000, 2000), 2 | 8, 500, 400, ratio), (10, 20, 500, 375));
        let wide = resized((0, 0, 480, 270), (480, 100), (640, 100), 2, 4000, 4000, 16.0 / 9.0);
        assert_eq!(wide, (0, -45, 640, 360));
        assert_eq!(wide.2 * 9, wide.3 * 16);
        assert_eq!(edge_at((0, 0, 400, 300), 2, 150), 1);
        assert_eq!(edge_at((0, 0, 400, 300), 398, 298), 2 | 8);
        assert_eq!(edge_at((0, 0, 400, 300), 200, 150), 0);
    }
}
