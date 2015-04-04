"use strict";

require('./core-upgrade.js');
var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants;

var ignoreableAttribs = new Set(['data-parsoid', 'data-parsoid-diff']);

function similar(a, b) {
	var isHtml_a = DU.isLiteralHTMLNode(a);
	var isHtml_b = DU.isLiteralHTMLNode(b);

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

function rewriteablePair(a, b) {
	// Currently supported: 'a' and 'b' are both B/I tags
	//
	// For <i>/<b> pair, we need not check whether the node being transformed
	// are new / edited, etc. since these minimization scenarios can
	// never show up in HTML that came from parsed wikitext.
	//
	// <i>..</i><i>..</i> can never show up without a <nowiki/> in between.
	// Similarly for <b>..</b><b>..</b> and <b><i>..</i></b><i>..</i>.
	//
	// This is because a sequence of 4 quotes is not parsed as ..</i><i>..
	// Neither is a sequence of 7 quotes parsed as ..</i></b><i>..
	//
	// So, if we see a minimizable pair of nodes, it is because the HTML
	// didn't originate from wikitext OR the HTML has been subsequently edited.
	// In both cases, we want to transform the DOM.

	return Consts.WTQuoteTags.has(a.nodeName) &&
		Consts.WTQuoteTags.has(b.nodeName);
}

/**
 * The only normalization implemented right now is I/B tag minimization.
 *
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
function _normalizeDOM(env, node, recurse) {
	if (DU.isFirstEncapsulationWrapperNode(node) || !node.firstChild) {
		return;
	}

	// Minimize the children of `node`.
	// recurse = true  => recurse to ensure the children are also minimized
	// recurse = false => assume the children are already minimized
	var a = node.firstChild, b;

	if (DU.isElt(a) && recurse) {
		_normalizeDOM(env, a, true);
	}

	while (a) {
		b = DU.nextNonDeletedSibling(a);
		if (!b) {
			break;
		}

		if (DU.isElt(b) && recurse) {
			_normalizeDOM(env, b, true);
		}

		// If 'a' and 'b' make a rewriteable tag-pair and neither of them
		// is an encapsulated element, we are good to go.
		if (rewriteablePair(a, b) &&
			!DU.isFirstEncapsulationWrapperNode(a) &&
			!DU.isFirstEncapsulationWrapperNode(b)) {
			if (mergable(a, b)) {
				a = merge(env, a, b);
				// The new a's children have new siblings. So let's look
				// at a again. But the children themselves haven't changed,
				// so we don't need to recurse.
				_normalizeDOM(env, a, false);
			} else if (swappable(a, b)) {
				a = merge(env, swap(env, a, DU.firstNonDeletedChildNode(a)), b);
				// Again, a has new children, but the grandkids have already
				// been minimized.
				_normalizeDOM(env, a, false);
			} else if (swappable(b, a)) {
				a = merge(env, a, swap(env, b, DU.firstNonDeletedChildNode(b)));
				// Again, a has new children, but the grandkids have already
				// been minimized.
				_normalizeDOM(env, a, false);
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

function normalizeDOM(node, env) {
	return _normalizeDOM(env, node, true);
}

if (typeof module === "object") {
	module.exports.normalizeDOM = normalizeDOM;
}
