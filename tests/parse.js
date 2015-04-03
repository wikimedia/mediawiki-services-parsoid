#!/usr/bin/env node
/**
 * Command line parse utility.
 * Read from STDIN, write to STDOUT.
 */
"use strict";
require( '../lib/core-upgrade.js' );

var ParserEnv = require('../lib/mediawiki.parser.environment.js').MWParserEnvironment,
	ParsoidConfig = require( '../lib/mediawiki.ParsoidConfig.js' ).ParsoidConfig,
	WikitextSerializer = require('../lib/mediawiki.WikitextSerializer.js').WikitextSerializer,
	SelectiveSerializer = require( '../lib/mediawiki.SelectiveSerializer.js' ).SelectiveSerializer,
	TemplateRequest = require('../lib/mediawiki.ApiRequest.js').TemplateRequest,
	Util = require('../lib/mediawiki.Util.js').Util,
	DU = require('../lib/mediawiki.DOMUtils.js').DOMUtils,
	yargs = require('yargs'),
	fs = require('fs'),
	path = require('path');

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
		'default': false
	},
	'html2wt': {
		description: 'HTML -> Wikitext',
		'boolean': true,
		'default': false
	},
	'wt2wt': {
		description: 'Wikitext -> HTML -> Wikitext',
		'boolean': true,
		'default': false
	},
	'html2html': {
		description: 'HTML -> Wikitext -> HTML',
		'boolean': true,
		'default': false
	},
	'selser': {
		description: 'Use the selective serializer to go from HTML to Wikitext.',
		'boolean': true,
		'default': false
	},
	'normalize': {
		description: 'Normalize the output as parserTests would do. Use --normalize for PHP tests, and --normalize=parsoid for parsoid-only tests',
		'default': false
	},
	'config': {
		description: "Path to a localsettings.js file.  Use --config w/ no argument to default to the server's localsettings.js",
		'default': false
	},
	'prefix': {
		description: 'Which wiki prefix to use; e.g. "enwiki" for English wikipedia, "eswiki" for Spanish, "mediawikiwiki" for mediawiki.org',
		'default': 'enwiki'
	},
	'page': {
		description: 'The page name, returned for {{PAGENAME}}. If no input is given (ie. empty/stdin closed), it downloads and parses the page.',
		'boolean': false,
		'default': ParserEnv.prototype.defaultPageName
	},
	'oldid': {
		description: 'Oldid of the given page.',
		'boolean': false,
		'default': null
	},
	'oldtext': {
		description: 'The old page text for a selective-serialization (see --selser)',
		'boolean': false,
		'default': false
	},
	'oldtextfile': {
		description: 'File containing the old page text for a selective-serialization (see --selser)',
		'boolean': false,
		'default': null
	},
	'oldhtmlfile': {
		description: 'File containing the old HTML for a selective-serialization (see --selser)',
		'boolean': false,
		'default': null
	},
	'domdiff': {
		description: 'File containing the diff-marked HTML for used with selective-serialization (see --selser)',
		'boolean': false,
		'default': null
	},
	'inputfile': {
		description: 'File containing input as an alternative to stdin',
		'boolean': false,
		'default': false
	},
	'extensions': {
		description: 'List of valid extensions - of form foo,bar,baz',
		'boolean': false,
		'default': ''
	},
	'dpinfile': {
		description: 'Input data-parsoid JSON file',
		'boolean': false,
		'default': ''
	},
	'dpin': {
		description: 'Input data-parsoid JSON',
		'boolean': false,
		'default': ''
	},
	'lint': {
		description: 'Parse with linter enabled',
		'boolean': true,
		'default': false
	}
});
exports.defaultOptions = yargs.options(standardOpts).parse([]);

function dpFromHead( doc ) {
	var dp, dpScriptElt = doc.getElementById('mw-data-parsoid');
	if ( dpScriptElt ) {
		dpScriptElt.parentNode.removeChild(dpScriptElt);
		dp = JSON.parse(dpScriptElt.text);
	}
	return dp;
}

var startsAtWikitext;
var startsAtHTML = function( argv, env, input, dp ) {
	var serializer, doc = DU.parseHTML( input );
	dp = dp || dpFromHead( doc );

	if ( argv.selser ) {
		dp = dp || dpFromHead( env.page.dom.ownerDocument );
		if ( dp ) {
			DU.applyDataParsoid( env.page.dom.ownerDocument, dp );
		}
		serializer = new SelectiveSerializer({ env: env, oldid: null });
	} else {
		serializer = new WikitextSerializer({ env: env });
	}

	if ( dp ) {
		DU.applyDataParsoid( doc, dp );
	}

	return Promise.promisify( serializer.serializeDOM, false, serializer )(
		doc.body, false
	).then(function(out) {
		if ( argv.html2wt || argv.wt2wt ) {
			return { trailingNL: true, out: out };
		} else {
			return startsAtWikitext( argv, env, out );
		}
	});
};

