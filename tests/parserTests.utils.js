'use strict';

require('../core-upgrade.js');

var colors = require('colors');
var yargs = require('yargs');

var Diff = require('../lib/utils/Diff.js').Diff;
var DU = require('../lib/utils/DOMUtils.js').DOMUtils;
var Util = require('../lib/utils/Util.js').Util;

/**
 * @class PTUtils
 * @singleton
 */
var PTUtils = module.exports = {};

/**
 * Colorize given number if <> 0.
 *
 * @param {number} count
 * @param {string} color
 * @return {string} Colorized count
 */
var colorizeCount = function(count, color) {
	// We need a string to use colors methods
	var s = count.toString();
	if (count === 0 || !s[color]) {
		return s;
	}
	return s[color] + '';
};

/**
 * @param {Array} modesRan
 * @param {Object} stats
 * @param {number} stats.failedTests Number of failed tests due to differences in output.
 * @param {number} stats.passedTests Number of tests passed without any special consideration.
 * @param {number} stats.passedTestsWhitelisted Number of tests passed by whitelisting.
 * @param {Object} stats.modes All of the stats (failedTests, passedTests, and passedTestsWhitelisted) per-mode.
 * @param {string} file
 * @param {number} loggedErrorCount
 * @param {RegExp|null} testFilter
 * @param {boolean} blacklistChanged
 * @return {number} The number of failures.
 */
var reportSummary = function(modesRan, stats, file, loggedErrorCount, testFilter, blacklistChanged) {
	var curStr, mode, thisMode;
	var failTotalTests = stats.failedTests;
	var happiness = (
		stats.passedTestsUnexpected === 0 && stats.failedTestsUnexpected === 0
	);
	var filename = (file === null) ? "ALL TESTS" : file;

	if (file === null) { console.log(); }
	console.log("==========================================================");
	console.log("SUMMARY:", happiness ? filename.green : filename.red);
	if (console.time && console.timeEnd && file !== null) {
		console.timeEnd('Execution time');
	}

	if (failTotalTests !== 0) {
		for (var i = 0; i < modesRan.length; i++) {
			mode = modesRan[i];
			curStr = mode + ': ';
			thisMode = stats.modes[mode];
			curStr += colorizeCount(thisMode.passedTests + thisMode.passedTestsWhitelisted, 'green') + ' passed (';
			curStr += colorizeCount(thisMode.passedTestsUnexpected, 'red') + ' unexpected, ';
			curStr += colorizeCount(thisMode.passedTestsWhitelisted, 'yellow') + ' whitelisted) / ';
			curStr += colorizeCount(thisMode.failedTests, 'red') + ' failed (';
			curStr += colorizeCount(thisMode.failedTestsUnexpected, 'red') + ' unexpected)';
			console.log(curStr);
		}

		curStr = 'TOTAL' + ': ';
		curStr += colorizeCount(stats.passedTests + stats.passedTestsWhitelisted, 'green') + ' passed (';
		curStr += colorizeCount(stats.passedTestsUnexpected, 'red') + ' unexpected, ';
		curStr += colorizeCount(stats.passedTestsWhitelisted, 'yellow') + ' whitelisted) / ';
		curStr += colorizeCount(stats.failedTests, 'red') + ' failed (';
		curStr += colorizeCount(stats.failedTestsUnexpected, 'red') + ' unexpected)';
		console.log(curStr);

		if (file === null) {
			console.log(colorizeCount(stats.passedTests + stats.passedTestsWhitelisted, 'green') +
				' total passed tests (expected ' +
				(stats.passedTests + stats.passedTestsWhitelisted - stats.passedTestsUnexpected + stats.failedTestsUnexpected) +
				'), ' +
				colorizeCount(failTotalTests , 'red') + ' total failures (expected ' +
				(stats.failedTests - stats.failedTestsUnexpected + stats.passedTestsUnexpected) +
				')');
		}
	} else {
		if (testFilter !== null) {
			console.log("Passed " + (stats.passedTests + stats.passedTestsWhitelisted) +
					" of " + stats.passedTests + " tests matching " + testFilter +
					"... " + "ALL TESTS PASSED!".green);
		} else {
			// Should not happen if it does: Champagne!
			console.log("Passed " + stats.passedTests + " of " + stats.passedTests +
					" tests... " + "ALL TESTS PASSED!".green);
		}
	}

	// If we logged error messages, complain about it.
	var logMsg = 'No errors logged.'.green;
	if (loggedErrorCount > 0) {
		logMsg = (loggedErrorCount + " errors logged.").red;
	}
	if (file === null) {
		if (loggedErrorCount > 0) {
			logMsg = ('' + loggedErrorCount).red;
		} else {
			logMsg = ('' + loggedErrorCount).green;
		}
		logMsg += ' errors logged.';
	}
	console.log(logMsg);

	var failures = (
		stats.passedTestsUnexpected +
		stats.failedTestsUnexpected +
		loggedErrorCount
	);

	// If the blacklist changed, complain about it.
	if (blacklistChanged) {
		console.log("Blacklist changed!".red);
	}

	if (file === null) {
		if (failures === 0) {
			console.log('--> ' + 'NO UNEXPECTED RESULTS'.green + ' <--');
			if (blacklistChanged) {
				console.log("Perhaps some tests were deleted or renamed.");
				console.log("Use `bin/parserTests.js --rewrite-blacklist` to update blacklist.");
			}
		} else {
			console.log(('--> ' + failures + ' UNEXPECTED RESULTS. <--').red);
		}
	}

	return failures;
};

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

