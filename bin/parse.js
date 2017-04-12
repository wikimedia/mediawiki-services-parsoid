#!/usr/bin/env node
/**
 * Command line parse utility.
 * Read from STDIN, write to STDOUT.
 */

'use strict';

require('../core-upgrade.js');

var fs = require('fs');
var path = require('path');
var yargs = require('yargs');
var yaml = require('js-yaml');

var parseJsPath = require.resolve('../lib/parse.js');
var Util = require('../lib/utils/Util.js').Util;
var DU = require('../lib/utils/DOMUtils.js').DOMUtils;
var Promise = require('../lib/utils/promise.js');

// Get some default values to display in argument descriptions
var ParserEnvProto = require('../lib/config/MWParserEnvironment.js').MWParserEnvironment.prototype;

var standardOpts = Util.addStandardOptions({
	'wt2html': {
		description: 'Wikitext -> HTML',
		'boolean': true,
		'default': false,
	},
	'html2wt': {
		description: 'HTML -> Wikitext',
		'boolean': true,
		'default': false,
	},
	'wt2wt': {
		description: 'Wikitext -> HTML -> Wikitext',
		'boolean': true,
		'default': false,
	},
	'html2html': {
		description: 'HTML -> Wikitext -> HTML',
		'boolean': true,
		'default': false,
	},
	'selser': {
		description: 'Use the selective serializer to go from HTML to Wikitext.',
		'boolean': true,
		'default': false,
	},
	'normalize': {
		description: 'Normalize the output as parserTests would do. Use --normalize for PHP tests, and --normalize=parsoid for parsoid-only tests',
		'default': false,
	},
	'config': {
		description: "Path to a config.yaml file.  Use --config w/ no argument to default to the server's config.yaml",
		'default': false,
	},
	'oldtext': {
		description: 'The old page text for a selective-serialization (see --selser)',
		'boolean': false,
		'default': null,
	},
	'oldtextfile': {
		description: 'File containing the old page text for a selective-serialization (see --selser)',
		'boolean': false,
		'default': null,
	},
	'oldhtmlfile': {
		description: 'File containing the old HTML for a selective-serialization (see --selser)',
		'boolean': false,
		'default': null,
	},
	'domdiff': {
		description: 'File containing the diff-marked HTML for used with selective-serialization (see --selser)',
		'boolean': false,
		'default': null,
	},
	'inputfile': {
		description: 'File containing input as an alternative to stdin',
		'boolean': false,
		'default': false,
	},
	'pbin': {
		description: 'Input pagebundle JSON',
		'boolean': false,
		'default': '',
	},
	'pbinfile': {
		description: 'Input pagebundle JSON file',
		'boolean': false,
		'default': '',
	},
	'pboutfile': {
		description: 'Output pagebundle JSON to file',
		'boolean': false,
		'default': false,
	},
	'offline': {
		description: 'Shortcut to turn off various network fetches during parse.',
		'boolean': true,
		'default': false,
	},
	'record': {
		description: 'Record http requests for later replay',
		'boolean': true,
		'default': false,
	},
	'replay': {
		description: 'Replay recorded http requests for later replay',
		'boolean': true,
		'default': false,
	},

	// These are ParsoidConfig properties

	'linting': {
		description: 'Parse with linter enabled',
		'boolean': true,
		'default': false,
	},
	'loadWMF': {
		description: 'Use WMF mediawiki API config',
		'boolean': true,
		'default': true,
	},
	'useBatchAPI': {
		description: 'Turn on/off the API batching system',
		// Since I picked a null default (to let the default config setting be the default),
		// I cannot make this a boolean option.
		'boolean': false,
		'default': null,
	},

	// These are MWParserEnvironment properties

	'prefix': {
		description: 'Which wiki prefix to use; e.g. "enwiki" for English wikipedia, "eswiki" for Spanish, "mediawikiwiki" for mediawiki.org',
		'boolean': false,
		'default': null,
	},
	'domain': {
		description: 'Which wiki to use; e.g. "en.wikipedia.org" for English wikipedia, "es.wikipedia.org" for Spanish, "mediawiki.org" for mediawiki.org',
		'boolean': false,
		'default': null,
	},
	'oldid': {
		description: 'Oldid of the given page.',
		'boolean': false,
		'default': null,
	},
	'contentVersion': {
		description: 'The acceptable content version.',
		'boolean': false,
		'default': ParserEnvProto.contentVersion,
	},
	'pageName': {
		description: 'The page name, returned for {{PAGENAME}}. If no input is given (ie. empty/stdin closed), it downloads and parses the page. This should be the actual title of the article (that is, not including any URL-encoding that might be necessary in wikitext).',
		'boolean': false,
		'default': ParserEnvProto.defaultPageName,
	},
	'pageBundle': {
		description: 'Output pagebundle JSON',
		'boolean': true,
		'default': false,
	},
	'scrubWikitext': {
		description: 'Apply wikitext scrubbing while serializing.',
		'boolean': true,
		'default': false,
	},
	'nativeGallery': {
		description: 'Omit extsrc from gallery.',
		'boolean': true,
		'default': false,
	},
	'contentmodel': {
		description: 'The content model of the input.  Defaults to "wikitext" but extensions may support others (for example, "json").',
		'boolean': false,
		'default': null,
	},
});

