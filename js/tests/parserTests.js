/**
 * Initial parser tests runner for experimental JS parser
 *
 * This pulls all the parserTests.txt items and runs them through the JS
 * parser and JS HTML renderer.
 *
 * @author Brion Vibber <brion@pobox.com>
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 * @author Neil Kandalgaonkar <neilk@wikimedia.org>
 */

(function() {

console.log( "Starting up JS parser tests" );

var fs = require('fs'),
	path = require('path'),
	jsDiff = require('diff'),
	colors = require('colors'),
	util = require( 'util' ),
	jsdom = require( 'jsdom' ),
	HTML5 = require('html5').HTML5,  //TODO is this fixup for tests only, or part of real parsing...
	PEG = require('pegjs'),
	// Handle options/arguments with optimist module
	optimist = require('optimist');

// track files imported / required
var fileDependencies = [];

// Fetch up some of our wacky parser bits...

var mp = '../lib/',
	ParserPipelineFactory = require(mp + 'mediawiki.parser.js').ParserPipelineFactory,
	MWParserEnvironment = require(mp + 'mediawiki.parser.environment.js').MWParserEnvironment,
	WikitextSerializer = require(mp + 'mediawiki.WikitextSerializer.js').WikitextSerializer,
	TemplateRequest = require(mp + 'mediawiki.ApiRequest.js').TemplateRequest;

// For now most modules only need this for $.extend and $.each :)
global.$ = require('jquery');

var pj = path.join;

// Our code...

var testWhiteList = require(__dirname + '/parserTests-whitelist.js').testWhiteList;

function ParserTests () {
	this.cache_file = "parserTests.cache"; // Name of file used to cache the parser tests cases
	this.parser_tests_file = "parserTests.txt";
	var default_args = ["Default tests-file: " + this.parser_tests_file,
	                    "Default options   : --wt2html --whitelist --color"];
	this.argv = optimist.usage( 'Usage: $0 [options] [tests-file]\n\n' + default_args.join("\n"), {
		'help': {
			description: 'Show this help message',
			alias: 'h'
		},
		'wt2html': {
			description: 'Wikitext -> HTML(DOM)',
			'default': false,
			'boolean': true
		},
		'html2wt': {
			description: 'HTML(DOM) -> Wikitext',
			'default': false,
			'boolean': true
		},
		'wt2wt': {
			description: 'Roundtrip testing: Wikitext -> DOM(HTML) -> Wikitext',
			'default': false,
			'boolean': true
		},
		'html2html': {
			description: 'Roundtrip testing: HTML(DOM) -> Wikitext -> HTML(DOM)',
			'default': false,
			'boolean': true
		},
		'cache': {
			description: 'Get tests cases from cache file ' + this.cache_file,
			'boolean': true,
			'default': false
		},
		'filter': {
			description: 'Only run tests whose descriptions which match given regex',
			alias: 'regex'
		},
		'disabled': {
			description: 'Run disabled tests (option not implemented)',
			'default': false,
			'boolean': true
		},
		'maxtests': {
			description: 'Maximum number of tests to run',
			'boolean': false
		},
		'quick': {
			description: 'Suppress diff output of failed tests',
			'boolean': true,
			'default': false
		},
		'quiet': {
			description: 'Suppress notification of passed tests (shows only failed tests)',
			'boolean': true,
			'default': false
		},
		'whitelist': {
			description: 'Compare against manually verified parser output from whitelist',
			'default': true,
			'boolean': true
		},
		'printwhitelist': {
			description: 'Print out a whitelist entry for failing tests. Default false.',
			'default': false,
			'boolean': true
		},
		'color': {
			description: 'Enable color output Ex: --no-color',
			'boolean': true,
			'default': true
		},
		'debug': {
			description: 'Print debugging information',
			'default': false,
			'boolean': true
		},
		'trace': {
			description: 'Print trace information (light debugging)',
			'default': false,
			'boolean': true
		}
	}).check( function(argv) {
		if( argv.filter === true ) {
			throw "--filter need an argument";
		}
	}).argv; // keep that

	var argv = this.argv;
	if( argv.help ) {
		optimist.showHelp();
		process.exit( 0 );
	}

	// Default
	if (!argv.html2wt && !argv.html2html && !argv.wt2wt) {
		argv.wt2html = true;
	}

	this.test_filter = null;
	if( argv.filter ) { // null is the 'default' by definition
		try {
			this.test_filter = new RegExp( argv.filter );
		} catch(e) {
			console.error( "\nERROR> --filter was given an invalid regular expression.");
			console.error( "ERROR> See below for JS engine error:\n" + e + "\n" );
			process.exit( 1 );
		}
		console.log( "Filtering title test using Regexp " + this.test_filter );
	}
	if( !argv.color ) {
		colors.mode = 'none';
	}

	// Identify tests file
	if (argv._[0]) {
		this.testFileName = argv._[0] ;
	} else {
		this.testFileName = __dirname+'/' + this.parser_tests_file;
	}

	try {
		this.testParser = PEG.buildParser(fs.readFileSync(__dirname+'/parserTests.pegjs', 'utf8'));
	} catch (e2) {
		console.log(e2);
	}

	this.cases = this.getTests() || [];

	if ( argv.maxtests ) {
		var n = Number(argv.maxtests);
		console.warn('maxtests:' + n );
		if(n > 0) {
			this.cases.length = n;
		}
	}

	this.articles = {};

	// Test statistics
	this.passedTests = 0;
	this.passedTestsManual = 0;
	this.failParseTests = 0;
	this.failTreeTests = 0;
	this.failOutputTests = 0;

	// Create a new parser environment
	this.env = new MWParserEnvironment({
		fetchTemplates: false,
		debug: argv.debug,
		trace: argv.trace,
		wgUploadPath: 'http://example.com/images'
	});

	// Create parsers, serializers, ..
	this.htmlparser = new HTML5.Parser();
	if (!argv.html2wt) {
		var parserPipelineFactory = new ParserPipelineFactory( this.env );
		this.parserPipeline = parserPipelineFactory.makePipeline( 'text/x-mediawiki/full' );
	}
	if (!argv.wt2html) {
		this.serializer = new WikitextSerializer({env: this.env});
	}
}

/**
 * Get an object holding our tests cases. Eventually from a cache file
 */
ParserTests.prototype.getTests = function () {

	// Startup by loading .txt test file
	var testFile;
	try {
		testFile = fs.readFileSync(this.testFileName, 'utf8');
		fileDependencies.push( this.testFileName );
	} catch (e) {
		console.log( e );
	}
	if( !this.argv.cache ) {
		// Cache not wanted, parse file and return object
		return this.parseTestCase( testFile );
	}

	// Find out modification time of all files depencies and then hashes those
	// as a unique value using sha1.
	var mtimes = '';
	fileDependencies.sort().forEach( function (file) {
		mtimes += fs.statSync( file ).mtime;
	});
	var sha1 = require('crypto').createHash('sha1')
		.update( mtimes ).digest( 'hex' );

	// Look for a cache_file
	var cache_content;
	var cache_file_digest;
	try {
		console.log( "Looking for cache file " + this.cache_file );
		cache_content = fs.readFileSync( this.cache_file, 'utf8' );
		// Fetch previous digest
		cache_file_digest = cache_content.match( /^CACHE: (\w+)\n/ )[1];
	} catch( e4 ) {
		// cache file does not exist
	}

	if( cache_file_digest === sha1 ) {
		// cache file match our digest.
		console.log( "Loaded tests cases from cache file" );
		// Return contained object after removing first line (CACHE: <sha1>)
		return JSON.parse( cache_content.replace( /.*\n/, '' ) );
	} else {
		// Write new file cache, content preprended with current digest
		console.log( "Cache file either inexistant or outdated" );
		var parse = this.parseTestCase( testFile );
		if ( parse !== undefined ) {
			console.log( "Writing parse result to " + this.cache_file );
			fs.writeFileSync( this.cache_file,
				"CACHE: " + sha1 + "\n" + JSON.stringify( parse ),
				'utf8'
			);
		}
		// We can now return the parsed object
		return parse;
	}
};

/**
 * Parse given tests cases given as plaintext
 */
ParserTests.prototype.parseTestCase = function ( content ) {
	console.log( "Parsing tests case from file, this takes a few seconds ..." );
	try {
		console.log( "Done parsing." );
		return this.testParser.parse(content);
	} catch (e) {
		console.log(e);
	}
	return undefined;
};

ParserTests.prototype.processArticle = function( index, item ) {
	var norm = this.env.normalizeTitle(item.title);
	//console.log( 'processArticle ' + norm );
	this.articles[norm] = item.text;
	process.nextTick( this.processCase.bind( this, index + 1 ) );
};

/* Normalize the expected parser output by parsing it using a HTML5 parser and
 * re-serializing it to HTML. Ideally, the parser would normalize inter-tag
 * whitespace for us. For now, we fake that by simply stripping all newlines.
 */
ParserTests.prototype.normalizeHTML = function (source) {
	// TODO: Do not strip newlines in pre and nowiki blocks!
	source = source.replace(/[\r\n]/g, '');
	try {
		this.htmlparser.parse('<body>' + source + '</body>');
		return this.htmlparser.document.childNodes[0].childNodes[1]
			.innerHTML
			// a few things we ignore for now..
			//.replace(/\/wiki\/Main_Page/g, 'Main Page')
			// do not expect a toc for now
			.replace(/<table[^>]+?id="toc"[^>]*>.+?<\/table>/mg, '')
			// do not expect section editing for now
			.replace(/(<span class="editsection">\[.*?<\/span> *)?<span[^>]+class="mw-headline"[^>]*>(.*?)<\/span>/g, '$2')
			// general class and titles, typically on links
			.replace(/(title|class|rel)="[^"]+"/g, '')
			// strip red link markup, we do not check if a page exists yet
			.replace(/\/index.php\?title=([^']+?)&amp;action=edit&amp;redlink=1/g, '/wiki/$1')
			// the expected html has some extra space in tags, strip it
			.replace(/<a +href/g, '<a href')
			.replace(/" +>/g, '">');
	} catch(e) {
        console.log("normalizeHTML failed on" +
				source + " with the following error: " + e);
		console.trace();
		return source;
	}
		
};

// Specialized normalization of the wiki parser output, mostly to ignore a few
// known-ok differences.
ParserTests.prototype.normalizeOut = function ( out ) {
	// TODO: Do not strip newlines in pre and nowiki blocks!
	return out
		.replace(/<span typeof="mw:(?:(?:Placeholder|Nowiki))"[^>]*>((?:[^<]+|(?!<\/span).)*)<\/span>/g, '$1')
		.replace(/[\r\n]| (data-parsoid|typeof|resource|rel|prefix|about|rev|datatype|inlist|property|vocab|content)="[^">]*"/g, '')
		.replace(/<!--.*?-->\n?/gm, '')
		.replace(/<\/?meta[^>]*>/g, '');
};

ParserTests.prototype.formatHTML = function ( source ) {
	// Quick hack to insert newlines before some block level start tags
	return source.replace(
		/(?!^)<((div|dd|dt|li|p|table|tr|td|tbody|dl|ol|ul|h1|h2|h3|h4|h5|h6)[^>]*)>/g, '\n<$1>');
};

ParserTests.prototype.printTitle = function( item, failure_only ) {
	if( failure_only ) {
		console.log('FAILED'.red + ': ' + item.title.yellow);
		return;
	}
	console.log('=====================================================');
	console.log('FAILED'.red + ': ' + item.title.yellow);
	console.log(item.comments.join('\n'));
	if (item.options) {
		console.log("OPTIONS".cyan + ":");
		console.log(item.options + '\n');
	}
	console.log("INPUT".cyan + ":");
	console.log((this.argv.html2wt || this.argv.html2html) ? item.result : item.input + "\n");
};

ParserTests.prototype.convertHtml2Wt = function(index, item, processWikitextCB, doc) {
	var content = this.argv.wt2wt ? doc.body : doc;
	try {
		processWikitextCB(this.serializer.serializeDOM(content));
	} catch (e) {
		processWikitextCB(null, e);
	}
};

ParserTests.prototype.convertWt2Html = function(index, item, processHtmlCB, wikitext, error) {
	if (error) {
		console.error("ERROR: " + error);
		return;
	}
	this.parserPipeline.once('document', processHtmlCB);
	this.parserPipeline.process(wikitext);
};

ParserTests.prototype.processTest = function ( index, item ) {
	if (!('title' in item)) {
		console.log(item);
		throw new Error('Missing title from test case.');
	}
	if (!('input' in item)) {
		console.log(item);
		throw new Error('Missing input from test case ' + item.title);
	}
	if (!('result' in item)) {
		console.log(item);
		throw new Error('Missing input from test case ' + item.title);
	}

	var cb, cb2;
	if (this.argv.wt2html || this.argv.wt2wt) {
		if (this.argv.wt2wt) {
			// insert an additional step in the callback chain
			// if we are roundtripping
			cb2 = this.processSerializedWT.bind(this, index, item);
			cb = this.convertHtml2Wt.bind(this, index, item, cb2);
		} else {
			cb = this.processParsedHTML.bind(this, index, item);
		}

		this.convertWt2Html(index, item, cb, item.input);
	} else {
		if (this.argv.html2html) {
			// insert an additional step in the callback chain
			// if we are roundtripping
			cb2 = this.processParsedHTML.bind(this, index, item);
			cb = this.convertWt2Html.bind(this, index, item, cb2);
		} else {
			cb = this.processSerializedWT.bind(this, index, item);
		}

		this.htmlparser.parse( '<html><body>' + item.result + '</body></html>');
		this.convertHtml2Wt(index, item, cb, this.htmlparser.tree.document.childNodes[0].childNodes[1]);
	}
};

ParserTests.prototype.processParsedHTML = function(index, item, doc) {
	if (doc.err) {
		this.printTitle(item);
		this.failParseTests++;
		console.log('PARSE FAIL', doc.err);
	} else {
		// Check the result vs. the expected result.
		this.checkHTML( item, doc.body.innerHTML );
	}

	// Now schedule the next test, if any
	process.nextTick( this.processCase.bind( this, index + 1 ) );
};

ParserTests.prototype.processSerializedWT = function(index, item, wikitext, error) {
	if (error) {
		this.printTitle(item);
		this.failParseTests++;
		console.log('SERIALIZE FAIL', error);
	} else {
		// Check the result vs. the expected result.
		this.checkWikitext(item, wikitext);
	}

	// Now schedule the next test, if any
	process.nextTick( this.processCase.bind( this, index + 1 ) );
};

ParserTests.prototype.diff = function ( a, b ) {
	if ( this.argv.color ) {
		return jsDiff.diffWords( a, b ).map( function ( change ) {
			if ( change.added ) {
				return change.value.green;
			} else if ( change.removed ) {
				return change.value.red;
			} else {
				return change.value;
			}
		}).join('');
	} else {
		var patch = jsDiff.createPatch('wikitext.txt', a, b, 'before', 'after');

		console.log('DIFF'.cyan +': ');

		// Strip the header from the patch, we know how diffs work..
		patch = patch.replace(/^[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/, '');

		return patch.split( '\n' ).map( function(line) {
			// Add some colors to diff output
			switch( line.charAt(0) ) {
				case '-':
					return line.red;
				case '+':
					return line.blue;
				default:
					return line;
			}
		}).join( "\n" );
	}
};

ParserTests.prototype.checkHTML = function ( item, out ) {
	var normalizedOut = this.normalizeOut(out);
	var normalizedExpected = this.normalizeHTML(item.result);
	if ( normalizedOut !== normalizedExpected ) {
		if (this.argv.whitelist &&
				item.title in testWhiteList &&
				this.normalizeOut(testWhiteList[item.title]) ===  normalizedOut) {
					if( !this.argv.quiet ) {
						console.log( 'PASSED (whiteList)'.green + ': ' + item.title.yellow );
					}
					this.passedTestsManual++;
					return;
				}
		this.printTitle( item, this.argv.quick );
		this.failOutputTests++;

		if( !this.argv.quick ) {
			console.log('RAW EXPECTED'.cyan + ':');
			console.log(item.result + "\n");

			console.log('RAW RENDERED'.cyan + ':');
			console.log(this.formatHTML(out) + "\n");

			var a = this.formatHTML(normalizedExpected);

			console.log('NORMALIZED EXPECTED'.magenta + ':');
			console.log(a + "\n");

			var b = this.formatHTML(normalizedOut);

			console.log('NORMALIZED RENDERED'.magenta + ':');
			console.log(this.formatHTML(this.normalizeOut(out)) + "\n");

			console.log('DIFF'.cyan +': ');

			var colored_diff = this.diff( a, b );
			console.log( colored_diff );

			if(this.argv.printwhitelist) {
				console.log("WHITELIST ENTRY:".cyan);
				console.log("testWhiteList[" +
						JSON.stringify(item.title) + "] = " +
						JSON.stringify(out) +
						";\n");
			}
		}
	} else {
		this.passedTests++;
		if( !this.argv.quiet ) {
			console.log( 'PASSED'.green + ': ' + item.title.yellow );
		}
	}
};

ParserTests.prototype.checkWikitext = function ( item, out) {
	// FIXME: normalization not in place yet
	var normalizedOut = this.argv.html2wt ? out.replace(/\n+$/, '') : out;

	// FIXME: normalization not in place yet
	var normalizedExpected = this.argv.html2wt ? item.input.replace(/\n+$/, '') : item.input;

	if ( normalizedOut !== normalizedExpected ) {
		this.printTitle( item, this.argv.quick );
		this.failOutputTests++;

		if( !this.argv.quick ) {
			console.log('RAW EXPECTED'.cyan + ':');
			console.log(item.input + "\n");

			console.log('RAW RENDERED'.cyan + ':');
			console.log(out + "\n");

			console.log('NORMALIZED EXPECTED'.magenta + ':');
			console.log(normalizedExpected + "\n");

			console.log('NORMALIZED RENDERED'.magenta + ':');
			console.log(normalizedOut + "\n");
			console.log('DIFF'.cyan +': ');
			var colored_diff = this.diff ( normalizedExpected, normalizedOut );
			console.log( colored_diff );
		}
	} else {
		this.passedTests++;
		if( !this.argv.quiet ) {
			console.log( 'PASSED'.green + ': ' + item.title.yellow );
		}
	}
};

/**
 * Print out a WikiDom conversion of the HTML DOM
 */
ParserTests.prototype.printWikiDom = function ( body ) {
	console.log('WikiDom'.cyan + ':');
	console.log( body );
};

/**
 * Colorize given number if <> 0
 *
 * @param count Integer: a number to colorize
 * @param color String: 'green' or 'red'
 */
ParserTests.prototype.ColorizeCount = function ( count, color ) {
	if( count === 0 ) {
		return count;
	}

	// We need a string to use colors methods
	count = count.toString();
	// FIXME there must be a wait to call a method by its name
	switch( color ) {
		case 'green': return count.green;
		case 'red':   return count.red;

		default:      return count;
	}
};

ParserTests.prototype.reportSummary = function () {

	var failTotalTests = (this.failParseTests + this.failTreeTests +
			this.failOutputTests);

	console.log( "==========================================================");
	console.log( "SUMMARY: ");

	if( failTotalTests !== 0 ) {
		console.log( this.ColorizeCount( this.passedTests    , 'green' ) +
				" passed");
		console.log( this.ColorizeCount( this.passedTestsManual , 'green' ) +
				" passed from whitelist");
		console.log( this.ColorizeCount( this.failParseTests , 'red'   ) +
				" parse failures");
		console.log( this.ColorizeCount( this.failTreeTests  , 'red'   ) +
				" tree build failures");
		console.log( this.ColorizeCount( this.failOutputTests, 'red'   ) +
				" output differences");
		console.log( "\n" );
		console.log( this.ColorizeCount( this.passedTests + this.passedTestsManual , 'green'   ) +
				' total passed tests, ' +
				this.ColorizeCount( failTotalTests , 'red'   ) + " total failures");

	} else {
		if( this.test_filter !== null ) {
			console.log( "Passed " + ( this.passedTests + this.passedTestsManual ) +
					" of " + this.passedTests + " tests matching " + this.test_filter +
					"... " + "ALL TESTS PASSED!".green );
		} else {
			// Should not happen if it does: Champagne!
			console.log( "Passed " + this.passedTests + " of " + this.passedTests +
					" tests... " + "ALL TESTS PASSED!".green );
		}
	}
	console.log( "==========================================================");

};

ParserTests.prototype.main = function () {
	console.log( "Initialisation complete. Now launching tests." );
	this.env.pageCache = this.articles;
	this.comments = [];
	this.processCase( 0 );
};

ParserTests.prototype.processCase = function ( i ) {
	if ( i < this.cases.length ) {
		var item = this.cases[i];
		//console.log( 'processCase ' + i + JSON.stringify( item )  );
		if ( typeof item === 'object' ) {
			switch(item.type) {
				case 'article':
					this.comments = [];
					this.processArticle( i, item );
					break;
				case 'test':
					if( this.test_filter &&
						-1 === item.title.search( this.test_filter ) ) {
						// Skip test whose title does not match --filter
						process.nextTick( this.processCase.bind( this, i + 1 ) );
						break;
					}
					// Add comments to following test.
					item.comments = this.comments;
					this.comments = [];
					this.processTest( i, item );
					break;
				case 'comment':
					this.comments.push( item.comment );
					process.nextTick( this.processCase.bind( this, i + 1 ) );
					break;
				case 'hooks':
					console.warn('parserTests: Unhandled hook ' + JSON.stringify( item ) );
					break;
				case 'functionhooks':
					console.warn('parserTests: Unhandled functionhook ' + JSON.stringify( item ) );
					break;
				default:
					this.comments = [];
					process.nextTick( this.processCase.bind( this, i + 1 ) );
					break;
			}
		} else {
			process.nextTick( this.processCase.bind( this, i + 1 ) );
		}
	} else {
		// print out the summary
		this.reportSummary();
	}
};

// Construct the ParserTests object and run the parser tests
new ParserTests().main();

})();
