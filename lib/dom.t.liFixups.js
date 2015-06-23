'use strict';

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;


/*
 * For the following wikitext (called the "LI hack"):
 *
 *     * <li class="..."> foo
 *
 * the Parsoid parser, pre-post processing generates something like
 *
 *     <li></li><li class="...">foo</li>
 *
 * This visitor deletes such spurious '<li>'s to match the output of
 * the PHP parser.
 *
 * However, note that the wikitext '<li></li>', any preceding wikitext
 * asterisk '*' absent, should indeed expand into two nodes in the
 * DOM.
 */
function handleLIHack(node, env) {
	var prevNode = node.previousSibling;

	if (DU.isLiteralHTMLNode(node) &&
		prevNode !== null &&
		prevNode.nodeName === 'LI' &&
		!DU.isLiteralHTMLNode(prevNode) &&
		DU.nodeEssentiallyEmpty(prevNode)) {

		var dp = DU.getDataParsoid(node);
		var typeOf = node.getAttribute('typeof') || '';
		var liHackSrc = DU.getWTSource(env, prevNode);

		if ( /(?:^|\s)mw:Transclusion(?=$|\s)/.test( typeOf ) ) {
			var dataMW = DU.getDataMw( node );
			dataMW.parts.unshift( liHackSrc );
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
		var prevNodeDSR = DU.getDataParsoid(prevNode).dsr;

		if (nodeDSR && prevNodeDSR) {
			dp.dsr = [
				prevNodeDSR[0],
				nodeDSR[1],
				nodeDSR[2] + prevNodeDSR[1] - prevNodeDSR[0],
				nodeDSR[3]
			];
		}

		// Delete the duplicated <li> node.
		DU.deleteNode(prevNode);
	}

	return true;
}

/**
 * Earlier in the parsing pipeline, we suppress all newlines
 * and other whitespace before categories which causes category
 * links to be swallowed into preceding paragraphs and list items.
 *
 * However, with wikitext like this: "*a\n\n[[Category:Foo]]", this
 * could prevent proper roundtripping (because we suppress newlines
 * when serializing list items). This needs addressing because
 * this pattern is extremely common (some list at the end of the page
 * followed by a list of categories for the page).
 */
function migrateTrailingCategories(li, env, atTopLevel, tplInfo) {
	// * Run this pass when processing the full page only (atTopLevel)
	// * Don't bother fixing up template content when processing the full page
	if (!atTopLevel || tplInfo) {
		return true;
	}

	// If:
	// * the last list-item of a list has a swallowed category as its last child,
	// * the list-item has a \n in its text content,
	// * the category is not part of a template,
	// then
	// * migrate the categories out of the outermost list
	// * and fix up the DSR of list items and list along the rightmost path.
	if (li.nextSibling === null &&
		DU.isList(li.parentNode) &&
		li.lastChild && DU.isCategoryLink(li.lastChild) &&
		!DU.isTplOrExtToplevelNode(li.lastChild) &&
		/\n/.test(li.textContent)) {

		// Find the outermost list
		var outerList = li.parentNode;
		while (DU.isListItem(outerList.parentNode)) {
			var p = outerList.parentNode;
			// Bail if we find ourself on a path that is not the rightmost path.
			if (p.nextSibling !== null) {
				return true;
			}
			outerList = p.parentNode;
		}

		var c = li.lastChild;
		var liDsr = DU.getDataParsoid(li).dsr;
		var newEndDsr = liDsr ? liDsr[1] : null;
		while (true) {
			if (DU.isElt(c)) {
				// Category
				var dsr = DU.getDataParsoid(c).dsr;
				newEndDsr = dsr ? dsr[0] : null;
			} else if (newEndDsr) {
				// Plain-text
				newEndDsr -= c.data.length;
			}
			outerList.parentNode.insertBefore(c, outerList.nextSibling);
			c = li.lastChild;

			// Continue migrating trailing categories
			if (c && DU.isCategoryLink(c)) {
				continue;
			}

			if (!c || !DU.isText(c) || !/\n\s*$/.test(c.nodeValue)) {
				break;
			}

			if (!/^\s*$/.test(c.nodeValue)) {
				// Split off the newlines into its own node and migrate it
				var nls = c.data;
				c.data = c.data.replace(/\s+$/, '');
				nls = nls.substring(c.data.length);
				c = c.ownerDocument.createTextNode(nls);
				outerList.parentNode.insertBefore(c, outerList.nextSibling);
				if (newEndDsr) {
					newEndDsr -= nls.length;
				}
				break;
			}
		}

		// Update DSR of all listitem & list nodes till
		// we hit the outermost list we started with.
		var delta;
		if (liDsr) {
			delta = newEndDsr ? liDsr[1] - newEndDsr : null;
		}

		// If there is no delta to adjust dsr by, we are done
		if (!delta) {
			return true;
		}

		// Fix DSR along the rightmost path to outerList
		var list;
		while (outerList !== list) {
			list = li.parentNode;
			liDsr = DU.getDataParsoid(li).dsr;
			if (liDsr) {
				liDsr[1] = liDsr[1] - delta;
			}

			var listDsr = DU.getDataParsoid(list).dsr;
			if (listDsr) {
				listDsr[1] = listDsr[1] - delta;
			}
			li = list.parentNode;
		}
	}

	return true;
}

if (typeof module === "object") {
	module.exports.handleLIHack = handleLIHack;
	module.exports.migrateTrailingCategories = migrateTrailingCategories;
}
