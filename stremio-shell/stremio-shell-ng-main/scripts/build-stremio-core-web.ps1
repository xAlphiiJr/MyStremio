#Requires -Version 5.1
<#
.SYNOPSIS
  Build MyStremio-patched @stremio/stremio-core-web 0.59.0 WASM and install it into webui.

.DESCRIPTION
  Clones stremio-core tag stremio-core-web-v0.59.0, replaces serialize_catalogs_with_extra.rs
  (merge all catalog pages, no .take(10)), builds with Rust 1.95 + wasm-bindgen 0.2.121,
  remaps worker.js hashed export names to the new ABI, and updates service-worker revisions.
#>
$ErrorActionPreference = "Stop"

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptRoot
$RepoRoot = Split-Path -Parent (Split-Path -Parent $ProjectRoot)
$CoreRoot = Join-Path $RepoRoot ".tmp\stremio-core"
$PatchSrc = Join-Path $ProjectRoot "patches\serialize_catalogs_with_extra.rs"
$Tag = "stremio-core-web-v0.59.0"
$RustChannel = "1.95"

$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path

if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
    throw "rustc not found. Install Rust from https://rustup.rs"
}
rustup install $RustChannel | Out-Null
rustup target add wasm32-unknown-unknown --toolchain $RustChannel | Out-Null
if (-not (Get-Command wasm-bindgen -ErrorAction SilentlyContinue) -or
    ((wasm-bindgen --version) -notmatch "0\.2\.121")) {
    Write-Host "Installing wasm-bindgen-cli 0.2.121..."
    cargo +$RustChannel install wasm-bindgen-cli --version 0.2.121 --locked --force
}
if (-not (Get-Command wasm-pack -ErrorAction SilentlyContinue)) {
    Write-Host "Installing wasm-pack..."
    cargo install wasm-pack --locked
}

if (-not (Test-Path $PatchSrc)) {
    throw "Missing patch file: $PatchSrc"
}

if (-not (Test-Path (Join-Path $CoreRoot ".git"))) {
    Write-Host "Cloning stremio-core $Tag..."
    New-Item -ItemType Directory -Force -Path (Split-Path $CoreRoot) | Out-Null
    git clone --depth 1 --branch $Tag https://github.com/Stremio/stremio-core.git $CoreRoot
} else {
    Write-Host "Updating stremio-core checkout to $Tag..."
    git -C $CoreRoot fetch --depth 1 origin tag $Tag
    git -C $CoreRoot checkout --force $Tag
    git -C $CoreRoot checkout -- stremio-core-web/Cargo.toml
}

rustup override set $RustChannel --path $CoreRoot | Out-Null
rustup override set $RustChannel --path (Join-Path $CoreRoot "stremio-core-web") | Out-Null

$serializePath = Join-Path $CoreRoot "stremio-core-web\src\model\serialize_catalogs_with_extra.rs"
Copy-Item -Force $PatchSrc $serializePath
Write-Host "Applied MyStremio board-pages serializer patch"

$webDir = Join-Path $CoreRoot "stremio-core-web"
Push-Location $webDir
try {
    Remove-Item -Recurse -Force "wasm_build" -ErrorAction SilentlyContinue
    Write-Host "Building stremio-core-web wasm (release, $RustChannel)..."
    wasm-pack build --no-typescript --no-pack --out-dir wasm_build --release --target web --mode no-install
    if ($LASTEXITCODE -ne 0) {
        throw "wasm-pack build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$builtWasm = Join-Path $webDir "wasm_build\stremio_core_web_bg.wasm"
$builtJs = Join-Path $webDir "wasm_build\stremio_core_web.js"
if (-not (Test-Path $builtWasm) -or -not (Test-Path $builtJs)) {
    throw "Built wasm/js missing under $webDir\wasm_build"
}

# Restore stock worker.js before remapping (idempotent rebuilds).
$workerRel = "webui\eb5752673c6ac87e7137a6c3cca21a6980028cf9\scripts\worker.js"
git -C $RepoRoot checkout -- (Join-Path "stremio-shell\stremio-shell-ng-main" $workerRel) 2>$null

$remap = Join-Path $ScriptRoot "remap-wasm-bindgen-hashes.py"
Write-Host "Remapping worker.js ABI hashes to match new wasm..."
& py -3 $remap $builtJs $builtWasm
if ($LASTEXITCODE -ne 0) {
    throw "ABI remap failed with exit code $LASTEXITCODE"
}

$swPatch = Join-Path $ScriptRoot "patch-webui-sw-revision.py"
& py -3 $swPatch (Join-Path $ProjectRoot "webui") (Join-Path $ProjectRoot "webui\eb5752673c6ac87e7137a6c3cca21a6980028cf9\scripts\main.js")
if ($LASTEXITCODE -ne 0) {
    throw "service-worker revision patch failed with exit code $LASTEXITCODE"
}

Write-Host "Done."
