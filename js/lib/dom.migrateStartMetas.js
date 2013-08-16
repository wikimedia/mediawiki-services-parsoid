"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants;

// If the last child of a node is a start-meta, simply
// move it up and make it the parent's sibling.
// This will move the start-meta closest to the content
// that the template/extension produced and improve accuracy
// of finding dom ranges and wrapping templates.
function migrateStartMetas( node, env ) {
	var c = node.firstChild;
	while (c) {
		var sibling = c.nextSibling;
		if (c.childNodes.length > 0) {
			migrateStartMetas(c, env);
		}
		c = sibling;
	}

	if (node.nodeName !== 'HTML') {
		var lastChild = node.lastChild;
		if (lastChild && DU.isTplStartMarkerMeta(lastChild)) {
			// console.warn("migration: " + lastChild.outerHTML);

			// We can migrate the meta-tag across this node's end-tag barrier only
			// if that end-tag is zero-width.
			var tagWidth = Consts.WT_TagWidths[node.nodeName.toLowerCase()];
			if (tagWidth && tagWidth[1] === 0 && !DU.isLiteralHTMLNode(node)) {
				node.parentNode.insertBefore(lastChild, node.nextSibling);
			}
		}
	}
}

if (typeof module === "object") {
	module.exports.migrateStartMetas = migrateStartMetas;
}
