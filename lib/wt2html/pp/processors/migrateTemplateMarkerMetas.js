/** @module */

'use strict';

var Consts = require('../../../config/WikitextConstants.js').WikitextConstants;
var DOMDataUtils = require('../../../utils/DOMDataUtils.js').DOMDataUtils;
var DOMUtils = require('../../../utils/DOMUtils.js').DOMUtils;
var WTUtils = require('../../../utils/WTUtils.js').WTUtils;

/**
 * This will move the start/end-meta closest to the content
 * that the template/extension produced and improve accuracy
 * of finding dom ranges and wrapping templates.
 *
 * If the last child of a node is a start-meta,
 * move it up and make it the parent's right sibling.
 *
 * If the first child of a node is an end-meta,
 * move it up and make it the parent's left sibling.
 * @param {Node} node
 * @param {MWParserEnvironment} env
 */
function migrateTemplateMarkerMetas(node, env) {
	let c = node.firstChild;
	while (c) {
		const sibling = c.nextSibling;
		if (c.hasChildNodes()) {
			migrateTemplateMarkerMetas(c, env);
		}
		c = sibling;
	}

	// No migration out of BODY
	if (DOMUtils.isBody(node)) {
		return;
	}

	var firstChild = DOMUtils.firstNonSepChild(node);
	if (firstChild && WTUtils.isTplEndMarkerMeta(firstChild)) {
		// We can migrate the meta-tag across this node's start-tag barrier only
		// if that start-tag is zero-width, or auto-inserted.
		const tagWidth = Consts.WtTagWidths.get(node.nodeName);
		if ((tagWidth && tagWidth[0] === 0 && !WTUtils.isLiteralHTMLNode(node)) ||
				DOMDataUtils.getDataParsoid(node).autoInsertedStart) {
			const sentinel = firstChild;
			do {
				firstChild = node.firstChild;
				node.parentNode.insertBefore(firstChild, node);
			} while (sentinel !== firstChild);
		}
	}

	let lastChild = DOMUtils.lastNonSepChild(node);
	if (lastChild && WTUtils.isTplStartMarkerMeta(lastChild)) {
		// We can migrate the meta-tag across this node's end-tag barrier only
		// if that end-tag is zero-width, or auto-inserted.
		const tagWidth = Consts.WtTagWidths.get(node.nodeName);
		if ((tagWidth && tagWidth[1] === 0 && !WTUtils.isLiteralHTMLNode(node)) ||
				// Except, don't migrate out of a table since the end meta
				// marker may have been fostered and this is more likely to
				// result in a flipped range that isn't enclosed.
				(DOMDataUtils.getDataParsoid(node).autoInsertedEnd && node.nodeName !== 'TABLE')) {
			const sentinel = lastChild;
			do {
				lastChild = node.lastChild;
				node.parentNode.insertBefore(lastChild, node.nextSibling);
			} while (sentinel !== lastChild);
		}
	}
}

if (typeof module === "object") {
	module.exports.migrateTemplateMarkerMetas = migrateTemplateMarkerMetas;
}
