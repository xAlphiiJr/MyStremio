const assert = require("assert");

const listeners = {};
const timers = new Set();
const originalSetInterval = global.setInterval;
global.setInterval = (fn, ms) => {
	const id = originalSetInterval(fn, ms);
	timers.add(id);
	return id;
};

function classList() {
	return { add() {}, remove() {}, toggle() {}, contains() { return false; }, forEach() {} };
}

global.MutationObserver = class {
	observe() {}
	disconnect() {}
};
global.location = { hash: "", href: "http://local/", pathname: "" };
global.document = {
	title: "",
	documentElement: { classList: classList() },
	addEventListener(name, fn) {
		(listeners[name] ||= []).push(fn);
	},
	removeEventListener() {},
	body: { classList: classList() },
	head: { appendChild() {} },
	querySelector() { return null; },
	querySelectorAll() { return []; },
	getElementById() { return null; },
	createElement() {
		return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} };
	}
};
global.window = {
	addEventListener() {},
	setTimeout,
	setInterval: global.setInterval,
	clearInterval,
	clearTimeout,
	location: global.location,
	StremioCustomPlayback: null
};
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

require("./tidb.plugin.js");

const plugin = window.tidbPlugin;
const episodeId = "tt0000001:1:1";
const segment = { type: "intro", start: 0, end: 90 };

function armPlayback(snap, position) {
	window.StremioCustomPlayback = {
		getMpvSnapshot: () => snap,
		getDuration: () => 1400
	};
	plugin.episodeId = episodeId;
	plugin.getPlaybackCurrentTime = () => position;
}

const buffering = {
	hasStream: true,
	playbackAdvanced: true,
	timeFresh: true,
	seeking: false,
	buffering: true,
	position: 10
};
armPlayback(buffering, 10);
const stalled = { duration: 1400, currentTime: 10 };
assert.strictEqual(plugin.seekToSegment(stalled, segment), false);
assert.strictEqual(stalled.currentTime, 10);
assert.strictEqual(plugin._autoSkippedKeys.size, 0);

const playing = { ...buffering, buffering: false };
armPlayback(playing, 10);
const video = { duration: 1400, currentTime: 10 };
assert.strictEqual(plugin.seekToSegment(video, segment), true);
assert.strictEqual(video.currentTime, 90);
assert.ok(plugin._autoSkippedKeys.has(plugin.getAutoSkipKey(segment)));

const broken = {
	duration: 1400,
	get currentTime() { return 10; },
	set currentTime(_value) { throw new Error("mpv rejected seek"); }
};
plugin._autoSkippedKeys.clear();
armPlayback(playing, 10);
assert.strictEqual(plugin.seekToSegment(broken, segment), false);
assert.ok(plugin._autoSkippedKeys.has(plugin.getAutoSkipKey(segment)));
assert.strictEqual(plugin.tryAutoSkip(broken, segment), true);

const clockVideo = { duration: 1400, currentTime: 10 };
armPlayback(buffering, 10);
plugin._autoSkipPending = true;
plugin._autoSkippedKeys.clear();
plugin._skipGraceLeft = 10000;
plugin._skipGraceTickAt = 0;
plugin.syncAutoSkipCountdown(clockVideo, segment);
assert.strictEqual(plugin._skipGraceLeft, 10000);
assert.strictEqual(plugin._skipGraceTickAt, 0);
assert.strictEqual(clockVideo.currentTime, 10);

armPlayback(playing, 10);
plugin._skipGraceTickAt = Date.now() - 4000;
plugin.syncAutoSkipCountdown(clockVideo, segment);
assert.ok(plugin._skipGraceLeft < 7000 && plugin._skipGraceLeft > 5000);
assert.strictEqual(clockVideo.currentTime, 10);
const pausedLeft = plugin._skipGraceLeft;
armPlayback(buffering, 10);
plugin.syncAutoSkipCountdown(clockVideo, segment);
plugin.syncAutoSkipCountdown(clockVideo, segment);
assert.strictEqual(plugin._skipGraceLeft, pausedLeft);
assert.strictEqual(clockVideo.currentTime, 10);

armPlayback(playing, 10);
plugin._skipGraceLeft = 500;
plugin._skipGraceTickAt = Date.now() - 1000;
plugin.syncAutoSkipCountdown(clockVideo, segment);
assert.strictEqual(clockVideo.currentTime, 90);
plugin._autoSkipPending = false;

const { seekBarHighlightBox, resolveSegmentEndSec } = window.__tidbHighlight;
const shortIntro = seekBarHighlightBox(0, 10, 7200);
assert.ok(shortIntro.widthPct < 0.2);
assert.strictEqual(shortIntro.leftPct, 0);
const endCredits = seekBarHighlightBox(7170, 7200, 7200);
assert.ok(endCredits.leftPct > 99.5);
assert.ok(endCredits.widthPct < 0.5);
assert.strictEqual(seekBarHighlightBox(0, null, 1440), null);
assert.strictEqual(resolveSegmentEndSec("intro", { start: 0, end: null }, 1440), null);
assert.strictEqual(resolveSegmentEndSec("credits", { start: 1400, end: null }, 1440), 1440);

plugin._autoSkippedKeys.add("keep-until-new-file");
plugin._fetchRequestedPath = "/old.mkv";
plugin._activeStreamPath = "/old.mkv";
listeners["stremio-custom-stream-started"][0]({ detail: { path: "/new.mkv" } });
assert.strictEqual(plugin._autoSkippedKeys.size, 0);
assert.strictEqual(plugin._fetchRequestedPath, null);
assert.strictEqual(plugin._activeStreamPath, "/new.mkv");

(async () => {
	plugin.episodeId = episodeId;
	plugin.video = { duration: 1400, getAttribute() { return null; } };
	plugin._lastSeenUrl = window.location.href;
	plugin._lastVideoSource = null;
	plugin._segmentsStreamPath = null;
	plugin._activeStreamPath = "/new.mkv";
	plugin._fetchRequestedPath = null;
	plugin.resolvePlaybackContext = async () => ({ episodeId });
	plugin.getPlaybackVideo = () => plugin.video;
	let fetches = 0;
	plugin.fetchData = () => {
		fetches += 1;
		return Promise.resolve(null);
	};
	await plugin.checkPlaybackChange();
	assert.strictEqual(fetches, 1);
	await plugin.checkPlaybackChange();
	assert.strictEqual(fetches, 1);

	plugin._segmentsStreamPath = null;
	plugin._fetchRequestedPath = null;
	await plugin.checkPlaybackChange();
	assert.strictEqual(fetches, 2);

	plugin.destroy();
	for (const id of timers) clearInterval(id);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
