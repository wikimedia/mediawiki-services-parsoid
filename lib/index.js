'use strict';

require('../core-upgrade.js');

var path = require('path');
var json = require('../package.json');
var parseJs = require('../bin/parse.js');
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
 * a native JavaScript API.  This file provides that, more-or-less.
 * It should be considered unstable.  Patches welcome.
 *
 * @class
 * @singleton
 */
var Parsoid = module.exports = {
	/** Name of the NPM package. */
	name: json.name,
	/** Version of the NPM package. */
	version: json.version,
};

/**
 * Parse wikitext (or html) to html (or wikitext).
 *
 * Sample usage:
 *
 *     Parsoid.parse('hi there', { document: true }).then(function(res) {
 *        console.log(res.out.outerHTML);
 *     }).done();
 *
 * @param {String} input
 *    The input wikitext or HTML (depending on conversion direction).
 * @param {Object} options
 * @param {Boolean} [options.document=false]
 *    Return a DOM {@link Document} (instead of a string)
 * @param {Boolean} [options.wt2html=true]
 *    Convert wikitext to HTML.
 * @param {Boolean} [options.html2wt=false]
 *    Convert HTML to wikitext.
 * @param {ParsoidConfig} [options.parsoidConfig]
 *    A {@link ParsoidConfig} object to use during parsing.
 *    If not provided one will be constructed using `options.config`.
 * @param {Object} [options.config]
 *    A set of options which will be passed to the {@link ParsoidConfig}
 *    constructor.
 * @return {Promise}
 *   Fulfilled with the result of the parse.
 */
Parsoid.parse = function(input, options, optCb) {
	options = options || {};
	var argv = Object.assign({}, parseJs.defaultOptions, options);

	if (argv.selser) {
		argv.html2wt = true;
	}

	// Default conversion mode
	if (!argv.html2wt && !argv.wt2wt && !argv.html2html) {
		argv.wt2html = true;
	}

	var prefix = argv.prefix || null;
	var domain = argv.domain || null;

	if (argv.apiURL) {
		prefix = 'customwiki';
		domain = null;
	} else if (!(prefix || domain)) {
		domain = 'en.wikipedia.org';
	}

	var parsoidConfig = options.parsoidConfig;
	if (!parsoidConfig) {
		// Default setup: Point Parsoid at WMF wikis.
		parsoidConfig = new ParsoidConfig(options.config || null, { loadWMF: true });
		parsoidConfig.defaultWiki = prefix ? prefix :
			parsoidConfig.reverseMwApiMap.get(domain);
	}

	return parseJs.parse(input || '', argv, parsoidConfig, prefix, domain)
	.nodify(optCb);
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
