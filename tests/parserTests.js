#!/usr/bin/env node
/*
 * Parsoid test runner
 *
 * This pulls all the parserTests.txt items and runs them through Parsoid.
 */
"use strict";

/**
 * @class ParserTestModule
 * @private
 * @singleton
 */

require('../lib/core-upgrade.js');

var fs = require('fs'),
	path = require('path'),
	colors = require('colors'),
	Util = require( '../lib/mediawiki.Util.js' ).Util,
	DU = require('../lib/mediawiki.DOMUtils.js').DOMUtils,
	childProc = require('child_process'),
	fork = childProc.fork,
	DOMUtils = require( '../lib/mediawiki.DOMUtils.js' ).DOMUtils,
	async = require( 'async' ),
	PEG = require('pegjs'),
	Alea = require('alea'),
	// Handle options/arguments with optimist module
	optimist = require('optimist'),
	apiServer = require( './apiServer.js' );

// Fetch up some of our wacky parser bits...

var mp = '../lib/',
	MWParserEnvironment = require(mp + 'mediawiki.parser.environment.js').MWParserEnvironment,
	WikitextSerializer = require(mp + 'mediawiki.WikitextSerializer.js').WikitextSerializer,
	SelectiveSerializer = require( mp + 'mediawiki.SelectiveSerializer.js' ).SelectiveSerializer,
	ParsoidConfig = require( mp + 'mediawiki.ParsoidConfig' ).ParsoidConfig;

var booleanOption = Util.booleanOption; // shortcut

// Run a mock API in the background so we can request things from it
var mockAPIServer, mockAPIServerURL;

