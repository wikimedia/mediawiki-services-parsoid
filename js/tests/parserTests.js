/**
 * Initial parser tests runner for experimental JS parser
 *
 * This pulls all the parserTests.txt items and runs them through the JS
 * parser and JS HTML renderer.
 */

(function() {

var fs = require('fs'),
	path = require('path'),
	jsDiff = require('diff'),
	colors = require('colors'),
	Util = require( '../lib/mediawiki.Util.js' ).Util,
	DOMUtils = require( '../lib/mediawiki.DOMUtils.js' ).DOMUtils,
	util = require( 'util' ),
	async = require( 'async' ),
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
	SelectiveSerializer = require( mp + 'mediawiki.SelectiveSerializer.js' ).SelectiveSerializer,
	ParsoidConfig = require( mp + 'mediawiki.ParsoidConfig' ).ParsoidConfig,
	TemplateRequest = require(mp + 'mediawiki.ApiRequest.js').TemplateRequest;

// For now most modules only need this for $.extend and $.each :)
global.$ = require(mp + 'fakejquery');

var pj = path.join;

// Our code...

/**
 * Colorize given number if <> 0
 *
 * @param count Integer: a number to colorize
 * @param color String: valid color for the colors library
 */
var colorizeCount = function ( count, color ) {
	if( count === 0 ) {
		return count;
	}

	// We need a string to use colors methods
	count = count.toString();

	// FIXME there must be a wait to call a method by its name
	if ( count[color] ) {
		return count[color];
	} else {
		return count;
	}
};

var testWhiteList = require(__dirname + '/parserTests-whitelist.js').testWhiteList,
	modes = ['wt2html', 'wt2wt', 'html2html', 'html2wt', 'selser'];

function ParserTests () {
	var i;

	this.cache_file = "parserTests.cache"; // Name of file used to cache the parser tests cases
	this.parser_tests_file = "parserTests.txt";
	this.tests_changes_file = 'changes.txt';

	this.articles = {};

	// Test statistics
	this.stats = {};
	this.stats.passedTests = 0;
	this.stats.passedTestsManual = 0;
	this.stats.failOutputTests = 0;
	var newModes = {};

	for ( i = 0; i < modes.length; i++ ) {
		newModes[modes[i]] = Util.clone( this.stats );
	}

	this.stats.modes = newModes;
}

var prettyPrintIOptions = function(iopts) {
	if (!iopts) { return ''; }
	var ppValue = function(v) {
		if ($.isArray(v)) {
			return v.map(ppValue).join(',');
		}
		if (/^\[\[[^\]]*\]\]$/.test(v) ||
		    /^[-\w]+$/.test(v)) {
			return v;
		}
		// the current PHP grammar doesn't provide for any way of
		// including the " character in a value, other than escaping
		// it using the [[ ... foo ... ]] syntax.  If we see a
		// double-quote in a value at this point, it means that
		// they've added some new fancy quoting scheme that we should
		// be handling here.  (Of course parserTests.pegjs probably
		// broke first.)
		console.assert(v.indexOf('"') < 0);
		return '"'+v+'"';
	};
	return Object.keys(iopts).map(function(k) {
		if (iopts[k]==='') { return k; }
		return k+'='+ppValue(iopts[k]);
	}).join(' ');
};

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

/**
 * Get the options from the command line.
 */
ParserTests.prototype.getOpts = function () {
	var default_args = ["Default tests-file: " + this.parser_tests_file,
	                    "Default options   : --wt2html --wt2wt --html2html --whitelist --color"];

	return optimist.usage( 'Usage: $0 [options] [tests-file]\n\n' + default_args.join("\n"), {
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
		'use_source': {
			description: 'Use original source in wt2wt tests',
			'boolean': true,
			'default': true
		},
		'html2html': {
			description: 'Roundtrip testing: HTML(DOM) -> Wikitext -> HTML(DOM)',
			'default': false,
			'boolean': true
		},
		'selser': {
			description: 'Roundtrip testing: Wikitext -> DOM(HTML) -> Wikitext (with selective serialization)',
			'default': false,
			'boolean': true
		},
		'changesout': {
			description: 'Output file for randomly-generated changes (only works if --selser is enabled too)',
			'default': null
		},
		'changesin': {
			description: 'Way to pass in non-random changes for tests. Use --changesout to generate a useful file for this purpose.',
			'default': null
		},
		'numchanges': {
			description: 'Make multiple different changes to the DOM, run a selser test for each one.',
			'default': 1,
			'boolean': false
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
		'run-disabled': {
			description: 'Run disabled tests',
			// this defaults to true because historically parsoid-only tests
			// were marked as 'disabled'.  Once these are all changed to
			// 'parsoid', this default should be changed to false.
			'default': true,
			'boolean': true
		},
		'run-php': {
			description: 'Run php-only tests',
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
		'trace [optional-flags]': {
			description: 'Same trace options as "parse.js" (See: node parse --help)',
			'default': false,
			'boolean': true
		},
		'dump <flags>': {
			description: 'Same dump options as "parse.js" (See: node parse --help)',
			'boolean': false,
			'default': ""
		},
		xml: {
			description: 'Print output in JUnit XML format.',
			'default': false,
			'boolean': true
		}
	}).check( function(argv) {
		if( argv.filter === true ) {
			throw "--filter need an argument";
		}
	}).argv; // keep that
};

/**
 * Get an object holding our tests cases. Eventually from a cache file
 */
ParserTests.prototype.getTests = function ( argv ) {

	// Startup by loading .txt test file
	var testFile;
	try {
		testFile = fs.readFileSync(this.testFileName, 'utf8');
		fileDependencies.push( this.testFileName );
	} catch (e) {
		console.error( e );
	}
	// parser grammar is also a dependency
	fileDependencies.push( this.testParserFileName );

	if( !booleanOption(argv.cache) ) {
		// Cache not wanted, parse file and return object
		return this.parseTestCase( testFile );
	}

	// Find out modification time of all files dependencies and then hash those
	// to make a unique value using sha1.
	var mtimes = fileDependencies.sort().map( function (file) {
		return fs.statSync( file ).mtime;
	}).join('|');

	var sha1 = require('crypto').createHash('sha1')
		.update( mtimes ).digest( 'hex' ),
		cache_file_name= __dirname + '/' + this.cache_file,
		// Look for a cache_file
		cache_content,
		cache_file_digest;
	try {
		cache_content = fs.readFileSync( cache_file_name, 'utf8' );
		// Fetch previous digest
		cache_file_digest = cache_content.match( /^CACHE: (\w+)\n/ )[1];
	} catch( e4 ) {
		// cache file does not exist
	}

	if( cache_file_digest === sha1 ) {
		// cache file match our digest.
		// Return contained object after removing first line (CACHE: <sha1>)
		return JSON.parse( cache_content.replace( /.*\n/, '' ) );
	} else {
		// Write new file cache, content preprended with current digest
		console.error( "Cache file either not present or outdated" );
		var parse = this.parseTestCase( testFile );
		if ( parse !== undefined ) {
			fs.writeFileSync( cache_file_name,
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
	try {
		return this.testParser.parse(content);
	} catch (e) {
		console.error(e);
	}
	return undefined;
};

ParserTests.prototype.processArticle = function( item, cb ) {
	var norm = this.env.normalizeTitle(item.title);
	//console.log( 'processArticle ' + norm );
	this.articles[norm] = item.text;
	process.nextTick( cb );
};

ParserTests.prototype.convertHtml2Wt = function( options, mode, item, doc, processWikitextCB ) {
	// In some cases (which?) the full document is passed in, but we are
	// interested in the body. So check if we got a document.
	var content = doc.nodeType === doc.DOCUMENT_NODE ? doc.body : doc,
		serializer = (mode === 'selser') ? new SelectiveSerializer({env: this.env})
										: new WikitextSerializer({env: this.env}),
		wt = '',
		changelist = [],
		waiting = 0,
		changesReturn,
		self = this,
		startsAtWikitext = mode === 'wt2wt' || mode === 'wt2html' || mode === 'selser';
	try {
		this.env.page.dom = item.cachedHTML || null;
		if ( mode === 'selser' ) {
			this.env.page.src = item.input;
			this.env.page.name = '';
			if ( options.changesin && item.changes === undefined ) {
				// A changesin option was passed, so set the changes to 0,
				// so we don't try to regenerate the changes.
				item.changes = 0;
			}
		} else if (booleanOption(options.use_source) && startsAtWikitext ) {
			this.env.page.src = item.input;
		} else {
			this.env.page.src = null;
		}
		serializer.serializeDOM( content, function ( res ) {
			wt += res;
		}, function () {
			processWikitextCB( null, wt );
			self.env.page.src = null;
			self.env.page.dom = null;
		} );
	} catch ( e ) {
		console.error(e.stack);
		processWikitextCB( e, null );
		this.env.page.src = null;
		this.env.page.dom = null;
	}
};

ParserTests.prototype.doesChangeExist = function ( changes, change ) {
	if ( !changes || changes.constructor !== Array ) {
		return false;
	}

	var i;
	for ( i = 0; i < changes.length; i++ ) {
		if ( Util.deepEquals( changes[i], change ) ) {
			return true;
		}
	}
	return false;
};

ParserTests.prototype.makeChanges = function ( item, content, changelist, cb ) {
	cb = cb || function () {};
	var initContent = content;

	if ( content.nodeType === content.DOCUMENT_NODE ) {
		content = content.body;
	}

	// Keep the changes in the item object in case of --changesout
	item.changes = item.changes || changelist;

	var changes = [
		'content',
		'rebuilt',
		'childrenRemoved',
		'attributes',
		'annotations'
	];

	// Helper function for getting a random change marker
	function getRandomChange() {
		var o = {};
		o[changes[Math.floor( Math.random() * changes.length )]] = 1;
		return o;
	}

	var node, change, nodes = Util.clone(content.childNodes);
	for ( var i = 0; i < changelist.length; i++ ) {
		node = nodes[i];
		change = changelist[i];
		if ( node && change && change.constructor === Array ) {
			this.makeChanges( item, node, change );
		} else if ( node && node.setAttribute && DOMUtils.isNodeEditable( this.env, node ) ) {
			switch ( change ) {
				case 1:
					node.setAttribute(
						'data-parsoid-changed',
						JSON.stringify( getRandomChange() ) );
					break;
				case 4:
					// One day we'll use this to change a node, but for now
					// it can bleed over into the "new" case.
				case 2:
					node.setAttribute(
						'data-parsoid-changed',
						JSON.stringify( { 'new': 1 } ) );
					break;
				case 3:
					// Delete this node!
					node.parentNode.removeChild( node );
					break;
				default:
					// Do nothing
					break;
			}
		}
	}

	cb( null, initContent );
};

ParserTests.prototype.generateChanges = function ( options, nonRandomChanges, item, content, cb ) {
	// This function won't actually change anything, but it will add change
	// markers to random elements.
	var child, i, changeObj, node, changelist = [], numAttempts = 0;

	var initContent = content;

	if ( content.nodeType === content.DOCUMENT_NODE ) {
		content = content.body;
	}

	var setChange = function ( err, nc, childChanges ) {
		if ( childChanges && childChanges.length ) {
			changeObj = childChanges;
		} else {
			changeObj = 0;
		}
	};

	item = item || {};

	do {
		node = content.cloneNode( true );
		changelist = [];

		for ( i = 0; i < node.childNodes.length; i++ ) {
			child = node.childNodes[i];

			if ( !child.setAttribute ) {
				if ( nonRandomChanges === undefined ) {
					changelist.push( 0 );
				}
				// This is probably a text node or comment node or something,
				// so we'll skip it in favor of something a little more
				// interesting.
				continue;
			}

			if ( nonRandomChanges === null) {
				if ( DOMUtils.isNodeEditable( this.env, child ) ) {
					if ( Math.random() < 0.5 ) {
						changeObj = Math.floor( Math.random() * 4 ) + 1;
					} else {
						this.generateChanges( options, null, null, child, setChange );
					}
				} else {
					changeObj = 0;
				}

				changelist.push( changeObj );
			} else {
				changelist = nonRandomChanges;
				break;
			}
		}
	} while ( nonRandomChanges === undefined &&
		this.doesChangeExist( item.otherChanges, changelist ) &&
		++numAttempts < 1000 );

	cb( null, content, changelist );
};

ParserTests.prototype.convertWt2Html = function( mode, wikitext, processHtmlCB ) {
	try {
		this.parserPipeline.once( 'document', function ( doc ) {
			// processHtmlCB can be asynchronous, so deep-clone
			// document before invoking it. (the parser pipeline
			// will attempt to reuse the document after this
			// event is emitted)
			processHtmlCB( null, doc.body.cloneNode(true) );
		} );
	} catch ( e ) {
		processHtmlCB( e );
	}
	this.env.page.src = wikitext;
	this.parserPipeline.process( wikitext );
};

/**
 * Process a single test.
 *
 * @arg item {object} this.cases[index]
 * @arg options {object} The options for this test.
 * @arg endCb {function} The callback function we should call when this test is done.
 */
ParserTests.prototype.processTest = function ( item, options, mode, endCb ) {
	if ( !( 'title' in item ) ) {
		console.error( item );
		throw new Error( 'Missing title from test case.' );
	}
	if ( !( 'input' in item ) ) {
		console.error( item );
		throw new Error( 'Missing input from test case ' + item.title );
	}
	if ( !( 'result' in item ) ) {
		console.error( item );
		throw new Error( 'Missing input from test case ' + item.title );
	}

	item.time = {};

	// Build a list of tasks for this test that will be passed to async.waterfall
	var finishHandler = function ( err, res ) {
		if ( err ) {
			options.reportFailure(
				item.title, item.comments, item.options,
				options, null, null, true, mode, err, item );
		}
		process.nextTick( endCb );
	};

	var testTasks = [];

	// Some useful booleans
	var startsAtWikitext = mode === 'wt2wt' || mode === 'wt2html' || mode === 'selser',
		startsAtHtml = mode === 'html2html' || mode === 'html2wt',
		endsAtWikitext = mode === 'wt2wt' || mode === 'selser' || mode === 'html2wt',
		endsAtHtml = mode === 'wt2html' || mode === 'html2html';

	// Source preparation stage
	if ( startsAtHtml ) {
		if ( item.cachedSourceHTML === null ) {
			testTasks.push( function ( cb ) {
				cb( null, Util.parseHTML( '<html><body>' + item.result + '</body></html>' )
					.body );
			} );
		} else {
			testTasks.push( function ( cb ) {
				cb( null, item.cachedSourceHTML.cloneNode( true ) );
			} );
		}
	}

	// Caching stage 0 - save the result of the first stage so we can maybe skip it later
	if ( startsAtHtml ) {
		testTasks.push( function ( result, cb ) {
			if ( startsAtHtml && item.cachedSourceHTML === null ) {
				// Cache source HTML
				item.cachedSourceHTML = result.cloneNode( true );
			}

			cb( null, result );
		} );
	}

	// First conversion stage
	if ( startsAtWikitext ) {
		if ( item.cachedHTML === null ) {
			testTasks.push( this.convertWt2Html.bind( this, mode, item.input ) );
		} else {
			testTasks.push( function ( cb ) {
				cb( null, item.cachedHTML.cloneNode( true ) );
			} );
		}
	} else if ( startsAtHtml ) {
		testTasks.push(	this.convertHtml2Wt.bind( this, options, mode, item	) );
	}

	// Caching stage 1 - save the result of the first two stages so we can maybe skip them later
	testTasks.push( function ( result, cb ) {
		if ( startsAtWikitext && item.cachedHTML === null ) {
			// Cache parsed HTML
			item.cachedHTML = result.cloneNode( true );
		}

		cb( null, result );
	} );

	// Generate and make changes for the selser test mode
	if ( mode === 'selser' ) {
		if ( item.changes === undefined ) {
			// Make sure we set this to the *right* falsy value.
			item.changes = null;
		}

		testTasks.push( this.generateChanges.bind( this, options, item.changes, item ) );
		testTasks.push( this.makeChanges.bind( this, item ) );

		// Save the modified DOM so we can re-test it later
		testTasks.push( function ( doc, cb ) {
			item.changedHTML = doc.cloneNode( true );
			cb( null, doc );
		} );
	}

	// Roundtrip stage
	if ( mode === 'wt2wt' || mode === 'selser' ) {
		testTasks.push( this.convertHtml2Wt.bind( this, options, mode, item ) );
	} else if ( mode === 'html2html' ) {
		testTasks.push( this.convertWt2Html.bind( this, mode ) );
	}

	// Processing stage
	if ( endsAtWikitext ) {
		testTasks.push( this.processSerializedWT.bind( this, item, options, mode ) );
	} else if ( endsAtHtml ) {
		testTasks.push( this.processParsedHTML.bind( this, item, options, mode ) );
	}

	item.time.start = Date.now();
	async.waterfall( testTasks, finishHandler );
};

/**
 * Process the results of a test that produces HTML.
 *
 * @arg item {object} this.cases[index]
 * @arg options {object} The options for this test.
 * @arg cb {function} The callback function we should call when this test is done.
 * @arg doc {object} The results of the parse.
 */
ParserTests.prototype.processParsedHTML = function( item, options, mode, doc, cb ) {
	item.time.end = Date.now();
	// Check the result vs. the expected result.
	this.checkHTML( item, doc.innerHTML, options, mode );

	// Now schedule the next test, if any
	process.nextTick( cb );
};

/**
 * Process the results of a test that produces wikitext.
 *
 * @arg item {object} this.cases[index]
 * @arg options {object} The options for this test.
 * @arg cb {function} The callback function we should call when this test is done.
 * @arg wikitext {string} The results of the parse.
 * @arg error {string} The results of the parse.
 */
ParserTests.prototype.processSerializedWT = function ( item, options, mode, wikitext, cb ) {
	item.time.end = Date.now();

	if ( mode === 'selser' ) {
		this.convertHtml2Wt( options, 'wt2wt', item, item.changedHTML.cloneNode( true ), function ( err, wt ) {
			if ( err === null ) {
				item.resultWT = wt;
			} else {
				item.resultWT = item.input;
			}
		} );
	}

	// Check the result vs. the expected result.
	this.checkWikitext( item, wikitext, options, mode );

	// Now schedule the next test, if any
	process.nextTick( cb );
};

/**
 * Print a failure message for a test.
 *
 * @arg title {string} The title of the test
 * @arg comments {Array} Any comments associated with the test
 * @arg iopts {object|null} Options from the test file
 * @arg options {object} Options for the test environment (usually a copy of argv)
 * @arg actual {object} The actual results (see printResult for more)
 * @arg expected {object} The expected results (see printResult for more)
 * @arg failure_only {bool} Whether we should print only a failure message, or go on to print the diff
 * @arg mode {string} The mode we're in (wt2wt, wt2html, html2wt, or html2html)
 */
ParserTests.prototype.printFailure = function ( title, comments, iopts, options,
		actual, expected, failure_only, mode, error, item ) {
	this.stats.failOutputTests++;
	this.stats.modes[mode].failOutputTests++;

	if ( !failure_only ) {
		console.log( '=====================================================' );
	}

	console.log( 'FAILED'.red + ': ' + ( title + ( mode ? ( ' (' + mode + ')' ) : '' ) ).yellow );

	if ( mode === 'selser' ) {
		if ( item.wt2wtPassed ) {
			console.log( 'Even worse, the normal roundtrip test passed!'.red );
		} else if ( actual && item.wt2wtResult !== actual.raw ) {
			console.log( 'Even worse, the normal roundtrip test had a different result!'.red );
		}
	}

	if ( !failure_only && !error ) {
		console.log( comments.join('\n') );

		if ( options ) {
			console.log( 'OPTIONS'.cyan + ':' );
			console.log( prettyPrintIOptions(iopts) + '\n' );
		}

		console.log( 'INPUT'.cyan + ':' );
		console.log( actual.input + '\n' );

		console.log( options.getActualExpected( actual, expected, options.getDiff, booleanOption( options.color ) ) );

		if ( booleanOption( options.printwhitelist )  ) {
			this.printWhitelistEntry( title, actual.raw );
		}
	} else if ( !failure_only && error ) {
		// The error object exists, which means
		// there was an error! gwicke said it wouldn't happen, but handle
		// it anyway, just in case.
		console.log( '\nBECAUSE THERE WAS AN ERROR:\n'.red );
		console.log( error.stack || error.toString() );
	}
};

/**
 * Print a success method for a test.
 *
 * This method is configurable through the options of the ParserTests object.
 *
 * @arg title {string} The title of the test
 * @arg mode {string} The mode we're in (wt2wt, wt2html, html2wt, or html2html)
 * @arg isWhitelist {bool} Whether this success was due to a whitelisting
 * @arg shouldReport {bool} Whether we should actually output this result, or just count it
 */
ParserTests.prototype.printSuccess = function ( title, mode, isWhitelist, shouldReport ) {
	if ( isWhitelist ) {
		this.stats.passedTestsManual++;
		this.stats.modes[mode].passedTestsManual++;
	} else {
		this.stats.passedTests++;
		this.stats.modes[mode].passedTests++;
	}
	if( !shouldReport ) {
		var outStr = 'PASSED';

		if ( isWhitelist ) {
			outStr += ' (whitelist)';
		}

		outStr = outStr.green + ': ';

		outStr += ( title + ' (' + mode + ')' ).yellow;

		console.log( outStr );
	}
};

/**
 * Print the actual and expected outputs.
 *
 * @arg actual {object} Actual output from the parser. Contains 'raw' and 'normal', the output in different formats
 * @arg expected {object} Expected output for this test. Contains 'raw' and 'normal' as above.
 * @arg getDiff {function} The function we use to get the diff for output (if any)
 * @arg color {bool} Whether we should output colorful strings or not.
 *
 * Side effect: Both objects will, after this, have 'formattedRaw' and 'formattedNormal' properties,
 * which are the result of calling Util.formatHTML() on the 'raw' and 'normal' properties.
 */
ParserTests.prototype.getActualExpected = function ( actual, expected, getDiff, color ) {
	var returnStr = '';
	expected.formattedRaw = expected.isWT ? expected.raw : Util.formatHTML( expected.raw );
	returnStr += ( color ? 'RAW EXPECTED'.cyan : 'RAW EXPECTED' ) + ':';
	returnStr += expected.formattedRaw + '\n';

	actual.formattedRaw = actual.isWT ? actual.raw : Util.formatHTML( actual.raw );
	returnStr += ( color ? 'RAW RENDERED'.cyan : 'RAW RENDERED' ) + ':';
	returnStr += actual.formattedRaw + '\n';

	expected.formattedNormal = expected.isWT ? expected.normal : Util.formatHTML( expected.normal );
	returnStr += ( color ? 'NORMALIZED EXPECTED'.magenta : 'NORMALIZED EXPECTED' ) + ':';
	returnStr += expected.formattedNormal + '\n';

	actual.formattedNormal = actual.isWT ? actual.normal : Util.formatHTML( actual.normal );
	returnStr += ( color ? 'NORMALIZED RENDERED'.magenta : 'NORMALIZED RENDERED' ) + ':';
	returnStr += actual.formattedNormal + '\n';

	returnStr += ( color ? 'DIFF'.cyan : 'DIFF' ) + ': \n';
	returnStr += getDiff( actual, expected, color );

	return returnStr;
};

/**
 * Print the diff between the actual and expected outputs.
 *
 * @arg actual {object} Actual output from the parser. Contains 'formattedNormal', a side effect from 'getActualExpected' above.
 * @arg expected {object} Expected output for this test. Contains 'formattedNormal' as above.
 * @arg color {bool} Do you want color in the diff output?
 */
ParserTests.prototype.getDiff = function ( actual, expected, color ) {
	return Util.diff( expected.formattedNormal, actual.formattedNormal, color );
};

/**
 * Print the whitelist entry for a test.
 *
 * @arg title {string} The title of the test.
 * @arg raw {string} The actual raw output from the parser.
 */
ParserTests.prototype.printWhitelistEntry = function ( title, raw ) {
	console.log( 'WHITELIST ENTRY:'.cyan);
	console.log( 'testWhiteList[' +
		JSON.stringify( title ) + '] = ' +
		JSON.stringify( raw ) + ';\n' );
};

/**
 * Print the result of a test.
 *
 * @arg title {string} The title of the test
 * @arg time {object} The times for the test--an object with 'start' and 'end' in milliseconds since epoch.
 * @arg comments {Array} Any comments associated with the test
 * @arg iopts {object|null} Any options for the test (not options passed into the process)
 * @arg expected {object} Expected output for this test. Contains 'raw' and 'normal' as above.
 * @arg actual {object} Actual output from the parser. Contains 'raw' and 'normal', the output in different formats
 * @arg options {object} Options for the test runner. Usually just a copy of argv.
 * @arg mode {string} The mode we're in (wt2wt, wt2html, html2wt, or html2html)
 */
ParserTests.prototype.printResult = function ( title, time, comments, iopts, expected, actual, options, mode, item ) {
	var quick = booleanOption( options.quick );
	var quiet = booleanOption( options.quiet );
	if ( mode === 'selser' ) {
		title += ' ' + JSON.stringify( item.changes );
	}

	if ( expected.normal !== actual.normal ) {
		if ( booleanOption( options.whitelist ) && title in testWhiteList &&
			Util.normalizeOut( testWhiteList[title] ) ===  actual.normal ) {
			options.reportSuccess( title, mode, true, quiet );
			return;
		}

		item.wt2wtResult = actual.raw;

		options.reportFailure( title, comments, iopts, options, actual, expected, quick, mode, null, item );
	} else {
		if ( mode === 'wt2wt' ) {
			item.wt2wtPassed = true;
		}
		options.reportSuccess( title, mode, false, quiet );
	}
};

/**
 * Check the result of a "2html" operation.
 *
 * @arg item {object} The test being run.
 * @arg out {string} The actual output of the parser.
 * @arg options {object} Options for this test and some shared methods.
 */
ParserTests.prototype.checkHTML = function ( item, out, options, mode ) {
	var normalizedOut, normalizedExpected;

	normalizedOut = Util.normalizeOut( out );

	if ( item.cachedNormalizedHTML === null ) {
		normalizedExpected = Util.normalizeHTML( item.result );
		item.cachedNormalizedHTML = normalizedExpected;
	} else {
		normalizedExpected = item.cachedNormalizedHTML;
	}

	var input = mode === 'html2html' ? item.result : item.input;
	var expected = { normal: normalizedExpected, raw: item.result };
	var actual = { normal: normalizedOut, raw: out, input: input };

	options.reportResult( item.title, item.time, item.comments, item.options || null, expected, actual, options, mode, item );
};

/**
 * Check the result of a "2wt" operation.
 *
 * @arg item {object} The test being run.
 * @arg out {string} The actual output of the parser.
 * @arg options {object} Options passed into the process on the command line.
 */
ParserTests.prototype.checkWikitext = function ( item, out, options, mode ) {
	if ( mode === 'selser' && item.resultWT !== null ) {
		item.input = item.resultWT;
	}

	var normalizedExpected
		toWikiText = mode === 'html2wt' || mode === 'wt2wt' || mode === 'selser';
	// FIXME: normalization not in place yet
	normalizedExpected = toWikiText ? item.input.replace(/\n+$/, '') : item.input;

	// FIXME: normalization not in place yet
	normalizedOut = toWikiText ? out.replace(/\n+$/, '') : out;

	var input = mode === 'html2wt' ? item.result : item.input;
	var expected = { isWT: true, normal: normalizedExpected, raw: item.input };
	var actual = { isWT: true, normal: normalizedOut, raw: out, input: input };

	options.reportResult( item.title, item.time, item.comments, item.options || null, expected, actual, options, mode, item );
};

/**
 * Print out a WikiDom conversion of the HTML DOM
 */
ParserTests.prototype.printWikiDom = function ( body ) {
	console.log('WikiDom'.cyan + ':');
	console.log( body );
};

/**
 * Report the summary of all test results to the user.
 *
 * This method is customizable through the options of this ParserTests object.
 *
 * @arg stats {object} The big ol' book of statistics. Members:
 *   failOutputTests: Number of failed tests due to differences in output
 *   passedTests: Number of tests passed without any special consideration
 *   passedTestsManual: Number of tests passed by whitelisting
 *   modes: The above stats per-mode.
 */
ParserTests.prototype.reportSummary = function ( stats ) {
	var curStr, thisMode, i, failTotalTests = stats.failOutputTests;

	console.log( "==========================================================");
	console.log( "SUMMARY: ");

	if( failTotalTests !== 0 ) {
		for ( i = 0; i < modes.length; i++ ) {
			curStr = modes[i] + ': ';
			thisMode = stats.modes[modes[i]];
			if ( thisMode.passedTests + thisMode.passedTestsManual + thisMode.failOutputTests > 0 ) {
				curStr += colorizeCount( thisMode.passedTests, 'green' ) + ' passed / ';
				curStr += colorizeCount( thisMode.passedTestsManual, 'yellow' ) + ' whitelisted / ';
				curStr += colorizeCount( thisMode.failOutputTests, 'red' ) + ' failed';
				console.log( curStr );
			}
		}

		curStr = 'TOTAL' + ': ';
		curStr += colorizeCount( stats.passedTests, 'green' ) + ' passed / ';
		curStr += colorizeCount( stats.passedTestsManual, 'yellow' ) + ' whitelisted / ';
		curStr += colorizeCount( stats.failOutputTests, 'red' ) + ' failed';
		console.log( curStr );

		console.log( '\n' );
		console.log( colorizeCount( stats.passedTests + stats.passedTestsManual, 'green' ) +
			' total passed tests, ' +
			colorizeCount( failTotalTests , 'red'   ) + ' total failures' );
	} else {
		if( this.test_filter !== null ) {
			console.log( "Passed " + ( stats.passedTests + stats.passedTestsManual ) +
					" of " + stats.passedTests + " tests matching " + this.test_filter +
					"... " + "ALL TESTS PASSED!".green );
		} else {
			// Should not happen if it does: Champagne!
			console.log( "Passed " + stats.passedTests + " of " + stats.passedTests +
					" tests... " + "ALL TESTS PASSED!".green );
		}
	}
	console.log( "==========================================================");

};

ParserTests.prototype.main = function ( options ) {
	if ( options.help ) {
		optimist.showHelp();
		process.exit( 0 );
	}

	if ( !( options.wt2wt || options.wt2html || options.html2wt || options.html2html || options.selser ) ) {
		options.wt2wt = true;
		options.wt2html = true;
		options.html2html = true;
	}

	if ( typeof options.reportFailure !== 'function' ) {
		// default failure reporting is standard out,
		// see ParserTests::printFailure for documentation of the default.
		options.reportFailure = this.printFailure.bind( this );
	}

	if ( typeof options.reportSuccess !== 'function' ) {
		// default success reporting is standard out,
		// see ParserTests::printSuccess for documentation of the default.
		options.reportSuccess = this.printSuccess.bind( this );
	}

	if ( typeof options.reportStart !== 'function' ) {
		// default summary reporting is standard out,
		// see ParserTests::reportStart for documentation of the default.
		options.reportStart = this.reportStartOfTests.bind( this );
	}

	if ( typeof options.reportSummary !== 'function' ) {
		// default summary reporting is standard out,
		// see ParserTests::reportSummary for documentation of the default.
		options.reportSummary = this.reportSummary.bind( this );
	}

	if ( typeof options.reportResult !== 'function' ) {
		// default result reporting is standard out,
		// see ParserTests::printResult for documentation of the default.
		options.reportResult = this.printResult.bind( this );
	}

	if ( typeof options.getDiff !== 'function' ) {
		// this is the default for diff-getting, but it can be overridden
		// see ParserTests::getDiff for documentation of the default.
		options.getDiff = this.getDiff.bind( this );
	}

	if ( typeof options.getActualExpected !== 'function' ) {
		// this is the default for getting the actual and expected
		// outputs, but it can be overridden
		// see ParserTests::getActualExpected for documentation of the default.
		options.getActualExpected = this.getActualExpected.bind( this );
	}

	// test case filtering
	this.runDisabled = booleanOption(options['run-disabled']);
	this.runPHP = booleanOption(options['run-php']);
	this.test_filter = null;
	if ( options.filter ) { // null is the 'default' by definition
		try {
			this.test_filter = new RegExp( options.filter );
		} catch ( e ) {
			console.error( '\nERROR> --filter was given an invalid regular expression.' );
			console.error( 'ERROR> See below for JS engine error:\n' + e + '\n' );
			process.exit( 1 );
		}
	}
	if( !booleanOption( options.color ) ) {
		colors.mode = 'none';
	}

	// Identify tests file
	if ( options._[0] ) {
		this.testFileName = options._[0] ;
	} else {
		this.testFileName = __dirname + '/' + this.parser_tests_file;
	}

	try {
		this.testParserFileName = __dirname + '/parserTests.pegjs';
		this.testParser = PEG.buildParser( fs.readFileSync( this.testParserFileName, 'utf8' ) );
	} catch ( e2 ) {
		console.error( e2 );
	}

	this.cases = this.getTests( options ) || [];

	if ( options.maxtests ) {
		var n = Number( options.maxtests );
		console.warn( 'maxtests:' + n );
		if ( n > 0 ) {
			this.cases.length = n;
		}
	}

	options.fetchTemplates = false;
	options.usePHPPreProcessor = false;
	options.useLocalConfig = true;

	var parsoidConfig = new ParsoidConfig( null, options );

	// Create a new parser environment
	MWParserEnvironment.getParserEnv( parsoidConfig, null, 'en', null, function ( err, env ) {
		// For posterity: err will never be non-null here, because we expect the WikiConfig
		// to be basically empty, since the parserTests environment is very bare.
		this.env = env;
		this.env.errCB = function ( e ) {
			console.warn("ERROR: " + e);
			console.error( e.stack );
		};
		Util.setDebuggingFlags( this.env.conf.parsoid, options );
		options.modes = [];
		if ( options.wt2html ) {
			options.modes.push( 'wt2html' );
		}
		if ( options.wt2wt ) {
			options.modes.push( 'wt2wt' );
		}
		if ( options.html2html ) {
			options.modes.push( 'html2html' );
		}
		if ( options.html2wt ) {
			options.modes.push( 'html2wt' );
		}
		if ( options.selser ) {
			options.modes.push( 'selser' );
		}

		// Create parsers, serializers, ..
		if ( options.html2html || options.wt2wt || options.wt2html || options.selser ) {
			var parserPipelineFactory = new ParserPipelineFactory( this.env );
			this.parserPipeline = parserPipelineFactory.makePipeline( 'text/x-mediawiki/full' );
		}
		if ( options.wt2wt || options.html2wt || options.html2html || options.selser ) {
			this.serializer = new WikitextSerializer({env: this.env});
		}
		if ( options.selser ) {
			this.selectiveSerializer = new SelectiveSerializer( { env: this.env, wts: this.serializer } );
		}

		if ( options.changesin ) {
			this.changes = JSON.parse(
				fs.readFileSync( options.changesin, 'utf-8' ) );
			if ( this.changes._numchanges ) {
				options.numchanges = true;
			}
		}

		options.reportStart();
		this.env.pageCache = this.articles;
		this.comments = [];
		this.processCase( 0, options );
	}.bind( this ) );
};

/**
 * Simple function for reporting the start of the tests.
 *
 * This method can be reimplemented in the options of the ParserTests object.
 */
ParserTests.prototype.reportStartOfTests = function () {
	console.log( 'Initialisation complete. Now launching tests.' );
};

ParserTests.prototype.buildTasks = function ( item, modes, options ) {
	var tasks = [];
	for ( var i = 0; i < modes.length; i++ ) {
		if ( modes[i] === 'selser' && options.numchanges ) {
			if ( !item.changes ) {
				item.changes = new Array( options.numchanges );
			}

			for ( var j = 0; j < item.changes.length; j++ ) {
				tasks.push( function ( modeIndex, changesIndex ) {
					return function ( cb ) {
						var newitem = Util.clone( item );
						newitem.changes = item.changes[changesIndex];
						newitem.otherChanges = item.changes;
						this.processTest( newitem, options, modes[modeIndex], function () {
							if ( !this.doesChangeExist( item.changes, newitem.changes ) ) {
								item.changes[changesIndex] = Util.clone( newitem.changes );
							}

							// Push the caches forward!
							item.cachedHTML = newitem.cachedHTML;
							item.cachedNormalizedHTML = newitem.cachedNormalizedHTML;
							item.cachedResultHTML = newitem.cachedResultHTML;

							process.nextTick( cb );
						}.bind( this ) );
					};
				}( i, j ).bind( this ) );
			}
		} else {
			tasks.push( this.processTest.bind( this, item, options, modes[i] ) );
		}
	}
	return tasks;
};

ParserTests.prototype.processCase = function ( i, options ) {
	var item, cases = this.cases;

	var nextCallback = this.processCase.bind( this, i + 1, options );

	if ( i < this.cases.length ) {
		item = this.cases[i];
		if (!item.options) { item.options = {}; }
		// Reset the cached results for the new case.
		// All test modes happen in a single run of processCase.
		item.cachedHTML = null;
		item.cachedNormalizedHTML = null;
		item.cachedSourceHTML = null;

		//console.log( 'processCase ' + i + JSON.stringify( item )  );
		if ( typeof item === 'object' ) {
			switch(item.type) {
				case 'article':
					this.comments = [];
					this.processArticle( item, nextCallback );
					break;
				case 'test':
						if( ('disabled' in item.options && !this.runDisabled) ||
						    ('php' in item.options && !this.runPHP) ||
						    (this.test_filter &&
						     -1 === item.title.search( this.test_filter ) ) ) {
						// Skip test whose title does not match --filter
						// or which is disabled or php-only
						process.nextTick( nextCallback );
						break;
					}
					item.changes = ( this.changes || {} )[item.title];
					// Add comments to following test.
					item.comments = item.comments || this.comments;
					this.comments = [];
					async.series( this.buildTasks( item, options.modes, options ), nextCallback );
					break;
				case 'comment':
					this.comments.push( item.comment );
					process.nextTick( nextCallback );
					break;
				case 'hooks':
					console.warn('parserTests: Unhandled hook ' + JSON.stringify( item ) );
					break;
				case 'functionhooks':
					console.warn('parserTests: Unhandled functionhook ' + JSON.stringify( item ) );
					break;
				default:
					this.comments = [];
					process.nextTick( nextCallback );
					break;
			}
		} else {
			process.nextTick( nextCallback );
		}
	} else {
		// We're done testing, first need to add the test changes to an output
		// file if it was specified.
		if ( options.changesout !== null && options.selser ) {
			var changes, allChanges = {};
			for ( var ci = 0; ci < cases.length; ci++ ) {
				if ( cases[ci].type === 'test' ) {
					changes = cases[ci].changes || [];

					for ( var cci = 0; cci < changes.length; cci++ ) {
						if ( !changes[cci] || changes[cci].constructor !== Array ) {
							changes.splice( cci, 1 );
							cci--;
						}
					}
					allChanges[cases[ci].title] = changes;
				}
			}
			allChanges._numchanges = options.numchanges;

			fs.writeFileSync(
				options.changesout,
				JSON.stringify( allChanges, null, 1 )
					.replace( /\n */g, '\n' )
					.replace( /\n\]/g, ']' )
					.replace( /,\n([^"])/g, ',$1' )
					.replace( /[\n ]*(\[)[\n ]*/g, '$1' ) );
		}

		// print out the summary
		// note: these stats won't necessarily be useful if someone
		// reimplements the reporting methods, since that's where we
		// increment the stats.
		options.reportSummary( this.stats );
	}
};

// Construct the ParserTests object and run the parser tests
var ptests = new ParserTests(), popts = ptests.getOpts();

// Note: Wrapping the XML output stuff in its own private world
// so it can have private counters and the like
var xmlFuncs = function () {
	var fail, pass, passWhitelist,

	results = {
		html2html: '',
		wt2wt: '',
		wt2html: '',
		html2wt: ''
	},

	/**
	 * Get the actual and expected outputs encoded for XML output.
	 *
	 * @arg actual {object} Actual output from the parser. Contains 'raw' and 'normal', the output in different formats
	 * @arg expected {object} Expected output for this test. Contains 'raw' and 'normal' as above.
	 * @arg getDiff {function} The function we use to get the diff for output (if any)
	 * @arg color {bool} Whether we should output colorful strings or not.
	 *
	 * Side effect: Both objects will, after this, have 'formattedRaw' and 'formattedNormal' properties,
	 * which are the result of calling Util.formatHTML() on the 'raw' and 'normal' properties.
	 */
	getActualExpectedXML = function ( actual, expected, getDiff, color ) {
		var returnStr = '';

		expected.formattedRaw = Util.formatHTML( expected.raw );
		actual.formattedRaw = Util.formatHTML( actual.raw );
		expected.formattedNormal = Util.formatHTML( expected.normal );
		actual.formattedNormal = Util.formatHTML( actual.normal );

		returnStr += 'RAW EXPECTED:\n';
		returnStr += Util.encodeXml( expected.formattedRaw ) + '\n\n';

		returnStr += 'RAW RENDERED:\n';
		returnStr += Util.encodeXml( actual.formattedRaw ) + '\n\n';

		returnStr += 'NORMALIZED EXPECTED:\n';
		returnStr += Util.encodeXml( expected.formattedNormal ) + '\n\n';

		returnStr += 'NORMALIZED RENDERED:\n';
		returnStr += Util.encodeXml( actual.formattedNormal ) + '\n\n';

		returnStr += 'DIFF:\n';
		returnStr += Util.encodeXml ( getDiff( actual, expected, false ) );

		return returnStr;
	},

	/**
	 * Report the start of the tests output.
	 */
	reportStartXML = function () {
		console.log( '<testsuites>' );
	},

	/**
	 * Report the end of the tests output.
	 */
	reportSummaryXML = function () {
		var i, mode;
		for ( i = 0; i < modes.length; i++ ) {
			mode = modes[i];
			console.log( '<testsuite name="parserTests-' + mode + '" file="parserTests.txt">' );
			console.log( results[mode] );
			console.log( '</testsuite>' );
		}

		console.log( '</testsuites>' );
	},

	/**
	 * Print a failure message for a test in XML.
	 *
	 * @arg title {string} The title of the test
	 * @arg comments {Array} Any comments associated with the test
	 * @arg iopts {object|null} Options from the test file
	 * @arg options {object} Options for the test environment (usually a copy of argv)
	 * @arg actual {object} The actual results (see printResult for more)
	 * @arg expected {object} The expected results (see printResult for more)
	 * @arg failure_only {bool} Whether we should print only a failure message, or go on to print the diff
	 * @arg mode {string} The mode we're in (wt2wt, wt2html, html2wt, or html2html)
	 */
	reportFailureXML = function ( title, comments, iopts, options, actual, expected, failure_only, mode, error ) {
		fail++;
		var failEle;

		if ( error ) {
			failEle = '<error type="somethingCrashedFail">\n';
			failEle += error.toString();
			failEle += '\n</error>\n';
		} else {
			failEle = '<failure type="parserTestsDifferenceInOutputFailure">\n';
			failEle += getActualExpectedXML( actual, expected, options.getDiff, false );
			failEle += '\n</failure>\n';
		}

		results[mode] += failEle;
	},

	/**
	 * Print a success method for a test in XML.
	 *
	 * This method is configurable through the options of the ParserTests object.
	 *
	 * @arg title {string} The title of the test
	 * @arg mode {string} The mode we're in (wt2wt, wt2html, html2wt, or html2html)
	 * @arg isWhitelist {bool} Whether this success was due to a whitelisting
	 * @arg shouldReport {bool} Whether we should actually output this result, or just count it
	 */
	reportSuccessXML = function ( title, mode, isWhitelist, shouldReport ) {
		if ( isWhitelist ) {
			passWhitelist++;
		} else {
			pass++;
		}
	},

	/**
	 * Print the result of a test in XML.
	 *
	 * @inheritdoc ParserTests#printResult
	 */
	reportResultXML = function ( title, time, comments, iopts, expected, actual, options, mode, item ) {
		var timeTotal, testcaseEle;
		var quick = booleanOption( options.quick );
		var quiet = booleanOption( options.quiet );

		if ( mode === 'selser' ) {
			title += ' ' + JSON.stringify( item.changes );
		}

		testcaseEle = '<testcase name="' + Util.encodeXml( title ) + '" ';
		testcaseEle += 'assertions="1" ';

		if ( time && time.end && time.start ) {
			timeTotal = time.end - time.start;
			if ( !isNaN( timeTotal ) ) {
				testcaseEle += 'time="' + ( ( time.end - time.start ) / 1000.0 ) + '"';
			}
		}

		testcaseEle += '>';

		results[mode] += testcaseEle;

		if ( expected.normal !== actual.normal ) {
			if ( options.whitelist && title in testWhiteList &&
				 Util.normalizeOut( testWhiteList[title] ) ===  actual.normal ) {
				reportSuccessXML( title, mode, true, quiet );
			} else {
				reportFailureXML( title, comments, iopts, options, actual, expected, quick, mode );
			}
		} else {
			reportSuccessXML( title, mode, false, quiet );
		}

		results[mode] += '</testcase>\n';
	};

	return {
		reportResult: reportResultXML,
		reportStart: reportStartXML,
		reportSummary: reportSummaryXML,
		reportSuccess: reportSuccessXML,
		reportFailure: reportFailureXML
	};
}();

if ( popts && popts.xml ) {
	popts.reportResult = xmlFuncs.reportResult;
	popts.reportStart = xmlFuncs.reportStart;
	popts.reportSummary = xmlFuncs.reportSummary;
	popts.reportFailure = xmlFuncs.reportFailure;
}

ptests.main( popts );

} )();
