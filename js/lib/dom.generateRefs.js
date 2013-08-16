"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

function generateRefs(refsExt, node) {
	var child = node.firstChild;
	while (child !== null) {
		var nextChild = child.nextSibling;
		DU.loadDataParsoid(child);
		if (DU.isElt(child)) {
			var typeOf = child.getAttribute('typeof');
			if ((/\bmw:Extension\/ref\/Marker\b/).test(typeOf)) {
				refsExt.extractRefFromNode(child);
			} else if ((/\bmw:Extension\/references\b/).test(typeOf)) {
				refsExt.insertReferencesIntoDOM(child);
			} else if (child.childNodes.length > 0) {
				generateRefs(refsExt, child);
			}
		}

		child = nextChild;
	}
}

if (typeof module === "object") {
	module.exports.generateRefs = generateRefs;
}
