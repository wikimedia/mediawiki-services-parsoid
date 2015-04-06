/*
* This file contains diff related functions for use in tests/server,
* to compare test results for a given page from different revisions.
*/

"use strict";
var simpleDiff = require('simplediff');

var Diff = {};

var diffTokens = function(oldString, newString, tokenize) {
	if (oldString === newString) {
		return [['=', [newString]]];
	} else {
		return simpleDiff.diff(tokenize(oldString), tokenize(newString));
	}
};

var diffResults = function(oldString, newString) {
	var testcaseTokenize = function(resultString) {
		var testcases = resultString.split(/<\/skipped>|<\/failure>/);
		// Omit everything that's not part of a <skipped> or <failure> element,
		// as this can contain info we're not interested in diffing
		// (eg character number within original text, perfstats).
		testcases = testcases.slice(0, -1);
		testcases = testcases.map(function(testcase) {
			var skipTagIndex = testcase.indexOf('<skipped');
			if (skipTagIndex !== -1) {
				return testcase.slice(skipTagIndex);
			} else {
				return testcase.slice(testcase.indexOf('<failure'));
			}
		});
		return testcases;
	};

	return diffTokens(oldString, newString, testcaseTokenize);
};

var testcaseStatus = function(diff, flag) {
	// Returns an array of 0's and 1's, where, supposing flag is '+', 1 in the nth position
	// means that the n'th token of the newer diffed item isn't a token of the older item.
	// (And symmetrically for '-', interchanging roles of 'newer' and 'older'.)
	var array = [];
	for (var i = 0, l = diff.length; i < l; i++) {
		var change = diff[i];
		if (change[0] === flag) {
			for (var j = 0; j < change[1].length; j++) {
				array.push(1);
			}
		} else if (change[0] === '=') {
			for (var k = 0; k < change[1].length; k++) {
				array.push(0);
			}
		}
	}
	return array;
};

// If flag is '+', adds status="new" attribute to <testcase> tags for testcases ocurring in
// newString but not in oldString. Otherwise (flag is '-') adds status="old" to <testcase>'s occuring in
// oldString but not in newString.
Diff.resultFlagged = function(oldString, newString, oldCommit, newCommit, flag) {
	// If one of the two results is an error, don't flag differences.
	if (oldString.slice(0, 6) === '<error' || newString.slice(0, 6) === '<error') {
		var output = flag === '+' ? newString : oldString;
		return output;
	}

	var status = flag === '+' ? 'new' : 'old';
	var xmlWrapper = flag === '+' ? 'FlagNewTestcases' : 'FlagOldTestcases';
	var testcases = flag === '+' ? newString.split(/(<\/testcase>)/) : oldString.split(/(<\/testcase>)/);
	var result, pre, post;

	if (testcases.length === 1) {
		// No diffs!
		result = testcases[0];
		pre = post = "";
	} else {
		var diff = diffResults(oldString, newString);
		var statusArray = testcaseStatus(diff, flag);
		var startTestcases = testcases[0].indexOf('<testcase');
		pre = testcases[0].slice(0, startTestcases);
		post = testcases[testcases.length - 1];
		testcases[0] = testcases[0].slice(startTestcases);

		var results = [];
		for (var i = 0, l = testcases.length - 1; i < l; i++) {
			if (i % 2 === 0 && statusArray[i / 2]) {
				testcases[i] = testcases[i].replace('<testcase', '<testcase status="' + status + '"');
			}
			results.push(testcases[i]);
		}
		result = results.join('');
	}

	return '<' + xmlWrapper  + ' oldCommit ="' + oldCommit + '" newCommit="' + newCommit + '" >' +
		pre + result + post + '</' + xmlWrapper + '>';
};

if (typeof module === "object") {
	module.exports.Diff = Diff;
}