startsAtWikitext = function( argv, env, input ) {
	return new Promise(function( resolve ) {
		var parser = env.pipelineFactory.getPipeline('text/x-mediawiki/full');
		parser.once( 'document', resolve );
		// Kick off the pipeline by feeding the input into the parser pipeline
		env.setPageSrcInfo( input );
		parser.processToplevelDoc( env.page.src );
	}).then(function( doc ) {
		if ( argv.lint ) {
			env.log("end/parse");
		}
		if ( argv.wt2html || argv.html2html ) {
			var out;
			if ( argv.normalize ) {
				out = DU.normalizeOut( doc.body, (argv.normalize === 'parsoid') );
			} else if ( argv.document ) {
				// used in Parsoid JS API, return document
				out = doc;
			} else {
				out = DU.serializeNode( doc );
			}
			return { trailingNL: true, out: out };
		} else {
			return startsAtHTML( argv, env, DU.serializeNode( doc ) );
		}
	});
};

var parse = exports.parse = function( input, argv, parsoidConfig, prefix ) {
	return ParserEnv.getParserEnv(parsoidConfig, null, {
		prefix: prefix,
		pageName: argv.page
	}).then(function( env ) {

		// fetch templates from enwiki by default.
		if ( argv.wgScriptPath ) {
			env.conf.wiki.wgScriptPath = argv.wgScriptPath;
		}

		var i, validExtensions;
		if ( validExtensions !== '' ) {
			validExtensions = argv.extensions.split( ',' );
			for ( i = 0; i < validExtensions.length; i++ ) {
				env.conf.wiki.addExtensionTag( validExtensions[i] );
			}
		}

		if ( !argv.wt2html ) {
			if ( argv.oldtextfile ) {
				argv.oldtext = fs.readFileSync(argv.oldtextfile, 'utf8');
			}
			if ( argv.oldhtmlfile ) {
				env.page.dom = DU.parseHTML(
					fs.readFileSync(argv.oldhtmlfile, 'utf8')
				).body;
			}
			if ( argv.domdiff ) {
				env.page.domdiff = {
					isEmpty: false,
					dom: DU.parseHTML(fs.readFileSync(argv.domdiff, 'utf8')).body
				};
			}
			env.setPageSrcInfo( argv.oldtext || null );
		}

		if ( typeof ( input ) === 'string' ) {
			return { env: env, input: input };
		}

		if ( argv.inputfile ) {
			// read input from the file, then process
			var fileContents = fs.readFileSync( argv.inputfile, 'utf8' );
			return { env: env, input: fileContents };
		}

		return new Promise(function( resolve ) {
			// collect input
			var inputChunks = [],
				stdin = process.stdin;
			stdin.resume();
			stdin.setEncoding('utf8');
			stdin.on('data', function( chunk ) {
				inputChunks.push( chunk );
			});
			stdin.on('end', function() {
				resolve( inputChunks );
			});
		}).then(function( inputChunks ) {
			// parse page if no input
			if ( inputChunks.length > 0 ) {
				return { env: env, input: inputChunks.join("") };
			} else if ( argv.html2wt || argv.html2html ) {
				env.log("fatal", "Pages start at wikitext.");
			}
			var target = env.resolveTitle(
				env.normalizeTitle( env.page.name ), ''
			);
			return new Promise(function( resolve, reject ) {
				var tpr = new TemplateRequest( env, target, argv.oldid );
				tpr.once('src', function( err, src_and_metadata ) {
					if ( err ) {
						reject( err );
					} else {
						resolve({ env: env, input: src_and_metadata });
					}
				});
			});
		});

	}).then(function( res ) {
		var env = res.env, input = res.input;
		if ( typeof input === "string" ) {
			input = input.replace(/\r/g, '');
		}

		if ( argv.html2wt || argv.html2html ) {
			var dp;
			if (argv.dpin.length > 0) {
				dp = JSON.parse( argv.dpin );
			} else if ( argv.dpinfile ) {
				dp = JSON.parse(fs.readFileSync(argv.dpinfile, 'utf8'));
			}
			return startsAtHTML( argv, env, input, dp );
		} else {
			return startsAtWikitext( argv, env, input );
		}

	});
};

if ( require.main === module ) {
	(function() {
		var default_mode_str = "Default conversion mode : --wt2html";

		var opts = yargs.usage(
			'Usage: echo wikitext | $0 [options]\n\n' + default_mode_str,
			standardOpts
		).check(Util.checkUnknownArgs.bind(null, standardOpts));

		var argv = opts.argv;

		if ( Util.booleanOption( argv.help ) ) {
			opts.showHelp();
			return;
		}

		// Because selser builds on html2wt serialization,
		// the html2wt flag should be automatically set when selser is set.
		if ( argv.selser ) {
			argv.html2wt = true;
		}

		// Default conversion mode
		if ( !argv.html2wt && !argv.wt2wt && !argv.html2html ) {
			argv.wt2html = true;
		}

		var prefix = argv.prefix || null;

		if ( argv.apiURL ) {
			prefix = 'customwiki';
		}

		var local = null;
		if ( Util.booleanOption( argv.config ) ) {
			var p = ( typeof ( argv.config ) === 'string' ) ?
				path.resolve( '.', argv.config) :
				path.resolve( __dirname, '../api/localsettings.js' );
			local = require( p );
		}

		var parsoidConfig = new ParsoidConfig( local, { defaultWiki: prefix } );
		Util.setTemplatingAndProcessingFlags( parsoidConfig, argv );
		Util.setDebuggingFlags( parsoidConfig, argv );
		return parse( null, argv, parsoidConfig, prefix ).then(function( res ) {
			var stdout = process.stdout;
			stdout.write( res.out );
			if ( res.trailingNL && stdout.isTTY ) {
				stdout.write( "\n" );
			}
		}).done();
	}());
}
