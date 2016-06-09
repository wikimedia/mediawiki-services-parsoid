#!/usr/bin/env node
/**
 * Command line parse utility.
 * Read from STDIN, write to STDOUT.
 */
'use strict';
require('../core-upgrade.js');

var ParserEnv = require('../lib/config/MWParserEnvironment.js').MWParserEnvironment;
var ParsoidConfig = require('../lib/config/ParsoidConfig.js').ParsoidConfig;
var TemplateRequest = require('../lib/mw/ApiRequest.js').TemplateRequest;
var Util = require('../lib/utils/Util.js').Util;
var DU = require('../lib/utils/DOMUtils.js').DOMUtils;
var Promise = require('../lib/utils/promise.js');
var fs = require('fs');
var path = require('path');
var yargs = require('yargs');

process.on('SIGUSR2', function() {
	var heapdump = require('heapdump');
	console.error('SIGUSR2 received! Writing snapshot.');
	process.chdir('/tmp');
	heapdump.writeSnapshot();
});

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
		description: "Path to a localsettings.js file.  Use --config w/ no argument to default to the server's localsettings.js",
		'default': false,
	},
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
	'page': {
		description: 'The page name, returned for {{PAGENAME}}. If no input is given (ie. empty/stdin closed), it downloads and parses the page.',
		'boolean': false,
		'default': ParserEnv.prototype.defaultPageName,
	},
	'oldid': {
		description: 'Oldid of the given page.',
		'boolean': false,
		'default': null,
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
	'contentVersion': {
		description: 'The acceptable content version.',
		'boolean': false,
		'default': ParserEnv.prototype.contentVersion,
	},
	'pagebundle': {
		description: 'Output pagebundle JSON',
		'boolean': true,
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
	'lint': {
		description: 'Parse with linter enabled',
		'boolean': true,
		'default': false,
	},
	'scrubWikitext': {
		description: 'Apply wikitext scrubbing while serializing.',
		'boolean': true,
		'default': false,
	},
	'loadWMF': {
		description: 'Use WMF mediawiki API config',
		'boolean': true,
		'default': true,
	},
	'offline': {
		description: 'Shortcut to turn off various network fetches during parse.',
		'boolean': true,
		'default': false,
	},
	'useBatchAPI': {
		description: 'Turn on/off the API batching system',
		// Since I picked a null default (to let the default config setting be the default),
		// I cannot make this a boolean option.
		'boolean': false,
		'default': null,
	},
});
exports.defaultOptions = yargs.options(standardOpts).parse([]);

var startsAtWikitext;
var startsAtHTML = function(argv, env, input, pb) {
	var doc = DU.parseHTML(input);
	pb = pb || DU.extractPageBundle(doc);
	if (argv.selser) {
		pb = pb || DU.extractPageBundle(env.page.dom.ownerDocument);
		if (pb) {
			DU.applyPageBundle(env.page.dom.ownerDocument, pb);
		}
	}
	if (pb) {
		DU.applyPageBundle(doc, pb);
	}
	return DU.serializeDOM(env, doc.body, argv.selser).then(function(out) {
		if (argv.html2wt || argv.wt2wt) {
			return { trailingNL: true, out: out, env: env };
		} else {
			return startsAtWikitext(argv, env, out);
		}
	});
};

startsAtWikitext = function(argv, env, input) {
	env.setPageSrcInfo(input);
	// Kick off the pipeline by feeding the input into the parser pipeline
	return env.pipelineFactory.parse(env, env.page.src).then(function(doc) {
		if (argv.lint) {
			env.log("end/parse");
		}
		if (argv.wt2html || argv.html2html) {
			var out;
			if (argv.normalize) {
				out = DU.normalizeOut(doc.body, (argv.normalize === 'parsoid'));
			} else if (argv.document) {
				// used in Parsoid JS API, return document
				out = doc;
			} else {
				out = DU.toXML(doc);
			}
			return { trailingNL: true, out: out, env: env };
		} else {
			return startsAtHTML(argv, env, DU.toXML(doc));
		}
	});
};

