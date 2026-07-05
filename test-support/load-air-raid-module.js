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
