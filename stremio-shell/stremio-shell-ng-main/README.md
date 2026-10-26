# MyStremio shell

Windows shell for MyStremio. User-facing docs and the installer live in the repo root `README.md`, `package-release.ps1`, and `setup/MyStremio.iss`.

One person, one window. Rust draws the page in WebView2 and plays video with MPV.

## Where a change goes

New UI behavior goes in a plugin (`assets-bundle/plugins`) or a script in `assets/custom_*.js`. Add a Python patch only when the minified Stremio page cannot be reached from those. Patch ids live in `scripts/patches.json`. Rebuild the page with `scripts/build-webui.ps1`.

Plugins are copied into the app and toggled in Settings. Scripts below are compiled into the exe. The order is the inject order in `src/stremio_app/stremio_wevbiew/wevbiew.rs`. Add a script there and a line here.

## Injected scripts

`custom_preboot.js` is written into `webui/index.html` before the bundled page. The rest run after it:

- `custom_startup_guard.js` — cold boot leaves a dead `#/player` route
- `custom_route_change.js` — tells other scripts when the hash route changes
- `custom_quick_play.js` — picks a stream from the saved resolution and quality
- `custom_bootstrap.js` — settings, plugin loader, theme, autoskip, the shell API
- `custom_scroll_restore.js` — puts the board scroll back when you return
- `custom_board_row_nav.js` — horizontal scroll on board rows
- `custom_player_glass.js` — glass look on the player chrome
- `custom_dead_player_nav.js` — Back and history must not land on a dead player
- `custom_player_loading.js` — player load state and when MPV is shown
- `custom_liquid_glass_nav.js` — the nav bar stays put across tabs
- `custom_hero_loading.js` — board hero while the poster is still loading
- `custom_deep_link.js` — opens `stremio://` links in this window
- `custom_continue_watching_posters.js` — poster and title fixes on Continue Watching
- `custom_continue_watching_play.js` — play on Continue Watching opens the player
- `custom_audio_sync.js` — keeps the chosen audio language across episodes
- `custom_subtitle_sync.js` — keeps the chosen subtitle language across episodes
- `custom_library_folders.js` — custom library folders and CSV import/export
- `custom_addon_manager.js` — reorder, rename, and pick metadata addons
- `custom_addon_soft_disable.js` — an addon can be off without uninstalling
- `custom_metadata_meta_gate.js` — only the chosen addons supply metadata
- `custom_discord_presence.js` — sends playback to Discord
- `custom_settings_ui.js` — MyStremio settings page and plugin categories
- `custom_settings_quick_nav.js` — reload button and quick-settings layout
- `custom_ui_scale.js` — UI scale control
- `custom_api_key_settings.js` — plugin forms show key status instead of a key field
- `custom_api_keys_hub.js` — the one API Keys page
- `custom_playback_bootstrap.js` — fullscreen and the first player hookup
- `custom_stream_cache.js` — how much of the stream is cached
- `custom_playback_api.js` — the player bridge the page uses instead of a `<video>` element
- `custom_seek_buffer.js` — buffer bar on the seek bar
- `custom_volume_persist.js` — volume survives a restart
- `custom_player_disable_hold_speed.js` — holding the mouse does not change playback speed
- `custom_track_label_fix.js` — fixes garbled audio and subtitle names
- `custom_search_suggestions.js` — search suggestions above the search bar
- `custom_mark_watched.js` — watched marks on the episode list
