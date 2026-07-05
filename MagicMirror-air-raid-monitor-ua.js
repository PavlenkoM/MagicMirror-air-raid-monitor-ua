const AIR_RAID_MODULE_NAME = 'MagicMirror-air-raid-monitor-ua';

// Ukraine Alert API oblast regionId -> `name` attribute of the region shape in public/ua.svg.
// regionIds are the API's stable identifiers; names/types are not reliable keys.
const OBLAST_ID_TO_SVG_NAME = {
	'3': "Khmel'nyts'kyy",
	'4': 'Vinnytsya',
	'5': 'Rivne',
	'8': 'Volyn',
	'9': "Dnipropetrovs'k",
	'10': 'Zhytomyr',
	'11': 'Transcarpathia',
	'12': 'Zaporizhzhya',
	'13': "Ivano-Frankivs'k",
	'14': 'Kyiv',
	'15': 'Kirovohrad',
	'16': "Luhans'k",
	'17': 'Mykolayiv',
	'18': 'Odessa',
	'19': 'Poltava',
	'20': 'Sumy',
	'21': "Ternopil'",
	'22': 'Kharkiv',
	'23': 'Kherson',
	'24': 'Cherkasy',
	'25': 'Chernihiv',
	'26': 'Chernivtsi',
	'27': "L'viv",
	'28': "Donets'k",
	'31': 'Kyiv City',
	'9999': 'Crimea',
};

// City communities that the API lists at the top level of /regions (typed "State"
// although they are not oblasts) -> the oblast they belong to.
const TOP_LEVEL_COMMUNITY_TO_OBLAST = {
	'564': '12', // м. Запоріжжя та Запорізька ТГ -> Запорізька область
	'1293': '22', // м. Харків та Харківська ТГ -> Харківська область
};

// How often to re-request the regions hierarchy; administrative changes are rare.
const REGIONS_REFRESH_INTERVAL = 7 * 24 * 60 * 60 * 1000;

