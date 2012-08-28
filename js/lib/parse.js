/**
 * Command line parse utility.
 * Read from STDIN, write to STDOUT.
 *
 * @author Neil Kandalgaonkar <neilk@wikimedia.org>
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 */

var ParserPipelineFactory = require('./mediawiki.parser.js').ParserPipelineFactory,
	ParserEnv = require('./mediawiki.parser.environment.js').MWParserEnvironment,
	ConvertDOMToLM = require('./mediawiki.LinearModelConverter.js').ConvertDOMToLM,
	WikitextSerializer = require('./mediawiki.WikitextSerializer.js').WikitextSerializer,
	optimist = require('optimist'),
	html5 = require('html5');

( function() {
	var default_mode_str = "Default conversion mode : --wt2html";
	var opts = optimist.usage( 'Usage: echo wikitext | $0 [options]\n\n' + default_mode_str, {
		'help': {
			description: 'Show this message',
			'boolean': true,
			'default': false
		},
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
		'linearmodel': {
			description: 'Output linear model data instead of HTML',
			'boolean': true,
			'default': false
		},
		'debug': {
			description: 'Debug mode',
			'boolean': true,
			'default': false
		},
		'trace': {
			description: 'Trace mode (light debugging), implied by --debug',
			'boolean': true,
			'default': false
		},
		'maxdepth': {
			description: 'Maximum expansion depth',
			'boolean': false,
			'default': 40
		},
		'wgScript': {
			description: 'http path to remote API, e.g. http://wiki.sample.com/w',
			'boolean': false,
			'default': 'http://en.wikipedia.org/w'
		},
		'wgScriptPath': {
			description: 'http path to remote web interface, e.g. http://wiki.sample.com/wiki',
			'boolean': false,
			'default': 'http://en.wikipedia.org/wiki/'
		},
		'wgScriptExtension': {
			description: 'Extension for PHP files on remote API server, if any. Include the period, e.g. ".php"',
			'boolean': false,
			'default': '.php'
		},
		'fetchTemplates': {
			description: 'Whether to fetch included templates recursively',
			'boolean': true,
			'default': true
		},
		'pagename': {
			description: 'The page name, returned for {{PAGENAME}}.',
			'boolean': false,
			'default': 'Main page'
		}
	});

	var argv = opts.argv;

	if ( argv.help ) {
		optimist.showHelp();
		return;
	}

	// Default conversion mode
	if (!argv.html2wt && !argv.wt2wt && !argv.html2html) {
		argv.wt2html = true;
	}

	var env = new ParserEnv({
		// fetch templates from enwiki by default.
		wgScript: argv.wgScript,
		wgScriptPath: argv.wgScriptPath,
		wgScriptExtension: argv.wgScriptExtension,
		// XXX: add options for this!
		wgUploadPath: 'http://upload.wikimedia.org/wikipedia/commons',
		fetchTemplates: argv.fetchTemplates,
		debug: argv.debug,
		trace: argv.trace,
		maxDepth: argv.maxdepth,
		pageName: argv.pagename
	});

	// Init parsers, serializers, etc.
	var parserPipeline,
	    serializer,
		htmlparser = new html5.Parser();
	if (!argv.html2wt) {
		var parserPipelineFactory = new ParserPipelineFactory(env);
		parserPipeline = parserPipelineFactory.makePipeline('text/x-mediawiki/full');
	}
	if (!argv.wt2html) {
		serializer = new WikitextSerializer({env: env});
	}

	var stdin = process.stdin,
	    stdout = process.stdout,
	    inputChunks = [];

	// collect input
	stdin.resume();
	stdin.setEncoding('utf8');
	stdin.on( 'data', function( chunk ) {
		inputChunks.push( chunk );
	} );

	// process input
	stdin.on( 'end', function() {
		var input = inputChunks.join('');
		if (argv.html2wt || argv.html2html) {
			htmlparser.parse('<html><body>' + input.replace(/\r/g, '') + '</body></html>');
			var content = htmlparser.tree.document.childNodes[0].childNodes[1];
			var wt = serializer.serializeDOM(content);

			env.text = wt;
			if (argv.html2wt) {
				// add a trailing newline for shell user's benefit
				stdout.write(wt);
				stdout.write("\n");
			} else {
				parserPipeline.on('document', function(document) {
					stdout.write( document.body.innerHTML );
				});
				parserPipeline.process(wt);
			}

			process.exit(0);
		} else {
			parserPipeline.on('document', function ( document ) {
				var res;
				if (argv.wt2html) {
					res = document.body.innerHTML;
				} else if (argv.wt2wt) {
					res = serializer.serializeDOM(document.body);
				} else { // linear model
					res = JSON.stringify( ConvertDOMToLM( document.body ), null, 2 );
				}

				// add a trailing newline for shell user's benefit
				stdout.write(res);
				stdout.write("\n");
				process.exit(0);
			});

			// Kick off the pipeline by feeding the input into the parser pipeline
			env.text = input;
			parserPipeline.process( input );
		}
	} );

} )();
