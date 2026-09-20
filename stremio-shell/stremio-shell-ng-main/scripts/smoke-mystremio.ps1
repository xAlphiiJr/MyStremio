#Requires -Version 5.1
# Smoke-check injected modules, bundled plugins, and web UI patch markers.
# Sleep/resume of EngineFS + MPV + WebView is listed as a manual check (cannot be done in CI).
param(
    [string]$ProjectRoot = (Join-Path $PSScriptRoot "..")
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "..\.."))
$AssetsDir = Join-Path $ProjectRoot "assets"
$WebUiDir = Join-Path $ProjectRoot "webui"
$WebViewRs = Join-Path $ProjectRoot "src\stremio_app\stremio_wevbiew\wevbiew.rs"
$PluginsRoot = Join-Path $RepoRoot "assets-bundle\plugins"

$failed = New-Object System.Collections.Generic.List[string]

function Add-Fail([string]$Message) {
    $failed.Add($Message)
    Write-Host "FAIL: $Message"
}

if (-not (Test-Path $WebViewRs)) {
    throw "Missing $WebViewRs"
}

$moduleRefs = Select-String -Path $WebViewRs -Pattern 'include_str!\("../../../assets/(custom_[^"]+\.js)"\)' |
    ForEach-Object { $_.Matches[0].Groups[1].Value } |
    Sort-Object -Unique

if ($moduleRefs.Count -lt 30) {
    Add-Fail "Expected 30+ injected custom_*.js modules in wevbiew.rs, found $($moduleRefs.Count)"
}

foreach ($rel in $moduleRefs) {
    $path = Join-Path $AssetsDir $rel
    if (-not (Test-Path $path)) {
        Add-Fail "Missing injected module: $rel"
    }
}

if (-not (Test-Path $PluginsRoot)) {
    Add-Fail "Missing bundled plugins at $PluginsRoot"
} else {
    $plugins = Get-ChildItem $PluginsRoot -Recurse -Filter "*.plugin.js"
    if ($plugins.Count -lt 10) {
        Add-Fail "Expected 10+ bundled plugins, found $($plugins.Count)"
    }
    foreach ($plugin in $plugins) {
        $text = Get-Content $plugin.FullName -Raw -ErrorAction SilentlyContinue
        if ([string]::IsNullOrWhiteSpace($text)) {
            Add-Fail "Empty plugin: $($plugin.FullName)"
        }
    }
}

$prebootSrc = Join-Path $AssetsDir "custom_preboot.js"
if (-not (Test-Path $prebootSrc)) {
    Add-Fail "Missing $prebootSrc"
}

$python = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
    $python = @('py', '-3')
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $python = @('python')
}

if (-not $python) {
    Add-Fail "Python 3 is required to verify web UI patches"
} elseif (-not (Test-Path (Join-Path $WebUiDir "index.html"))) {
    Add-Fail "Missing web UI at $WebUiDir"
} else {
    $apply = Join-Path $PSScriptRoot "apply-webui-patches.py"
    $exe = $python[0]
    $pyArgs = @()
    if ($python.Count -gt 1) {
        $pyArgs = $python[1..($python.Count - 1)]
    }
    & $exe @pyArgs $apply $WebUiDir "--verify-only"
    if ($LASTEXITCODE -ne 0) {
        Add-Fail "apply-webui-patches.py --verify-only failed with exit code $LASTEXITCODE"
    }
}

Write-Host ""
Write-Host "Manual sleep-resume checks (not run in CI):"
Write-Host "  1. Play a stream, sleep the PC for 2+ minutes, resume: picture, audio, EngineFS catalogs return without reload."
Write-Host "  2. Same after turning the display off and after Windows lock."
Write-Host "  3. Same from tray restore."

if ($failed.Count -gt 0) {
    throw "Smoke test failed with $($failed.Count) error(s)."
}

Write-Host "Smoke test passed: $($moduleRefs.Count) injected modules, bundled plugins, and web UI patch markers."
