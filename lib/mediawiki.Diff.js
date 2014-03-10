"use strict";
var simpleDiff = require('simplediff');

var Diff = {};
(function(exports){

	/**
	 * Perform word-based diff on a line-based diff. The word-based algorithm is
	 * practically unusable for inputs > 5k bytes, so we only perform it on the
	 * output of the more efficient line-based diff.
	 *
	 * @method
	 * @param {Array} diff The diff to refine
	 * @returns {Array} The refined diff
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

	var escapeHTML = function(string) {
		var result = string;
		result = result.replace(/&/g, '&amp;');
		result = result.replace(/</g, '&lt;');
		result = result.replace(/>/g, '&gt;');
		result = result.replace(/"/g, '&quot;');
		return result;
	};

	exports.convertChangesToXML = function(changes){
		var result = [];
		for ( var i = 0; i < changes.length; i++) {
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

	exports.diffLines = function(oldString, newString) {
		var lineTokenize = function(value) {
			var retLines = [],
			lines = value.split(/^/m);
			for (var i = 0; i < lines.length; i++) {
				var line = lines[i],
				lastLine = lines[i - 1];
				// Merge lines that may contain windows new lines
				if (line === '\n' && lastLine && lastLine[lastLine.length - 1] === '\r') {
					retLines[retLines.length - 1] += '\n';
				} else if (line) {
					retLines.push(line);
				}
			}
			return retLines;
		};
		return diffTokens(oldString, newString, lineTokenize);
	};


})(Diff);

if (typeof module === "object") {
	module.exports.Diff = Diff;
}