# Upstream stremio-web bundle

Checked-in `webui/` is the **patched MyStremio output**, not a stock Stremio build.

To rebuild from a clean input:

1. Run `scripts/fetch-stremio-web.ps1` (clones https://github.com/Stremio/stremio-web into repo-root `.tmp/stremio-web`).
2. Run `scripts/build-webui.ps1`. That script copies `.tmp/stremio-web/build` over `webui/` and applies every entry in `scripts/patches.json`.

The webpack content-hash folder under `webui/` is discovered at patch time from `index.html` / `scripts/main.js`. Do not hardcode it.

`mystremio-preboot.js` is generated from `assets/custom_preboot.js` during `cargo build` and `build-webui.ps1`. Do not edit it by hand.
