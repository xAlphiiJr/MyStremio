# Build MyStremio and package the Windows installer (self-contained, no portable zip).
param(
    [string]$Target = "x86_64-pc-windows-msvc",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $ProjectRoot "..\..")).Path
$ReleaseDir = Join-Path $ProjectRoot "target\$Target\release"
$OutputDir = Join-Path $RepoRoot "release"
$CargoToml = Join-Path $ProjectRoot "Cargo.toml"
$ExeName = "mystremio-shell.exe"

function Get-AppVersion {
    $line = Select-String -Path $CargoToml -Pattern '^version\s*=' | Select-Object -First 1
    if (-not $line) { throw "Could not read version from Cargo.toml" }
    return ($line.Line -replace '.*=\s*"([^"]+)".*', '$1').Trim()
}

function Find-InnoSetup {
    $paths = @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    )
    foreach ($path in $paths) {
        if (Test-Path $path) { return $path }
    }

    $uninstallRoots = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    foreach ($root in $uninstallRoots) {
        $entry = Get-ItemProperty $root -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like "Inno Setup*" } |
            Select-Object -First 1
        if ($entry -and $entry.InstallLocation) {
            $candidate = Join-Path $entry.InstallLocation.TrimEnd('\') "ISCC.exe"
            if (Test-Path $candidate) { return $candidate }
        }
    }

    return $null
}

$Version = Get-AppVersion
$SetupName = "MyStremioSetup-v${Version}_x64.exe"
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}
$SetupPath = Join-Path $OutputDir $SetupName

if (-not $SkipBuild) {
    & (Join-Path $ProjectRoot "build-custom.ps1") -Target $Target -SkipShortcut
}

$ExePath = Join-Path $ReleaseDir $ExeName
if (-not (Test-Path $ExePath)) {
    throw "Release build missing: $ExePath"
}

if (-not (Test-Path (Join-Path $ReleaseDir "plugins"))) {
    throw "Release folder missing plugins/. Run build-custom.ps1 first."
}

$Inno = Find-InnoSetup
if ($Inno) {
    $Iss = Join-Path $ProjectRoot "setup\MyStremio.iss"
    Write-Host "Building installer with Inno Setup..."
    & $Inno $Iss
    if (-not (Test-Path $SetupPath)) {
        throw "Installer build failed: $SetupPath"
    }
    Write-Host "Installer: $SetupPath"
} else {
    throw @"
Inno Setup 6 not found. Install it from https://jrsoftware.org/isinfo.php
(or: winget install JRSoftware.InnoSetup), then rerun package-release.ps1.
"@
}

$ChecksumPath = Join-Path $OutputDir "SHA256SUMS.txt"
$hash = (Get-FileHash -Path $SetupPath -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $SetupName" | Set-Content -Path $ChecksumPath -Encoding UTF8

Get-ChildItem $OutputDir -File | Where-Object {
    ($_.Name -like 'MyStremioSetup-v*_x64.exe' -and $_.Name -ne $SetupName) -or
    ($_.Name -like 'StremioCustomSetup-v*_x64.exe') -or
    ($_.Name -like 'StremioCustom-v*-win64.zip') -or
    ($_.Name -like 'MyStremio-v*-win64.zip')
} | ForEach-Object {
    Remove-Item $_.FullName -Force
    Write-Host "Removed old release: $($_.Name)"
}

Write-Host ""
Write-Host "Release artifacts in $OutputDir"
Get-ChildItem $OutputDir -File | ForEach-Object {
    Write-Host "  $($_.Name) ($([math]::Round($_.Length / 1MB, 2)) MB)"
}
Write-Host ""
Write-Host "Install path: $env:LOCALAPPDATA\Programs\MyStremio"
Write-Host "User data:    $env:APPDATA\MyStremio"
Write-Host ""
Write-Host "Upload $SetupName to GitHub Releases - users only need this one file."
