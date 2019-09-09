/** @module */

'use strict';

require('../../core-upgrade.js');

var JSUtils = require('../utils/jsutils.js').JSUtils;
var wtConsts = require('../config/WikitextConstants.js');
var Consts = wtConsts.WikitextConstants;
var Util = require('../utils/Util.js').Util;
var DOMDataUtils = require('../utils/DOMDataUtils.js').DOMDataUtils;
var DOMUtils = require('../utils/DOMUtils.js').DOMUtils;
var DiffUtils = require('./DiffUtils.js').DiffUtils;
var WTSUtils = require('./WTSUtils.js').WTSUtils;
var WTUtils = require('../utils/WTUtils.js').WTUtils;

/**
 * Clean up the constraints object to prevent excessively verbose output
 * and clog up log files / test runs.
 * @private
 */
function loggableConstraints(constraints) {
	var c = {
		a: constraints.a,
		b: constraints.b,
		min: constraints.min,
		max: constraints.max,
		force: constraints.force,
	};
	if (constraints.constraintInfo) {
		c.constraintInfo = {
			onSOL: constraints.constraintInfo.onSOL,
			sepType: constraints.constraintInfo.sepType,
			nodeA: constraints.constraintInfo.nodeA.nodeName,
			nodeB: constraints.constraintInfo.nodeB.nodeName,
		};
	}
	return c;
}

function precedingSeparatorTxt(n) {
	// Given the CSS white-space property and specifically,
	// "pre" and "pre-line" values for this property, it seems that any
	// sane HTML editor would have to preserve IEW in HTML documents
	// to preserve rendering. One use-case where an editor might change
	// IEW drastically would be when the user explicitly requests it
	// (Ex: pretty-printing of raw source code).
	//
	// For now, we are going to exploit this.  This information is
	// only used to extrapolate DSR values and extract a separator
	// string from source, and is only used locally.  In addition,
	// the extracted text is verified for being a valid separator.
	//
	// So, at worst, this can create a local dirty diff around separators
	// and at best, it gets us a clean diff.

	var buf = '';
	var orig = n;
	while (n) {
		if (DOMUtils.isIEW(n)) {
			buf += n.nodeValue;
		} else if (DOMUtils.isComment(n)) {
			buf += "<!--";
			buf += n.nodeValue;
			buf += "-->";
		} else if (n !== orig) { // dont return if input node!
			return null;
		}

		n = n.previousSibling;
	}

	return buf;
}

/**
 * Helper for updateSeparatorConstraints.
 *
 * Collects, checks and integrates separator newline requirements to a simple
 * min, max structure.
 * @param {SerializerState} state
 * @param {Node} nodeA
 * @param {Object} aCons
 * @param {Node} nodeB
 * @param {Object} bCons
 * @return {Object}
 * @return {Object} [return.a]
 * @return {Object} [return.b]
 * @private
 */
function getSepNlConstraints(state, nodeA, aCons, nodeB, bCons) {
	const env = state.env;

	const nlConstraints = {
		min: aCons.min,
		max: aCons.max,
		force: aCons.force || bCons.force,
	};

	// now figure out if this conflicts with the nlConstraints so far
	if (bCons.min !== undefined) {
		if (nlConstraints.max !== undefined && nlConstraints.max < bCons.min) {
			// Conflict, warn and let nodeB win.
			env.log("info/html2wt", "Incompatible constraints 1:", nodeA.nodeName,
					nodeB.nodeName, loggableConstraints(nlConstraints));
			nlConstraints.min = bCons.min;
			nlConstraints.max = bCons.min;
		} else {
			nlConstraints.min = Math.max(nlConstraints.min || 0, bCons.min);
		}
	}

	if (bCons.max !== undefined) {
		if (nlConstraints.min !== undefined && nlConstraints.min > bCons.max) {
			// Conflict, warn and let nodeB win.
			env.log("info/html2wt", "Incompatible constraints 2:", nodeA.nodeName,
					nodeB.nodeName, loggableConstraints(nlConstraints));
			nlConstraints.min = bCons.max;
			nlConstraints.max = bCons.max;
		} else if (nlConstraints.max !== undefined) {
			nlConstraints.max = Math.min(nlConstraints.max, bCons.max);
		} else {
			nlConstraints.max = bCons.max;
		}
	}

	if (nlConstraints.max === undefined) {
		// Anything more than two lines will trigger paragraphs, so default to
		// two if nothing is specified.
		nlConstraints.max = 2;
	}

	return nlConstraints;
}

