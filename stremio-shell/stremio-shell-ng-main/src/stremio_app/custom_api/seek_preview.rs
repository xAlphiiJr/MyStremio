//! Second, paused libmpv used only for hover stills. The playing player is never seeked.
//! shortcut: a second open of the 11470 URL can stall the film, drop it if playback rebuffers.

use flume::Sender;
use libmpv2::Mpv;
use serde_json::{json, Value};
use std::ffi::{c_void, CString};
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, Once, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const BUCKET_SECS: f64 = 3.0;
const PREVIEW_W: i32 = 192;
const PREVIEW_H: i32 = 108;
const CACHE_MAX: usize = 24;
const OPEN_TIMEOUT: Duration = Duration::from_secs(8);
const SEEK_TIMEOUT: Duration = Duration::from_secs(8);
const CACHED_SEEK: Duration = Duration::from_secs(4);
const IDLE_CLOSE: Duration = Duration::from_secs(20);

struct Job {
    id: Value,
    path: String,
    seconds: f64,
    local: bool,
    tx: Sender<String>,
}

struct Frame {
    w: i32,
    h: i32,
    rgb: String,
}

struct Queue {
    job: Mutex<Option<Job>>,
    wake: Condvar,
}

struct Preview {
    mpv: Mpv,
    render: *mut libmpv2_sys::mpv_render_context,
    path: String,
    opening: Option<String>,
}

unsafe impl Send for Preview {}

impl Drop for Preview {
    fn drop(&mut self) {
        unsafe { libmpv2_sys::mpv_render_context_free(self.render) };
    }
}

pub fn bucket_index(seconds: f64) -> Option<i64> {
    if !seconds.is_finite() || seconds < 0.0 || seconds > 1_000_000.0 {
        return None;
    }
    Some((seconds / BUCKET_SECS).floor() as i64)
}

pub fn preview_allowed(path: &str) -> bool {
    let path = path.trim();
    !path.is_empty() && !path.contains('\0')
}

pub fn enqueue(message: Value, tx: Sender<String>) {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let seconds = params
        .get("seconds")
        .and_then(|v| v.as_f64())
        .unwrap_or(f64::NAN);
    let local = params.get("local").and_then(|v| v.as_bool()).unwrap_or(false);
    let Some(bucket) = bucket_index(seconds) else {
        reply_error(&id, "bad time", &tx);
        return;
    };
    if !preview_allowed(&path) {
        reply_result(&id, json!({ "unavailable": true }), &tx);
        return;
    }
    if let Some(hit) = cache_get(&path, bucket) {
        reply_result(&id, frame_json(&hit), &tx);
        return;
    }
    if !start_worker() {
        reply_error(&id, "preview worker", &tx);
        return;
    }
    let job = Job {
        id,
        path,
        seconds,
        local,
        tx,
    };
    let queue = queue();
    let mut slot = queue.job.lock().unwrap_or_else(|err| err.into_inner());
    if slot
        .as_ref()
        .is_some_and(|old| keep_queued(old.local, job.local))
    {
        let id = job.id.clone();
        let tx = job.tx.clone();
        drop(slot);
        reply_error(&id, "stale", &tx);
        return;
    }
    if let Some(old) = slot.replace(job) {
        reply_error(&old.id, "stale", &old.tx);
    }
    queue.wake.notify_one();
}

fn queue() -> &'static Queue {
    static QUEUE: OnceLock<Queue> = OnceLock::new();
    QUEUE.get_or_init(|| Queue {
        job: Mutex::new(None),
        wake: Condvar::new(),
    })
}

fn cache() -> &'static Mutex<Vec<(String, i64, Frame)>> {
    static CACHE: OnceLock<Mutex<Vec<(String, i64, Frame)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

fn cache_get(path: &str, bucket: i64) -> Option<Frame> {
    let guard = cache().lock().unwrap_or_else(|err| err.into_inner());
    guard
        .iter()
        .find(|(cached_path, cached_bucket, _)| cached_path == path && *cached_bucket == bucket)
        .map(|(_, _, frame)| Frame {
            w: frame.w,
            h: frame.h,
            rgb: frame.rgb.clone(),
        })
}

