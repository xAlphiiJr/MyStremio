# MyStremio

**MyStremio** is a customized Windows desktop client based on the Stremio shell. It bundles enhanced playback, interface tweaks, library collections, Discord Rich Presence, and many plugins — all in one installer.

> **Disclaimer:** MyStremio is an independent community project. It is not affiliated with or endorsed by Stremio AG.

---

## Installation

You only need **one file** — just like the official Stremio installer.

1. Open the [GitHub Releases](https://github.com/YOUR_USERNAME/MyStremio/releases) page.
2. Download **`MyStremioSetup-v2.1.0_x64.exe`** (or the latest version).
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

## Custom features

### Player & playback

| Feature | Description |
|---------|-------------|
| **Subtitle sync** | Adjust subtitle delay per session; embedded subtitles supported |
| **Audio sync** | Fine-tune audio delay for out-of-sync streams |
| **Autoskip** | Skip intros, outros, and credits (AniSkip + TheIntroDB integration) |
| **Picture-in-Picture** | PiP button in the video player |
| **Seek buffer** | Improved seeking and buffer handling |
| **Stream cache** | Caches stream metadata for faster re-selection |
| **Player glass UI** | Frosted-glass styling on the player overlay |
| **Player loading** | Enhanced loading states during playback start |
| **Favorite languages** | Prefer audio/subtitle languages; dedicated settings page |
| **Playback API** | Extended playback control hooks for plugins |
| **Enhanced player** | Subtitle styling, ASS cleanup, RTL fixes, title display |
| **Enhanced external player** | Launch VLC, MPC-HC, and other external players |
| **Stream UI** | Unified stream list with ratings, accordions, AfterCredits, WatchHub |
| **Stream quality picker** | Groups streams by resolution with smart ranking and “Best Pick” |
| **Filter streams** | Filter episode/movie streams by criteria |
| **AniSkip** | Anime opening/ending skip (Kitsu metadata) |
| **TheIntroDB** | Skip intros, recaps, credits, and previews |

### Library & navigation

| Feature | Description |
|---------|-------------|
| **Library collections** | Create custom folders (Watchlist, Favorites, etc.) via **+** in the library filter bar |
| **Add to collection** | Right-click or **Shift+click** library items to add/remove from active collection |
| **Liquid Glass navigation** | Horizontal top navigation integrated with the Liquid Glass theme |
| **Scroll restore** | Remembers scroll position when navigating back |
| **Deep links** | Improved handling of `stremio://` and external links |
| **Slash to search** | Press `/` to focus the search bar from the main menu |

### Interface & themes

| Feature | Description |
|---------|-------------|
| **Liquid Glass theme** | Modern glassmorphism UI (default) |
| **AMOLED theme** | Pure black theme for OLED displays |
| **Hide titlebar buttons** | Optional minimal title bar |
| **Dynamic Hero** | Netflix-style rotating hero banner on the home screen |
| **Enhanced covers** | Wider Continue Watching posters with logo overlay |
| **Enhanced title bar** | Extra info in the window title bar |
| **Context menu fix** | Context menus render above all UI layers |
| **Enhancements tweaks** | Combined interface and player tweaks |
| **Custom settings UI** | Dedicated **MyStremio** section in Stremio settings |

### Metadata & discovery

| Feature | Description |
|---------|-------------|
| **Data enrichment** | TMDB-powered cast, similar titles, collections, ratings (requires TMDB API key) |
| **Meta hover panel** | Rich info panel when hovering posters |
| **Card hover info** | IMDB rating and release date on card hover |
| **Playback preview** | Trailer preview on poster hover (Netflix-style) |
| **Trending anime** | Top airing anime row from MyAnimeList |

### Integrations & utilities

| Feature | Description |
|---------|-------------|
| **Discord Rich Presence** | Shows what you are watching in Discord |
| **Addon marketplace** | Browse and manage custom addon integrations |
| **Cinebye addons** | Curated addon helpers |
| **DOM inspector** | Developer tool for inspecting Stremio’s DOM |
| **Plugin initializer** | Loads and validates bundled plugins |

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

Output: `release\MyStremioSetup-v2.1.0_x64.exe`

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

## Version

**2.1.0** — Rebranded to MyStremio, single-installer release, library collection click fix.
