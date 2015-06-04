/**
 * Main entry point for Parsoid's JavaScript API.
 *
 * Note that Parsoid's main interface is actually a web API, as
 * defined by the files in ../api.
 *
 * But some users would like to use Parsoid as a NPM package using
 * a native JavaScript API.  This file provides that, more-or-less.
 * It should be considered unstable.  Patches welcome.
 */

'use strict';
require('../lib/core-upgrade.js');

var json = require('../package.json');
var parseJs = require('../tests/parse.js');
var ParsoidConfig = require('../lib/mediawiki.ParsoidConfig.js').ParsoidConfig;

var Parsoid = module.exports = {
	name: json.name, // package name
	version: json.version, // npm version #
};

// Sample usage:
//  Parsoid.parse('hi there', { document: true }).then(function(res) {
//    console.log(res.out.outerHTML);
//  }).done();
Parsoid.parse = function(input, options, optCb) {
	options = options || {};
	var argv = Object.create(parseJs.defaultOptions);
	Object.keys(options).forEach(function(k) { argv[k] = options[k]; });

	if ( argv.selser ) {
		argv.html2wt = true;
	}

	// Default conversion mode
	if ( !argv.html2wt && !argv.wt2wt && !argv.html2html ) {
		argv.wt2html = true;
	}

	var prefix = argv.prefix || null;

	if ( argv.apiURL ) {
		prefix = 'customwiki';
	}

	var parsoidConfig = options.parsoidConfig ||
			new ParsoidConfig(options.config || null, { defaultWiki: prefix });
	return parseJs.parse(input || '', argv, parsoidConfig, prefix).nodify(optCb);
};
