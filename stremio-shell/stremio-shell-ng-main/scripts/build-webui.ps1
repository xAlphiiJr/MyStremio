$ErrorActionPreference = "Stop"

$ScriptRoot = $PSScriptRoot
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptRoot ".."))
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "..\.."))
$WebUiRoot = Join-Path $RepoRoot ".tmp\stremio-web"
$WebUiBuild = Join-Path $WebUiRoot "build"
$WebUiOut = Join-Path $ProjectRoot "webui"

if (-not (Test-Path (Join-Path $WebUiRoot "package.json"))) {
    if (Test-Path (Join-Path $WebUiOut "index.html")) {
        Write-Host "Using prebuilt web UI at $WebUiOut (stremio-web source not found at $WebUiRoot)."
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

$mainJs = Get-ChildItem -Path $WebUiOut -Recurse -Filter main.js | Select-Object -First 1
if ($mainJs) {
    $fixScript = Join-Path $ScriptRoot "fix-webui-language-mojibake.py"
    if (Test-Path $fixScript) {
        python $fixScript $mainJs.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "Language mojibake repair failed with exit code $LASTEXITCODE"
        }
    }
}

Write-Host "Local web UI copied to $WebUiOut"
