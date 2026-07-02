$ErrorActionPreference = "Stop"

$ScriptRoot = $PSScriptRoot
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptRoot ".."))
$SourceWebUi = Join-Path $ProjectRoot "webui"
$InstallRoot = Join-Path $env:LOCALAPPDATA "Programs\MyStremio"
$InstallWebUi = Join-Path $InstallRoot "webui"
$WebViewRoot = Join-Path $env:APPDATA "MyStremio\WebView2"

if (-not (Test-Path $SourceWebUi)) {
    throw "Source web UI missing at $SourceWebUi. Build or restore the repo webui folder first."
}
if (-not (Test-Path $InstallRoot)) {
    throw "MyStremio is not installed at $InstallRoot"
}

Write-Host "Stopping MyStremio if it is running..."
Get-Process mystremio-shell -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host "Copying repaired web UI to $InstallWebUi"
if (Test-Path $InstallWebUi) {
    Remove-Item $InstallWebUi -Recurse -Force
}
New-Item -ItemType Directory -Path $InstallWebUi -Force | Out-Null
Copy-Item -Path (Join-Path $SourceWebUi "*") -Destination $InstallWebUi -Recurse -Force

$mainJs = Get-ChildItem -Path $InstallWebUi -Recurse -Filter main.js | Select-Object -First 1
if (-not $mainJs) {
    throw "Installed web UI copy is missing main.js"
}

python (Join-Path $ScriptRoot "verify-webui-main.js.py") $mainJs.FullName
if ($LASTEXITCODE -ne 0) {
    throw "Installed main.js failed verification"
}

if (Test-Path $WebViewRoot) {
    Write-Host "Clearing stale WebView2 cache at $WebViewRoot"
    Remove-Item $WebViewRoot -Recurse -Force
}

Write-Host "Repair complete. Start MyStremio from the Start menu."
