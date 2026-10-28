'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadAirRaidModule = require('../test-support/load-air-raid-module');

const moduleDefinition = loadAirRaidModule();

global.Log = { info() {}, error() {}, log() {} };

const ALERTS = [{ regionId: '12', activeAlerts: [{ type: 'AIR' }] }];
const MINUTE = 60 * 1000;
const START = new Date(2026, 9, 28, 21, 0, 0).getTime(); // local time

// `responses`: what fetchLocal returns per call, as { data, asOf } or an Error.
function makeInstance(responses = [], config = {}) {
	const instance = Object.assign(Object.create(moduleDefinition), {
		config: { ...moduleDefinition.defaults, apiKey: 'key', ...config },
		regionToOblast: {},
		startedAt: START,
		renders: [],
	});
	instance.translate = (key, vars) => (vars ? `${key}:${vars.time}` : key);
	instance.loadRegions = async () => {};
	instance.updateDom = () => instance.renders.push(instance.getStaleNotice());
	instance.fetchLocal = async () => {
		const response = responses.shift();
		if (response instanceof Error) {
			throw response;
		}
		instance.lastResponseAsOf = response.asOf ?? null;
		return response.data;
	};
	return instance;
}

function withNow(t, now) {
	const realNow = Date.now;
	Date.now = () => now.value;
	t.after(() => { Date.now = realNow; });
}

test('staleAfter defaults to 10 minutes', () => {
	assert.equal(moduleDefinition.defaults.staleAfter, 10);
});

test('fetchLocal records the X-Data-As-Of header of the response', async (t) => {
	const originalFetch = global.fetch;
	t.after(() => { global.fetch = originalFetch; });
	global.fetch = async () => new Response('[]', { status: 200, headers: { 'X-Data-As-Of': '2026-10-28T19:00:00Z' } });
	const instance = Object.assign(Object.create(moduleDefinition), { config: { apiKey: 'k' } });

	await instance.fetchLocal('/alerts');

	assert.equal(instance.lastResponseAsOf, '2026-10-28T19:00:00Z');
});

test('dataAsOf comes from X-Data-As-Of, or the fetch time without it', async (t) => {
	const now = { value: START + 5 * MINUTE };
	withNow(t, now);
	const instance = makeInstance([
		{ data: ALERTS, asOf: new Date(START + 2 * MINUTE).toISOString() },
		{ data: ALERTS },
	]);

	await instance.loadAirRaidData();
	assert.equal(instance.dataAsOf, START + 2 * MINUTE);

	await instance.loadAirRaidData();
	assert.equal(instance.dataAsOf, START + 5 * MINUTE);
});

test('a failed update keeps dataAsOf, so the data ages', async (t) => {
	const now = { value: START };
	withNow(t, now);
	const instance = makeInstance([{ data: ALERTS }, new Error('Response status: 500')]);

	await instance.loadAirRaidData();
	now.value = START + 11 * MINUTE;
	await instance.loadAirRaidData();

	assert.equal(instance.dataAsOf, START);
	assert.equal(instance.isDataStale(), true);
});

test('stale strictly after staleAfter minutes; 0 turns it off', () => {
	const instance = makeInstance();
	instance.dataAsOf = START;

	assert.equal(instance.isDataStale(START + 10 * MINUTE), false);
	assert.equal(instance.isDataStale(START + 10 * MINUTE + 1), true);

	instance.config.staleAfter = 0;
	assert.equal(instance.isDataStale(START + 60 * MINUTE), false);
	instance.config.staleAfter = 2;
	assert.equal(instance.isDataStale(START + 3 * MINUTE), true);
});

test('before any data, staleness counts from the module start', () => {
	const instance = makeInstance();

	assert.equal(instance.getStaleNotice(START + 5 * MINUTE), '');
	assert.equal(instance.getStaleNotice(START + 11 * MINUTE), 'stale_no_data');
});

test('the notice shows the time of the data, with the date when not today', () => {
	const instance = makeInstance();
	instance.dataAsOf = new Date(2026, 9, 28, 9, 5).getTime();

	assert.equal(instance.getStaleNotice(new Date(2026, 9, 28, 9, 30).getTime()), 'stale:09:05');
	assert.equal(instance.getStaleNotice(new Date(2026, 9, 29, 0, 10).getTime()), 'stale:28.10 09:05');
});

test('the notice appears, updates and disappears without new alert data', async (t) => {
	const now = { value: START };
	withNow(t, now);
	const old = new Date(START).toISOString();
	const instance = makeInstance([
		{ data: ALERTS, asOf: old },
		{ data: ALERTS, asOf: old },
		{ data: ALERTS, asOf: old },
		{ data: ALERTS, asOf: new Date(START + 12 * MINUTE).toISOString() },
	]);

	await instance.loadAirRaidData(); // first load renders twice (loader, data)
	instance.renderedStaleNotice = instance.getStaleNotice();
	instance.renders = [];

	now.value = START + 5 * MINUTE;
	await instance.loadAirRaidData();
	assert.deepEqual(instance.renders, [], 'fresh and unchanged: no re-render');

	now.value = START + 11 * MINUTE;
	await instance.loadAirRaidData();
	assert.deepEqual(instance.renders, ['stale:21:00'], 'the relay stopped confirming: notice shows');
	instance.renderedStaleNotice = 'stale:21:00';

	now.value = START + 13 * MINUTE;
	await instance.loadAirRaidData();
	assert.deepEqual(instance.renders, ['stale:21:00', ''], 'confirmed again: notice goes');
});

test('getDom dims the map and adds the notice only when stale', async (t) => {
	const originalDocument = global.document;
	t.after(() => { global.document = originalDocument; });
	global.document = {
		createElement: () => {
			const classes = [];
			return { className: '', innerHTML: '', classList: { add: c => classes.push(c), list: classes } };
		},
	};
	const instance = makeInstance();
	instance.mapTemplate = async () => '<svg></svg>';
	instance.dataAsOf = START;

	const now = { value: START + MINUTE };
	withNow(t, now);
	let dom = await instance.getDom();
	assert.deepEqual(dom.classList.list, []);
	assert.doesNotMatch(dom.innerHTML, /air-raid-stale/);

	now.value = START + 20 * MINUTE;
	dom = await instance.getDom();
	assert.deepEqual(dom.classList.list, ['is-stale']);
	assert.match(dom.innerHTML, /<div class="air-raid-stale">stale:21:00<\/div>/);
	assert.equal(instance.renderedStaleNotice, 'stale:21:00');
});
