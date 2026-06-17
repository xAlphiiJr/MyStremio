# MyStremio

**MyStremio** is a customized Windows desktop client based on the Stremio shell. It bundles enhanced playback, interface tweaks, library collections, Discord Rich Presence, and many plugins — all in one installer.

> **Disclaimer:** MyStremio is an independent community project. It is not affiliated with or endorsed by Stremio AG.

---

## Installation

You only need **one file** — just like the official Stremio installer.

1. Open the [GitHub Releases](https://github.com/YOUR_USERNAME/MyStremio/releases) page.
2. Download **`MyStremioSetup-v2.1.3_x64.exe`** (or the latest version).
3. Run the installer. It installs everything automatically:
   - Application binaries (`mystremio-shell.exe`, streaming server, FFmpeg, libmpv)
   - Bundled plugins and themes
   - WebView2 runtime (installed automatically if missing)
   - Protocol handlers (`stremio://`, `magnet:`, optional `.torrent`)
4. Launch **MyStremio** from the Start menu or desktop shortcut.

### Install location

| What | Path |
|------|------|
| Application | `%LOCALAPPDATA%\Programs\MyStremio\` |
| User settings & addons | `%APPDATA%\MyStremio\` |

No portable ZIP or extra downloads are required. The installer is fully self-contained.

### Requirements

- Windows 10/11 (64-bit)
- Internet connection (for Stremio web UI and addons)
- Optional: API keys for enrichment plugins (TMDB, TheIntroDB, etc.) — configure after install in **Settings → MyStremio**

### Uninstall

Use **Settings → Apps → MyStremio** or the uninstaller from the Start menu. You can optionally delete `%APPDATA%\MyStremio\` to remove all personal data.

---

## What MyStremio adds on top of Stremio

### Playback pipeline upgrades

| MyStremio addition | Why it matters |
|--------------------|----------------|
| **Custom MPV preload control** | Stable buffering with user-controlled preload behavior |
| **Seek buffer + hover timestamp** | More precise seeking and clearer scrub feedback |
| **Stream cache coordination** | Faster stream resume/re-selection and fewer loading stalls |
| **Persistent language quick-select** | Audio/subtitle language preferences survive restarts |
| **Custom subtitle sync + style layer** | Better subtitle timing and readability without breaking playback |

### Stream page enhancements

| MyStremio addition | Why it matters |
|--------------------|----------------|
| **Unified Stream UI plugin** | Groups streams into addon accordions with cleaner structure |
| **Ratings bundle card** | Aggregates IMDb/TMDb/RT/Metacritic data directly in stream view |
| **WatchHub panel integration** | Streaming provider overview integrated into stream details |
| **AfterCredits panel** | Post-credit hints visible without addon list clutter |
| **Quality picker overlay** | Faster best-stream selection by grouped quality tiers |

### Interface and workflow improvements

| MyStremio addition | Why it matters |
|--------------------|----------------|
| **Liquid Glass theme + player glass tuning** | Consistent custom visual layer across app and player |
| **Dynamic Hero + enhanced covers** | More informative home/continue-watching presentation |
| **Custom settings surface (`Settings -> MyStremio`)** | Central place for all MyStremio-specific controls |
| **Library folders and collection actions** | Extra organization workflow not available in stock behavior |
| **Route-aware plugin runtime control** | Non-essential plugins suspend during playback to lower overhead |

### Integrations

| MyStremio addition | Why it matters |
|--------------------|----------------|
| **Discord Rich Presence (persistent settings)** | Optional live activity sharing with stable reconnect behavior |
| **Data Enrichment hardening** | TMDB enrichment with safer mount targeting and helper links (TMDB, RPDB, TheIntroDB) |

### Settings location

Open **Settings** (`#/settings`) → **MyStremio** for app-specific options (Discord, autoskip, themes, plugin configs).

---

## First-time setup

1. Install and launch MyStremio.
2. Log in with your Stremio account (or continue as guest).
3. Install your preferred addons via the addon catalog.
4. Open **Settings → MyStremio** to configure optional API keys:
   - **TMDB** — for Data Enrichment (free key at [themoviedb.org](https://www.themoviedb.org/settings/api))
   - **TheIntroDB** — for intro/credits skip
5. Create library collections with the **+** button in the library filter bar.

---

## Building from source (developers)

Requires: Rust (MSVC), Visual Studio Build Tools, Inno Setup 6, and Stremio Desktop installed once (for runtime binaries).

```powershell
cd stremio-shell\stremio-shell-ng-main
.\package-release.ps1
```

Output: `release\MyStremioSetup-v2.1.3_x64.exe`

To assemble a clean GitHub folder from the parent repository:

```powershell
.\publish-github.ps1
```

---

## Privacy & data

- **No API keys or personal settings are bundled** in the installer. Plugin config files ship with empty keys.
- Your library collections, addon settings, and preferences are stored locally in `%APPDATA%\MyStremio\`.
- Discord Rich Presence only sends activity when enabled and connected.

---

## License & third-party

MyStremio builds on the Stremio shell and includes third-party plugins and themes. See `mystremio/build/THIRD-PARTY-NOTICES.txt` for attributions.

Stremio® is a trademark of Smart Code OOD. This project is a community modification and is not officially supported by Stremio.

---

## Patch Notes

### 2.1.3

- Version bump to `2.1.3` across shell/package/release artifacts.
- Added library backup controls in **Settings -> MyStremio -> Library** with **Export library JSON** and **Import library JSON**.
- Improved board return behavior: returning from detail view now restores to the exact previously selected title anchor more reliably.
- WatchHub remains collapsible while keeping the previous panel design/style in the detail sidebar.
- Fullscreen state handling in the shell/window bridge was refactored and hardened to reduce desync between button state and actual fullscreen mode.
- Fixed plugin settings input persistence so clearing API key fields is saved correctly instead of being blocked.
- Removed legacy API-key auto-recovery/migration behavior in Data Enrichment so deleted keys stay deleted.
- Security hardening for release assets: default plugin config keys are empty and no secrets are bundled.
- Added strict build-time secret guard (`Assert-NoPluginConfigSecrets`) to fail the build if non-empty API keys are detected in plugin JSON files.
- Cleaned dead bootstrap/runtime code paths to reduce release complexity.
- Kept installer update behavior compatible with in-app user config persistence in `%APPDATA%`.
