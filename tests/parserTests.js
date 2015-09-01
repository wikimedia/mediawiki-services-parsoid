#!/usr/bin/env node
/*
 * Parsoid test runner
 *
 * This pulls all the parserTests.txt items and runs them through Parsoid.
 */
'use strict';
require('../lib/core-upgrade.js');

/**
 * @class ParserTestModule
 * @private
 * @singleton
 */

var apiServer = require('./apiServer.js');
var async = require('async');
var colors = require('colors');
var childProc = require('child_process');
var fork = childProc.fork;
var fs = require('fs');
var path = require('path');
var yargs = require('yargs');
var Alea = require('alea');
var DU = require('../lib/mediawiki.DOMUtils.js').DOMUtils;
var ParsoidLogger = require('../lib/ParsoidLogger.js').ParsoidLogger;
var PEG = require('pegjs');
var Util = require('../lib/mediawiki.Util.js').Util;
var Diff = require('../lib/mediawiki.Diff.js').Diff;

// Fetch up some of our wacky parser bits...
var MWParserEnvironment = require('../lib/mediawiki.parser.environment.js').MWParserEnvironment;
var ParsoidConfig = require('../lib/mediawiki.ParsoidConfig').ParsoidConfig;

var booleanOption = Util.booleanOption; // shortcut

// Run a mock API in the background so we can request things from it
var mockAPIServer, mockAPIServerURL;

// track files imported / required
var fileDependencies = [];
var parserTestsUpToDate = true;

var exitUnexpected = new Error('unexpected failure');  // unique marker value

// Our code...

/**
 * @method
 *
 * Colorize given number if <> 0
 *
 * @param {number} count
 * @param {string} color
 */
