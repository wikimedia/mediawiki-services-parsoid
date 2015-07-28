#!/usr/bin/env node
'use strict';
require('../lib/core-upgrade.js');

var DOMDiff = require('../lib/mediawiki.DOMDiff.js').DOMDiff;
var Util = require('../lib/mediawiki.Util.js').Util;
var DU = require('../lib/mediawiki.DOMUtils.js').DOMUtils;
var ParsoidLogger = require('../lib/ParsoidLogger.js').ParsoidLogger;
var yargs = require('yargs');
var fs = require('fs');

var opts = yargs.usage("Usage: node $0 [options] [old-html-file new-html-file]\n\nProvide either inline html OR 2 files", {
	help: {
		description: 'Show this message',
		'boolean': true,
		'default': false,
	},
	oldhtml: {
		description: 'Old html',
		'boolean': false,
		'default': null,
	},
	newhtml: {
		description: 'New html',
		'boolean': false,
		'default': null,
	},
	quiet: {
		description: 'Emit only the marked-up HTML',
		'boolean': true,
		'default': false,
	},
	debug: {
		description: 'Debug mode',
		'boolean': true,
		'default': false,
	},
});

var argv = opts.argv;
var oldhtml = argv.oldhtml;
var newhtml = argv.newhtml;

if (!oldhtml && argv._[0]) {
	oldhtml = fs.readFileSync(argv._[0], 'utf8');
	newhtml = fs.readFileSync(argv._[1], 'utf8');
}

if (Util.booleanOption(argv.help) || !oldhtml || !newhtml) {
	opts.showHelp();
	return;
}

var oldDOM = DU.parseHTML(oldhtml);
var dummyEnv = {
	conf: { parsoid: { debug: Util.booleanOption(argv.debug) }, wiki: {} },
	page: { id: null, dom: oldDOM.body },
};

if (argv.debug) {
	var logger = new ParsoidLogger(dummyEnv);
	logger.registerBackend(/^(trace|debug)(\/|$)/, logger.getDefaultTracerBackend());
	dummyEnv.log = logger.log.bind(logger);
} else {
	dummyEnv.log = function() {};
}

var dd = new DOMDiff(dummyEnv);
var newDOM = DU.parseHTML(newhtml);
var diff = dd.diff(newDOM.body);

if (!Util.booleanOption(argv.quiet)) {
	console.warn("----- DIFF-marked DOM -----");
}
console.log(diff.dom.outerHTML);
process.exit(0);
