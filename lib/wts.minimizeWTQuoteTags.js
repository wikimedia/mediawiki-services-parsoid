"use strict";

require('./core-upgrade.js');
var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants;

var ignoreableAttribs = new Set(['data-parsoid']);
function similar(a, b) {
	var isHtml_a = DU.isLiteralHTMLNode(a),
		isHtml_b = DU.isLiteralHTMLNode(b);

	return (!isHtml_a && !isHtml_b) ||
		(isHtml_a && isHtml_b && DU.attribsEquals(a, b, ignoreableAttribs));
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
	return DU.numNonDeletedChildNodes(a) === 1 &&
		similar(a, DU.firstNonDeletedChildNode(a)) &&
		mergable(DU.firstNonDeletedChildNode(a), b);
}

/** Transfer all of b's children to a and delete b */
function merge(env, a, b) {
	DU.migrateChildren(b, a);
	b.parentNode.removeChild(b);

	DU.setDiffMark(a, env, "children-changed");
	return a;
}

/** b is a's sole non-deleted child.  Switch them around. */
function swap(env, a, b) {
	DU.migrateChildren(b, a);
	a.parentNode.insertBefore(b, a);
	b.appendChild(a);

	DU.setDiffMark(a, env, "children-changed");
	DU.setDiffMark(b, env, "children-changed");

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
function minimizeTags(env, node, rewriteablePair, recurse) {
	if (DU.isFirstEncapsulationWrapperNode(node) || !node.firstChild) {
		return;
	}

	// minimize the children of `node`.  if `recurse` is true we're going to
	// recurse to ensure the children are also minimized.  if `recurse` is
	// false we can assume the children are already minimized.
	var a = node.firstChild, b;

	if (DU.isElt(a) && recurse) {
		minimizeTags(env, a, rewriteablePair, true);
	}

	while (a) {
		b = DU.nextNonDeletedSibling(a);
		if (!b) {
			break;
		}

		if (DU.isElt(b) && recurse) {
			minimizeTags(env, b, rewriteablePair, true);
		}

		// If 'a' and 'b' make a rewriteable tag-pair and neither of them
		// is an encapsulated element, we are good to go!
		if (rewriteablePair(a, b) &&
			!DU.isFirstEncapsulationWrapperNode(a) &&
			!DU.isFirstEncapsulationWrapperNode(b))
		{
			if (mergable(a, b)) {
				a = merge(env, a, b);
				// the new a's children have new siblings.  so let's look
				// at a again.  but the children themselves haven't changed,
				// so we don't need to recurse.
				minimizeTags(env, a, rewriteablePair, false);
			} else if (swappable(a, b)) {
				a = merge(env, swap(env, a, DU.firstNonDeletedChildNode(a)), b);
				// again, a has new children, but the grandkids have already
				// been minimized.
				minimizeTags(env, a, rewriteablePair, false);
			} else if (swappable(b, a)) {
				a = merge(env, a, swap(env, b, DU.firstNonDeletedChildNode(b)));
				// again, a has new children, but the grandkids have already
				// been minimized.
				minimizeTags(env, a, rewriteablePair, false);
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

// NOTE: We need not check whether the node being transformed
// are new / edited, etc. since these minimization scenarios can
// never show up in HTML that came from parsed wikitext
//
// <i>..</i><i>..</i> can never show up without a <nowiki/> in between.
// Similarly for <b>..</b><b>..</b> and <b><i>..</i></b><i>..</i>.
//
// This is because a sequence of 4 quotes is not parsed as ..</i><i>..
// Neither is a sequence of 7 quotes parsed as ..</i></b><i>..
//
// So, if we see a minimizable pair of nodes, it is because the HTML
// didn't originate from wikitext OR the HTML has been subsequently edited.
// In both cases, we want to apply the transformation below.
function minimizeWTQuoteTags(node, env) {
	return minimizeTags(env, node, function(a, b) {
			// - 'a' and 'b' are both B/I tags
			return Consts.WTQuoteTags.has( a.nodeName ) &&
				Consts.WTQuoteTags.has( b.nodeName );
		}, true);
}

if (typeof module === "object") {
	module.exports.minimizeWTQuoteTags = minimizeWTQuoteTags;
}
