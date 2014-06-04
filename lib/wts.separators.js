"use strict";

require('./core-upgrade.js');
var wtConsts = require('./mediawiki.wikitext.constants.js'),
	Consts = wtConsts.WikitextConstants,
	Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	WTSUtils = require('./wts.utils.js').WTSUtils,
	pd = require('./mediawiki.parser.defines.js');

/**
 * Clean up the constraints object to prevent excessively verbose output
 * and clog up log files / test runs
 */
function loggableConstraints(constraints) {
	var c = {
		a: constraints.a,
		b: constraints.b,
		min: constraints.min,
		max: constraints.max
	};

	if (constraints.constraintInfo) {
		c.constraintInfo = {
			onSOL: constraints.constraintInfo.onSOL,
			sepType: constraints.constraintInfo.sepType,
			nodeA: constraints.constraintInfo.nodeA.nodeName,
			nodeB: constraints.constraintInfo.nodeB.nodeName
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

	var buf = '', orig = n;
	while (n) {
		if (DU.isIEW(n)) {
			buf += n.nodeValue;
		} else if (DU.isComment(n)) {
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
 * Helper for updateSeparatorConstraints
 *
 * Collects, checks and integrates separator newline requirements to a sinple
 * min, max structure.
 */
function getSepNlConstraints(state, nodeA, sepNlsHandlerA, nodeB, sepNlsHandlerB) {
	var nlConstraints = { a:{}, b:{} };

	// Leave constraints unchanged when:
	// * both nodes are element nodes
	// * both nodes were present in original wikitext
	// * either one of them is sol-transparent
	if (DU.isElt(nodeA) && DU.isElt(nodeB)
		&& !DU.isNewElt(nodeA) && !DU.isNewElt(nodeB)
		&& (DU.emitsSolTransparentSingleLineWT(nodeA)
			|| DU.emitsSolTransparentSingleLineWT(nodeB)))
	{
		return nlConstraints;
	}

	if (sepNlsHandlerA) {
		nlConstraints.a = sepNlsHandlerA(nodeA, nodeB, state);
		nlConstraints.min = nlConstraints.a.min;
		nlConstraints.max = nlConstraints.a.max;
	}

	if (sepNlsHandlerB) {
		nlConstraints.b = sepNlsHandlerB(nodeB, nodeA, state);
		var cb = nlConstraints.b;

		// now figure out if this conflicts with the nlConstraints so far
		if (cb.min !== undefined) {
			if (nlConstraints.max !== undefined && nlConstraints.max < cb.min) {
				// Conflict, warn and let nodeB win.
				state.env.log("warning", "Incompatible constraints 1:", nodeA.nodeName,
						nodeB.nodeName, loggableConstraints(nlConstraints));
				nlConstraints.min = cb.min;
				nlConstraints.max = cb.min;
			} else {
				nlConstraints.min = Math.max(nlConstraints.min || 0, cb.min);
			}
		}

		if (cb.max !== undefined) {
			if (nlConstraints.min !== undefined && nlConstraints.min > cb.max) {
				// Conflict, warn and let nodeB win.
				state.env.log("warning", "Incompatible constraints 2:", nodeA.nodeName,
						nodeB.nodeName, loggableConstraints(nlConstraints));
				nlConstraints.min = cb.max;
				nlConstraints.max = cb.max;
			} else if (nlConstraints.max !== undefined) {
				nlConstraints.max = Math.min(nlConstraints.max, cb.max);
			} else {
				nlConstraints.max = cb.max;
			}
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
 * Starting on a text or comment node, collect ws text / comments between
 * elements.
 *
 * Assumptions:
 * - Called on first text / comment node
 *
 * Returns true if the node is a separator
 *
 * XXX: Support separator-transparent elements!
 */
var handleSeparatorText = function ( node, state ) {
	if (!state.inIndentPre && DU.isText(node)) {
		if (node.nodeValue.match(/^\s*$/)) {
			state.sep.src = (state.sep.src || '') + node.nodeValue;

			// Same caveat as in WSP._serializeTextNode applies here as well
			// Since all whitespace is buffered as separator text,
			// WTS is still in SOL state here.
			if (state.sep.src.match(/\n/)) {
				state.onSOL = true;
			}

			//if (!state.sep.lastSourceNode) {
			//	// FIXME: Actually set lastSourceNode when the source is
			//	// emitted / emitSeparator is called!
			//	state.sep.lastSourceNode = node.previousSibling || node.parentNode;
			//}
			return true;
		} else {
			if (node.nodeValue.match(/^[ \t]*\n+/)) {
				state.sep.src = (state.sep.src || '') + node.nodeValue.match(/^[ \t]*\n+/)[0];
				//if (!state.sep.lastSourceNode) {
				//	// FIXME: Actually set lastSourceNode when the source is
				//	// emitted / emitSeparator is called!
				//	state.sep.lastSourceNode = node.previousSibling || node.parentNode;
				//}
			}
			return false;
		}
	} else if (DU.isComment(node)) {
		state.sep.src = (state.sep.src || '') + WTSUtils.commentWT(node.nodeValue);
		return true;
	} else {
		return false;
	}
};

/**
 * Create a separator given a (potentially empty) separator text and newline
 * constraints
 */
function makeSeparator(state, sep, nlConstraints) {
	var origSep = sep;

	// TODO: Move to Util?
	var commentRe = '<!--(?:[^-]|-(?!->))*-->',
		// Split on comment/ws-only lines, consuming subsequent newlines since
		// those lines are ignored by the PHP parser
		// Ignore lines with ws and a single comment in them
		splitReString = '(?:\n(?:[ \t]*?' + commentRe + '[ \t]*?)+(?=\n))+|' + commentRe,
		splitRe = new RegExp(splitReString),
		sepMatch = sep.split(splitRe).join('').match(/\n/g),
		sepNlCount = sepMatch && sepMatch.length || 0,
		minNls = nlConstraints.min || 0;

	if (state.atStartOfOutput && ! nlConstraints.a.min && minNls > 0) {
		// Skip first newline as we are in start-of-line context
		minNls--;
	}

	if (minNls > 0 && sepNlCount < minNls) {
		// Append newlines
		var nlBuf = [];
		for (var i = 0; i < (minNls - sepNlCount); i++) {
			nlBuf.push('\n');
		}

		// In a parent-child separator scenario where the the first
		// content node is not an element, that element could have contributed
		// to the separator. In that case, the newlines should be prepended
		// because they usually correspond to the parent's constraints,
		// and the separator was plucked from the child.
		//
		// FIXME: In reality, this is more complicated since the separator
		// might have been combined from the parent's previous sibling and
		// from parent's first content node, and the newlines should be spliced
		// in between. But, we dont really track that scenario carefully
		// enough to implement that. So, this is just the next best scenario.
		//
		// The most common case seem to be situations like this:
		//
		// echo "a<p><!--c-->b</p>" | node parse --html2wt
		var constraintInfo = nlConstraints.constraintInfo || {},
			sepType = constraintInfo.sepType,
			nodeA = constraintInfo.nodeA;
		if (sepType === 'parent-child' && !DU.isElt(DU.firstNonSepChildNode(nodeA))) {
			sep = nlBuf.join('') + sep;
		} else {
			sep = sep + nlBuf.join('');
		}
	} else if (nlConstraints.max !== undefined && sepNlCount > nlConstraints.max) {
		// Strip some newlines outside of comments
		// Capture separators in a single array with a capturing version of
		// the split regexp, so that we can work on the non-separator bits
		// when stripping newlines.
		var allBits = sep.split(new RegExp('(' + splitReString + ')')),
			newBits = [],
			n = sepNlCount;

		while (n > nlConstraints.max) {
			var bit = allBits.pop();
			while (bit && bit.match(splitRe)) {
				// skip comments
				newBits.push(bit);
				bit = allBits.pop();
			}
			while(n > nlConstraints.max && bit.match(/\n/)) {
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
 * Merge two constraints, with the newer constraint winning in case of
 * conflicts.
 *
 * XXX: Use nesting information for conflict resolution / switch to scoped
 * constraints?
 */
function mergeConstraints(env, oldConstraints, newConstraints) {
	//console.log(oldConstraints);
	var res = {a: oldConstraints.a, b:newConstraints.b};
	res.min = Math.max(oldConstraints.min || 0, newConstraints.min || 0);
	res.max = Math.min(oldConstraints.max !== undefined ? oldConstraints.max : 2,
			newConstraints.max !== undefined ? newConstraints.max : 2);
	if (res.min > res.max) {
		// let newConstraints win, but complain
		if (newConstraints.max !== undefined && newConstraints.max > res.min) {
			res.max = newConstraints.max;
		} else if (newConstraints.min && newConstraints.min < res.min) {
			res.min = newConstraints.min;
		}

		res.max = res.min;
		env.log("warning", 'Incompatible constraints (merge):', res,
			loggableConstraints(oldConstraints), loggableConstraints(newConstraints));
	}
	return res;
}

/**
 * Figure out separator constraints and merge them with existing constraints
 * in state so that they can be emitted when the next content emits source.
 *
 * node handlers:
 *
 * body: {
 *	handle: function(node, state, cb) {},
 *		// responsible for calling
 *	sepnls: {
 *		before: function(node) -> {min: 1, max: 2}
 *		after: function(node)
 *		firstChild: function(node)
 *		lastChild: function(node)
 *	}
 * }
 */
var updateSeparatorConstraints = function( state, nodeA, handlerA, nodeB, handlerB) {
	var nlConstraints,
		sepHandlerA = handlerA && handlerA.sepnls || {},
		sepHandlerB = handlerB && handlerB.sepnls || {},
		sepType = null;
	if ( nodeA.nextSibling === nodeB ) {
		// sibling separator
		sepType = "sibling";
		nlConstraints = getSepNlConstraints(state, nodeA, sepHandlerA.after,
											nodeB, sepHandlerB.before);
	} else if ( nodeB.parentNode === nodeA ) {
		sepType = "parent-child";
		// parent-child separator, nodeA parent of nodeB
		nlConstraints = getSepNlConstraints(state, nodeA, sepHandlerA.firstChild,
											nodeB, sepHandlerB.before);
	} else if ( nodeA.parentNode === nodeB ) {
		sepType = "child-parent";
		// parent-child separator, nodeB parent of nodeA
		nlConstraints = getSepNlConstraints(state, nodeA, sepHandlerA.after,
											nodeB, sepHandlerB.lastChild);
	} else {
		// sibling separator
		sepType = "sibling";
		nlConstraints = getSepNlConstraints(state, nodeA, sepHandlerA.after,
											nodeB, sepHandlerB.before);
	}

	if (nodeA.nodeName === undefined) {
		console.trace();
	}

	this.env.log('debug/wts/sep', function() {
		return 'constraint | ' + sepType + " | <" + nodeA.nodeName + "," + nodeB.nodeName + "> | " +
			JSON.stringify(nlConstraints) +
			" | " + JSON.stringify((nodeA.outerHTML || nodeA.nodeValue || '').substr(0,40)) +
			" | " + JSON.stringify((nodeB.outerHTML || nodeB.nodeValue || '').substr(0,40));
	});

	if(state.sep.constraints) {
		// Merge the constraints
		state.sep.constraints = mergeConstraints(this.env, state.sep.constraints, nlConstraints);
		//if (state.sep.lastSourceNode && DU.isText(state.sep.lastSourceNode) {
		//	state.sep.lastSourceNode = nodeA;
		//}
	} else {
		state.sep.constraints = nlConstraints;
		//state.sep.lastSourceNode = state.sep.lastSourceNode || nodeA;
	}

	state.sep.constraints.constraintInfo = {
		onSOL: state.onSOL,
		sepType: sepType,
		nodeA: nodeA,
		nodeB: nodeB
	};

	//console.log('nlConstraints', state.sep.constraints);
};

function makeSepIndentPreSafe(state, sep, nlConstraints) {
	var constraintInfo = nlConstraints.constraintInfo || {},
		sepType = constraintInfo.sepType,
		nodeA = constraintInfo.nodeA,
		nodeB = constraintInfo.nodeB;

	// Ex: "<div>foo</div>\n <span>bar</span>"
	//
	// We also should test for onSOL state to deal with HTML like
	// <ul> <li>foo</li></ul>
	// and strip the leading space before non-indent-pre-safe tags
	if (!state.inIndentPre &&
		(sep.match(/\n+ +(<!--(?:[^\-]|-(?!->))*-->[^\n]*)?$/g) || (
		(constraintInfo.onSOL && sep.match(/ +(<!--(?:[^\-]|-(?!->))*-->[^\n]*)?$/g)))))
	{
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
		if (sepType && DU.precedingSpaceSuppressesIndentPre(nodeB)) {
			isIndentPreSafe = true;
		} else if (sepType === 'sibling' || nodeA && nodeA.nodeName === 'BODY') {
			console.assert(nodeA.nodeName !== 'BODY' || sepType === 'parent-child');

			// 'nodeB' is the first non-separator child of 'nodeA'.
			//
			// Walk past sol-transparent nodes in the right-sibling chain
			// of 'nodeB' till we establish indent-pre safety.
			while (nodeB && DU.emitsSolTransparentSingleLineWT(nodeB)) {
				nodeB = nodeB.nextSibling;
			}

			isIndentPreSafe = !nodeB ||
				DU.precedingSpaceSuppressesIndentPre(nodeB) ||
				// If the text node itself has a leading space that
				// could trigger indent-pre, no need to worry about
				// leading space in the separator.
				(DU.isText(nodeB) && nodeB.nodeValue.match(/^[ \t]/));
		} else if (sepType === 'parent-child') {
			// 'nodeB' is the first non-separator child of 'nodeA'.
			//
			// Walk up past zero-wikitext width nodes in the ancestor chain
			// of 'nodeA' till we establish indent-pre safety.
			while (Consts.ZeroWidthWikitextTags.has(nodeA.nodeName)) {
				nodeA = nodeA.parentNode;
			}

			// Deal with weak/strong indent-pre suppressing tags
			if (Consts.WeakIndentPreSuppressingTags.has(nodeA.nodeName)) {
				isIndentPreSafe = true;
			} else {
				// Strong indent-pre suppressing tags suppress indent-pres
				// in entire DOM subtree rooted at that node
				while (nodeA.nodeName !== 'BODY') {
					if (Consts.StrongIndentPreSuppressingTags.has(nodeA.nodeName) &&
						(!Consts.SolSpaceSensitiveTags.has(nodeA.nodeName) ||
						DU.isLiteralHTMLNode(nodeA)))
					{
						isIndentPreSafe = true;
					}
					nodeA = nodeA.parentNode;
				}
			}
		}

		if (!isIndentPreSafe) {
			// Wrap non-nl ws from last line, but preserve comments.
			// This avoids triggering indent-pres.
			sep = sep.replace(/( +)(<!--(?:[^\-]|-(?!->))*-->[^\n]*)?$/g, function() {
				var rest = arguments[2] || '';
				if (constraintInfo.onSOL && Consts.SolSpaceSensitiveTags.has(nodeB.nodeName)) {
					// No other option but to strip the leading space
					return rest;
				} else {
					// Since we nowiki-ed, we are no longer in sol state
					state.onSOL = false;
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

/**
 * Emit a separator based on the collected (and merged) constraints
 * and existing separator text. Called when new output is triggered.
 */
var emitSeparator = function(state, cb, node) {

	var sep,
		origNode = node,
		src = state.env.page.src,
		prevNode = state.sep.lastSourceNode,
		dsrA, dsrB;

	// We can use original source only if:
	// * We have access to original wikitext
	// * If we are in rt-testing mode (NO edits in that scenario)
	// * If we are in selser mode AND this node is not part of a subtree
	//   that has been marked 'modified' (massively edited, either in actuality
	//   or because DOMDiff is not smart enough).
	//
	// In other scenarios, DSR values on "adjacent" nodes in the edited DOM
	// may not reflect deleted content between them.
	var origSepUsable = src && (state.rtTesting || state.selserMode) && !state.inModifiedContent;
	if (origSepUsable && node && prevNode && node !== prevNode) {
		if (!DU.isElt(prevNode)) {
			// Check if this is the last child of a zero-width element, and use
			// that for dsr purposes instead. Typical case: text in p.
			if (!prevNode.nextSibling &&
				prevNode.parentNode &&
				prevNode.parentNode !== node &&
				DU.getDataParsoid( prevNode.parentNode ).dsr &&
				DU.getDataParsoid( prevNode.parentNode ).dsr[3] === 0)
			{
				dsrA = DU.getDataParsoid( prevNode.parentNode ).dsr;
			} else if (prevNode.previousSibling &&
					prevNode.previousSibling.nodeType === prevNode.ELEMENT_NODE &&
					// FIXME: Not sure why we need this check because data-parsoid
					// is loaded on all nodes. mw:Diffmarker maybe? But, if so, why?
					// Should be fixed.
					DU.getDataParsoid( prevNode.previousSibling ).dsr &&
					// Don't extrapolate if the string was potentially changed
					// or we didn't diff (selser disabled)
					(state.rtTesting || // no changes in rt testing
					 // diffed and no change here
					 (state.selserMode && !DU.directChildrenChanged(node.parentNode, this.env)))
				 )
			{
				var endDsr = DU.getDataParsoid( prevNode.previousSibling ).dsr[1],
					correction;
				if (typeof(endDsr) === 'number') {
					if (DU.isComment(prevNode)) {
						correction = prevNode.nodeValue.length + 7;
					} else {
						correction = prevNode.nodeValue.length;
					}
					dsrA = [endDsr, endDsr + correction + DU.indentPreDSRCorrection(prevNode), 0, 0];
				}
			} else {
				/* jshint noempty: false */
				//console.log( prevNode.nodeValue, prevNode.parentNode.outerHTML);
			}
		} else {
			dsrA = DU.getDataParsoid( prevNode ).dsr;
		}

		if (!dsrA) {
			/* jshint noempty: false */
			// nothing to do -- no reason to compute dsrB if dsrA is null
		} else if (!DU.isElt(node)) {
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

			var npDP = DU.getDataParsoid( node.parentNode );
			if ( node.parentNode !== prevNode && npDP.dsr && npDP.dsr[2] === 0 ) {
				var sepTxt = precedingSeparatorTxt(node);
				if (sepTxt !== null) {
					dsrB = npDP.dsr;
					if (typeof(dsrB[0]) === 'number' && sepTxt.length > 0) {
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
				while (!node.nextSibling && node.nodeName !== 'BODY' &&
					(!DU.getDataParsoid( node ).dsr ||
					DU.getDataParsoid( node ).dsr[0] === null ||
					DU.getDataParsoid( node ).dsr[1] === null))
				{
					node = node.parentNode;
				}
			}

			dsrB = DU.getDataParsoid( node ).dsr;
		}

		// FIXME: Maybe we shouldn't set dsr in the dsr pass if both aren't valid?
		if (WTSUtils.isValidDSR(dsrA) && WTSUtils.isValidDSR(dsrB)) {
			//console.log(prevNode.data.parsoid.dsr, node.data.parsoid.dsr);
			// Figure out containment relationship
			if (dsrA[0] <= dsrB[0]) {
				if (dsrB[1] <= dsrA[1]) {
					if (dsrA[0] === dsrB[0] && dsrA[1] === dsrB[1]) {
						// Both have the same dsr range, so there can't be any
						// separators between them
						sep = '';
					} else if (dsrA[2] !== null) {
						// B in A, from parent to child
						sep = src.substring(dsrA[0] + dsrA[2], dsrB[0]);
					}
				} else if (dsrA[1] <= dsrB[0]) {
					// B following A (siblingish)
					sep = src.substring(dsrA[1], dsrB[0]);
				} else if (dsrB[3] !== null) {
					// A in B, from child to parent
					sep = src.substring(dsrA[1], dsrB[1] - dsrB[3]);
				}
			} else if (dsrA[1] <= dsrB[1]) {
				if (dsrB[3] !== null) {
					// A in B, from child to parent
					sep = src.substring(dsrA[1], dsrB[1] - dsrB[3]);
				}
			} else {
				this.env.log("warning","dsr backwards: should not happen!");
			}

			if (state.sep.lastSourceSep) {
				//console.log('lastSourceSep', state.sep.lastSourceSep);
				sep = state.sep.lastSourceSep + sep;
			}
		}
	}

	this.env.log('debug/wts/sep', function() {
		return 'maybe-sep  | ' +
			'prev:' + (prevNode ? prevNode.nodeName : '--none--') +
			', node:' + (origNode ? origNode.nodeName : '--none--') +
			', sep: ' + JSON.stringify(sep) + ', state.sep.src: ' + JSON.stringify(state.sep.src);
	});

	// 1. Verify that the separator is really one (has to be whitespace and comments)
	// 2. If the separator is being emitted before a node that emits sol-transparent WT,
	//    go through makeSeparator to verify indent-pre constraints are met.
	var sepConstraints = state.sep.constraints || {a:{},b:{}, max:0};
	if (sep === undefined ||
		!WTSUtils.isValidSep(sep) ||
		(state.sep.src && state.sep.src !== sep))
	{
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
		state.emitSep(sep, origNode, cb, 'SEP:');
	}
};

if (typeof module === "object") {
	module.exports.handleSeparatorText = handleSeparatorText;
	module.exports.updateSeparatorConstraints = updateSeparatorConstraints;
	module.exports.emitSeparator = emitSeparator;
}
