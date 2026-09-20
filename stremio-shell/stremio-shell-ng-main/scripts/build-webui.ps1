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

    $applyScript = Join-Path $ScriptRoot "apply-webui-patches.py"
    if (-not (Test-Path $applyScript)) {
        throw "Missing web UI patch runner: $applyScript"
    }
    Invoke-WebUiPython $applyScript $WebUiDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "Web UI patch apply/verify failed with exit code $LASTEXITCODE"
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