/**
 * Create a separator given a (potentially empty) separator text and newline
 * constraints.
 * @return {string}
 * @private
 */
function makeSeparator(state, sep, nlConstraints) {
	var origSep = sep;

	// Split on comment/ws-only lines, consuming subsequent newlines since
	// those lines are ignored by the PHP parser
	// Ignore lines with ws and a single comment in them
	var splitReString = [
		'(?:\n(?:[ \t]*?',
		Util.COMMENT_REGEXP.source,
		'[ \t]*?)+(?=\n))+|',
		Util.COMMENT_REGEXP.source,
	].join('');
	var splitRe = new RegExp(splitReString);
	var sepMatch = sep.split(splitRe).join('').match(/\n/g);
	var sepNlCount = sepMatch && sepMatch.length || 0;
	var minNls = nlConstraints.min || 0;

	if (state.atStartOfOutput && minNls > 0) {
		// Skip first newline as we are in start-of-line context
		minNls--;
	}

	if (minNls > 0 && sepNlCount < minNls) {
		// Append newlines
		var nlBuf = [];
		for (var i = 0; i < (minNls - sepNlCount); i++) {
			nlBuf.push('\n');
		}

		/* ------------------------------------------------------------------
		 * The following two heuristics try to do a best-guess on where to
		 * add the newlines relative to nodeA and nodeB that best matches
		 * wikitext output expectations.
		 *
		 * 1. In a parent-child separator scenario, where the first child of
		 *    nodeA is not an element, it could have contributed to the separator.
		 *    In that case, the newlines should be prepended because they
		 *    usually correspond to the parent's constraints,
		 *    and the separator was plucked from the child.
		 *
		 *    Try html2wt on this snippet:
		 *
		 *    a<p><!--cmt-->b</p>
		 *
		 * 2. In a sibling scenario, if nodeB is a literal-HTML element, nodeA is
		 *    forcing the newline and hence the newline should be emitted right
		 *    after it.
		 *
		 *    Try html2wt on this snippet:
		 *
		 *    <p>foo</p>  <p data-parsoid='{"stx":"html"}'>bar</p>
		 * -------------------------------------------------------------------- */
		var constraintInfo = nlConstraints.constraintInfo || {};
		var sepType = constraintInfo.sepType;
		var nodeA = constraintInfo.nodeA;
		var nodeB = constraintInfo.nodeB;
		if (
			sepType === 'parent-child' &&
			!DOMUtils.isContentNode(DOMUtils.firstNonDeletedChild(nodeA)) &&
			!(
				Consts.HTML.ChildTableTags.has(nodeB.nodeName) &&
				!WTUtils.isLiteralHTMLNode(nodeB)
			)
		) {
			sep = nlBuf.join('') + sep;
		} else if (sepType === 'sibling' && WTUtils.isLiteralHTMLNode(nodeB)) {
			sep = nlBuf.join('') + sep;
		} else {
			sep += nlBuf.join('');
		}
	} else if (nlConstraints.max !== undefined && sepNlCount > nlConstraints.max) {
		// Strip some newlines outside of comments
		// Capture separators in a single array with a capturing version of
		// the split regexp, so that we can work on the non-separator bits
		// when stripping newlines.
		var allBits = sep.split(new RegExp('(' + splitReString + ')'));
		var newBits = [];
		var n = sepNlCount;

		while (n > nlConstraints.max) {
			var bit = allBits.pop();
			while (bit && bit.match(splitRe)) {
				// skip comments
				newBits.push(bit);
				bit = allBits.pop();
			}
			while (n > nlConstraints.max && bit.match(/\n/)) {
				bit = bit.replace(/\n([^\n]*)/, '$1');
				n--;
			}
			newBits.push(bit);
		}
		newBits.reverse();
		newBits = allBits.concat(newBits);
		sep = newBits.join('');
	}

	state.env.log("debug/wts/sep", 'make-new   |', function() {
		var constraints = Util.clone(nlConstraints);
		constraints.constraintInfo = undefined;
		return JSON.stringify(sep) + ", " +
			JSON.stringify(origSep) + ", " +
			minNls + ", " + sepNlCount + ", " + JSON.stringify(constraints);
	});

	return sep;
}

/**
 * Merge two constraints.
 *
 * @private
 */
