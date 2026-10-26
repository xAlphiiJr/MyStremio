use std::ptr;
use winapi::shared::minwindef::FALSE;
use winapi::um::handleapi::CloseHandle;
use winapi::um::powrprof::SetSuspendState;
use winapi::um::processthreadsapi::{GetCurrentProcess, OpenProcessToken};
use winapi::um::securitybaseapi::AdjustTokenPrivileges;
use winapi::um::winbase::LookupPrivilegeValueW;
use winapi::um::winnt::{
    LUID, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES,
    TOKEN_QUERY,
};
use winapi::um::winuser::{ExitWindowsEx, EWX_FORCEIFHUNG, EWX_REBOOT, EWX_SHUTDOWN};

const SHTDN_REASON_FLAG_PLANNED: u32 = 0x8000_0000;

/**
 * Enable `SeShutdownPrivilege` so sleep / shutdown / restart succeed.
 */
fn enable_shutdown_privilege() -> bool {
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        ) == 0
        {
            return false;
        }
        let mut luid = LUID {
            LowPart: 0,
            HighPart: 0,
        };
        let name: Vec<u16> = "SeShutdownPrivilege\0".encode_utf16().collect();
        if LookupPrivilegeValueW(ptr::null(), name.as_ptr(), &mut luid) == 0 {
            CloseHandle(token);
            return false;
        }
        let mut privileges = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        let ok = AdjustTokenPrivileges(
            token,
            FALSE,
            &mut privileges,
            0,
            ptr::null_mut(),
            ptr::null_mut(),
        );
        CloseHandle(token);
        ok != 0
    }
}

/**
 * Sleep the PC (S3), not hibernate. Requires shutdown privilege.
 */
pub fn sleep_pc() -> Result<(), String> {
    if !enable_shutdown_privilege() {
        return Err("Could not enable shutdown privilege".to_string());
    }
    let ok = unsafe { SetSuspendState(0, 0, 0) };
    if ok != 0 {
        Ok(())
    } else {
        Err("SetSuspendState failed".to_string())
    }
}

/**
 * Shut down or reboot the PC. `restart` selects reboot vs power-off.
 */
pub fn exit_windows(restart: bool) -> Result<(), String> {
    if !enable_shutdown_privilege() {
        return Err("Could not enable shutdown privilege".to_string());
    }
    let flags = if restart {
        EWX_REBOOT | EWX_FORCEIFHUNG
    } else {
        EWX_SHUTDOWN | EWX_FORCEIFHUNG
    };
    let ok = unsafe { ExitWindowsEx(flags, SHTDN_REASON_FLAG_PLANNED) };
    if ok != 0 {
        Ok(())
    } else {
        Err("ExitWindowsEx failed".to_string())
    }
}

/**
 * Apply an allowlisted power action. `close` is handled by the window quit path.
 */
pub fn apply(action: &str) -> Result<(), String> {
    match action {
        "sleep" => sleep_pc(),
        "shutdown" => exit_windows(false),
        "restart" => exit_windows(true),
        other => Err(format!("Unsupported power action: {other}")),
    }
}

/**
 * One power action, optional `close`. Two different power actions are rejected.
 * Canonical form is `sleep`, `shutdown`, `restart`, `close`, or `sleep,close`.
 */
pub fn parse_actions(raw: &str) -> Option<String> {
    let mut close = false;
    let mut power: Option<&str> = None;
    let mut saw = false;
    for part in raw.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        saw = true;
        match part {
            "close" => close = true,
            "sleep" | "shutdown" | "restart" => {
                if let Some(existing) = power {
                    if existing != part {
                        return None;
                    }
                }
                power = Some(part);
            }
            _ => return None,
        }
    }
    if !saw {
        return None;
    }
    match (power, close) {
        (Some(power), true) => Some(format!("{power},close")),
        (Some(power), false) => Some(power.to_string()),
        (None, true) => Some("close".to_string()),
        (None, false) => None,
    }
}

/// `SetSuspendState` blocks until resume, so sleep-and-close runs in a child
/// that waits until this process has exited.
pub fn spawn_sleep_after_exit() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let pid = std::process::id().to_string();
    let args = ["--sleep-now", "--sleep-parent", pid.as_str()];
    spawn_detached(&exe, &args).map_err(|err| format!("Could not start sleep: {err}"))
}

pub fn sleep_after_parent(pid: u32) {
    wait_until_dead(pid);
    let _ = sleep_pc();
}

fn spawn_detached(exe: &std::path::Path, args: &[&str]) -> std::io::Result<()> {
    use winapi::um::winbase::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, DETACHED_PROCESS};

    let flags = CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW | DETACHED_PROCESS;
    if start_detached(exe, args, flags).is_ok() {
        return Ok(());
    }
    start_detached(exe, args, CREATE_NO_WINDOW | DETACHED_PROCESS).map(|_| ())
}

fn start_detached(
    exe: &std::path::Path,
    args: &[&str],
    flags: u32,
) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    Command::new(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(flags)
        .spawn()
}

fn wait_until_dead(pid: u32) {
    if pid == 0 {
        return;
    }
    use std::thread;
    use std::time::{Duration, Instant};
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;
    // shortcut: stop waiting after 3s, upgrade if exit ever takes longer than that.
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
            if handle.is_null() {
                return;
            }
            CloseHandle(handle);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::parse_actions;

    #[test]
    fn parse_actions_joins_sleep_and_close() {
        assert_eq!(parse_actions("close,sleep").as_deref(), Some("sleep,close"));
        assert_eq!(
            parse_actions("shutdown,close").as_deref(),
            Some("shutdown,close")
        );
        assert_eq!(parse_actions("sleep").as_deref(), Some("sleep"));
        assert_eq!(parse_actions("close").as_deref(), Some("close"));
    }

    #[test]
    fn parse_actions_rejects_unknown_and_conflicting_power() {
        assert_eq!(parse_actions("sleep,nope"), None);
        assert_eq!(parse_actions("sleep,shutdown"), None);
        assert_eq!(parse_actions(""), None);
    }
}
