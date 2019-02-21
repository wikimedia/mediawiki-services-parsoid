/** @module */

'use strict';

var DOMDataUtils = require('../../../utils/DOMDataUtils.js').DOMDataUtils;
var DOMUtils = require('../../../utils/DOMUtils.js').DOMUtils;
var Util = require('../../../utils/Util.js').Util;

/**
 * Migrate data-parsoid attributes into a property on each DOM node.
 * We may migrate them back in the final DOM traversal.
 *
 * Various mw metas are converted to comments before the tree build to
 * avoid fostering. Piggy-backing the reconversion here to avoid excess
 * DOM traversals.
 */
function prepareDOM(seenDataIds, node, env) {
	if (DOMUtils.isElt(node)) {
		// Deduplicate docIds that come from splitting nodes because of
		// content model violations when treebuilding.
		const docId = node.getAttribute(DOMDataUtils.DataObjectAttrName());
		if (docId !== null) {
			if (seenDataIds.has(docId)) {
				const data = DOMDataUtils.getNodeData(node);
				DOMDataUtils.setNodeData(node, Util.clone(data, true));
			} else {
				seenDataIds.add(docId);
			}
		}
		// Set title to display when present (last one wins).
		if (node.nodeName === "META" &&
				node.getAttribute("property") === "mw:PageProp/displaytitle") {
			env.page.meta.displayTitle = node.getAttribute("content");
		}
	} else if (DOMUtils.isComment(node) && /^\{[^]+\}$/.test(node.data)) {
		// Convert serialized meta tags back from comments.
		// We use this trick because comments won't be fostered,
		// providing more accurate information about where tags are expected
		// to be found.
		var data, type;
		try {
			data = JSON.parse(node.data);
			type = data["@type"];
		} catch (e) {
			// not a valid json attribute, do nothing
			return true;
		}
		if (/^mw:/.test(type)) {
			var meta = node.ownerDocument.createElement("meta");
			data.attrs.forEach(function(attr) {
				try {
					meta.setAttribute(attr.nodeName, attr.nodeValue);
				} catch (e) {
					env.log("warn", "prepareDOM: Dropped invalid attribute",
						attr.nodeName);
				}
			});
			node.parentNode.replaceChild(meta, node);
			return meta;
		}

	}
	return true;
}

if (typeof module === 'object') {
	module.exports.prepareDOM = prepareDOM;
}
