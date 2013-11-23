"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	JSUtils = require('./jsutils.js').JSUtils;


// These nodes either end a line in wikitext (tr, li, dd, ol, ul, dl, caption,
// p) or have implicit closing tags that can leak newlines to those that end a
// line (th, td)
//
// SSS FIXME: Given condition 2, we may not need to check th/td anymore
// (if we can rely on auto inserted start/end tags being present always).
var nodesToMigrateFrom = JSUtils.arrayToSet([
	"PRE", "TH", "TD", "TR", "LI", "DD", "OL", "UL", "DL", "CAPTION", "P"
]);

function nodeEndsLineInWT(node) {
	return nodesToMigrateFrom.has( node.nodeName ) && !DU.isLiteralHTMLNode( node );
}

function migrateTrailingNLs(elt, env) {

	// We can migrate a newline out of a node if one of the following is true:
	// (1) The node ends a line in wikitext (=> not a literal html tag)
	// (2) The node has an auto-closed end-tag (wikitext-generated or literal html tag)
	// (3) It is the rightmost node in the DOM subtree rooted at a node
	//     that ends a line in wikitext
	function canMigrateNLOutOfNode(node) {
		return node && (
			nodeEndsLineInWT(node) ||
			(DU.isElt(node) && DU.getDataParsoid( node ).autoInsertedEnd) ||
			(!node.nextSibling && canMigrateNLOutOfNode(node.parentNode))
		);
	}

	// A node has zero wt width if:
	// - tsr[0] == tsr[1]
	// - only has children with zero wt width
	function hasZeroWidthWT(node) {
		var tsr = DU.getDataParsoid( node ).tsr;
		if (!tsr || tsr[0] === null || tsr[0] !== tsr[1]) {
			return false;
		}

		var c = node.firstChild;
		while (c && DU.isElt(c) && hasZeroWidthWT(c)) {
			c = c.nextSibling;
		}

		return c === null;
	}

	// 1. Process DOM rooted at 'elt' first
	var children = elt.childNodes;
	for (var i = 0; i < children.length; i++) {
		migrateTrailingNLs(children[i], env);
	}

	// 2. Process 'elt' itself after -- skip literal-HTML nodes
	if (canMigrateNLOutOfNode(elt)) {
		var firstEltToMigrate = null,
			migrationBarrier = null,
			partialContent = false,
			n = elt.lastChild;

		// We can migrate trailing newlines across nodes that have zero-wikitext-width.
		while (n && DU.isElt(n) && hasZeroWidthWT(n)) {
			migrationBarrier = n;
			n = n.previousSibling;
		}

		// Find nodes that need to be migrated out:
		// - a sequence of comment and newline nodes that is preceded by
		//   a non-migratable node (text node with non-white-space content
		//   or an element node).
		var foundNL = false;
		while (n && (n.nodeType === n.TEXT_NODE || n.nodeType === n.COMMENT_NODE)) {
			if (n.nodeType === n.COMMENT_NODE) {
				firstEltToMigrate = n;
			} else {
				if (n.data.match(/^\s*\n\s*$/)) {
					foundNL = true;
					firstEltToMigrate = n;
					partialContent = false;
				} else if (n.data.match(/\n$/)) {
					foundNL = true;
					firstEltToMigrate = n;
					partialContent = true;
					break;
				} else {
					break;
				}
			}

			n = n.previousSibling;
		}

		if (firstEltToMigrate && foundNL) {
			var eltParent = elt.parentNode,
				insertPosition = elt.nextSibling;

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
		}
	}
}

if (typeof module === "object") {
	module.exports.migrateTrailingNLs = migrateTrailingNLs;
}