function mergeConstraints(env, oldConstraints, newConstraints) {
	const res = {
		min: Math.max(oldConstraints.min || 0, newConstraints.min || 0),
		max: Math.min(
			oldConstraints.max !== undefined ? oldConstraints.max : 2,
			newConstraints.max !== undefined ? newConstraints.max : 2
		),
		force: oldConstraints.force || newConstraints.force,
	};

	if (res.min > res.max) {
		// If oldConstraints.force is set, older constraints win
		if (!oldConstraints.force) {
			// let newConstraints win, but complain
			if (newConstraints.max !== undefined && newConstraints.max > res.min) {
				res.max = newConstraints.max;
			} else if (newConstraints.min && newConstraints.min < res.min) {
				res.min = newConstraints.min;
			}
		}
		res.max = res.min;
		env.log("info/html2wt", 'Incompatible constraints (merge):', res,
			loggableConstraints(oldConstraints), loggableConstraints(newConstraints));
	}

	return res;
}

const debugOut = function(node) {
	return JSON.stringify(node.outerHTML || node.nodeValue || '').substr(0, 40);
};

/**
 * Figure out separator constraints and merge them with existing constraints
 * in state so that they can be emitted when the next content emits source.
 * @param {Object} state
 * @param {Node} nodeA
 * @param {DOMHandler} sepHandlerA
 * @param {Node} nodeB
 * @param {DOMHandler} sepHandlerB
 */
var updateSeparatorConstraints = function(state, nodeA, sepHandlerA, nodeB, sepHandlerB) {
	let sepType, nlConstraints, aCons, bCons;

	if (nodeB.parentNode === nodeA) {
		// parent-child separator, nodeA parent of nodeB
		sepType = "parent-child";
		aCons = sepHandlerA.firstChild(nodeA, nodeB, state);
		bCons = sepHandlerB.before(nodeB, nodeA, state);
		nlConstraints = getSepNlConstraints(state, nodeA, aCons, nodeB, bCons);
	} else if (nodeA.parentNode === nodeB) {
		// parent-child separator, nodeB parent of nodeA
		sepType = "child-parent";
		aCons = sepHandlerA.after(nodeA, nodeB, state);
		bCons = sepHandlerB.lastChild(nodeB, nodeA, state);
		nlConstraints = getSepNlConstraints(state, nodeA, aCons, nodeB, bCons);
	} else {
		// sibling separator
		sepType = "sibling";
		aCons = sepHandlerA.after(nodeA, nodeB, state);
		bCons = sepHandlerB.before(nodeB, nodeA, state);
		nlConstraints = getSepNlConstraints(state, nodeA, aCons, nodeB, bCons);
	}

	if (nodeA.nodeName === undefined) {
		console.trace();
	}

	if (state.sep.constraints) {
		// Merge the constraints
		state.sep.constraints = mergeConstraints(
			state.env,
			state.sep.constraints,
			nlConstraints
		);
	} else {
		state.sep.constraints = nlConstraints;
	}

	state.env.log('debug/wts/sep', function() {
		return 'constraint' +
			' | ' + sepType +
			' | <' + nodeA.nodeName + ',' + nodeB.nodeName + '>' +
			' | ' + JSON.stringify(state.sep.constraints) +
			' | ' + debugOut(nodeA) +
			' | ' + debugOut(nodeB);
	});

	state.sep.constraints.constraintInfo = {
		onSOL: state.onSOL,
		// force SOL state when separator is built/emitted
		forceSOL: sepHandlerB.forceSOL,
		sepType: sepType,
		nodeA: nodeA,
		nodeB: nodeB,
	};
};

// spaces + (comments and anything but newline)?
var WS_COMMENTS_SEP_TEST_REGEXP = JSUtils.rejoin(
		/( +)/,
		'(', Util.COMMENT_REGEXP, /[^\n]*/, ')?$'
);

var WS_COMMENTS_SEP_REPLACE_REGEXP = new RegExp(WS_COMMENTS_SEP_TEST_REGEXP.source, 'g');

// multiple newlines followed by spaces + (comments and anything but newline)?
var NL_WS_COMMENTS_SEP_REGEXP = JSUtils.rejoin(
		/\n+/,
		WS_COMMENTS_SEP_TEST_REGEXP
);

