const assert = require('assert');

global.MutationObserver = class {
  observe() {}
  disconnect() {}
};
global.location = { hash: '', pathname: '' };
global.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
global.document = {
  addEventListener() {},
  documentElement: { lang: 'en' },
  body: {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {},
  },
  head: { appendChild() {} },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
  getElementById() {
    return null;
  },
  createElement() {
    return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} };
  },
};
global.window = {
  addEventListener() {},
  setTimeout,
  location: global.location,
};
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

require('./custom_library_folders.js');

const { parseCsv, mergeCollectionRows, libraryRowDecision } = window.__libraryCsvPlan;

const semi = parseCsv('type;id;name;folder\nmovie;tt0111161;Inception;Action');
assert.strictEqual(semi[1][0], 'movie');
assert.strictEqual(semi[1][1], 'tt0111161');
assert.strictEqual(semi[1][3], 'Action');

const comma = parseCsv('type,id,name,folder\nmovie,tt1,"A, B",Action');
assert.strictEqual(comma[1][2], 'A, B');

const visible = new Set(['movie:tt1']);
const metaIds = new Set(['tt1', 'tt2']);
assert.strictEqual(libraryRowDecision(visible, metaIds, 'movie', 'tt9', 'New', 'both').action, 'add');
assert.strictEqual(libraryRowDecision(visible, metaIds, 'movie', 'tt1', 'Old', 'both').action, 'already');
assert.strictEqual(libraryRowDecision(visible, metaIds, 'movie', 'tt2', 'Gone', 'both').action, 'skip');

const plan = mergeCollectionRows(
  [
    { id: 'keep', name: 'Stay', items: ['movie:tt9'] },
    { id: 'old', name: 'Action', items: ['movie:tt1'] },
  ],
  parseCsv('folder,type,id\nAction,movie,tt1\nAction,movie,tt2\n')
);
assert.strictEqual(plan.folders.length, 2);
assert.strictEqual(plan.folders[0].id, 'keep');
assert.deepStrictEqual(plan.folders[0].items, ['movie:tt9']);
assert.deepStrictEqual(plan.folders[1].items, ['movie:tt1', 'movie:tt2']);
assert.strictEqual(plan.already, 1);
assert.strictEqual(plan.added, 1);

const { entriesFromStorage, recordsFromEntries } = window.__libraryCsvPlan;
const stored = recordsFromEntries(entriesFromStorage(
  JSON.stringify({ items: { tt1: { _id: 'tt1', type: 'movie', name: 'Old', removed: false } } }),
  JSON.stringify({ items: { tt2: { _id: 'tt2', type: 'movie', name: 'Gone', removed: true } } })
));
assert.strictEqual(stored.visible.size, 1);
assert.ok(stored.metaIds.has('tt1') && stored.metaIds.has('tt2'));

const { mergeLibraryExportRows, planLibraryImportRow } = window.__libraryCsvPlan;
const merged = mergeLibraryExportRows([
  { type: 'movie', id: 'tt0137523', name: 'Fight Club', folder: 'A', poster: '', imdb: 'tt0137523' },
  { type: 'movie', id: 'tmdb:550', name: 'Fight Club', folder: 'B', poster: 'https://image.tmdb.org/t/p/w500/x.jpg', imdb: 'tt0137523' },
]);
assert.strictEqual(merged.length, 1);
assert.strictEqual(merged[0].id, 'tt0137523');
assert.strictEqual(merged[0].poster, 'https://image.tmdb.org/t/p/w500/x.jpg');
assert.strictEqual(merged[0].alt, 'tmdb:550');
assert.ok(merged[0].folder.split(';').includes('A') && merged[0].folder.split(';').includes('B'));

const onlyTmdb = mergeLibraryExportRows([
  { type: 'movie', id: 'tmdb:550', name: 'Fight Club', folder: '', poster: '', imdb: 'tt0137523' },
]);
assert.strictEqual(onlyTmdb[0].id, 'tt0137523');
assert.strictEqual(onlyTmdb[0].alt, 'tmdb:550');
assert.ok(onlyTmdb[0].poster.includes('tt0137523'));

const existing = new Map([
  ['movie:tt0137523', { key: 'movie:tt0137523', id: 'tt0137523', type: 'movie', poster: 'https://img/x.jpg' }],
]);
const byImdb = new Map([['movie:tt0137523', existing.get('movie:tt0137523')]]);
const same = planLibraryImportRow(existing, byImdb, new Set(['tt0137523']), 'movie', 'tmdb:550', 'Fight Club', 'both', 'tt0137523', '', 'tmdb:550');
assert.strictEqual(same.action, 'already');
assert.strictEqual(same.key, 'movie:tt0137523');

const blank = new Map([
  ['movie:tmdb:550', { key: 'movie:tmdb:550', id: 'tmdb:550', type: 'movie', imdb: '', poster: '', watched: false }],
]);
const upgrade = planLibraryImportRow(blank, new Map(), new Set(['tmdb:550']), 'movie', 'tt0137523', 'Fight Club', 'both', 'tt0137523', 'https://image.tmdb.org/t/p/w500/x.jpg', 'tmdb:550');
assert.strictEqual(upgrade.action, 'add');
assert.strictEqual(upgrade.metaId, 'tt0137523');
assert.deepStrictEqual(upgrade.dropIds, ['tmdb:550']);
blank.get('movie:tmdb:550').watched = true;
const kept = planLibraryImportRow(blank, new Map(), new Set(['tmdb:550']), 'movie', 'tt0137523', 'Fight Club', 'both', 'tt0137523', '', 'tmdb:550');
assert.deepStrictEqual(kept.dropIds, []);

const fresh = planLibraryImportRow(new Map(), new Map(), new Set(), 'movie', 'tmdb:550', 'Fight Club', 'both', 'tt0137523', '');
assert.strictEqual(fresh.action, 'add');
assert.strictEqual(fresh.metaId, 'tt0137523');
assert.ok(fresh.poster.includes('tt0137523'));

console.log('library csv plan ok');
