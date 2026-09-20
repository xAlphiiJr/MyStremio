# Copies plugins and themes from project sources into the shell release folder.
# No local AppData fallback is allowed for release safety.
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,
    [string]$ReleaseDir = (Join-Path $PSScriptRoot "..\target\x86_64-pc-windows-msvc\release")
)

$ErrorActionPreference = "Stop"

if (-not $SourceRoot) {
    throw "-SourceRoot is required (folder containing 'plugins' and 'themes', typically the repo assets-bundle)."
}

$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)
$ReleaseDir = [System.IO.Path]::GetFullPath($ReleaseDir)

$PluginSource = Join-Path $SourceRoot "plugins"
$ThemeSource = Join-Path $SourceRoot "themes"
$PluginTargets = @(
    (Join-Path $ReleaseDir "plugins")
)
$ThemeTargets = @(
    (Join-Path $ReleaseDir "themes")
)

function Copy-TreeIfExists {
    param(
        [string]$Source,
        [string]$Destination,
        [switch]$Required
    )

    if (-not (Test-Path $Source)) {
        if ($Required) {
            throw "Missing required source: $Source"
        }
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

            foreach ($key in @('tidb_api_key', 'tidbApiKey', 'introdb_api_key', 'introdbApiKey', 'tmdb_api_key', 'tmdbApiKey', 'rpdb_api_key', 'rpdbApiKey', 'api_key', 'apiKey')) {
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
            throw "Could not sanitize $($_.FullName): $_"
        }
    }
}

function Assert-NoPluginConfigSecrets {
    param([string]$PluginsDir)

    if (-not (Test-Path $PluginsDir)) { return }

    $secretKeys = @('tidb_api_key', 'tidbApiKey', 'introdb_api_key', 'introdbApiKey', 'tmdb_api_key', 'tmdbApiKey', 'rpdb_api_key', 'rpdbApiKey', 'api_key', 'apiKey')
    $findings = New-Object System.Collections.Generic.List[string]

    Get-ChildItem $PluginsDir -Recurse -Filter "*.plugin.json" | ForEach-Object {
        try {
            $raw = Get-Content $_.FullName -Raw -Encoding UTF8
            if ([string]::IsNullOrWhiteSpace($raw)) { return }
            $json = $raw | ConvertFrom-Json
            foreach ($key in $secretKeys) {
                if ($json.PSObject.Properties.Name -contains $key) {
                    $value = [string]$json.$key
                    if (-not [string]::IsNullOrWhiteSpace($value)) {
                        $relative = $_.FullName.Replace([System.IO.Path]::GetFullPath($PluginsDir), '').TrimStart('\', '/')
                        $findings.Add("$relative::$key")
                    }
                }
            }
        } catch {
            throw "Could not parse plugin config for secret validation: $($_.FullName) :: $_"
        }
    }

    if ($findings.Count -gt 0) {
        $lines = ($findings | Sort-Object | ForEach-Object { " - $_" }) -join "`n"
        throw "Build blocked: non-empty API keys detected in plugin configs.`n$lines`nAll keys must be empty in repo assets."
    }
}

function Remove-DeprecatedAssets {
    param(
        [string]$PluginsDir,
        [string]$ThemesDir
    )

    $deprecatedPlugins = @(
        "player\picture-in-picture.plugin.js",
        "player\filter-streams.plugin.js",
        "player\stream-ui.plugin.js",
        "player\stream-ui.plugin.json",
        "player\stream-ui.plugin.schema.json",
        "interface\enhancements-tweaks.plugin.js",
        "interface\hero-div.plugin.js",
        "metadata\card-hover-info.plugin.js",
        "metadata\playback-preview.plugin.js",
        "metadata\trending-anime.plugin.js",
        "player\AniSkip.plugin.js",
        "player\enhanced-external-player.plugin.js",
        "player\enhanced-player.plugin.js",
        "player\stream-quality-picker.plugin.js",
        "utilities\dom-inspector.plugin.js",
        "utilities\initializer.plugin.js"
    )
    $deprecatedThemes = @(
        "amoled.theme.css",
        "hide-titlebar-buttons.theme.css"
    )

    if (Test-Path $PluginsDir) {
        foreach ($rel in $deprecatedPlugins) {
            $path = Join-Path $PluginsDir $rel
            if (Test-Path $path) {
                Remove-Item -Path $path -Force
                Write-Host "Removed deprecated plugin: $rel"
            }
        }
    }

    if (Test-Path $ThemesDir) {
        foreach ($rel in $deprecatedThemes) {
            $path = Join-Path $ThemesDir $rel
            if (Test-Path $path) {
                Remove-Item -Path $path -Force
                Write-Host "Removed deprecated theme: $rel"
            }
        }
    }
}

if (-not (Test-Path $PluginSource)) {
    throw "Plugin source not found. Set -SourceRoot to a project folder containing 'plugins'. Current: $PluginSource"
}
if (-not (Test-Path $ThemeSource)) {
    throw "Theme source not found. Set -SourceRoot to a project folder containing 'themes'. Current: $ThemeSource"
}

Assert-NoPluginConfigSecrets -PluginsDir $PluginSource

foreach ($target in $PluginTargets) {
    Copy-TreeIfExists -Source $PluginSource -Destination $target -Required
    if ($target -eq (Join-Path $ReleaseDir "plugins")) {
        Sanitize-PluginConfigs -PluginsDir $target
    }
}

foreach ($target in $ThemeTargets) {
    Copy-TreeIfExists -Source $ThemeSource -Destination $target -Required
}

for ($i = 0; $i -lt $PluginTargets.Count; $i++) {
    $pluginTarget = $PluginTargets[$i]
    $themeTarget = $ThemeTargets[$i]
    Remove-DeprecatedAssets -PluginsDir $pluginTarget -ThemesDir $themeTarget
}

$ShellProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ShaderSource = Join-Path $ShellProjectRoot "shaders"
$ShaderTarget = Join-Path $ReleaseDir "shaders"
Copy-TreeIfExists -Source $ShaderSource -Destination $ShaderTarget
Write-Host "Custom assets synced."
