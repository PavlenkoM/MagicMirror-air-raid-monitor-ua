# Full Alert Threshold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paint an oblast `full` on the map when more than a configurable fraction of its districts/communities have an active alert, instead of `partial` for any single descendant alert.

**Architecture:** `MagicMirror-air-raid-monitor-ua.js` already builds `regionToOblast` (regionId → oblastId) once per week from the `/regions` hierarchy, and derives per-oblast alert status from the flat `/alerts` list in `getRegionStatuses()`. This plan extends the same `/regions` walk to also tally a sibling map, `totalPartsByOblast` (oblastId → count of descendant districts/communities), then reworks `getRegionStatuses()` to compare the ratio of alerted parts to that total against a new configurable threshold.

**Tech Stack:** Vanilla JS (MagicMirror module API, no build step, no existing dependencies). Tests use Node's built-in `node:test` + `node:assert/strict` (Node 18+, zero new dependencies) — this is a new pattern for this repo, since it has no existing test harness.

## Global Constraints

- "Part" = every District and Community node under an oblast, counted flatly in one denominator (not leaf-only, not district-only). Source: spec §Decisions.1.
- Threshold is read from `config.fullAlertThreshold` (module config), not a hardcoded constant. Default `0.5`. Source: spec §Decisions.2.
- Comparison is strict `ratio > threshold`. Exactly at the threshold stays `partial`. Source: spec §Decisions.3.
- An oblast's own self-alert (`entry.regionId === oblastId`) always wins → `full`, regardless of the ratio. Source: spec §Decisions.4.
- Childless oblasts (Kyiv City `31`, Crimea `9999`) are unaffected: no descendant parts to ratio against, so they can only be unstyled or `full` via self-alert, same as today. Source: spec §Decisions.5.
- No changes to `OBLAST_ID_TO_SVG_NAME`, `TOP_LEVEL_COMMUNITY_TO_OBLAST`, `getMapStyles()`, `getMapLegend()`, or `node_helper.js`. Source: spec §Out of scope.
- Verification is a `node:test` unit suite covering the counting/threshold logic, plus a manual check against the port-8081 test MagicMirror instance (no live-data-only reliance, since live alerts can't be made to reproduce a >50% scenario on demand). Source: this session's follow-up decision on top of the spec.

---

## File Structure

- **Modify `MagicMirror-air-raid-monitor-ua.js`**: add `fullAlertThreshold` to `defaults`; add `totalPartsByOblast` to instance state; extend `loadRegions()`'s tree walk to tally it; rework `getRegionStatuses()` to use the ratio.
- **Create `test-support/load-air-raid-module.js`**: shared loader that stubs the global `Module.register`/`Log` MagicMirror provides at runtime, `require`s the real module file, and returns its captured definition object. Lives outside `test/` deliberately — verified empirically that `node --test`'s default file discovery recursively sweeps up *any* file under a directory literally named `test`/`tests` (even plain, non-test helper files, which then show up as harmless but confusing zero-assertion "passing" entries); a sibling `test-support/` directory is not swept.
- **Create `test/load-regions.test.js`**: unit tests for the `/regions`-tree tally (`regionToOblast` + `totalPartsByOblast`), with a synthetic `fetchLocal` stub — no network, no real MagicMirror runtime.
- **Create `test/get-region-statuses.test.js`**: unit tests for the ratio-based full/partial/self-alert logic in `getRegionStatuses()`.

Both test files `require('../test-support/load-air-raid-module')` rather than duplicating the loader (this repo has no test harness yet, so this is a new pattern). Run the whole suite with plain `node --test` (no path argument) from the repo root — `node --test test/` was tried and errors out (`Cannot find module '.../test'`) because Node treats a positional directory argument as a module path to resolve, not a discovery root; only the no-argument form uses default recursive discovery.

---

### Task 1: `loadRegions` tallies `totalPartsByOblast`

**Files:**
- Create: `test-support/load-air-raid-module.js`
- Create: `test/load-regions.test.js`
- Modify: `MagicMirror-air-raid-monitor-ua.js:64` (instance state block), `MagicMirror-air-raid-monitor-ua.js:131-151` (`loadRegions`)

**Interfaces:**
- Produces: `this.totalPartsByOblast` (`Object<string, number>`) — oblastId → count of descendant District/Community nodes (and the two mistyped top-level communities, `564`/`1293`), rebuilt alongside `this.regionToOblast` on the same weekly cache cycle. Also produces the shared `test-support/load-air-raid-module.js` helper (`module.exports = function loadAirRaidModule()`), reused by Task 2.
- Consumes: existing `this.fetchLocal('/regions')` (unchanged contract: `{ states: [...] }`).

- [ ] **Step 1: Write the shared test-loader helper**

Create `test-support/load-air-raid-module.js`:

```js
'use strict';

// Stubs the global `Module.register` / `Log` that MagicMirror provides at
// runtime, requires the real module source, and returns its captured
// definition object so plain node:test files can call its methods directly
// without a full MagicMirror runtime.
module.exports = function loadAirRaidModule() {
	let definition = null;
	global.Module = { register(name, def) { definition = def; } };
	global.Log = { info() {}, error() {}, log() {} };

	delete require.cache[require.resolve('../MagicMirror-air-raid-monitor-ua.js')];
	require('../MagicMirror-air-raid-monitor-ua.js');

	delete global.Module;
	delete global.Log;

	return definition;
};
```

- [ ] **Step 2: Write the failing test**

Create `test/load-regions.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadAirRaidModule = require('../test-support/load-air-raid-module');

const moduleDefinition = loadAirRaidModule();

function makeInstance(overrides = {}) {
	return Object.assign(Object.create(moduleDefinition), {
		regionToOblast: null,
		totalPartsByOblast: null,
		regionsLoadedAt: 0,
	}, overrides);
}

// Zaporizhzhya oblast (12) with 2 districts x 2 communities each, plus the
// mistyped top-level "м. Запоріжжя та Запорізька ТГ" community (564) that the
// API lists as a sibling State instead of nesting it under 12. Crimea (9999)
// has no subdivisions at all.
const fakeRegionsResponse = {
	states: [
		{
			regionId: '12',
			regionType: 'State',
			regionChildIds: [
				{
					regionId: '201',
					regionType: 'District',
					regionChildIds: [
						{ regionId: '301', regionType: 'Community' },
						{ regionId: '302', regionType: 'Community' },
					],
				},
				{
					regionId: '202',
					regionType: 'District',
					regionChildIds: [
						{ regionId: '303', regionType: 'Community' },
						{ regionId: '304', regionType: 'Community' },
					],
				},
			],
		},
		{ regionId: '564', regionType: 'State', regionChildIds: [] },
		{ regionId: '9999', regionType: 'State', regionChildIds: [] },
	],
};

test('loadRegions tallies regionToOblast and totalPartsByOblast from the /regions tree', async () => {
	const instance = makeInstance({
		fetchLocal: async () => fakeRegionsResponse,
	});

	await instance.loadRegions();

	assert.deepEqual(instance.regionToOblast, {
		'12': '12',
		'201': '12',
		'202': '12',
		'301': '12',
		'302': '12',
		'303': '12',
		'304': '12',
		'564': '12',
		'9999': '9999',
	});

	assert.deepEqual(instance.totalPartsByOblast, {
		'12': 7, // 2 districts + 4 communities + the 564 top-level community
	});
	assert.equal(instance.totalPartsByOblast['9999'], undefined);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/load-regions.test.js`
Expected: FAIL — `AssertionError` comparing `instance.totalPartsByOblast` (`null`, since `loadRegions` doesn't set that property yet) against the expected object.

- [ ] **Step 4: Implement**

In `MagicMirror-air-raid-monitor-ua.js`, add `totalPartsByOblast: null,` to the instance state block (right after `regionToOblast: null,`):

```js
	regionToOblast: null,
	totalPartsByOblast: null,
	regionsLoadedAt: 0,
```

Replace the body of `loadRegions`:

```js
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/load-regions.test.js`
Expected: PASS — 1 test, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add MagicMirror-air-raid-monitor-ua.js test-support/load-air-raid-module.js test/load-regions.test.js
git commit -m "$(cat <<'EOF'
Tally per-oblast part counts while building the regions map

loadRegions() now also records totalPartsByOblast (districts +
communities per oblast) from the same /regions walk that builds
regionToOblast, so getRegionStatuses() can compute what fraction of
an oblast is currently under alert.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `getRegionStatuses` uses a configurable ratio threshold

**Files:**
- Create: `test/get-region-statuses.test.js`
- Modify: `MagicMirror-air-raid-monitor-ua.js:53-57` (`defaults`), `MagicMirror-air-raid-monitor-ua.js:222-249` (`getRegionStatuses`)

**Interfaces:**
- Consumes: `this.regionToOblast`, `this.totalPartsByOblast` (from Task 1), `this.airRaidData`, `this.config.fullAlertThreshold`, and the shared `test-support/load-air-raid-module.js` helper (from Task 1).
- Produces: unchanged public shape — `{ svgRegionName: 'full' | 'partial' }` — consumed as before by `getMapStyles()`.

- [ ] **Step 1: Write the failing test**

Create `test/get-region-statuses.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadAirRaidModule = require('../test-support/load-air-raid-module');

const moduleDefinition = loadAirRaidModule();

function makeInstance(overrides = {}) {
	return Object.assign(Object.create(moduleDefinition), {
		config: { fullAlertThreshold: 0.5 },
		regionToOblast: {},
		totalPartsByOblast: {},
		airRaidData: [],
	}, overrides);
}

test('defaults.fullAlertThreshold is 0.5', () => {
	assert.equal(moduleDefinition.defaults.fullAlertThreshold, 0.5);
});

test('oblast self-alert is always full, regardless of children', () => {
	const instance = makeInstance({
		regionToOblast: { '15': '15', '81': '15' },
		totalPartsByOblast: { '15': 1 },
		airRaidData: [
			{ regionId: '15', activeAlerts: [{ type: 'AIR' }] },
		],
	});

	assert.deepEqual(instance.getRegionStatuses(), { Kirovohrad: 'full' });
});

test('a minority of alerted parts stays partial', () => {
	const instance = makeInstance({
		regionToOblast: { '15': '15', '81': '15', '82': '15', '83': '15', '84': '15' },
		totalPartsByOblast: { '15': 4 },
		airRaidData: [
			{ regionId: '81', activeAlerts: [{ type: 'AIR' }] }, // 1 of 4 = 25%
		],
	});

	assert.deepEqual(instance.getRegionStatuses(), { Kirovohrad: 'partial' });
});

test('exactly the threshold stays partial (strict greater-than)', () => {
	const instance = makeInstance({
		regionToOblast: { '15': '15', '81': '15', '82': '15' },
		totalPartsByOblast: { '15': 2 },
		airRaidData: [
			{ regionId: '81', activeAlerts: [{ type: 'AIR' }] }, // 1 of 2 = exactly 50%
		],
	});

	assert.deepEqual(instance.getRegionStatuses(), { Kirovohrad: 'partial' });
});

test('more than the threshold becomes full', () => {
	const instance = makeInstance({
		regionToOblast: { '15': '15', '81': '15', '82': '15', '83': '15' },
		totalPartsByOblast: { '15': 3 },
		airRaidData: [
			{ regionId: '81', activeAlerts: [{ type: 'AIR' }] },
			{ regionId: '82', activeAlerts: [{ type: 'AIR' }] }, // 2 of 3 ≈ 67%
		],
	});

	assert.deepEqual(instance.getRegionStatuses(), { Kirovohrad: 'full' });
});

test('threshold is read from config, not hardcoded', () => {
	const instance = makeInstance({
		config: { fullAlertThreshold: 0.2 },
		regionToOblast: { '15': '15', '81': '15', '82': '15', '83': '15', '84': '15' },
		totalPartsByOblast: { '15': 4 },
		airRaidData: [
			{ regionId: '81', activeAlerts: [{ type: 'AIR' }] }, // 1 of 4 = 25% > 20%
		],
	});

	assert.deepEqual(instance.getRegionStatuses(), { Kirovohrad: 'full' });
});

test('childless oblast still becomes full via self-alert, not a division-by-zero crash', () => {
	const instance = makeInstance({
		regionToOblast: { '31': '31' }, // Kyiv City has no districts/communities
		totalPartsByOblast: {},
		airRaidData: [
			{ regionId: '31', activeAlerts: [{ type: 'AIR' }] },
		],
	});

	assert.deepEqual(instance.getRegionStatuses(), { 'Kyiv City': 'full' });
});

test('no active alerts anywhere yields an empty result', () => {
	const instance = makeInstance({
		regionToOblast: { '15': '15' },
		totalPartsByOblast: {},
		airRaidData: [
			{ regionId: '15', activeAlerts: [] },
		],
	});

	assert.deepEqual(instance.getRegionStatuses(), {});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/get-region-statuses.test.js`
Expected: FAIL — at minimum the `defaults.fullAlertThreshold is 0.5` test (property doesn't exist → `undefined !== 0.5`), and the ratio tests (current code marks any descendant alert `partial` unconditionally, so the ">50%" and "threshold from config" cases return `partial` instead of the expected `full`).

- [ ] **Step 3: Implement**

In `MagicMirror-air-raid-monitor-ua.js`, update `defaults`:

```js
	defaults: {
		// The API rate-limits each key to roughly 1 request/minute (exceeding it
		// returns empty 401s), so polling faster than 60s locks the module out.
		updateInterval: 60 * 1.5, // seconds, also the minimum
		// An oblast is painted "full" once more than this fraction of its
		// districts/communities have an active alert of their own.
		fullAlertThreshold: 0.5,
	},
```

Replace `getRegionStatuses`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/get-region-statuses.test.js`
Expected: PASS — 8 tests, 0 failures.

Then run the full suite (plain `node --test`, no path argument, from the repo root — a directory path argument like `test/` errors with `Cannot find module`) to confirm no regression in Task 1's test:

Run: `node --test`
Expected: PASS — 9 tests total, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add MagicMirror-air-raid-monitor-ua.js test/get-region-statuses.test.js
git commit -m "$(cat <<'EOF'
Paint an oblast full once most of its parts are alerted

getRegionStatuses() now compares the ratio of alerted districts and
communities against a new configurable config.fullAlertThreshold
(default 0.5) instead of marking an oblast partial the moment any
single descendant has an alert. An oblast's own self-alert still
always wins.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Manual verification against the live test instance

**Files:** none (verification only).

**Interfaces:** none — this task drives the already-implemented behavior through the browser to catch anything the unit tests can't (real SVG styling, real `Module.register`/`updateDom` lifecycle).

- [ ] **Step 1: Start the isolated test MagicMirror instance**

Follow the `magicmirror-test-instance-recipe` project memory:

```bash
# from /Users/mike/Projects/MagicMirror
# 1. create config/config.airraid-test.js containing only this module's entry
#    (copy the module block, including apiKey, from config/config.js; set port: 8081)
MM_CONFIG_FILE=/Users/mike/Projects/MagicMirror/config/config.airraid-test.js npm run server
```

- [ ] **Step 2: Open the test instance and confirm the module loads**

Navigate to `http://localhost:8081` (via claude-in-chrome or a regular browser tab) and confirm the map renders with no console errors (`read_console_messages` if using claude-in-chrome).

- [ ] **Step 3: Inject a >50%-parts-alerted scenario via the browser console and confirm `full`**

In the page's DevTools console:

```js
const air = MM.getModules().find(m => m.name === 'MagicMirror-air-raid-monitor-ua');
air.regionToOblast = { '15': '15', '81': '15', '82': '15', '83': '15' };
air.totalPartsByOblast = { '15': 3 };
air.airRaidData = [
	{ regionId: '81', activeAlerts: [{ type: 'AIR' }] },
	{ regionId: '82', activeAlerts: [{ type: 'AIR' }] },
];
air.updateDom();
```

Expected: the Kirovohrad shape (`[name="Kirovohrad"]`) renders with the `full` style (solid white fill per `getMapStyles()`), even though no entry for `15` itself (the oblast's own regionId) is present in `airRaidData`.

- [ ] **Step 4: Adjust to a <50%-parts-alerted scenario and confirm `partial`**

```js
air.airRaidData = [
	{ regionId: '81', activeAlerts: [{ type: 'AIR' }] },
];
air.updateDom();
```

Expected: the Kirovohrad shape now renders with the `partial` style (50% white fill), not `full`.

- [ ] **Step 5: Clean up**

```bash
# Ctrl-C the npm run server process, then:
rm /Users/mike/Projects/MagicMirror/config/config.airraid-test.js
lsof -nP -t -iTCP:8081 -sTCP:LISTEN | xargs -r kill
```

Confirm the user's real MagicMirror instance (port 8080) was never touched.

- [ ] **Step 6: Report results**

No commit for this task (verification only) — report back what was observed in Steps 3–4 so the plan can be marked complete.

---

## Self-Review Notes

- **Spec coverage:** all 5 spec §Decisions items map to Task 1 (parts counting) or Task 2 (threshold config, strict `>`, self-alert priority, childless-oblast safety); the spec's Testing section maps to Task 3, extended with the unit tests per this session's follow-up decision.
- **Type consistency:** `regionToOblast`/`totalPartsByOblast` keys are oblastId strings throughout (Task 1 produces them from `region.regionId` JSON strings; Task 2 consumes them via the same string keys) — verified no numeric/string key mismatches.
- **No placeholders:** all steps contain full runnable code and exact commands.