var printWhitelistEntry = function(title, raw) {
	console.log('WHITELIST ENTRY:'.cyan + '');
	console.log('testWhiteList[' +
		JSON.stringify(title) + '] = ' +
		JSON.stringify(raw) + ';\n');
};

/**
 * @param {Object} stats
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @param {string} title
 * @param {Object} actual
 * @param {Object} expected
 * @param {boolean} expectFail Whether this test was expected to fail (on blacklist).
 * @param {boolean} failureOnly Whether we should print only a failure message, or go on to print the diff.
 * @param {Object} bl BlackList.
 * @return {boolean} True if the failure was expected.
 */
var printFailure = function(stats, item, options, mode, title, actual, expected, expectFail, failureOnly, bl) {
	stats.failedTests++;
	stats.modes[mode].failedTests++;
	var fail = {
		title: title,
		raw: actual ? actual.raw : null,
		expected: expected ? expected.raw : null,
		actualNormalized: actual ? actual.normal : null,
	};
	stats.modes[mode].failList.push(fail);

	var extTitle = (title + (mode ? (' (' + mode + ')') : ''))
		.replace('\n', ' ');

	var blacklisted = false;
	if (Util.booleanOption(options.blacklist) && expectFail) {
		// compare with remembered output
		if (bl[title][mode] !== actual.raw) {
			blacklisted = true;
		} else {
			if (!Util.booleanOption(options.quiet)) {
				console.log('EXPECTED FAIL'.red + ': ' + extTitle.yellow);
			}
			return true;
		}
	}

	stats.failedTestsUnexpected++;
	stats.modes[mode].failedTestsUnexpected++;
	fail.unexpected = true;

	if (!failureOnly) {
		console.log('=====================================================');
	}

	console.log('UNEXPECTED FAIL'.red.inverse + ': ' + extTitle.yellow);

	if (blacklisted) {
		console.log('Blacklisted, but the output changed!'.red);
	}

	if (mode === 'selser') {
		if (item.hasOwnProperty('wt2wtPassed') && item.wt2wtPassed) {
			console.log('Even worse, the non-selser wt2wt test passed!'.red);
		} else if (actual && item.hasOwnProperty('wt2wtResult') &&
				item.wt2wtResult !== actual.raw) {
			console.log('Even worse, the non-selser wt2wt test had a different result!'.red);
		}
	}

	if (!failureOnly) {
		console.log(item.comments.join('\n'));
		if (options) {
			console.log('OPTIONS'.cyan + ':');
			console.log(prettyPrintIOptions(item.options) + '\n');
		}
		console.log('INPUT'.cyan + ':');
		console.log(actual.input + '\n');
		console.log(options.getActualExpected(actual, expected, options.getDiff));
		if (Util.booleanOption(options.printwhitelist)) {
			printWhitelistEntry(title, actual.raw);
		}
	}

	return false;
};

