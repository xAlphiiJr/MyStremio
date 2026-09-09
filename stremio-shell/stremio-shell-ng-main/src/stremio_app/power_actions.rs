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
