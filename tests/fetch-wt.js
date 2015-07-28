#!/usr/bin/env node
'use strict';
require('../lib/core-upgrade.js');

/** Fetch the wikitext for a page, given title or revision id.
 *
 *  This is very useful for extracting test cases which can then be passed
 *  to tests/parse.js
 */

var fs = require('fs');
var yargs = require('yargs');
var TemplateRequest = require('../lib/mediawiki.ApiRequest.js').TemplateRequest;
var ParsoidConfig = require('../lib/mediawiki.ParsoidConfig').ParsoidConfig;
var MWParserEnvironment = require('../lib/mediawiki.parser.environment.js').MWParserEnvironment;
var Util = require('../lib/mediawiki.Util.js').Util;


var fetch = function(page, revid, options) {
	var prefix = options.prefix || null;

	if (options.apiURL) {
		prefix = 'customwiki';
	}

	var setup = function(parsoidConfig) {
		Util.setTemplatingAndProcessingFlags(parsoidConfig, options);
	};

	var parsoidConfig = new ParsoidConfig(
		{ setup: setup },
		{ defaultWiki: prefix }
	);

	var env;
	MWParserEnvironment.getParserEnv(parsoidConfig, null, {
		prefix: prefix,
		pageName: page,
	}).then(function(_env) {
		env = _env;
		var target = page ?
			env.resolveTitle(env.normalizeTitle(env.page.name), '') : null;
		return TemplateRequest.setPageSrcInfo(env, target, revid);
	}).then(function() {
		if (options.output) {
			fs.writeFileSync(options.output, env.page.src, 'utf8');
		} else {
			console.log(env.page.src);
		}
	}).done();
};

var usage = 'Usage: $0 [options] <page-title or rev-id>\n' +
	'If first argument is numeric, it is used as a rev id; otherwise it is\n' +
	'used as a title.  Use the --title option for a numeric title.';
var opts = yargs.usage(usage, {
	'output': {
		description: "Write page to given file",
	},
	'prefix': {
		description: 'Which wiki prefix to use; e.g. "enwiki" for English wikipedia, "eswiki" for Spanish, "mediawikiwiki" for mediawiki.org',
		'boolean': false,
		'default': 'enwiki',
	},
	'revid': {
		description: 'Page revision to fetch',
		'boolean': false,
	},
	'title': {
		description: 'Page title to fetch (only if revid is not present)',
		'boolean': false,
	},
	'help': {
		description: 'Show this message',
		'boolean': true,
		'default': false,
	},
});

var argv = opts.argv;
var title = null;
var revid = null;
var error;
if (argv.title && argv.revid) {
	error = "Can't specify title and revid at the same time.";
} else if (argv.title) {
	title = '' + argv.title; // convert, in case it's numeric.
} else if (argv.revid) {
	revid = +argv.revid;
} else if (typeof (argv._[0]) === 'number') {
	revid = argv._[0];
} else if (argv._[0]) {
	title = argv._[0];
} else {
	error = "Must specify a title or revision id.";
}

if (argv.help || error) {
	if (error) {
		// Make the error standout in the output
		var buf = ["-------"];
		for (var i = 0; i < error.length; i++) {
			buf.push("-");
		}
		buf = buf.join('');
		console.error(buf);
		console.error('ERROR:', error);
		console.error(buf);
	}
	opts.showHelp();
	return;
}

fetch(title, revid, argv);
