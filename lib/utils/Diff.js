'use strict';

var simpleDiff = require('simplediff');

var Util = require('./Util.js').Util;

var Diff = {};

Diff.convertDiffToOffsetPairs = function(diff) {
	var currentPair;
	var pairs = [];
	var srcOff = 0;
	var outOff = 0;
	diff.forEach(function(change) {
		var pushPair = function(pair, start) {
			if (!pair.added) {
				pair.added = { start: start, end: start };
			} else if (!pair.removed) {
				pair.removed = { start: start, end: start };
			}
			pairs.push([ pair.added, pair.removed ]);
			currentPair = {};
		};

		var valueLength = change[1].join('').length;

		if (!currentPair) {
			currentPair = {};
		}

		if (change[0] === '+') {
			if (currentPair.added) {
				pushPair(currentPair, outOff);
			}

			currentPair.added = { start: outOff };
			outOff += valueLength;
			currentPair.added.end = outOff;

			if (currentPair.removed) {
				pushPair(currentPair);
			}
		} else if (change[0] === '-') {
			if (currentPair.removed) {
				pushPair(currentPair, srcOff);
			}

			currentPair.removed = { start: srcOff };
			srcOff += valueLength;
			currentPair.removed.end = srcOff;

			if (currentPair.added) {
				pushPair(currentPair);
			}
		} else {
			if (currentPair.added || currentPair.removed) {
				pushPair(currentPair, currentPair.added ? srcOff : outOff);
			}

			srcOff += valueLength;
			outOff += valueLength;
		}
	});
	return pairs;
};

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

Diff.diffWords = function(oldString, newString) {
	var wordTokenize = function(value) {
		return value.split(/(\s+|\b)/);
	};
	return diffTokens(oldString, newString, wordTokenize);
};

Diff.diffLines = function(oldString, newString) {
	var lineTokenize = function(value) {
		return value.split(/^/m).map(function(line) {
			return line.replace(/\r$/g, '\n');
		});
	};
	return diffTokens(oldString, newString, lineTokenize);
};

Diff.colorDiff = function(a, b) {
	var diffs = 0;
	var diff = Diff.diffWords(a, b)
	.map(function(change) {
		var value = change[1].join('');
		switch (change[0]) {
			case '+':
				diffs++;
				return value.split('\n').map(function(line) {
					return line.green + '';  // add '' to workaround color bug
				}).join('\n');
			case '-':
				diffs++;
				return value.split('\n').map(function(line) {
					return line.red + '';  // add '' to workaround color bug
				}).join('\n');
			default:
				return value;
		}
	})
	.join('');
	return (diffs > 0) ? diff : '';
};

/**
 * This is essentially lifted from jsDiff@1.4.0, but using our diff and
 * without the header and no newline warning.
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