fn cache_put(path: String, bucket: i64, frame: Frame) {
    let mut guard = cache().lock().unwrap_or_else(|err| err.into_inner());
    if let Some(existing) = guard
        .iter_mut()
        .find(|(cached_path, cached_bucket, _)| cached_path == &path && *cached_bucket == bucket)
    {
        existing.2 = frame;
        return;
    }
    if guard.len() >= CACHE_MAX {
        guard.remove(0);
    }
    guard.push((path, bucket, frame));
}

fn start_worker() -> bool {
    static START: Once = Once::new();
    static OK: AtomicBool = AtomicBool::new(false);
    START.call_once(|| {
        let spawned = thread::Builder::new()
            .name("seek-preview".into())
            .spawn(worker_loop)
            .is_ok();
        OK.store(spawned, Ordering::Relaxed);
    });
    OK.load(Ordering::Relaxed)
}

fn worker_loop() {
    let mut session: Option<Preview> = None;
    loop {
        let Some(job) = next_job(session.is_some()) else {
            session = None;
            continue;
        };
        if session.as_ref().is_some_and(|open| {
            !reuse_player(&open.path, open.opening.as_deref(), &job.path)
        }) {
            session = None;
        }
        if session.is_none() {
            match Preview::open() {
                Ok(open) => session = Some(open),
                Err(err) => {
                    eprintln!("seek-preview: {err}");
                    reply_error(&job.id, "preview open", &job.tx);
                    continue;
                }
            }
        }
        let drop_player = {
            let open = session.as_mut().unwrap();
            match open.frame_at(&job.path, job.seconds, job.local) {
                Ok(frame) => {
                    if let Some(bucket) = bucket_index(job.seconds) {
                        cache_put(
                            job.path.clone(),
                            bucket,
                            Frame {
                                w: frame.w,
                                h: frame.h,
                                rgb: frame.rgb.clone(),
                            },
                        );
                    }
                    reply_result(&job.id, frame_json(&frame), &job.tx);
                    false
                }
                Err(err) => {
                    // A miss keeps the player. Reopening the stream is the stall.
                    let drop_player = err != "timeout" && err != "stale";
                    if drop_player {
                        eprintln!("seek-preview: {err}");
                    }
                    reply_error(&job.id, "preview frame", &job.tx);
                    drop_player
                }
            }
        };
        if drop_player {
            session = None;
        }
    }
}

fn next_job(session_open: bool) -> Option<Job> {
    let queue = queue();
    let mut slot = queue.job.lock().unwrap_or_else(|err| err.into_inner());
    loop {
        if let Some(job) = slot.take() {
            return Some(job);
        }
        if !session_open {
            slot = queue.wake.wait(slot).unwrap_or_else(|err| err.into_inner());
            continue;
        }
        let (guard, status) = queue
            .wake
            .wait_timeout(slot, IDLE_CLOSE)
            .unwrap_or_else(|err| err.into_inner());
        slot = guard;
        if slot.is_none() && status.timed_out() {
            return None;
        }
    }
}