(function() {
	var defaultModeStr = "Default conversion mode : --wt2html";

	var opts = yargs.usage(
		'Usage: echo wikitext | $0 [options]\n\n' + defaultModeStr,
		standardOpts
	).strict();

	var argv = opts.parse(process.argv);

	if (Util.booleanOption(argv.help)) {
		opts.showHelp();
		return;
	}

	var mode = ['selser', 'html2html', 'html2wt', 'wt2wt']
	.find(function(m) { return argv[m]; }) || 'wt2html';

	var selser;
	if (mode === 'selser') {
		selser = {
			oldtext: argv.oldtext,
		};
		if (argv.oldtextfile) {
			selser.oldtext = fs.readFileSync(argv.oldtextfile, 'utf8');
		}
		if (selser.oldtext === null) {
			throw new Error('Please provide original wikitext ' +
				'(--oldtext or --oldtextfile). Selser requires that.');
		}
		if (argv.oldhtmlfile) {
			selser.oldhtml = fs.readFileSync(argv.oldhtmlfile, 'utf8');
		}
		if (argv.domdiff) {
			selser.domdiff = fs.readFileSync(argv.domdiff, 'utf8');
		}
	}

	var pb;
	if (argv.pbin.length > 0) {
		pb = JSON.parse(argv.pbin);
	} else if (argv.pbinfile) {
		pb = JSON.parse(fs.readFileSync(argv.pbinfile, 'utf8'));
	}

	var prefix = argv.prefix || null;
	var domain = argv.domain || null;

	if (argv.apiURL) {
		prefix = 'customwiki';
		domain = null;
	} else if (!(prefix || domain)) {
		domain = 'en.wikipedia.org';
	}

	var parsoidOptions = {
		linting: argv.linting,
		loadWMF: argv.loadWMF,
		useBatchAPI: argv.useBatchAPI,
	};

	if (Util.booleanOption(argv.config)) {
		var p = (typeof (argv.config) === 'string') ?
			path.resolve('.', argv.config) :
			path.resolve(__dirname, '../config.yaml');
		// Assuming Parsoid is the first service in the list
		parsoidOptions = yaml.load(fs.readFileSync(p, 'utf8')).services[0].conf;
	}

	Util.setTemplatingAndProcessingFlags(parsoidOptions, argv);
	Util.setDebuggingFlags(parsoidOptions, argv);

	// Offline shortcut
	if (argv.offline) {
		parsoidOptions.fetchConfig = false;
		parsoidOptions.fetchTemplates = false;
		parsoidOptions.fetchImageInfo = false;
		parsoidOptions.usePHPPreProcessor = false;
		parsoidOptions.expandExtensions = false;
	}

	if (parsoidOptions.localsettings) {
		parsoidOptions.localsettings = path.resolve(__dirname, parsoidOptions.localsettings);
	}

	var nock, dir, nocksFile;
	if (argv.record || argv.replay) {
		prefix = prefix || 'enwiki';
		dir = path.resolve(__dirname, '../nocks/');
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir);
		}
		dir = dir + '/' + prefix;
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir);
		}
		nocksFile = dir + '/' + encodeURIComponent(argv.page) + '.js';
		if (argv.record) {
			nock = require('nock');
			nock.recorder.rec({ dont_print: true });
		} else {
			require(nocksFile);
		}
	}

	var envOptions = {
		domain: domain,
		prefix: prefix,
		pageName: argv.pageName,
		scrubWikitext: argv.scrubWikitext,
		nativeGallery: argv.nativeGallery,
		pageBundle: argv.pageBundle || argv.pboutfile,
	};

	return Promise.resolve()
	.then(function() {
		if (argv.inputfile) {
			// read input from the file, then process
			var fileContents = fs.readFileSync(argv.inputfile, 'utf8');
			return fileContents;
		}

		// Send a message to stderr if there is no input for a while, since the
		// convention that --pageName must be used with </dev/null is confusing.
		var stdinTimer = setTimeout(function() {
			console.error('Waiting for stdin...');
		}, 1000);

		return new Promise(function(resolve) {
			// collect input
			var inputChunks = [];
			var stdin = process.stdin;
			stdin.resume();
			stdin.setEncoding('utf8');
			stdin.on('data', function(chunk) {
				inputChunks.push(chunk);
			});
			stdin.on('end', function() {
				resolve(inputChunks);
			});
		})
		.then(function(inputChunks) {
			clearTimeout(stdinTimer);
			// parse page if no input
			if (inputChunks.length > 0) {
				return inputChunks.join('');
			} else if (argv.html2wt || argv.html2html) {
				throw new Error('Pages start at wikitext.');
			}
		});
	})
	.then(function(input) {
		var obj = {
			input: input,
			mode: mode,
			parsoidOptions: parsoidOptions,
			envOptions: envOptions,
			oldid: argv.oldid,
			selser: selser,
			pb: pb,
			contentmodel: argv.contentmodel,
			contentVersion: argv.contentVersion,
		};
		return require(parseJsPath)(obj);
	})
	.then(function(out) {
		var str;
		if (['wt2html', 'html2html'].includes(mode)) {
			var html = out.html;
			var doc;
			if (argv.pboutfile) {
				fs.writeFileSync(argv.pboutfile, JSON.stringify(out.pb), 'utf8');
			} else if (argv.pageBundle) {
				// Stitch this back in, even though it was just extracted
				doc = DU.parseHTML(html);
				DU.injectPageBundle(doc, out.pb);
				html = DU.toXML(doc);
			}
			if (argv.normalize) {
				doc = DU.parseHTML(html);
				str = DU.normalizeOut(doc.body, (argv.normalize === 'parsoid'));
			} else {
				str = html;
			}
		} else {
			str = out.wt;
		}
		var stdout = process.stdout;
		stdout.write(str);
		if (stdout.isTTY) {
			stdout.write('\n');
		}
		if (argv.record) {
			return new Promise(function(resolve, reject) {
				var nockCalls = nock.recorder.play();
				var stream = fs.createWriteStream(nocksFile);
				stream.once('open', function() {
					stream.write("var nock = require('nock');");
					for (var i = 0; i < nockCalls.length; i++) {
						stream.write(nockCalls[i]);
					}
					stream.end();
				});
				stream.once('error', function(e) {
					reject(e);
				});
				stream.once('close', function() {
					resolve();
				});
			});
		}
	})
	.done();
}());
