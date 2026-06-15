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
    if ((Test-Path (Join-Path $MystremioRoot "plugins")) -or (Test-Path (Join-Path $MystremioRoot "themes"))) {
        $SourceRoot = $MystremioRoot
    } elseif ((Test-Path (Join-Path $LegacyRoot "plugins")) -or (Test-Path (Join-Path $LegacyRoot "themes"))) {
        $SourceRoot = $LegacyRoot
    } else {
        $SourceRoot = ""
    }
}

$SourceRoot = if ($SourceRoot) { [System.IO.Path]::GetFullPath($SourceRoot) } else { "" }
$ReleaseDir = [System.IO.Path]::GetFullPath($ReleaseDir)

$PluginSource = if ($SourceRoot) { Join-Path $SourceRoot "plugins" } else { "" }
$ThemeSource = if ($SourceRoot) { Join-Path $SourceRoot "themes" } else { "" }
$PluginTargets = @(
    (Join-Path $ReleaseDir "plugins"),
    (Join-Path $env:APPDATA "MyStremio\plugins")
)
$ThemeTargets = @(
    (Join-Path $ReleaseDir "themes"),
    (Join-Path $env:APPDATA "MyStremio\themes")
)

function Resolve-FallbackSource {
    param(
        [string]$Kind,
        [string]$ReleaseDir
    )
    $candidates = @(
        (Join-Path $env:APPDATA "MyStremio\$Kind"),
        (Join-Path (Join-Path $PSScriptRoot "..") $Kind),
        (Join-Path $ReleaseDir $Kind),
        (Join-Path $env:USERPROFILE "Downloads\StremioCustom-v2.0.0-win64\$Kind"),
        (Join-Path $env:USERPROFILE "Downloads\MyStremio-v2.1.0-win64\$Kind")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            $hasFiles = (Get-ChildItem -Path $candidate -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1)
            if ($hasFiles) {
                return [System.IO.Path]::GetFullPath($candidate)
            }
        }
    }
    return $null
}

function Copy-TreeIfExists {
    param(
        [string]$Source,
        [string]$Destination
    )

    if (-not (Test-Path $Source)) {
        Write-Warning "Missing source: $Source"
        return
    }

    $srcFull = [System.IO.Path]::GetFullPath($Source)
    $dstFull = [System.IO.Path]::GetFullPath($Destination)
    if ($srcFull -eq $dstFull) {
        Write-Warning "Skipping sync because source equals destination: $srcFull"
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

function Patch-ContextMenuFixPlugin {
    param([string]$PluginsDir)

    if (-not (Test-Path $PluginsDir)) { return }
    $pluginPath = Join-Path $PluginsDir "interface\context-menu-fix.plugin.js"
    if (-not (Test-Path $pluginPath)) { return }

    try {
        $raw = Get-Content $pluginPath -Raw -Encoding UTF8
        if (-not $raw) { return }

        $needle = "if (isNavMenu) {"
        $guard = "return; // Keep profile menu native/clickable"
        if ($raw -like "*$needle*" -and $raw -notlike "*$guard*") {
            $replacement = "if (isNavMenu) {`r`n            $guard`r`n        }`r`n`r`n        if (false && isNavMenu) {"
            $patched = $raw.Replace($needle, $replacement)
            if ($patched -ne $raw) {
                Set-Content -Path $pluginPath -Value $patched -Encoding UTF8
                Write-Host "Patched context-menu-fix plugin to skip profile menu cloning."
            }
        }
    } catch {
        Write-Warning "Could not patch context-menu-fix plugin: $_"
    }
}

function Ensure-StreamUiSchema {
    param([string]$PluginsDir)

    if (-not (Test-Path $PluginsDir)) { return }
    $schemaSource = Join-Path (Join-Path $PSScriptRoot "..\assets") "stream-ui.plugin.schema.json"
    if (-not (Test-Path $schemaSource)) { return }
    $schemaTarget = Join-Path $PluginsDir "stream-ui.plugin.schema.json"

    try {
        Copy-Item -Path $schemaSource -Destination $schemaTarget -Force
        Write-Host "Ensured Stream UI schema in $PluginsDir"
    } catch {
        Write-Warning ("Could not copy Stream UI schema to " + $PluginsDir + ": " + $_)
    }
}

function Patch-StreamUiPlugin {
    param([string]$PluginsDir)

    if (-not (Test-Path $PluginsDir)) { return }
    $pluginPath = Join-Path $PluginsDir "player\stream-ui.plugin.js"
    if (-not (Test-Path $pluginPath)) { return }

    try {
        $raw = Get-Content $pluginPath -Raw -Encoding UTF8
        if (-not $raw) { return }
        $patched = $raw
        $patched = $patched.Replace(
            "acc.className = GROUP + (open ? ' open' : '');",
            "acc.className = GROUP + ' open';"
        )
        $patched = $patched.Replace(
            'aria-expanded="${open ? ''true'' : ''false''}"',
            'aria-expanded="true"'
        )
        if ($patched -ne $raw) {
            Set-Content -Path $pluginPath -Value $patched -Encoding UTF8
            Write-Host "Patched Stream UI plugin to keep accordions expanded by default."
        }
    } catch {
        Write-Warning ("Could not patch Stream UI plugin in " + $PluginsDir + ": " + $_)
    }
}

if (-not $PluginSource -or -not (Test-Path $PluginSource)) {
    $fallback = Resolve-FallbackSource -Kind "plugins" -ReleaseDir $ReleaseDir
    if ($fallback) {
        Write-Warning "Plugin source not found at '$PluginSource'. Using fallback '$fallback'."
        $PluginSource = $fallback
    } else {
        throw "Plugin source not found: $PluginSource"
    }
}
if (-not $ThemeSource -or -not (Test-Path $ThemeSource)) {
    $fallback = Resolve-FallbackSource -Kind "themes" -ReleaseDir $ReleaseDir
    if ($fallback) {
        Write-Warning "Theme source not found at '$ThemeSource'. Using fallback '$fallback'."
        $ThemeSource = $fallback
    } else {
        throw "Theme source not found: $ThemeSource"
    }
}

foreach ($target in $PluginTargets) {
    if ($SkipAppData -and $target -like "$env:APPDATA*") { continue }
    Copy-TreeIfExists -Source $PluginSource -Destination $target
    Ensure-StreamUiSchema -PluginsDir $target
    Patch-StreamUiPlugin -PluginsDir $target
    if ($target -eq (Join-Path $ReleaseDir "plugins")) {
        Sanitize-PluginConfigs -PluginsDir $target
        Patch-ContextMenuFixPlugin -PluginsDir $target
    }
}

foreach ($target in $ThemeTargets) {
    if ($SkipAppData -and $target -like "$env:APPDATA*") { continue }
    Copy-TreeIfExists -Source $ThemeSource -Destination $target
}

Write-Host "Custom assets synced."
