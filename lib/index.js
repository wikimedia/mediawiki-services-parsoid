'use strict';

require('../core-upgrade.js');

var path = require('path');
var json = require('../package.json');
var parseJs = require('./parse.js');
var ParsoidConfig = require('./config/ParsoidConfig.js').ParsoidConfig;
var ParsoidService = require('./api/ParsoidService.js');

var prepareLog = function(logData) {
	var log = Object.assign({ logType: logData.logType }, logData.locationData);
	var flat = logData.flatLogObject();
	Object.keys(flat).forEach(function(k) {
		// Be sure we don't have a `type` field here since logstash
		// treats that as magical.  We created a special `location`
		// field above and bunyan will add a `level` field (from the
		// contents of our `type` field) when we call the specific
		// logger returned by `_getBunyanLogger`.
		if (/^(type|location|level)$/.test(k)) { return; }
		log[k] = flat[k];
	});
	return log;
};

/**
 * Main entry point for Parsoid's JavaScript API.
 *
 * Note that Parsoid's main interface is actually a web API, as
 * defined by {@link ParsoidService} (and the files in the `api` directory).
 *
 * But some users would like to use Parsoid as a NPM package using
 * a native JavaScript API.
 *
 * @class
 * @singleton
 */
var Parsoid = module.exports = {
	/** Name of the NPM package. */
	name: json.name,
	/** Version of the NPM package. */
	version: json.version,
	/** Expose parse method. */
	parse: parseJs,
};

/**
 * Start an API service worker as part of a service-runner service.
 * @param {Object} options
 * @return {Promise} a Promise for an `http.Server`.
 */
Parsoid.apiServiceWorker = function apiServiceWorker(options) {
	// By default, set the loggerBackend and metrics to service-runner's.
	var parsoidOptions = Object.assign({
		loggerBackend: function(logData, cb) {
			options.logger.log(logData.logType, prepareLog(logData));
			cb();
		},
		metrics: options.metrics,
	}, options.config);  // but it can be overriden here.
	// For backwards compatibility, and to continue to support non-static
	// configs for the time being.
	if (parsoidOptions.localsettings) {
		parsoidOptions.localsettings = path.resolve(options.appBasePath, parsoidOptions.localsettings);
	}
	var parsoidConfig = new ParsoidConfig(null, parsoidOptions);
	return ParsoidService.init(parsoidConfig, options.logger);
};
