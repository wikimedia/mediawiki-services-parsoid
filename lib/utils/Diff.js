/**
 * Diff tools.
 * @module
 */

'use strict';

var simpleDiff = require('simplediff');

var Util = require('./Util.js').Util;

/** @namespace */
var Diff = {};

/** @func */
Diff.convertDiffToOffsetPairs = function(diff, srcLengths, outLengths) {
	var currentPair;
	var pairs = [];
	var srcOff = 0;
	var outOff = 0;
	var srcIndex = 0;
	var outIndex = 0;
	diff.forEach(function(change) {
		var pushPair = function(pair, start) {
			if (!pair.added) {
				pair.added = { start: start, end: start };
			} else if (!pair.removed) {
				pair.removed = { start: start, end: start };
			}
			pairs.push([ pair.removed, pair.added ]);
			currentPair = {};
		};

		// Use original line lengths;
		var srcLen = 0;
		var outLen = 0;
		change[1].forEach(function() {
			if (change[0] === '+') {
				outLen += outLengths[outIndex];
				outIndex++;
			} else if (change[0] === '-') {
				srcLen += srcLengths[srcIndex];
				srcIndex++;
			} else {
				srcLen += srcLengths[srcIndex];
				outLen += outLengths[outIndex];
				srcIndex++;
				outIndex++;
			}
		});

		if (!currentPair) {
			currentPair = {};
		}

		if (change[0] === '+') {
			if (currentPair.added) {
				pushPair(currentPair, srcOff); // srcOff used for adding pair.removed
			}

			currentPair.added = { start: outOff };
			outOff += outLen;
			currentPair.added.end = outOff;

			if (currentPair.removed) {
				pushPair(currentPair);
			}
		} else if (change[0] === '-') {
			if (currentPair.removed) {
				pushPair(currentPair, outOff); // outOff used for adding pair.added
			}

			currentPair.removed = { start: srcOff };
			srcOff += srcLen;
			currentPair.removed.end = srcOff;

			if (currentPair.added) {
				pushPair(currentPair);
			}
		} else {
			if (currentPair.added || currentPair.removed) {
				pushPair(currentPair, currentPair.added ? srcOff : outOff);
			}

			srcOff += srcLen;
			outOff += outLen;
		}
	});
	return pairs;
};

/** @func */
Diff.convertChangesToXML = function(changes) {
	var result = [];
	for (var i = 0; i < changes.length; i++) {
		var change = changes[i];
		if (change[0] === '+') {
			result.push('<ins>');
		} else if (change[0] === '-') {
			result.push('<del>');
		}

		result.push(Util.escapeHtml(change[1].join('')));

		if (change[0] === '+') {
			result.push('</ins>');
		} else if (change[0] === '-') {
			result.push('</del>');
		}
	}
	return result.join('');
};

var diffTokens = function(oldString, newString, tokenize) {
	if (oldString === newString) {
		return [['=', [newString]]];
	} else {
		return simpleDiff.diff(tokenize(oldString), tokenize(newString));
	}
};

