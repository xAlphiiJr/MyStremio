$ErrorActionPreference = "Stop"

$ScriptRoot = $PSScriptRoot
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptRoot ".."))
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "..\.."))
$WebUiRoot = Join-Path $RepoRoot ".tmp\stremio-web"
$WebUiBuild = Join-Path $WebUiRoot "build"
$WebUiOut = Join-Path $ProjectRoot "webui"

# Resolve a real Python interpreter for the web UI patch scripts.
#
# Bare `python` on Windows frequently resolves to the Microsoft Store execution
# alias stub (%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe). When the Store
# package is not actually installed the stub prints "Python was not found ..."
# and returns exit code 9009, which used to abort the whole build. We instead
# probe a list of candidates and pick the first that really runs, explicitly
# skipping the Store stub. Returns the interpreter as an argument array so both
# plain interpreters ("python.exe") and the launcher ("py -3") work uniformly.
function Resolve-PythonCommand {
    $candidates = @()

    # Windows Python launcher is the most reliable when present.
    if (Get-Command py -ErrorAction SilentlyContinue) {
        $candidates += , @('py', '-3')
    }

    # `python`/`python3` on PATH, excluding the Store alias stub.
    foreach ($name in @('python', 'python3')) {
        Get-Command $name -All -ErrorAction SilentlyContinue | ForEach-Object {
            $src = $_.Source
            if ($src -and ($src -notlike '*\Microsoft\WindowsApps\*')) {
                $candidates += , @($src)
            }
        }
    }

    # Actual per-user Store install (real python.exe, not the alias reparse point).
    $storeRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
    if (Test-Path $storeRoot) {
        Get-ChildItem $storeRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'PythonSoftwareFoundation.Python*' } |
            ForEach-Object {
                $exe = Join-Path $_.FullName 'python.exe'
                if (Test-Path $exe) { $candidates += , @($exe) }
            }
    }

    foreach ($candidate in $candidates) {
        try {
            $exe = $candidate[0]
            $args = @()
            if ($candidate.Count -gt 1) { $args = $candidate[1..($candidate.Count - 1)] }
            $version = & $exe @args '--version' 2>&1
            if ($LASTEXITCODE -eq 0 -and "$version" -match 'Python\s+3') {
                return , $candidate
            }
        } catch {
            # Try the next candidate.
        }
    }

    throw @"
No usable Python 3 interpreter found for web UI patching.
The bundled web UI is patched by scripts in $ScriptRoot which require Python 3.
Install Python from https://www.python.org/downloads/ (enable "Add to PATH"),
or disable the Microsoft Store alias under Settings > Apps > App execution aliases,
then rerun the build.
"@
}

$PythonCommand = $null

# Detect whether the bundled web UI already carries the required custom patches.
#
# The patch scripts are idempotent, so when Python is unavailable but a previously
# patched bundle is present we can still package a correct installer. We only trust
# this fallback when the observable markers all match; otherwise the build must fail
# loudly rather than ship an unpatched web UI.
function Test-WebUiAlreadyPatched {
    param([string]$WebUiDirectory)

    $indexHtml = Join-Path $WebUiDirectory "index.html"
    if (-not (Test-Path $indexHtml)) { return $false }

    # Preboot asset injected and referenced.
    if (-not (Test-Path (Join-Path $WebUiDirectory "mystremio-preboot.js"))) { return $false }
    if (-not (Select-String -Path $indexHtml -Pattern 'mystremio-preboot\.js' -Quiet)) { return $false }

    $mainJs = Get-ChildItem -Path $WebUiDirectory -Recurse -Filter main.js | Select-Object -First 1
    if (-not $mainJs) { return $false }

    # Hero fallback patch removes every FALLBACK_TITLES.map(...) usage.
    if (Select-String -Path $mainJs.FullName -Pattern 'FALLBACK_TITLES\.map' -Quiet) { return $false }

    # Updater banner rebranded to MyStremio.
    if (-not (Select-String -Path $mainJs.FullName -Pattern 'A new version of MyStremio is available' -Quiet)) { return $false }

    # Board catalog LoadNextPage + catalog-index sync for row chevrons.
    if (-not (Select-String -Path $mainJs.FullName -Pattern '__mystremioBoardLoadNextPage' -Quiet)) { return $false }
    if (-not (Select-String -Path $mainJs.FullName -Pattern '__mystremioBoardSyncCatalogIndices' -Quiet)) { return $false }

    return $true
}

# Invoke one of the web UI patch scripts with the resolved Python interpreter.
function Invoke-WebUiPython {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    if (-not $script:PythonCommand) {
        $script:PythonCommand = Resolve-PythonCommand
        Write-Host "Using Python interpreter: $($script:PythonCommand -join ' ')"
    }

    $exe = $script:PythonCommand[0]
    $prefix = @()
    if ($script:PythonCommand.Count -gt 1) {
        $prefix = $script:PythonCommand[1..($script:PythonCommand.Count - 1)]
    }
    & $exe @prefix @Arguments
}

