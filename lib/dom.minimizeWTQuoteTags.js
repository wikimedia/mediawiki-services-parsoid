"use strict";

require('./core-upgrade.js');
var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants,
	JSUtils = require('./jsutils.js').JSUtils;

function similar(a, b) {
	var isHtml_a = DU.isLiteralHTMLNode(a),
		isHtml_b = DU.isLiteralHTMLNode(b);

	return (!isHtml_a && !isHtml_b) ||
		(isHtml_a && isHtml_b && DU.attribsEquals(a, b, JSUtils.arrayToSet(['data-parsoid'])));
}

/** Can a and b be merged into a single node? */
function mergable(a, b) {
	return a.nodeName === b.nodeName && similar(a, b);
}

/**
 * Can a and b be combined into a single node
 * if we swap a and a.firstChild?
 *
 * For example: a='<b><i>x</i></b>' b='<i>y</i>' => '<i><b>x</b>y</i>'
 */
function swappable(a, b) {
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
function minimizeTags(node, rewriteablePair, recurse) {
	if (DU.isFirstEncapsulationWrapperNode(node) || !node.firstChild) {
		return;
	}

	// minimize the children of `node`.  if `recurse` is true we're going to
	// recurse to ensure the children are also minimized.  if `recurse` is
	// false we can assume the children are already minimized.
	var a = node.firstChild, b;

	if (DU.isElt(a) && recurse) {
		minimizeTags(a, rewriteablePair, true);
	}

	while (a) {
		b = a.nextSibling;
		if (!b) {
			break;
		}

		if (DU.isElt(b) && recurse) {
			minimizeTags(b, rewriteablePair, true);
		}

		// If 'a' and 'b' make a rewriteable tag-pair and neither of them
		// is an encapsulated element, we are good to go!
		if (rewriteablePair(a, b) &&
			!DU.isFirstEncapsulationWrapperNode(a) &&
			!DU.isFirstEncapsulationWrapperNode(b))
		{
			if (mergable(a, b)) {
				a = merge(a, b);
				// the new a's children have new siblings.  so let's look
				// at a again.  but the children themselves haven't changed,
				// so we don't need to recurse.
				minimizeTags(a, rewriteablePair, false);
			} else if (swappable(a, b)) {
				a = merge(swap(a, a.firstChild), b);
				// again, a has new children, but the grandkids have already
				// been minimized.
				minimizeTags(a, rewriteablePair, false);
			} else if (swappable(b, a)) {
				a = merge(a, swap(b, b.firstChild));
				// again, a has new children, but the grandkids have already
				// been minimized.
				minimizeTags(a, rewriteablePair, false);
			} else {
				a = b;
			}
		} else {
			a = b;
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
			return Consts.WTQuoteTags.has( a.nodeName ) &&
				Consts.WTQuoteTags.has( b.nodeName ) &&
				(DU.isNewElt(a) || DU.isNewElt(b));
		}, true);
}

if (typeof module === "object") {
	module.exports.minimizeWTQuoteTags = minimizeWTQuoteTags;
}