impl Preview {
    fn open() -> Result<Self, String> {
        let mpv = Mpv::with_initializer(|init| {
            init.set_option("vo", "libmpv")?;
            init.set_option("ao", "null")?;
            init.set_option("aid", "no")?;
            init.set_option("sid", "no")?;
            init.set_option("hwdec", "no")?;
            init.set_option("pause", "yes")?;
            init.set_option("hr-seek", "no")?;
            init.set_option("keep-open", "yes")?;
            init.set_option("force-window", "no")?;
            init.set_option("cache", "yes")?;
            // One second: a still is one keyframe, not a second download of the film.
            init.set_option("cache-secs", "1")?;
            init.set_option("demuxer-readahead-secs", "1")?;
            init.set_option("cache-pause-initial", "no")?;
            init.set_option("demuxer-max-bytes", "32MiB")?;
            init.set_option("demuxer-max-back-bytes", "8MiB")?;
            init.set_option("vd-lavc-fast", "yes")?;
            init.set_option("vd-lavc-skiploopfilter", "all")?;
            // Render must not wait on the display clock.
            let _ = init.set_option("video-timing-offset", "0");
            let _ = init.set_option("osd-level", "0");
            let _ = init.set_option("sub-auto", "no");
            let _ = init.set_option("audio-display", "no");
            let _ = init.set_option("input-default-bindings", "no");
            let _ = init.set_option("input-vo-keyboard", "no");
            let _ = init.set_option("input-media-keys", "no");
            let _ = init.set_option("ytdl", "no");
            let _ = init.set_option("msg-level", "all=no");
            Ok(())
        })
        .map_err(|err| format!("open: {err:?}"))?;

        let api = CString::new("sw").map_err(|_| "sw".to_string())?;
        let mut params = [
            libmpv2_sys::mpv_render_param {
                type_: libmpv2_sys::mpv_render_param_type_MPV_RENDER_PARAM_API_TYPE,
                data: api.as_ptr() as *mut c_void,
            },
            libmpv2_sys::mpv_render_param {
                type_: libmpv2_sys::mpv_render_param_type_MPV_RENDER_PARAM_INVALID,
                data: std::ptr::null_mut(),
            },
        ];
        let mut render = std::ptr::null_mut();
        let rc = unsafe {
            libmpv2_sys::mpv_render_context_create(
                &mut render,
                mpv.ctx.as_ptr(),
                params.as_mut_ptr(),
            )
        };
        if rc < 0 || render.is_null() {
            if !render.is_null() {
                unsafe { libmpv2_sys::mpv_render_context_free(render) };
            }
            return Err(format!("sw render {rc}"));
        }
        Ok(Self {
            mpv,
            render,
            path: String::new(),
            opening: None,
        })
    }

    fn frame_at(&mut self, path: &str, seconds: f64, local: bool) -> Result<Frame, String> {
        if self.path != path {
            if !already_opening(self.opening.as_deref(), path) {
                self.argv(&["loadfile", path, "replace"])?;
                self.opening = Some(path.to_string());
            }
            self.wait_for(
                libmpv2_sys::mpv_event_id_MPV_EVENT_FILE_LOADED,
                Instant::now() + OPEN_TIMEOUT,
                !local,
            )?;
            self.argv(&["set", "pause", "yes"])?;
            self.drain();
            self.path = path.to_string();
            self.opening = None;
        }
        if yields_to_local(local, queued_is_local()) {
            return Err("stale".into());
        }
        self.drain();
        let at = format!("{seconds:.3}");
        let deadline = Instant::now() + seek_wait(local);
        self.argv(&["seek", &at, "absolute"])?;
        self.wait_for(
            libmpv2_sys::mpv_event_id_MPV_EVENT_PLAYBACK_RESTART,
            deadline,
            !local,
        )?;
        let mut rgb = self.render_rgb()?;
        // shortcut: an all-black first seek is stepped once, upgrade if a black intro must stay on that frame
        if rgb.iter().all(|byte| *byte == 0) {
            let _ = unsafe { libmpv2_sys::mpv_render_context_update(self.render) };
            self.argv(&["frame-step"])?;
            loop {
                if !local && queued_is_local() {
                    return Err("stale".into());
                }
                let flags = unsafe { libmpv2_sys::mpv_render_context_update(self.render) };
                if flags & u64::from(libmpv2_sys::mpv_render_update_flag_MPV_RENDER_UPDATE_FRAME) != 0
                {
                    rgb = self.render_rgb()?;
                    break;
                }
                if Instant::now() >= deadline {
                    return Err("timeout".into());
                }
                let _ = unsafe { libmpv2_sys::mpv_wait_event(self.mpv.ctx.as_ptr(), 0.05) };
            }
        }
        // shortcut: software RGB skips the player's bt.2390 tone map, so HDR stills won't match.
        Ok(Frame {
            w: PREVIEW_W,
            h: PREVIEW_H,
            rgb: base64(&rgb),
        })
    }

    fn argv(&self, args: &[&str]) -> Result<(), String> {
        let owned: Vec<CString> = args
            .iter()
            .map(|arg| CString::new(*arg).map_err(|_| "bad arg".to_string()))
            .collect::<Result<_, _>>()?;
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|arg| arg.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        let rc = unsafe { libmpv2_sys::mpv_command(self.mpv.ctx.as_ptr(), ptrs.as_mut_ptr()) };
        if rc < 0 {
            Err(format!("command {rc}"))
        } else {
            Ok(())
        }
    }

