'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadAirRaidModule = require('../test-support/load-air-raid-module');

const moduleDefinition = loadAirRaidModule();

function makeInstance(config) {
	return Object.assign(Object.create(moduleDefinition), {
		config: { ...moduleDefinition.defaults, ...config },
	});
}

const RELAY = { relayUrl: 'https://relay.example/v1', relayToken: 'tok' };

test('direct mode: updateInterval defaults to 90s, which is also the minimum', () => {
	assert.equal(makeInstance({ apiKey: 'k' }).getUpdateTimerInterval(), 90 * 1000);
	assert.equal(makeInstance({ apiKey: 'k', updateInterval: 30 }).getUpdateTimerInterval(), 90 * 1000);
	assert.equal(makeInstance({ apiKey: 'k', updateInterval: 120 }).getUpdateTimerInterval(), 120 * 1000);
});

test('relay mode: updateInterval defaults to 10s, which is also the minimum', () => {
	assert.equal(makeInstance(RELAY).getUpdateTimerInterval(), 10 * 1000);
	assert.equal(makeInstance({ ...RELAY, updateInterval: 5 }).getUpdateTimerInterval(), 10 * 1000);
	assert.equal(makeInstance({ ...RELAY, updateInterval: 30 }).getUpdateTimerInterval(), 30 * 1000);
});

test('relayUrl switches to relay mode even when apiKey is also set', () => {
	assert.equal(makeInstance({ apiKey: 'k' }).isRelayMode(), false);
	assert.equal(makeInstance({ ...RELAY, apiKey: 'k' }).isRelayMode(), true);
});

test('direct mode sends only the API key to the node_helper', () => {
	assert.deepEqual(makeInstance({ apiKey: 'k' }).getRequestHeaders(), { 'Authorization': 'k' });
});

test('relay mode sends the relay URL and token, never the API key', () => {
	assert.deepEqual(makeInstance({ ...RELAY, apiKey: 'k' }).getRequestHeaders(), {
		'X-Relay-Url': 'https://relay.example/v1',
		'X-Relay-Token': 'tok',
	});
});

test('fetchLocal passes the mode headers to the node_helper route', async (t) => {
	const originalFetch = global.fetch;
	t.after(() => { global.fetch = originalFetch; });
	const calls = [];
	global.fetch = async (url, options) => {
		calls.push({ url, headers: options.headers });
		return new Response('[]', { status: 200 });
	};

	assert.deepEqual(await makeInstance(RELAY).fetchLocal('/alerts'), []);
	assert.deepEqual(calls, [{
		url: '/alerts',
		headers: { 'X-Relay-Url': 'https://relay.example/v1', 'X-Relay-Token': 'tok' },
	}]);
});
