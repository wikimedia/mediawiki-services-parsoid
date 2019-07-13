#!/usr/bin/env node

'use strict';

require('../core-upgrade.js');

/**
 * Fetch the siteconfig for a set of wikis.
 * See: lib/config/baseconfig/README
 */

var fs = require('pn/fs');
var path = require('path');
var yargs = require('yargs');
var yaml = require('js-yaml');

var ConfigRequest = require('../lib/mw/ApiRequest.js').ConfigRequest;
var MWParserEnvironment = require('../lib/config/MWParserEnvironment.js').MWParserEnvironment;
var ParsoidConfig = require('../lib/config/ParsoidConfig.js').ParsoidConfig;
var Promise = require('../lib/utils/promise.js');
var ScriptUtils = require('./ScriptUtils.js').ScriptUtils;

var update = Promise.async(function *(opts) {
	var prefix = opts.prefix || null;
	var domain = opts.domain || null;

	if (opts.apiURL) {
		prefix = 'customwiki';
		domain = null;
	} else if (!(prefix || domain)) {
		domain = 'en.wikipedia.org';
	}

	var parsoidOptions = {
		loadWMF: true,
		fetchConfig: true,
	};

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
	pc.defaultWiki = prefix || pc.getPrefixFor(domain);

	var env = yield MWParserEnvironment.getParserEnv(pc, {
		prefix: prefix,
		domain: domain,
	});
	var resultConf = yield ConfigRequest.promise(env, opts.formatversion);
	var configDir = path.resolve(__dirname, '..');
	var iwp = env.conf.wiki.iwp;
	// HACK for be-tarask
	if (iwp === 'be_x_oldwiki') { iwp = 'be-taraskwiki'; }
	var localConfigFile = path.resolve(
		configDir, `./baseconfig/${opts.formatversion === 2 ? '2/' : ''}${iwp}.json`
	);
	var resultStr = JSON.stringify({ query: resultConf }, null, 2);
	yield fs.writeFile(localConfigFile, resultStr, 'utf8');
	console.log('Wrote', localConfigFile);
});

var usage = 'Usage: $0 [options]\n' +
	'Rewrites one cached siteinfo configuration.\n' +
	'Use --domain or --prefix to select which one to rewrite.';

var yopts = yargs
.usage(usage)
.options(ScriptUtils.addStandardOptions({
	'config': {
		description: "Path to a config.yaml file.  Use --config w/ no argument to default to the server's config.yaml",
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
	'formatversion': {
		description: 'Which formatversion to use',
		'boolean': false,
		'default': 1,
	}
}));

Promise.async(function *() {
	var argv = yopts.argv;
	if (argv.help) {
		yopts.showHelp();
		return;
	}
	yield update(argv);
})().done();
