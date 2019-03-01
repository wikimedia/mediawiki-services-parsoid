/**
 * DOM normalization.
 *
 * DOM normalizations are performed after DOMDiff is run.
 * So, normalization routines should update diff markers appropriately.
 *
 * SSS FIXME: Once we simplify WTS to get rid of rt-test mode,
 * we should be able to get rid of the 'children-changed' diff marker
 * and just use the more generic 'subtree-changed' marker.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

const { WikitextConstants: Consts } = require('../config/WikitextConstants.js');
const { ContentUtils } = require('../utils/ContentUtils.js');
const { DiffUtils } = require('./DiffUtils.js');
const { DOMDataUtils } = require('../utils/DOMDataUtils.js');
const { DOMUtils } = require('../utils/DOMUtils.js');
const { JSUtils } = require('../utils/jsutils.js');
const { WTSUtils } = require('./WTSUtils.js');
const { WTUtils } = require('../utils/WTUtils.js');

const wtIgnorableAttrs = new Set(['data-parsoid', 'id', 'title', DOMDataUtils.DataObjectAttrName()]);
const htmlIgnorableAttrs = new Set(['data-parsoid', DOMDataUtils.DataObjectAttrName()]);
const specializedAttribHandlers = JSUtils.mapObject({
	'data-mw': function(nodeA, dmwA, nodeB, dmwB, options) {
		return JSUtils.deepEquals(dmwA, dmwB);
	},
});

function similar(a, b) {
	if (a.nodeName === 'A') {
		// FIXME: Similar to 1ce6a98, DOMUtils.nextNonDeletedSibling is being
		// used in this file where maybe DOMUtils.nextNonSepSibling belongs.
		return DOMUtils.isElt(b) && DiffUtils.attribsEquals(a, b, wtIgnorableAttrs, specializedAttribHandlers);
	} else {
		var aIsHtml = WTUtils.isLiteralHTMLNode(a);
		var bIsHtml = WTUtils.isLiteralHTMLNode(b);
		var ignorableAttrs = aIsHtml ? htmlIgnorableAttrs : wtIgnorableAttrs;

		// FIXME: For non-HTML I/B tags, we seem to be dropping all attributes
		// in our tag handlers (which seems like a bug). Till that is fixed,
		// we'll preserve existing functionality here.
		return (!aIsHtml && !bIsHtml) ||
			(aIsHtml && bIsHtml && DiffUtils.attribsEquals(a, b, ignorableAttrs, specializedAttribHandlers));
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
 * For example: A='<b><i>x</i></b>' b='<i>y</i>' => '<i><b>x</b>y</i>'.
 */
function swappable(a, b) {
	return DOMUtils.numNonDeletedChildNodes(a) === 1 &&
		similar(a, DOMUtils.firstNonDeletedChild(a)) &&
		mergable(DOMUtils.firstNonDeletedChild(a), b);
}

function firstChild(node, rtl) {
	return rtl ? DOMUtils.lastNonDeletedChild(node) : DOMUtils.firstNonDeletedChild(node);
}

function isInsertedContent(node, env) {
	while (true) {
		if (DiffUtils.hasInsertedDiffMark(node, env)) {
			return true;
		}
		if (DOMUtils.isBody(node)) {
			return false;
		}
		node = node.parentNode;
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
		return b.nodeName === 'A' && (WTUtils.isNewElt(a) || WTUtils.isNewElt(b));
	}
}

/**
 * @class
 * @param {SerializerState} state
 */
class DOMNormalizer {
	constructor(state) {
		this.env = state.env;
		this.inSelserMode = state.selserMode;
		this.inRtTestMode = state.rtTestMode;
		this.inInsertedContent = false;
	}

