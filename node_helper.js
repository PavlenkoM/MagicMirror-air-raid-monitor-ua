/* Magic Mirror
 * Node Helper: MagicMirror-air-raid-monitor-ua
 *
 * By PavlenkoM
 */

const NodeHelper = require("node_helper");
const Log = require("logger");
const fs = require("fs");
const path = require("path");

const API_HEADERS = {
	'Accept': 'application/json',
};
const AIR_RAID_API_BASE = "https://api.ukrainealarm.com/api/v3";

// A relay is polled every few seconds, so a hung request must not outlive the
// next cycle and pile up behind it.
const RELAY_TIMEOUT = 8 * 1000;

// Response header telling the front end how fresh the alerts are: the relay's
// X-Relay-Synced-At (its last confirmed full sync), or the fetch time when the
// data comes straight from the API or the relay does not send that header.
const AS_OF_HEADER = 'X-Data-As-Of';

// The regions hierarchy survives restarts on disk: the API allows a burst of only
// ~2 requests, and refetching it on every start would waste one of them.
const REGIONS_CACHE_FILE = path.join(__dirname, ".regions-cache.json");
const REGIONS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // administrative changes are rare

// Two data sources, picked per request by the headers the front end sends:
// - direct: `Authorization: <apiKey>`, straight to the UkraineAlarm API;
// - relay: `X-Relay-Url` + `X-Relay-Token`, to the user's own server, which
//   serves `${relayUrl}/alerts` and `${relayUrl}/regions` in the API's format.
module.exports = NodeHelper.create({
	regionsCache: null,
	regionsCacheTime: 0,
	regionsCacheFile: REGIONS_CACHE_FILE,
	// relay endpoint URL -> { etag, data, syncedAt } of its last 200 (or 304) response
	relayResponses: null,

	start: function() {
		this.relayResponses = new Map();
		this.expressApp.get("/alerts", this.fetchAlerts.bind(this));
		this.expressApp.get("/regions", this.fetchRegions.bind(this));
	},

	fetchAlerts: async function(req, res) {
		try {
			const { data, syncedAt } = await this.fetchUpstream(req, '/alerts');
			res.set(AS_OF_HEADER, syncedAt || new Date().toISOString());
			res.send(data);
		} catch (e) {
			this.sendError(res, e);
		}
	},

	fetchRegions: async function(req, res) {
		if (!this.regionsCache) {
			this.readRegionsCacheFile();
		}

		const cacheIsFresh = this.regionsCache
			&& Date.now() - this.regionsCacheTime < REGIONS_CACHE_TTL;
		if (cacheIsFresh) {
			res.send(this.regionsCache);
			return;
		}

		try {
			const { data: regions } = await this.fetchUpstream(req, '/regions');
			this.regionsCache = regions;
			this.regionsCacheTime = Date.now();
			try {
				fs.writeFileSync(this.regionsCacheFile, JSON.stringify(regions));
			} catch (e) {
				Log.error(`Could not write regions cache: ${e.message}`);
			}
			res.send(regions);
		} catch (e) {
			// A stale hierarchy beats an error: the refetch usually fails because of
			// the API rate limiter, and administrative changes are rare anyway.
			// A misconfigured relayUrl is still reported, so it does not go unnoticed.
			if (this.regionsCache && !e.status) {
				Log.error(e);
				res.send(this.regionsCache);
				return;
			}
			this.sendError(res, e);
		}
	},

	sendError: function(res, e) {
		Log.error(e);
		res.status(e.status || 500).send({ error: e.message });
	},

	readRegionsCacheFile: function() {
		try {
			const { mtimeMs } = fs.statSync(this.regionsCacheFile);
			this.regionsCache = JSON.parse(fs.readFileSync(this.regionsCacheFile, 'utf8'));
			this.regionsCacheTime = mtimeMs;
		} catch (e) {
			// no usable cache file yet
		}
	},

	// Resolves to { data, syncedAt }; syncedAt is null unless a relay reported it.
	fetchUpstream: async function(req, endpoint) {
		const relayUrl = req.headers['x-relay-url'];
		if (relayUrl) {
			return this.fetchFromRelay(relayUrl, req.headers['x-relay-token'], endpoint);
		}
		const data = await this.fetchRemoteData(`${AIR_RAID_API_BASE}${endpoint}`, req.headers['authorization']);
		return { data, syncedAt: null };
	},

	// A valid ISO timestamp from the X-Relay-Synced-At header, or null.
	relaySyncedAt: function(response) {
		const value = response.headers.get('x-relay-synced-at');
		return value && !Number.isNaN(Date.parse(value)) ? value : null;
	},

	// `${relayUrl}${endpoint}`; throws a 400 error for anything but a plain
	// http(s) base URL, since the token has its own option and header.
	relayEndpoint: function(relayUrl, endpoint) {
		let parsed;
		try {
			parsed = new URL(relayUrl);
		} catch (e) {
			parsed = null;
		}
		if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
			const error = new Error(`Invalid relayUrl "${relayUrl}": expected an http(s) base URL without "?" or "#"`);
			error.status = 400;
			throw error;
		}
		return `${relayUrl.replace(/\/+$/, '')}${endpoint}`;
	},

	// Conditional GET: the relay answers an unchanged resource with an empty
	// 304, so frequent polling costs a few hundred bytes per cycle.
	fetchFromRelay: async function(relayUrl, token, endpoint) {
		const url = this.relayEndpoint(relayUrl, endpoint);
		if (!this.relayResponses) {
			this.relayResponses = new Map();
		}
		const cached = this.relayResponses.get(url);

		const headers = {
			...API_HEADERS,
			'X-Relay-Token': token || '',
		};
		if (cached) {
			headers['If-None-Match'] = cached.etag;
		}

		const response = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(RELAY_TIMEOUT),
		});

		if (response.status === 304 && cached) {
			// The body is unchanged, but the relay may have confirmed it since.
			cached.syncedAt = this.relaySyncedAt(response) || cached.syncedAt;
			return { data: cached.data, syncedAt: cached.syncedAt };
		}
		if (!response.ok) {
			const hint = response.status === 401 ? ' (check relayToken)' : '';
			throw new Error(`Relay request to ${url} failed.\nStatus Code: ${response.status}${hint}`);
		}

		const data = await response.json();
		const syncedAt = this.relaySyncedAt(response);
		const etag = response.headers.get('etag');
		if (etag) {
			this.relayResponses.set(url, { etag, data, syncedAt });
		} else {
			this.relayResponses.delete(url);
		}
		return { data, syncedAt };
	},

	fetchRemoteData: async function(url, apiKey) {
		const response = await fetch(url, {
			headers: {
				...API_HEADERS,
				'Authorization': apiKey,
			},
		});

		if (!response.ok) {
			throw new Error(`Request Failed.\nStatus Code: ${response.status}`);
		}

		return response.json();
	}
});