// track files imported / required
var fileDependencies = [];
var parserTestsUpToDate = true;

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
		if (Array.isArray(v)) {
			return v.map(ppValue).join(',');
		}
		if (typeof v !== 'string') {
			return JSON.stringify(v);
		}
		if (/^\[\[[^\]]*\]\]$/.test(v) ||
		    /^[-\w]+$/.test(v)) {
			return v;
		}
		return JSON.stringify(v);
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
	                    "Default options   : --wt2html --wt2wt --html2html --html2wt --whitelist --blacklist --color=auto"];

	return optimist.usage( 'Usage: $0 [options] [tests-file]\n\n' + default_args.join("\n"), Util.addStandardOptions({
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
		'changetree': {
			description: 'Changes to apply to parsed HTML to generate new HTML to be serialized (useful with selser)',
			'default': null,
			'boolean': false
		},
		'use_source': {
			description: 'Use original source in wt2wt tests',
			'boolean': true,
			'default': true
		},
		'numchanges': {
			description: 'Make multiple different changes to the DOM, run a selser test for each one.',
			'default': 20,
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
	},{
		// override defaults for standard options
		fetchTemplates: false,
		usephppreprocessor: false,
		fetchConfig: false
	})).check( function(argv) {
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
		console.warn("warning", "ParserTests.txt not up-to-date with upstream.");
	}

	// Startup by loading .txt test file
	var testFile;
	try {
		testFile = fs.readFileSync(this.testFileName, 'utf8');
		fileDependencies.push( this.testFileName );
	} catch (e) {
		this.env.log("error", e);
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
		return JSON.parse( cache_content.replace( /^.*\n/, '' ) );
	} else {
		// Write new file cache, content preprended with current digest
		this.env.log("error", "Cache file either not present or outdated");
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
		this.env.log("error", e);
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
	setImmediate( cb );
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
		this.env.page.dom = item.cachedHTMLStr ? DU.parseHTML(item.cachedHTMLStr).body : null;
		if ( mode === 'selser' ) {
			// console.warn("--> selsering: " + content.outerHTML);
			this.env.setPageSrcInfo( item.input );
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
		this.env.log("error", e);
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
 * @param {Array} allChanges Already-tried changes
 * @param {Array} change Candidate change
 * @returns {boolean}
 */
ParserTests.prototype.isDuplicateChangeTree = function ( allChanges, change ) {
	if ( !Array.isArray(allChanges) ) {
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

// Random string used as selser comment content
var staticRandomString = "ahseeyooxooZ8Oon0boh";

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

	var self = this;

	// Helper function for getting a random string
	function randomString() {
		return random().toString(36).slice(2);
	}

	function insertNewNode(n) {
		// Insert a text node, if not in a fosterable position.
		// If in foster position, enter a comment.
		// In either case, dom-diff should register a new node
		var str = randomString(),
			ownerDoc = n.ownerDocument,
			wrapperName,
			newNode;

		// For these container nodes, it would be buggy
		// to insert text nodes as children
		switch (n.parentNode.nodeName) {
			case 'OL':
			case 'UL': wrapperName = 'LI'; break;
			case 'DL': wrapperName = 'DD'; break;

			case 'TR':
				var prev = DU.getPrevElementSibling(n);
				if (prev) {
					// TH or TD
					wrapperName = prev.nodeName;
				} else {
					var next = DU.getNextElementSibling(n);
					if (next) {
						// TH or TD
						wrapperName = next.nodeName;
					} else {
						wrapperName = 'TD';
					}
				}
				break;
		}

		if (wrapperName) {
			newNode = ownerDoc.createElement(wrapperName);
			newNode.appendChild(ownerDoc.createTextNode(str));
		} else if (DOMUtils.isFosterablePosition(n)) {
			newNode = ownerDoc.createComment(str);
		} else {
			newNode = ownerDoc.createTextNode(str);
		}

		n.parentNode.insertBefore(newNode, n);
	}

	function removeNode(n) {
		n.parentNode.removeChild(n);
	}

	function applyChangesInternal(node, changes) {
		if (!node) {
			// FIXME: Generate change assignments dynamically
			self.env.log("error", "no node in applyChangesInternal, ",
					"HTML structure likely changed");
			return;
		}

		// Clone the array since it could be modified below
		var nodes = Util.clone(node.childNodes);

		for ( var i = 0; i < changes.length; i++ ) {
			var child = nodes[i],
				change = changes[i];

			if ( Array.isArray(change) ) {
				applyChangesInternal( child, change );
			} else {
				switch ( change ) {
					// No change
					case 0:
						break;

					// Change node wrapper
					// (sufficient to insert a random attr)
					case 1:
						if (DU.isElt(child)) {
							child.setAttribute( 'data-foobar', randomString() );
						} else {
							self.env.log("error", "Buggy changetree. changetype 1 (modify attribute) cannot be applied on text/comment nodes.");
						}
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

	// Keep the changes in the item object
	// to check for duplicates after the waterfall
	item.changes = changelist;

	if ( content.nodeType === content.DOCUMENT_NODE ) {
		content = content.body;
	}

	if (this.env.conf.parsoid.dumpFlags &&
		this.env.conf.parsoid.dumpFlags.indexOf("dom:post-changes") !== -1)
	{
		console.warn("-------------------------");
		console.warn("Original DOM: " + content.outerHTML);
		console.warn("-------------------------");
	}

	if (item.changes === 5) {
		// Hack so that we can work on the parent node rather than just the
		// children: Append a comment with known content. This is later
		// stripped from the output, and the result is compared to the
		// original wikitext rather than the non-selser wt2wt result.
		content.appendChild(content.ownerDocument.createComment(staticRandomString));
	} else if (item.changes !== 0) {
		applyChangesInternal(content, item.changes);
	}

	if (this.env.conf.parsoid.dumpFlags &&
		this.env.conf.parsoid.dumpFlags.indexOf("dom:post-changes") !== -1)
	{
		console.warn("Change tree: " + JSON.stringify(item.changes));
		console.warn("-------------------------");
		console.warn("DOM with changes applied: " + content.outerHTML);
		console.warn("-------------------------");
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
 * @param {Object} item
 * @param {Node} content
 * @param {Function} cb
 * @param {Error/null} cb.err
 * @param {Node} cb.content
 * @param {Array} cb.changelist
 */
ParserTests.prototype.generateChanges = function( options, item, content, cb ) {

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
		// - Entity spans are uneditable as well
		return (/\bmw:(Image|Entity)\b/).test(node.getAttribute('typeof')) ||
			(
				node.nodeName !== 'FIGCAPTION' &&
				node.parentNode &&
				node.parentNode.nodeName !== 'BODY' &&
				nodeIsUneditable(node.parentNode)
			);
	}

	function hasChangeMarkers(list) {
		// If all recorded changes are 0, then nothing has been modified
		return list.some(function(c) {
			return Array.isArray(c) ? hasChangeMarkers(c) : (c > 0);
		});
	}

	function genChangesInternal(item, node) {
		// Seed the random-number generator based on the item title
		var changelist = [],
			children = node.childNodes,
			n = children.length;

		for (var i = 0; i < n; i++) {
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

	var changeTree, numAttempts = 0;
	do {
		numAttempts++;
		changeTree = genChangesInternal(item, content);
	} while (
		numAttempts < 1000 &&
		(changeTree.length === 0 || self.isDuplicateChangeTree( item.selserChangeTrees, changeTree ))
	);

	if ( numAttempts === 1000 ) {
		// couldn't generate a change ... marking as such
		item.duplicateChange = true;
	}

	cb( null, content, changeTree );
};

/**
 * @method
 * @param {string} mode
 * @param {string} wikitext
 * @param {Function} processHtmlCB
 * @param {Error/null} processHtmlCB.err
 * @param {Node/null} processHtmlCB.doc
 */
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
	this.env.setPageSrcInfo( wikitext );
	this.parserPipeline.processToplevelDoc( wikitext );
};

/**
 * @method
 * @param {Object} item
 * @param {Object} options
 * @param {Function} endCb
 */
ParserTests.prototype.processTest = function ( item, options, mode, endCb ) {
	if ( !( 'title' in item ) ) {
		this.env.log("error", item);
		throw new Error( 'Missing title from test case.' );
	}
	if ( !( 'input' in item ) ) {
		this.env.log("error", item);
		throw new Error( 'Missing input from test case ' + item.title );
	}
	if ( !( 'result' in item ) ) {
		this.env.log("error", item);
		throw new Error( 'Missing input from test case ' + item.title );
	}

	item.time = {};

	var i, extensions = [];

	if ( item.options ) {

		if ( item.options.extensions !== undefined ) {
			extensions = item.options.extensions.split( ' ' );
		}

		if ( item.options.title !== undefined &&
		     !Array.isArray(item.options.title) ) {
			// Strip the [[]] markers.
			var title = item.options.title.replace( /^\[\[|\]\]$/g, '' );
			title = this.env.normalizeTitle( title, true );
			// This sets the page name as well as the relative link prefix
			// for the rest of the parse.
			this.env.reset( title );
		} else {
			// Since we are reusing the 'env' object, set it to Main Page
			// so that relative link prefix is back to "./"
			this.env.reset( "Main Page" );
		}

		if ( item.options.subpage !== undefined ) {
			this.env.conf.wiki.namespacesWithSubpages[0] = true;
		} else {
			this.env.conf.wiki.namespacesWithSubpages[0] = false;
		}

		this.env.conf.wiki.allowExternalImages = [ '' ]; // all allowed
		if ( item.options.wgallowexternalimages !== undefined &&
			 ! /^(1|true|)$/.test(item.options.wgallowexternalimages) ) {
			this.env.conf.wiki.allowExternalImages = undefined;
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

		setImmediate( endCb );
	}.bind( this );

	var testTasks = [];

	// Some useful booleans
	var startsAtWikitext = mode === 'wt2wt' || mode === 'wt2html' || mode === 'selser',
		startsAtHtml = mode === 'html2html' || mode === 'html2wt',
		endsAtWikitext = mode === 'wt2wt' || mode === 'selser' || mode === 'html2wt',
		endsAtHtml = mode === 'wt2html' || mode === 'html2html';

	// Source preparation
	if ( startsAtHtml ) {
		testTasks.push( function ( cb ) {
			var result = DU.parseHTML(item.result).body;
			cb( null, result );
		} );
	}

	// First conversion stage
	if ( startsAtWikitext ) {
		if ( item.cachedHTMLStr === null ) {
			testTasks.push( this.convertWt2Html.bind( this, mode, item.input ) );
			// Caching stage 1 - save the result of the first two stages so we can maybe skip them later
			testTasks.push( function ( result, cb ) {
				// Cache parsed HTML
				item.cachedHTMLStr = DU.serializeNode(result);
				cb( null, result );
			} );
		} else {
			testTasks.push( function ( cb ) {
				cb( null, DU.parseHTML(item.cachedHTMLStr) );
			} );
		}
	} else if ( startsAtHtml ) {
		testTasks.push(	this.convertHtml2Wt.bind( this, options, mode, item	) );
	}

	// Generate and make changes for the selser test mode
	if ( mode === 'selser' ) {
		if ( options.changetree ) {
			testTasks.push( function(content, cb) {
				cb( null, content, JSON.parse(options.changetree) );
			} );
		} else if (item.changetree) {
			testTasks.push( function(content, cb) {
				cb( null, content, item.changetree );
			} );
		} else {
			testTasks.push( this.generateChanges.bind( this, options, item ) );
		}
		testTasks.push( this.applyChanges.bind( this, item ) );

		// Save the modified DOM so we can re-test it later
		// Always serialize to string and reparse before passing to selser/wt2wt
		testTasks.push( function ( doc, cb ) {
			item.changedHTMLStr = DU.serializeNode(doc);
			doc = DU.parseHTML(item.changedHTMLStr).body;
			cb( null, doc );
		} );
	}

	// Always serialize DOM to string and reparse before passing to wt2wt
	if (mode === 'wt2wt') {
		testTasks.push( function ( doc, cb ) {
			cb( null, DU.parseHTML(DU.serializeNode(doc)).body);
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
	this.checkHTML( item, DU.serializeChildren(doc), options, mode );

	// Now schedule the next test, if any
	setImmediate( cb );
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
	var self = this;
	item.time.end = Date.now();

	if ( mode === 'selser' ) {
		if (item.changetree === 5) {
			item.resultWT = item.input;
		} else {
			this.convertHtml2Wt( options, 'wt2wt', item, DU.parseHTML(item.changedHTMLStr), function ( err, wt ) {
				if ( err === null ) {
					item.resultWT = wt;
				} else {
					item.resultWT = item.input;
				}
				// Check the result vs. the expected result.
				self.checkWikitext( item, wikitext, options, mode );

				// Now schedule the next test, if any
				setImmediate( cb );
			} );
			// Async processing
			return;
		}
	}
	// Sync processing
	// Check the result vs. the expected result.
	self.checkWikitext( item, wikitext, options, mode );

	// Now schedule the next test, if any
	setImmediate( cb );

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
	this.stats.modes[mode].failList.push({
		title: title,
		raw: actual ? actual.raw : null
	});

	var extTitle = ( title + ( mode ? ( ' (' + mode + ')' ) : '' ) ).
		replace('\n', ' ');

	var blacklisted = false;
	if ( booleanOption( options.blacklist ) && expectFail ) {
		// compare with remembered output
		if ( mode === 'selser' && !options.changetree && testBlackList[title].raw !== actual.raw ) {
			blacklisted = true;
		} else {
			if ( !booleanOption( options.quiet ) ) {
				console.log( 'EXPECTED FAIL'.red + ': ' + extTitle.yellow );
			}
			return;
		}
	}

	this.stats.failedTestsUnexpected++;
	this.stats.modes[mode].failedTestsUnexpected++;

	if ( !failure_only ) {
		console.log( '=====================================================' );
	}

	console.log( 'UNEXPECTED FAIL'.red.inverse + ': ' + extTitle.yellow );

	if ( mode === 'selser' ) {
		if ( blacklisted ) {
			console.log( 'Blacklisted, but the output changed!'.red + '');
		}
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
		this.env.log("error", error);
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
 * which are the result of calling DU.formatHTML() on the 'raw' and 'normal' properties.
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
	expected.formattedRaw = expected.isWT ? expected.raw : DU.formatHTML( expected.raw );
	returnStr += 'RAW EXPECTED'.cyan + ':';
	returnStr += expected.formattedRaw + '\n';

	actual.formattedRaw = actual.isWT ? actual.raw : DU.formatHTML( actual.raw );
	returnStr += 'RAW RENDERED'.cyan + ':';
	returnStr += actual.formattedRaw + '\n';

	expected.formattedNormal = expected.isWT ? expected.normal : DU.formatHTML( expected.normal );
	returnStr += 'NORMALIZED EXPECTED'.magenta + ':';
	returnStr += expected.formattedNormal + '\n';

	actual.formattedNormal = actual.isWT ? actual.normal : DU.formatHTML( actual.normal );
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
 * @param {Function} reportFailure
 * @param {Function} reportSuccess
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
 * @param {Object} item
 * @param {Function} pre
 * @param {Function} post
 */
function printResult( reportFailure, reportSuccess, title, time, comments, iopts, expected, actual, options, mode, item, pre, post ) {
	var quick = booleanOption( options.quick );
	var parsoidOnly = (iopts.parsoid !== undefined);

	if ( mode === 'selser' ) {
		title += ' ' + JSON.stringify( item.changes );
	}

	var whitelist = false;
	var tb = testBlackList[title];
	var expectFail = ( tb ? tb.modes : [] ).indexOf( mode ) >= 0;
	var fail = ( expected.normal !== actual.normal );

	if ( fail &&
	     booleanOption( options.whitelist ) &&
	     title in testWhiteList &&
	     DU.normalizeOut( testWhiteList[title], parsoidOnly ) ===  actual.normal ) {
		whitelist = true;
		fail = false;
	}

	if ( mode === 'wt2wt' ) {
		item.wt2wtPassed = !fail;
		item.wt2wtResult = actual.raw;
	}

	// don't report selser fails when nothing was changed or it's a dup
	if ( mode === 'selser' && ( item.changes === 0 || item.duplicateChange ) ) {
		return;
	}

	if ( typeof pre === 'function' ) {
		pre( mode, title, time );
	}

	if ( fail ) {
		reportFailure( title, comments, iopts, options, actual, expected, expectFail, quick, mode, null, item );
	} else {
		reportSuccess( title, options, mode, !expectFail, whitelist, item );
	}

	if ( typeof post === 'function' ) {
		post( mode );
	}
}

/**
 * @param {Object} item
 * @param {string} out
 * @param {Object} options
 */
ParserTests.prototype.checkHTML = function ( item, out, options, mode ) {
	var normalizedOut, normalizedExpected;
	var parsoidOnly = (item.options.parsoid !== undefined);

	normalizedOut = DU.normalizeOut( out, parsoidOnly );

	if ( item.cachedNormalizedHTML === null ) {
		if ( parsoidOnly ) {
			var normalDOM = DU.serializeChildren(DU.parseHTML( item.result ).body);
			normalizedExpected = DU.normalizeOut( normalDOM, parsoidOnly );
		} else {
			normalizedExpected = DU.normalizeHTML( item.result );
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
	out = out.replace(new RegExp('<!--' + staticRandomString + '-->', 'g'), '');
	if ( mode === 'selser' && item.resultWT !== null && item.changes !== 5 ) {
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
		console.log("==========================================================");
		console.warn("WARNING:".red +
		              " parserTests.txt not up-to-date with upstream.");
		console.warn("         Run fetch-parserTests.txt.js to update.");
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
		console.log("Additional dump options specific to parserTests script:");
		console.log("* dom:post-changes  : Dumps DOM after applying selser changetree\n");
		console.log("Examples");
		console.log("$ node parserTests --selser --filter '...' --dump dom:post-changes");
		console.log("$ node parserTests --selser --filter '...' --changetree '...' --dump dom:post-changes\n");
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
			// sanity checking (bug 51448 asks to be able to use --filter here)
			if ( options.filter || options.maxtests ) {
				this.env.log("error", "can't combine --rewrite-blacklist with --filter or --maxtests");
				process.exit( 1 );
			}
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
		// see printResult for documentation of the default.
		options.reportResult = printResult.bind( this, options.reportFailure, options.reportSuccess );
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
			var errors = ["--filter was given an invalid regular expression."];
			errors.push("See below for JS engine error:\n" + e + "\n");
			this.env.log("fatal", errors);
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
		this.env.log("error", e2);
	}

	this.cases = this.getTests( options ) || [];

	if ( options.maxtests ) {
		var n = Number( options.maxtests );
		this.env.log("warning", "maxtests:", n);
		if ( n > 0 ) {
			this.cases.length = n;
		}
	}

	options.expandExtensions = true;

	var i, key, parsoidConfig = new ParsoidConfig( null, options ),
		iwmap = Object.keys( parsoidConfig.interwikiMap );
	Util.setTemplatingAndProcessingFlags( parsoidConfig, options );

	for ( i = 0; i < iwmap.length; i++ ) {
		key = iwmap[i];
		parsoidConfig.interwikiMap[key] = mockAPIServerURL;
	}


	// Create a new parser environment
	MWParserEnvironment.getParserEnv( parsoidConfig, null, 'enwiki', null, null, function ( err, env ) {
		// For posterity: err will never be non-null here, because we expect the WikiConfig
		// to be basically empty, since the parserTests environment is very bare.
		this.env = env;

		if (booleanOption( options.quiet )) {
			this.env.logger.changeLogLevels("fatal", "error");
		}

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
		if ( options.html2wt ) {
			options.modes.push( 'html2wt' );
		}
		if ( options.html2html ) {
			options.modes.push( 'html2html' );
		}
		if ( options.selser ) {
			options.modes.push( 'selser' );
		}

		// Create parsers, serializers, ..
		if ( options.html2html || options.wt2wt || options.wt2html || options.selser ) {
			this.parserPipeline = this.env.pipelineFactory.getPipeline('text/x-mediawiki/full');
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
	console.log( 'Initialization complete. Now launching tests.' );
};

/**
 * FIXME: clean up this mess!
 * - generate all changes at once (generateChanges should return a tree
 *   really) rather than going to all these lengths of interleaving change
 *   generation with tests
 * - set up the changes in item directly rather than juggling around with
 *   indexes etc
 * - indicate whether to compare to wt2wt or the original input
 * - maybe make a full selser test one method that uses others rather than the
 *   current chain of methods that sometimes do something for selser
 *
 * @method
 */
ParserTests.prototype.buildTasks = function ( item, modes, options ) {
	var tasks = [],
		self = this;
	for ( var i = 0; i < modes.length; i++ ) {
		if ( modes[i] === 'selser' && options.numchanges && !options.changetree ) {
			item.selserChangeTrees = new Array( options.numchanges );
			var newitem;

			// Prepend a selser test that appends a comment to the root node
			tasks.push( function ( cb ) {
				newitem = Util.clone(item);
				newitem.changetree = 5;
				self.processTest( newitem, options, 'selser', function() {
					setImmediate(cb);
				});
			});

			var done = false;
			for ( var j = 0; j < item.selserChangeTrees.length; j++ ) {
				// we create the function in the loop but are careful to
				// bind loop variables i and j at function creation time
				/* jshint loopfunc: true */
				tasks.push( function ( modeIndex, changesIndex, cb ) {
					if (done) {
						setImmediate( cb );
					} else {
						newitem = Util.clone( item );
						newitem.seed = changesIndex + '';
						this.processTest( newitem, options, modes[modeIndex], function () {
							if ( this.isDuplicateChangeTree( item.selserChangeTrees, newitem.changes ) ) {
								// Once we get a duplicate change tree, we can no longer
								// generate and run new tests.  So, be done now!
								done = true;
							} else {
								item.selserChangeTrees[changesIndex] = newitem.changes;
							}

							// Push the caches forward!
							item.cachedHTMLStr = newitem.cachedHTMLStr;
							item.cachedNormalizedHTML = newitem.cachedNormalizedHTML;

							setImmediate( cb );
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
		item.cachedHTMLStr = null;
		item.cachedNormalizedHTML = null;

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
						setImmediate( nextCallback );
						break;
					}
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
						if ( !Array.isArray(item.options.parsoid) ) {
							// make a string into a 1-item array
							item.options.parsoid = [ item.options.parsoid ];
						}

						// Avoid filtering out the selser test
						if ( options.selser &&
							item.options.parsoid.indexOf( "selser" ) < 0 &&
							item.options.parsoid.indexOf( "wt2wt" ) >= 0
						) {
							item.options.parsoid.push( "selser" );
						}

						targetModes = targetModes.filter(function(mode) {
							return item.options.parsoid.indexOf( mode ) >= 0;
						});
					}

					if ( targetModes.length ) {

						// Honor language option in parserTests.txt
						var prefix = item.options.language || 'enwiki';
						if (!/wiki/.test(prefix)) {
							// Convert to our enwiki.. format
							prefix = prefix + 'wiki';
						}
						this.env.switchToConfig( prefix, function( err ) {
							if ( err ) {
								return this.env.log("fatal", err);
							}

							// TODO: set language variant
							// adjust config to match that used for PHP tests
							// see core/tests/parser/parserTest.inc:setupGlobals() for
							// full set of config normalizations done.
							var wikiConf = this.env.conf.wiki;
							wikiConf.fakeTimestamp = 123;
							wikiConf.timezoneOffset = 0; // force utc for parsertests
							wikiConf.server = 'http://example.org';
							wikiConf.wgScriptPath = '/';
							wikiConf.script = '/index.php';
							wikiConf.articlePath = '/wiki/$1';
							// this has been updated in the live wikis, but the parser tests
							// expect the old value (as set in parserTest.inc:setupDatabase())
							wikiConf.interwikiMap.meatball =
								Util.clone(wikiConf.interwikiMap.meatball);
							wikiConf.interwikiMap.meatball.url =
								'http://www.usemod.com/cgi-bin/mb.pl?$1';
							// Add 'MemoryAlpha' namespace (bug 51680)
							this.env.conf.wiki.namespaceNames['100'] = 'MemoryAlpha';
							this.env.conf.wiki.namespaceIds.memoryalpha =
								this.env.conf.wiki.canonicalNamespaces.memoryalpha = 100;

							async.series( this.buildTasks( item, targetModes, options ),
								nextCallback );
						}.bind( this ) );

					} else {
						setImmediate( nextCallback );
					}

					break;
				case 'comment':
					this.comments.push( item.comment );
					setImmediate( nextCallback );
					break;
				case 'hooks':
					var hooks = item.text.split(/\n/), self = this;
					hooks.forEach(function(hook) {
						this.env.log("warning", "parserTests: Adding extension hook", JSON.stringify(hook));
						self.env.conf.wiki.addExtensionTag( hook );
					});
					setImmediate( nextCallback );
					break;
				case 'functionhooks':
					this.env.log("warning", "parserTests: Unhandled functionhook", JSON.stringify(item));
					break;
				default:
					this.comments = [];
					setImmediate( nextCallback );
					break;
			}
		} else {
			setImmediate( nextCallback );
		}
	} else {

		// Kill the forked API, so we'll exit correctly.
		// SSS: Is this still required in this new version?
		mockAPIServer.kill();

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
				this.stats.modes[mode].failList.forEach(function(fail) {
					contents += 'add('+JSON.stringify(mode)+', '+
						JSON.stringify(fail.title);
					contents += ', '+JSON.stringify(fail.raw);
					contents += ');\n';
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
	 * which are the result of calling DU.formatHTML() on the 'raw' and 'normal' properties.
	 *
	 * @inheritdoc ParserTests#getActualExpected.
	 *
	 * @returns {string} The XML representation of the actual and expected outputs
	 */
	getActualExpectedXML = function ( actual, expected, getDiff ) {
		var returnStr = '';

		expected.formattedRaw = DU.formatHTML( expected.raw );
		actual.formattedRaw = DU.formatHTML( actual.raw );
		expected.formattedNormal = DU.formatHTML( expected.normal );
		actual.formattedNormal = DU.formatHTML( actual.normal );

		returnStr += 'RAW EXPECTED:\n';
		returnStr += DU.encodeXml( expected.formattedRaw ) + '\n\n';

		returnStr += 'RAW RENDERED:\n';
		returnStr += DU.encodeXml( actual.formattedRaw ) + '\n\n';

		returnStr += 'NORMALIZED EXPECTED:\n';
		returnStr += DU.encodeXml( expected.formattedNormal ) + '\n\n';

		returnStr += 'NORMALIZED RENDERED:\n';
		returnStr += DU.encodeXml( actual.formattedNormal ) + '\n\n';

		returnStr += 'DIFF:\n';
		returnStr += DU.encodeXml ( getDiff( actual, expected, false ) );

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
	 * @inheritdoc printResult
	 */
	reportResultXML = function () {

		function pre( mode, title, time ) {
			var testcaseEle;
			testcaseEle = '<testcase name="' + DU.encodeXml( title ) + '" ';
			testcaseEle += 'assertions="1" ';

			var timeTotal;
			if ( time && time.end && time.start ) {
				timeTotal = time.end - time.start;
				if ( !isNaN( timeTotal ) ) {
					testcaseEle += 'time="' + ( ( time.end - time.start ) / 1000.0 ) + '"';
				}
			}

			testcaseEle += '>';
			results[mode] += testcaseEle;
		}

		function post( mode ) {
			results[mode] += '</testcase>\n';
		}

		var args = Array.prototype.slice.call( arguments );
		args = [ reportFailureXML, reportSuccessXML ].concat( args, pre, post );
		printResult.apply( this, args );

	};

	return {
		reportResult: reportResultXML,
		reportStart: reportStartXML,
		reportSummary: reportSummaryXML,
		reportSuccess: reportSuccessXML,
		reportFailure: reportFailureXML
	};
})();

// Construct the ParserTests object and run the parser tests
var ptests = new ParserTests();
var popts  = ptests.getOpts();

if ( popts && popts.xml ) {
	popts.reportResult = xmlFuncs.reportResult;
	popts.reportStart = xmlFuncs.reportStart;
	popts.reportSummary = xmlFuncs.reportSummary;
	popts.reportFailure = xmlFuncs.reportFailure;
	colors.mode = 'none';
}

// Start the mock api server and kick off parser tests
apiServer.startMockAPIServer({quiet: popts.quiet, port: 7001 }, function(url, server) {
	mockAPIServerURL = url;
	mockAPIServer = server;
	ptests.main(popts);
});
