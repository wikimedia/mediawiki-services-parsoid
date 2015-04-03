"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

function stripEmptyElements(node, tplInfo, options) {
	// Cannot delete if:
	// * it is the first node since that carries the transclusion
	//   information (typeof, data-mw). We could delete and migrate
	//   the info over, but more pain than worth it. We can reconsider if
	//   this ever becomes an issue.
	// * it has any attributes.
	if (!node.firstChild && node !== tplInfo.first &&
		node.nodeName in {'TR':1, 'LI':1} && node.attributes.length === 0) {
		DU.deleteNode(node);
	}
}

function removeDataParsoid(node, tplInfo, options) {
	if (node !== tplInfo.first) {
		var dp = DU.getDataParsoid(node);
		// We can't remove data-parsoid from inside <references> text, as that's
		// the only HTML representation we have left for it.
		if (node.getAttribute('class') === "mw-reference-text") {
			tplInfo.done = true;
			return;
		}
		// TODO: We can't remove dp from nodes with stx information
		// right now, as the serializer needs that information to know which
		// content model the text came from to emit the right newline separators.
		// For example, both "a\n\nb" and "<p>a</p><p>b/p>" both generate
		// identical html but serialize to different wikitext.
		if (!dp.stx) {
			node.removeAttribute('data-parsoid');
		}
	}
}

if (typeof module === "object") {
	module.exports.stripEmptyElements =
		DU.traverseTplOrExtNodes.bind(DU, stripEmptyElements);
	module.exports.removeDataParsoid =
		DU.traverseTplOrExtNodes.bind(DU, removeDataParsoid);
}
