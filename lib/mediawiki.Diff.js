'use strict';

var simpleDiff = require('simplediff');
var jsDiff = require('diff');


var Diff = {};

/**
 * Perform word-based diff on a line-based diff. The word-based algorithm is
 * practically unusable for inputs > 5k bytes, so we only perform it on the
 * output of the more efficient line-based diff.
 *
 * @method
 * @param {Array} diff The diff to refine
 * @return {Array} The refined diff
 */
// var refineDiff = function ( diff ) {
// 	// Attempt to accumulate consecutive add-delete pairs
// 	// with short text separating them (short = 2 chars right now)
// 	//
// 	// This is equivalent to the <b><i> ... </i></b> minimization
// 	// to expand range of <b> and <i> tags, except there is no optimal
// 	// solution except as determined by heuristics ("short text" = <= 2 chars).
// 	function mergeConsecutiveSegments(wordDiffs) {
// 		var n = wordDiffs.length,
// 			currIns = null, currDel = null,
// 			newDiffs = [];
// 		for (var i = 0; i < n; i++) {
// 			var d = wordDiffs[i],
// 				dVal = d.value;
// 			if (d.added) {
// 				// Attempt to accumulate
// 				if (currIns === null) {
// 					currIns = d;
// 				} else {
// 					currIns.value = currIns.value + dVal;
// 				}
// 			} else if (d.removed) {
// 				// Attempt to accumulate
// 				if (currDel === null) {
// 					currDel = d;
// 				} else {
// 					currDel.value = currDel.value + dVal;
// 				}
// 			} else if (((dVal.length < 4) || !dVal.match(/\s/)) && currIns && currDel) {
// 				// Attempt to accumulate
// 				currIns.value = currIns.value + dVal;
// 				currDel.value = currDel.value + dVal;
// 			} else {
// 				// Accumulation ends. Purge!
// 				if (currIns !== null) {
// 					newDiffs.push(currIns);
// 					currIns = null;
// 				}
// 				if (currDel !== null) {
// 					newDiffs.push(currDel);
// 					currDel = null;
// 				}
// 				newDiffs.push(d);
// 			}
// 		}

// 		// Purge buffered diffs
// 		if (currIns !== null) {
// 			newDiffs.push(currIns);
// 		}
// 		if (currDel !== null) {
// 			newDiffs.push(currDel);
// 		}

// 		return newDiffs;
// 	}

// 	var added = null,
// 		out = [];
// 	for ( var i = 0, l = diff.length; i < l; i++ ) {
// 		var d = diff[i];
// 		if ( d.added ) {
// 			if ( added ) {
// 				out.push( added );
// 			}
// 			added = d;
// 		} else if ( d.removed ) {
// 			if ( added ) {
// 				var fineDiff = jsDiff.diffWords( d.value, added.value );
// 				fineDiff = mergeConsecutiveSegments(fineDiff);
// 				out.push.apply( out, fineDiff );
// 				added = null;
// 			} else {
// 				out.push( d );
// 			}
// 		} else {
// 			if ( added ) {
// 				out.push( added );
// 				added = null;
// 			}
// 			out.push(d);
// 		}
// 	}
// 	if ( added ) {
// 		out.push(added);
// 	}
// 	return out;
// };

// Variant of diff with some extra context
var contextDiff = function(a, b, color, onlyReportChanges, useLines) {
	var diff = jsDiff.diffLines(a, b);
	var offsetPairs = this.convertDiffToOffsetPairs(diff);
	var results = [];
	offsetPairs.map(function(pair) {
		var context = 5;
		var asource = a.substring(pair[0].start - context, pair[0].end + context);
		var bsource = b.substring(pair[1].start - context, pair[1].end + context);
		results.push('++++++\n' + JSON.stringify(asource));
		results.push('------\n' + JSON.stringify(bsource));
		// results.push('======\n' + Diff.htmlDiff(a, b, color, onlyReportChanges, useLines));
	});
	if (!onlyReportChanges || diff.length > 0) {
		return results.join('\n');
	} else {
		return '';
	}
};

Diff.convertDiffToOffsetPairs = function(diff) {
	var currentPair;
	var pairs = [];
	var srcOff = 0;
	var outOff = 0;
	diff.map(function(change) {
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

var escapeHTML = function(string) {
	var result = string;
	result = result.replace(/&/g, '&amp;');
	result = result.replace(/</g, '&lt;');
	result = result.replace(/>/g, '&gt;');
	result = result.replace(/"/g, '&quot;');
	return result;
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

		result.push(escapeHTML(change[1].join('')));

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

Diff.diffLines = function(oldString, newString) {
	var lineTokenize = function(value) {
		return value.split(/^/m).map(function(line) {
			return line.replace(/\r$/g, '\n');
		});
	};
	return diffTokens(oldString, newString, lineTokenize);
};

Diff.htmlDiff = function(a, b, color, onlyReportChanges, useLines) {
	var thediff, patch;
	var diffs = 0;
	if (color) {
		thediff = jsDiff[useLines ? 'diffLines' : 'diffWords'](a, b).map(function(change) {
			if (useLines && change.value[-1] !== '\n') {
				change.value += '\n';
			}
			if (change.added) {
				diffs++;
				return change.value.split('\n').map(function(line) {
					return line.green + ''; //  add '' to workaround color bug
				}).join('\n');
			} else if (change.removed) {
				diffs++;
				return change.value.split('\n').map(function(line) {
					return line.red + '';  // add '' to workaround color bug
				}).join('\n');
			} else {
				return change.value;
			}
		}).join('');
		if (!onlyReportChanges || diffs > 0) {
			return thediff;
		} else {
			return '';
		}
	} else {
		patch = jsDiff.createPatch('wikitext.txt', a, b, 'before', 'after');

		// Strip the header from the patch, we know how diffs work..
		patch = patch.replace(/^[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/, '');

		// Don't care about not having a newline.
		patch = patch.replace(/^\\ No newline at end of file\n/, '');

		return patch;
	}
};

if (typeof module === "object") {
	module.exports.Diff = Diff;
}
