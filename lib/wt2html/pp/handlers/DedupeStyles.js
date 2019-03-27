/** @module */

'use strict';

const { DOMDataUtils } = require('../../../utils/DOMDataUtils.js');
const { DOMUtils } = require('../../../utils/DOMUtils.js');

class DedupeStyles {
	static dedupe(node, env) {
		if (!env.styleTagKeys) {
			env.styleTagKeys = new Set();
		}

		if (!node.hasAttribute('data-mw-deduplicate')) {
			// Not a templatestyles <style> tag
			return true;
		}
		const key = node.getAttribute('data-mw-deduplicate');

		if (!env.styleTagKeys.has(key)) {
			// Not a dupe
			env.styleTagKeys.add(key);
			return true;
		}

		if (!DOMUtils.isFosterablePosition(node)) {
			// Dupe - replace with a placeholder <link> reference
			const link = node.ownerDocument.createElement('link');
			link.setAttribute('rel', 'mw-deduplicated-inline-style');
			link.setAttribute('href', 'mw-data:' + key);
			link.setAttribute('about', node.getAttribute('about'));
			link.setAttribute('typeof', node.getAttribute('typeof'));
			DOMDataUtils.setDataParsoid(link, DOMDataUtils.getDataParsoid(node));
			DOMDataUtils.setDataMw(link, DOMDataUtils.getDataMw(node));
			node.parentNode.replaceChild(link, node);
			return link;
		} else {
			env.log("info/wt2html/templatestyle",
				"Duplicate style tag found in fosterable position. " +
				"Not deduping it, but emptying out the style tag for performance reasons.");
			node.innerHTML = '';
			return true;
		}
	}
}

if (typeof module === 'object') {
	module.exports.DedupeStyles = DedupeStyles;
}
