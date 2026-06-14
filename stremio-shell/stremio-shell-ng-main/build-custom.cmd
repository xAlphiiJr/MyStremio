@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-custom.ps1" %*
if errorlevel 1 (
  echo.
  pause
)