/**
 * @param {Object} stats
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @param {string} title
 * @param {boolean} expectSuccess Whether this success was expected (or was this test blacklisted?).
 * @param {boolean} isWhitelist Whether this success was due to a whitelisting.
 * @return {boolean} True if the success was expected.
 */
var printSuccess = function(stats, item, options, mode, title, expectSuccess, isWhitelist) {
	var quiet = Util.booleanOption(options.quiet);
	if (isWhitelist) {
		stats.passedTestsWhitelisted++;
		stats.modes[mode].passedTestsWhitelisted++;
	} else {
		stats.passedTests++;
		stats.modes[mode].passedTests++;
	}
	var extTitle = (title + (mode ? (' (' + mode + ')') : ''))
		.replace('\n', ' ');

	if (Util.booleanOption(options.blacklist) && !expectSuccess) {
		stats.passedTestsUnexpected++;
		stats.modes[mode].passedTestsUnexpected++;
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
var getActualExpected = function(actual, expected, getDiff) {
	let mkVisible =
		s => s.replace(/\n/g, '\u21b5\n'.white).replace(/\xA0/g, '\u2423'.white);
	if (colors.mode === 'none') {
		mkVisible = s => s;
	}
	var returnStr = '';
	returnStr += 'RAW EXPECTED'.cyan + ':\n';
	returnStr += expected.raw + '\n';

	returnStr += 'RAW RENDERED'.cyan + ':\n';
	returnStr += actual.raw + '\n';

	returnStr += 'NORMALIZED EXPECTED'.magenta + ':\n';
	returnStr += mkVisible(expected.normal) + '\n';

	returnStr += 'NORMALIZED RENDERED'.magenta + ':\n';
	returnStr += mkVisible(actual.normal) + '\n';

	returnStr += 'DIFF'.cyan + ':\n';
	returnStr += getDiff(actual, expected);

	return returnStr;
};

/**
 * @param {Object} actual
 * @param {string} actual.normal
 * @param {Object} expected
 * @param {string} expected.normal
 * @return {string} Colorized diff
 */
var doDiff = function(actual, expected) {
	// safe to always request color diff, because we set color mode='none'
	// if colors are turned off.
	var e = expected.normal.replace(/\xA0/g, '\u2423');
	var a = actual.normal.replace(/\xA0/g, '\u2423');
	return Diff.colorDiff(e, a, {
		context: 2,
		noColor: (colors.mode === 'none'),
	});
};

/**
 * @param {Function} reportFailure
 * @param {Function} reportSuccess
 * @param {Object} bl BlackList.
 * @param {Object} wl WhiteList.
 * @param {Object} stats
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @param {Object} expected
 * @param {Object} actual
 * @param {Function} pre
 * @param {Function} post
 * @return {boolean} True if the result was as expected.
 */
function printResult(reportFailure, reportSuccess, bl, wl, stats, item, options, mode, expected, actual, pre, post) {
	var title = item.title;  // Title may be modified here, so pass it on.

	var quick = Util.booleanOption(options.quick);
	var parsoidOnly =
		('html/parsoid' in item) || (item.options.parsoid !== undefined);

	if (mode === 'selser') {
		title += ' ' + (item.changes ? JSON.stringify(item.changes) : 'manual');
	}

	var whitelist = false;
	var tb = bl[title];
	var expectFail = (tb && tb.hasOwnProperty(mode));
	var fail = (expected.normal !== actual.normal);
	// Return whether the test was as expected, independent of pass/fail
	var asExpected;

	if (fail &&
		Util.booleanOption(options.whitelist) &&
		title in wl &&
		DU.normalizeOut(DU.parseHTML(wl[title]).body, parsoidOnly) ===  actual.normal
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
		pre(stats, mode, title, item.time);
	}

	if (fail) {
		asExpected = reportFailure(stats, item, options, mode, title, actual, expected, expectFail, quick, bl);
	} else {
		asExpected = reportSuccess(stats, item, options, mode, title, !expectFail, whitelist);
	}

	if (typeof post === 'function') {
		post(stats, mode);
	}

	return asExpected;
}

var _reportOnce = false;
/**
 * Simple function for reporting the start of the tests.
 *
 * This method can be reimplemented in the options of the ParserTests object.
 */
var reportStartOfTests = function() {
	if (!_reportOnce) {
		_reportOnce = true;
		console.log('ParserTests running with node', process.version);
		console.log('Initialization complete. Now launching tests.');
	}
};

/**
 * Get the actual and expected outputs encoded for XML output.
 *
 * @inheritdoc getActualExpected
 *
 * @return {string} The XML representation of the actual and expected outputs.
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
	returnStr += DU.encodeXml(getDiff(actual, expected, false));

	return returnStr;
};

/**
 * Report the start of the tests output.
 *
 * @inheritdoc reportStart
 */
var reportStartXML = function() {};

/**
 * Report the end of the tests output.
 *
 * @inheritdoc reportSummary
 */
var reportSummaryXML = function(modesRan, stats, file, loggedErrorCount, testFilter, blacklistChanged) {
	if (file === null) {
		/* Summary for all tests; not included in XML format output. */
		return;
	}
	console.log('<testsuites file="' + file + '">');
	for (var i = 0; i < modesRan.length; i++) {
		var mode = modesRan[i];
		console.log('<testsuite name="parserTests-' + mode + '">');
		console.log(stats.modes[mode].result);
		console.log('</testsuite>');
	}
	console.log('</testsuites>');
};

/**
 * Print a failure message for a test in XML.
 *
 * @inheritdoc printFailure
 */
var reportFailureXML = function(stats, item, options, mode, title, actual, expected, expectFail, failureOnly, bl) {
	stats.failedTests++;
	stats.modes[mode].failedTests++;
	var failEle = '';
	var blacklisted = false;
	if (Util.booleanOption(options.blacklist) && expectFail) {
		// compare with remembered output
		blacklisted = (bl[title][mode] === actual.raw);
	}
	if (!blacklisted) {
		failEle += '<failure type="parserTestsDifferenceInOutputFailure">\n';
		failEle += getActualExpectedXML(actual, expected, options.getDiff);
		failEle += '\n</failure>';
		stats.failedTestsUnexpected++;
		stats.modes[mode].failedTestsUnexpected++;
		stats.modes[mode].result += failEle;
	}
};

/**
 * Print a success method for a test in XML.
 *
 * @inheritdoc printSuccess
 */
var reportSuccessXML = function(stats, item, options, mode, title, expectSuccess, isWhitelist) {
	if (isWhitelist) {
		stats.passedTestsWhitelisted++;
		stats.modes[mode].passedTestsWhitelisted++;
	} else {
		stats.passedTests++;
		stats.modes[mode].passedTests++;
	}
};

/**
 * Print the result of a test in XML.
 *
 * @inheritdoc printResult
 */
var reportResultXML = function() {
	function pre(stats, mode, title, time) {
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
		stats.modes[mode].result += testcaseEle;
	}

	function post(stats, mode) {
		stats.modes[mode].result += '</testcase>';
	}

	var args = Array.prototype.slice.call(arguments);
	args = [ reportFailureXML, reportSuccessXML ].concat(args, pre, post);
	printResult.apply(this, args);

	// In xml, test all cases always
	return true;
};

/**
 * Get the options from the command line.
 *
 * @return {Object}
 */
var getOpts = function() {
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
			description: 'Get tests cases from cache file',
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
		},
		'update-unexpected': {
			description: 'Update parserTests.txt with results from wt2html unexpected fails.',
			'default': false,
			'boolean': true,
		},
	}, {
		// override defaults for standard options
		fetchTemplates: false,
		usePHPPreProcessor: false,
		fetchConfig: false,
	});

	return yargs.usage(
		'Usage: $0 [options] [tests-file]',
		standardOpts
	).check(function(argv, aliases) {
		if (argv.filter === true) {
			throw "--filter needs an argument";
		}
		if (argv.regex === true) {
			throw "--regex needs an argument";
		}
		return true;
	}).strict();
};

