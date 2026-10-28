'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const loadNodeHelper = require('../test-support/load-node-helper');

const helperDefinition = loadNodeHelper();

const ALERTS = [{ regionId: '12', activeAlerts: [{ type: 'AIR' }] }];
const REGIONS = { states: [{ regionId: '12', regionChildIds: [] }] };
const RELAY_URL = 'https://relay.example/v1';

// Helper instance with a private regions cache file and a fake global fetch
// that answers from `responses` (one per call, Response or Error) and records
// every request.
function setup(t, responses) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-raid-helper-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const requests = [];
	const originalFetch = global.fetch;
	global.fetch = async (url, options = {}) => {
		requests.push({ url, headers: { ...options.headers } });
		const response = responses.shift();
		if (response instanceof Error) {
			throw response;
		}
		return response;
	};
	t.after(() => { global.fetch = originalFetch; });

	const helper = Object.assign(Object.create(helperDefinition), {
		regionsCacheFile: path.join(dir, 'regions-cache.json'),
		regionsCache: null,
		regionsCacheTime: 0,
		relayResponses: new Map(),
	});
	return { helper, requests };
}

function json(data, { status = 200, etag } = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: etag ? { 'Content-Type': 'application/json', ETag: etag } : { 'Content-Type': 'application/json' },
	});
}

function notModified() {
	return new Response(null, { status: 304 });
}

function fakeRes() {
	return {
		statusCode: 200,
		body: undefined,
		status(code) { this.statusCode = code; return this; },
		send(body) { this.body = body; return this; },
	};
}

const directReq = { headers: { authorization: 'api-key' } };
const relayReq = (url = RELAY_URL) => ({ headers: { 'x-relay-url': url, 'x-relay-token': 'tok' } });

test('direct mode: /alerts goes to the UkraineAlarm API with the API key', async (t) => {
	const { helper, requests } = setup(t, [json(ALERTS)]);
	const res = fakeRes();

	await helper.fetchAlerts(directReq, res);

	assert.deepEqual(res.body, ALERTS);
	assert.equal(requests[0].url, 'https://api.ukrainealarm.com/api/v3/alerts');
	assert.equal(requests[0].headers.Authorization, 'api-key');
	assert.equal(requests[0].headers['X-Relay-Token'], undefined);
});

test('direct mode does not send conditional requests', async (t) => {
	const { helper, requests } = setup(t, [json(ALERTS, { etag: '"a"' }), json(ALERTS, { etag: '"a"' })]);

	await helper.fetchAlerts(directReq, fakeRes());
	await helper.fetchAlerts(directReq, fakeRes());

	assert.equal(requests[1].headers['If-None-Match'], undefined);
});

test('relay mode: /alerts goes to relayUrl with X-Relay-Token and no Authorization', async (t) => {
	const { helper, requests } = setup(t, [json(ALERTS)]);
	const res = fakeRes();

	await helper.fetchAlerts(relayReq(), res);

	assert.deepEqual(res.body, ALERTS);
	assert.equal(requests[0].url, 'https://relay.example/v1/alerts');
	assert.equal(requests[0].headers['X-Relay-Token'], 'tok');
	assert.equal(requests[0].headers.Authorization, undefined);
});

test('relay mode: trailing slashes in relayUrl are ignored', async (t) => {
	const { helper, requests } = setup(t, [json(ALERTS)]);

	await helper.fetchAlerts(relayReq('https://relay.example/v1//'), fakeRes());

	assert.equal(requests[0].url, 'https://relay.example/v1/alerts');
});

test('relay mode: an ETag is revalidated and a 304 returns the last data', async (t) => {
	const { helper, requests } = setup(t, [json(ALERTS, { etag: '"v1"' }), notModified()]);

	const first = fakeRes();
	await helper.fetchAlerts(relayReq(), first);
	const second = fakeRes();
	await helper.fetchAlerts(relayReq(), second);

	assert.equal(requests[0].headers['If-None-Match'], undefined);
	assert.equal(requests[1].headers['If-None-Match'], '"v1"');
	assert.equal(second.statusCode, 200);
	assert.deepEqual(second.body, ALERTS);
});

