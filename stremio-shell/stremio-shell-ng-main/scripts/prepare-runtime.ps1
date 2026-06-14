# Copies Stremio streaming-server runtime files next to the built shell executable.
param(
    [string]$OutputDir = (Join-Path $PSScriptRoot "..\target\x86_64-pc-windows-msvc\release"),
    [string]$SourceDir = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)

$RuntimeFiles = @(
    "stremio-runtime.exe",
    "ffmpeg.exe",
    "ffprobe.exe",
    "avcodec-58.dll",
    "avdevice-58.dll",
    "avfilter-7.dll",
    "avformat-58.dll",
    "avutil-56.dll",
    "postproc-55.dll",
    "swresample-3.dll",
    "swscale-5.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll"
)

function Resolve-RuntimeSource {
    param([string]$Preferred)

    $Candidates = @()
    if ($Preferred) {
        $Candidates += $Preferred
    }

    $Candidates += @(
        (Join-Path $env:LOCALAPPDATA "Programs\Stremio")
    )

    foreach ($Candidate in $Candidates) {
        if (-not $Candidate) { continue }
        $RuntimeExe = Join-Path $Candidate "stremio-runtime.exe"
        if (Test-Path $RuntimeExe) {
            return (Resolve-Path $Candidate).Path
        }
    }

    throw @"
Runtime source not found.

Install Stremio Desktop once, or pass -SourceDir to a folder containing:
  stremio-runtime.exe, ffmpeg.exe, ffprobe.exe, and the ffmpeg DLLs.

Default search path:
  $env:LOCALAPPDATA\Programs\Stremio
"@
}

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$Source = Resolve-RuntimeSource -Preferred $SourceDir
Write-Host "Runtime source: $Source"
Write-Host "Output dir:     $OutputDir"

foreach ($File in $RuntimeFiles) {
    $From = Join-Path $Source $File
    if (-not (Test-Path $From)) {
        throw "Missing runtime file in source: $From"
    }
    Copy-Item -Path $From -Destination (Join-Path $OutputDir $File) -Force
}

# Patched server.js from this repo (localhost baseUrl fix).
$ServerJs = Join-Path $ProjectRoot "server.js"
if (-not (Test-Path $ServerJs)) {
    throw "Missing patched server.js in project root: $ServerJs"
}
Copy-Item -Path $ServerJs -Destination (Join-Path $OutputDir "server.js") -Force

# libmpv DLL: build.rs extracts/copies it to project root during cargo build.
$LibMpvCandidates = @(
    (Join-Path $ProjectRoot "libmpv-2.dll"),
    (Join-Path $Source "libmpv-2.dll")
)
$LibMpvCopied = $false
foreach ($LibMpv in $LibMpvCandidates) {
    if (Test-Path $LibMpv) {
        Copy-Item -Path $LibMpv -Destination (Join-Path $OutputDir "libmpv-2.dll") -Force
        Write-Host "Copied libmpv-2.dll from $LibMpv"
        $LibMpvCopied = $true
        break
    }
}
if (-not $LibMpvCopied) {
    Write-Warning "libmpv-2.dll not found yet. Run 'cargo build --release' first, or copy it manually."
}

Write-Host "Runtime files prepared in $OutputDir"

& (Join-Path $PSScriptRoot "sync-custom-assets.ps1") -ReleaseDir $OutputDir -SkipAppData
