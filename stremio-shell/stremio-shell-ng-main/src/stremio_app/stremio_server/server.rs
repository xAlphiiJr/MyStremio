use crate::stremio_app::constants::{SRV_BUFFER_SIZE, SRV_LOG_SIZE, STREMIO_SERVER_DEV_MODE};
use native_windows_gui::{self as nwg, PartialUi};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    env, fs,
    io::Read,
    net::TcpStream,
    ops::Deref,
    os::windows::process::CommandExt,
    path,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use winapi::um::{
    handleapi::CloseHandle,
    processthreadsapi::{GetCurrentProcess, OpenProcess, TerminateProcess},
    winbase::{CreateJobObjectA, CREATE_NO_WINDOW},
    winnt::{
        JobObjectExtendedLimitInformation, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        PROCESS_TERMINATE,
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
    /// Skip the crash modal and auto-restart when we killed the process on purpose.
    quiet_restart: Arc<AtomicBool>,
    recovering: Arc<AtomicBool>,
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

fn take_pid(slot: &Arc<Mutex<Option<u32>>>) -> Option<u32> {
    slot.lock().ok().and_then(|mut guard| guard.take())
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
        unsafe {
            let job_main_process = CreateJobObjectA(std::ptr::null_mut(), std::ptr::null_mut());
            let jeli = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
                BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                    LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                        | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
                        | JOB_OBJECT_LIMIT_BREAKAWAY_OK,
                    ..std::mem::zeroed()
                },
                ..std::mem::zeroed()
            };
            winapi::um::jobapi2::SetInformationJobObject(
                job_main_process,
                JobObjectExtendedLimitInformation,
                &jeli as *const _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            winapi::um::jobapi2::AssignProcessToJobObject(job_main_process, GetCurrentProcess());
        }
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

        if local_webui_available {
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

        let mut server_command = Command::new(runtime_path);
        server_command
            .arg(server_path)
            .env("NO_CORS", "1")
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if local_webui_available {
            server_command.env("WEBUI_LOCATION", local_webui_location);
        }

        match server_command.spawn() {
            Ok(mut child) => {
                store_pid(&server_pid, child.id());
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
                clear_pid(&server_pid);
            }
            Err(err) => {
                nwg::error_message(
                    "Stremio server",
                    format!("Cannot execute stremio-runtime: {}", &err).as_str(),
                );
            }
        };

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
     * True when EngineFS on :11470 accepts a TCP connection.
     */
    pub fn is_engine_reachable() -> bool {
        let Ok(addr) = ENGINE_HOST.parse() else {
            return false;
        };
        TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
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
     * After sleep/resume: probe EngineFS, respawn if sockets are dead, then notify UI.
     *
     * `ready` is signaled when the probe succeeds or a respawn attempt finishes.
     */
    pub fn recover_after_resume(&self, ready: nwg::NoticeSender) {
        if self.development {
            ready.notice();
            return;
        }
        if self.recovering.swap(true, Ordering::SeqCst) {
            return;
        }
        let logs = self.logs.clone();
        let crash_sender = self.crash_notice.sender();
        let ready_rx = self.ready_rx.clone();
        let server_pid = self.server_pid.clone();
        let webui_pid = self.webui_pid.clone();
        let quiet = self.quiet_restart.clone();
        let recovering = self.recovering.clone();

        thread::spawn(move || {
            thread::sleep(Duration::from_millis(800));
            if StremioServer::is_engine_reachable() {
                ready.notice();
                recovering.store(false, Ordering::SeqCst);
                drop((logs, crash_sender, ready_rx, server_pid, webui_pid, quiet));
                return;
            }

            quiet.store(true, Ordering::SeqCst);
            if let Some(pid) = take_pid(&server_pid) {
                terminate_pid(pid);
            }
            if let Some(pid) = take_pid(&webui_pid) {
                terminate_pid(pid);
            }
            thread::sleep(Duration::from_millis(400));

            if !StremioServer::is_engine_reachable() {
                spawn_server_thread(logs, crash_sender, ready_rx, server_pid, webui_pid);
            }

            for _ in 0..50 {
                if StremioServer::is_engine_reachable() {
                    break;
                }
                thread::sleep(Duration::from_millis(200));
            }
            ready.notice();
            thread::sleep(Duration::from_secs(3));
            quiet.store(false, Ordering::SeqCst);
            recovering.store(false, Ordering::SeqCst);
        });
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
        let rx = {
            let mut slot = self.ready_rx.lock().unwrap();
            slot.take()
        };
        let Some(rx) = rx else {
            return;
        };
        match rx.recv_timeout(timeout) {
            Ok(endpoint) => {
                println!("Stremio server ready at {endpoint}");
            }
            Err(flume::RecvTimeoutError::Timeout) => {
                eprintln!(
                    "Timed out waiting for Stremio server after {}ms; continuing startup",
                    timeout.as_millis()
                );
            }
            Err(flume::RecvTimeoutError::Disconnected) => {
                eprintln!("Stremio server thread ended before ready signal");
            }
        }
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
            if self.quiet_restart.load(Ordering::SeqCst) {
                return;
            }
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