	addDiffMarks(node, mark, dontRecurse) {
		var env = this.env;
		if (!this.inSelserMode || DiffUtils.hasDiffMark(node, env, mark)) {
			return;
		}

		// Don't introduce nested inserted markers
		if (this.inInsertedContent && mark === 'inserted') {
			return;
		}

		// Newly added elements don't need diff marks
		if (!WTUtils.isNewElt(node)) {
			DiffUtils.addDiffMark(node, env, mark);
			if (mark === 'inserted' || mark === 'deleted') {
				DiffUtils.addDiffMark(node.parentNode, env, 'children-changed');
			}
		}

		if (dontRecurse) {
			return;
		}

		// Walk up the subtree and add 'subtree-changed' markers
		node = node.parentNode;
		while (DOMUtils.isElt(node) && !DOMUtils.isBody(node)) {
			if (DiffUtils.hasDiffMark(node, env, 'subtree-changed')) {
				return;
			}
			if (!WTUtils.isNewElt(node)) {
				DiffUtils.setDiffMark(node, env, 'subtree-changed');
			}
			node = node.parentNode;
		}
	}

	/** Transfer all of b's children to a and delete b. */
	merge(a, b) {
		var sentinel = b.firstChild;

		// Migrate any intermediate nodes (usually 0 / 1 diff markers)
		// present between a and b to a
		var next = a.nextSibling;
		if (next !== b) {
			a.appendChild(next);
		}

		// The real work of merging
		DOMUtils.migrateChildren(b, a);
		b.parentNode.removeChild(b);

		// Normalize the node to merge any adjacent text nodes
		a.normalize();

		// Update diff markers
		if (sentinel) {
			// Nodes starting at 'sentinal' were inserted into 'a'
			// b, which was a's sibling was deleted
			// Only addDiffMarks to sentinel, if it is still part of the dom
			// (and hasn't been deleted by the call to a.normalize() )
			if (sentinel.parentNode) {
				this.addDiffMarks(sentinel, 'moved', true);
			}
			this.addDiffMarks(a, 'children-changed', true);
		}
		if (a.nextSibling) {
			// FIXME: Hmm .. there is an API hole here
			// about ability to add markers after last child
			this.addDiffMarks(a.nextSibling, 'moved', true);
		}
		this.addDiffMarks(a.parentNode, 'children-changed');

		return a;
	}

	/** b is a's sole non-deleted child.  Switch them around. */
	swap(a, b) {
		DOMUtils.migrateChildren(b, a);
		a.parentNode.insertBefore(b, a);
		b.appendChild(a);

		// Mark a's subtree, a, and b as all having moved
		if (a.firstChild !== null) {
			this.addDiffMarks(a.firstChild, 'moved', true);
		}
		this.addDiffMarks(a, 'moved', true);
		this.addDiffMarks(b, 'moved', true);
		this.addDiffMarks(a, 'children-changed', true);
		this.addDiffMarks(b, 'children-changed', true);
		this.addDiffMarks(b.parentNode, 'children-changed');

		return b;
	}

	hoistLinks(node, rtl) {
		var sibling = firstChild(node, rtl);
		var hasHoistableContent = false;

		while (sibling) {
			var next = rtl ? DOMUtils.previousNonDeletedSibling(sibling) : DOMUtils.nextNonDeletedSibling(sibling);
			if (!DOMUtils.isContentNode(sibling)) {
				sibling = next;
				continue;
			} else if (!WTUtils.isRenderingTransparentNode(sibling)
				|| WTUtils.isEncapsulationWrapper(sibling)) {
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
				node.parentNode.insertBefore(move, rtl ? DOMUtils.nextNonDeletedSibling(node) : node);
				move = firstChild(node, rtl);
			}

			// and drop any leading whitespace
			if (DOMUtils.isText(sibling)) {
				var space = new RegExp(rtl ? '\\s*$' : '^\\s*');
				sibling.nodeValue = sibling.nodeValue.replace(space, '');
			}

			// Update diff markers
			this.addDiffMarks(firstNode, 'moved', true);
			if (sibling) { this.addDiffMarks(sibling, 'moved', true); }
			this.addDiffMarks(node, 'children-changed', true);
			this.addDiffMarks(node.parentNode, 'children-changed');
		}
	}

