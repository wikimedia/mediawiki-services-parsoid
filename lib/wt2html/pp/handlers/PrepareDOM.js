/** @module */

'use strict';

const { DOMDataUtils } = require('../../../utils/DOMDataUtils.js');
const { DOMUtils } = require('../../../utils/DOMUtils.js');
const { Util } = require('../../../utils/Util.js');
const { WTUtils } = require('../../../utils/WTUtils.js');

class PrepareDOM {
	/**
	 * Migrate data-parsoid attributes into a property on each DOM node.
	 * We may migrate them back in the final DOM traversal.
	 *
	 * Various mw metas are converted to comments before the tree build to
	 * avoid fostering. Piggy-backing the reconversion here to avoid excess
	 * DOM traversals.
	 */
	static prepareDOM(seenDataIds, node, env) {
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
			return true;
		}
		const meta = WTUtils.reinsertFosterableContent(env, node, false);
		return meta !== null ? meta : true;
	}
}

if (typeof module === 'object') {
	module.exports.PrepareDOM = PrepareDOM;
}