function makeSepIndentPreSafe(state, sep, nlConstraints) {
	var constraintInfo = nlConstraints.constraintInfo || {};
	var sepType = constraintInfo.sepType;
	var nodeA = constraintInfo.nodeA;
	var nodeB = constraintInfo.nodeB;
	var forceSOL = constraintInfo.forceSOL && sepType !== 'child-parent';
	var origNodeB = nodeB;

	// Ex: "<div>foo</div>\n <span>bar</span>"
	//
	// We also should test for onSOL state to deal with HTML like
	// <ul> <li>foo</li></ul>
	// and strip the leading space before non-indent-pre-safe tags
	if (!state.inPHPBlock && !state.inIndentPre &&
		(NL_WS_COMMENTS_SEP_REGEXP.test(sep)
		|| WS_COMMENTS_SEP_TEST_REGEXP.test(sep) && (constraintInfo.onSOL || forceSOL))
	) {
		// 'sep' is the separator before 'nodeB' and it has leading spaces on a newline.
		// We have to decide whether that leading space will trigger indent-pres in wikitext.
		// The decision depends on where this separator will be emitted relative
		// to 'nodeA' and 'nodeB'.

		var isIndentPreSafe = false;

		// Example sepType scenarios:
		//
		// 1. sibling
		//    <div>foo</div>
		//     <span>bar</span>
		//    The span will be wrapped in an indent-pre if the leading space
		//    is not stripped since span is not a block tag
		//
		// 2. child-parent
		//    <span>foo
		//     </span>bar
		//    The " </span>bar" will be wrapped in an indent-pre if the
		//    leading space is not stripped since span is not a block tag
		//
		// 3. parent-child
		//    <div>foo
		//     <span>bar</span>
		//    </div>
		//
		// In all cases, only block-tags prevent indent-pres.
		// (except for a special case for <br> nodes)
		if (nodeB && WTSUtils.precedingSpaceSuppressesIndentPre(nodeB, origNodeB)) {
			isIndentPreSafe = true;
		} else if (sepType === 'sibling' || nodeA && DOMUtils.atTheTop(nodeA)) {
			console.assert(!DOMUtils.atTheTop(nodeA) || sepType === 'parent-child');

			// 'nodeB' is the first non-separator child of 'nodeA'.
			//
			// Walk past sol-transparent nodes in the right-sibling chain
			// of 'nodeB' till we establish indent-pre safety.
			while (nodeB && (DOMUtils.isDiffMarker(nodeB) ||
					WTUtils.emitsSolTransparentSingleLineWT(nodeB))) {
				nodeB = nodeB.nextSibling;
			}

			isIndentPreSafe = !nodeB || WTSUtils.precedingSpaceSuppressesIndentPre(nodeB, origNodeB);
		}

		// Check whether nodeB is nested inside an element that suppresses
		// indent-pres.
		//
		// 1. Walk up past zero-wikitext width nodes in the ancestor chain
		//    of 'nodeB' till we establish indent-pre safety.
		//    If nodeB uses HTML syntax, obviously it is not zero width!
		//
		// 2. Check if the ancestor is a weak/strong indent-pre suppressing tag.
		//    - Weak indent-pre suppressing tags only suppress indent-pres
		//      within immediate children.
		//    - Strong indent-pre suppressing tags suppress indent-pres
		//      in entire DOM subtree rooted at that node.

		if (nodeB && !DOMUtils.atTheTop(nodeB)) {
			var parentB = nodeB.parentNode; // could be nodeA
			while (WTUtils.isZeroWidthWikitextElt(parentB)) {
				parentB = parentB.parentNode;
			}

			if (Consts.WeakIndentPreSuppressingTags.has(parentB.nodeName)) {
				isIndentPreSafe = true;
			} else {
				while (!DOMUtils.atTheTop(parentB)) {
					if (Consts.StrongIndentPreSuppressingTags.has(parentB.nodeName) &&
							(parentB.nodeName !== 'P' || WTUtils.isLiteralHTMLNode(parentB))) {
						isIndentPreSafe = true;
					}
					parentB = parentB.parentNode;
				}
			}
		}

		var stripLeadingSpace = (constraintInfo.onSOL || forceSOL) && nodeB && Consts.SolSpaceSensitiveTags.has(nodeB.nodeName);
		if (!isIndentPreSafe || stripLeadingSpace) {
			// Wrap non-nl ws from last line, but preserve comments.
			// This avoids triggering indent-pres.
			sep = sep.replace(WS_COMMENTS_SEP_REPLACE_REGEXP, function() {
				var rest = arguments[2] || '';
				if (stripLeadingSpace) {
					// No other option but to strip the leading space
					return rest;
				} else {
					// Since we nowiki-ed, we are no longer in sol state
					state.onSOL = false;
					state.hasIndentPreNowikis = true;
					return '<nowiki>' + arguments[1] + '</nowiki>' + rest;
				}
			});
		}
	}

	state.env.log("debug/wts/sep", 'ipre-safe  |', function() {
		var constraints = Util.clone(nlConstraints);
		constraints.constraintInfo = undefined;
		return JSON.stringify(sep) + ", " + JSON.stringify(constraints);
	});

	return sep;
}

