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
const AIR_RAID_API = `${AIR_RAID_API_BASE}/alerts`;

// The regions hierarchy survives restarts on disk: the API allows a burst of only
// ~2 requests, and refetching it on every start would waste one of them.
const REGIONS_CACHE_FILE = path.join(__dirname, ".regions-cache.json");
const REGIONS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // administrative changes are rare

module.exports = NodeHelper.create({
	regionsCache: null,
	regionsCacheTime: 0,

	start: function() {
		this.expressApp.get("/alerts", this.proxyTo(AIR_RAID_API));
		this.expressApp.get("/status", this.proxyTo(`${AIR_RAID_API}/status`));
		this.expressApp.get("/regions", this.fetchRegions.bind(this));
	},

	proxyTo: function(url) {
		return async (req, res) => {
			try {
				res.send(await this.fetchRemoteData(url, req.headers['authorization']));
			} catch (e) {
				Log.error(e);
				res.status(500).send({ error: e.message });
			}
		};
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
			const regions = await this.fetchRemoteData(
				`${AIR_RAID_API_BASE}/regions`,
				req.headers['authorization']
			);
			this.regionsCache = regions;
			this.regionsCacheTime = Date.now();
			try {
				fs.writeFileSync(REGIONS_CACHE_FILE, JSON.stringify(regions));
			} catch (e) {
				Log.error(`Could not write regions cache: ${e.message}`);
			}
			res.send(regions);
		} catch (e) {
			Log.error(e);
			// A stale hierarchy beats an error: the refetch usually fails because of
			// the API rate limiter, and administrative changes are rare anyway.
			if (this.regionsCache) {
				res.send(this.regionsCache);
				return;
			}
			res.status(500).send({ error: e.message });
		}
	},

	readRegionsCacheFile: function() {
		try {
			const { mtimeMs } = fs.statSync(REGIONS_CACHE_FILE);
			this.regionsCache = JSON.parse(fs.readFileSync(REGIONS_CACHE_FILE, 'utf8'));
			this.regionsCacheTime = mtimeMs;
		} catch (e) {
			// no usable cache file yet
		}
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
