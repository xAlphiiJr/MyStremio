# Stremio Custom — Phase 1 (Player)

Native Windows shell based on [stremio-shell-ng](https://github.com/Stremio/stremio-shell-ng): **WebView2 + libmpv**, same architecture as Stremio Desktop.

**Goal:** Stable playback for all stream types, with working audio and subtitle track selection. Plugins come later.

## Requirements

- Windows 10/11 with [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
- [Rust](https://rustup.rs/) (stable, **MSVC** toolchain)
- **Visual Studio Build Tools** with the **C++** workload (`link.exe`)
- Stremio Desktop installed once (runtime binaries in `%LOCALAPPDATA%\Programs\Stremio`)
- `libmpv-2_x64.zip` in project root **or** `libmpv-2.dll` from an existing Stremio install

## Build & run

```powershell
cd stremio-shell\stremio-shell-ng-main

# One-shot build + runtime copy
.\build-custom.ps1

# Start (F12 = DevTools)
.\run.ps1 -SkipBuild
```

Manual steps:

```powershell
# Requires: Rust (MSVC) + Visual Studio Build Tools (C++ workload)
.\build-custom.ps1
.\run.ps1 -SkipBuild
```

## What was customized

| Area | Change |
|------|--------|
| App name | Stremio Custom |
| Data dir | `%APPDATA%\Stremio Custom\` |
| Web UI URL | `streamingServerUrl=http://127.0.0.1:11470/` |
| Auto-updater | Disabled |
| `server.js` | `enginefs.baseUrl` uses localhost (not LAN IP) |

## Test playback

1. Start with `.\run.ps1` and `--dev-tools` (default).
2. Open a title that failed in Electron (e.g. Euphoria 4K, Two and a Half Men).
3. Confirm: video starts, `duration > 0`, audio/subtitle menus populate.

## Phase 2 (plugins + themes)

Themes, plugins, and the **Custom** settings section are integrated via WebView2 bootstrap + Rust file API.

```powershell
.\build-custom.ps1      # build + runtime + plugins/themes + desktop shortcut
.\run.ps1 -SkipBuild    # start app
```

Settings: `#/settings` → **Custom** → toggle themes/plugins → **Strg+R** to reload.

Bundled assets are copied from `stremio-custom/plugins` and `stremio-custom/themes`.

### Not included yet (higher effort)

- Picture-in-Picture, Enhanced External Player
- Community marketplace / registry install
- Favorite language bars, autoskip quick settings
- Session volume, seek buffer indicator

### Deferred / later

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Cannot execute stremio-runtime` | Install Stremio Desktop once, then run `.\build-custom.ps1` |
| `Missing libmpv-2_x64.zip` | Place zip in project root, or install Stremio Desktop |
| Server starts on wrong port | Web UI expects port 11470; restart app if port busy |
| Black screen, server OK | Check MPV logs in terminal when started from `run.ps1` |
