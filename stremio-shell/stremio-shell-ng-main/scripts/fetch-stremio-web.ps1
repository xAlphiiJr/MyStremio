#Requires -Version 5.1
# Clone stock stremio-web into repo-root .tmp/stremio-web for a clean Web UI rebuild.
param(
    [string]$Repo = "https://github.com/Stremio/stremio-web.git",
    [string]$Ref = ""
)

$ErrorActionPreference = "Stop"
$ScriptRoot = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $ScriptRoot
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "..\.."))
$Dest = Join-Path $RepoRoot ".tmp\stremio-web"

if (-not (Test-Path (Join-Path $Dest ".git"))) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Dest) | Out-Null
    if ($Ref) {
        git clone --depth 1 --branch $Ref $Repo $Dest
    } else {
        git clone --depth 1 $Repo $Dest
    }
} else {
    git -C $Dest fetch --depth 1 origin
    if ($Ref) {
        git -C $Dest checkout --force $Ref
    } else {
        git -C $Dest checkout --force
        git -C $Dest pull --ff-only
    }
}

Write-Host "stremio-web source is at $Dest"
Write-Host "Next: scripts/build-webui.ps1 (copies a clean build into webui/, then applies patches.json)"
