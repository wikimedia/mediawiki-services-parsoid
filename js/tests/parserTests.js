#!/usr/bin/env node
/*
 * Initial parser tests runner for experimental JS parser
 *
 * This pulls all the parserTests.txt items and runs them through the JS
 * parser and JS HTML renderer.
 */

(function() {

/**
 * @class ParserTestModule
 * @private
 * @singleton
 */

var fs = require('fs'),
	path = require('path'),
	colors = require('colors'),
	Util = require( '../lib/mediawiki.Util.js' ).Util,
	childProc = require('child_process'),
	fork = childProc.fork,
	DOMUtils = require( '../lib/mediawiki.DOMUtils.js' ).DOMUtils,
	async = require( 'async' ),
	PEG = require('pegjs'),
	Alea = require('alea'),
	// Handle options/arguments with optimist module
	optimist = require('optimist');
var booleanOption = Util.booleanOption; // shortcut

// exhaustive changesin file to use with selser blacklist
var BLACKLIST_CHANGESIN = __dirname + "/selser.changes.json";

// Run a mock API in the background so we can request things from it
var forkedAPI = fork( __dirname + '/mockAPI.js', [], { silent: true } );

process.on( 'exit', function () {
	forkedAPI.kill();
} );

// track files imported / required
var fileDependencies = [];
var parserTestsUpToDate = true;

// Fetch up some of our wacky parser bits...

var mp = '../lib/',
	MWParserEnvironment = require(mp + 'mediawiki.parser.environment.js').MWParserEnvironment,
	WikitextSerializer = require(mp + 'mediawiki.WikitextSerializer.js').WikitextSerializer,
	SelectiveSerializer = require( mp + 'mediawiki.SelectiveSerializer.js' ).SelectiveSerializer,
	ParsoidConfig = require( mp + 'mediawiki.ParsoidConfig' ).ParsoidConfig;

// For now most modules only need this for $.extend and $.each :)
var $ = require(mp + 'fakejquery');

// Our code...

/**
 * @method
 *
 * Colorize given number if <> 0
 *
 * @param {number} count
 * @param {string} color
 */
var colorizeCount = function ( count, color ) {
	if( count === 0 ) {
		return count;
	}

	// We need a string to use colors methods
	count = count.toString();

	// FIXME there must be a wait to call a method by its name
	if ( count[color] ) {
		return count[color] + '';
	} else {
		return count;
	}
};

var testWhiteList = require(__dirname + '/parserTests-whitelist.js').
		testWhiteList;
var testBlackList = require(__dirname + '/parserTests-blacklist.js').
		testBlackList;

var modes = ['wt2html', 'wt2wt', 'html2html', 'html2wt', 'selser'];

/**
 * @class
 * @private
 * @singleton
 *
 * Main class for the test environment.
 */
function ParserTests () {
	var i;

	this.cache_file = "parserTests.cache"; // Name of file used to cache the parser tests cases
	this.parser_tests_file = "parserTests.txt";
	this.tests_changes_file = 'changes.txt';

	this.articles = {};

	// Test statistics
	this.stats = {};
	this.stats.passedTests = 0;
	this.stats.passedTestsWhitelisted = 0;
	this.stats.passedTestsUnexpected = 0;
	this.stats.failedTests = 0;
	this.stats.failedTestsUnexpected = 0;

	var newModes = {};

	for ( i = 0; i < modes.length; i++ ) {
		newModes[modes[i]] = Util.clone( this.stats );
		newModes[modes[i]].failList = [];
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


/**
 * @method
 *
 * Get the options from the command line.
 *
 * @returns {Object}
 */
ParserTests.prototype.getOpts = function () {
	var default_args = ["Default tests-file: " + this.parser_tests_file,
	                    "Default options   : --wt2html --wt2wt --html2html --whitelist --color=auto"];

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
		'use_source': {
			description: 'Use original source in wt2wt tests',
			'boolean': true,
			'default': true
		},
		'editMode': {
			description: 'Test in edit-mode (changes some parse & serialization strategies)',
			'default': true,
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
		'blacklist': {
			description: 'Compare against expected failures from blacklist',
			'default': true,
			'boolean': true
		},
		'rewrite-blacklist': {
			description: 'Update parserTests-blacklist.js with failing tests.',
			'default': false,
			'boolean': true
		},
		'color': {
			description: 'Enable color output Ex: --no-color',
			'default': 'auto'
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
		'exit-zero': {
			description: "Don't exit with nonzero status if failures are found.",
			'default': false,
			'boolean': true
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
 * @method
 *
 * Get an object holding our tests cases. Eventually from a cache file
 *
 * @param {Object} argv
 * @returns {Object}
 */
ParserTests.prototype.getTests = function ( argv ) {
	// double check that test file is up-to-date with upstream
	var fetcher = require(__dirname+"/fetch-parserTests.txt.js");
	if (!fetcher.isUpToDate()) {
		parserTestsUpToDate = false;
		console.warn("WARNING: parserTests.txt not up-to-date with upstream.");
	}

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
 * @method
 *
 * Parse content of tests case file given as plaintext
 *
 * @param {string} content
 * @returns {Array}
 */
ParserTests.prototype.parseTestCase = function ( content ) {
	try {
		return this.testParser.parse(content);
	} catch (e) {
		console.error(e);
	}
	return undefined;
};

/**
 * @method
 *
 * Process an article test case (i.e. the text of an article we need for a test)
 *
 * @param {Object} item
 * @param {string} item.title
 * @param {string} item.text
 * @param {Function} cb
 */
ParserTests.prototype.processArticle = function( item, cb ) {
	var norm = this.env.normalizeTitle(item.title);
	//console.log( 'processArticle ' + norm );
	this.articles[norm] = item.text;
	process.nextTick( cb );
};

/**
 * @method
 *
 * Convert a DOM to Wikitext.
 *
 * @param {Object} options
 * @param {string} mode
 * @param {Object} item
 * @param {Node} doc
 * @param {Function} processWikitextCB
 * @param {Error/null} processWikitextCB.err
 * @param {string/null} processWikitextCB.res
 */
ParserTests.prototype.convertHtml2Wt = function( options, mode, item, doc, processWikitextCB ) {
	// SSS FIXME: SelSer clobbers this flag -- need a better fix for this.
	// Maybe pass this as an option, or clone the entire environment.
	this.env.conf.parsoid.editMode = options.editMode;

	// In some cases (which?) the full document is passed in, but we are
	// interested in the body. So check if we got a document.
	var content = doc.nodeType === doc.DOCUMENT_NODE ? doc.body : doc,
		serializer = (mode === 'selser') ? new SelectiveSerializer({env: this.env})
										: new WikitextSerializer({env: this.env}),
		wt = '',
		self = this,
		startsAtWikitext = mode === 'wt2wt' || mode === 'wt2html' || mode === 'selser';
	try {
		this.env.page.dom = item.cachedHTML || null;
		if ( mode === 'selser' ) {
			// console.warn("--> selsering: " + content.outerHTML);
			this.env.setPageSrcInfo( item.input );
			if ( options.changesin && item.changes === undefined ) {
				// A changesin option was passed, so set the changes to 0,
				// so we don't try to regenerate the changes.
				item.changes = 0;
			}
		} else if (booleanOption(options.use_source) && startsAtWikitext ) {
			this.env.setPageSrcInfo( item.input );
		} else {
			this.env.setPageSrcInfo( null );
		}
		serializer.serializeDOM( content, function ( res ) {
			wt += res;
		}, function () {
			processWikitextCB( null, wt );
			self.env.setPageSrcInfo( null );
			self.env.page.dom = null;
		} );
	} catch ( e ) {
		console.error(e.stack);
		processWikitextCB( e, null );
		this.env.setPageSrcInfo( null );
		this.env.page.dom = null;
	}
};

/**
 * @method
 *
 * For a selser test, check if a change we could make has already been tested in this round.
 * Used for generating unique tests.
 *
 * @param {Array} changes Already-tried changes
 * @param {Array} change Candidate change
 * @returns {boolean}
 */
ParserTests.prototype.isDuplicateChangeTree = function ( allChanges, change ) {
	if ( !allChanges || allChanges.constructor !== Array ) {
		return false;
	}

	var i;
	for ( i = 0; i < allChanges.length; i++ ) {
		if ( Util.deepEquals( allChanges[i], change ) ) {
			return true;
		}
	}
	return false;
};

/**
 * @method
 *
 * Make changes to a DOM in order to run a selser test on it.
 *
 * @param {Object} item
 * @param {Node} content
 * @param {Array} changelist
 * @param {Function} cb
 * @param {Error} cb.err
 * @param {Node} cb.document
 */
ParserTests.prototype.applyChanges = function ( item, content, changelist, cb ) {
	// Helper function for getting a random string
	function randomString() {
		return random().toString(36).slice(2);
	}

	function insertNewNode(n) {
		// Insert a text node, if not in a fosterable position.
		// If in foster position, enter a comment.
		// In either case, dom-diff should register a new node
		var str = randomString(), ownerDoc = n.ownerDocument;
		n.parentNode.insertBefore(
			DOMUtils.isFosterablePosition(n) ?
				ownerDoc.createComment(str) :
				ownerDoc.createTextNode(str),
			n);
	}

	function removeNode(n) {
		n.parentNode.removeChild(n);
	}

	function applyChangesInternal(node, changes) {
		if (!node) {
			// FIXME: Generate change assignments dynamically
			console.error('ERROR: no node in applyChangesInternal, ' +
					'HTML structure likely changed');
			return;
		}
		var nodes = Util.clone(node.childNodes);

		for ( var i = 0; i < changes.length; i++ ) {
			var child = nodes[i],
				change = changes[i];

			if ( change && change.constructor === Array ) {
				applyChangesInternal( child, change );
			} else if ( child && child.setAttribute ) {
				switch ( change ) {
					// No change
					case 0:
						break;

					// Change node wrapper
					// (sufficient to insert a random attr)
					case 1:
						child.setAttribute( 'data-foobar', randomString() );
						break;

					// Insert new node before child
					case 2:
						insertNewNode(child);
						break;

					// Delete tree rooted at child
					case 3:
						removeNode(child);
						break;

					// Change tree rooted at child
					case 4:
						insertNewNode(child);
						removeNode(child);
						break;
				}
			}
		}
	}

	// Seed the random-number generator based on the item title
	var random = new Alea( (item.seed || '') + (item.title || '') );

	// Keep the changes in the item object in case of --changesout
	item.changes = item.changes || changelist;

	if ( content.nodeType === content.DOCUMENT_NODE ) {
		content = content.body;
	}

	if (item.changes !== 0) {
		applyChangesInternal(content, item.changes);
	}

	if (cb) {
		cb( null, content );
	}
};

/**
 * @method
 *
 * Generate a change object for a document, so we can apply it during a selser test.
 *
 * @param {Object} options
 * @param {Object/null} nonRandomChanges Passed in changes, i.e., don't generate random changes.
 * @param {Object} item
 * @param {Node} content
 * @param {Function} cb
 * @param {Error/null} cb.err
 * @param {Node} cb.content
 * @param {Array} cb.changelist
 */
ParserTests.prototype.generateChanges = function ( options, nonRandomChanges, item, content, cb ) {

	var self = this,
		random = new Alea( (item.seed || '') + (item.title || '') );

	/**
	 * If no node in the DOM subtree rooted at 'node' is editable in the VE,
	 * this function should return false.
	 *
	 * Currently true for template and extension content.
	 */
	function domSubtreeIsEditable(env, node) {
		return !DOMUtils.isTplElementNode(env, node);
	}

	/**
	 * Even if a DOM subtree might be editable in the VE,
	 * certain nodes in the DOM might not be directly editable.
	 *
	 * Currently, this restriction is only applied to DOMs generated for images.
	 * Possibly, there are other candidates.
	 */
	function nodeIsUneditable(node) {
		// Text and comment nodes are always editable
		if (!DOMUtils.isElt(node)) {
			return false;
		}

		// - Meta tag providing info about tpl-affected attrs is uneditable.
		//
		//   SSS FIXME: This is not very useful right now because sometimes,
		//   these meta-tags are not siblings with the element that it applies to.
		//   So, you can still end up deleting the meta-tag (by deleting its parent)
		//   and losing this property.  See example below.  The best fix for this is
		//   to hoist all these kind of meta tags into <head>, start, or end of doc.
		//   Then, we don't even have to check for editability of these nodes here.
		//
		//   Ex:
		//   ...
		//   <td><meta about="#mwt2" property="mw:objectAttrVal#style" ...>..</td>
		//   <td about="#mwt2" typeof="mw:ExpandedAttrs/Transclusion" ...>..</td>
		//   ...
		if ((/\bmw:objectAttr/).test(node.getAttribute('property'))) {
			return true;
		}

		// - Image wrapper is an uneditable image elt.
		// - Any node nested in an image elt that is not a fig-caption
		//   is an uneditable image elt.
		return (/\bmw:Image\b/).test(node.getAttribute('typeof')) ||
			(
				node.nodeName !== 'FIGCAPTION' &&
				node.parentNode &&
				node.parentNode.nodeName !== 'BODY' &&
				nodeIsUneditable(node.parentNode)
			);
	}

	function hasChangeMarkers(list) {
		// If all recorded changes are 0, then nothing has been modified
		for (var i = 0, n = list.length; i < n; i++) {
			var c = list[i];
			if ((c.constructor === Array && hasChangeMarkers(c)) || c > 0) {
				return true;
			}
		}
		return false;
	}

	function genChangesInternal(item, node) {
		// Seed the random-number generator based on the item title
		var changelist = [],
			children = node.childNodes;

		for (var i = 0, n = children.length; i < n; i++) {
			var child = children[i],
				changeType = 0;

			if ( domSubtreeIsEditable( self.env, child ) ) {
				if ( nodeIsUneditable(child) || random() < 0.5 ) {
					changeType = genChangesInternal(
						// ensure the subtree has a seed
						{ seed: ''+random.uint32() },
						child );
				} else {
					if ( !child.setAttribute ) {
						// Text or comment node -- valid changes: 2, 3, 4
						// since we cannot set attributes on these
						changeType = Math.floor( random() * 3 ) + 2;
					} else {
						changeType = Math.floor( random() * 4 ) + 1;
					}
				}
			}

			changelist.push( changeType );
		}

		return hasChangeMarkers(changelist) ? changelist : 0;
	}

	if ( content.nodeType === content.DOCUMENT_NODE ) {
		content = content.body;
	}

	var changeTree = nonRandomChanges;
	if (!changeTree) {
		var numAttempts = 0;
		do {
			numAttempts++;
			changeTree = genChangesInternal(item, content);
		} while (
			numAttempts < 1000 &&
			(changeTree.length === 0 || self.isDuplicateChangeTree( item.selserChangeTrees, changeTree ))
		);
	}

	cb( null, content, changeTree );
};

ParserTests.prototype.convertWt2Html = function( mode, prefix, variant, wikitext, processHtmlCB ) {
/**
 * @method
 * @param {string} mode
 * @param {string} prefix
 * @param {string} variant
 * @param {string} wikitext
 * @param {Function} processHtmlCB
 * @param {Error/null} processHtmlCB.err
 * @param {Node/null} processHtmlCB.doc
 */
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
	this.env.setPageSrcInfo( wikitext );
	this.env.switchToConfig( prefix, function( err ) {
		if ( err ) {
			processHtmlCB( err );
		} else {
			// TODO: set language variant
			// adjust config to match that used for PHP tests
			// see core/tests/parser/parserTest.inc:setupGlobals() for
			// full set of config normalizations done.
			this.env.conf.wiki.fakeTimestamp = 123;
			this.env.conf.wiki.timezoneOffset = 0; // force utc for parsertests
			this.env.conf.wiki.server = 'http://example.org';
			this.env.conf.wiki.wgScriptPath = '/';
			this.env.conf.wiki.script = '/index.php';
			this.env.conf.wiki.articlePath = '/wiki/$1';
			// this has been updated in the live wikis, but the parser tests
			// expect the old value (as set in parserTest.inc:setupDatabase())
			this.env.conf.wiki.interwikiMap.meatball.url =
				'http://www.usemod.com/cgi-bin/mb.pl?$1';
			// convert this wikitext!
			this.parserPipeline.processToplevelDoc( wikitext );
		}
	}.bind(this));
};

/**
 * @method
 * @param {Object} item
 * @param {Object} options
 * @param {Function} endCb
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

	var i, variant,
		extensions = [],
		prefix = 'en';

	if ( item.options ) {
		if ( item.options.language !== undefined ) {
			prefix = item.options.language;
		}

		variant = (item.options || {}).variant;

		if ( item.options.extensions !== undefined ) {
			extensions = item.options.extensions.split( ' ' );
		}

		if ( item.options.title !== undefined &&
		     !$.isArray(item.options.title) ) {
			// Strip the [[]] markers.
			var title = item.options.title.replace( /^\[\[|\]\]$/g, '' );
			title = this.env.normalizeTitle( title, true );
			this.env.setPageName( title );
		}

		if ( item.options.subpage !== undefined ) {
			this.env.conf.wiki.namespacesWithSubpages[0] = true;
		} else {
			this.env.conf.wiki.namespacesWithSubpages[0] = false;
		}
	}

	item.extensions = extensions;
	for ( i = 0; i < extensions.length; i++ ) {
		this.env.conf.wiki.addExtensionTag( extensions[i] );
	}

	// Build a list of tasks for this test that will be passed to async.waterfall
	var finishHandler = function ( err, res ) {
		if ( err ) {
			options.reportFailure( item.title, item.comments, item.options,
			                       options, null, null, false,
			                       true, mode, err, item );
		}

		for ( i = 0; i < extensions.length; i++ ) {
			this.env.conf.wiki.removeExtensionTag( extensions[i] );
		}

		process.nextTick( endCb );
	}.bind( this );

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
				cb( null, Util.parseHTML(item.result).body );
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
			testTasks.push( this.convertWt2Html.bind( this, mode, prefix, variant, item.input ) );
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
		testTasks.push( this.applyChanges.bind( this, item ) );

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
		testTasks.push( this.convertWt2Html.bind( this, mode, prefix, variant ) );
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
 * @method
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @param {Node} doc
 * @param {Function} cb
 */
ParserTests.prototype.processParsedHTML = function( item, options, mode, doc, cb ) {
	item.time.end = Date.now();
	// Check the result vs. the expected result.
	this.checkHTML( item, doc.innerHTML, options, mode );

	// Now schedule the next test, if any
	process.nextTick( cb );
};

/**
 * @method
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @param {Node} doc
 * @param {Function} cb
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
 * @method
 * @param {string} title
 * @param {Array} comments
 * @param {Object/null} iopts Options from the test file
 * @param {Object} options
 * @param {Object} actual
 * @param {Object} expected
 * @param {boolean} expectFail Whether this test was expected to fail (on blacklist)
 * @param {boolean} failure_only Whether we should print only a failure message, or go on to print the diff
 * @param {string} mode
 */
ParserTests.prototype.printFailure = function ( title, comments, iopts, options,
		actual, expected, expectFail, failure_only, mode, error, item ) {
	this.stats.failedTests++;
	this.stats.modes[mode].failedTests++;
	this.stats.modes[mode].failList.push(title);

	var extTitle = ( title + ( mode ? ( ' (' + mode + ')' ) : '' ) ).
		replace('\n', ' ');

	if ( booleanOption( options.blacklist ) && expectFail ) {
		if ( !booleanOption( options.quiet ) ) {
			console.log( 'EXPECTED FAIL'.red + ': ' + extTitle.yellow );
		}
		return;
	} else {
		this.stats.failedTestsUnexpected++;
		this.stats.modes[mode].failedTestsUnexpected++;
	}

	if ( !failure_only ) {
		console.log( '=====================================================' );
	}

	console.log( 'UNEXPECTED FAIL'.red.inverse + ': ' + extTitle.yellow );

	if ( mode === 'selser' ) {
		if ( item.wt2wtPassed ) {
			console.log( 'Even worse, the non-selser wt2wt test passed!'.red + '');
		} else if ( actual && item.wt2wtResult !== actual.raw ) {
			console.log( 'Even worse, the non-selser wt2wt test had a different result!'.red + '');
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

		console.log( options.getActualExpected( actual, expected, options.getDiff ) );

		if ( booleanOption( options.printwhitelist )  ) {
			this.printWhitelistEntry( title, actual.raw );
		}
	} else if ( !failure_only && error ) {
		// The error object exists, which means
		// there was an error! gwicke said it wouldn't happen, but handle
		// it anyway, just in case.
		console.log( '\nBECAUSE THERE WAS AN ERROR:\n'.red + '');
		console.log( error.stack || error.toString() );
	}
};

/**
 * @method
 * @param {string} title
 * @param {string} mode
 * @param {boolean} expectSuccess Whether this success was expected (or was this test blacklisted?)
 * @param {boolean} isWhitelist Whether this success was due to a whitelisting
 * @param {boolean} shouldReport Whether we should actually output this result, or just count it
 */
ParserTests.prototype.printSuccess = function ( title, options, mode, expectSuccess, isWhitelist, item ) {
	var quiet = booleanOption( options.quiet );
	if ( isWhitelist ) {
		this.stats.passedTestsWhitelisted++;
		this.stats.modes[mode].passedTestsWhitelisted++;
	} else {
		this.stats.passedTests++;
		this.stats.modes[mode].passedTests++;
	}
	var extTitle = ( title + ( mode ? ( ' (' + mode + ')' ) : '' ) ).
		replace('\n', ' ');

	if( booleanOption( options.blacklist ) && !expectSuccess ) {
		this.stats.passedTestsUnexpected++;
		this.stats.modes[mode].passedTestsUnexpected++;
		console.log( 'UNEXPECTED PASS'.green.inverse +
					 (isWhitelist ? ' (whitelist)' : '') +
					 ':' + extTitle.yellow);
		return;
	}
	if( !quiet ) {
		var outStr = 'EXPECTED PASS';

		if ( isWhitelist ) {
			outStr += ' (whitelist)';
		}

		outStr = outStr.green + ': ' + extTitle.yellow;

		console.log( outStr );

		if ( mode === 'selser' && !item.wt2wtPassed ) {
			console.log( 'Even better, the non-selser wt2wt test failed!'.red + '');
		}
	}
};

/**
 * @method
 *
 * Print the actual and expected outputs.
 *
 * Side effect: Both objects will, after this, have 'formattedRaw' and 'formattedNormal' properties,
 * which are the result of calling Util.formatHTML() on the 'raw' and 'normal' properties.
 *
 * @param {Object} actual
 * @param {string} actual.raw
 * @param {string} actual.normal
 * @param {Object} expected
 * @param {string} expected.raw
 * @param {string} expected.normal
 * @param {Function} getDiff Returns a string showing the diff(s) for the test.
 * @param {Object} getDiff.actual
 * @param {Object} getDiff.expected
 * @returns {string}
 */
ParserTests.prototype.getActualExpected = function ( actual, expected, getDiff ) {
	var returnStr = '';
	expected.formattedRaw = expected.isWT ? expected.raw : Util.formatHTML( expected.raw );
	returnStr += 'RAW EXPECTED'.cyan + ':';
	returnStr += expected.formattedRaw + '\n';

	actual.formattedRaw = actual.isWT ? actual.raw : Util.formatHTML( actual.raw );
	returnStr += 'RAW RENDERED'.cyan + ':';
	returnStr += actual.formattedRaw + '\n';

	expected.formattedNormal = expected.isWT ? expected.normal : Util.formatHTML( expected.normal );
	returnStr += 'NORMALIZED EXPECTED'.magenta + ':';
	returnStr += expected.formattedNormal + '\n';

	actual.formattedNormal = actual.isWT ? actual.normal : Util.formatHTML( actual.normal );
	returnStr += 'NORMALIZED RENDERED'.magenta + ':';
	returnStr += actual.formattedNormal + '\n';

	returnStr += 'DIFF'.cyan + ': \n';
	returnStr += getDiff( actual, expected );

	return returnStr;
};

/**
 * @param {Object} actual
 * @param {string} actual.formattedNormal
 * @param {Object} expected
 * @param {string} expected.formattedNormal
 */
ParserTests.prototype.getDiff = function ( actual, expected ) {
	// safe to always request color diff, because we set color mode='none'
	// if colors are turned off.
	return Util.diff( expected.formattedNormal, actual.formattedNormal, true );
};

/**
 * @param {string} title
 * @param {string} raw The raw output from the parser.
 */
ParserTests.prototype.printWhitelistEntry = function ( title, raw ) {
	console.log( 'WHITELIST ENTRY:'.cyan + '');
	console.log( 'testWhiteList[' +
		JSON.stringify( title ) + '] = ' +
		JSON.stringify( raw ) + ';\n' );
};

/**
 * @param {string} title
 * @param {Object} time
 * @param {number} time.start
 * @param {number} time.end
 * @param {Array} comments
 * @param {Object|null} iopts Any options for the test (not options passed into the process)
 * @param {Object} expected
 * @param {Object} actual
 * @param {Object} options
 * @param {string} mode
 */
ParserTests.prototype.printResult = function ( title, time, comments, iopts, expected, actual, options, mode, item ) {
	var quick = booleanOption( options.quick );
	var parsoidOnly = (iopts.parsoid !== undefined);

	if ( mode === 'selser' ) {
		title += ' ' + JSON.stringify( item.changes );
	}

	var whitelist = false;
	var expectFail = (testBlackList[title] || []).indexOf(mode) >= 0;
	var fail = ( expected.normal !== actual.normal );

	if ( fail &&
	     booleanOption( options.whitelist ) &&
	     title in testWhiteList &&
	     Util.normalizeOut( testWhiteList[title], parsoidOnly ) ===  actual.normal ) {
		whitelist = true;
		fail = false;
	}

	if ( mode === 'wt2wt' ) {
		item.wt2wtPassed = !fail;
		item.wt2wtResult = actual.raw;
	}

	if ( fail ) {
		options.reportFailure( title, comments, iopts, options,
		                       actual, expected, expectFail,
		                       quick, mode, null, item );
	} else {
		options.reportSuccess( title, options, mode, !expectFail,
		                       whitelist, item );
	}
};

/**
 * @param {Object} item
 * @param {string} out
 * @param {Object} options
 */
ParserTests.prototype.checkHTML = function ( item, out, options, mode ) {
	var normalizedOut, normalizedExpected;
	var parsoidOnly = (item.options.parsoid !== undefined);

	normalizedOut = Util.normalizeOut( out, parsoidOnly );

	if ( item.cachedNormalizedHTML === null ) {
		if ( parsoidOnly ) {
			var normalDOM = Util.parseHTML( item.result ).body.innerHTML;
			normalizedExpected = Util.normalizeOut( normalDOM, parsoidOnly );
		} else {
			normalizedExpected = Util.normalizeHTML( item.result );
		}
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
 * @param {Object} item
 * @param {string} out
 * @param {Object} options
 */
ParserTests.prototype.checkWikitext = function ( item, out, options, mode ) {
	if ( mode === 'selser' && item.resultWT !== null ) {
		item.input = item.resultWT;
	}

	var normalizedExpected,
		toWikiText = mode === 'html2wt' || mode === 'wt2wt' || mode === 'selser';
	// FIXME: normalization not in place yet
	normalizedExpected = toWikiText ? item.input.replace(/\n+$/, '') : item.input;

	// FIXME: normalization not in place yet
	var normalizedOut = toWikiText ? out.replace(/\n+$/, '') : out;

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
 * @param {Object} stats
 * @param {number} stats.failedTests Number of failed tests due to differences in output
 * @param {number} stats.passedTests Number of tests passed without any special consideration
 * @param {number} stats.passedTestsWhitelisted Number of tests passed by whitelisting
 * @param {Object} stats.modes All of the stats (failedTests, passedTests, and passedTestsWhitelisted) per-mode.
 */
ParserTests.prototype.reportSummary = function ( stats ) {
	var curStr, thisMode, i, failTotalTests = stats.failedTests;

	console.log( "==========================================================");
	console.log( "SUMMARY: ");

	if( failTotalTests !== 0 ) {
		for ( i = 0; i < modes.length; i++ ) {
			curStr = modes[i] + ': ';
			thisMode = stats.modes[modes[i]];
			if ( thisMode.passedTests + thisMode.passedTestsWhitelisted + thisMode.failedTests > 0 ) {
				curStr += colorizeCount( thisMode.passedTests + thisMode.passedTestsWhitelisted, 'green' ) + ' passed (';
				curStr += colorizeCount( thisMode.passedTestsUnexpected, 'red' ) + ' unexpected, ';
				curStr += colorizeCount( thisMode.passedTestsWhitelisted, 'yellow' ) + ' whitelisted) / ';
				curStr += colorizeCount( thisMode.failedTests, 'red' ) + ' failed (';
				curStr += colorizeCount( thisMode.failedTestsUnexpected, 'red') + ' unexpected)';
				console.log( curStr );
			}
		}

		curStr = 'TOTAL' + ': ';
		curStr += colorizeCount( stats.passedTests + stats.passedTestsWhitelisted, 'green' ) + ' passed (';
		curStr += colorizeCount( stats.passedTestsUnexpected, 'red' ) + ' unexpected, ';
		curStr += colorizeCount( stats.passedTestsWhitelisted, 'yellow' ) + ' whitelisted) / ';
		curStr += colorizeCount( stats.failedTests, 'red' ) + ' failed (';
		curStr += colorizeCount( stats.failedTestsUnexpected, 'red') + ' unexpected)';
		console.log( curStr );

		console.log( '\n' );
		console.log( colorizeCount( stats.passedTests + stats.passedTestsWhitelisted, 'green' ) +
		             ' total passed tests (expected ' +
		             (stats.passedTests + stats.passedTestsWhitelisted - stats.passedTestsUnexpected + stats.failedTestsUnexpected) +
		             '), '+
		             colorizeCount( failTotalTests , 'red'   ) + ' total failures (expected ' +
		             (stats.failedTests - stats.failedTestsUnexpected + stats.passedTestsUnexpected) +
		             ')' );
		if ( stats.passedTestsUnexpected === 0 &&
		     stats.failedTestsUnexpected === 0 ) {
			console.log( '--> ' + 'NO UNEXPECTED RESULTS'.green + ' <--');
		}
	} else {
		if( this.test_filter !== null ) {
			console.log( "Passed " + ( stats.passedTests + stats.passedTestsWhitelisted ) +
					" of " + stats.passedTests + " tests matching " + this.test_filter +
					"... " + "ALL TESTS PASSED!".green );
		} else {
			// Should not happen if it does: Champagne!
			console.log( "Passed " + stats.passedTests + " of " + stats.passedTests +
					" tests... " + "ALL TESTS PASSED!".green );
		}
	}
	// repeat warning about out-of-date parser tests (we might have missed
	// in at the top) and describe what to do about it.
	if (!parserTestsUpToDate) {
		console.log( "==========================================================");
		console.warn( "WARNING:".red +
		              " parserTests.txt not up-to-date with upstream." );
		console.warn ("         Run fetch-parserTests.txt.js to update." );
	}
	console.log( "==========================================================");

	return (stats.passedTestsUnexpected + stats.failedTestsUnexpected);
};

/**
 * @method
 * @param {Object} options
 */
ParserTests.prototype.main = function ( options ) {
	if ( options.help ) {
		optimist.showHelp();
		process.exit( 0 );
	}
	Util.setColorFlags( options );

	if ( !( options.wt2wt || options.wt2html || options.html2wt || options.html2html || options.selser ) ) {
		options.wt2wt = true;
		options.wt2html = true;
		options.html2html = true;
		options.html2wt = true;
		if ( booleanOption( options['rewrite-blacklist'] ) ) {
			// turn on all modes by default for --rewrite-blacklist
			options.selser = true;
			// force use of the exhaustive changes file when creating blacklist.
			options.changesin = BLACKLIST_CHANGESIN;
		}
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
	options.expandExtensions = true;
	options.fetchConfig = false;

	var i, key, parsoidConfig = new ParsoidConfig( null, options ),
		iwmap = Object.keys( parsoidConfig.interwikiMap );

	for ( i = 0; i < iwmap.length; i++ ) {
		key = iwmap[i];
		parsoidConfig.interwikiMap[key] = 'http://localhost:7001/api.php';
	}

	// Create a new parser environment
	MWParserEnvironment.getParserEnv( parsoidConfig, null, 'en', null, function ( err, env ) {
		// For posterity: err will never be non-null here, because we expect the WikiConfig
		// to be basically empty, since the parserTests environment is very bare.
		this.env = env;
		this.env.errCB = function ( e ) {
			console.warn("ERROR: " + e);
			console.error( e.stack );
			process.exit(1);
		};

		this.env.conf.parsoid.editMode = options.editMode;

		// Enable <ref> and <references> tags since we want to
		// test Parsoid's native implementation of these tags.
		this.env.conf.wiki.addExtensionTag("ref");
		this.env.conf.wiki.addExtensionTag("references");

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
			this.parserPipeline = Util.getParserPipeline(this.env, 'text/x-mediawiki/full');
		}

		if ( booleanOption( options.blacklist ) && options.selser ) {
			if ( options.changesin &&
			     path.resolve( options.changesin ) ===
			     path.resolve( BLACKLIST_CHANGESIN ) ) {
				/* okay, everything's consistent. */
				/* jshint noempty: false */
			} else {
				console.error( "Turning off blacklist because custom "+
				               "changesin files is being used." );
				options.blacklist = false;
			}
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
	console.log( 'ParserTests running with node', process.version);
	console.log( 'Initialisation complete. Now launching tests.' );
};

/**
 * @method
 */
ParserTests.prototype.buildTasks = function ( item, modes, options ) {
	var tasks = [];
	for ( var i = 0; i < modes.length; i++ ) {
		if ( modes[i] === 'selser' && options.numchanges ) {
			if ( !item.selserChangeTrees ) {
				item.selserChangeTrees = new Array( options.numchanges );
			}

			var done = false;
			for ( var j = 0; j < item.selserChangeTrees.length; j++ ) {
				// we create the function in the loop but are careful to
				// bind loop variables i and j at function creation time
				/* jshint loopfunc: true */
				tasks.push( function ( modeIndex, changesIndex, cb ) {
					if (done) {
						process.nextTick( cb );
					} else {
						var newitem = Util.clone( item );
						newitem.seed = changesIndex + '';
						newitem.changes = item.selserChangeTrees[changesIndex];
						this.processTest( newitem, options, modes[modeIndex], function () {
							// No short-circuiting if we have changesin file passed in.
							// Process all change trees specified in that file.
							if (!options.changesin) {
								if ( this.isDuplicateChangeTree( item.selserChangeTrees, newitem.changes ) ) {
									// Once we get a duplicate change tree, we can no longer
									// generate and run new tests.  So, be done now!
									done = true;
								} else {
									item.selserChangeTrees[changesIndex] = newitem.changes;
								}
							}

							// Push the caches forward!
							item.cachedHTML = newitem.cachedHTML;
							item.cachedNormalizedHTML = newitem.cachedNormalizedHTML;
							item.cachedResultHTML = newitem.cachedResultHTML;

							process.nextTick( cb );
						}.bind( this ) );
					}
				}.bind( this, i, j ) );
			}
		} else {
			tasks.push( this.processTest.bind( this, item, options, modes[i] ) );
		}
	}
	return tasks;
};

/**
 * @method
 */
ParserTests.prototype.processCase = function ( i, options ) {
	var ix, item, cases = this.cases, targetModes = options.modes;

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
						this.comments = [];
						process.nextTick( nextCallback );
						break;
					}
					item.selserChangeTrees = ( this.changes || {} )[item.title];
					// Add comments to following test.
					item.comments = item.comments || this.comments;
					this.comments = [];

					if ( item.options.parsoid ) {
						// pegjs parser handles item options as follows:
						//   item option         value of item.options.parsoid
						//    <none>                      undefined
						//    parsoid                         ""
						//    parsoid=wt2html              "wt2html"
						//    parsoid=wt2html,wt2wt    ["wt2html","wt2wt"]
						if ( item.options.parsoid.constructor !== Array ) {
							// make a string into a 1-item array
							item.options.parsoid = [ item.options.parsoid ];
						}

						targetModes = targetModes.filter(function(mode) {
							return item.options.parsoid.indexOf( mode ) >= 0;
						});
					}

					if ( targetModes.length ) {
						async.series( this.buildTasks( item, targetModes, options ), nextCallback );
					} else {
						process.nextTick( nextCallback );
					}

					break;
				case 'comment':
					this.comments.push( item.comment );
					process.nextTick( nextCallback );
					break;
				case 'hooks':
					var hooks = item.text.split(/\n/), self = this;
					hooks.forEach(function(hook) {
						console.warn('parserTests: Adding extension hook ' +
							JSON.stringify(hook) );
						self.env.conf.wiki.addExtensionTag( hook );
					});
					process.nextTick( nextCallback );
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
					var changeTrees = cases[ci].selserChangeTrees || [];
					for (var j = 0, n = changeTrees.length; j < n; j++) {
						if (changeTrees[j] === undefined) {
							break;
						}
					}
					allChanges[cases[ci].title] = changeTrees.splice(0, j);
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

		// Kill the forked API, so we'll exit correctly.
		forkedAPI.kill();

		// update the blacklist, if requested
		if (booleanOption( options['rewrite-blacklist'] )) {
			var filename = __dirname+'/parserTests-blacklist.js';
			var shell = fs.readFileSync(filename, 'utf8').
				split(/^.*DO NOT REMOVE THIS LINE.*$/m);
			var contents = shell[0];
			contents += '// ### DO NOT REMOVE THIS LINE ### ';
			contents += '(start of automatically-generated section)\n';
			modes.forEach(function(mode) {
				contents += '\n// Blacklist for '+mode+'\n';
				this.stats.modes[mode].failList.forEach(function(title) {
					contents += 'add('+JSON.stringify(mode)+', '+
						JSON.stringify(title)+');\n';
				});
				contents += '\n';
			}.bind(this));
			contents += '// ### DO NOT REMOVE THIS LINE ### ';
			contents += '(end of automatically-generated section)';
			contents += shell[2];
			fs.writeFileSync(filename, contents, 'utf8');
		}

		// print out the summary
		// note: these stats won't necessarily be useful if someone
		// reimplements the reporting methods, since that's where we
		// increment the stats.
		var failures = options.reportSummary( this.stats );

		// we're done!
		if ( booleanOption( options['exit-zero'] ) ) {
			failures = false;
		}
		process.exit(failures ? 2 : 0); // exit status 1 == uncaught exception
	}
};

// Construct the ParserTests object and run the parser tests
var ptests = new ParserTests(), popts = ptests.getOpts();

// Note: Wrapping the XML output stuff in its own private world
// so it can have private counters and the like
/**
 * @class XMLParserTestsRunner
 *
 * Place for XML functions for the parserTests output.
 *
 * @singleton
 * @private
 */
var xmlFuncs = (function () {
	var fail, pass, passWhitelist,

	results = {
		html2html: '',
		wt2wt: '',
		wt2html: '',
		html2wt: ''
	},

	/**
	 * @method getActualExpectedXML
	 *
	 * Get the actual and expected outputs encoded for XML output.
	 *
	 * Side effect: Both objects will, after this, have 'formattedRaw' and 'formattedNormal' properties,
	 * which are the result of calling Util.formatHTML() on the 'raw' and 'normal' properties.
	 *
	 * @inheritdoc ParserTests#getActualExpected.
	 *
	 * @returns {string} The XML representation of the actual and expected outputs
	 */
	getActualExpectedXML = function ( actual, expected, getDiff ) {
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
	 * @method reportStartXML
	 *
	 * Report the start of the tests output.
	 */
	reportStartXML = function () {
		console.log( '<testsuites>' );
	},

	/**
	 * @method reportSummaryXML
	 *
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
	 * @method reportFailureXML
	 *
	 * Print a failure message for a test in XML.
	 *
	 * @inheritdoc ParserTests#printFailure
	 */
	reportFailureXML = function ( title, comments, iopts, options, actual, expected, expectFail, failure_only, mode, error ) {
		fail++;
		var failEle;

		if ( error ) {
			failEle = '<error type="somethingCrashedFail">\n';
			failEle += error.toString();
			failEle += '\n</error>\n';
		} else {
			failEle = '<failure type="parserTestsDifferenceInOutputFailure">\n';
			failEle += getActualExpectedXML( actual, expected, options.getDiff );
			failEle += '\n</failure>\n';
		}

		results[mode] += failEle;
	},

	/**
	 * @method reportSuccessXML
	 *
	 * Print a success method for a test in XML.
	 *
	 * @inheritdoc ParserTests#printSuccess
	 */
	reportSuccessXML = function ( title, options, mode, expectSuccess, isWhitelist, item ) {
		if ( isWhitelist ) {
			passWhitelist++;
		} else {
			pass++;
		}
	},

	/**
	 * @method reportResultXML
	 *
	 * Print the result of a test in XML.
	 *
	 * @inheritdoc ParserTests#printResult
	 */
	reportResultXML = function ( title, time, comments, iopts, expected, actual, options, mode, item ) {
		var timeTotal, testcaseEle;
		var quick = booleanOption( options.quick );
		var parsoidOnly = (iopts.parsoid !== undefined);

		if ( mode === 'selser' ) {
			title += ' ' + JSON.stringify( item.changes );
		}

		var whitelist = false;
		var expectFail = (testBlackList[title] || []).indexOf(mode) >= 0;
		var fail = ( expected.normal !== actual.normal );

		if ( fail &&
		     booleanOption( options.whitelist ) &&
		     title in testWhiteList &&
		     Util.normalizeOut( testWhiteList[title], parsoidOnly ) ===  actual.normal ) {
			whitelist = true;
			fail = false;
		}

		if ( mode === 'wt2wt' ) {
			item.wt2wtPassed = !fail;
			item.wt2wtResult = actual.raw;
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

		if ( fail ) {
			reportFailureXML( title, comments, iopts, options,
			                  actual, expected, expectFail,
			                  quick, mode, null, item );
		} else {
			reportSuccessXML( title, options, mode, !expectFail,
			                  whitelist, item );
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
})();

if ( popts && popts.xml ) {
	popts.reportResult = xmlFuncs.reportResult;
	popts.reportStart = xmlFuncs.reportStart;
	popts.reportSummary = xmlFuncs.reportSummary;
	popts.reportFailure = xmlFuncs.reportFailure;
	colors.mode = 'none';
}

ptests.main( popts );

} )();
