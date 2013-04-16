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

if (argv.help || !oldhtml || !newhtml) {
	optimist.showHelp();
	return;
}

var dd = new DOMDiff({ conf: { parsoid: { debug: argv.debug } }, page: { id: null } }),
	oldDOM = Util.parseHTML(oldhtml),
	newDOM = Util.parseHTML(newhtml);

dd.doDOMDiff(oldDOM, newDOM);
console.warn("----- DIFF-marked DOM -----");
console.log(newDOM.outerHTML );
