'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadAirRaidModule = require('../test-support/load-air-raid-module');

const moduleDefinition = loadAirRaidModule();

// loadAirRaidData logs at runtime; the shared loader only stubs Log while requiring the module
global.Log = { info() {}, error() {}, log() {} };

const ALERTS_A = [{ regionId: '12', activeAlerts: [{ type: 'AIR' }] }];
const ALERTS_B = [{ regionId: '12', activeAlerts: [] }];

// Instance with the network and rendering stubbed: `responses` are returned
// (or thrown, for Error values) by fetchLocal one per call, in order.
function makeInstance(responses) {
	const instance = Object.assign(Object.create(moduleDefinition), {
		config: { apiKey: 'key' },
		regionToOblast: {},
		requestedPaths: [],
		renders: [],
	});
	instance.loadRegions = async () => {};
	instance.updateDom = () => instance.renders.push({ isLoading: instance.isLoading });
	instance.fetchLocal = async (path) => {
		instance.requestedPaths.push(path);
		const response = responses.shift();
		if (response instanceof Error) {
			throw response;
		}
		return response;
	};
	return instance;
}

test('each cycle sends exactly one API request: /alerts', async () => {
	// The API answers 401 to a second request within seconds, so a /status
	// pre-check followed by /alerts made every changed cycle fail.
	const instance = makeInstance([ALERTS_A, ALERTS_A, ALERTS_B]);

	await instance.loadAirRaidData();
	await instance.loadAirRaidData();
	await instance.loadAirRaidData();

	assert.deepEqual(instance.requestedPaths, ['/alerts', '/alerts', '/alerts']);
});

test('first load shows the loader, then renders the data', async () => {
	const instance = makeInstance([ALERTS_A]);

	await instance.loadAirRaidData();

	assert.deepEqual(instance.airRaidData, ALERTS_A);
	assert.deepEqual(instance.renders, [{ isLoading: true }, { isLoading: false }]);
});

test('unchanged alerts do not re-render, changed alerts re-render without the loader', async () => {
	const instance = makeInstance([ALERTS_A, ALERTS_A, ALERTS_B]);
	await instance.loadAirRaidData();
	instance.renders = [];

	await instance.loadAirRaidData();
	assert.deepEqual(instance.renders, [], 'same data: the map must not blink');

	await instance.loadAirRaidData();
	assert.deepEqual(instance.airRaidData, ALERTS_B);
	assert.deepEqual(instance.renders, [{ isLoading: false }]);
});

test('a failed request keeps the last alerts and is retried next cycle', async () => {
	const instance = makeInstance([ALERTS_A, new Error('Response status: 500'), ALERTS_B]);
	await instance.loadAirRaidData();

	await instance.loadAirRaidData();
	assert.deepEqual(instance.airRaidData, ALERTS_A);

	await instance.loadAirRaidData();
	assert.deepEqual(instance.airRaidData, ALERTS_B);
	assert.deepEqual(instance.requestedPaths, ['/alerts', '/alerts', '/alerts']);
});
