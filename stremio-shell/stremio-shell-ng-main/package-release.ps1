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

function Sync-ReleaseArtifacts {
    param([string]$ReleaseDirectory)

    if (-not $env:MYSTREMIO_ASSET_SOURCE_ROOT) {
        $env:MYSTREMIO_ASSET_SOURCE_ROOT = Join-Path $RepoRoot "assets-bundle"
    }

    Write-Host "Refreshing release artifacts before packaging..."
    & (Join-Path $ProjectRoot "scripts\sync-custom-assets.ps1") `
        -ReleaseDir $ReleaseDirectory `
        -SourceRoot $env:MYSTREMIO_ASSET_SOURCE_ROOT

    # Always rebuild/copy web UI so -SkipBuild and full builds package the same fresh bundle.
    & (Join-Path $ProjectRoot "scripts\build-webui.ps1")

    $WebUiDir = Join-Path $ProjectRoot "webui"
    $WebUiOut = Join-Path $ReleaseDirectory "webui"
    if (-not (Test-Path $WebUiDir)) {
        throw "Web UI missing. Expected build output at $WebUiDir"
    }
    if (Test-Path $WebUiOut) {
        Remove-Item $WebUiOut -Recurse -Force
    }
    New-Item -ItemType Directory -Path $WebUiOut -Force | Out-Null
    Copy-Item -Path (Join-Path $WebUiDir "*") -Destination $WebUiOut -Recurse -Force
    Write-Host "Synced web UI to $WebUiOut"
}

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

Sync-ReleaseArtifacts -ReleaseDirectory $ReleaseDir

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
# Write UTF-8 without BOM so the updater can parse the first hash cleanly.
$checksumLine = "$hash  $SetupName"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($ChecksumPath, ($checksumLine + [Environment]::NewLine), $utf8NoBom)

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