test('relay mode: new data with a new ETag replaces the cached one', async (t) => {
	const changed = [{ regionId: '12', activeAlerts: [] }];
	const { helper, requests } = setup(t, [
		json(ALERTS, { etag: '"v1"' }),
		json(changed, { etag: '"v2"' }),
		notModified(),
	]);

	await helper.fetchAlerts(relayReq(), fakeRes());
	await helper.fetchAlerts(relayReq(), fakeRes());
	const third = fakeRes();
	await helper.fetchAlerts(relayReq(), third);

	assert.equal(requests[2].headers['If-None-Match'], '"v2"');
	assert.deepEqual(third.body, changed);
});

test('relay mode: an error status is passed on as 500 and keeps the cached ETag', async (t) => {
	const { helper, requests } = setup(t, [
		json(ALERTS, { etag: '"v1"' }),
		json({ error: 'unauthorized' }, { status: 401 }),
		notModified(),
	]);

	await helper.fetchAlerts(relayReq(), fakeRes());
	const failed = fakeRes();
	await helper.fetchAlerts(relayReq(), failed);
	const recovered = fakeRes();
	await helper.fetchAlerts(relayReq(), recovered);

	assert.equal(failed.statusCode, 500);
	assert.match(failed.body.error, /401/);
	assert.equal(requests[2].headers['If-None-Match'], '"v1"');
	assert.deepEqual(recovered.body, ALERTS);
});

test('relay mode: a network failure answers 500', async (t) => {
	const { helper } = setup(t, [new TypeError('fetch failed')]);
	const res = fakeRes();

	await helper.fetchAlerts(relayReq(), res);

	assert.equal(res.statusCode, 500);
});

test('relay mode: a malformed relayUrl answers 400 without any request', async (t) => {
	for (const url of ['not a url', 'ftp://relay.example/v1', 'https://relay.example/v1?token=x', 'https://relay.example/v1#x']) {
		const { helper, requests } = setup(t, []);
		const res = fakeRes();

		await helper.fetchAlerts(relayReq(url), res);

		assert.equal(res.statusCode, 400, url);
		assert.match(res.body.error, /Invalid relayUrl/, url);
		assert.equal(requests.length, 0, url);
	}
});

test('relay mode: /regions comes from the relay and is cached on disk', async (t) => {
	const { helper, requests } = setup(t, [json(REGIONS, { etag: '"r"' })]);

	const first = fakeRes();
	await helper.fetchRegions(relayReq(), first);
	const second = fakeRes();
	await helper.fetchRegions(relayReq(), second);

	assert.deepEqual(first.body, REGIONS);
	assert.deepEqual(second.body, REGIONS);
	assert.equal(requests.length, 1, 'a fresh cache must not hit the relay again');
	assert.equal(requests[0].url, 'https://relay.example/v1/regions');
	assert.deepEqual(JSON.parse(fs.readFileSync(helper.regionsCacheFile, 'utf8')), REGIONS);
});

test('both modes: a stale regions cache is served when the refetch fails', async (t) => {
	for (const req of [directReq, relayReq()]) {
		const { helper } = setup(t, [json({}, { status: 503 })]);
		helper.regionsCache = REGIONS;
		helper.regionsCacheTime = 1; // long expired
		const res = fakeRes();

		await helper.fetchRegions(req, res);

		assert.equal(res.statusCode, 200);
		assert.deepEqual(res.body, REGIONS);
	}
});

test('relay mode: a malformed relayUrl is reported even with a stale regions cache', async (t) => {
	const { helper } = setup(t, []);
	helper.regionsCache = REGIONS;
	helper.regionsCacheTime = 1;
	const res = fakeRes();

	await helper.fetchRegions(relayReq('ftp://relay.example'), res);

	assert.equal(res.statusCode, 400);
});
