/* A map of tests which we know Parsoid currently fails.
 *
 * New patches which fix previously-broken tests should also patch this
 * file to document which tests are now expected to succeed.
 *
 * This helps clean up 'npm test' output, documents known bugs, and helps
 * Jenkins make sense of the parserTest output.
 *
 * NOTE that the selser blacklist depends on tests/selser.changes.json
 * If the selser change list is modified, this blacklist should be refreshed.
 *
 * This blacklist can be automagically updated by running
 *    parserTests.js --rewrite-blacklist
 * You might want to do this after you fix some bug that makes more tests
 * pass.  It is still your responsibility to carefully review the blacklist
 * diff to ensure there are no unexpected new failures (lines added).
 */

/*
 * This should map test titles to an array of test types (wt2html, wt2wt,
 * html2html, html2wt, selser) which are known to fail.
 * For easier maintenance, we group each test type together, and use a
 * helper function to create the array if needed then append the test type.
 */

'use strict';

var testBlackList = {};
var add = function(testtype, title, raw) {  // eslint-disable-line
	if (typeof (testBlackList[title]) !== 'object') {
		testBlackList[title] = {
			modes: [],
			raw: raw,
		};
	}
	testBlackList[title].modes.push(testtype);
};

// ### DO NOT REMOVE THIS LINE ### (start of automatically-generated section)

// Blacklist for wt2html


// Blacklist for wt2wt


// Blacklist for html2html


// Blacklist for html2wt


// Blacklist for selser

// ### DO NOT REMOVE THIS LINE ### (end of automatically-generated section)


if (typeof module === 'object') {
	module.exports.testBlackList = testBlackList;
}
