"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants;

/* -----------------------------------------------------------
 * This will move the start/end-meta closest to the content
 * that the template/extension produced and improve accuracy
 * of finding dom ranges and wrapping templates.
 *
 * If the last child of a node is a start-meta,
 * move it up and make it the parent's right sibling.
 *
 * If the first child of a node is an end-meta,
 * move it up and make it the parent's left sibling.
 * ----------------------------------------------------------- */
function migrateTemplateMarkerMetas( node, env ) {
	var tagWidth;

	var c = node.firstChild;
	while (c) {
		var sibling = c.nextSibling;
		if (c.childNodes.length > 0) {
			migrateTemplateMarkerMetas(c, env);
		}
		c = sibling;
	}

	if (node.nodeName !== 'HTML') {
		var firstChild = node.firstChild;
		if (firstChild && DU.isTplEndMarkerMeta(firstChild)) {
			// console.warn("migration: " + firstChild.outerHTML);

			// We can migrate the meta-tag across this node's end-tag barrier only
			// if that end-tag is zero-width.
			tagWidth = Consts.WT_TagWidths[node.nodeName];
			if (tagWidth && tagWidth[0] === 0 && !DU.isLiteralHTMLNode(node)) {
				node.parentNode.insertBefore(firstChild, node);
			}
		}

		var lastChild = node.lastChild;
		if (lastChild && DU.isTplStartMarkerMeta(lastChild)) {
			// console.warn("migration: " + lastChild.outerHTML);

			// We can migrate the meta-tag across this node's end-tag barrier only
			// if that end-tag is zero-width.
			tagWidth = Consts.WT_TagWidths[node.nodeName];
			if (tagWidth && tagWidth[1] === 0 && !DU.isLiteralHTMLNode(node)) {
				node.parentNode.insertBefore(lastChild, node.nextSibling);
			}
		}
	}
}

if (typeof module === "object") {
	module.exports.migrateTemplateMarkerMetas = migrateTemplateMarkerMetas;
}
