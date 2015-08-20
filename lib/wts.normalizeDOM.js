'use strict';

/**
 * DOM normalization.
 *
 * DOM normalizations are performed after DOMDiff is run.
 * So, normalization routines should update diff markers appropriately.
 *
 * SSS FIXME: Once we simplify WTS to get rid of rt-test mode,
 * we should be able to get rid of the 'children-changed' diff marker
 * and just use the more generic 'subtree-changed' marker.
 */

require('./core-upgrade.js');
var DU = require('./mediawiki.DOMUtils.js').DOMUtils;
var Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants;

function Normalizer(state) {
	this.env = state.env;
	this.inSelserMode = state.selserMode;
	this.inRtTestMode = state.rtTestMode;
	this.inInsertedContent = false;
}

Normalizer.prototype.addDiffMarks = function(node, mark, dontRecurse) {
	var env = this.env;
	if (!this.inSelserMode || this.inInsertedContent || DU.hasDiffMark(node, env, mark)) {
		return;
	}

	// Newly added elements don't need diff marks
	if (!DU.isNewElt(node)) {
		DU.addDiffMark(node, env, mark);
	}

	if (dontRecurse) {
		return;
	}

	// Walk up the subtree and add 'subtree-changed' markers
	node = node.parentNode;
	while (DU.isElt(node) && !DU.isBody(node)) {
		if (DU.hasDiffMark(node, env, 'subtree-changed')) {
			return;
		}
		if (!DU.isNewElt(node)) {
			DU.setDiffMark(node, env, 'subtree-changed');
		}
		node = node.parentNode;
	}
};

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
	return DU.numNonDeletedChildNodes(a) === 1 &&
		similar(a, DU.firstNonDeletedChildNode(a)) &&
		mergable(DU.firstNonDeletedChildNode(a), b);
}

/** Transfer all of b's children to a and delete b */
Normalizer.prototype.merge = function(a, b) {
	var sentinel = b.firstChild;

	// Migrate any intermediate nodes (usually 0 / 1 diff markers)
	// present between a and b to a
	var next = a.nextSibling;
	if (next !== b) {
		a.appendChild(next);
	}

	// The real work of merging
	DU.migrateChildren(b, a);
	b.parentNode.removeChild(b);

	// Update diff markers
	if (sentinel) {
		// Nodes starting at 'sentinal' were inserted into 'a'
		// b, which was a's sibling was deleted
		this.addDiffMarks(sentinel, 'moved', true);
		this.addDiffMarks(a, 'children-changed', true);
	}
	if (a.nextSibling) {
		// FIXME: Hmm .. there is an API hole here
		// about ability to add markers after last child
		this.addDiffMarks(a.nextSibling, 'moved', true);
	}
	this.addDiffMarks(a.parentNode, 'children-changed');

	return a;
};

/** b is a's sole non-deleted child.  Switch them around. */
Normalizer.prototype.swap = function(a, b) {
	DU.migrateChildren(b, a);
	a.parentNode.insertBefore(b, a);
	b.appendChild(a);

	// Mark a's subtree, a, and b as all having moved
	this.addDiffMarks(a.firstChild, 'moved', true);
	this.addDiffMarks(a, 'moved', true);
	this.addDiffMarks(b, 'moved', true);
	this.addDiffMarks(a, 'children-changed', true);
	this.addDiffMarks(b, 'children-changed', true);
	this.addDiffMarks(b.parentNode, 'children-changed');

	return b;
};