/** @func */
Diff.diffWords = function(oldString, newString) {
	// This is a complicated regexp, but it improves on the naive \b by:
	// * keeping tag-like things (<pre>, <a, </a>, etc) together
	// * keeping possessives and contractions (don't, etc) together
	// * ensuring that newlines always stay separate, so we don't
	//   have diff chunks that contain multiple newlines
	//   (ie, "remove \n\n" followed by "add \n", instead of
	//   "keep \n", "remove \n")
	var wordTokenize =
		value => value.split(/((?:<\/?)?\w+(?:'\w+|>)?|\s(?:(?!\n)\s)*)/g).filter(
			// For efficiency, filter out zero-length strings from token list
			// UGLY HACK: simplediff trips if one of tokenized words is
			// 'constructor'. Since this failure breaks parserTests.js runs,
			// work around that by hiding that diff for now.
			s => s !== '' && s !== 'constructor'
		);
	return diffTokens(oldString, newString, wordTokenize);
};

/** @func */
Diff.diffLines = function(oldString, newString) {
	var lineTokenize = function(value) {
		return value.split(/^/m).map(function(line) {
			return line.replace(/\r$/g, '\n');
		});
	};
	return diffTokens(oldString, newString, lineTokenize);
};

/** @func */
Diff.colorDiff = function(a, b, options) {
	const context = options && options.context;
	let diffs = 0;
	let buf = '';
	let before = '';
	const visibleWs = s => s.replace(/[ \xA0]/g,'\u2423');
	const funcs = (options && options.html) ? {
		'+': s => '<font color="green">' + Util.escapeHtml(visibleWs(s)) + '</font>',
		'-': s => '<font color="red">' + Util.escapeHtml(visibleWs(s)) + '</font>',
		'=': s => Util.escapeHtml(s),
	} : (options && options.noColor) ? {
		'+': s => '{+' + s + '+}',
		'-': s => '{-' + s + '-}',
		'=': s => s,
	} : {
		// add '' to workaround color bug; make spaces visible
		'+': s => visibleWs(s).green + '',
		'-': s => visibleWs(s).red + '',
		'=': s => s,
	};
	const NL = (options && options.html) ? '<br/>\n' : '\n';
	const DIFFSEP = (options && options.separator) || NL;
	const visibleNL = '\u21b5';
	for (const change of Diff.diffWords(a, b)) {
		const op = change[0];
		const value = change[1].join('');
		if (op !== '=') {
			diffs++;
			buf += before;
			before = '';
			buf += value.split('\n').map((s,i,arr) => {
				if (i !== (arr.length - 1)) { s += visibleNL; }
				return s ? funcs[op](s) : s;
			}).join(NL);
		} else {
			if (context) {
				const lines = value.split('\n');
				if (lines.length > 2 * (context + 1)) {
					const first = lines.slice(0, context + 1).join(NL);
					const last = lines.slice(lines.length - context - 1).join(NL);
					if (diffs > 0) {
						buf += first + NL;
					}
					before = (diffs > 0 ? DIFFSEP : '') + last;
					continue;
				}
			}
			buf += value;
		}
	}
	if (options && options.diffCount) {
		return { count: diffs, output: buf };
	}
	return (diffs > 0) ? buf : '';
};

/**
 * This is essentially lifted from jsDiff@1.4.0, but using our diff and
 * without the header and no newline warning.
 * @private
 */
var createPatch = function(diff) {
	var ret = [];

	diff.push({ value: '', lines: [] });  // Append an empty value to make cleanup easier

	// Formats a given set of lines for printing as context lines in a patch
	function contextLines(lines) {
		return lines.map(function(entry) { return ' ' + entry; });
	}

	var oldRangeStart = 0;
	var newRangeStart = 0;
	var curRange = [];
	var oldLine = 1;
	var newLine = 1;

	for (var i = 0; i < diff.length; i++) {
		var current = diff[i];
		var lines = current.lines || current.value.replace(/\n$/, '').split('\n');
		current.lines = lines;

		if (current.added || current.removed) {
			// If we have previous context, start with that
			if (!oldRangeStart) {
				var prev = diff[i - 1];
				oldRangeStart = oldLine;
				newRangeStart = newLine;

				if (prev) {
					curRange = contextLines(prev.lines.slice(-4));
					oldRangeStart -= curRange.length;
					newRangeStart -= curRange.length;
				}
			}

			// Output our changes
			curRange.push.apply(curRange, lines.map(function(entry) {
				return (current.added ? '+' : '-') + entry;
			}));

			// Track the updated file position
			if (current.added) {
				newLine += lines.length;
			} else {
				oldLine += lines.length;
			}
		} else {
			// Identical context lines. Track line changes
			if (oldRangeStart) {
				// Close out any changes that have been output (or join overlapping)
				if (lines.length <= 8 && i < diff.length - 2) {
					// Overlapping
					curRange.push.apply(curRange, contextLines(lines));
				} else {
					// end the range and output
					var contextSize = Math.min(lines.length, 4);
					ret.push(
						'@@ -' + oldRangeStart + ',' + (oldLine - oldRangeStart + contextSize)
						+ ' +' + newRangeStart + ',' + (newLine - newRangeStart + contextSize)
						+ ' @@');
					ret.push.apply(ret, curRange);
					ret.push.apply(ret, contextLines(lines.slice(0, contextSize)));

					oldRangeStart = 0;
					newRangeStart = 0;
					curRange = [];
				}
			}
			oldLine += lines.length;
			newLine += lines.length;
		}
	}

	return ret.join('\n') + '\n';
};

/** @func */
Diff.patchDiff = function(a, b) {
	// Essentially lifted from jsDiff@1.4.0's PatchDiff.tokenize
	var patchTokenize = function(value) {
		var ret = [];
		var linesAndNewlines = value.split(/(\n|\r\n)/);
		// Ignore the final empty token that occurs if the string ends with a new line
		if (!linesAndNewlines[linesAndNewlines.length - 1]) {
			linesAndNewlines.pop();
		}
		// Merge the content and line separators into single tokens
		for (var i = 0; i < linesAndNewlines.length; i++) {
			var line = linesAndNewlines[i];
			if (i % 2) {
				ret[ret.length - 1] += line;
			} else {
				ret.push(line);
			}
		}
		return ret;
	};
	var diffs = 0;
	var diff = diffTokens(a, b, patchTokenize)
	.map(function(change) {
		var value = change[1].join('');
		switch (change[0]) {
			case '+':
				diffs++;
				return { value: value, added: true };
			case '-':
				diffs++;
				return { value: value, removed: true };
			default:
				return { value: value };
		}
	});
	if (!diffs) { return null; }
	return createPatch(diff);
};

if (typeof module === "object") {
	module.exports.Diff = Diff;
}