    fn drain(&self) {
        loop {
            let event = unsafe { libmpv2_sys::mpv_wait_event(self.mpv.ctx.as_ptr(), 0.0) };
            if event.is_null() {
                return;
            }
            if unsafe { (*event).event_id } == libmpv2_sys::mpv_event_id_MPV_EVENT_NONE {
                return;
            }
        }
    }

    fn wait_for(&self, want: u32, deadline: Instant, yield_cold: bool) -> Result<(), String> {
        loop {
            if yield_cold && queued_is_local() {
                return Err("stale".into());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("timeout".into());
            }
            let slice = left.min(Duration::from_millis(200)).as_secs_f64();
            let event = unsafe { libmpv2_sys::mpv_wait_event(self.mpv.ctx.as_ptr(), slice) };
            if event.is_null() {
                continue;
            }
            let id = unsafe { (*event).event_id };
            if id == libmpv2_sys::mpv_event_id_MPV_EVENT_END_FILE
                || id == libmpv2_sys::mpv_event_id_MPV_EVENT_SHUTDOWN
            {
                return Err(format!("playback ended {id}"));
            }
            if id == want {
                return Ok(());
            }
        }
    }

    fn render_rgb(&self) -> Result<Vec<u8>, String> {
        let w = PREVIEW_W as usize;
        let h = PREVIEW_H as usize;
        let stride = w * 4;
        let mut buf = vec![0u8; stride * h + 64];
        let off = buf.as_mut_ptr().align_offset(64);
        if off >= 64 {
            return Err("align".into());
        }
        let ptr = unsafe { buf.as_mut_ptr().add(off) };
        let mut size = [PREVIEW_W, PREVIEW_H];
        let mut stride_n = stride;
        let format = CString::new("rgb0").map_err(|_| "rgb0".to_string())?;
        let mut params = [
            sw_param(
                libmpv2_sys::mpv_render_param_type_MPV_RENDER_PARAM_SW_SIZE,
                size.as_mut_ptr() as *mut c_void,
            ),
            sw_param(
                libmpv2_sys::mpv_render_param_type_MPV_RENDER_PARAM_SW_FORMAT,
                format.as_ptr() as *mut c_void,
            ),
            sw_param(
                libmpv2_sys::mpv_render_param_type_MPV_RENDER_PARAM_SW_STRIDE,
                &mut stride_n as *mut usize as *mut c_void,
            ),
            sw_param(
                libmpv2_sys::mpv_render_param_type_MPV_RENDER_PARAM_SW_POINTER,
                ptr as *mut c_void,
            ),
            sw_param(
                libmpv2_sys::mpv_render_param_type_MPV_RENDER_PARAM_INVALID,
                std::ptr::null_mut(),
            ),
        ];
        let rc =
            unsafe { libmpv2_sys::mpv_render_context_render(self.render, params.as_mut_ptr()) };
        if rc < 0 {
            return Err(format!("render {rc}"));
        }
        let mut packed = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            let row = unsafe { std::slice::from_raw_parts(ptr.add(y * stride), stride) };
            for x in 0..w {
                let i = x * 4;
                packed.extend_from_slice(&row[i..i + 3]);
            }
        }
        Ok(packed)
    }
}

fn sw_param(type_: u32, data: *mut c_void) -> libmpv2_sys::mpv_render_param {
    libmpv2_sys::mpv_render_param { type_, data }
}

fn frame_json(frame: &Frame) -> Value {
    json!({ "w": frame.w, "h": frame.h, "rgb": frame.rgb })
}

fn reply_result(id: &Value, result: Value, tx: &Sender<String>) {
    let _ = tx.send(
        json!({
            "stremioCustom": true,
            "id": id,
            "result": result,
        })
        .to_string(),
    );
}

fn reply_error(id: &Value, message: &str, tx: &Sender<String>) {
    let _ = tx.send(
        json!({
            "stremioCustom": true,
            "id": id,
            "error": message,
        })
        .to_string(),
    );
}

fn base64(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | data[i + 2] as u32;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        i += 3;
    }
    if i < data.len() {
        let mut n = (data[i] as u32) << 16;
        if i + 1 < data.len() {
            n |= (data[i + 1] as u32) << 8;
        }
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if i + 1 < data.len() {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
            out.push('=');
        } else {
            out.push('=');
            out.push('=');
        }
    }
    out
}

