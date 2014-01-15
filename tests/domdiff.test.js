#!/usr/bin/env node
"use strict";
var DOMDiff = require('../lib/mediawiki.DOMDiff.js').DOMDiff,
	Util = require('../lib/mediawiki.Util.js').Util,
	DU = require('../lib/mediawiki.DOMUtils.js').DOMUtils,
	optimist = require('optimist'),
	fs = require('fs');

var opts = optimist.usage("Usage: node $0 [options] [old-html-file new-html-file]\n\nProvide either inline html OR 2 files", {
		'help': {
			description: 'Show this message',
			'boolean': true,
			'default': false
		},
		'oldhtml': {
			description: 'Old html',
			'boolean': false,
			'default': null
		},
		'newhtml': {
			description: 'New html',
			'boolean': false,
			'default': null
		},
		'quiet': {
			description: 'Emit only the marked-up HTML',
			'boolean': true,
			'default': false
		},
		'debug': {
			description: 'Debug mode',
			'boolean': true,
			'default': false
		}
	});

var argv = opts.argv,
	oldhtml = argv.oldhtml,
	newhtml = argv.newhtml;

if (!oldhtml && argv._[0]) {
	oldhtml = fs.readFileSync(argv._[0], 'utf8');
	newhtml = fs.readFileSync(argv._[1], 'utf8');
}

if (Util.booleanOption( argv.help ) || !oldhtml || !newhtml) {
	optimist.showHelp();
	return;
}

var dummyEnv = {
	conf: { parsoid: { debug: Util.booleanOption( argv.debug ) } },
	page: { id: null },
	isParsoidObjectId: function() { return true; }
};

var dd = new DOMDiff(dummyEnv),
	oldDOM = DU.parseHTML(oldhtml),
	newDOM = DU.parseHTML(newhtml);

dd.doDOMDiff(oldDOM, newDOM);
if ( !Util.booleanOption( argv.quiet ) ) {
	console.warn("----- DIFF-marked DOM -----");
}
console.log(newDOM.outerHTML );
process.exit(0);