	stripIfEmpty(node) {
		var next = DOMUtils.nextNonDeletedSibling(node);
		var dp = DOMDataUtils.getDataParsoid(node);
		var strict = this.inRtTestMode;
		var autoInserted = dp.autoInsertedStart || dp.autoInsertedEnd;

		// In rtTestMode, let's reduce noise by requiring the node to be fully
		// empty (ie. exclude whitespace text) and not having auto-inserted tags.
		var strippable = !(this.inRtTestMode && autoInserted) &&
			DOMUtils.nodeEssentiallyEmpty(node, strict) &&
			// Ex: "<a..>..</a><b></b>bar"
			// From [[Foo]]<b/>bar usage found on some dewiki pages.
			// FIXME: Should this always than just in rt-test mode
			!(this.inRtTestMode && dp.stx === 'html');

		if (strippable) {
			// Update diff markers (before the deletion)
			this.addDiffMarks(node, 'deleted', true);
			node.parentNode.removeChild(node);
			return next;
		} else {
			return node;
		}
	}

	moveTrailingSpacesOut(node) {
		var next = DOMUtils.nextNonDeletedSibling(node);
		var last = DOMUtils.lastNonDeletedChild(node);
		var endsInSpace = DOMUtils.isText(last) && last.nodeValue.match(/\s+$/);
		// Conditional on rtTestMode to reduce the noise in testing.
		if (!this.inRtTestMode && endsInSpace) {
			last.nodeValue = last.nodeValue.substring(0, endsInSpace.index);
			// Try to be a little smarter and drop the spaces if possible.
			if (next && (!DOMUtils.isText(next) || !/^\s+/.test(next.nodeValue))) {
				if (!DOMUtils.isText(next)) {
					var txt = node.ownerDocument.createTextNode('');
					node.parentNode.insertBefore(txt, next);
					next = txt;
				}
				next.nodeValue = endsInSpace[0] + next.nodeValue;
				// next (a text node) is new / had new content added to it
				this.addDiffMarks(next, 'inserted', true);
			}
			this.addDiffMarks(last, 'inserted', true);
			this.addDiffMarks(node.parentNode, 'children-changed');
		}
	}

	stripBRs(node) {
		var child = node.firstChild;
		while (child) {
			var next = child.nextSibling;
			if (child.nodeName === 'BR') {
				// replace <br/> with a single space
				node.removeChild(child);
				node.insertBefore(node.ownerDocument.createTextNode(' '), next);
			} else if (DOMUtils.isElt(child)) {
				this.stripBRs(child);
			}
			child = next;
		}
	}

	stripBidiCharsAroundCategories(node) {
		if (!DOMUtils.isText(node) ||
			(!WTUtils.isCategoryLink(node.previousSibling) && !WTUtils.isCategoryLink(node.nextSibling))) {
			// Not a text node and not adjacent to a category link
			return node;
		}

		var next = node.nextSibling;
		if (!next || WTUtils.isCategoryLink(next)) {
			// The following can leave behind an empty text node.
			var oldLength = node.nodeValue.length;
			node.nodeValue = node.nodeValue.replace(/([\u200e\u200f]+\n)?[\u200e\u200f]+$/g, '');
			var newLength = node.nodeValue.length;

			if (oldLength !== newLength) {
				// Log changes for editors benefit
				this.env.log('warn/html2wt/bidi',
					'LRM/RLM unicode chars stripped around categories');
			}

			if (newLength === 0) {
				// Remove empty text nodes to keep DOM in normalized form
				var ret = DOMUtils.nextNonDeletedSibling(node);
				node.parentNode.removeChild(node);
				this.addDiffMarks(node, 'deleted');
				return ret;
			}

			// Treat modified node as having been newly inserted
			this.addDiffMarks(node, 'inserted');
		}
		return node;
	}

