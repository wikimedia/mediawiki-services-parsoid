/** @module */

'use strict';

const { DOMDataUtils } = require('../../../utils/DOMDataUtils.js');
const { DOMUtils } = require('../../../utils/DOMUtils.js');
const { WTUtils } = require('../../../utils/WTUtils.js');

class LiFixups {
	/**
	 * For the following wikitext (called the "LI hack"):
	 * ```
	 *     * <li class="..."> foo
	 * ```
	 * the Parsoid parser, pre-post processing generates something like
	 * ```
	 *     <li></li><li class="...">foo</li>
	 * ```
	 * This visitor deletes such spurious `<li>`s to match the output of
	 * the PHP parser.
	 *
	 * However, note that the wikitext `<li></li>`, any preceding wikitext
	 * asterisk `*` absent, should indeed expand into two nodes in the
	 * DOM.
	 */
	static handleLIHack(node, env) {
		var prevNode = node.previousSibling;

		if (WTUtils.isLiteralHTMLNode(node) &&
			prevNode !== null &&
			prevNode.nodeName === 'LI' &&
			!WTUtils.isLiteralHTMLNode(prevNode) &&
			DOMUtils.nodeEssentiallyEmpty(prevNode)) {

			var dp = DOMDataUtils.getDataParsoid(node);
			var typeOf = node.getAttribute('typeof') || '';
			var liHackSrc = WTUtils.getWTSource(env.topFrame, prevNode);

			if (/(?:^|\s)mw:Transclusion(?=$|\s)/.test(typeOf)) {
				var dataMW = DOMDataUtils.getDataMw(node);
				if (dataMW.parts) { dataMW.parts.unshift(liHackSrc); }
			} else {
				// We have to store the extra information in order to
				// reconstruct the original source for roundtripping.
				dp.liHackSrc = liHackSrc;
			}

			// Update the dsr. Since we are coalescing the first
			// node with the second (or, more precisely, deleting
			// the first node), we have to update the second DSR's
			// starting point and start tag width.
			var nodeDSR = dp.dsr;
			var prevNodeDSR = DOMDataUtils.getDataParsoid(prevNode).dsr;

			if (nodeDSR && prevNodeDSR) {
				dp.dsr = [
					prevNodeDSR[0],
					nodeDSR[1],
					nodeDSR[2] + prevNodeDSR[1] - prevNodeDSR[0],
					nodeDSR[3],
				];
			}

			// Delete the duplicated <li> node.
			prevNode.parentNode.removeChild(prevNode);
		}

		return true;
	}

	static getMigrationInfo(c) {
		var tplRoot = WTUtils.findFirstEncapsulationWrapperNode(c);
		if (tplRoot !== null) {
			// Check if everything between tplRoot and c is migratable.
			var prev = tplRoot.previousSibling;
			while (c !== prev) {
				if (!WTUtils.isCategoryLink(c) &&
					!(c.nodeName === 'SPAN' && /^\s*$/.test(c.textContent))) {
					return { tplRoot: tplRoot, migratable: false };
				}

				c = c.previousSibling;
			}
		}

		return { tplRoot: tplRoot, migratable: true };
	}

	static findLastMigratableNode(li) {
		var sentinel = null;
		var c = DOMUtils.lastNonSepChild(li);
		// c is known to be a category link.
		// fail fast in parser tests if something changes.
		console.assert(WTUtils.isCategoryLink(c));
		while (c) {
			// Handle template units first
			var info = LiFixups.getMigrationInfo(c);
			if (!info.migratable) {
				break;
			} else if (info.tplRoot !== null) {
				c = info.tplRoot;
			}

			if (DOMUtils.isText(c)) {
				// Update sentinel if we hit a newline.
				// We want to migrate these newlines and
				// everything following them out of 'li'.
				if (/\n\s*$/.test(c.nodeValue)) {
					sentinel = c;
				}

				// If we didn't hit pure whitespace, we are done!
				if (!/^\s*$/.test(c.nodeValue)) {
					break;
				}
			} else if (DOMUtils.isComment(c)) {
				sentinel = c;
			} else if (!WTUtils.isCategoryLink(c)) {
				// We are done if we hit anything but text
				// or category links.
				break;
			}

			c = c.previousSibling;
		}

		return sentinel;
	}