// Serializing auto inserted content should invalidate the original separator
var handleAutoInserted = function(node) {
	var dp = DOMDataUtils.getDataParsoid(node);
	var dsr = Util.clone(dp.dsr);
	if (dp.autoInsertedStart) { dsr[2] = null; }
	if (dp.autoInsertedEnd) { dsr[3] = null; }
	return dsr;
};

/**
 * Emit a separator based on the collected (and merged) constraints
 * and existing separator text. Called when new output is triggered.
 * @param {Object} state
 * @param {Node} node
 * @return {string}
 */
var buildSep = function(state, node) {
	var env = state.env;
	var origNode = node;
	var prevNode = state.sep.lastSourceNode;
	var sep, dsrA, dsrB;

	/* ----------------------------------------------------------------------
	 * Assuming we have access to the original source, we can use it only if:
	 * - If we are in selser mode AND
	 *   . this node is not part of a subtree that has been marked 'modified'
	 *     (massively edited, either in actuality or because DOMDiff is not smart enough).
	 *   . neither node is adjacent to a deleted block node
	 *     (see the extensive comment in SSP.emitChunk in wts.SerializerState.js)
	 *
	 * In other scenarios, DSR values on "adjacent" nodes in the edited DOM
	 * may not reflect deleted content between them.
	 * ---------------------------------------------------------------------- */
	var again = (node === prevNode);
	var origSepUsable = !again &&
			state.selserMode && !state.inModifiedContent &&
			!WTSUtils.nextToDeletedBlockNodeInWT(prevNode, true) &&
			!WTSUtils.nextToDeletedBlockNodeInWT(node, false) &&
			WTSUtils.origSrcValidInEditedContext(state.env, prevNode) &&
			WTSUtils.origSrcValidInEditedContext(state.env, node);

	if (origSepUsable) {
		if (!DOMUtils.isElt(prevNode)) {
			// Check if this is the last child of a zero-width element, and use
			// that for dsr purposes instead. Typical case: text in p.
			if (!prevNode.nextSibling &&
				prevNode.parentNode &&
				prevNode.parentNode !== node &&
				DOMDataUtils.getDataParsoid(prevNode.parentNode).dsr &&
				DOMDataUtils.getDataParsoid(prevNode.parentNode).dsr[3] === 0) {
				dsrA = handleAutoInserted(prevNode.parentNode);
			} else if (prevNode.previousSibling &&
					prevNode.previousSibling.nodeType === prevNode.ELEMENT_NODE &&
					// FIXME: Not sure why we need this check because data-parsoid
					// is loaded on all nodes. mw:Diffmarker maybe? But, if so, why?
					// Should be fixed.
					DOMDataUtils.getDataParsoid(prevNode.previousSibling).dsr &&
					// Don't extrapolate if the string was potentially changed
					!DiffUtils.directChildrenChanged(node.parentNode, env)
			) {
				var endDsr = DOMDataUtils.getDataParsoid(prevNode.previousSibling).dsr[1];
				var correction;
				if (typeof (endDsr) === 'number') {
					if (DOMUtils.isComment(prevNode)) {
						correction = WTUtils.decodedCommentLength(prevNode);
					} else {
						correction = prevNode.nodeValue.length;
					}
					dsrA = [endDsr, endDsr + correction + WTUtils.indentPreDSRCorrection(prevNode), 0, 0];
				}
			}
		} else {
			dsrA = handleAutoInserted(prevNode);
		}

		if (!dsrA) {
			// nothing to do -- no reason to compute dsrB if dsrA is null
		} else if (!DOMUtils.isElt(node)) {
			// If this is the child of a zero-width element
			// and is only preceded by separator elements, we
			// can use the parent for dsr after correcting the dsr
			// with the separator run length.
			//
			// 1. text in p.
			// 2. ws-only child of a node with auto-inserted start tag
			//    Ex: "<span> <s>x</span> </s>" --> <span> <s>x</s*></span><s*> </s>
			// 3. ws-only children of a node with auto-inserted start tag
			//    Ex: "{|\n|-\n <!--foo--> \n|}"

			var npDP = DOMDataUtils.getDataParsoid(node.parentNode);
			if (node.parentNode !== prevNode && npDP.dsr && npDP.dsr[2] === 0) {
				var sepTxt = precedingSeparatorTxt(node);
				if (sepTxt !== null) {
					dsrB = npDP.dsr;
					if (typeof (dsrB[0]) === 'number' && sepTxt.length > 0) {
						dsrB = Util.clone(dsrB);
						dsrB[0] += sepTxt.length;
					}
				}
			}
		} else {
			if (prevNode.parentNode === node) {
				// FIXME: Maybe we shouldn't set dsr in the dsr pass if both aren't valid?
				//
				// When we are in the lastChild sep scenario and the parent doesn't have
				// useable dsr, if possible, walk up the ancestor nodes till we find
				// a dsr-bearing node
				//
				// This fix is needed to handle trailing newlines in this wikitext:
				// [[File:foo.jpg|thumb|300px|foo\n{{echo|A}}\n{{echo|B}}\n{{echo|C}}\n\n]]
				while (!node.nextSibling && !DOMUtils.atTheTop(node) &&
					(!DOMDataUtils.getDataParsoid(node).dsr ||
					DOMDataUtils.getDataParsoid(node).dsr[0] === null ||
					DOMDataUtils.getDataParsoid(node).dsr[1] === null)) {
					node = node.parentNode;
				}
			}

			// The top node could be a document fragment, which is not
			// an element, and so getDataParsoid will return `null`.
			dsrB = DOMUtils.isElt(node) ? handleAutoInserted(node) : null;
		}

		// FIXME: Maybe we shouldn't set dsr in the dsr pass if both aren't valid?
		if (Util.isValidDSR(dsrA) && Util.isValidDSR(dsrB)) {
			// Figure out containment relationship
			if (dsrA[0] <= dsrB[0]) {
				if (dsrB[1] <= dsrA[1]) {
					if (dsrA[0] === dsrB[0] && dsrA[1] === dsrB[1]) {
						// Both have the same dsr range, so there can't be any
						// separators between them
						sep = '';
					} else if (dsrA[2] !== null) {
						// B in A, from parent to child
						sep = state.getOrigSrc(dsrA[0] + dsrA[2], dsrB[0]);
					}
				} else if (dsrA[1] <= dsrB[0]) {
					// B following A (siblingish)
					sep = state.getOrigSrc(dsrA[1], dsrB[0]);
				} else if (dsrB[3] !== null) {
					// A in B, from child to parent
					sep = state.getOrigSrc(dsrA[1], dsrB[1] - dsrB[3]);
				}
			} else if (dsrA[1] <= dsrB[1]) {
				if (dsrB[3] !== null) {
					// A in B, from child to parent
					sep = state.getOrigSrc(dsrA[1], dsrB[1] - dsrB[3]);
				}
			} else {
				env.log("info/html2wt", "dsr backwards: should not happen!");
			}
		}
	}

	env.log('debug/wts/sep', function() {
		return 'maybe-sep  | ' +
			'prev:' + (prevNode ? prevNode.nodeName : '--none--') +
			', node:' + (origNode ? origNode.nodeName : '--none--') +
			', sep: ' + JSON.stringify(sep) + ', state.sep.src: ' + JSON.stringify(state.sep.src);
	});

	// 1. Verify that the separator is really one (has to be whitespace and comments)
	// 2. If the separator is being emitted before a node that emits sol-transparent WT,
	//    go through makeSeparator to verify indent-pre constraints are met.
	var sepConstraints = state.sep.constraints || { max: 0 };
	if (sep === undefined ||
		!WTSUtils.isValidSep(sep) ||
		(state.sep.src && state.sep.src !== sep)) {
		if (state.sep.constraints || state.sep.src) {
			// TODO: set modified flag if start or end node (but not both) are
			// modified / new so that the selser can use the separator
			sep = makeSeparator(state, state.sep.src || '', sepConstraints);
		} else {
			sep = undefined;
		}
	}

	if (sep !== undefined) {
		sep = makeSepIndentPreSafe(state, sep, sepConstraints);
	}
	return sep;
};

if (typeof module === "object") {
	module.exports.updateSeparatorConstraints = updateSeparatorConstraints;
	module.exports.buildSep = buildSep;
}
