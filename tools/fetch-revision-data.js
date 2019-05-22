#!/usr/bin/env node

'use strict';

require('../core-upgrade.js');

/*
 * Given a title (and an optional revision id), fetch:
 * 1. the wikitext for a page from the MW API
 * 2. latest matching HTML and data-parsoid for the revision from RESTBase
 */

var fs = require('pn/fs');
var path = require('path');
var yargs = require('yargs');
var yaml = require('js-yaml');

var Promise = require('../lib/utils/promise.js');

var TemplateRequest = require('../lib/mw/ApiRequest.js').TemplateRequest;
var ParsoidConfig = require('../lib/config/ParsoidConfig.js').ParsoidConfig;
var MWParserEnvironment = require('../lib/config/MWParserEnvironment.js').MWParserEnvironment;
var Util = require('../lib/utils/Util.js').Util;
var ScriptUtils = require('./ScriptUtils.js').ScriptUtils;

var fetch = Promise.async(function *(page, revid, opts) {
	var prefix = opts.prefix || null;
	var domain = opts.domain || null;
	if (!prefix && !domain) {
		domain = "en.wikipedia.org";
	}

	var parsoidOptions = {};

	if (ScriptUtils.booleanOption(opts.config)) {
		var p = (typeof (opts.config) === 'string') ?
			path.resolve('.', opts.config) :
			path.resolve(__dirname, '../config.yaml');
		// Assuming Parsoid is the first service in the list
		parsoidOptions = yaml.load(yield fs.readFile(p, 'utf8')).services[0].conf;
	}

	ScriptUtils.setTemplatingAndProcessingFlags(parsoidOptions, opts);
	ScriptUtils.setDebuggingFlags(parsoidOptions, opts);

	if (parsoidOptions.localsettings) {
		parsoidOptions.localsettings = path.resolve(__dirname, parsoidOptions.localsettings);
	}

	var pc = new ParsoidConfig(null, parsoidOptions);
	if (!prefix) {
		// domain has been provided
		prefix = pc.getPrefixFor(domain);
	} else if (!domain) {
		// prefix has been set
		domain = pc.mwApiMap.get(prefix).domain;
	}
	pc.defaultWiki = prefix;

	var outputPrefix = prefix + "." + page;
	var rbOpts = {
		uri: null,
		method: 'GET',
		headers: {
			'User-Agent': pc.userAgent,
		},
	};

	var env = yield MWParserEnvironment.getParserEnv(pc, {
		prefix: prefix,
		domain: domain,
		pageName: page,
	});

	// Fetch wikitext from mediawiki API
	var target = page ?
		env.normalizeAndResolvePageTitle() : null;
	yield TemplateRequest.setPageSrcInfo(env, target, revid);
	yield fs.writeFile(outputPrefix + ".wt", env.page.src, 'utf8');

	// Fetch HTML from RESTBase
	rbOpts.uri = "https://" + domain + "/api/rest_v1/page/html/" + Util.phpURLEncode(page) + (revid ? "/" + revid : "");
	var resp = yield ScriptUtils.retryingHTTPRequest(2, rbOpts);
	yield fs.writeFile(outputPrefix + ".html", resp[1], 'utf8');
	var etag = resp[0].headers.etag.replace(/^W\//, '').replace(/"/g, '');

	// Fetch matching data-parsoid form RESTBase
	rbOpts.uri = "https://" + domain + "/api/rest_v1/page/data-parsoid/" + Util.phpURLEncode(page) + "/" + etag;
	resp = yield ScriptUtils.retryingHTTPRequest(2, rbOpts);

	// RESTBase doesn't have the outer wrapper
	// that the parse.js script expects
	var pb = '{"parsoid":' + resp[1] + "}";
	yield fs.writeFile(outputPrefix + ".pb.json", pb, 'utf8');

	console.log("If you are debugging a bug report on a VE edit, make desired edit to the HTML file and save to a new file.");
	console.log("Then run the following script to generated edited wikitext");
	console.log("parse.js --html2wt --selser --oldtextfile "
		+ outputPrefix + ".wt"
		+ " --oldhtmlfile " + outputPrefix + ".html"
		+ " --pbinfile " + outputPrefix + ".pb.json"
		+ " < edited.html > edited.wt");
});

var usage = 'Usage: $0 [options] --title <page-title> [--revid <rev-id>]\n';
var yopts = yargs
.usage(usage)
.options({
	'config': {
		description: "Path to a config.yaml file. Defaults to the server's config.yaml",
		'default': true,
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
		description: 'Page title to fetch',
		'boolean': false,
	},
});

Promise.async(function *() {
	var argv = yopts.argv;
	var title = argv.title;
	var error;
	if (!title) {
		error = "Must specify a title.";
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
		yopts.showHelp();
		return;
	}

	yield fetch(title, argv.revid, argv);
})().done();