Normalizer.prototype.hoistLinks = function(node, rtl) {
	var firstChild = function(node, rtl) {
		return rtl ? DU.lastNonDeletedChildNode(node) : DU.firstNonDeletedChildNode(node);
	};

	var sibling = firstChild(node, rtl);
	var hasHoistableContent = false;

	while (sibling) {
		var next = rtl ? DU.previousNonDeletedSibling(sibling) : DU.nextNonDeletedSibling(sibling);
		if (!DU.isContentNode(sibling)) {
			sibling = next;
			continue;
		} else if ((!DU.isSolTransparentLink(sibling) && !DU.isBehaviorSwitch(this.env, sibling))
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
		var move = firstChild(node, rtl);
		var firstNode = move;
		while (move !== sibling) {
			node.parentNode.insertBefore(move, rtl ? DU.nextNonDeletedSibling(node) : node);
			move = firstChild(node, rtl);
		}

		// and drop any leading whitespace
		if (DU.isText(sibling)) {
			var space = new RegExp(rtl ? '\\s*$' : '^\\s*');
			sibling.nodeValue = sibling.nodeValue.replace(space, '');
		}

		// Update diff markers
		this.addDiffMarks(firstNode, 'moved', true);
		this.addDiffMarks(sibling, 'moved', true);
		this.addDiffMarks(node, 'children-changed', true);
		this.addDiffMarks(node.parentNode, 'children-changed');
	}
};

Normalizer.prototype.stripIfEmpty = function(node) {
	var next = DU.nextNonDeletedSibling(node);
	var dp = DU.getDataParsoid(node);
	var strict = this.inRtTestMode;
	var autoInserted = dp.autoInsertedStart || dp.autoInsertedEnd;

	// In rtTestMode, let's reduce noise by requiring the node to be fully
	// empty (ie. exclude whitespace text) and not having auto-inserted tags.
	var strippable = !(this.inRtTestMode && autoInserted) &&
		DU.nodeEssentiallyEmpty(node, strict) &&
		// Ex: "<a..>..</a><b></b>bar"
		// From [[Foo]]<b/>bar usage found on some dewiki pages.
		// FIXME: Should this always than just in rt-test mode
		!(this.inRtTestMode && dp.stx === 'html');

	if (strippable) {
		// Update diff markers (before the deletion)
		this.addDiffMarks(node, 'deleted', true);
		this.addDiffMarks(node.parentNode, 'children-changed');
		node.parentNode.removeChild(node);
		return next;
	} else {
		return node;
	}
};

Normalizer.prototype.moveTrailingSpacesOut = function(node) {
	var next = DU.nextNonDeletedSibling(node);
	var last = DU.lastNonDeletedChildNode(node);
	var endsInSpace = DU.isText(last) && last.nodeValue.match(/\s+$/);
	// Conditional on rtTestMode to reduce the noise in testing.
	if (!this.inRtTestMode && endsInSpace) {
		last.nodeValue = last.nodeValue.substring(0, endsInSpace.index);
		// Try to be a little smarter and drop the spaces if possible.
		if (next && (!DU.isText(next) || !/^\s+/.test(next.nodeValue))) {
			if (!DU.isText(next)) {
				var txt = node.ownerDocument.createTextNode('');
				node.parentNode.insertBefore(txt, next);
				next = txt;
			}
			next.nodeValue = endsInSpace[0] + next.nodeValue;
			// next (a text node) is new / had new content added to it
			this.addDiffMarks(next, 'inserted', true);
		}
		this.addDiffMarks(last, 'inserted', true);
		this.addDiffMarks(node, 'children-changed', true);
		this.addDiffMarks(node.parentNode, 'children-changed');
	}
};

/**
 * Normalizations implemented right now:
 * -------------------------------------
 * 1. Tag minimization (I/B tags) in normalizeSiblingPair
 * 2. Strip empty headings and style tags
 * 3. Force SOL transparent links to serialize before/after heading
 * 4. Trailing spaces are migrated out of links
 * 5. Space is added before escapable prefixes in table cells
 */
Normalizer.prototype.normalizeNode = function(node) {
	// Only if scrubWikitext flag is enabled
	if (!this.env.scrubWikitext) {
		return node;
	}

	// Skip unmodified content
	if (this.inSelserMode && !DU.isBody(node) &&
		!this.inInsertedContent && !DU.hasDiffMarkers(node, this.env) &&
		// If orig-src is not valid, this in effect becomes
		// an edited node and needs normalizations applied to it.
		DU.origSrcValidInEditedContext(this.env, node)) {
		return node;
	}

	// Headings
	if (/^H[1-6]$/.test(node.nodeName)) {
		this.hoistLinks(node, false);
		this.hoistLinks(node, true);
		return this.stripIfEmpty(node);

	// Quote tags
	} else if (Consts.WTQuoteTags.has(node.nodeName)) {
		return this.stripIfEmpty(node);

	// Anchors
	} else if (node.nodeName === 'A') {
		var next = DU.nextNonDeletedSibling(node);
		// We could have checked for !mw:ExtLink but in
		// the case of links without any annotations,
		// the positive test is semantically safer than the
		// negative test.
		if (/^mw:WikiLink$/.test(node.getAttribute('rel')) && this.stripIfEmpty(node) !== node) {
			return next;
		}
		this.moveTrailingSpacesOut(node);
		return node;

	// Table cells
	} else if (node.nodeName === 'TD') {
		var dp = DU.getDataParsoid(node);

		// * HTML <td>s won't have escapable prefixes
		// * First cell should always be checked for escapable prefixes
		// * Second and later cells in a wikitext td row (with stx_v='row' flag)
		//   won't have escapable prefixes.
		if (dp.stx === 'html' ||
			(DU.firstNonSepChildNode(node.parentNode) !== node &&
			dp.stx_v === 'row')) {
			return node;
		}

		var first = DU.firstNonDeletedChildNode(node);
		// Emit a space before escapable prefix
		// This is preferable to serializing with a nowiki.
		if (DU.isText(first) && /^[\-+]/.test(first.nodeValue)) {
			first.nodeValue = ' ' + first.nodeValue;
			this.addDiffMarks(first, 'inserted', true);
			this.addDiffMarks(node, 'children-changed');
		}
		return node;

	// Default
	} else {
		return node;
	}
};

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

Normalizer.prototype.normalizeSiblingPair = function(a, b) {
	// If 'a' and 'b' make a rewriteable tag-pair,
	// we are good to go.
	if (rewriteablePair(this.env, a, b)) {
		if (mergable(a, b)) {
			a = this.merge(a, b);
			// The new a's children have new siblings. So let's look
			// at a again. But their grandkids haven't changed,
			// so we don't need to recurse further.
			this.processSubtree(a, false);
		} else if (swappable(a, b)) {
			a = this.merge(this.swap(a, DU.firstNonDeletedChildNode(a)), b);
			// Again, a has new children, but the grandkids have already
			// been minimized.
			this.processSubtree(a, false);
		} else if (swappable(b, a)) {
			a = this.merge(a, this.swap(b, DU.firstNonDeletedChildNode(b)));
			// Again, a has new children, but the grandkids have already
			// been minimized.
			this.processSubtree(a, false);
		} else {
			a = b;
		}
	} else {
		a = b;
	}

	return a;
};

Normalizer.prototype.processSubtree = function(node, recurse) {
	// Process the first child outside the loop.
	var a = DU.firstNonDeletedChildNode(node);
	if (!a) {
		return;
	}

	a = this.processNode(a, recurse);
	while (a) {
		// We need a pair of adjacent siblings for tag minimization.
		var b = DU.nextNonDeletedSibling(a);
		if (!b) {
			return;
		}

		// Process subtree rooted at 'b'.
		b = this.processNode(b, recurse);

		// If we skipped over a bunch of nodes in the middle,
		// we no longer have a pair of adjacent siblings.
		if (b && DU.previousNonDeletedSibling(b) === a) {
			// Process the pair.
			a = this.normalizeSiblingPair(a, b);
		} else {
			a = b;
		}
	}
};

Normalizer.prototype.processNode = function(node, recurse) {
	// Normalize 'node' and the subtree rooted at 'node'
	// recurse = true  => recurse and normalize subtree
	// recurse = false => assume the subtree is already normalized

	// Normalize node till it stabilizes
	var next;
	while (true) {
		// Skip templated content
		if (DU.isFirstEncapsulationWrapperNode(node)) {
			node = DU.skipOverEncapsulatedContent(node);
		}

		if (!node) {
			return null;
		}

		// Set insertion marker
		var insertedSubtree = DU.hasInsertedDiffMark(node, this.env);
		if (insertedSubtree) {
			console.assert(!this.inInsertedContent, 'Found nested inserted dom-diff flags!');
			this.inInsertedContent = true;
		}

		// Post-order traversal: Process subtree first, and current node after.
		// This lets multiple normalizations take effect cleanly.
		if (recurse && DU.isElt(node)) {
			this.processSubtree(node, true);
		}

		next = this.normalizeNode(node);

		// Clear insertion marker
		if (insertedSubtree) {
			this.inInsertedContent = false;
		}

		if (next === node) {
			return node;
		} else {
			node = next;
		}
	}

	console.assert(false, "Control should never get here!");
};

Normalizer.prototype.normalizeDOM = function(body) {
	return this.processNode(body, true);
};

if (typeof module === 'object') {
	module.exports.Normalizer = Normalizer;
}