	// When an A tag is encountered, if there are format tags inside, move them outside
	// Also merge a single sibling A tag that is mergable
	// The link href and text must match for this normalization to take effect
	moveFormatTagOutsideATag(node) {
		if (this.inRtTestMode || node.nodeName !== 'A') {
			return node;
		}

		var sibling = DOMUtils.nextNonDeletedSibling(node);
		if (sibling) {
			this.normalizeSiblingPair(node, sibling);
		}

		var firstChild = DOMUtils.firstNonDeletedChild(node);
		var fcNextSibling = null;
		if (firstChild) {
			fcNextSibling = DOMUtils.nextNonDeletedSibling(firstChild);
		}

		var blockingAttrs = [ 'color', 'style', 'class' ];

		if (!node.hasAttribute('href')) {
			this.env.log("error/normalize", "href is missing from a tag", node.outerHTML);
			return node;
		}
		var nodeHref = node.getAttribute('href');

		// If there are no tags to swap, we are done
		if (firstChild && DOMUtils.isElt(firstChild) &&
			// No reordering possible with multiple children
			fcNextSibling === null &&
			// Do not normalize WikiLinks with these attributes
			!blockingAttrs.some(function(attr) { return firstChild.hasAttribute(attr); }) &&
			// Compare textContent to the href, noting that this matching doesn't handle all
			// possible simple-wiki-link scenarios that isSimpleWikiLink in link handler tackles
			node.textContent === nodeHref.replace(/\.\//, '')
		) {
			var child;
			while ((child = DOMUtils.firstNonDeletedChild(node)) && DOMUtils.isFormattingElt(child)) {
				this.swap(node, child);
			}
			return firstChild;
		}

		return node;
	}

	/**
	 * scrubWikitext normalizations implemented right now:
	 *
	 * 1. Tag minimization (I/B tags) in normalizeSiblingPair
	 * 2. Strip empty headings and style tags
	 * 3. Force SOL transparent links to serialize before/after heading
	 * 4. Trailing spaces are migrated out of links
	 * 5. Space is added before escapable prefixes in table cells
	 * 6. Strip <br/> from headings
	 * 7. Strip bidi chars around categories
	 * 8. When an A tag is encountered, if there are format tags inside, move them outside
	 *
	 * The return value from this function should respect the
	 * following contract:
	 * - if input node is unmodified, return it.
	 * - if input node is modified, return the new node
	 *   that it transforms into.
	 * If you return a node other than this, normalizations may not
	 * apply cleanly and may be skipped.
	 *
	 * @param {Node} node the node to normalize
	 * @return {Node} the normalized node
	 */
	normalizeNode(node) {
		var dp;
		if (node.nodeName === 'TH' || node.nodeName === 'TD') {
			dp = DOMDataUtils.getDataParsoid(node);
			// Table cells (td/th) previously used the stx_v flag for single-row syntax.
			// Newer code uses stx flag since that is used everywhere else.
			// While we still have old HTML in cache / storage, accept
			// the stx_v flag as well.
			// TODO: We are at html version 1.5.0 now. Once storage
			// no longer has version 1.5.0 content, we can get rid of
			// this b/c code.
			if (dp.stx_v) {
				// HTML (stx='html') elements will not have the stx_v flag set
				// since the single-row syntax only applies to native-wikitext.
				// So, we can safely override it here.
				dp.stx = dp.stx_v;
			}
		}

		// The following are done only if scrubWikitext flag is enabled
		if (!this.env.scrubWikitext) {
			return node;
		}

		var next;

		if (this.env.conf.parsoid.scrubBidiChars) {
			// Strip bidirectional chars around categories
			// Note that this is being done everywhere,
			// not just in selser mode
			next = this.stripBidiCharsAroundCategories(node);
			if (next !== node) {
				return next;
			}
		}

		// Skip unmodified content
		if (this.inSelserMode && !DOMUtils.isBody(node) &&
			!this.inInsertedContent && !DiffUtils.hasDiffMarkers(node, this.env) &&
			// If orig-src is not valid, this in effect becomes
			// an edited node and needs normalizations applied to it.
			WTSUtils.origSrcValidInEditedContext(this.env, node)) {
			return node;
		}

		// Headings
		if (/^H[1-6]$/.test(node.nodeName)) {
			this.hoistLinks(node, false);
			this.hoistLinks(node, true);
			this.stripBRs(node);
			return this.stripIfEmpty(node);

		// Quote tags
		} else if (Consts.WTQuoteTags.has(node.nodeName)) {
			return this.stripIfEmpty(node);

		// Anchors
		} else if (node.nodeName === 'A') {
			next = DOMUtils.nextNonDeletedSibling(node);
			// We could have checked for !mw:ExtLink but in
			// the case of links without any annotations,
			// the positive test is semantically safer than the
			// negative test.
			if (/^mw:WikiLink$/.test(node.getAttribute('rel') || '') && this.stripIfEmpty(node) !== node) {
				return next;
			}
			this.moveTrailingSpacesOut(node);
			return this.moveFormatTagOutsideATag(node);

		// Table cells
		} else if (node.nodeName === 'TD') {
			dp = DOMDataUtils.getDataParsoid(node);
			// * HTML <td>s won't have escapable prefixes
			// * First cell should always be checked for escapable prefixes
			// * Second and later cells in a wikitext td row (with stx='row' flag)
			//   won't have escapable prefixes.
			if (dp.stx === 'html' ||
				(DOMUtils.firstNonSepChild(node.parentNode) !== node && dp.stx === 'row')) {
				return node;
			}

			var first = DOMUtils.firstNonDeletedChild(node);
			// Emit a space before escapable prefix
			// This is preferable to serializing with a nowiki.
			if (DOMUtils.isText(first) && /^[\-+}]/.test(first.nodeValue)) {
				first.nodeValue = ' ' + first.nodeValue;
				this.addDiffMarks(first, 'inserted', true);
			}
			return node;

		// Font tags without any attributes
		} else if (node.nodeName === 'FONT' && DOMDataUtils.noAttrs(node)) {
			next = DOMUtils.nextNonDeletedSibling(node);
			DOMUtils.migrateChildren(node, node.parentNode, node);
			node.parentNode.removeChild(node);
			return next;

		// T184755: Convert sequences of <p></p> nodes to sequences of
		// <br/>, <p><br/>..other content..</p>, <p><br/><p/> to ensure
		// they serialize to as many newlines as the count of <p></p> nodes.
		} else if (node.nodeName === 'P' && !WTUtils.isLiteralHTMLNode(node) &&
			// Don't normalize empty p-nodes that came from source
			// FIXME: See T210647
			!/\bmw-empty-elt\b/.test(node.getAttribute('class') || '') &&
			// Don't apply normalization to <p></p> nodes that
			// were generated through deletions or other normalizations.
			// FIXME: This trick fails for non-selser mode since
			// diff markers are only added in selser mode.
			DOMUtils.hasNChildren(node, 0, true) &&
			// FIXME: Also, skip if this is the only child.
			// Eliminates spurious test failures in non-selser mode.
			!DOMUtils.hasNChildren(node.parentNode, 1)
		) {
			let brParent, brSibling;
			const br = node.ownerDocument.createElement('br');
			next = DOMUtils.nextNonSepSibling(node);
			if (next && next.nodeName === 'P' && !WTUtils.isLiteralHTMLNode(next)) {
				// Replace 'node' (<p></p>) with a <br/> and make it the
				// first child of 'next' (<p>..</p>). If 'next' was actually
				// a <p></p> (i.e. empty), 'next' becomes <p><br/></p>
				// which will serialize to 2 newlines.
				brParent = next;
				brSibling = next.firstChild;
			} else {
				// We cannot merge the <br/> with 'next' because it
				// is not a <p>..</p>.
				brParent = node.parentNode;
				brSibling = node;
			}

			// Insert <br/>
			brParent.insertBefore(br, brSibling);
			// Avoid nested insertion markers
			if (brParent === next && !isInsertedContent(brParent, this.env)) {
				this.addDiffMarks(br, 'inserted');
			}

			// Delete node
			this.addDiffMarks(node.parentNode, 'deleted');
			node.parentNode.removeChild(node);

			return next;

		// Default
		} else {
			return node;
		}
	}

