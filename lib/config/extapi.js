/*
 * This file exports the stuff required by external extensions.
 */
'use strict';
// Note that extension code gets core-upgrade when they load the extension API.
require('../../core-upgrade.js');

var semver = require('semver');
var parsoidJson = require('../../package.json');

module.exports = {
	versionCheck: function(requestedVersion) {
		// Throw exception if the supplied major/minor version is
		// incompatible with the currently running Parsoid.
		if (!semver.satisfies(parsoidJson.version, requestedVersion)) {
			throw new Error(
				"Parsoid version " + parsoidJson.version + " is inconsistent " +
				"with required version " + requestedVersion
			);
		}

		// Return the exports to support chaining.  We could also elect
		// to return a slightly different version of the exports here if
		// we wanted to support multiple API versions.
		return {
			Promise: require('../utils/promise.js'),
			// XXX we may wish to export a subset of Util/DOMUtils/defines
			// and explicitly mark the exported functions as "stable", ie
			// we need to bump Parsoid's major version if the exported
			// functions are changed.
			Util: require('../utils/Util.js').Util,
			DOMUtils: require('../utils/DOMUtils.js').DOMUtils,
			defines: require('../wt2html/parser.defines.js'),
		};
	},
};
