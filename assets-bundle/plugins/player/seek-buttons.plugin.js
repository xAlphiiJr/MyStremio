/**

 * @name Seek Buttons

 * @description Skip back and forward in the player control bar (configurable interval)

 * @version 1.6.0

 * @author MyStremio

 * @category player

 */

/* jshint esversion: 11, browser: true, devel: true */



(function () {

	"use strict";



	const PLUGIN_VERSION = "1.6.1";

	const PLUGIN_ID = "seek-buttons";

	const SETTING_SKIP_SECONDS = "skipSeconds";

	const DEFAULT_SKIP_SEC = 10;

	const MIN_SKIP_SEC = 1;

	const MAX_SKIP_SEC = 600;

	const ICON_SIZE = "2.0rem";

	const STYLE_ID = "stremio-seek-buttons-styles";

	const GROUP_ID = "stremio-seek-buttons-group";

	const BACK_ID = "stremio-seek-back-btn";

	const FORWARD_ID = "stremio-seek-forward-btn";

	const BTN_CLASS = "stremio-seek-btn";



	if (window.__stremioSeekButtonsVersion !== PLUGIN_VERSION) {

		window.__stremioSeekButtonsReady = false;

		document.getElementById(GROUP_ID)?.remove();

		document.getElementById(STYLE_ID)?.remove();

	}



	function isSeekButtonsEnabled() {

		const helpers = window.StremioCustom?.helpers;

		if (!helpers?.isPluginEnabled) return false;

		return helpers.isPluginEnabled("player/seek-buttons.plugin.js");

	}



	if (!isSeekButtonsEnabled()) {

		window.__stremioSeekButtonsUnload = function teardownDisabled() {

			document.getElementById(GROUP_ID)?.remove();

			document.getElementById(STYLE_ID)?.remove();

			window.__stremioSeekButtonsReady = false;

			window.__stremioSeekButtonsVersion = "";

		};

		return;

	}



	if (window.__stremioSeekButtonsReady) return;



	const state = {

		skipSeconds: DEFAULT_SKIP_SEC,

		settingsReady: null,

	};



	const ICON_BACK = [

		"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",

		"M3 3v5h5",

	];



	function getSettingsApi() {

		return window.StremioCustomAPI || window.StremioEnhancedAPI || null;

	}



	function normalizeSkipSeconds(raw) {

		if (raw === null || raw === undefined || raw === "") return DEFAULT_SKIP_SEC;

		const parsed = Number(String(raw).trim().replace(",", "."));

		if (!Number.isFinite(parsed)) return DEFAULT_SKIP_SEC;

		return Math.min(MAX_SKIP_SEC, Math.max(MIN_SKIP_SEC, Math.round(parsed)));

	}



	function getSkipSeconds() {

		return normalizeSkipSeconds(state.skipSeconds);

	}



	async function initializeSettings() {

		const api = getSettingsApi();

		if (!api || window.__stremioSeekButtonsSettingsRegistered) return;



		const schema = [

			{

				key: SETTING_SKIP_SECONDS,

				type: "input",

				inputType: "number",

				label: "Skip interval (seconds)",

				description: `Seconds to skip when pressing back or forward (${MIN_SKIP_SEC}–${MAX_SKIP_SEC}).`,

				placeholder: String(DEFAULT_SKIP_SEC),

				defaultValue: String(DEFAULT_SKIP_SEC),

			},

		];



		try {

			await api.registerSettings(PLUGIN_ID, schema);

			window.__stremioSeekButtonsSettingsRegistered = true;

		} catch (err) {

			const message = err && err.message ? String(err.message) : "";

			if (message.includes("settings schema registered")) {

				window.__stremioSeekButtonsSettingsRegistered = true;

				return;

			}

			console.warn("[SeekButtons] Failed to register settings:", err);

		}

	}



	async function loadSettings() {

		const api = getSettingsApi();

		if (!api) {

			state.skipSeconds = DEFAULT_SKIP_SEC;

			return;

		}



		const raw = await api.getSetting(PLUGIN_ID, SETTING_SKIP_SECONDS);

		state.skipSeconds = normalizeSkipSeconds(raw);



		const normalized = String(state.skipSeconds);

		if (raw !== null && raw !== undefined && String(raw).trim() !== normalized) {

			try {

				await api.saveSetting(PLUGIN_ID, SETTING_SKIP_SECONDS, normalized);

			} catch (_) {}

		}

	}



	function wireSettingsListener() {

		const api = getSettingsApi();

		if (!api?.onSettingsSaved) return;



		api.onSettingsSaved(PLUGIN_ID, async (payload) => {

			if (payload && typeof payload === "object" && payload[SETTING_SKIP_SECONDS] != null) {

				state.skipSeconds = normalizeSkipSeconds(payload[SETTING_SKIP_SECONDS]);

			} else {

				await loadSettings();

			}

			rebuildButtons();

		});

	}



	function isPlayerRoute() {

		return /#\/player/.test(window.location.href || "");

	}



	function injectStyles() {

		let style = document.getElementById(STYLE_ID);

		if (!style) {

			style = document.createElement("style");

			style.id = STYLE_ID;

			(document.head || document.documentElement).appendChild(style);

		}

		style.textContent = `

			#${GROUP_ID} {

				display: flex !important;

				flex-direction: row !important;

				align-items: center !important;

				flex: none !important;

				margin: 0 !important;

				padding: 0 !important;

				border: none !important;

				background: transparent !important;

				gap: 0 !important;

			}

			#${GROUP_ID} .${BTN_CLASS} {

				margin: 0 !important;

				padding: 0 !important;

				flex: none !important;

			}

			#${GROUP_ID} .${BTN_CLASS} [class*="button-container"] {

				display: none !important;

			}

			#${GROUP_ID} .${BTN_CLASS} [class*="icon"],

			#${GROUP_ID} .${BTN_CLASS} svg {

				display: flex !important;

				align-items: center !important;

				justify-content: center !important;

				width: ${ICON_SIZE} !important;

				height: ${ICON_SIZE} !important;

				min-width: ${ICON_SIZE} !important;

				min-height: ${ICON_SIZE} !important;

				margin: 0 !important;

				padding: 0 !important;

				line-height: 0 !important;

			}

			#${GROUP_ID} .${BTN_CLASS} svg {

				flex: none !important;

				fill: none !important;

				stroke: currentColor !important;

				pointer-events: none !important;

			}

		`;

	}



	function getPlaybackVideo() {

		return (

			window.StremioCustomPlayback?.getVideo?.() ||

			document.querySelector('[class*="player-container"] video') ||

			document.querySelector("video")

		);

	}



	function getCurrentTimeSec() {

		const fromApi = window.StremioCustomPlayback?.getCurrentTime?.();

		if (Number.isFinite(fromApi)) return fromApi;

		const video = getPlaybackVideo();

		if (video && Number.isFinite(video.currentTime)) return video.currentTime;

		return 0;

	}



	function getDurationSec() {

		const fromApi = window.StremioCustomPlayback?.getDuration?.();

		if (Number.isFinite(fromApi) && fromApi > 0) return fromApi;

		const video = getPlaybackVideo();

		if (video && Number.isFinite(video.duration) && video.duration > 0) return video.duration;

		return null;

	}



	function seekTo(seconds) {

		const api = window.StremioCustomPlayback;

		if (api?.seekTo) {

			api.seekTo(seconds);

			return;

		}

		const video = getPlaybackVideo();

		if (video) video.currentTime = seconds;

	}



	function seekRelative(deltaSec) {

		let target = getCurrentTimeSec() + deltaSec;

		const duration = getDurationSec();

		if (duration != null) {

			target = Math.min(duration, Math.max(0, target));

		} else {

			target = Math.max(0, target);

		}

		seekTo(target);

	}



	function findVolumeInsertPoint() {

		const controlBar = document.querySelector('[class*="player-container"] [class*="control-bar-container"]');

		if (!controlBar) return null;



		const volumeRoot =

			controlBar.querySelector('[class*="control-bar-volume"]') ||

			controlBar.querySelector('[class*="volume-change-indicator"]')?.closest('[class*="control-bar"]') ||

			controlBar.querySelector('[class*="volume-slider"]')?.closest('[class*="volume"]') ||

			controlBar.querySelector('[class*="volume-slider"]')?.parentElement;



		if (!volumeRoot || !volumeRoot.parentNode) return null;

		const parent = volumeRoot.parentNode;
		const brightnessBtn = document.getElementById("mystremio-brightness-btn");
		if (
			brightnessBtn &&
			brightnessBtn.parentNode === parent &&
			brightnessBtn.previousElementSibling === volumeRoot
		) {
			return { parent, after: brightnessBtn };
		}

		return { parent, after: volumeRoot };

	}



	function getButtonTemplate() {

		const container = document.querySelector(

			'[class*="player-container"] [class*="control-bar-buttons-container"]'

		);

		if (!container) return null;

		return container.querySelector('[class*="control-bar-button"]:not([class*="menu"])');

	}



	function buildStrokeSvg(paths, className, mirror) {

		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

		svg.setAttribute("viewBox", "0 0 24 24");

		svg.setAttribute("fill", "none");

		svg.setAttribute("stroke", "currentColor");

		svg.setAttribute("stroke-width", "1.5");

		svg.setAttribute("stroke-linecap", "round");

		svg.setAttribute("stroke-linejoin", "round");

		svg.setAttribute("aria-hidden", "true");

		if (className) {

			svg.setAttribute("class", className);

		}



		const parent =

			mirror

				? (() => {

					const group = document.createElementNS("http://www.w3.org/2000/svg", "g");

					group.setAttribute("transform", "matrix(-1, 0, 0, 1, 24, 0)");

					svg.appendChild(group);

					return group;

				})()

				: svg;



		for (const pathData of paths) {

			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");

			path.setAttribute("d", pathData);

			parent.appendChild(path);

		}

		return svg;

	}



	function replaceButtonIcon(button, paths, mirror) {

		const iconWrap = button.querySelector('[class*="icon"]');

		const refSvg = button.querySelector("svg");

		const svgClass = refSvg?.getAttribute("class") || "";

		const svg = buildStrokeSvg(paths, svgClass, mirror);



		if (iconWrap) {

			iconWrap.replaceChildren(svg);

			return;

		}

		if (refSvg) {

			refSvg.replaceWith(svg);

			return;

		}

		button.appendChild(svg);

	}



	function applyAccessibleLabel(button, direction) {

		const label = direction === "back" ? "Skip backward" : "Skip forward";

		button.removeAttribute("title");

		button.setAttribute("aria-label", label);

	}



	function createSeekButton(id, direction, iconPaths, mirror) {

		const template = getButtonTemplate();

		let button;



		if (template) {

			button = template.cloneNode(true);

			button.classList.remove("disabled");

			button.removeAttribute("tabindex");

			button.removeAttribute("title");

			button.querySelectorAll('[class*="button-container"]').forEach((el) => el.remove());

		} else {

			button = document.createElement("button");

			button.type = "button";

		}



		button.id = id;

		button.classList.add(BTN_CLASS);

		applyAccessibleLabel(button, direction);

		replaceButtonIcon(button, iconPaths, mirror);



		button.addEventListener("click", (event) => {

			event.preventDefault();

			event.stopPropagation();

			const step = getSkipSeconds();

			seekRelative(direction === "back" ? -step : step);

		});



		return button;

	}



	function isStaleButton(button) {

		if (!button) return true;

		return !button.className.includes("control-bar-button");

	}



	function placeAfterVolume(group, insertPoint) {

		const { parent, after } = insertPoint;

		if (group.parentNode === parent && group.previousSibling === after) return;

		parent.insertBefore(group, after.nextSibling);

	}



	function rebuildButtons() {

		document.getElementById(GROUP_ID)?.remove();

		ensureButtons();

	}



	function ensureButtons() {

		if (!isPlayerRoute()) {

			document.getElementById(GROUP_ID)?.remove();

			return;

		}



		injectStyles();

		const insertPoint = findVolumeInsertPoint();

		if (!insertPoint) return;



		let group = document.getElementById(GROUP_ID);

		const back = document.getElementById(BACK_ID);

		const forward = document.getElementById(FORWARD_ID);

		if (group && (isStaleButton(back) || isStaleButton(forward))) {

			group.remove();

			group = null;

		}



		if (!group) {

			group = document.createElement("div");

			group.id = GROUP_ID;

			group.setAttribute("role", "group");

			group.setAttribute("aria-label", "Skip controls");

			group.appendChild(createSeekButton(BACK_ID, "back", ICON_BACK, false));

			group.appendChild(createSeekButton(FORWARD_ID, "forward", ICON_BACK, true));

			placeAfterVolume(group, insertPoint);

			return;

		}



		if (back) applyAccessibleLabel(back, "back");

		if (forward) applyAccessibleLabel(forward, "forward");

		placeAfterVolume(group, insertPoint);

	}



	let buttonsObserver = null;

	let buttonsInterval = null;



	function teardown() {
		window.__stremioSeekButtonsReady = false;
		window.__stremioSeekButtonsVersion = "";
		suspendRuntime();
		document.getElementById(STYLE_ID)?.remove();
	}

	/**
	 * Stops observers/intervals while off the player route without unloading the plugin.
	 */
	function suspendRuntime() {
		document.getElementById(GROUP_ID)?.remove();
		if (buttonsObserver) {
			buttonsObserver.disconnect();
			buttonsObserver = null;
		}
		if (buttonsInterval) {
			clearInterval(buttonsInterval);
			buttonsInterval = null;
		}
	}

	/**
	 * Re-attaches control-bar-scoped watchers when returning to the player.
	 */
	function ensureRuntime() {
		if (!isSeekButtonsEnabled() || !isPlayerRoute()) {
			suspendRuntime();
			return;
		}
		ensureButtons();
		if (buttonsObserver && buttonsInterval) return;

		if (!buttonsObserver) {
			const target =
				document.querySelector('[class*="player-container"] [class*="control-bar-buttons-container"]') ||
				document.querySelector('[class*="player-container"]') ||
				document.body;
			buttonsObserver = new MutationObserver(() => {
				if (!isSeekButtonsEnabled() || !isPlayerRoute()) {
					suspendRuntime();
					return;
				}
				ensureButtons();
			});
			buttonsObserver.observe(target, { childList: true, subtree: true });
		}

		if (!buttonsInterval) {
			buttonsInterval = setInterval(() => {
				if (!isSeekButtonsEnabled() || !isPlayerRoute()) {
					suspendRuntime();
					return;
				}
				ensureButtons();
			}, 2500);
		}
	}

	window.__stremioSeekButtonsUnload = suspendRuntime;

	function initObservers() {
		ensureRuntime();

		document.addEventListener("stremio-custom-route-change", () => {
			ensureRuntime();
		});
		document.addEventListener("stremio-custom-playback-route", () => {
			ensureRuntime();
		});
		document.addEventListener("stremio-custom-playback-stopped", () => {
			suspendRuntime();
		});
		document.addEventListener("stremio-custom-stream-started", () => {
			ensureRuntime();
		});
	}



	async function boot() {

		if (!isSeekButtonsEnabled()) {

			teardown();

			return;

		}



		state.settingsReady = initializeSettings();

		await state.settingsReady;

		await loadSettings();

		wireSettingsListener();



		window.__stremioSeekButtonsReady = true;

		window.__stremioSeekButtonsVersion = PLUGIN_VERSION;

		initObservers();

	}



	if (document.readyState === "loading") {

		document.addEventListener("DOMContentLoaded", () => boot().catch((err) => {

			console.warn("[SeekButtons] Boot failed:", err);

		}));

	} else {

		boot().catch((err) => {

			console.warn("[SeekButtons] Boot failed:", err);

		});

	}

})();


