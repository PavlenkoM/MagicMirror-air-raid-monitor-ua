'use strict';

const Module = require('module');

// Requires the real node_helper.js with MagicMirror's `node_helper` and
// `logger` modules stubbed, and returns its definition object (what
// NodeHelper.create receives), so its methods can be called directly.
module.exports = function loadNodeHelper() {
	const originalLoad = Module._load;
	Module._load = function(request, ...rest) {
		if (request === 'node_helper') {
			return { create: definition => definition };
		}
		if (request === 'logger') {
			return { info() {}, warn() {}, error() {}, log() {} };
		}
		return originalLoad.call(this, request, ...rest);
	};

	try {
		const file = require.resolve('../node_helper.js');
		delete require.cache[file];
		return require(file);
	} finally {
		Module._load = originalLoad;
	}
};
