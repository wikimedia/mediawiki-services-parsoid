/** @module */

'use strict';

require('../../../../core-upgrade.js');

const { DOMDataUtils } = require('../../../utils/DOMDataUtils.js');
const { DOMUtils } = require('../../../utils/DOMUtils.js');
const { WTUtils } = require('../../../utils/WTUtils.js');

// These nodes either end a line in wikitext (tr, li, dd, ol, ul, dl, caption,
// p) or have implicit closing tags that can leak newlines to those that end a
// line (th, td)
//
// SSS FIXME: Given condition 2, we may not need to check th/td anymore
// (if we can rely on auto inserted start/end tags being present always).
const nodesToMigrateFrom = new Set([
	'PRE', 'TH', 'TD', 'TR', 'LI', 'DD', 'OL', 'UL', 'DL', 'CAPTION', 'P',
]);

class MigrateTrailingNLs {
	nodeEndsLineInWT(node, dp) {
		return nodesToMigrateFrom.has(node.nodeName) && !WTUtils.hasLiteralHTMLMarker(dp);
	}

	getTableParent(node) {
		if (/^(TD|TH)$/.test(node.nodeName)) { node = node.parentNode; }
		if (node.nodeName === 'TR') { node = node.parentNode; }
		if (/^(TBODY|THEAD|TFOOT|CAPTION)$/.test(node.nodeName)) { node = node.parentNode; }
		return node.nodeName === 'TABLE' ? node : null;
	}

	// We can migrate a newline out of a node if one of the following is true:
	// (1) The node ends a line in wikitext (=> not a literal html tag)
	// (2) The node has an auto-closed end-tag (wikitext-generated or literal html tag)
	//     and hasn't been fostered out of a table.
	// (3) It is the rightmost node in the DOM subtree rooted at a node
	//     that ends a line in wikitext
	canMigrateNLOutOfNode(node) {
		if (!node || node.nodeName === 'TABLE' || node.nodeName === 'BODY') {
			return false;
		}

		// Don't allow migration out of a table if the table has had
		// content fostered out of it.
		var tableParent = this.getTableParent(node);
		if (tableParent && DOMUtils.isElt(tableParent.previousSibling) &&
			DOMDataUtils.getDataParsoid(tableParent.previousSibling).fostered) {
			return false;
		}

		var dp = DOMDataUtils.getDataParsoid(node);
		return !dp.fostered && (this.nodeEndsLineInWT(node, dp) || dp.autoInsertedEnd ||
			(!node.nextSibling && this.canMigrateNLOutOfNode(node.parentNode)));
	}

	// A node has zero wt width if:
	// - tsr[0] == tsr[1]
	// - only has children with zero wt width
	hasZeroWidthWT(node) {
		var tsr = DOMDataUtils.getDataParsoid(node).tsr;
		if (!tsr || tsr[0] === null || tsr[0] !== tsr[1]) {
			return false;
		}

		var c = node.firstChild;
		while (c && DOMUtils.isElt(c) && this.hasZeroWidthWT(c)) {
			c = c.nextSibling;
		}

		return c === null;
	}

	/**
	 */
	migrateTrailingNLs(elt, env) {
		// Nothing to do for text and comment nodes
		if (!DOMUtils.isElt(elt)) {
			return;
		}

		// 1. Process DOM rooted at 'elt' first
		//
		// Process children backward so that a table
		// is processed before its fostered content.
		// See subtle changes in newline migration with this wikitext:
		//     "<table>\n<tr> || ||\n<td> a\n</table>"
		// when walking backward vs. forward.
		//
		// Separately, walking backward also lets us ingore
		// newly added children after child (because of
		// migrated newline nodes from child's DOM tree).
		var child = elt.lastChild;
		while (child !== null) {
			this.migrateTrailingNLs(child, env);
			child = child.previousSibling;
		}

		// 2. Process 'elt' itself after -- skip literal-HTML nodes
		if (this.canMigrateNLOutOfNode(elt)) {
			var firstEltToMigrate = null;
			var migrationBarrier = null;
			var partialContent = false;
			var n = elt.lastChild;

			// We can migrate trailing newlines across nodes that have zero-wikitext-width.
			while (n && DOMUtils.isElt(n) && this.hasZeroWidthWT(n)) {
				migrationBarrier = n;
				n = n.previousSibling;
			}

			// Find nodes that need to be migrated out:
			// - a sequence of comment and newline nodes that is preceded by
			//   a non-migratable node (text node with non-white-space content
			//   or an element node).
			var foundNL = false;
			var tsrCorrection = 0;
			while (n && (DOMUtils.isText(n) || DOMUtils.isComment(n))) {
				if (DOMUtils.isComment(n)) {
					firstEltToMigrate = n;
					// <!--comment-->
					tsrCorrection += WTUtils.decodedCommentLength(n);
				} else {
					if (n.data.match(/^[ \t\r\n]*\n[ \t\r\n]*$/)) {
						foundNL = true;
						firstEltToMigrate = n;
						partialContent = false;
						// all whitespace is moved
						tsrCorrection += n.data.length;
					} else if (n.data.match(/\n$/)) {
						foundNL = true;
						firstEltToMigrate = n;
						partialContent = true;
						// only newlines moved
						tsrCorrection += n.data.match(/\n+$/)[0].length;
						break;
					} else {
						break;
					}
				}

				n = n.previousSibling;
			}

			if (firstEltToMigrate && foundNL) {
				var eltParent = elt.parentNode;
				var insertPosition = elt.nextSibling;

				// A marker meta-tag for an end-tag carries TSR information for the tag.
				// It is important not to separate them by inserting content since that
				// will affect accuracy of DSR computation for the end-tag as follows:
				//    end_tag.dsr[1] = marker_meta.tsr[0] - inserted_content.length
				// But, that is incorrect since end_tag.dsr[1] should be marker_meta.tsr[0]
				//
				// So, if the insertPosition is in between an end-tag and
				// its marker meta-tag, move past that marker meta-tag.
				if (insertPosition
					&& DOMUtils.isMarkerMeta(insertPosition, 'mw:EndTag')
					&& insertPosition.getAttribute('data-etag') === elt.nodeName.toLowerCase()) {
					insertPosition = insertPosition.nextSibling;
				}

				n = firstEltToMigrate;
				while (n !== migrationBarrier) {
					var next = n.nextSibling;
					if (partialContent) {
						var nls = n.data;
						n.data = n.data.replace(/\n+$/, '');
						nls = nls.substring(n.data.length);
						n = n.ownerDocument.createTextNode(nls);
						partialContent = false;
					}
					eltParent.insertBefore(n, insertPosition);
					n = next;
				}

				// Adjust tsr of any nodes after migrationBarrier.
				// Ex: zero-width nodes that have valid tsr on them
				// By definition (zero-width), these are synthetic nodes added by Parsoid
				// that aren't present in the original wikitext.
				n = migrationBarrier;
				while (n) {
					// TSR is guaranteed to exist and be valid
					// (checked by hasZeroWidthWT above)
					var dp = DOMDataUtils.getDataParsoid(n);
					dp.tsr[0] -= tsrCorrection;
					dp.tsr[1] -= tsrCorrection;
					n = n.nextSibling;
				}
			}
		}
	}

	run(node, env, opts) {
		this.migrateTrailingNLs(node, env);
	}
}

if (typeof module === 'object') {
	module.exports.MigrateTrailingNLs = MigrateTrailingNLs;
}
