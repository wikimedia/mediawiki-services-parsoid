#!/usr/bin/env node
'use strict';
require('../core-upgrade.js');

/*
 * Given a title (and an optional revision id), fetch:
 * 1. the wikitext for a page from the MW API
 * 2. latest matching HTML and data-parsoid for the revision from RESTBase
 */

var fs = require('fs');
var path = require('path');
var yargs = require('yargs');
var yaml = require('js-yaml');

var TemplateRequest = require('../lib/mw/ApiRequest.js').TemplateRequest;
var ParsoidConfig = require('../lib/config/ParsoidConfig.js').ParsoidConfig;
var MWParserEnvironment = require('../lib/config/MWParserEnvironment.js').MWParserEnvironment;
var Util = require('../lib/utils/Util.js').Util;


var fetch = function(page, revid, opts) {
	var prefix = opts.prefix || null;
	var domain = opts.domain || null;
	if (!prefix && !domain) {
		domain = "en.wikipedia.org";
	}

	var config = null;
	if (Util.booleanOption(opts.config)) {
		var p = (typeof (opts.config) === 'string') ?
			path.resolve('.', opts.config) :
			path.resolve(__dirname, '../config.yaml');
		// Assuming Parsoid is the first service in the list
		config = yaml.load(fs.readFileSync(p, 'utf8')).services[0].conf;
	}

	var setup = function(parsoidConfig) {
		if (config && config.localsettings) {
			var local = require(path.resolve(__dirname, config.localsettings));
			local.setup(parsoidConfig);
		}
		Util.setTemplatingAndProcessingFlags(parsoidConfig, opts);
		Util.setDebuggingFlags(parsoidConfig, opts);
	};

	var parsoidConfig = new ParsoidConfig({ setup: setup }, config);
	if (!prefix) {
		// domain has been provided
		prefix = parsoidConfig.reverseMwApiMap.get(domain);
	} else if (!domain) {
		// prefix has been set
		domain = parsoidConfig.mwApiMap.get(prefix).domain;
	}

	parsoidConfig.defaultWiki = prefix;

	var env;
	var outputPrefix = prefix + "." + page;
	var rbOpts = {
		uri: null,
		method: 'GET',
		headers: {
			'User-Agent': parsoidConfig.userAgent,
		},
	};
	MWParserEnvironment.getParserEnv(parsoidConfig, {
		prefix: prefix,
		domain: domain,
		pageName: page,
	}).then(function(_env) {
		// Fetch wikitext from mediawiki API
		env = _env;
		var target = page ?
			env.normalizeAndResolvePageTitle() : null;
		return TemplateRequest.setPageSrcInfo(env, target, revid);
	}).then(function() {
		fs.writeFileSync(outputPrefix + ".wt", env.page.src, 'utf8');
	}).then(function() {
		// Fetch HTML from RESTBase
		rbOpts.uri = "https://" + domain + "/api/rest_v1/page/html/" + Util.urlencode(page) + (revid ? "/" + revid : "");
		return Util.retryingHTTPRequest(2, rbOpts);
	}).then(function(resp) {
		fs.writeFileSync(outputPrefix + ".html", resp[1], 'utf8');
		return resp[0].headers.etag.replace(/"/g, '');
	}).then(function(etag) {
		// Fetch matching data-parsoid form RESTBase
		rbOpts.uri = "https://" + domain + "/api/rest_v1/page/data-parsoid/" + Util.urlencode(page) + "/" + etag;
		return Util.retryingHTTPRequest(2, rbOpts);
	}).then(function(resp) {
		// RESTBase doesn't have the outer wrapper
		// that the parse.js script expects
		var pb = '{"parsoid":' + resp[1] + "}";
		fs.writeFileSync(outputPrefix + ".pb.json", pb, 'utf8');
	}).done(function() {
		console.log("If you are debugging a bug report on a VE edit, make desired edit to the HTML file and save to a new file.");
		console.log("Then run the following script to generated edited wikitext");
		console.log("parse.js --html2wt --selser --oldtextfile " + outputPrefix + ".wt"
			+ " --oldhtmlfile " + outputPrefix + ".html"
			+ " --pbinfile " + outputPrefix + ".pb.json"
			+ " < edited.html > edited.wt");
	});
};

var usage = 'Usage: $0 [options] <page-title> <optional-rev-id>\n';
var opts = yargs.usage(usage, {
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

(function() {
	var argv = opts.argv;
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
		opts.showHelp();
		return;
	}

	fetch(title, argv.revid, argv);
}());
