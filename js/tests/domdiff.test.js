#!/usr/bin/env node
var DOMDiff = require('../lib/mediawiki.DOMDiff.js').DOMDiff,
	Util = require('../lib/mediawiki.Util.js').Util,
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
	oldhtml = fs.readFileSync(argv._[0], 'utf8')
	newhtml = fs.readFileSync(argv._[1], 'utf8')
}

// user-friendly 'boolean' command-line options:
// allow --debug=no and --debug=false to mean the same as --no-debug
var booleanOption = function ( val ) {
	if ( !val ) { return false; }
	if ( (typeof val) === 'string' &&
	     /^(no|false)$/i.test(val)) {
		return false;
	}
	return true;
};

if (booleanOption( argv.help ) || !oldhtml || !newhtml) {
	optimist.showHelp();
	return;
}

var dd = new DOMDiff({ conf: { parsoid: { debug: booleanOption( argv.debug ) } }, page: { id: null } }),
	oldDOM = Util.parseHTML(oldhtml),
	newDOM = Util.parseHTML(newhtml);

dd.doDOMDiff(oldDOM, newDOM);
if ( !booleanOption( argv.quiet ) ) {
	console.warn("----- DIFF-marked DOM -----");
}
console.log(newDOM.outerHTML );
process.exit(0);
