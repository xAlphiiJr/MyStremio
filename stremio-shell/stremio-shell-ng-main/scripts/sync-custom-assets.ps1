# Copies plugins and themes from project sources into the shell release folder.
# No local AppData fallback is allowed for release safety.
param(
    [string]$SourceRoot = "",
    [string]$ReleaseDir = (Join-Path $PSScriptRoot "..\target\x86_64-pc-windows-msvc\release")
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
    (Join-Path $ReleaseDir "plugins")
)
$ThemeTargets = @(
    (Join-Path $ReleaseDir "themes")
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

            foreach ($key in @('tidb_api_key', 'tidbApiKey', 'tmdb_api_key', 'tmdbApiKey', 'rpdb_api_key', 'rpdbApiKey', 'api_key', 'apiKey')) {
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

function Assert-NoPluginConfigSecrets {
    param([string]$PluginsDir)

    if (-not (Test-Path $PluginsDir)) { return }

    $secretKeys = @('tidb_api_key', 'tidbApiKey', 'tmdb_api_key', 'tmdbApiKey', 'rpdb_api_key', 'rpdbApiKey', 'api_key', 'apiKey')
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
        if ($raw -match "OPEN_STATE_KEY\s*=\s*'sui-open-accordions'") {
            $patched = $raw
            $patched = $patched.Replace(
                "const shouldOpen = open !== false;",
                "const shouldOpen = open === true;"
            )
            # Keep existing modern patch unchanged once present.
            if ($patched -ne $raw) {
                Set-Content -Path $pluginPath -Value $patched -Encoding UTF8
                Write-Host "Updated Stream UI plugin to preserve open groups across list rebuilds."
            } else {
                Write-Host "Stream UI plugin already has session accordion memory patch."
            }
            return
        }
        # Older plugin variants can be patched safely with the legacy replacements below.
        $patched = $raw.Replace(
            "acc.className = GROUP + (open ? ' open' : '');",
            "acc.className = GROUP + ' open';"
        ).Replace(
            'aria-expanded="${open ? ''true'' : ''false''}"',
            'aria-expanded="true"'
        )
        if ($patched -ne $raw) {
            Set-Content -Path $pluginPath -Value $patched -Encoding UTF8
            Write-Host "Patched legacy Stream UI plugin."
        }
    } catch {
        Write-Warning ("Could not patch Stream UI plugin in " + $PluginsDir + ": " + $_)
    }
}

function Patch-HeroDivPlugin {
    param([string]$PluginsDir)

    if (-not (Test-Path $PluginsDir)) { return }
    $pluginPath = Join-Path $PluginsDir "interface\hero-div.plugin.js"
    if (-not (Test-Path $pluginPath)) { return }

    try {
        $raw = Get-Content $pluginPath -Raw -Encoding UTF8
        if (-not $raw) { return }
        $patched = $raw.Replace(
            "margin-top: -15px !important;",
            "margin-top: 0 !important;"
        ).Replace(
            "min-height: 900px;",
            "min-height: 900px;`r`n                    border-top: 0 !important;"
        )
        if ($patched -ne $raw) {
            Set-Content -Path $pluginPath -Value $patched -Encoding UTF8
            Write-Host "Patched hero-div plugin top spacing to remove frame seam."
        }
    } catch {
        Write-Warning ("Could not patch hero-div plugin in " + $PluginsDir + ": " + $_)
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
        "interface\enhancements-tweaks.plugin.js",
        "interface\horizontal-navigation.plugin.js",
        "metadata\card-hover-info.plugin.js",
        "metadata\playback-preview.plugin.js",
        "metadata\trending-anime.plugin.js"
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

function Patch-DataEnrichmentPlugin {
    param([string]$PluginsDir)

    if (-not (Test-Path $PluginsDir)) { return }
    $pluginPath = Join-Path $PluginsDir "metadata\data-enrichment.plugin.js"
    if (-not (Test-Path $pluginPath)) { return }

    try {
        $raw = Get-Content $pluginPath -Raw -Encoding UTF8
        if (-not $raw) { return }
        $patched = $raw

        $patched = $patched.Replace(
            "                '[class*=""details-container""]',`r`n                '[class*=""side-drawer""]',`r`n                '[class*=""description-container""]',`r`n                '[class*=""menu-container""]',",
            "                '[class*=""details-container""]',`r`n                '[class*=""side-drawer""]',"
        )

        $patched = $patched.Replace(
            "                if (element) return element;",
            "                if (element && !element.closest('[class*=""player-container""], [class*=""control-bar-layer""], [class*=""subtitles-menu-container""]')) return element;"
        )

        if ($patched -ne $raw) {
            Set-Content -Path $pluginPath -Value $patched -Encoding UTF8
            Write-Host "Patched data-enrichment mount guards to avoid player UI injection."
        }
    } catch {
        Write-Warning ("Could not patch data-enrichment plugin in " + $PluginsDir + ": " + $_)
    }
}

function Patch-EnhancedPlayerPlugin {
    param([string]$PluginsDir)

    if (-not (Test-Path $PluginsDir)) { return }
    $pluginPath = Join-Path $PluginsDir "player\enhanced-player.plugin.js"
    if (-not (Test-Path $pluginPath)) { return }

    try {
        $raw = Get-Content $pluginPath -Raw -Encoding UTF8
        if (-not $raw) { return }
        $patched = $raw.Replace(
            "background: rgba(70, 70, 70, 0.28);",
            "background: rgba(70, 70, 70, 0.22);"
        ).Replace(
            "background: rgba(70, 70, 70, 0.22); border: 1px solid rgba(255,255,255,0.08);",
            "background: rgba(70, 70, 70, 0.16); border: 1px solid rgba(255,255,255,0.08);"
        ).Replace(
            "background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.7);",
            "background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.7);"
        ).Replace(
            "border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06);",
            "border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05);"
        )
        if ($patched -ne $raw) {
            Set-Content -Path $pluginPath -Value $patched -Encoding UTF8
            Write-Host "Patched enhanced-player subtitle panel opacity for Liquid Glass."
        }
    } catch {
        Write-Warning ("Could not patch enhanced-player plugin in " + $PluginsDir + ": " + $_)
    }
}

function Patch-LiquidGlassTheme {
    param([string]$ThemesDir)

    if (-not (Test-Path $ThemesDir)) { return }
    $themePath = Join-Path $ThemesDir "liquid-glass.theme.css"
    if (-not (Test-Path $themePath)) { return }

    try {
        $raw = Get-Content $themePath -Raw -Encoding UTF8
        if (-not $raw) { return }

        $patched = $raw.Replace(
            "top: 0.5px !important;",
            "top: 0 !important;"
        )

        $seamBlock = @"

/* hard seam fix between window frame and hero/nav */
#app,
#app [class*="main-nav-bars-container"],
#app nav[class*="horizontal-nav-bar"],
.hero-container {
    border-top: 0 !important;
}
#app::before,
#app [class*="main-nav-bars-container"]::before,
#app nav[class*="horizontal-nav-bar"]::before,
.hero-container::before {
    display: none !important;
}
"@
        if ($patched -notlike "*hard seam fix between window frame and hero/nav*") {
            $patched += $seamBlock
        }

        if ($patched -ne $raw) {
            Set-Content -Path $themePath -Value $patched -Encoding UTF8
            Write-Host "Patched Liquid Glass theme top seam styles."
        }
    } catch {
        Write-Warning ("Could not patch liquid-glass theme in " + $ThemesDir + ": " + $_)
    }
}

if (-not $PluginSource -or -not (Test-Path $PluginSource)) {
    throw "Plugin source not found. Set -SourceRoot to a project folder containing 'plugins'. Current: $PluginSource"
}
if (-not $ThemeSource -or -not (Test-Path $ThemeSource)) {
    throw "Theme source not found. Set -SourceRoot to a project folder containing 'themes'. Current: $ThemeSource"
}

Assert-NoPluginConfigSecrets -PluginsDir $PluginSource

foreach ($target in $PluginTargets) {
    Copy-TreeIfExists -Source $PluginSource -Destination $target
    Ensure-StreamUiSchema -PluginsDir $target
    Patch-StreamUiPlugin -PluginsDir $target
    Patch-HeroDivPlugin -PluginsDir $target
    Patch-DataEnrichmentPlugin -PluginsDir $target
    Patch-EnhancedPlayerPlugin -PluginsDir $target
    if ($target -eq (Join-Path $ReleaseDir "plugins")) {
        Sanitize-PluginConfigs -PluginsDir $target
        Patch-ContextMenuFixPlugin -PluginsDir $target
    }
}

foreach ($target in $ThemeTargets) {
    Copy-TreeIfExists -Source $ThemeSource -Destination $target
    Patch-LiquidGlassTheme -ThemesDir $target
}

for ($i = 0; $i -lt $PluginTargets.Count; $i++) {
    $pluginTarget = $PluginTargets[$i]
    $themeTarget = $ThemeTargets[$i]
    Remove-DeprecatedAssets -PluginsDir $pluginTarget -ThemesDir $themeTarget
}

Write-Host "Custom assets synced."
