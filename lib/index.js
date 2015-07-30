'use strict';
require('../lib/core-upgrade.js');

var json = require('../package.json');
var parseJs = require('../tests/parse.js');
var ParsoidConfig = require('../lib/mediawiki.ParsoidConfig.js').ParsoidConfig;
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
	var argv = Object.create(parseJs.defaultOptions);
	Object.keys(options).forEach(function(k) { argv[k] = options[k]; });

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

	if (argv.apiURL) {
		prefix = 'customwiki';
	}

	var parsoidConfig = options.parsoidConfig ||
		new ParsoidConfig(options.config || null, { defaultWiki: prefix });
	if (argv.pdoc) {
		parsoidConfig.addHTMLTemplateParameters = true;
	}
	return parseJs.parse(input || '', argv, parsoidConfig, prefix).then(function(res) {
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
	options = Object.assign({}, options);
	options.pdoc = true;
	return Parsoid.parse(wikitext, options).then(function(pdoc2) {
		var node = pdoc.document.adoptNode(pdoc2.document.body);
		return new JsApi.PNodeList(pdoc, null, node);
	});
};

// Expose other helpful objects.
Object.keys(JsApi).forEach(function(k) {
	Parsoid[k] = JsApi[k];
});
