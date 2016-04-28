'use strict';
require('../core-upgrade.js');

var json = require('../package.json');
var parseJs = require('../bin/parse.js');
var ParsoidConfig = require('./config/ParsoidConfig.js').ParsoidConfig;
var ParsoidService = require('./api/ParsoidService.js');
var JsApi = require('./jsapi.js');

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
 * See `USAGE.md` and `./jsapi.js` for a useful wrapper API which works
 * well with this interface.
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
 * Advanced usage using the {@link PDoc} API:
 *
 *     Parsoid.parse('{{echo|hi}}', { pdoc: true }).then(function(pdoc) {
 *        var templates = pdoc.filterTemplates();
 *        console.log(templates[0].name);
 *     }).done();
 *
 * @param {String} input
 *    The input wikitext or HTML (depending on conversion direction).
 * @param {Object} options
 * @param {Boolean} [options.document=false]
 *    Return a DOM {@link Document} (instead of a string)
 * @param {Boolean} [options.pdoc=false]
 *    Return a {@link PDoc} object (instead of a string)
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

	if (argv.pdoc) {
		argv.document = true;
	}

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
	if (argv.pdoc) {
		parsoidConfig.addHTMLTemplateParameters = true;
		// Since the jsapi acts directly on our serialized XML, it's heavily
		// tied to the content version.  Let's be explicit about which one
		// is acceptable, so that we fail loudly if/when it's no longer
		// supported.
		argv.contentversion = '1.2.1';

	}
	return parseJs.parse(input || '', argv, parsoidConfig, prefix, domain).then(function(res) {
		return argv.pdoc ? new JsApi.PDoc(res.env, res.out) : res;
	}).nodify(optCb);
};

// Add a helper method to PNodeList, based on Parsoid.parse.

/** @class PNodeList */
/**
 * Create a {@link PNodeList} belonging to the given {@link PDoc}
 * from a string containing wikitext.
 * @param {PDoc} pdoc
 *   The {@link PDoc} which will own the result.
 * @param {String} wikitext
 *   The wikitext to convert.
 * @param {Object} options
 *   Options which are passed to {@link Parsoid#parse}.
 * @return {Promise}
 *    Fulfilled by a {@link PNodeList} representing the given wikitext.
 * @static
 */
JsApi.PNodeList.fromWikitext = function(pdoc, wikitext, options) {
	options = Object.assign({}, options, { pdoc: true });
	return Parsoid.parse(wikitext, options).then(function(pdoc2) {
		var node = pdoc.document.adoptNode(pdoc2.document.body);
		return new JsApi.PNodeList(pdoc, null, node);
	});
};

// Expose other helpful objects.
Object.keys(JsApi).forEach(function(k) {
	Parsoid[k] = JsApi[k];
});

/**
 * Start an API service worker as part of a service-runner service.
 * @param {Object} options
 * @return {Promise} a Promise for an `http.Server`.
 */
Parsoid.apiServiceWorker = function apiServiceWorker(options) {
	var parsoidConfig = new ParsoidConfig(null, options.config);
	return ParsoidService.init(parsoidConfig, options.logger);
};
