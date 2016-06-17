#!/usr/bin/env node
'use strict';
require('../core-upgrade.js');

/** Fetch the wikitext for a page, given title or revision id.
 *
 *  This is very useful for extracting test cases which can then be passed
 *  to tests/parse.js
 */

var fs = require('fs');
var path = require('path');
var yargs = require('yargs');

var TemplateRequest = require('../lib/mw/ApiRequest.js').TemplateRequest;
var ParsoidConfig = require('../lib/config/ParsoidConfig.js').ParsoidConfig;
var MWParserEnvironment = require('../lib/config/MWParserEnvironment.js').MWParserEnvironment;
var Util = require('../lib/utils/Util.js').Util;


var fetch = function(page, revid, opts) {
	var prefix = opts.prefix || null;
	var domain = opts.domain || null;

	if (opts.apiURL) {
		prefix = 'customwiki';
		domain = null;
	} else if (!(prefix || domain)) {
		domain = 'en.wikipedia.org';
	}

	var local = null;
	if (Util.booleanOption(opts.config)) {
		var p = (typeof (opts.config) === 'string') ?
			path.resolve('.', opts.config) :
			path.resolve(__dirname, '../localsettings.js');
		local = require(p);
	}

	var setup = function(parsoidConfig) {
		if (local && local.setup) {
			local.setup(parsoidConfig);
		}
		Util.setTemplatingAndProcessingFlags(parsoidConfig, opts);
		Util.setDebuggingFlags(parsoidConfig, opts);
	};

	var parsoidConfig = new ParsoidConfig(
		{ setup: setup }
	);
	parsoidConfig.defaultWiki = prefix ? prefix :
		parsoidConfig.reverseMwApiMap.get(domain);

	var env;
	var target;
	MWParserEnvironment.getParserEnv(parsoidConfig, {
		prefix: prefix,
		domain: domain,
		pageName: page,
	}).then(function(_env) {
		env = _env;
		target = page ?
			env.normalizeAndResolvePageTitle() : null;
		return TemplateRequest.setPageSrcInfo(env, target, revid);
	}).then(function() {
		if (opts.output) {
			fs.writeFileSync(opts.output, env.page.src, 'utf8');
		} else {
			console.log(env.page.src);
		}
	}, function(e) {
		console.error('Failed to fetch', target, revid);
		console.error(e);
	}).done();
};

var usage = 'Usage: $0 [options] <page-title or rev-id>\n' +
	'If first argument is numeric, it is used as a rev id; otherwise it is\n' +
	'used as a title.  Use the --title option for a numeric title.';
var opts = yargs.usage(usage, Util.addStandardOptions({
	'output': {
		description: "Write page to given file",
	},
	'config': {
		description: "Path to a localsettings.js file.  Use --config w/ no argument to default to the server's localsettings.js",
		'default': false,
	},
	'prefix': {
		description: 'Which wiki prefix to use; e.g. "enwiki" for English wikipedia, "eswiki" for Spanish, "mediawikiwiki" for mediawiki.org',
		'boolean': false,
		'default': null,
	},
	'domain': {
		description: 'Which wiki to use; e.g. "en.wikipedia.org" for English wikipedia, "es.wikipedia.org" for Spanish, "www.mediawiki.org" for mediawiki.org',
		'boolean': false,
		'default': null,
	},
	'revid': {
		description: 'Page revision to fetch',
		'boolean': false,
	},
	'title': {
		description: 'Page title to fetch (only if revid is not present)',
		'boolean': false,
	},
}));

(function() {
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
}());
