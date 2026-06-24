# MyStremio

**MyStremio** is a personalized Windows desktop client built on the Stremio shell stack.
It combines UI upgrades, player improvements, plugins/themes, library tools, and Discord Rich Presence in one installer.

> **Disclaimer:** MyStremio is an independent community project and is not affiliated with Stremio AG.

---

## How MyStremio differs from official Stremio

- Built-in UI and navigation enhancements (including a Glass-Theme and a custom settings area)
- Improved player tooling (hover timestamp, TheIntroDB/auto-skip options, controllable preload behavior)
- Better stream organization and metadata presentation (enrichment panels and cleaner stream UI behavior)
- Integrated Cinebye management (manage addons, optional Cinemeta disable)
- Custom library groups with JSON import/export
- Additional power-user options such as plugin/theme toggles and Discord Rich Presence
- Packaged as a ready-to-use single installer

---

## Features with screenshots

### 1) Board hero home view

The board offers a modern hero section created by [Fxy6969](https://github.com/Fxy6969).

![Board Hero Home](./images/01-board-hero-home.png)

### 2) Hover metadata in catalogs

While browsing catalogs, hover cards show key information (plot, genres, cast) without forcing a page change.

![Catalog Hover Metadata](./images/02-catalog-hover-metadata.png)

### 3) Detail view with metadata and stream sidebar

The detail page combines metadata, cast, similar titles, and an extended stream/provider sidebar in one view.

![Metadata and Stream UI](./images/03-detail-metadata-stream-sidebar.png)

### 4) Cinebye Addon Manager

[Cinebye](https://cinebye.elfhosted.com/) is integrated so you can manage addons inside Stremio and optionally disable specific sources (for example Cinemeta).

![Cinebye Addon Manager](./images/04-cinebye-addon-manager.png)

### 5) Favorite subtitle and audio languages

Inside player settings, you can define favorite subtitle and audio languages that act as your preferred language pool.
This preference layer is used by the quick language actions shown in the next section.

![Favorite Languages for Subtitles and Audio](./images/05-favorite-languages-subtitles-audio.png)

### 6) Quick Select language shortcuts

Quick Select reads your favorites and exposes them as one-click subtitle/audio buttons, so switching language is fast and consistent during playback.
In short: favorites define what is available, Quick Select is the runtime shortcut layer that applies those preferences immediately.

![Quick Select Language Shortcuts](./images/06-quick-select-language-shortcuts.png)

### 7) Settings: themes and plugins

Themes and plugins can be managed directly from settings, including quick access to the themes/plugins folders.

![Themes and Plugins Settings](./images/07-settings-themes-plugins.png)

### 8) Settings: preload, library backup, Discord

Inside **Settings -> MyStremio**, you get central controls for buffer/preload, library export/import, and Discord Rich Presence.

![Preload Library Discord Settings](./images/08-settings-preload-library-discord.png)





---

## Installation

1. Download the latest installer from this repository's **Releases** page.
2. Run `MyStremioSetup-..._x64.exe`.
3. The installer sets up:
   - App binaries (`mystremio-shell.exe`, streaming server, FFmpeg, libmpv)
   - Bundled plugins and themes
   - WebView2 runtime (if missing)
   - Protocol handlers (`stremio://`, `magnet:`, optional `.torrent`)
4. Launch MyStremio from the Start menu or desktop shortcut.

### Install paths

- App: `%LOCALAPPDATA%\Programs\MyStremio\`
- User data (settings/addons): `%APPDATA%\MyStremio\`

### Requirements

- Windows 10/11 (64-bit)
- Internet connection (web UI, addons, metadata sources)
- Optional API keys for plugins (for example TMDB, TheIntroDB)

### Uninstall

Use **Windows Apps & Features** or the Start menu uninstaller.
Optionally delete `%APPDATA%\MyStremio\` to remove all local user data.

---

## First-time setup

1. Install and launch MyStremio.
2. Sign in with your Stremio account.
3. Open **Settings -> MyStremio** and configure optional items:
   - Preload/buffer
   - Themes/plugins
   - Discord Rich Presence
   - Plugin API keys
4. Create library folders and use JSON import/export when needed.

---

## Themes and plugins (manual files)

### Install themes/plugins

1. Open **Settings -> MyStremio**.
2. Click **Open themes/plugins folder**.
3. Place your theme/plugin files in that folder.
4. Toggle the switch and press CTRL+R to reload the app.

---

## Build from source (developers)

Requires Rust (MSVC), Visual Studio Build Tools, Inno Setup 6, and an installed Stremio Desktop runtime.

```powershell
cd stremio-shell\stremio-shell-ng-main
.\package-release.ps1
```

Output: `release\MyStremioSetup-..._x64.exe`

Optional for a clean GitHub-ready package:

```powershell
.\publish-github.ps1
```

---

## Privacy and local data

- No API keys or personal settings are prefilled in the installer.
- Settings, addon data, and library structure are stored locally in `%APPDATA%\MyStremio\`.
- Discord Rich Presence only sends data when enabled and connected.

---

## Credits

MyStremio is based on the following independent communtiy projects:

- [REVENGE977/stremio-enhanced](https://github.com/REVENGE977/stremio-enhanced)
- [Fxy6969/Stremio-Glass-Theme](https://github.com/Fxy6969/Stremio-Glass-Theme)
- [Bo0ii/StreamGo](https://github.com/Bo0ii/StreamGo)

These projects were important inspiration, and I used many of their features for my own custom build.

---

## Feedback

This started as a fun personal project and is improved iteratively.
If you find reproducible bugs or have ideas, please share feedback or open an issue.