function Repair-WebUiLanguageEmbeds {
    param([string]$WebUiDirectory)

    $mainJs = Get-ChildItem -Path $WebUiDirectory -Recurse -Filter main.js | Select-Object -First 1
    if (-not $mainJs) { return }

    # If Python is unavailable but the bundle is already patched (e.g. a Rust-only
    # rebuild on a machine that lost its Python install), continue with a warning
    # instead of failing. An unpatched bundle still hard-fails below.
    if (-not $script:PythonCommand) {
        $probe = $null
        try { $probe = Resolve-PythonCommand } catch { $probe = $null }
        if (-not $probe) {
            if (Test-WebUiAlreadyPatched -WebUiDirectory $WebUiDirectory) {
                Write-Warning "Python 3 not found, but the bundled web UI is already patched. Skipping web UI patch steps and packaging the existing bundle."
                return
            }
            # Not patched and no Python: surface the actionable install message.
            Resolve-PythonCommand | Out-Null
        }
        else {
            $script:PythonCommand = $probe
            Write-Host "Using Python interpreter: $($script:PythonCommand -join ' ')"
        }
    }

    $fixScript = Join-Path $ScriptRoot "fix-webui-language-embeds.py"
    $interfaceLanguages = Join-Path $ProjectRoot "assets\interfaceLanguages.json"
    $languageNames = Join-Path $ProjectRoot "assets\languageNames.json"
    if (-not (Test-Path $fixScript)) { return }
    if (-not (Test-Path $interfaceLanguages)) {
        throw "Missing interface languages source: $interfaceLanguages"
    }
    if (-not (Test-Path $languageNames)) {
        throw "Missing language names source: $languageNames"
    }

    Invoke-WebUiPython $fixScript $mainJs.FullName $interfaceLanguages $languageNames
    if ($LASTEXITCODE -ne 0) {
        throw "Language embed repair failed with exit code $LASTEXITCODE"
    }

    $mojibakeScript = Join-Path $ScriptRoot "fix-webui-language-mojibake.py"
    if (Test-Path $mojibakeScript) {
        Invoke-WebUiPython $mojibakeScript $mainJs.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "Language mojibake repair failed with exit code $LASTEXITCODE"
        }
    }

    $shortcutScript = Join-Path $ScriptRoot "fix-webui-shortcut-symbols.py"
    if (Test-Path $shortcutScript) {
        Invoke-WebUiPython $shortcutScript $mainJs.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "Shortcut symbol repair failed with exit code $LASTEXITCODE"
        }
    }

    $heroPatchScript = Join-Path $ScriptRoot "fix-webui-hero-fallback.py"
    if (Test-Path $heroPatchScript) {
        Invoke-WebUiPython $heroPatchScript $mainJs.FullName
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Hero fallback patch reported exit code $LASTEXITCODE (continuing build)"
        }
    }

    $updaterBrandingScript = Join-Path $ScriptRoot "fix-webui-updater-branding.py"
    if (Test-Path $updaterBrandingScript) {
        Invoke-WebUiPython $updaterBrandingScript $mainJs.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "Updater branding patch failed with exit code $LASTEXITCODE"
        }
    }

    $boardCatalogScript = Join-Path $ScriptRoot "fix-webui-board-catalog-pages.py"
    if (Test-Path $boardCatalogScript) {
        Invoke-WebUiPython $boardCatalogScript $mainJs.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "Board catalog pages patch failed with exit code $LASTEXITCODE"
        }
    }

    $swPatchScript = Join-Path $ScriptRoot "patch-webui-sw-revision.py"
    if (Test-Path $swPatchScript) {
        Invoke-WebUiPython $swPatchScript $WebUiDirectory $mainJs.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "Service worker revision patch failed with exit code $LASTEXITCODE"
        }
    }

    $prebootScript = Join-Path $ScriptRoot "patch-webui-preboot.py"
    $prebootAsset = Join-Path $ProjectRoot "assets\custom_preboot.js"
    if (Test-Path $prebootScript) {
        Invoke-WebUiPython $prebootScript $WebUiDirectory $prebootAsset
        if ($LASTEXITCODE -ne 0) {
            throw "Preboot patch failed with exit code $LASTEXITCODE"
        }
    }

    $verifyScript = Join-Path $ScriptRoot "verify-webui-main.js.py"
    if (Test-Path $verifyScript) {
        Invoke-WebUiPython $verifyScript $mainJs.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "main.js verification failed with exit code $LASTEXITCODE"
        }
    }
}

if (-not (Test-Path (Join-Path $WebUiRoot "package.json"))) {
    if (Test-Path (Join-Path $WebUiOut "index.html")) {
        Write-Host "Using prebuilt web UI at $WebUiOut (stremio-web source not found at $WebUiRoot)."
        Repair-WebUiLanguageEmbeds -WebUiDirectory $WebUiOut
        return
    }
    throw "Missing stremio-web source at $WebUiRoot and no prebuilt web UI at $WebUiOut"
}

function Resolve-PnpmCommand {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        return "pnpm"
    }
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        return "corepack pnpm"
    }
    throw "pnpm/corepack not found. Install Node.js with Corepack enabled."
}

$pnpm = Resolve-PnpmCommand

Write-Host "Building local stremio-web from $WebUiRoot"

if (-not (Test-Path (Join-Path $WebUiRoot "node_modules"))) {
    cmd /c "cd /d `"$WebUiRoot`" && $pnpm install --frozen-lockfile"
    if ($LASTEXITCODE -ne 0) {
        throw "stremio-web install failed with exit code $LASTEXITCODE"
    }
}

cmd /c "cd /d `"$WebUiRoot`" && $pnpm build"
if ($LASTEXITCODE -ne 0) {
    throw "stremio-web build failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path $WebUiBuild)) {
    throw "stremio-web build output missing: $WebUiBuild"
}

if (Test-Path $WebUiOut) {
    Remove-Item $WebUiOut -Recurse -Force
}
New-Item -ItemType Directory -Path $WebUiOut -Force | Out-Null
Copy-Item -Path (Join-Path $WebUiBuild "*") -Destination $WebUiOut -Recurse -Force

Repair-WebUiLanguageEmbeds -WebUiDirectory $WebUiOut

Write-Host "Local web UI copied to $WebUiOut"
