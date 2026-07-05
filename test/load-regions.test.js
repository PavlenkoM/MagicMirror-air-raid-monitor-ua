'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadAirRaidModule = require('../test-support/load-air-raid-module');

const moduleDefinition = loadAirRaidModule();

function makeInstance(overrides = {}) {
	return Object.assign(Object.create(moduleDefinition), {
		regionToOblast: null,
		totalPartsByOblast: null,
		childrenByRegionId: null,
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

	assert.deepEqual(instance.childrenByRegionId, {
		'12': ['201', '202'],
		'201': ['301', '302'],
		'202': ['303', '304'],
	});
});