PTUtils.prepareOptions = function() {
	var popts = getOpts();
	var options = popts.argv;

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
		if (Util.booleanOption(options['rewrite-blacklist'])) {
			// turn on all modes by default for --rewrite-blacklist
			options.selser = true;
			// sanity checking (T53448 asks to be able to use --filter here)
			if (options.filter || options.regex || options.maxtests || options['exit-unexpected']) {
				console.log("\nERROR> can't combine --rewrite-blacklist with --filter, --maxtests or --exit-unexpected");
				process.exit(1);
			}
		}
	}

	if (options.xml) {
		options.reportResult = reportResultXML;
		options.reportStart = reportStartXML;
		options.reportSummary = reportSummaryXML;
		options.reportFailure = reportFailureXML;
		colors.mode = 'none';
	}

	if (typeof options.reportFailure !== 'function') {
		// default failure reporting is standard out,
		// see printFailure for documentation of the default.
		options.reportFailure = printFailure;
	}

	if (typeof options.reportSuccess !== 'function') {
		// default success reporting is standard out,
		// see printSuccess for documentation of the default.
		options.reportSuccess = printSuccess;
	}

	if (typeof options.reportStart !== 'function') {
		// default summary reporting is standard out,
		// see reportStart for documentation of the default.
		options.reportStart = reportStartOfTests;
	}

	if (typeof options.reportSummary !== 'function') {
		// default summary reporting is standard out,
		// see reportSummary for documentation of the default.
		options.reportSummary = reportSummary;
	}

	if (typeof options.reportResult !== 'function') {
		// default result reporting is standard out,
		// see printResult for documentation of the default.
		options.reportResult = printResult.bind(null, options.reportFailure, options.reportSuccess);
	}

	if (typeof options.getDiff !== 'function') {
		// this is the default for diff-getting, but it can be overridden
		// see doDiff for documentation of the default.
		options.getDiff = doDiff;
	}

	if (typeof options.getActualExpected !== 'function') {
		// this is the default for getting the actual and expected
		// outputs, but it can be overridden
		// see getActualExpected for documentation of the default.
		options.getActualExpected = getActualExpected;
	}

	options.modes = [];

	if (options.wt2html) {
		options.modes.push('wt2html');
	}
	if (options.wt2wt) {
		options.modes.push('wt2wt');
	}
	if (options.html2html) {
		options.modes.push('html2html');
	}
	if (options.html2wt) {
		options.modes.push('html2wt');
	}
	if (options.selser) {
		options.modes.push('selser');
	}

	return options;
};

// Hard-code some interwiki prefixes, as is done
// in parserTest.inc:setupInterwikis()
PTUtils.iwl = {
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

PTUtils.addNamespace = function(wikiConf, name) {
	var nsid = name.id;
	var old = wikiConf.siteInfo.namespaces[nsid];
	if (old) {  // Id may already be defined; if so, clear it.
		if (old === name) { return; }  // ParserTests does a lot redundantly.
		wikiConf.namespaceIds.delete(Util.normalizeNamespaceName(old['*']));
		wikiConf.canonicalNamespaces[Util.normalizeNamespaceName(old.canonical ? old.canonical : old['*'])] = undefined;
	}
	wikiConf.namespaceNames[nsid] = name['*'];
	wikiConf.namespaceIds.set(Util.normalizeNamespaceName(name['*']), Number(nsid));
	wikiConf.canonicalNamespaces[Util.normalizeNamespaceName(name.canonical ? name.canonical : name['*'])] = Number(nsid);
	wikiConf.namespacesWithSubpages[nsid] = true;
	wikiConf.siteInfo.namespaces[nsid] = name;
};
