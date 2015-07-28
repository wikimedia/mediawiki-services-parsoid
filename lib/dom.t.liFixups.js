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

		if (/(?:^|\s)mw:Transclusion(?=$|\s)/.test(typeOf)) {
			var dataMW = DU.getDataMw(node);
			dataMW.parts.unshift(liHackSrc);
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
				nodeDSR[3],
			];
		}

		// Delete the duplicated <li> node.
		DU.deleteNode(prevNode);
	}

	return true;
}

function getMigrationInfo(c) {
	var tplRoot = DU.findFirstEncapsulationWrapperNode(c);
	if (tplRoot !== null) {
		// Check if everything between tplRoot and c is migratable.
		var prev = tplRoot.previousSibling;
		while (c !== prev) {
			if (!DU.isCategoryLink(c) &&
				!(c.nodeName === 'SPAN' && /^\s*$/.test(c.textContent))) {
				return { tplRoot: tplRoot, migratable: false };
			}

			c = c.previousSibling;
		}
	}

	return { tplRoot: tplRoot, migratable: true };
}

function findLastMigratableNode(li) {
	var sentinel = null;
	var c = li.lastChild;
	// c is known to be a category link.
	// fail fast in parser tests if something changes.
	console.assert(DU.isCategoryLink(c));
	while (c) {
		// Handle template units first
		var info = getMigrationInfo(c);
		if (!info.migratable) {
			break;
		} else if (info.tplRoot !== null) {
			c = info.tplRoot;
		}

		if (DU.isText(c)) {
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
		} else if (!DU.isCategoryLink(c)) {
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

	// If there is migratable content inside a list item
	// (categories preceded by newlines),
	// * migrate it out of the outermost list
	// * and fix up the DSR of list items and list along the rightmost path.
	if (li.nextSibling === null && DU.isList(li.parentNode) &&
		li.lastChild && DU.isCategoryLink(li.lastChild)) {

		// Find the outermost list -- content will be moved after it
		var outerList = li.parentNode;
		while (DU.isListItem(outerList.parentNode)) {
			var p = outerList.parentNode;
			// Bail if we find ourself on a path that is not the rightmost path.
			if (p.nextSibling !== null) {
				return true;
			}
			outerList = p.parentNode;
		}

		// Find last migratable node
		var sentinel = findLastMigratableNode(li);
		if (!sentinel) {
			return true;
		}

		// Migrate (and update DSR)
		var c = li.lastChild;
		var liDsr = DU.getDataParsoid(li).dsr;
		var newEndDsr = -1; // dummy to eliminate useless null checks
		while (true) {
			if (DU.isElt(c)) {
				var dsr = DU.getDataParsoid(c).dsr;
				newEndDsr = dsr ? dsr[0] : -1;
				outerList.parentNode.insertBefore(c, outerList.nextSibling);
			} else if (DU.isText(c)) {
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
