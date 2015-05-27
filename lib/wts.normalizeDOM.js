'use strict';

/**
 * DOM normalization.
 *
 * Note that DOM normalization is performed on incoming DOM *before*
 * DOMDiff is run.  Normalization routines should therefore be written
 * to only update new/edited content, otherwise selser may break.
 */

require('./core-upgrade.js');
var DU = require('./mediawiki.DOMUtils.js').DOMUtils;
var Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants;

var ignoreableAttribs = new Set(['data-parsoid', 'data-parsoid-diff']);

function similar(a, b) {
	var aIsHtml = DU.isLiteralHTMLNode(a);
	var bIsHtml = DU.isLiteralHTMLNode(b);

	return (!aIsHtml && !bIsHtml) ||
		(aIsHtml && bIsHtml && DU.attribsEquals(a, b, ignoreableAttribs));
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
function merge(env, a, b) {
	DU.migrateChildren(b, a);
	b.parentNode.removeChild(b);
	return a;
}

/** b is a's sole non-deleted child.  Switch them around. */
function swap(env, a, b) {
	DU.migrateChildren(b, a);
	a.parentNode.insertBefore(b, a);
	b.appendChild(a);

	return b;
}

function hoistLinks(node, rtl) {
	var first = rtl ? 'lastChild' : 'firstChild';
	var prop = rtl ? 'previousSibling' : 'nextSibling';
	var sibling = node[first];
	var hasHoistableContent = false;
	var next, move, space;

	while (sibling) {
		next = sibling[prop];
		if (!DU.isContentNode(sibling)) {
			sibling = next;
			continue;
		} else if (!DU.isSolTransparentLink(sibling)) {
			break;
		} else {
			hasHoistableContent = true;
		}
		sibling = next;
	}

	if (hasHoistableContent) {
		// soak up all the non-content nodes (exclude sibling)
		move = node[first];
		while (move !== sibling) {
			node.parentNode.insertBefore(move, rtl ? node.nextSibling : node);
			move = node[first];
		}
		// and drop any leading whitespace
		if (DU.isText(sibling)) {
			space = new RegExp(rtl ? '\\s*$' : '^\\s*');
			sibling.nodeValue = sibling.nodeValue.replace(space, '');
		}
	}
}

// Forward declaration
var _normalizeDOM;

/**
 * Normalizations implemented right now:
 * -------------------------------------
 * 1. Tag minimization (I/B tags) in normalizeSiblingPair
 * 2. Strip empty headings
 * 3. Force SOL transparent links to serialize before/after heading
 */

function normalizeNode(env, node) {
	var isHeading = /^H[1-6]$/.test(node.nodeName);
	if (isHeading) {
		hoistLinks(node, false);
		hoistLinks(node, true);
	}

	// Right now, only newly inserted elements are normalized
	if (!env.scrubWikitext || !DU.isNewElt(node)) {
		return node;
	}

	// Empty headings are stripped
	var emptyHeading = isHeading && DU.nodeEssentiallyEmpty(node);
	if (emptyHeading) {
		var next = node.nextSibling;
		node.parentNode.removeChild(node);
		node = next;
	}

	return node;
}

/*
 * Tag minimization
 * ----------------
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

function normalizeSiblingPair(env, a, b) {
	// If 'a' and 'b' make a rewriteable tag-pair,
	// we are good to go.
	if (rewriteablePair(a, b)) {
		if (mergable(a, b)) {
			a = merge(env, a, b);
			// The new a's children have new siblings. So let's look
			// at a again. But their grandkids haven't changed,
			// so we don't need to recurse further.
			_normalizeDOM(env, a, false);
		} else if (swappable(a, b)) {
			a = merge(env, swap(env, a, a.firstChild), b);
			// Again, a has new children, but the grandkids have already
			// been minimized.
			_normalizeDOM(env, a, false);
		} else if (swappable(b, a)) {
			a = merge(env, a, swap(env, b, b.firstChild));
			// Again, a has new children, but the grandkids have already
			// been minimized.
			_normalizeDOM(env, a, false);
		} else {
			a = b;
		}
	} else {
		a = b;
	}

	return a;
}

function processNode(env, a, recurse) {
	// Normalize 'a' and the subtree rooted at 'a'
	// recurse = true  => recurse and normalize subtree
	// recurse = false => assume the subtree is already normalized

	// Skip templated content
	if (a && DU.isFirstEncapsulationWrapperNode(a)) {
		a = DU.skipOverEncapsulatedContent(a);
	}

	if (a) {
		// Normalize node till it stabilizes
		var next = normalizeNode(env, a);
		while (next !== a) {
			if (!next) {
				return null;
			}
			a = next;
			next = normalizeNode(env, a);
		}

		// Process DOM rooted at 'a'
		if (recurse && DU.isElt(a)) {
			_normalizeDOM(env, a, true);
		}
	}

	return a;
}

_normalizeDOM = function(env, node, recurse) {
	// Process the first child outside the loop.
	var a = node.firstChild;
	a = processNode(env, a, recurse);
	while (a) {
		// We need a pair of adjacent siblings for tag minimization.
		var b = a.nextSibling;
		if (!b) {
			break;
		}

		// Process subtree rooted at 'b'.
		b = processNode(env, b, recurse);

		// If we skipped over a bunch of nodes in the middle,
		// we no longer have a pair of adjacent siblings.
		if (b && b.previousSibling === a) {
			// Process the pair.
			a = normalizeSiblingPair(env, a, b);
		} else {
			a = b;
		}
	}
};

function normalizeDOM(body, env) {
	return _normalizeDOM(env, body, true);
}

if (typeof module === 'object') {
	module.exports.normalizeDOM = normalizeDOM;
}