var colorizeCount = function(count, color) {
	if (count === 0) {
		return count;
	}

	// We need a string to use colors methods
	count = count.toString();

	// FIXME there must be a wait to call a method by its name
	if (count[color]) {
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
 *
 * Main class for the test environment.
 *
 * @singleton
 * @private
 */
function ParserTests() {
	var i;

	this.cacheFile = "parserTests.cache"; // Name of file used to cache the parser tests cases
	this.parserTestsFile = "parserTests.txt";
	this.testsChangesFile = 'changes.txt';

	this.articles = {};
	this.tests = new Set();

	// Test statistics
	this.stats = {};
	this.stats.passedTests = 0;
	this.stats.passedTestsWhitelisted = 0;
	this.stats.passedTestsUnexpected = 0;
	this.stats.failedTests = 0;
	this.stats.failedTestsUnexpected = 0;

	var newModes = {};

	for (i = 0; i < modes.length; i++) {
		newModes[modes[i]] = Util.clone(this.stats);
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
		if (/^\[\[[^\]]*\]\]$/.test(v) || /^[-\w]+$/.test(v)) {
			return v;
		}
		return JSON.stringify(v);
	};
	return Object.keys(iopts).map(function(k) {
		if (iopts[k] === '') { return k; }
		return k + '=' + ppValue(iopts[k]);
	}).join(' ');
};


/**
 * @method
 *
 * Get the options from the command line.
 *
 * @return {Object}
 */
ParserTests.prototype.getOpts = function() {

	var standardOpts = Util.addStandardOptions({
		'wt2html': {
			description: 'Wikitext -> HTML(DOM)',
			'default': false,
			'boolean': true,
		},
		'html2wt': {
			description: 'HTML(DOM) -> Wikitext',
			'default': false,
			'boolean': true,
		},
		'wt2wt': {
			description: 'Roundtrip testing: Wikitext -> DOM(HTML) -> Wikitext',
			'default': false,
			'boolean': true,
		},
		'html2html': {
			description: 'Roundtrip testing: HTML(DOM) -> Wikitext -> HTML(DOM)',
			'default': false,
			'boolean': true,
		},
		'selser': {
			description: 'Roundtrip testing: Wikitext -> DOM(HTML) -> Wikitext (with selective serialization). ' +
				'Set to "noauto" to just run the tests with manual selser changes.',
			'default': false,
			'boolean': true,
		},
		'changetree': {
			description: 'Changes to apply to parsed HTML to generate new HTML to be serialized (useful with selser)',
			'default': null,
			'boolean': false,
		},
		'use_source': {
			description: 'Use original source in wt2wt tests',
			'boolean': true,
			'default': true,
		},
		'numchanges': {
			description: 'Make multiple different changes to the DOM, run a selser test for each one.',
			'default': 20,
			'boolean': false,
		},
		'cache': {
			description: 'Get tests cases from cache file ' + this.cacheFile,
			'boolean': true,
			'default': false,
		},
		'filter': {
			description: 'Only run tests whose descriptions match given string',
		},
		'regex': {
			description: 'Only run tests whose descriptions match given regex',
			alias: ['regexp', 're'],
		},
		'run-disabled': {
			description: 'Run disabled tests',
			'default': false,
			'boolean': true,
		},
		'run-php': {
			description: 'Run php-only tests',
			'default': false,
			'boolean': true,
		},
		'maxtests': {
			description: 'Maximum number of tests to run',
			'boolean': false,
		},
		'quick': {
			description: 'Suppress diff output of failed tests',
			'boolean': true,
			'default': false,
		},
		'quiet': {
			description: 'Suppress notification of passed tests (shows only failed tests)',
			'boolean': true,
			'default': false,
		},
		'whitelist': {
			description: 'Compare against manually verified parser output from whitelist',
			'default': true,
			'boolean': true,
		},
		'printwhitelist': {
			description: 'Print out a whitelist entry for failing tests. Default false.',
			'default': false,
			'boolean': true,
		},
		'blacklist': {
			description: 'Compare against expected failures from blacklist',
			'default': true,
			'boolean': true,
		},
		'rewrite-blacklist': {
			description: 'Update parserTests-blacklist.js with failing tests.',
			'default': false,
			'boolean': true,
		},
		'exit-zero': {
			description: "Don't exit with nonzero status if failures are found.",
			'default': false,
			'boolean': true,
		},
		xml: {
			description: 'Print output in JUnit XML format.',
			'default': false,
			'boolean': true,
		},
		'exit-unexpected': {
			description: 'Exit after the first unexpected result.',
			'default': false,
			'boolean': true,
		},
		'update-tests': {
			description: 'Update parserTests.txt with results from wt2html fails.',
			'default': false,
			'boolean': true,
		},
		'update-unexpected': {
			description: 'Update parserTests.txt with results from wt2html unexpected fails.',
			'default': false,
			'boolean': true,
		},
	}, {
		// override defaults for standard options
		fetchTemplates: false,
		usephppreprocessor: false,
		fetchConfig: false,
	});

	var defaultArgs = [
		"Default tests-file: " + this.parserTestsFile,
		"Default options   : --wt2html --wt2wt --html2html --html2wt --whitelist --blacklist --color=auto",
	];

	return yargs.usage(
		'Usage: $0 [options] [tests-file]\n\n' + defaultArgs.join("\n"),
		standardOpts
	).check(function(argv, aliases) {
		Util.checkUnknownArgs(standardOpts, argv, aliases);
		if (argv.filter === true) {
			throw "--filter needs an argument";
		}
		if (argv.regex === true) {
			throw "--regex needs an argument";
		}
	});
};

/**
 * @method
 *
 * Get an object holding our tests cases. Eventually from a cache file
 *
 * @param {Object} argv
 * @return {Object}
 */
ParserTests.prototype.getTests = function(argv) {
	// double check that test file is up-to-date with upstream
	var fetcher = require(__dirname + "/fetch-parserTests.txt.js");
	if (!fetcher.isUpToDate()) {
		parserTestsUpToDate = false;
		console.warn("warning", "ParserTests.txt not up-to-date with upstream.");
	}

	// Startup by loading .txt test file
	var testFile;
	try {
		testFile = fs.readFileSync(this.testFileName, 'utf8');
		fileDependencies.push(this.testFileName);
	} catch (e) {
		console.error(e);
	}
	// parser grammar is also a dependency
	fileDependencies.push(this.testParserFileName);

	if (!booleanOption(argv.cache)) {
		// Cache not wanted, parse file and return object
		return this.parseTestCase(testFile);
	}

	// Find out modification time of all files dependencies and then hash those
	// to make a unique value using sha1.
	var mtimes = fileDependencies.sort().map(function(file) {
		return fs.statSync(file).mtime;
	}).join('|');

	var sha1 = require('crypto')
		.createHash('sha1')
		.update(mtimes)
		.digest('hex');

	var cacheFileName = __dirname + '/' + this.cacheFile;
	// Look for a cacheFile
	var cacheContent;
	var cacheFileDigest;
	try {
		cacheContent = fs.readFileSync(cacheFileName, 'utf8');
		// Fetch previous digest
		cacheFileDigest = cacheContent.match(/^CACHE: (\w+)\n/)[1];
	} catch (e4) {
		// cache file does not exist
	}

	if (cacheFileDigest === sha1) {
		// cache file match our digest.
		// Return contained object after removing first line (CACHE: <sha1>)
		return JSON.parse(cacheContent.replace(/^.*\n/, ''));
	} else {
		// Write new file cache, content preprended with current digest
		console.error("Cache file either not present or outdated");
		var parse = this.parseTestCase(testFile);
		if (parse !== undefined) {
			fs.writeFileSync(cacheFileName,
				"CACHE: " + sha1 + "\n" + JSON.stringify(parse),
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
 * @return {Array}
 */
ParserTests.prototype.parseTestCase = function(content) {
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
ParserTests.prototype.processArticle = function(item, cb) {
	var norm = this.env.normalizeTitle(item.title);
	var err = null;
	if (this.articles.hasOwnProperty(norm)) {
		err = new Error('Duplicate article: ' + item.title);
	} else {
		this.articles[norm] = item.text;
	}
	setImmediate(cb, err);
};

/**
 * @method
 *
 * Convert a DOM to Wikitext.
 *
 * @param {Object} options
 * @param {string} mode
 * @param {Object} item
 * @param {Node} body
 * @param {Function} processWikitextCB
 * @param {Error|null} processWikitextCB.err
 * @param {string|null} processWikitextCB.res
 */
ParserTests.prototype.convertHtml2Wt = function(options, mode, item, body, processWikitextCB) {
	var startsAtWikitext = mode === 'wt2wt' || mode === 'wt2html' || mode === 'selser';
	var self = this;
	var cb = function(err, wt) {
		self.env.setPageSrcInfo(null);
		self.env.page.dom = null;
		self.env.page.editedDoc = null;
		processWikitextCB(err, wt);
	};
	try {
		if (startsAtWikitext) {
			// FIXME: All tests share an env.
			// => we need to initialize this each time over here.
			this.env.page.dom = item.cachedBODY;
			this.env.page.editedDoc = item.cachedBODY.ownerDoc;
		}
		if (mode === 'selser') {
			// console.warn("--> selsering: " + body.outerHTML);
			this.env.setPageSrcInfo(item.wikitext);
		} else if (booleanOption(options.use_source) && startsAtWikitext) {
			this.env.setPageSrcInfo(item.wikitext);
		} else {
			this.env.setPageSrcInfo(null);
		}
		DU.serializeDOM(this.env, body, (mode === 'selser'), cb);
	} catch (err) {
		cb(err, null);
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
 * @return {boolean}
 */
ParserTests.prototype.isDuplicateChangeTree = function(allChanges, change) {
	if (!Array.isArray(allChanges)) {
		return false;
	}

	var i;
	for (i = 0; i < allChanges.length; i++) {
		if (Util.deepEquals(allChanges[i], change)) {
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
 * @param {Node} body
 * @param {Array} changelist
 * @param {Function} cb
 * @param {Error} cb.err
 * @param {Node} cb.body
 */
ParserTests.prototype.applyChanges = function(item, body, changelist, cb) {
	var self = this;

	// Helper function for getting a random string
	function randomString() {
		return random().toString(36).slice(2);
	}

	function insertNewNode(n) {
		// Insert a text node, if not in a fosterable position.
		// If in foster position, enter a comment.
		// In either case, dom-diff should register a new node
		var str = randomString();
		var ownerDoc = n.ownerDocument;
		var wrapperName;
		var newNode;

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
			case 'BODY': wrapperName = 'P'; break;
			default:
				if (DU.isBlockNodeWithVisibleWT(n)) {
					wrapperName = 'P';
				}
				break;
		}

		if (DU.isFosterablePosition(n) && n.parentNode.nodeName !== 'TR') {
			newNode = ownerDoc.createComment(str);
		} else if (wrapperName) {
			newNode = ownerDoc.createElement(wrapperName);
			newNode.appendChild(ownerDoc.createTextNode(str));
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

		for (var i = 0; i < changes.length; i++) {
			var child = nodes[i];
			var change = changes[i];

			if (Array.isArray(change)) {
				applyChangesInternal(child, change);
			} else {
				switch (change) {
					// No change
					case 0:
						break;

					// Change node wrapper
					// (sufficient to insert a random attr)
					case 1:
						if (DU.isElt(child)) {
							child.setAttribute('data-foobar', randomString());
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
	var random = new Alea((item.seed || '') + (item.title || ''));

	// Keep the changes in the item object
	// to check for duplicates after the waterfall
	item.changes = changelist;

	if (this.env.conf.parsoid.dumpFlags &&
		this.env.conf.parsoid.dumpFlags.indexOf("dom:post-changes") !== -1) {
		console.warn("-------------------------");
		console.warn("Original DOM: " + body.outerHTML);
		console.warn("-------------------------");
	}

	if (item.changes === 5) {
		// Hack so that we can work on the parent node rather than just the
		// children: Append a comment with known content. This is later
		// stripped from the output, and the result is compared to the
		// original wikitext rather than the non-selser wt2wt result.
		body.appendChild(body.ownerDocument.createComment(staticRandomString));
	} else if (item.changes !== 0) {
		applyChangesInternal(body, item.changes);
	}

	if (this.env.conf.parsoid.dumpFlags &&
		this.env.conf.parsoid.dumpFlags.indexOf("dom:post-changes") !== -1) {
		console.warn("Change tree : " + JSON.stringify(item.changes));
		console.warn("-------------------------");
		console.warn("Edited DOM  : " + body.outerHTML);
		console.warn("-------------------------");
	}

	if (cb) {
		cb(null, body);
	}
};

/**
 * @method
 *
 * Generate a change object for a document, so we can apply it during a selser test.
 *
 * @param {Object} options
 * @param {Object} item
 * @param {Node} body
 * @param {Function} cb
 * @param {Error|null} cb.err
 * @param {Node} cb.body
 * @param {Array} cb.changelist
 */
ParserTests.prototype.generateChanges = function(options, item, body, cb) {
	var self = this;
	var random = new Alea((item.seed || '') + (item.title || ''));

	/**
	 * If no node in the DOM subtree rooted at 'node' is editable in the VE,
	 * this function should return false.
	 *
	 * Currently true for template and extension content, and for entities.
	 */
	function domSubtreeIsEditable(env, node) {
		return !DU.isTplOrExtToplevelNode(node) &&
			!(DU.isElt(node) && node.getAttribute("typeof") === "mw:Entity");
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
		if (!DU.isElt(node)) {
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
		var changelist = [];
		var children = node.childNodes;
		var n = children.length;

		for (var i = 0; i < n; i++) {
			var child = children[i];
			var changeType = 0;

			if (domSubtreeIsEditable(self.env, child)) {
				if (nodeIsUneditable(child) || random() < 0.5) {
					changeType = genChangesInternal(
						// ensure the subtree has a seed
						{ seed: '' + random.uint32() },
						child);
				} else {
					if (!child.setAttribute) {
						// Text or comment node -- valid changes: 2, 3, 4
						// since we cannot set attributes on these
						changeType = Math.floor(random() * 3) + 2;
					} else {
						changeType = Math.floor(random() * 4) + 1;
					}
				}
			}

			changelist.push(changeType);
		}

		return hasChangeMarkers(changelist) ? changelist : 0;
	}

	var changeTree;
	var numAttempts = 0;
	do {
		numAttempts++;
		changeTree = genChangesInternal(item, body);
	} while (
		numAttempts < 1000 &&
		(changeTree.length === 0 || self.isDuplicateChangeTree(item.selserChangeTrees, changeTree))
	);

	if (numAttempts === 1000) {
		// couldn't generate a change ... marking as such
		item.duplicateChange = true;
	}

	cb(null, body, changeTree);
};

ParserTests.prototype.applyManualChanges = function(body, changes, cb) {
	var err = null;
	// changes are specified using jquery methods.
	//  [x,y,z...] becomes $(x)[y](z....)
	// that is, ['fig', 'attr', 'width', '120'] is interpreted as
	//   $('fig').attr('width', '120')
	// See http://api.jquery.com/ for documentation of these methods.
	// "contents" as second argument calls the jquery .contents() method
	// on the results of the selector in the first argument, which is
	// a good way to get at the text and comment nodes
	var jquery = {
		after: function(html) {
			var div = this.ownerDocument.createElement('div');
			div.innerHTML = html;
			DU.migrateChildren(div, this.parentNode, this.nextSibling);
		},
		attr: function(name, val) {
			this.setAttribute(name, val);
		},
		before: function(html) {
			var div = this.ownerDocument.createElement('div');
			div.innerHTML = html;
			DU.migrateChildren(div, this.parentNode, this);
		},
		removeAttr: function(name) {
			this.removeAttribute(name);
		},
		removeClass: function(c) {
			this.classList.remove(c);
		},
		addClass: function(c) {
			this.classList.add(c);
		},
		text: function(t) {
			this.textContent = t;
		},
		html: function(h) {
			this.innerHTML = h;
		},
		remove: function(optSelector) {
			// jquery lets us specify an optional selector to further
			// restrict the removed elements.
			// text nodes don't have the "querySelectorAll" method, so
			// just include them by default (jquery excludes them, which
			// is less useful)
			var what = !optSelector ? [ this ] :
				!DU.isElt(this) ? [ this ] /* text node hack! */ :
				this.querySelectorAll(optSelector);
			Array.prototype.forEach.call(what, function(node) {
				if (node.parentNode) { node.parentNode.removeChild(node); }
			});
		},
		empty: function() {
			while (this.firstChild) {
				this.removeChild(this.firstChild);
			}
		},
	};

	changes.forEach(function(change) {
		if (err) { return; }
		if (change.length < 2) {
			err = new Error('bad change: ' + change);
			return;
		}
		// use document.querySelectorAll as a poor man's $(...)
		var els = body.querySelectorAll(change[0]);
		if (!els.length) {
			err = new Error(change[0] + ' did not match any elements: ' + body.outerHTML);
			return;
		}
		if (change[1] === 'contents') {
			change = change.slice(1);
			els = Array.prototype.reduce.call(els, function(acc, el) {
				acc.push.apply(acc, el.childNodes);
				return acc;
			}, []);
		}
		var fun = jquery[change[1]];
		if (!fun) {
			err = new Error('bad mutator function: ' + change[1]);
			return;
		}
		Array.prototype.forEach.call(els, function(el) {
			fun.apply(el, change.slice(2));
		});
	});
	if (err) { console.log(err.toString().red); }
	cb(err, body);
};

/**
 * @method
 * @param {string} mode
 * @param {string} wikitext
 * @param {Function} processHtmlCB
 * @param {Error|null} processHtmlCB.err
 * @param {Node|null} processHtmlCB.doc
 */
ParserTests.prototype.convertWt2Html = function(mode, wikitext, processHtmlCB) {
	this.env.setPageSrcInfo(wikitext);
	this.parserPipeline.once('document', function(doc) {
		// processHtmlCB can be asynchronous, so deep-clone
		// document before invoking it. (the parser pipeline
		// will attempt to reuse the document after this
		// event is emitted)
		processHtmlCB(null, doc.body.cloneNode(true));
	});
	this.parserPipeline.processToplevelDoc(wikitext);
};

/**
 * @method
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @param {Function} endCb
 */
ParserTests.prototype.processTest = function(item, options, mode, endCb) {
	if (!('title' in item)) {
		return endCb(new Error('Missing title from test case.'));
	}

	item.time = {};

	var i;
	var extensions = [];

	if (item.options) {

		if (item.options.extensions !== undefined) {
			extensions = item.options.extensions.split(' ');
		}

		if (item.options.title !== undefined &&
			!Array.isArray(item.options.title)) {
			// Strip the [[]] markers.
			var title = item.options.title.replace(/^\[\[|\]\]$/g, '');
			title = this.env.normalizeTitle(title, true);
			// This sets the page name as well as the relative link prefix
			// for the rest of the parse.
			this.env.initializeForPageName(title);
		} else {
			// Since we are reusing the 'env' object, set it to the default
			// so that relative link prefix is back to "./"
			this.env.initializeForPageName(this.env.defaultPageName);
		}

		if (item.options.subpage !== undefined) {
			this.env.conf.wiki.namespacesWithSubpages[0] = true;
		} else {
			this.env.conf.wiki.namespacesWithSubpages[0] = false;
		}

		this.env.conf.wiki.allowExternalImages = [ '' ]; // all allowed
		if (item.options.wgallowexternalimages !== undefined &&
				!/^(1|true|)$/.test(item.options.wgallowexternalimages)) {
			this.env.conf.wiki.allowExternalImages = undefined;
		}

		this.env.scrubWikitext = item.options.parsoid &&
			item.options.parsoid.hasOwnProperty('scrubWikitext') ?
				item.options.parsoid.scrubWikitext :
				MWParserEnvironment.prototype.scrubWikitext;
	}

	item.extensions = extensions;
	for (i = 0; i < extensions.length; i++) {
		this.env.conf.wiki.addExtensionTag(extensions[i]);
	}

	// Build a list of tasks for this test that will be passed to async.waterfall
	var finishHandler = function(err) {
		for (i = 0; i < extensions.length; i++) {
			this.env.conf.wiki.removeExtensionTag(extensions[i]);
		}
		setImmediate(endCb, err);
	}.bind(this);

	var testTasks = [];

	// Some useful booleans
	var startsAtWikitext = mode === 'wt2wt' || mode === 'wt2html' || mode === 'selser';
	var startsAtHtml = mode === 'html2html' || mode === 'html2wt';
	var endsAtWikitext = mode === 'wt2wt' || mode === 'selser' || mode === 'html2wt';
	var endsAtHtml = mode === 'wt2html' || mode === 'html2html';

	var parsoidOnly = ('html/parsoid' in item) || (item.options.parsoid !== undefined);

	// Source preparation
	if (startsAtHtml) {
		testTasks.push(function(cb) {
			var html = item.html;
			if (!parsoidOnly) {
				// Strip some php output that has no wikitext representation
				// (like .mw-editsection) and won't html2html roundtrip and
				// therefore causes false failures.
				html = DU.normalizePhpOutput(html);
			}
			cb(null, DU.parseHTML(html).body);
		});
		testTasks.push(this.convertHtml2Wt.bind(this, options, mode, item));
	} else {  // startsAtWikitext
		// Always serialize DOM to string and reparse before passing to wt2wt
		if (item.cachedBODY === null) {
			testTasks.push(this.convertWt2Html.bind(this, mode, item.wikitext));
			// Caching stage 1 - save the result of the first two stages
			// so we can maybe skip them later
			testTasks.push(function(body, cb) {
				// Cache parsed HTML
				item.cachedBODY = DU.parseHTML(DU.serializeNode(body).str).body;

				// - In wt2html mode, pass through original DOM
				//   so that it is serialized just once.
				// - In wt2wt and selser modes, pass through serialized and
				//   reparsed DOM so that fostering/normalization effects
				//   are reproduced.
				if (mode === "wt2html") {
					cb(null, body);
				} else {
					cb(null, item.cachedBODY.cloneNode(true));
				}
			});
		} else {
			testTasks.push(function(cb) {
				cb(null, item.cachedBODY.cloneNode(true));
			});
		}
	}

	// Generate and make changes for the selser test mode
	if (mode === 'selser') {
		if ((options.selser === 'noauto' || item.changetree === 'manual') &&
			item.options.parsoid && item.options.parsoid.changes) {
			testTasks.push(function(body, cb) {
				// Ensure that we have this set here in case it hasn't been
				// set in buildTasks because the 'selser=noauto' option was passed.
				item.changetree = 'manual';
				this.applyManualChanges(body, item.options.parsoid.changes, cb);
			}.bind(this));
		} else {
			var changetree = options.changetree ? JSON.parse(options.changetree) : item.changetree;
			if (changetree) {
				testTasks.push(function(content, cb) {
					cb(null, content, changetree);
				});
			} else {
				testTasks.push(this.generateChanges.bind(this, options, item));
			}
			testTasks.push(this.applyChanges.bind(this, item));
		}
		// Save the modified DOM so we can re-test it later
		// Always serialize to string and reparse before passing to selser/wt2wt
		testTasks.push(function(body, cb) {
			item.changedHTMLStr = DU.serializeNode(body).str;
			cb(null, DU.parseHTML(item.changedHTMLStr).body);
		});
	} else if (mode === 'wt2wt') {
		// handle a 'changes' option if present.
		if (item.options.parsoid && item.options.parsoid.changes) {
			testTasks.push(function(body, cb) {
				this.applyManualChanges(body, item.options.parsoid.changes, cb);
			}.bind(this));
		}
	}

	// Roundtrip stage
	if (mode === 'wt2wt' || mode === 'selser') {
		testTasks.push(this.convertHtml2Wt.bind(this, options, mode, item));
	} else if (mode === 'html2html') {
		testTasks.push(this.convertWt2Html.bind(this, mode));
	}

	// Processing stage
	if (endsAtWikitext) {
		testTasks.push(this.processSerializedWT.bind(this, item, options, mode));
	} else if (endsAtHtml) {
		testTasks.push(this.processParsedHTML.bind(this, item, options, mode));
	}

	item.time.start = Date.now();
	async.waterfall(testTasks, finishHandler);
};

/**
 * @method
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @param {Node} body
 * @param {Function} cb
 */
ParserTests.prototype.processParsedHTML = function(item, options, mode, body, cb) {
	item.time.end = Date.now();
	// Check the result vs. the expected result.
	var checkPassed = this.checkHTML(item, body, options, mode);

	// Now schedule the next test, if any
	// Only pass an error if --exit-unexpected was set and there was an error
	// Otherwise, pass undefined so that async.waterfall continues
	var err = (options['exit-unexpected'] && !checkPassed) ?
			exitUnexpected : null;
	setImmediate(cb, err);
};

/**
 * @method
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @param {string} wikitext
 * @param {Function} cb
 */
ParserTests.prototype.processSerializedWT = function(item, options, mode, wikitext, cb) {
	item.time.end = Date.now();

	var self = this;
	var checkAndReturn = function() {
		// Check the result vs. the expected result.
		var checkPassed = self.checkWikitext(item, wikitext, options, mode);

		// Now schedule the next test, if any.
		// Only pass an error if --exit-unexpected was set and there was an
		// error. Otherwise, pass undefined so that async.waterfall continues
		var err = (options['exit-unexpected'] && !checkPassed) ?
				exitUnexpected : null;
		setImmediate(cb, err);
	};

	if (mode === 'selser' && options.selser !== 'noauto') {
		if (item.changetree === 5) {
			item.resultWT = item.wikitext;
		} else {
			var body = DU.parseHTML(item.changedHTMLStr).body;
			this.convertHtml2Wt(options, 'wt2wt', item, body, function(err, wt) {
				if (err === null) {
					item.resultWT = wt;
				} else {
					// FIXME: what's going on here? Error handling here is suspect.
					self.env.log('warning', 'Convert html2wt erred!');
					item.resultWT = item.wikitext;
				}
				return checkAndReturn();
			});
			// Async processing
			return;
		}
	}

	// Sync processing
	return checkAndReturn();
};

/**
 * @method
 * @param {string} title
 * @param {Array} comments
 * @param {Object|null} iopts Options from the test file
 * @param {Object} options
 * @param {Object} actual
 * @param {Object} expected
 * @param {boolean} expectFail Whether this test was expected to fail (on blacklist)
 * @param {boolean} failureOnly Whether we should print only a failure message, or go on to print the diff
 * @param {string} mode
 */
ParserTests.prototype.printFailure = function(title, comments, iopts, options,
		actual, expected, expectFail, failureOnly, mode, error, item) {
	this.stats.failedTests++;
	this.stats.modes[mode].failedTests++;
	var fail = {
			title: title,
			raw: actual ? actual.raw : null,
			expected: expected ? expected.raw : null,
			actualNormalized: actual ? actual.normal : null,
		};
	this.stats.modes[mode].failList.push(fail);

	var extTitle = (title + (mode ? (' (' + mode + ')') : '')).
		replace('\n', ' ');

	var blacklisted = false;
	if (booleanOption(options.blacklist) && expectFail) {
		// compare with remembered output
		if (mode === 'selser' && !options.changetree && testBlackList[title].raw !== actual.raw) {
			blacklisted = true;
		} else {
			if (!booleanOption(options.quiet)) {
				console.log('EXPECTED FAIL'.red + ': ' + extTitle.yellow);
			}
			return true;
		}
	}

	this.stats.failedTestsUnexpected++;
	this.stats.modes[mode].failedTestsUnexpected++;
	fail.unexpected = true;

	if (!failureOnly) {
		console.log('=====================================================');
	}

	console.log('UNEXPECTED FAIL'.red.inverse + ': ' + extTitle.yellow);

	if (mode === 'selser') {
		if (blacklisted) {
			console.log('Blacklisted, but the output changed!'.red);
		}
		if (item.hasOwnProperty('wt2wtPassed') && item.wt2wtPassed) {
			console.log('Even worse, the non-selser wt2wt test passed!'.red);
		} else if (actual && item.hasOwnProperty('wt2wtResult') &&
				item.wt2wtResult !== actual.raw) {
			console.log('Even worse, the non-selser wt2wt test had a different result!'.red);
		}
	}

	if (!failureOnly && !error) {
		console.log(comments.join('\n'));

		if (options) {
			console.log('OPTIONS'.cyan + ':');
			console.log(prettyPrintIOptions(iopts) + '\n');
		}

		console.log('INPUT'.cyan + ':');
		console.log(actual.input + '\n');

		console.log(options.getActualExpected(actual, expected, options.getDiff));

		if (booleanOption(options.printwhitelist)) {
			this.printWhitelistEntry(title, actual.raw);
		}
	} else if (!failureOnly && error) {
		// The error object exists, which means
		// there was an error! gwicke said it wouldn't happen, but handle
		// it anyway, just in case.
		this.env.log("error", error);
	}

	return false;
};

/**
 * @method
 * @param {string} title
 * @param {Object} options
 * @param {string} mode
 * @param {boolean} expectSuccess Whether this success was expected (or was this test blacklisted?)
 * @param {boolean} isWhitelist Whether this success was due to a whitelisting
 * @param {Object} item
 */
ParserTests.prototype.printSuccess = function(title, options, mode, expectSuccess, isWhitelist, item) {
	var quiet = booleanOption(options.quiet);
	if (isWhitelist) {
		this.stats.passedTestsWhitelisted++;
		this.stats.modes[mode].passedTestsWhitelisted++;
	} else {
		this.stats.passedTests++;
		this.stats.modes[mode].passedTests++;
	}
	var extTitle = (title + (mode ? (' (' + mode + ')') : '')).
		replace('\n', ' ');

	if (booleanOption(options.blacklist) && !expectSuccess) {
		this.stats.passedTestsUnexpected++;
		this.stats.modes[mode].passedTestsUnexpected++;
		console.log('UNEXPECTED PASS'.green.inverse +
			(isWhitelist ? ' (whitelist)' : '') +
			':' + extTitle.yellow);
		return false;
	}
	if (!quiet) {
		var outStr = 'EXPECTED PASS';

		if (isWhitelist) {
			outStr += ' (whitelist)';
		}

		outStr = outStr.green + ': ' + extTitle.yellow;

		console.log(outStr);

		if (mode === 'selser' && item.hasOwnProperty('wt2wtPassed') &&
				!item.wt2wtPassed) {
			console.log('Even better, the non-selser wt2wt test failed!'.red);
		}
	}
	return true;
};

/**
 * @method
 *
 * Print the actual and expected outputs.
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
 * @return {string}
 */
ParserTests.prototype.getActualExpected = function(actual, expected, getDiff) {
	var returnStr = '';
	returnStr += 'RAW EXPECTED'.cyan + ':\n';
	returnStr += expected.raw + '\n';

	returnStr += 'RAW RENDERED'.cyan + ':\n';
	returnStr += actual.raw + '\n';

	returnStr += 'NORMALIZED EXPECTED'.magenta + ':\n';
	returnStr += expected.normal + '\n';

	returnStr += 'NORMALIZED RENDERED'.magenta + ':\n';
	returnStr += actual.normal + '\n';

	returnStr += 'DIFF'.cyan + ':\n';
	returnStr += getDiff(actual, expected);

	return returnStr;
};

/**
 * @param {Object} actual
 * @param {string} actual.normal
 * @param {Object} expected
 * @param {string} expected.normal
 */
ParserTests.prototype.getDiff = function(actual, expected) {
	// safe to always request color diff, because we set color mode='none'
	// if colors are turned off.
	return Diff.htmlDiff(expected.normal, actual.normal, true);
};

/**
 * @param {string} title
 * @param {string} raw The raw output from the parser.
 */
ParserTests.prototype.printWhitelistEntry = function(title, raw) {
	console.log('WHITELIST ENTRY:'.cyan + '');
	console.log('testWhiteList[' +
		JSON.stringify(title) + '] = ' +
		JSON.stringify(raw) + ';\n');
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
function printResult(reportFailure, reportSuccess, title, time, comments, iopts, expected, actual, options, mode, item, pre, post) {
	var quick = booleanOption(options.quick);
	var parsoidOnly =
		('html/parsoid' in item) || (iopts.parsoid !== undefined);

	if (mode === 'selser') {
		title += ' ' + (item.changes ? JSON.stringify(item.changes) : 'manual');
	}

	var whitelist = false;
	var tb = testBlackList[title];
	var expectFail = (tb ? tb.modes : []).indexOf(mode) >= 0;
	var fail = (expected.normal !== actual.normal);
	// Return whether the test was as expected, independent of pass/fail
	var asExpected;

	if (fail &&
		booleanOption(options.whitelist) &&
		title in testWhiteList &&
		DU.normalizeOut(DU.parseHTML(testWhiteList[title]).body, parsoidOnly) ===  actual.normal
	) {
		whitelist = true;
		fail = false;
	}

	if (mode === 'wt2wt') {
		item.wt2wtPassed = !fail;
		item.wt2wtResult = actual.raw;
	}

	// don't report selser fails when nothing was changed or it's a dup
	if (mode === 'selser' && (item.changes === 0 || item.duplicateChange)) {
		return true;
	}

	if (typeof pre === 'function') {
		pre(mode, title, time);
	}

	if (fail) {
		asExpected = reportFailure(title, comments, iopts, options, actual, expected, expectFail, quick, mode, null, item);
	} else {
		asExpected = reportSuccess(title, options, mode, !expectFail, whitelist, item);
	}

	if (typeof post === 'function') {
		post(mode);
	}

	return asExpected;
}

/**
 * @param {Object} item
 * @param {string} out
 * @param {Object} options
 */
ParserTests.prototype.checkHTML = function(item, out, options, mode) {
	var normalizedOut, normalizedExpected;
	var parsoidOnly =
		('html/parsoid' in item) || (item.options.parsoid !== undefined);

	normalizedOut = DU.normalizeOut(out, parsoidOnly);
	out = DU.serializeChildren(out);

	if (item.cachedNormalizedHTML === null) {
		if (parsoidOnly) {
			var normalDOM = DU.parseHTML(item.html).body;
			normalizedExpected = DU.normalizeOut(normalDOM, parsoidOnly);
		} else {
			normalizedExpected = DU.normalizeHTML(item.html);
		}
		item.cachedNormalizedHTML = normalizedExpected;
	} else {
		normalizedExpected = item.cachedNormalizedHTML;
	}

	var input = mode === 'html2html' ? item.html : item.wikitext;
	var expected = { normal: normalizedExpected, raw: item.html };
	var actual = { normal: normalizedOut, raw: out, input: input };

	return options.reportResult(item.title, item.time, item.comments, item.options || null, expected, actual, options, mode, item);
};

/**
 * @param {Object} item
 * @param {string} out
 * @param {Object} options
 */
ParserTests.prototype.checkWikitext = function(item, out, options, mode) {
	var itemWikitext = item.wikitext;
	out = out.replace(new RegExp('<!--' + staticRandomString + '-->', 'g'), '');
	if (mode === 'selser' && item.resultWT !== null &&
			item.changes !== 5 && item.changetree !== 'manual') {
		itemWikitext = item.resultWT;
	} else if ((mode === 'wt2wt' || (mode === 'selser' && item.changetree === 'manual')) &&
				item.options.parsoid && item.options.parsoid.changes) {
		itemWikitext = item['wikitext/edited'];
	}

	var toWikiText = mode === 'html2wt' || mode === 'wt2wt' || mode === 'selser';
	// FIXME: normalization not in place yet
	var normalizedExpected = toWikiText ? itemWikitext.replace(/\n+$/, '') : itemWikitext;

	// FIXME: normalization not in place yet
	var normalizedOut = toWikiText ? out.replace(/\n+$/, '') : out;

	var input = mode === 'selser' ? item.changedHTMLStr :
			mode === 'html2wt' ? item.html : itemWikitext;
	var expected = { normal: normalizedExpected, raw: itemWikitext };
	var actual = { normal: normalizedOut, raw: out, input: input };

	return options.reportResult(item.title, item.time, item.comments, item.options || null, expected, actual, options, mode, item);
};

/**
 * Print out a WikiDom conversion of the HTML DOM
 */
ParserTests.prototype.printWikiDom = function(body) {
	console.log('WikiDom'.cyan + ':');
	console.log(body);
};

/**
 * @param {Object} stats
 * @param {number} stats.failedTests Number of failed tests due to differences in output
 * @param {number} stats.passedTests Number of tests passed without any special consideration
 * @param {number} stats.passedTestsWhitelisted Number of tests passed by whitelisting
 * @param {Object} stats.modes All of the stats (failedTests, passedTests, and passedTestsWhitelisted) per-mode.
 */
ParserTests.prototype.reportSummary = function(stats) {
	var curStr;
	var thisMode;
	var failTotalTests = stats.failedTests;

	console.log("==========================================================");
	console.log("SUMMARY: ");
	if (console.time && console.timeEnd) {
		console.timeEnd('Execution time');
	}

	if (failTotalTests !== 0) {
		for (var i = 0; i < modes.length; i++) {
			curStr = modes[i] + ': ';
			thisMode = stats.modes[modes[i]];
			if (thisMode.passedTests + thisMode.passedTestsWhitelisted + thisMode.failedTests > 0) {
				curStr += colorizeCount(thisMode.passedTests + thisMode.passedTestsWhitelisted, 'green') + ' passed (';
				curStr += colorizeCount(thisMode.passedTestsUnexpected, 'red') + ' unexpected, ';
				curStr += colorizeCount(thisMode.passedTestsWhitelisted, 'yellow') + ' whitelisted) / ';
				curStr += colorizeCount(thisMode.failedTests, 'red') + ' failed (';
				curStr += colorizeCount(thisMode.failedTestsUnexpected, 'red') + ' unexpected)';
				console.log(curStr);
			}
		}

		curStr = 'TOTAL' + ': ';
		curStr += colorizeCount(stats.passedTests + stats.passedTestsWhitelisted, 'green') + ' passed (';
		curStr += colorizeCount(stats.passedTestsUnexpected, 'red') + ' unexpected, ';
		curStr += colorizeCount(stats.passedTestsWhitelisted, 'yellow') + ' whitelisted) / ';
		curStr += colorizeCount(stats.failedTests, 'red') + ' failed (';
		curStr += colorizeCount(stats.failedTestsUnexpected, 'red') + ' unexpected)';
		console.log(curStr);

		console.log('\n');
		console.log(colorizeCount(stats.passedTests + stats.passedTestsWhitelisted, 'green') +
			' total passed tests (expected ' +
			(stats.passedTests + stats.passedTestsWhitelisted - stats.passedTestsUnexpected + stats.failedTestsUnexpected) +
			'), ' +
			colorizeCount(failTotalTests , 'red') + ' total failures (expected ' +
			(stats.failedTests - stats.failedTestsUnexpected + stats.passedTestsUnexpected) +
			')');
		if (stats.passedTestsUnexpected === 0 &&
				stats.failedTestsUnexpected === 0) {
			console.log('--> ' + 'NO UNEXPECTED RESULTS'.green + ' <--');
		}
	} else {
		if (this.testFilter !== null) {
			console.log("Passed " + (stats.passedTests + stats.passedTestsWhitelisted) +
					" of " + stats.passedTests + " tests matching " + this.testFilter +
					"... " + "ALL TESTS PASSED!".green);
		} else {
			// Should not happen if it does: Champagne!
			console.log("Passed " + stats.passedTests + " of " + stats.passedTests +
					" tests... " + "ALL TESTS PASSED!".green);
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
	console.log("==========================================================");

	return (stats.passedTestsUnexpected + stats.failedTestsUnexpected);
};

/**
 * @method
 * @param {Object} options
 */
ParserTests.prototype.main = function(options, popts) {

	if (options.help) {
		popts.showHelp();
		console.log("Additional dump options specific to parserTests script:");
		console.log("* dom:post-changes  : Dumps DOM after applying selser changetree\n");
		console.log("Examples");
		console.log("$ node parserTests --selser --filter '...' --dump dom:post-changes");
		console.log("$ node parserTests --selser --filter '...' --changetree '...' --dump dom:post-changes\n");
		process.exit(0);
	}
	Util.setColorFlags(options);

	if (!(options.wt2wt || options.wt2html || options.html2wt || options.html2html || options.selser)) {
		options.wt2wt = true;
		options.wt2html = true;
		options.html2html = true;
		options.html2wt = true;
		if (booleanOption(options['rewrite-blacklist'])) {
			// turn on all modes by default for --rewrite-blacklist
			options.selser = true;
			// sanity checking (bug 51448 asks to be able to use --filter here)
			if (options.filter || options.regex || options.maxtests || options['exit-unexpected']) {
				console.log("\nERROR> can't combine --rewrite-blacklist with --filter, --maxtests or --exit-unexpected");
				process.exit(1);
			}
		}
	}

	if (typeof options.reportFailure !== 'function') {
		// default failure reporting is standard out,
		// see ParserTests::printFailure for documentation of the default.
		options.reportFailure = this.printFailure.bind(this);
	}

	if (typeof options.reportSuccess !== 'function') {
		// default success reporting is standard out,
		// see ParserTests::printSuccess for documentation of the default.
		options.reportSuccess = this.printSuccess.bind(this);
	}

	if (typeof options.reportStart !== 'function') {
		// default summary reporting is standard out,
		// see ParserTests::reportStart for documentation of the default.
		options.reportStart = this.reportStartOfTests.bind(this);
	}

	if (typeof options.reportSummary !== 'function') {
		// default summary reporting is standard out,
		// see ParserTests::reportSummary for documentation of the default.
		options.reportSummary = this.reportSummary.bind(this);
	}

	if (typeof options.reportResult !== 'function') {
		// default result reporting is standard out,
		// see printResult for documentation of the default.
		options.reportResult = printResult.bind(this, options.reportFailure, options.reportSuccess);
	}

	if (typeof options.getDiff !== 'function') {
		// this is the default for diff-getting, but it can be overridden
		// see ParserTests::getDiff for documentation of the default.
		options.getDiff = this.getDiff.bind(this);
	}

	if (typeof options.getActualExpected !== 'function') {
		// this is the default for getting the actual and expected
		// outputs, but it can be overridden
		// see ParserTests::getActualExpected for documentation of the default.
		options.getActualExpected = this.getActualExpected.bind(this);
	}

	// test case filtering
	this.runDisabled = booleanOption(options['run-disabled']);
	this.runPHP = booleanOption(options['run-php']);
	this.testFilter = null; // null is the 'default' by definition
	if (options.filter || options.regex) {
		// NOTE: filter.toString() is required because a number-only arg
		// shows up as a numeric type rather than a string.
		// Ex: parserTests.js --filter 53221
		var pattern = options.regex || Util.escapeRegExp(options.filter.toString());
		try {
			this.testFilter = new RegExp(pattern);
		} catch (e) {
			console.error('\nERROR> --filter was given an invalid regular expression.');
			console.error('\nERROR> See below for JS engine error:\n' + e + '\n');
			process.exit(1);
		}
	}

	// Identify tests file
	if (options._[0]) {
		this.testFileName = options._[0] ;
	} else {
		this.testFileName = __dirname + '/' + this.parserTestsFile;
	}

	try {
		this.testParserFileName = __dirname + '/parserTests.pegjs';
		this.testParser = PEG.buildParser(fs.readFileSync(this.testParserFileName, 'utf8'));
	} catch (e2) {
		console.log(e2);
	}

	this.cases = this.getTests(options) || [];

	if (options.maxtests) {
		var n = Number(options.maxtests);
		console.warn('maxtests:' + n);
		if (n > 0) {
			this.cases.length = n;
		}
	}

	options.expandExtensions = true;

	var setup = function(parsoidConfig) {
		// Set tracing and debugging before the env. object is
		// constructed since tracing backends are registered there.
		// (except for the --quiet option where the backends are
		// overridden here).
		Util.setDebuggingFlags(parsoidConfig, options);
		Util.setTemplatingAndProcessingFlags(parsoidConfig, options);

		// Init early so we can overwrite it here.
		parsoidConfig.loadWMF = false;
		parsoidConfig.initMwApiMap();

		// Send all requests to the mock API server.
		parsoidConfig.mwApiMap.forEach(function(apiConf) {
			parsoidConfig.setMwApi({
				prefix: apiConf.prefix,
				domain: apiConf.domain,
				uri: mockAPIServerURL,
			});
		});

		// This isn't part of the sitematrix but the
		// "Check noCommafy in formatNum" test depends on it.
		parsoidConfig.setMwApi({
			prefix: 'be-taraskwiki',
			domain: 'be-tarask.wikipedia.org',
			uri: mockAPIServerURL,
		});
	};

	var parsoidConfig = new ParsoidConfig({ setup: setup }, options);

	// Create a new parser environment
	MWParserEnvironment.getParserEnv(parsoidConfig, null, { prefix: 'enwiki' },
			function(err, env) {
		// For posterity: err will never be non-null here, because we expect
		// the WikiConfig to be basically empty, since the parserTests
		// environment is very bare.
		console.assert(!err, err);
		this.env = env;

		if (booleanOption(options.quiet)) {
			var logger = new ParsoidLogger(env);
			logger.registerLoggingBackends(["fatal", "error"], parsoidConfig);
			env.setLogger(logger);
		}

		// Enable <ref> and <references> tags since we want to
		// test Parsoid's native implementation of these tags.
		this.env.conf.wiki.addExtensionTag("ref");
		this.env.conf.wiki.addExtensionTag("references");

		options.modes = [];
		if (options.wt2html) {
			options.modes.push('wt2html');
		}
		if (options.wt2wt) {
			options.modes.push('wt2wt');
		}
		if (options.html2wt) {
			options.modes.push('html2wt');
		}
		if (options.html2html) {
			options.modes.push('html2html');
		}
		if (options.selser) {
			options.modes.push('selser');
		}

		// Create parsers, serializers, ..
		if (options.html2html || options.wt2wt || options.wt2html || options.selser) {
			this.parserPipeline = this.env.pipelineFactory.getPipeline('text/x-mediawiki/full');
		}

		if (console.time && console.timeEnd) {
			console.time('Execution time');
		}
		options.reportStart();
		this.env.pageCache = this.articles;
		this.comments = [];
		this.processCase(0, options);
	}.bind(this));
};

/**
 * Simple function for reporting the start of the tests.
 *
 * This method can be reimplemented in the options of the ParserTests object.
 */
ParserTests.prototype.reportStartOfTests = function() {
	console.log('ParserTests running with node', process.version);
	console.log('Initialization complete. Now launching tests.');
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
ParserTests.prototype.buildTasks = function(item, modes, options) {
	var tasks = [];
	var self = this;
	for (var i = 0; i < modes.length; i++) {
		if (modes[i] === 'selser' && options.numchanges &&
			options.selser !== 'noauto' && !options.changetree) {
			var newitem;

			// Prepend manual changes, if present, but not if 'selser' isn't
			// in the explicit modes option.
			if (item.options.parsoid && item.options.parsoid.changes) {
				tasks.push(function(cb) {
					newitem = Util.clone(item);
					// Mutating the item here is necessary to output 'manual' in
					// the test's title and to differentiate it for blacklist.
					// It can only get here in two cases:
					// * When there's no changetree specified in the command line,
					//   buildTasks creates the items by cloning the original one,
					//   so there should be no problem setting it.
					//   In fact, it will override the existing 'manual' value
					//   (lines 1765 and 1767).
					// * When a changetree is specified in the command line and
					//   it's 'manual', there shouldn't be a problem setting the
					//   value here as no other items will be processed.
					// Still, protect against changing a different copy of the item.
					console.assert(newitem.changetree === 'manual' ||
						newitem.changetree === undefined);
					newitem.changetree = 'manual';
					self.processTest(newitem, options, 'selser', function(err) {
						setImmediate(cb, err);
					});
				});
			}
			// And if that's all we want, next one.
			if (item.options.parsoid && item.options.parsoid.selser === 'noauto') {
				continue;
			}

			item.selserChangeTrees = new Array(options.numchanges);

			// Prepend a selser test that appends a comment to the root node
			tasks.push(function(cb) {
				newitem = Util.clone(item);
				newitem.changetree = 5;
				self.processTest(newitem, options, 'selser', function(err) {
					setImmediate(cb, err);
				});
			});

			var done = false;
			for (var j = 0; j < item.selserChangeTrees.length; j++) {
				// we create the function in the loop but are careful to
				// bind loop variables i and j at function creation time
				/* jshint loopfunc: true */
				tasks.push(function(modeIndex, changesIndex, cb) {
					if (done) {
						setImmediate(cb);
					} else {
						newitem = Util.clone(item);
						// Make sure we aren't reusing the one from manual changes
						console.assert(newitem.changetree === undefined);
						newitem.seed = changesIndex + '';
						this.processTest(newitem, options, modes[modeIndex], function(err) {
							if (this.isDuplicateChangeTree(item.selserChangeTrees, newitem.changes)) {
								// Once we get a duplicate change tree, we can no longer
								// generate and run new tests.  So, be done now!
								done = true;
							} else {
								item.selserChangeTrees[changesIndex] = newitem.changes;
							}

							// Push the caches forward!
							item.cachedBODY = newitem.cachedBODY;
							item.cachedNormalizedHTML = newitem.cachedNormalizedHTML;

							setImmediate(cb, err);
						}.bind(this));
					}
				}.bind(this, i, j));
			}
		} else {
			if (modes[i] === 'selser' && options.selser === 'noauto') {
				// Manual changes were requested on the command line,
				// check that the item does have them.
				if (item.options.parsoid && item.options.parsoid.changes) {
					// If it does, we need to clone the item so that previous
					// results don't clobber this one.
					tasks.push(this.processTest.bind(this, Util.clone(item), options, modes[i]));
				} else {
					// If it doesn't have manual changes, just skip it.
					continue;
				}
			} else {
				// A non-selser task, we can reuse the item.
				tasks.push(this.processTest.bind(this, item, options, modes[i]));
			}
		}
	}
	return tasks;
};

/**
 * @method
 */
ParserTests.prototype.processCase = function(i, options, err) {
	var ix;
	var item;
	var cases = this.cases;
	var targetModes = options.modes;
	var nextCallback = this.processCase.bind(this, i + 1, options);

	// There are two types of errors that reach here.  The first is just
	// a notification that a test failed.  We use the error propagation
	// mechanism to get back to this point to print the summary.  The
	// second type is an actual exception that we should hard fail on.
	// exitUnexpected is a sentinel for the first type.
	if (err && err !== exitUnexpected) {
		this.env.log('fatal', err);
		process.exit(1); // Should not reach here.
	}
	var earlyExit = options['exit-unexpected'] && (err === exitUnexpected);

	if (i < this.cases.length && !earlyExit) {
		item = this.cases[i];
		if (typeof item === 'string') {
			// this is a comment line in the file, ignore it.
			return setImmediate(nextCallback);
		}

		if (!item.options) { item.options = {}; }

		// backwards-compatibility aliases for section names.
		if ('input' in item) { item.wikitext = item.input; delete item.input; }
		if ('result' in item) { item.html = item.result; delete item.result; }

		// html/* and html/parsoid should be treated as html.
		[ 'html/*', 'html/*+tidy', 'html+tidy', 'html/parsoid' ].forEach(function(alt) {
			if (alt in item) {
				item.html = item[alt];
			}
		});
		// ensure that test is not skipped if it has a wikitext/edited section
		if ('wikitext/edited' in item) { item.html = true; }

		// Reset the cached results for the new case.
		// All test modes happen in a single run of processCase.
		item.cachedBODY = null;
		item.cachedNormalizedHTML = null;

		// console.log( 'processCase ' + i + JSON.stringify( item )  );
		if (typeof item === 'object') {
			switch (item.type) {
				case 'article':
					this.comments = [];
					this.processArticle(item, nextCallback);
					break;
				case 'test':
					if (this.tests.has(item.title)) {
						return setImmediate(nextCallback,
							new Error('Duplicate titles: ' + item.title));
					} else {
						this.tests.add(item.title);
					}

					if (!('wikitext' in item && 'html' in item) ||
						('disabled' in item.options && !this.runDisabled) ||
						('php' in item.options &&
							!('html/parsoid' in item || this.runPHP)) ||
						(this.testFilter &&
							-1 === item.title.search(this.testFilter))) {
						// Skip test whose title does not match --filter
						// or which is disabled or php-only
						this.comments = [];
						setImmediate(nextCallback);
						break;
					}
					// Add comments to following test.
					item.comments = item.comments || this.comments;
					this.comments = [];

					if (item.options.parsoid && item.options.parsoid.modes) {
						// Avoid filtering out the selser test
						if (options.selser &&
							item.options.parsoid.modes.indexOf("selser") < 0 &&
							item.options.parsoid.modes.indexOf("wt2wt") >= 0
						) {
							item.options.parsoid.modes.push("selser");
						}

						targetModes = targetModes.filter(function(mode) {
							return item.options.parsoid.modes.indexOf(mode) >= 0;
						});
					}

					if (targetModes.length) {

						// Honor language option in parserTests.txt
						var prefix = item.options.language || 'enwiki';
						if (!/wiki/.test(prefix)) {
							// Convert to our enwiki.. format
							prefix = prefix + 'wiki';
						}
						this.env.switchToConfig(prefix, function(err) {
							if (err) {
								return nextCallback(err);
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
							// Hard-code some interwiki prefixes, as is done
							// in parserTest.inc:setupInterwikis()
							var iwl = {
								local: {
									url: 'http://doesnt.matter.org/$1',
									localinterwiki: '',
								},
								wikipedia: {
									url: 'http://en.wikipedia.org/wiki/$1',
								},
								meatball: {
									// this has been updated in the live wikis, but the parser tests
									// expect the old value (as set in parserTest.inc:setupInterwikis())
									url: 'http://www.usemod.com/cgi-bin/mb.pl?$1',
								},
								memoryalpha: {
									url: 'http://www.memory-alpha.org/en/index.php/$1',
								},
								zh: {
									url: 'http://zh.wikipedia.org/wiki/$1',
									language: '\u4e2d\u6587',
									local: '',
								},
								es: {
									url: 'http://es.wikipedia.org/wiki/$1',
									language: 'espa\u00f1ol',
									local: '',
								},
								fr: {
									url: 'http://fr.wikipedia.org/wiki/$1',
									language: 'fran\u00e7ais',
									local: '',
								},
								ru: {
									url: 'http://ru.wikipedia.org/wiki/$1',
									language: '\u0440\u0443\u0441\u0441\u043a\u0438\u0439',
									local: '',
								},
								mi: {
									url: 'http://mi.wikipedia.org/wiki/$1',
									// better for testing if one of the
									// localinterwiki prefixes is also a
									// language
									language: 'Test',
									local: '',
									localinterwiki: '',
								},
								mul: {
									url: 'http://wikisource.org/wiki/$1',
									extralanglink: '',
									linktext: 'Multilingual',
									sitename: 'WikiSource',
									local: '',
								},
								// not in PHP setupInterwikis(), but needed
								en: {
									url: 'http://en.wikipedia.org/wiki/$1',
									language: 'English',
									local: '',
									protorel: '',
								},
							};
							wikiConf.interwikiMap.clear();
							Object.keys(iwl).forEach(function(key) {
								iwl[key].prefix = key;
								wikiConf.interwikiMap.set(key, {});
								Object.keys(iwl[key]).forEach(function(f) {
									wikiConf.interwikiMap.get(key)[f] = iwl[key][f];
								});
							});
							// Add 'MemoryAlpha' namespace (bug 51680)
							this.env.conf.wiki.namespaceNames['100'] = 'MemoryAlpha';
							this.env.conf.wiki.namespaceIds.memoryalpha =
							this.env.conf.wiki.canonicalNamespaces.memoryalpha = 100;

							async.series(this.buildTasks(item, targetModes, options),
								nextCallback);
						}.bind(this));

					} else {
						setImmediate(nextCallback);
					}

					break;
				case 'comment':
					this.comments.push(item.comment);
					setImmediate(nextCallback);
					break;
				case 'hooks':
					var hooks = item.text.split(/\n/);
					var self = this;
					hooks.forEach(function(hook) {
						self.env.log("warning", "parserTests: Adding extension hook", JSON.stringify(hook));
						self.env.conf.wiki.addExtensionTag(hook);
					});
					setImmediate(nextCallback);
					break;
				case 'functionhooks':
					this.env.log("warning", "parserTests: Unhandled functionhook", JSON.stringify(item));
					break;
				default:
					this.comments = [];
					setImmediate(nextCallback);
					break;
			}
		} else {
			setImmediate(nextCallback);
		}
	} else {

		// update the blacklist, if requested
		if (booleanOption(options['rewrite-blacklist'])) {
			var filename = __dirname + '/parserTests-blacklist.js';
			var shell = fs.readFileSync(filename, 'utf8').
				split(/^.*DO NOT REMOVE THIS LINE.*$/m);
			var contents = shell[0];
			contents += '// ### DO NOT REMOVE THIS LINE ### ';
			contents += '(start of automatically-generated section)\n';
			modes.forEach(function(mode) {
				contents += '\n// Blacklist for ' + mode + '\n';
				this.stats.modes[mode].failList.forEach(function(fail) {
					contents += 'add(' + JSON.stringify(mode) + ', ' +
						JSON.stringify(fail.title);
					contents += ', ' + JSON.stringify(fail.raw);
					contents += ');\n';
				});
				contents += '\n';
			}.bind(this));
			contents += '// ### DO NOT REMOVE THIS LINE ### ';
			contents += '(end of automatically-generated section)';
			contents += shell[2];
			fs.writeFileSync(filename, contents, 'utf8');
		}

		// Write updated tests from failed ones
		if (booleanOption(options['update-tests']) ||
				booleanOption(options['update-unexpected'])) {
			var parserTestsFilename = __dirname + '/parserTests.txt';
			var parserTests = fs.readFileSync(parserTestsFilename, 'utf8');
			this.stats.modes.wt2html.failList.forEach(function(fail) {
				if (booleanOption(options['update-tests'] || fail.unexpected)) {
					var exp = new RegExp("(" + /!!\s*test\s*/.source +
						Util.escapeRegExp(fail.title) + /(?:(?!!!\s*end)[\s\S])*/.source +
						")(" + Util.escapeRegExp(fail.expected) + ")", "m");
					parserTests = parserTests.replace(exp, "$1" + fail.actualNormalized.replace(/\$/g, '$$$$'));
				}
			});
			fs.writeFileSync(parserTestsFilename, parserTests, 'utf8');
		}

		// print out the summary
		// note: these stats won't necessarily be useful if someone
		// reimplements the reporting methods, since that's where we
		// increment the stats.
		var failures = options.reportSummary(this.stats);

		// we're done!
		if (booleanOption(options['exit-zero'])) {
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
var xmlFuncs = (function() {
	var fail;
	var pass;
	var passWhitelist;

	var results = {
		html2html: '',
		wt2wt: '',
		wt2html: '',
		html2wt: '',
	};

	/**
	 * @method getActualExpectedXML
	 *
	 * Get the actual and expected outputs encoded for XML output.
	 *
	 * @inheritdoc ParserTests#getActualExpected.
	 *
	 * @return {string} The XML representation of the actual and expected outputs
	 */
	var getActualExpectedXML = function(actual, expected, getDiff) {
		var returnStr = '';

		returnStr += 'RAW EXPECTED:\n';
		returnStr += DU.encodeXml(expected.raw) + '\n\n';

		returnStr += 'RAW RENDERED:\n';
		returnStr += DU.encodeXml(actual.raw) + '\n\n';

		returnStr += 'NORMALIZED EXPECTED:\n';
		returnStr += DU.encodeXml(expected.normal) + '\n\n';

		returnStr += 'NORMALIZED RENDERED:\n';
		returnStr += DU.encodeXml(actual.normal) + '\n\n';

		returnStr += 'DIFF:\n';
		returnStr += DU.encodeXml (getDiff(actual, expected, false));

		return returnStr;
	};

	/**
	 * @method reportStartXML
	 *
	 * Report the start of the tests output.
	 */
	var reportStartXML = function() {
		console.log('<testsuites>');
	};

	/**
	 * @method reportSummaryXML
	 *
	 * Report the end of the tests output.
	 */
	var reportSummaryXML = function() {
		for (var i = 0; i < modes.length; i++) {
			var mode = modes[i];
			console.log('<testsuite name="parserTests-' + mode + '" file="parserTests.txt">');
			console.log(results[mode]);
			console.log('</testsuite>');
		}
		console.log('</testsuites>');
	};

	/**
	 * @method reportFailureXML
	 *
	 * Print a failure message for a test in XML.
	 *
	 * @inheritdoc ParserTests#printFailure
	 */
	var reportFailureXML = function(title, comments, iopts, options, actual, expected, expectFail, failureOnly, mode, error) {
		fail++;

		var failEle;
		if (error) {
			failEle = '<error type="somethingCrashedFail">\n';
			failEle += error.toString();
			failEle += '\n</error>\n';
		} else {
			failEle = '<failure type="parserTestsDifferenceInOutputFailure">\n';
			failEle += getActualExpectedXML(actual, expected, options.getDiff);
			failEle += '\n</failure>\n';
		}
		results[mode] += failEle;
	};

	/**
	 * @method reportSuccessXML
	 *
	 * Print a success method for a test in XML.
	 *
	 * @inheritdoc ParserTests#printSuccess
	 */
	var reportSuccessXML = function(title, options, mode, expectSuccess, isWhitelist, item) {
		if (isWhitelist) {
			passWhitelist++;
		} else {
			pass++;
		}
	};

	/**
	 * @method reportResultXML
	 *
	 * Print the result of a test in XML.
	 *
	 * @inheritdoc printResult
	 */
	var reportResultXML = function() {

		function pre(mode, title, time) {
			var testcaseEle;
			testcaseEle = '<testcase name="' + DU.encodeXml(title) + '" ';
			testcaseEle += 'assertions="1" ';

			var timeTotal;
			if (time && time.end && time.start) {
				timeTotal = time.end - time.start;
				if (!isNaN(timeTotal)) {
					testcaseEle += 'time="' + ((time.end - time.start) / 1000.0) + '"';
				}
			}

			testcaseEle += '>';
			results[mode] += testcaseEle;
		}

		function post(mode) {
			results[mode] += '</testcase>\n';
		}

		var args = Array.prototype.slice.call(arguments);
		args = [ reportFailureXML, reportSuccessXML ].concat(args, pre, post);
		printResult.apply(this, args);

		// In xml, test all cases always
		return true;
	};

	return {
		reportResult: reportResultXML,
		reportStart: reportStartXML,
		reportSummary: reportSummaryXML,
		reportSuccess: reportSuccessXML,
		reportFailure: reportFailureXML,
	};
})();

// Construct the ParserTests object and run the parser tests
var ptests = new ParserTests();
var popts  = ptests.getOpts();

if (popts.argv.xml) {
	popts.reportResult = xmlFuncs.reportResult;
	popts.reportStart = xmlFuncs.reportStart;
	popts.reportSummary = xmlFuncs.reportSummary;
	popts.reportFailure = xmlFuncs.reportFailure;
	colors.mode = 'none';
}

if (popts.argv.help) {
	ptests.main(popts.argv, popts);
}

// Start the mock api server and kick off parser tests
apiServer.startMockAPIServer({ quiet: popts.quiet }).then(function(ret) {
	mockAPIServerURL = ret.url;
	mockAPIServer = ret.child;
	return ptests.main(popts.argv, popts);
}).done();
apiServer.exitOnProcessTerm();
