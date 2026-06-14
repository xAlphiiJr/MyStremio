# Copies plugins and themes from mystremio into the shell release folder.
# Release builds use -SkipAppData so personal AppData settings are never bundled.
param(
    [string]$SourceRoot = "",
    [string]$ReleaseDir = (Join-Path $PSScriptRoot "..\target\x86_64-pc-windows-msvc\release"),
    [switch]$SkipAppData
)

$ErrorActionPreference = "Stop"

if (-not $SourceRoot) {
    $MystremioRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\..\mystremio"))
    $LegacyRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\..\stremio-custom"))
    if (Test-Path $MystremioRoot) {
        $SourceRoot = $MystremioRoot
    } elseif (Test-Path $LegacyRoot) {
        $SourceRoot = $LegacyRoot
    } else {
        throw "Plugin/theme source not found. Expected mystremio/ or stremio-custom/ at repository root."
    }
}

$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)
$ReleaseDir = [System.IO.Path]::GetFullPath($ReleaseDir)

$PluginSource = Join-Path $SourceRoot "plugins"
$ThemeSource = Join-Path $SourceRoot "themes"
$PluginTargets = @(
    (Join-Path $ReleaseDir "plugins"),
    (Join-Path $env:APPDATA "MyStremio\plugins")
)
$ThemeTargets = @(
    (Join-Path $ReleaseDir "themes"),
    (Join-Path $env:APPDATA "MyStremio\themes")
)

function Copy-TreeIfExists {
    param(
        [string]$Source,
        [string]$Destination
    )

    if (-not (Test-Path $Source)) {
        Write-Warning "Missing source: $Source"
        return
    }

    if (Test-Path $Destination) {
        Remove-Item $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null

    Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force
    Write-Host "Synced $Source -> $Destination"
}

function Sanitize-PluginConfigs {
    param([string]$PluginsDir)

    if (-not (Test-Path $PluginsDir)) { return }

    Get-ChildItem $PluginsDir -Recurse -Filter "*.plugin.json" | ForEach-Object {
        try {
            $raw = Get-Content $_.FullName -Raw -Encoding UTF8
            if ([string]::IsNullOrWhiteSpace($raw)) { return }
            $json = $raw | ConvertFrom-Json
            $changed = $false

            foreach ($key in @('tidb_api_key', 'tmdb_api_key', 'rpdb_api_key', 'api_key', 'apiKey')) {
                if ($json.PSObject.Properties.Name -contains $key -and $json.$key) {
                    $json.$key = ''
                    $changed = $true
                }
            }

            if ($changed) {
                $json | ConvertTo-Json -Depth 10 | Set-Content $_.FullName -Encoding UTF8
                Write-Host "Sanitized secrets in $($_.Name)"
            }
        } catch {
            Write-Warning "Could not sanitize $($_.FullName): $_"
        }
    }
}

if (-not (Test-Path $PluginSource)) {
    throw "Plugin source not found: $PluginSource"
}
if (-not (Test-Path $ThemeSource)) {
    throw "Theme source not found: $ThemeSource"
}

foreach ($target in $PluginTargets) {
    if ($SkipAppData -and $target -like "$env:APPDATA*") { continue }
    Copy-TreeIfExists -Source $PluginSource -Destination $target
    if ($target -eq (Join-Path $ReleaseDir "plugins")) {
        Sanitize-PluginConfigs -PluginsDir $target
    }
}

foreach ($target in $ThemeTargets) {
    if ($SkipAppData -and $target -like "$env:APPDATA*") { continue }
    Copy-TreeIfExists -Source $ThemeSource -Destination $target
}

Write-Host "Custom assets synced."