	normalizeSiblingPair(a, b) {
		if (!rewriteablePair(this.env, a, b)) {
			return b;
		}

		// Since 'a' and 'b' make a rewriteable tag-pair, we are good to go.
		if (mergable(a, b)) {
			a = this.merge(a, b);
			// The new a's children have new siblings. So let's look
			// at a again. But their grandkids haven't changed,
			// so we don't need to recurse further.
			this.processSubtree(a, false);
			return a;
		}

		if (swappable(a, b)) {
			a = this.merge(this.swap(a, DOMUtils.firstNonDeletedChild(a)), b);
			// Again, a has new children, but the grandkids have already
			// been minimized.
			this.processSubtree(a, false);
			return a;
		}

		if (swappable(b, a)) {
			a = this.merge(a, this.swap(b, DOMUtils.firstNonDeletedChild(b)));
			// Again, a has new children, but the grandkids have already
			// been minimized.
			this.processSubtree(a, false);
			return a;
		}

		return b;
	}

	processSubtree(node, recurse) {
		// Process the first child outside the loop.
		var a = DOMUtils.firstNonDeletedChild(node);
		if (!a) {
			return;
		}

		a = this.processNode(a, recurse);
		while (a) {
			// We need a pair of adjacent siblings for tag minimization.
			var b = DOMUtils.nextNonDeletedSibling(a);
			if (!b) {
				return;
			}

			// Process subtree rooted at 'b'.
			b = this.processNode(b, recurse);

			// If we skipped over a bunch of nodes in the middle,
			// we no longer have a pair of adjacent siblings.
			if (b && DOMUtils.previousNonDeletedSibling(b) === a) {
				// Process the pair.
				a = this.normalizeSiblingPair(a, b);
			} else {
				a = b;
			}
		}
	}

