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
		childrenByRegionId: null,
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

test('a district alert cascades to cover all of its own communities', () => {
	const instance = makeInstance({
		regionToOblast: { '15': '15', '81': '15', '760': '15', '761': '15' },
		totalPartsByOblast: { '15': 3 }, // 1 district + 2 communities
		childrenByRegionId: { '81': ['760', '761'] },
		airRaidData: [
			{ regionId: '81', activeAlerts: [{ type: 'AIR' }] }, // district-level alert only, no per-community entries
		],
	});

	// covered = {81, 760, 761} = all 3 parts -> 100% > 50% -> full
	assert.deepEqual(instance.getRegionStatuses(), { Kirovohrad: 'full' });
});

test('a community alert with no district-level alert only counts itself, not cascaded', () => {
	const instance = makeInstance({
		regionToOblast: { '15': '15', '81': '15', '760': '15', '761': '15' },
		totalPartsByOblast: { '15': 3 },
		childrenByRegionId: { '81': ['760', '761'] },
		airRaidData: [
			{ regionId: '760', activeAlerts: [{ type: 'AIR' }] }, // only one community alerted, district itself not alerted
		],
	});

	// covered = {760} = 1 of 3 parts ≈ 33% -> partial
	assert.deepEqual(instance.getRegionStatuses(), { Kirovohrad: 'partial' });
});

test('cascade does not double-count when a community under an already-covered district also has its own alert entry', () => {
	const instance = makeInstance({
		regionToOblast: { '15': '15', '81': '15', '760': '15', '761': '15', '82': '15', '770': '15', '771': '15' },
		totalPartsByOblast: { '15': 6 }, // 2 districts + 4 communities
		childrenByRegionId: { '81': ['760', '761'], '82': ['770', '771'] },
		airRaidData: [
			{ regionId: '81', activeAlerts: [{ type: 'AIR' }] }, // covers 81, 760, 761 (district + its 2 communities)
			{ regionId: '760', activeAlerts: [{ type: 'AIR' }] }, // redundant - already covered by 81's cascade
		],
	});

	// covered = {81, 760, 761} = 3 of 6 parts = exactly 50% -> NOT > 0.5 (strict) -> stays partial.
	// A buggy implementation that double-counts the redundant 760 entry (e.g. summing
	// alert-entry counts instead of a Set) would land on 4/6 ≈ 67% -> full instead.
	assert.deepEqual(instance.getRegionStatuses(), { Kirovohrad: 'partial' });
});
