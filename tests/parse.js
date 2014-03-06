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
	optimist = require('optimist'),
	fs = require('fs');

( function() {
	var default_mode_str = "Default conversion mode : --wt2html";
	var opts = optimist.usage( 'Usage: echo wikitext | $0 [options]\n\n' + default_mode_str, Util.addStandardOptions({
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
		}
	}));

	var argv = opts.argv;

	if ( Util.booleanOption( argv.help ) ) {
		optimist.showHelp();
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

	var parsoidConfig = new ParsoidConfig( null, { defaultWiki: prefix } );

	Util.setTemplatingAndProcessingFlags( parsoidConfig, argv );
	Util.setDebuggingFlags( parsoidConfig, argv );

	ParserEnv.getParserEnv( parsoidConfig, null, prefix, argv.page || null, null, function ( err, env ) {
		if ( err !== null ) {
			env.log("fatal", err);
		}

		// fetch templates from enwiki by default.
		if ( argv.wgScriptPath ) {
			env.conf.wiki.wgScriptPath = argv.wgScriptPath;
		}

		var i,
				validExtensions;

		if ( validExtensions !== '' ) {
			validExtensions = argv.extensions.split( ',' );

			for ( i = 0; i < validExtensions.length; i++ ) {
				env.conf.wiki.addExtensionTag( validExtensions[i] );
			}
		}

		// Init parsers, serializers, etc.
		var parserPipeline,
				serializer;

		if ( !argv.html2wt ) {
			parserPipeline = env.pipelineFactory.getPipeline( 'text/x-mediawiki/full');
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
			if ( argv.selser ) {
				serializer = new SelectiveSerializer( { env: env, oldid: null } );
			} else {
				serializer = new WikitextSerializer( { env: env } );
			}
		}

		var stdin = process.stdin,
			stdout = process.stdout,
			inputChunks = [];

		// process input
		var processInput = function() {

			// parse page
			if ( inputChunks.length === 0 ) {
				var target = env.resolveTitle( env.normalizeTitle( env.page.name ),
																			'' );
				var tpr = new TemplateRequest( env, target );
				tpr.once( 'src', function ( err, src_and_metadata ) {
					if ( err ) {
						env.log("fatal", err);
					}
					env.setPageSrcInfo( src_and_metadata );
					Util.parse( env, function ( src, err, doc ) {
						if ( err ) {
							env.log("fatal", err);
						}
						stdout.write( DU.serializeNode( doc.documentElement ) );
					}, null, env.page.src );
				} );
				return;
			}

			var input = inputChunks.join('');
			if ( argv.html2wt || argv.html2html ) {
				var doc = DU.parseHTML( input.replace(/\r/g, '') ),
					wt = '';
				if ( argv.dpin.length > 0 ) {
					DU.applyDataParsoid( doc, JSON.parse( argv.dpin ) );
				}
				serializer.serializeDOM( doc.body, function ( chunk ) {
					wt += chunk;
				}, function () {
					env.setPageSrcInfo( wt );
					if ( argv.html2wt ) {
						// add a trailing newline for shell user's benefit
						stdout.write(wt);
					} else {
						parserPipeline.once( 'document', function(document) {
							var out;
							if ( argv.normalize ) {
								out = DU.normalizeOut(
									DU.serializeNode( document.body ),
									( argv.normalize==='parsoid' )
								);
							} else {
								out = DU.serializeNode( document.body );
							}

							stdout.write( out );
						} );
						parserPipeline.processToplevelDoc(wt);
					}
				} );
			} else {
				parserPipeline.once( 'document', function ( document ) {
					var res,
						finishCb = function ( trailingNL ) {
							stdout.write( res );
							if (trailingNL && process.stdout.isTTY) {
								stdout.write("\n");
							}
						};
					if ( argv.wt2html ) {
						if ( argv.dp ) {
							console.log( JSON.stringify( document.data.parsoid ) );
						}
						if ( argv.normalize ) {
							res = DU.normalizeOut(
								DU.serializeNode( document.body ),
								( argv.normalize==='parsoid' )
							);
						} else {
							res = DU.serializeNode( document.body );
						}
						finishCb( true );
					} else {
						res = '';
						if ( argv.dp ) {
							DU.applyDataParsoid( document, document.data.parsoid );
						}
						serializer.serializeDOM(
							DU.parseHTML( DU.serializeNode( document, true ) ).body,
								function ( chunk ) {
									res += chunk;
								},
								finishCb
						);
					}
				} );

				// Kick off the pipeline by feeding the input into the parser pipeline
				env.setPageSrcInfo( input );
				parserPipeline.processToplevelDoc( env.page.src );
			}
		};

		if (argv.inputfile) {
			//read input from the file, then process
			var fileContents = fs.readFileSync( argv.inputfile, 'utf8' );
			inputChunks.push( fileContents );
			processInput();
		} else {
			// collect input
			stdin.resume();
			stdin.setEncoding('utf8');
			stdin.on( 'data', function( chunk ) {
				inputChunks.push( chunk );
			} );
			stdin.on( 'end', processInput );
		}
	} );
} )();
