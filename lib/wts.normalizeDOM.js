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

var wtIgnorableAttrs = new Set(['data-parsoid', 'id', 'title']);
var htmlIgnorableAttrs = new Set(['data-parsoid']);

function similar(a, b) {
	if (a.nodeName === 'A') {
		return DU.attribsEquals(a, b, wtIgnorableAttrs);
	} else {
		var aIsHtml = DU.isLiteralHTMLNode(a);
		var bIsHtml = DU.isLiteralHTMLNode(b);
		var ignorableAttrs = aIsHtml ? htmlIgnorableAttrs : wtIgnorableAttrs;

		// FIXME: For non-HTML I/B tags, we seem to be dropping all attributes
		// in our tag handlers (which seems like a bug). Till that is fixed,
		// we'll preserve existing functionality here.
		return (!aIsHtml && !bIsHtml) ||
			(aIsHtml && bIsHtml && DU.attribsEquals(a, b, ignorableAttrs));
	}
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

function hoistLinks(env, node, rtl) {
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
		} else if ((!DU.isSolTransparentLink(sibling) && !DU.isBehaviorSwitch(env, sibling))
			|| DU.isEncapsulationWrapper(sibling)) {
			// Don't venture into templated content
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

function stripIfEmpty(node) {
	var next = node.nextSibling;
	if (DU.nodeEssentiallyEmpty(node)) {
		node.parentNode.removeChild(node);
		return next;
	} else {
		return node;
	}
}

// Forward declaration
var _normalizeDOM;

/**
 * Normalizations implemented right now:
 * -------------------------------------
 * 1. Tag minimization (I/B tags) in normalizeSiblingPair
 * 2. Strip empty headings and style tags
 * 3. Force SOL transparent links to serialize before/after heading
 * 4. Trailing spaces are migrated out of links
 * 5. Space is added before escapable prefixes in table cells
 */

function normalizeNode(env, node) {
	var doc = node.ownerDocument;

	// Only newly inserted elements are scrubbed
	if (!env.scrubWikitext || !DU.isNewElt(node)) {
		return node;

	// Headings
	} else if (/^H[1-6]$/.test(node.nodeName)) {
		hoistLinks(env, node, false);
		hoistLinks(env, node, true);
		return stripIfEmpty(node);

	// Quote tags
	} else if (Consts.WTQuoteTags.has(node.nodeName)) {
		return stripIfEmpty(node);

	// Anchors
	} else if (node.nodeName === 'A') {
		var next = node.nextSibling;
		if (stripIfEmpty(node) !== node) {
			return next;
		}
		var last = node.lastChild;
		var endsInSpace = DU.isText(last) && last.nodeValue.match(/\s+$/);
		// Move trailing spaces out of links
		if (endsInSpace) {
			last.nodeValue = last.nodeValue.substring(0, endsInSpace.index);
			if (!DU.isText(next)) {
				var txt = doc.createTextNode('');
				node.parentNode.insertBefore(txt, next);
				next = txt;
			}
			next.nodeValue = endsInSpace[0] + next.nodeValue;
		}
		return node;

	// Table cells
	} else if (node.nodeName === 'TD') {
		var first = node.firstChild;
		// Emit a space before escapable prefix
		// This is preferable to serializing with a nowiki.
		if (DU.isText(first) && /^[\-+]/.test(first.nodeValue)) {
			first.nodeValue = ' ' + first.nodeValue;
		}
		return node;

	// Default
	} else {
		return node;
	}
}

/*
 * Tag minimization
 * ----------------
 * Minimize a pair of tags in the dom tree rooted at node.
 *
 * This function merges adjacent nodes of the same type
 * and swaps nodes where possible to enable further merging.
 *
 * See examples below:
 *
 * 1. <b>X</b><b>Y</b>
 *    ==> <b>XY</b>
 *
 * 2. <i>A</i><b><i>X</i></b><b><i>Y</i></b><i>Z</i>
 *    ==> <i>A<b>XY</b>Z</i>
 *
 * 3. <a href="Football">Foot</a><a href="Football">ball</a>
 *    ==> <a href="Football">Football</a>
 */

function rewriteablePair(env, a, b) {
	if (Consts.WTQuoteTags.has(a.nodeName)) {
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

		return Consts.WTQuoteTags.has(b.nodeName);
	} else if (env.scrubWikitext && a.nodeName === 'A') {
		// Link merging is only supported in scrubWikitext mode.
		// For <a> tags, we require at least one of the two tags
		// to be a newly created element.
		return b.nodeName === 'A' && (DU.isNewElt(a) || DU.isNewElt(b));
	}
}

function normalizeSiblingPair(env, a, b) {
	// If 'a' and 'b' make a rewriteable tag-pair,
	// we are good to go.
	if (rewriteablePair(env, a, b)) {
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
