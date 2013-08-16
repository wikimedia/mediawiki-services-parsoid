"use strict";

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
function handleLIHack(env, node) {
	var prevNode = node.previousSibling;

	/* Does `node` contain nothing or just non-newline whitespace? */
	function nodeEssentiallyEmpty(node) {
		var childNodes = node.childNodes;
		if (0 === childNodes.length) {
			return true;
		} else if (childNodes.length > 1) {
			return false;
		} else {
			var child = childNodes[0];
			return (child.nodeName === "#text" &&
				/^[ \t]*$/.test(child.nodeValue));
		}
	}

	if (DU.isLiteralHTMLNode(node) &&
	    prevNode !== null &&
	    prevNode.nodeName === 'LI' &&
	    !DU.isLiteralHTMLNode(prevNode) &&
	    nodeEssentiallyEmpty(prevNode)) {
		// We have to store the extra information in order to
		// reconstruct the original source for roundtripping.
		node.data.parsoid.liHackSrc = DU.getWTSource(env, prevNode);

		// Update the dsr. Since we are coalescing the first
		// node with the second (or, more precisely, deleting
		// the first node), we have to update the second DSR's
		// starting point and start tag width.
		var nodeDSR     = node.data.parsoid.dsr,
		    prevNodeDSR = prevNode.data.parsoid.dsr;

		if (nodeDSR && prevNodeDSR) {
			node.data.parsoid.dsr = [ prevNodeDSR[0],
						  nodeDSR[1],
						  nodeDSR[2] + prevNodeDSR[1] - prevNodeDSR[0],
						  nodeDSR[3] ];
		}

		// Delete the duplicated <li> node.
		DU.deleteNode(prevNode);
	}

	return true;
}

if (typeof module === "object") {
	module.exports.handleLIHack = handleLIHack;
}
