"use strict";

require('./core-upgrade.js');
var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants;

function similar(a, b) {
	var isHtml_a = DU.isLiteralHTMLNode(a),
		isHtml_b = DU.isLiteralHTMLNode(b);

	return (!isHtml_a && !isHtml_b) ||
		(isHtml_a && isHtml_b && DU.attribsEquals(a, b, {'data-parsoid' : 1}));
}

/** Can a and b be merged into a single node? */
function mergable(a, b) {
	return a.nodeName === b.nodeName && similar(a, b);
}

/**
 * Can a and b be combined into a single node
 * if we swap a and a.firstChild?
 *
 * FIXME: Better name than combinable?
 */
function combinable(a, b) {
	return a.childNodes.length === 1 &&
		similar(a, a.firstChild) &&
		mergable(a.firstChild, b);
}

/** Transfer all of b's children to a and delete b */
function merge(a, b) {
	DU.migrateChildren(b, a);
	b.parentNode.removeChild(b);

	return a;
}

/** b is a's sole child.  Switch them around. */
function swap(a, b) {
	DU.migrateChildren(b, a);
	a.parentNode.insertBefore(b, a);
	b.appendChild(a);

	return b;
}

/**
 * Minimize a pair of tags in the dom tree rooted at node.
 *
 * This function merges adjacent nodes of the same type
 * and swaps nodes where possible to enable further merging.
 *
 * See examples below for a (B, I) tag-pair:
 *
 * 1. <b>X</b><b>Y</b>
 *    ==> <b>XY</b>
 *
 * 2. <i>A</i><b><i>X</i></b><b><i>Y</i></b><i>Z</i>
 *    ==> <i>A<b>XY</b>Z</i>
 */
function minimizeTags(node, rewriteablePair) {
	if (DU.isEncapsulatedElt(node) || !node.firstChild) {
		return;
	}

	var a = node.firstChild, b,
		min_a = true;

	while (a) {
		if (DU.isElt(a) && min_a) {
			minimizeTags(a, rewriteablePair);
		}

		b = a.nextSibling;
		if (!b) {
			break;
		}

		if (DU.isElt(b)) {
			minimizeTags(b, rewriteablePair);
		}

		// If 'a' and 'b' make a rewriteable tag-pair and neither of them
		// is an encapsulated element, we are good to go!
		if (rewriteablePair(a, b) && !DU.isEncapsulatedElt(a) && !DU.isEncapsulatedElt(b)) {
			if (mergable(a, b)) {
				a = merge(a, b);
				min_a = true;
			} else if (combinable(a, b)) {
				a = merge(swap(a, a.firstChild), b);
				min_a = true;
			} else if (combinable(b, a)) {
				a = merge(a, swap(b, b.firstChild));
				min_a = true;
			} else {
				a = b;
				min_a = false;
			}
		} else {
			a = b;
			min_a = false;
		}
	}

	// return node to enable chaining
	return node;
}

function minimizeWTQuoteTags(node) {
	return minimizeTags(node, function(a, b) {
			// - 'a' and 'b' are both B/I tags
			// - at least one of them is new
			//   FIXME: What if neither is new, but one of them is modified?
			//   Do we want to minimize and introduce a dirty diff?
			// - neither is an encapsulated elt
			return a.nodeName in Consts.WTQuoteTags &&
				b.nodeName in Consts.WTQuoteTags &&
				(DU.isNewElt(a) || DU.isNewElt(b));
		}
	);
}

if (typeof module === "object") {
	module.exports.minimizeWTQuoteTags = minimizeWTQuoteTags;
}
