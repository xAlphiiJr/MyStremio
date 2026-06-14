# Build (optional) and start MyStremio shell with dev tools.
# Hinweis: In PowerShell nicht .\run.ps1 direkt ausfuehren (ExecutionPolicy).
# Stattdessen: run.cmd -SkipBuild  oder  powershell -ExecutionPolicy Bypass -File .\run.ps1
param(
    [switch]$SkipBuild,
    [switch]$NoDevTools
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$Target = "x86_64-pc-windows-msvc"
$ReleaseDir = Join-Path $ProjectRoot "target\$Target\release"
$ExeName = "mystremio-shell.exe"
$ExePath = Join-Path $ReleaseDir $ExeName

function Ensure-Cargo {
    if (Get-Command cargo -ErrorAction SilentlyContinue) {
        return
    }

    $CargoBin = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
    if (Test-Path $CargoBin) {
        $env:Path = "$(Split-Path $CargoBin);$env:Path"
        return
    }

    throw @"
Rust/Cargo not found in PATH.

Install from https://rustup.rs/ (stable, MSVC toolchain), then reopen the terminal and run:
  cargo build --release --target $Target
"@
}

if (-not $SkipBuild) {
    Ensure-Cargo
    Push-Location $ProjectRoot
    try {
        cargo build --release --target $Target
    } finally {
        Pop-Location
    }
} else {
    Write-Host "SkipBuild: using existing $ExeName (custom JS/CSS in assets/ needs a full build to update)." -ForegroundColor Yellow
}

& (Join-Path $ProjectRoot "scripts\prepare-runtime.ps1") -OutputDir $ReleaseDir

if (-not (Test-Path $ExePath)) {
    throw "Executable not found: $ExePath"
}

$Args = @()
if (-not $NoDevTools) {
    $Args += "--dev-tools"
}

Write-Host "Starting $ExePath $($Args -join ' ')"
Start-Process -FilePath $ExePath -ArgumentList $Args -WorkingDirectory $ReleaseDir

# Ensure desktop shortcut exists after first successful run.
$ShortcutScript = Join-Path $ProjectRoot "scripts\create-desktop-shortcut.ps1"
if (Test-Path $ShortcutScript) {
    try {
        & $ShortcutScript -ReleaseDir $ReleaseDir | Out-Null
    } catch {
        Write-Warning "Could not create desktop shortcut: $_"
    }
}
