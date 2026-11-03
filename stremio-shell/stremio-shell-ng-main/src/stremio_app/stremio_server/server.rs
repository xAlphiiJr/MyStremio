use crate::stremio_app::constants::{SRV_BUFFER_SIZE, SRV_LOG_SIZE, STREMIO_SERVER_DEV_MODE};
use native_windows_gui::{self as nwg, PartialUi};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    env, fs,
    io::Read,
    net::TcpStream,
    ops::Deref,
    os::windows::{io::AsRawHandle, process::CommandExt},
    path,
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use winapi::um::{
    handleapi::CloseHandle,
    processthreadsapi::{OpenProcess, TerminateProcess},
    winbase::{CreateJobObjectA, CREATE_NO_WINDOW},
    winnt::{
        JobObjectExtendedLimitInformation, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, PROCESS_TERMINATE,
    },
};

const ENGINE_HOST: &str = "127.0.0.1:11470";

#[derive(Default)]
pub struct StremioServer {
    development: bool,
    parent: nwg::ControlHandle,
    crash_notice: nwg::Notice,
    logs: Arc<Mutex<String>>,
    /// Receives EngineFS endpoint when the background server thread is ready.
    ready_rx: Arc<Mutex<Option<flume::Receiver<String>>>>,
    server_pid: Arc<Mutex<Option<u32>>>,
    webui_pid: Arc<Mutex<Option<u32>>>,
}

fn terminate_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return;
        }
        TerminateProcess(handle, 1);
        CloseHandle(handle);
    }
}

fn store_pid(slot: &Arc<Mutex<Option<u32>>>, pid: u32) {
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(pid);
    }
}

fn clear_pid(slot: &Arc<Mutex<Option<u32>>>) {
    if let Ok(mut guard) = slot.lock() {
        *guard = None;
    }
}

/// PIDs listening on `port`. Remote `0.0.0.0:0` / `[::]:0` so locale-specific
/// state names (LISTENING / ABHÖREN) do not matter.
fn listening_pids(netstat: &str, port: u16) -> Vec<u32> {
    let suffix = format!(":{port}");
    let mut pids = Vec::new();
    for line in netstat.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 || !cols[0].eq_ignore_ascii_case("tcp") {
            continue;
        }
        if !cols[1].ends_with(&suffix) {
            continue;
        }
        let remote = cols[2];
        if remote != "0.0.0.0:0" && remote != "[::]:0" && remote != "*:*" {
            continue;
        }
        let Ok(pid) = cols[cols.len() - 1].parse::<u32>() else {
            continue;
        };
        if pid > 4 && !pids.contains(&pid) {
            pids.push(pid);
        }
    }
    pids
}

/// One job for this process. Children die when the shell exits. The shell is not a member,
/// so a runtime exception cannot close the window.
fn assign_runtime_job(child: &std::process::Child) {
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectA(std::ptr::null_mut(), std::ptr::null_mut());
        if job.is_null() {
            return 0;
        }
        let jeli = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK,
                ..std::mem::zeroed()
            },
            ..std::mem::zeroed()
        };
        winapi::um::jobapi2::SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &jeli as *const _ as *mut _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        job as usize
    });
    if job == 0 {
        return;
    }
    let ok = unsafe {
        winapi::um::jobapi2::AssignProcessToJobObject(
            job as winapi::shared::ntdef::HANDLE,
            child.as_raw_handle() as winapi::shared::ntdef::HANDLE,
        )
    };
    if ok == 0 {
        eprintln!(
            "runtime job assign failed: {}",
            std::io::Error::last_os_error()
        );
    }
}

fn engine_listener_pids() -> Vec<u32> {
    let Ok(output) = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return Vec::new();
    };
    listening_pids(&String::from_utf8_lossy(&output.stdout), 11470)
}

/**
 * Spawn EngineFS + local webui. Shared by first start and wake recovery.
 */
