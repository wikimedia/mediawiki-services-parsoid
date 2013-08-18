var DU = require('./mediawiki.DOMUtils.js').DOMUtils;


/**
 * DOM visitor that strips the double td for this test case:
 * |{{echo|{{!}} Foo}}
 *
 * See https://bugzilla.wikimedia.org/show_bug.cgi?id=50603
 */
function stripDoubleTDs (env, node) {
	var nextNode = node.nextSibling;

	if (!DU.isLiteralHTMLNode(node) &&
		nextNode !== null &&
	    nextNode.nodeName === 'TD' &&
	    !DU.isLiteralHTMLNode(nextNode) &&
		// FIXME: will not be set for nested templates
		DU.isEncapsulatedElt(nextNode) &&
	    DU.nodeEssentiallyEmpty(node))
	{
		// Update the dsr. Since we are coalescing the first
		// node with the second (or, more precisely, deleting
		// the first node), we have to update the second DSR's
		// starting point and start tag width.
		var nodeDSR     = node.data.parsoid.dsr,
		    nextNodeDSR = nextNode.data.parsoid.dsr;

		if (nodeDSR && nextNodeDSR) {
			nextNodeDSR[0] = nodeDSR[0];
		}

		// Now update data-mw
		// XXX: use data.mw for data-mw as well!
		var dataMW = DU.getJSONAttribute(nextNode, 'data-mw'),
			nodeSrc = DU.getWTSource(env, node);

		if (!dataMW.parts) {
			dataMW.parts = [
				nodeSrc,
				{
					// XXX: Should we always use parts or at least the
					// template wrapper? This will need to be updated whenever
					// we change the template info.
					template: {
						target: dataMW.target,
						params: dataMW.params,
						i: 0
					}
				}
			];
			dataMW.target = undefined;
			dataMW.params = undefined;
		} else {
			dataMW.parts.unshift(nodeSrc);
		}
		DU.setJSONAttribute(nextNode, 'data-mw', dataMW);

		// Delete the duplicated <td> node.
		node.parentNode.removeChild(node);
		// This node was deleted, so don't continue processing on it.
		return nextNode;
	}

	return true;
}

if (typeof module === "object") {
	module.exports.stripDoubleTDs = stripDoubleTDs;
}
