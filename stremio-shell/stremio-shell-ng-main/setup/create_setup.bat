@echo off
set mypath=%~dp0

if not exist "%mypath%..\target\x86_64-pc-windows-msvc\release\mystremio-shell.exe" (
    echo Build mystremio-shell first: ..\build-custom.ps1
    exit /b 1
)

"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" "%mypath%MyStremio.iss"