Module.register(AIR_RAID_MODULE_NAME, {
	requiresVersion: "2.19.0",
	styleSelectorPrefix: 'air-raid-status',
	status: {
		no_data: 'no_data',
		partial: 'partial',
		full: 'full'
	},

	defaults: {
		// The API rate-limits each key to roughly 1 request/minute (exceeding it
		// returns empty 401s), so polling faster than 60s locks the module out.
		updateInterval: 60 * 1.5, // seconds, also the minimum
		// An oblast is painted "full" once more than this fraction of its
		// districts/communities have an active alert of their own.
		fullAlertThreshold: 0.5,
	},

	isLoading: false,
	airRaidData: [],
	requestTimer: null,
	mapSVG: null,
	storedActionIndex: null,
	regionToOblast: null,
	totalPartsByOblast: null,
	regionsLoadedAt: 0,

	getStyles: function() {
		return [
			this.file(`${AIR_RAID_MODULE_NAME}.css`)
		];
	},

	start: function() {
		this.loadAirRaidData();
		this.initLoaderTimer();
	},

	stop: function() {
		this.clearTimer();
	},

	getDom: async function() {
		const wrapper = document.createElement("div");
		wrapper.className = `${AIR_RAID_MODULE_NAME}-wrapper`;

		let content = await this.mapTemplate();
		if (this.isLoading) {
			content += this.getPreloaderLoader();
		}
		wrapper.innerHTML = content;

		return wrapper;
	},

	getUpdateTimerInterval: function() {
		return Math.max(this.config.updateInterval, this.defaults.updateInterval) * 1000;
	},

	// All node_helper routes share the auth header and error contract.
	fetchLocal: async function(path) {
		const response = await fetch(path, {
			headers: {
				'Authorization': this.config.apiKey,
			}
		});

		if (!response.ok) {
			throw new Error(`Response status: ${response.status}`);
		}

		return response.json();
	},

	getMapSVG: async function() {
		if (this.mapSVG) {
			return this.mapSVG;
		}

		try {
			const responseData = await fetch(`/${AIR_RAID_MODULE_NAME}/ua.svg`);
			this.mapSVG = await responseData.text();
		} catch (e) {
			Log.error(e);
		}

		return this.mapSVG;
	},

	// Builds regionId -> oblast regionId from the /regions hierarchy. Cached by the
	// node_helper, so only the first request after a MagicMirror start goes upstream.
	loadRegions: async function() {
		if (this.regionToOblast && Date.now() - this.regionsLoadedAt < REGIONS_REFRESH_INTERVAL) {
			return;
		}

		try {
			const { states } = await this.fetchLocal('/regions');

			const regionToOblast = {};
			const totalPartsByOblast = {};
			const walk = (region, oblastId) => {
				regionToOblast[region.regionId] = oblastId;
				if (region.regionId !== oblastId) {
					totalPartsByOblast[oblastId] = (totalPartsByOblast[oblastId] || 0) + 1;
				}
				(region.regionChildIds || []).forEach(child => walk(child, oblastId));
			};
			states.forEach(state => walk(state, TOP_LEVEL_COMMUNITY_TO_OBLAST[state.regionId] || state.regionId));

			this.regionToOblast = regionToOblast;
			this.totalPartsByOblast = totalPartsByOblast;
			this.regionsLoadedAt = Date.now();
		} catch (e) {
			Log.error(e);
		}
	},

	loadAirRaidData: async function() {
		const hadRegions = Boolean(this.regionToOblast);
		await this.loadRegions();
		const regionsJustLoaded = !hadRegions && Boolean(this.regionToOblast);

		const shouldUpdateStatus = await this.shouldUpdateStatus();

		if (!shouldUpdateStatus) {
			// The map renders gray while the regions hierarchy is missing, so a late
			// /regions arrival must trigger a re-render even without new alert data.
			if (regionsJustLoaded) {
				this.updateDom();
			}
			return;
		}

		this.isLoading = true;
		this.updateDom();

		try {
			this.airRaidData = await this.fetchLocal('/alerts');

			const activeRegions = Array.isArray(this.airRaidData)
				? this.airRaidData.filter(region => region.activeAlerts?.length)
				: [];
			Log.info(`Air raid alerts: ${activeRegions.length} region(s) with active alerts`, this.airRaidData);
		} catch(e) {
			Log.error(e);
			// The action index is already committed, so without a reset the next cycle
			// would see "no change" and this failed /alerts fetch would never be retried.
			this.storedActionIndex = null;
		}

		this.isLoading = false;
		this.updateDom();
	},

	shouldUpdateStatus: async function() {
		try {
			const { lastActionIndex } = await this.fetchLocal('/status');
			const shouldUpdate = this.storedActionIndex !== lastActionIndex;

			this.storedActionIndex = lastActionIndex;

			return shouldUpdate;
		} catch(e) {
			Log.error(e);
			// Skip the /alerts call this cycle: a failed /status is usually the API
			// rate limiter, and another request would keep the key locked out.
			return false;
		}
	},

	initLoaderTimer: function() {
		this.clearTimer();

		this.requestTimer = setTimeout(() => {
			this.loadAirRaidData();
			this.initLoaderTimer();
		}, this.getUpdateTimerInterval());
	},

	clearTimer: function() {
		if (this.requestTimer) {
			clearTimeout(this.requestTimer);
			this.requestTimer = null;
		}
	},

	// Turns the API's alert entries into { svgRegionName: status }: an oblast's
	// own alert always marks it "full"; otherwise it's "full" once more than
	// config.fullAlertThreshold of its districts/communities have an alert of
	// their own, else "partial" for any lesser fraction.
	getRegionStatuses: function () {
		const result = {};
		if (!Array.isArray(this.airRaidData) || !this.regionToOblast) {
			return result;
		}

		const selfAlertedOblasts = new Set();
		const alertedPartsByOblast = {};

		this.airRaidData.forEach(entry => {
			if (!entry.activeAlerts?.length) {
				return;
			}

			const oblastId = this.regionToOblast[entry.regionId];
			if (!oblastId) {
				return;
			}

			if (entry.regionId === oblastId) {
				selfAlertedOblasts.add(oblastId);
			} else {
				alertedPartsByOblast[oblastId] = (alertedPartsByOblast[oblastId] || 0) + 1;
			}
		});

		const alertedOblastIds = new Set([...selfAlertedOblasts, ...Object.keys(alertedPartsByOblast)]);
		alertedOblastIds.forEach(oblastId => {
			const svgName = OBLAST_ID_TO_SVG_NAME[oblastId];
			if (!svgName) {
				return;
			}

			if (selfAlertedOblasts.has(oblastId)) {
				result[svgName] = this.status.full;
				return;
			}

			const totalParts = this.totalPartsByOblast?.[oblastId] || 0;
			const ratio = totalParts > 0 ? alertedPartsByOblast[oblastId] / totalParts : 0;
			result[svgName] = ratio > this.config.fullAlertThreshold ? this.status.full : this.status.partial;
		});

		return result;
	},

	mapTemplate: async function () {
		return `
			${this.getMapStyles()}
			${await this.getMapSVG()}
			${this.getMapLegend()}
		`;
	},

	getMapStyles: function () {
		const statuses = {
			[this.status.no_data]: {
				selectors: [`.${this.styleSelectorPrefix}-${this.status.no_data}`],
				styles: `{
					fill: rgba(255,255,255,0.25);
					background-color: rgba(255,255,255,0.25);
					border: 1px solid red;
					stroke: red;
				}`
			},
			[this.status.partial]: {
				selectors: [`.${this.styleSelectorPrefix}-${this.status.partial}`],
				styles: `{
					background-color: rgba(255,255,255,0.5);
					border: 1px solid #ffffff;
					fill: rgba(255,255,255,0.5);
					stroke: #000000;
				}`
			},
			[this.status.full]: {
				selectors: [`.${this.styleSelectorPrefix}-${this.status.full}`],
				styles: `{
					background-color: rgba(255,255,255,0.9);
					border: 1px solid #ffffff;
					fill: rgba(255,255,255,1);
					stroke: #000000;
				}`
			}
		};

		const regionStatuses = this.getRegionStatuses();
		Object.keys(regionStatuses).map(region => {
			const status = regionStatuses[region];
			if (!status || !statuses[status]) {
				return;
			}

			statuses[status].selectors.push(`[name="${region}"]`);
		});

		const stylesList = Object.keys(statuses).map(status => {
			const {selectors, styles} = statuses[status];
			if (!selectors?.length) {
				return '';
			}

			return `${selectors.join(',')} ${styles}`;
		});



		return `<style>${stylesList.join(' ')}</style>`;
	},

	getMapLegend: function () {
		const itemsList = Object.keys(this.status).map(key => {
			const status = this.status[key];
			return `
				<li class="graph-legend-item">
					<span class="${this.styleSelectorPrefix}-${status}"></span> ${this.translate(status)}
				</li>
			`;
		});
		return `<ul class="graph-legend">${itemsList.join('')}</ul>`;
	},

	getPreloaderLoader: function () {
		return `
			<div class="preloader">
				<div class="preloader__spinner"></div>
			</div>
		`;
	},

	getTranslations: function() {
		return {
			en: "translations/en.json",
			uk: "translations/uk.json"
		}
	}
});
