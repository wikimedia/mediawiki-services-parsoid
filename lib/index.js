'use strict';

require('../core-upgrade.js');

var path = require('path');
var json = require('../package.json');
var parseJs = require('./parse.js');
var ParsoidService = require('./api/ParsoidService.js');

/**
 * Main entry point for Parsoid's JavaScript API.
 *
 * Note that Parsoid's main interface is actually a web API, as
 * defined by {@link ParsoidService} (and the files in the `api` directory).
 *
 * But some users would like to use Parsoid as a NPM package using
 * a native JavaScript API.
 *
 * @namespace
 * @module
 */
var Parsoid = module.exports = {
	/** Name of the NPM package. */
	name: json.name,
	/** Version of the NPM package. */
	version: json.version,
	/**
	 * Expose parse method.
	 * @see module:parse
	 */
	parse: parseJs,
};

/**
 * Start an API service worker as part of a service-runner service.
 *
 * @param {Object} options
 * @return {Promise} A Promise for an `http.Server`.
 * @func module:index~apiServiceWorker
 */
Parsoid.apiServiceWorker = function apiServiceWorker(options) {
	var parsoidOptions = Object.assign({
		// Pull these out since the name "metrics" conflicts between
		// configuration and the instantiated object.
		parent: {
			logging: options.config.logging,
			metrics: options.config.metrics,
		},
	}, options.config, { logging: undefined, metrics: undefined });
	// For backwards compatibility, and to continue to support non-static
	// configs for the time being.
	if (parsoidOptions.localsettings) {
		parsoidOptions.localsettings = path.resolve(options.appBasePath, parsoidOptions.localsettings);
	}
	return ParsoidService.init(parsoidOptions, options.logger);
};
