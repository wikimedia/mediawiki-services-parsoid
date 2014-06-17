#!/usr/bin/env node
/**
 * Command line parse utility.
 * Read from STDIN, write to STDOUT.
 */
"use strict";

var ParserEnv = require('../lib/mediawiki.parser.environment.js').MWParserEnvironment,
	ParsoidConfig = require( '../lib/mediawiki.ParsoidConfig.js' ).ParsoidConfig,
	WikitextSerializer = require('../lib/mediawiki.WikitextSerializer.js').WikitextSerializer,
	SelectiveSerializer = require( '../lib/mediawiki.SelectiveSerializer.js' ).SelectiveSerializer,
	TemplateRequest = require('../lib/mediawiki.ApiRequest.js').TemplateRequest,
	Util = require('../lib/mediawiki.Util.js').Util,
	DU = require('../lib/mediawiki.DOMUtils.js').DOMUtils,
	Logger = require('../lib/Logger.js').Logger,
	yargs = require('yargs'),
	fs = require('fs'),
	path = require('path');

( function() {
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
			'default': 'Main_Page'
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
		var p = ( typeof( argv.config ) === 'string' ) ?
			path.resolve( '.', argv.config) :
			path.resolve( __dirname, '../api/localsettings.js' );
		local = require( p );
	}
	var parsoidConfig = new ParsoidConfig( local, { defaultWiki: prefix } );

	Util.setTemplatingAndProcessingFlags( parsoidConfig, argv );
	Util.setDebuggingFlags( parsoidConfig, argv );

	ParserEnv.getParserEnv( parsoidConfig, null, prefix, argv.page || null, null, function ( err, env ) {
		if ( err !== null ) {
			console.error(err);
			return;
		}

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
				env.page.dom = DU.parseHTML(fs.readFileSync(argv.oldhtmlfile, 'utf8')).body;
			}
			if ( argv.domdiff ) {
				env.page.domdiff = { isEmpty: false, dom: DU.parseHTML(fs.readFileSync(argv.domdiff, 'utf8')).body };
			}
			env.setPageSrcInfo( argv.oldtext || null );
		}

		var inputChunks = [];
		var processInput = function () {
			// parse page if no input
			if ( inputChunks.length === 0 ) {
				if ( argv.html2wt || argv.html2html ) {
					env.log("fatal", "Pages start at wikitext.");
				}
				var target = env.resolveTitle(
						env.normalizeTitle( env.page.name ), '' );
				var tpr = new TemplateRequest( env, target );
				tpr.once( 'src', function ( err, src_and_metadata ) {
					if ( err ) {
						env.log("fatal", err);
					}
					startsAtWikitext( env, src_and_metadata );
				} );
				return;
			}

			var input = inputChunks.join('');
			if ( argv.html2wt || argv.html2html ) {
				var dp = argv.dpin.length > 0 ? JSON.parse( argv.dpin ) : null;
				startsAtHTML( env, input.replace(/\r/g, ''), dp );
			} else {
				startsAtWikitext( env, input );
			}
		};

		if ( argv.inputfile ) {
			//read input from the file, then process
			var fileContents = fs.readFileSync( argv.inputfile, 'utf8' );
			inputChunks.push( fileContents );
			processInput();
		} else {
			// collect input
			var stdin = process.stdin;
			stdin.resume();
			stdin.setEncoding('utf8');
			stdin.on( 'data', function( chunk ) {
				inputChunks.push( chunk );
			} );
			stdin.on( 'end', processInput );
		}
	});

	function addTrailingNL( trailingNL, out ) {
		var stdout = process.stdout;
		stdout.write(out);
		if ( trailingNL && stdout.isTTY ) {
			stdout.write("\n");
		}
	}

	function startsAtHTML( env, input, dp ) {
		var serializer;
		if ( argv.selser ) {
			serializer = new SelectiveSerializer({ env: env, oldid: null });
		} else {
			serializer = new WikitextSerializer({ env: env });
		}
		var doc = DU.parseHTML( input );
		if ( dp ) {
			DU.applyDataParsoid( doc, dp );
		}
		var out = '';
		serializer.serializeDOM(doc.body, function ( chunk ) {
			out += chunk;
		}, function () {
			if ( argv.html2wt || argv.wt2wt ) {
				addTrailingNL( false, out );
			} else {
				startsAtWikitext( env, out );
			}
		});
	}

	function startsAtWikitext( env, input ) {
		var parserPipeline = env.pipelineFactory.getPipeline(
			'text/x-mediawiki/full');

		parserPipeline.once('document', function ( document ) {
			var out, dp;
			if ( argv.wt2html || argv.html2html ) {
				out = DU.serializeNode( document );
				if ( argv.normalize ) {
					out = DU.normalizeOut(out, (argv.normalize === 'parsoid'));
				}
				addTrailingNL( true, out );
			} else {
				out = DU.serializeNode( document.body, true );
				dp = argv.dp ? DU.getDataParsoid( document ) : null;
				startsAtHTML( env, out, dp );
			}
			if(argv.lint){
				env.log("end/parse");
			}
		});

		// Kick off the pipeline by feeding the input into the parser pipeline
		env.setPageSrcInfo( input );
		parserPipeline.processToplevelDoc( env.page.src );
	}

})();
