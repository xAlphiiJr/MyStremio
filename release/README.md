# Release artifacts

Upload **both** files to each GitHub Release:

- `MyStremioSetup-v{version}_x64.exe`
- `SHA256SUMS.txt`

Both are produced by `package-release.ps1` in the local `release/` folder.

Installer binaries (`.exe`, `.zip`) are gitignored and must not be committed. `SHA256SUMS.txt` in the repo is only a convenience copy for developers — the **in-app updater reads it from the GitHub Release assets**, not from the source tree.

## Manual release checklist

1. Bump `version` in `stremio-shell/stremio-shell-ng-main/Cargo.toml`
2. Run `package-release.ps1`
3. Create a GitHub Release with tag `v{version}` (example: `v2.3.4`)
4. Attach `MyStremioSetup-v{version}_x64.exe` and `SHA256SUMS.txt` from `release/`

## In-app updater requirements

The app checks `https://api.github.com/repos/xAlphiiJr/MyStremio/releases/latest`.

For automatic updates to work:

1. The release tag version must be **higher** than the installed app version (semver, e.g. `2.3.3` → `2.3.4`).
2. Both assets must be attached to that release (installer + `SHA256SUMS.txt`).
3. Names must match: `MyStremioSetup-v2.3.4_x64.exe` and a `SHA256SUMS.txt` line for that exact filename.