	processNode(node, recurse) {
		// Normalize 'node' and the subtree rooted at 'node'
		// recurse = true  => recurse and normalize subtree
		// recurse = false => assume the subtree is already normalized

		// Normalize node till it stabilizes
		var next;
		while (true) {  // eslint-disable-line
			// Skip templated content
			while (node && WTUtils.isFirstEncapsulationWrapperNode(node)) {
				node = WTUtils.skipOverEncapsulatedContent(node);
			}

			if (!node) {
				return null;
			}

			// Set insertion marker
			var insertedSubtree = DiffUtils.hasInsertedDiffMark(node, this.env);
			if (insertedSubtree) {
				if (this.inInsertedContent) {
					// Dump debugging info
					console.warn("--- Nested inserted dom-diff flags ---");
					console.warn("Node:", DOMUtils.isElt(node) ? ContentUtils.ppToXML(node) : node.textContent);
					console.warn("Node's parent:", ContentUtils.ppToXML(node.parentNode));
					ContentUtils.dumpDOM(node.ownerDocument.body,
						'-- DOM triggering nested inserted dom-diff flags --',
						{ storeDiffMark: true, env: this.env });
				}
				// FIXME: If this assert is removed, the above dumping code should
				// either be removed OR fixed up to remove uses of ContentUtils.ppToXML
				console.assert(!this.inInsertedContent, 'Found nested inserted dom-diff flags!');
				this.inInsertedContent = true;
			}

			// Post-order traversal: Process subtree first, and current node after.
			// This lets multiple normalizations take effect cleanly.
			if (recurse && DOMUtils.isElt(node)) {
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

		console.assert(false, "Control should never get here!");  // eslint-disable-line
	}

	normalize(body) {
		return this.processNode(body, true);
	}
}

if (typeof module === 'object') {
	module.exports.DOMNormalizer = DOMNormalizer;
}
