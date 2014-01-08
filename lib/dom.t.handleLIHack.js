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

	if (DU.isLiteralHTMLNode(node) &&
	    prevNode !== null &&
	    prevNode.nodeName === 'LI' &&
	    !DU.isLiteralHTMLNode(prevNode) &&
	    DU.nodeEssentiallyEmpty(prevNode)) {

		var dp = DU.getDataParsoid( node );

		// We have to store the extra information in order to
		// reconstruct the original source for roundtripping.
		dp.liHackSrc = DU.getWTSource(env, prevNode);

		// Update the dsr. Since we are coalescing the first
		// node with the second (or, more precisely, deleting
		// the first node), we have to update the second DSR's
		// starting point and start tag width.
		var nodeDSR     = dp.dsr,
		    prevNodeDSR = DU.getDataParsoid( prevNode ).dsr;

		if (nodeDSR && prevNodeDSR) {
			dp.dsr = [ prevNodeDSR[0],
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