	/**
	 * Earlier in the parsing pipeline, we suppress all newlines
	 * and other whitespace before categories which causes category
	 * links to be swallowed into preceding paragraphs and list items.
	 *
	 * However, with wikitext like this: `*a\n\n[[Category:Foo]]`, this
	 * could prevent proper roundtripping (because we suppress newlines
	 * when serializing list items). This needs addressing because
	 * this pattern is extremely common (some list at the end of the page
	 * followed by a list of categories for the page).
	 */
	static migrateTrailingCategories(li, env, unused, tplInfo) {
		// * Don't bother fixing up template content when processing the full page
		if (tplInfo) {
			return true;
		}

		// If there is migratable content inside a list item
		// (categories preceded by newlines),
		// * migrate it out of the outermost list
		// * and fix up the DSR of list items and list along the rightmost path.
		if (li.nextSibling === null && DOMUtils.isList(li.parentNode) &&
			WTUtils.isCategoryLink(DOMUtils.lastNonSepChild(li))) {

			// Find the outermost list -- content will be moved after it
			var outerList = li.parentNode;
			while (DOMUtils.isListItem(outerList.parentNode)) {
				var p = outerList.parentNode;
				// Bail if we find ourself on a path that is not the rightmost path.
				if (p.nextSibling !== null) {
					return true;
				}
				outerList = p.parentNode;
			}

			// Find last migratable node
			var sentinel = LiFixups.findLastMigratableNode(li);
			if (!sentinel) {
				return true;
			}

			// Migrate (and update DSR)
			var c = li.lastChild;
			var liDsr = DOMDataUtils.getDataParsoid(li).dsr;
			var newEndDsr = -1; // dummy to eliminate useless null checks
			while (true) {  // eslint-disable-line
				if (DOMUtils.isElt(c)) {
					var dsr = DOMDataUtils.getDataParsoid(c).dsr;
					newEndDsr = dsr ? dsr[0] : -1;
					outerList.parentNode.insertBefore(c, outerList.nextSibling);
				} else if (DOMUtils.isText(c)) {
					if (/^\s*$/.test(c.nodeValue)) {
						newEndDsr -= c.data.length;
						outerList.parentNode.insertBefore(c, outerList.nextSibling);
					} else {
						// Split off the newlines into its own node and migrate it
						var nls = c.data;
						c.data = c.data.replace(/\s+$/, '');
						nls = nls.substring(c.data.length);
						var nlNode = c.ownerDocument.createTextNode(nls);
						outerList.parentNode.insertBefore(nlNode, outerList.nextSibling);
						newEndDsr -= nls.length;
					}
				} else if (DOMUtils.isComment(c)) {
					newEndDsr -= WTUtils.decodedCommentLength(c);
					outerList.parentNode.insertBefore(c, outerList.nextSibling);
				}

				if (c === sentinel) {
					break;
				}

				c = li.lastChild;
			}

			// Update DSR of all listitem & list nodes till
			// we hit the outermost list we started with.
			var delta;
			if (liDsr && newEndDsr >= 0) {
				delta = liDsr[1] - newEndDsr;
			}

			// If there is no delta to adjust dsr by, we are done
			if (!delta) {
				return true;
			}

			// Fix DSR along the rightmost path to outerList
			var list;
			while (outerList !== list) {
				list = li.parentNode;
				liDsr = DOMDataUtils.getDataParsoid(li).dsr;
				if (liDsr) {
					liDsr[1] -= delta;
				}

				var listDsr = DOMDataUtils.getDataParsoid(list).dsr;
				if (listDsr) {
					listDsr[1] -= delta;
				}
				li = list.parentNode;
			}
		}

		return true;
	}
}

if (typeof module === "object") {
	module.exports.LiFixups = LiFixups;
}