fn already_opening(opening: Option<&str>, path: &str) -> bool {
    opening == Some(path)
}

fn reuse_player(loaded: &str, opening: Option<&str>, path: &str) -> bool {
    loaded == path || already_opening(opening, path)
}

fn seek_wait(local: bool) -> Duration {
    if local { CACHED_SEEK } else { SEEK_TIMEOUT }
}

fn yields_to_local(current_local: bool, queued_local: bool) -> bool {
    !current_local && queued_local
}

fn keep_queued(queued_local: bool, next_local: bool) -> bool {
    queued_local && !next_local
}

fn queued_is_local() -> bool {
    let slot = queue().job.lock().unwrap_or_else(|err| err.into_inner());
    slot.as_ref().is_some_and(|job| job.local)
}

fn displace<T>(slot: &mut Option<T>, next: T) -> Option<T> {
    slot.replace(next)
}

#[cfg(test)]
mod tests {
    use super::{
        already_opening, base64, bucket_index, displace, keep_queued, preview_allowed, reuse_player,
        seek_wait, yields_to_local,
    };

    #[test]
    fn local_seek_goes_first() {
        assert!(yields_to_local(false, true));
        assert!(!yields_to_local(false, false));
        assert!(!yields_to_local(true, true));
        assert!(keep_queued(true, false));
        assert!(!keep_queued(false, true));
        assert!(!keep_queued(true, true));
        assert!(seek_wait(true) < seek_wait(false));
    }

    #[test]
    fn open_is_not_restarted() {
        assert!(already_opening(Some("film"), "film"));
        assert!(!already_opening(Some("other"), "film"));
        assert!(!already_opening(None, "film"));
        assert!(reuse_player("film", None, "film"));
        assert!(reuse_player("", Some("film"), "film"));
        assert!(!reuse_player("other", None, "film"));
    }

    #[test]
    fn buckets_are_three_seconds() {
        assert_eq!(bucket_index(0.0), Some(0));
        assert_eq!(bucket_index(2.9), Some(0));
        assert_eq!(bucket_index(3.0), Some(1));
        assert_eq!(bucket_index(-1.0), None);
        assert_eq!(bucket_index(f64::NAN), None);
    }

    #[test]
    fn preview_rejects_empty_paths() {
        assert!(preview_allowed("http://127.0.0.1:11470/hash/0"));
        assert!(preview_allowed(r"D:\Movies\film.mkv"));
        assert!(!preview_allowed(""));
        assert!(!preview_allowed("http://127.0.0.1:11470/\0"));
    }

    #[test]
    fn pending_keeps_only_the_latest() {
        let mut pending = None;
        assert_eq!(displace(&mut pending, 1), None);
        assert_eq!(displace(&mut pending, 2), Some(1));
        assert_eq!(pending.take(), Some(2));
    }

    #[test]
    fn sw_preview_context_opens() {
        drop(super::Preview::open().expect("sw context"));
    }

    #[test]
    fn first_still_is_not_black() {
        let path = std::env::temp_dir().join("mystremio-seek-preview-gray.y4m");
        std::fs::write(&path, gray_y4m()).expect("y4m");
        let mut preview = super::Preview::open().expect("sw context");
        let frame = preview
            .frame_at(&path.to_string_lossy(), 0.0, true)
            .expect("first still");
        let _ = std::fs::remove_file(&path);
        assert!(
            frame.rgb.bytes().any(|byte| byte != b'A'),
            "first still is black"
        );
    }

    fn gray_y4m() -> Vec<u8> {
        let (w, h) = (192, 108);
        let y = w * h;
        let c = (w / 2) * (h / 2);
        let mut plane = Vec::with_capacity(y + c * 2);
        plane.extend(std::iter::repeat(180).take(y));
        plane.extend(std::iter::repeat(128).take(c * 2));
        let mut buf = format!("YUV4MPEG2 W{w} H{h} F15:1 Ip A1:1 C420\n").into_bytes();
        for _ in 0..4 {
            buf.extend_from_slice(b"FRAME\n");
            buf.extend_from_slice(&plane);
        }
        buf
    }

    #[test]
    fn base64_matches_known_vector() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
    }
}