var parse = exports.parse = function(input, argv, parsoidConfig, prefix, domain) {
	var env;
	return ParserEnv.getParserEnv(parsoidConfig, {
		prefix: prefix,
		domain: domain,
		pageName: argv.page,
	}).then(function(_env) {
		env = _env;

		// fetch templates from enwiki by default.
		if (argv.wgScriptPath) {
			env.conf.wiki.wgScriptPath = argv.wgScriptPath;
		}

		// Enable wikitext scrubbing
		env.scrubWikitext = argv.scrubWikitext;

		// Sets ids on nodes and stores data-* attributes in a JSON blob
		env.pageBundle = argv.pagebundle;

		// The content version to output
		if (argv.contentVersion) {
			env.setContentVersion(argv.contentVersion);
		}

		if (!argv.wt2html) {
			if (argv.oldtextfile) {
				argv.oldtext = fs.readFileSync(argv.oldtextfile, 'utf8');
			}
			if (argv.oldhtmlfile) {
				env.page.dom = DU.parseHTML(
					fs.readFileSync(argv.oldhtmlfile, 'utf8')
				).body;
			}
			if (argv.domdiff) {
				// FIXME: need to load diff markers from attributes
				env.page.domdiff = {
					isEmpty: false,
					dom: DU.ppToDOM(fs.readFileSync(argv.domdiff, 'utf8')),
				};
				throw new Error('this is broken');
			}
			env.setPageSrcInfo(argv.oldtext || null);
		}

		if (argv.selser && argv.oldtext === null) {
			throw new Error('Please provide original wikitext ' +
				'(--oldtext or --oldtextfile). Selser requires that.');
		}

		if (typeof input === 'string') {
			return input;
		}

		if (argv.inputfile) {
			// read input from the file, then process
			var fileContents = fs.readFileSync(argv.inputfile, 'utf8');
			return fileContents;
		}

		// Send a message to stderr if there is no input for a while, since the
		// convention that --page must be used with </dev/null is confusing.
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
		}).then(function(inputChunks) {
			clearTimeout(stdinTimer);
			// parse page if no input
			if (inputChunks.length > 0) {
				return inputChunks.join('');
			} else if (argv.html2wt || argv.html2html) {
				env.log("fatal", "Pages start at wikitext.");
			}
			var target = env.normalizeAndResolvePageTitle();
			return TemplateRequest
				.setPageSrcInfo(env, target, argv.oldid)
				.then(function() { return env.page.src; });
		});
	}).then(function(str) {
		str = str.replace(/\r/g, '');
		if (argv.html2wt || argv.html2html) {
			var pb;
			if (argv.pbin.length > 0) {
				pb = JSON.parse(argv.pbin);
			} else if (argv.pbinfile) {
				pb = JSON.parse(fs.readFileSync(argv.pbinfile, 'utf8'));
			}
			return startsAtHTML(argv, env, str, pb);
		} else {
			return startsAtWikitext(argv, env, str);
		}
	});
};

if (require.main === module) {
	(function() {
		var defaultModeStr = "Default conversion mode : --wt2html";

		var opts = yargs.usage(
			'Usage: echo wikitext | $0 [options]\n\n' + defaultModeStr,
			standardOpts
		).strict();

		var argv = opts.argv;

		if (Util.booleanOption(argv.help)) {
			opts.showHelp();
			return;
		}

		// Because selser builds on html2wt serialization,
		// the html2wt flag should be automatically set when selser is set.
		if (argv.selser) {
			argv.html2wt = true;
		}

		// Default conversion mode
		if (!argv.html2wt && !argv.wt2wt && !argv.html2html) {
			argv.wt2html = true;
		}

		// Offline shortcut
		if (argv.offline) {
			argv.fetchConfig = false;
			argv.fetchTemplates = false;
			argv.fetchImageInfo = false;
			argv.usephppreprocessor = false;
		}

		var prefix = argv.prefix || null;
		var domain = argv.domain || null;

		if (argv.apiURL) {
			prefix = 'customwiki';
			domain = null;
		} else if (!(prefix || domain)) {
			domain = 'en.wikipedia.org';
		}

		var local = null;
		if (Util.booleanOption(argv.config)) {
			var p = (typeof (argv.config) === 'string') ?
				path.resolve('.', argv.config) :
				path.resolve(__dirname, '../localsettings.js');
			local = require(p);
		}

		var setup = function(parsoidConfig) {
			parsoidConfig.loadWMF = argv.loadWMF;
			if (local && local.setup) {
				local.setup(parsoidConfig);
			}
			Util.setTemplatingAndProcessingFlags(parsoidConfig, argv);
			Util.setDebuggingFlags(parsoidConfig, argv);
		};

		var parsoidConfig = new ParsoidConfig(
			{ setup: setup }
		);

		parsoidConfig.defaultWiki = prefix ? prefix :
			parsoidConfig.reverseMwApiMap.get(domain);

		return parse(null, argv, parsoidConfig, prefix, domain).then(function(res) {
			var stdout = process.stdout;
			stdout.write(res.out);
			if (res.trailingNL && stdout.isTTY) {
				stdout.write('\n');
			}
		}).done();
	}());
}
