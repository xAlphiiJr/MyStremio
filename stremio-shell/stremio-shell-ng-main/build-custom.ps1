# Build MyStremio shell (requires MSVC Build Tools).
param(
    [string]$Target = "x86_64-pc-windows-msvc",
    [switch]$SkipShortcut
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$ReleaseDir = Join-Path $ProjectRoot "target\$Target\release"

function Ensure-Cargo {
    if (Get-Command cargo -ErrorAction SilentlyContinue) {
        return
    }
    $CargoBin = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
    if (Test-Path $CargoBin) {
        $env:Path = "$(Split-Path $CargoBin);$env:Path"
        return
    }
    throw "Rust/Cargo not found. Install from https://rustup.rs/"
}

function Get-VcVarsBat {
    $VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $VsWhere)) {
        throw "vswhere.exe not found. Install Visual Studio Build Tools with the C++ workload."
    }

    $VsPath = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $VsPath) {
        throw "MSVC toolchain not found. Install Visual Studio Build Tools with the C++ workload."
    }

    return (Join-Path $VsPath "VC\Auxiliary\Build\vcvars64.bat")
}

Ensure-Cargo
$VcVars = Get-VcVarsBat
$TargetDir = Join-Path $ProjectRoot "target"

$BuildCmd = @(
    "call `"$VcVars`"",
    "set PATH=%USERPROFILE%\.cargo\bin;%PATH%",
    "set `"CARGO_TARGET_DIR=$TargetDir`"",
    "cd /d `"$ProjectRoot`"",
    "cargo build --release --target $Target"
) -join " && "

Write-Host "Building mystremio-shell ($Target)..."
cmd /c $BuildCmd

& (Join-Path $ProjectRoot "scripts\prepare-runtime.ps1") -OutputDir $ReleaseDir

if (-not $SkipShortcut) {
    & (Join-Path $ProjectRoot "scripts\create-desktop-shortcut.ps1") -ReleaseDir $ReleaseDir
}

Write-Host "Build complete: $(Join-Path $ReleaseDir 'mystremio-shell.exe')"
