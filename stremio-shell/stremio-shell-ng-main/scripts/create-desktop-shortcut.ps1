# Creates a desktop shortcut for MyStremio.
param(
    [string]$ReleaseDir = (Join-Path $PSScriptRoot "..\target\x86_64-pc-windows-msvc\release"),
    [string]$ShortcutName = "MyStremio.lnk"
)

$ErrorActionPreference = "Stop"
$ReleaseDir = [System.IO.Path]::GetFullPath($ReleaseDir)
$ExePath = Join-Path $ReleaseDir "mystremio-shell.exe"

if (-not (Test-Path $ExePath)) {
    throw "Executable not found: $ExePath`nRun .\build-custom.ps1 first."
}

$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop $ShortcutName
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $ExePath
$Shortcut.WorkingDirectory = $ReleaseDir
$Shortcut.Arguments = "--dev-tools"
$Shortcut.Description = "MyStremio - Freedom to Stream"
$Shortcut.Save()

Write-Host "Desktop shortcut created: $ShortcutPath"