fn spawn_server_thread(
    logs: Arc<Mutex<String>>,
    crash_sender: nwg::NoticeSender,
    ready_rx: Arc<Mutex<Option<flume::Receiver<String>>>>,
    server_pid: Arc<Mutex<Option<u32>>>,
    webui_pid: Arc<Mutex<Option<u32>>>,
) {
    let (tx, rx) = flume::unbounded();
    {
        let mut slot = ready_rx.lock().unwrap();
        *slot = Some(rx);
    }

    thread::spawn(move || {
        let mut path = env::current_exe()
            .and_then(fs::canonicalize)
            .expect("Cannot get the current executable path");
        path.pop();
        let lines = Arc::new(Mutex::new(String::new()));
        let runtime_path = path.clone().join(path::Path::new("stremio-runtime.exe"));
        let server_path = path.clone().join(path::Path::new("server.js"));
        let webui_server_path = path.clone().join(path::Path::new("webui-server.js"));
        let webui_dir = path.clone().join(path::Path::new("webui"));
        let webui_index = webui_dir.join(path::Path::new("index.html"));

        let local_webui_location =
            "http://127.0.0.1:11475/index.html#/?streamingServerUrl=http%3A%2F%2F127.0.0.1%3A11470%2F";
        let local_webui_available = webui_server_path.exists() && webui_index.exists();

        if local_webui_available && TcpStream::connect("127.0.0.1:11475").is_err() {
            match Command::new(runtime_path.clone())
                .arg(&webui_server_path)
                .arg("--dir")
                .arg(&webui_dir)
                .arg("--port")
                .arg("11475")
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(child) => {
                    assign_runtime_job(&child);
                    store_pid(&webui_pid, child.id());
                    std::mem::forget(child);
                }
                Err(err) => {
                    eprintln!("Cannot execute webui-server: {err}");
                }
            }

            for _ in 0..50 {
                if TcpStream::connect("127.0.0.1:11475").is_ok() {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }

        // A leftover can answer once, then die with the previous process's job.
        if StremioServer::is_engine_reachable() {
            thread::sleep(Duration::from_millis(500));
            if StremioServer::is_engine_reachable() {
                println!("Stremio server already ready at http://127.0.0.1:11470");
                tx.send("http://127.0.0.1:11470".to_string()).ok();
                return;
            }
            eprintln!("Stremio server dropped; starting a new one");
        }

        // shortcut: 3 bind attempts, raise if the runtime still dies before listen.
        let mut attempt = 0;
        loop {
            attempt += 1;
            if !StremioServer::is_engine_reachable() {
                let self_pid = std::process::id();
                for pid in engine_listener_pids() {
                    if pid != self_pid {
                        terminate_pid(pid);
                    }
                }
                thread::sleep(Duration::from_millis(300));
            }
            if StremioServer::is_engine_reachable() {
                tx.send("http://127.0.0.1:11470".to_string()).ok();
                return;
            }

            let mut server_command = Command::new(&runtime_path);
            server_command
                .arg(&server_path)
                .env("NO_CORS", "1")
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if local_webui_available {
                server_command.env("WEBUI_LOCATION", local_webui_location);
            }

            match server_command.spawn() {
                Ok(mut child) => {
                    assign_runtime_job(&child);
                    store_pid(&server_pid, child.id());
                    let http_ready = Arc::new(AtomicBool::new(false));
                    let stop_poll = Arc::new(AtomicBool::new(false));
                    let poll_ready = http_ready.clone();
                    let poll_stop = stop_poll.clone();
                    let poll_tx = tx.clone();
                    let poll = thread::spawn(move || {
                        while !poll_stop.load(Ordering::SeqCst) {
                            if StremioServer::is_engine_reachable() {
                                poll_ready.store(true, Ordering::SeqCst);
                                poll_tx.send("http://127.0.0.1:11470".to_string()).ok();
                                return;
                            }
                            thread::sleep(Duration::from_millis(300));
                        }
                    });
                    let mut stdout = child.stdout.take().unwrap();
                    let out_lines = lines.clone();
                    let tx = tx.clone();
                    let out_thread = thread::spawn(move || {
                        let http_endpoint = String::new();
                        loop {
                            let mut buffer = [0; SRV_BUFFER_SIZE];
                            let on = match stdout.read(&mut buffer[..]) {
                                Ok(0) => break,
                                Ok(n) => n,
                                Err(err) => {
                                    eprintln!("server stdout read error: {err}");
                                    break;
                                }
                            };
                            std::io::stdout().write_all(&buffer).ok();
                            let string_data = String::from_utf8_lossy(&buffer[..on]);
                            {
                                let lines = &mut *out_lines.lock().unwrap();
                                *lines += string_data.deref();
                                if http_endpoint.is_empty() {
                                    if let Some(http_endpoint) = string_data
                                        .lines()
                                        .find(|line| line.starts_with("EngineFS server started at"))
                                    {
                                        let http_endpoint =
                                            http_endpoint.split_whitespace().last().unwrap();
                                        println!("HTTP endpoint: {http_endpoint}");
                                        tx.send(http_endpoint.to_string()).ok();
                                    }
                                }
                                *lines = lines
                                    .lines()
                                    .rev()
                                    .take(SRV_LOG_SIZE)
                                    .collect::<Vec<&str>>()
                                    .into_iter()
                                    .rev()
                                    .collect::<Vec<&str>>()
                                    .join("\n");
                            };
                        }
                    });

                    let mut stderr = child.stderr.take().unwrap();
                    let err_lines = lines.clone();
                    let err_thread = thread::spawn(move || {
                        let mut buffer = [0; SRV_BUFFER_SIZE];
                        loop {
                            let en = match stderr.read(&mut buffer[..]) {
                                Ok(0) => break,
                                Ok(n) => n,
                                Err(err) => {
                                    eprintln!("server stderr read error: {err}");
                                    break;
                                }
                            };
                            std::io::stderr().write_all(&buffer).ok();
                            let string_data = String::from_utf8_lossy(&buffer[..en]);
                            {
                                let lines = &mut *err_lines.lock().unwrap();
                                *lines += string_data.deref();
                                *lines = lines
                                    .lines()
                                    .rev()
                                    .take(SRV_LOG_SIZE)
                                    .collect::<Vec<&str>>()
                                    .into_iter()
                                    .rev()
                                    .collect::<Vec<&str>>()
                                    .join("\n");
                            };
                        }
                    });
                    out_thread.join().ok();
                    err_thread.join().ok();
                    stop_poll.store(true, Ordering::SeqCst);
                    poll.join().ok();
                    clear_pid(&server_pid);
                    if !http_ready.load(Ordering::SeqCst) && attempt < 3 {
                        eprintln!(
                        "Stremio server exited before accepting connections (attempt {attempt})"
                    );
                        thread::sleep(Duration::from_millis(400));
                        continue;
                    }
                }
                Err(err) => {
                    nwg::error_message(
                        "Stremio server",
                        format!("Cannot execute stremio-runtime: {}", &err).as_str(),
                    );
                }
            }
            break;
        }

        {
            let mut logs = logs.lock().unwrap();
            *logs = lines.lock().unwrap().deref().to_string();
        }
        println!("Server terminated.");
        crash_sender.notice();
    });
}

impl StremioServer {
    /**
     * True when EngineFS on :11470 answers HTTP GET /settings.
     */
    pub fn is_engine_reachable() -> bool {
        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .no_proxy()
            .build()
        {
            Ok(client) => client,
            Err(_) => return false,
        };
        match client.get(format!("http://{ENGINE_HOST}/settings")).send() {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    /**
     * Spawn the streaming server on a background thread without blocking the UI.
     *
     * Call [`Self::wait_ready`] after the main window is visible (e.g. from OnInit)
     * so splash can paint while EngineFS starts.
     */
    pub fn start(&self) {
        if self.development {
            return;
        }
        spawn_server_thread(
            self.logs.clone(),
            self.crash_notice.sender(),
            self.ready_rx.clone(),
            self.server_pid.clone(),
            self.webui_pid.clone(),
        );
    }

    /**
     * Block until EngineFS reports ready, or until `timeout` elapses.
     *
     * Intended to run after the main window is shown so startup does not feel frozen.
     */
    pub fn wait_ready(&self, timeout: Duration) {
        if self.development {
            return;
        }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if Self::is_engine_reachable() {
                println!("Stremio server ready at http://{ENGINE_HOST}");
                return;
            }
            thread::sleep(Duration::from_millis(200));
        }
        eprintln!(
            "Timed out waiting for Stremio server after {}ms; continuing startup",
            timeout.as_millis()
        );
    }
}

impl PartialUi for StremioServer {
    fn build_partial<W: Into<nwg::ControlHandle>>(
        data: &mut Self,
        parent: Option<W>,
    ) -> Result<(), nwg::NwgError> {
        if std::env::var(STREMIO_SERVER_DEV_MODE).unwrap_or("false".to_string()) == "true" {
            data.development = true;
        }

        data.parent = parent.expect("No parent window").into();

        nwg::Notice::builder()
            .parent(data.parent)
            .build(&mut data.crash_notice)
            .ok();
        // Non-blocking: wait_ready() runs from MainWindow::on_init after the window is visible.
        data.start();
        println!("Stremio server spawning");
        Ok(())
    }
    fn process_event<'a>(
        &self,
        evt: nwg::Event,
        _evt_data: &nwg::EventData,
        handle: nwg::ControlHandle,
    ) {
        use nwg::Event as E;
        if evt == E::OnNotice && handle == self.crash_notice.handle {
            nwg::modal_error_message(
                self.parent,
                "Stremio server crash log",
                self.logs.lock().unwrap().deref(),
            );
            self.start();
            self.wait_ready(Duration::from_secs(15));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::listening_pids;

    #[test]
    fn listening_pids_ignores_established_and_other_ports() {
        let netstat = "\
  TCP    127.0.0.1:11470        127.0.0.1:54000        HERGESTELLT     999\n\
  TCP    127.0.0.1:11470        0.0.0.0:0              ABHÖREN         4321\n\
  TCP    127.0.0.1:11475        0.0.0.0:0              ABHÖREN         111\n\
  TCP    [::1]:11470            [::]:0                 LISTENING       4321\n\
  TCP    0.0.0.0:11470          0.0.0.0:0              LISTENING       4\n";
        assert_eq!(listening_pids(netstat, 11470), vec![4321]);
    }
}
