'use strict';

var DU = require('../../utils/DOMUtils.js').DOMUtils;
var Util = require('../../utils/Util.js').Util;

function dumpDOM(options, root) {
	function cloneData(node, clone) {
		var d = DU.getNodeData(node);
		if (d.parsoid && (Object.keys(d.parsoid).length > 0)) {
			DU.setNodeData(clone, Util.clone(d));
		}
		node = node.firstChild;
		clone = clone.firstChild;
		while (node) {
			cloneData(node, clone);
			node = node.nextSibling;
			clone = clone.nextSibling;
		}
	}

	// cloneNode doesn't clone data => walk DOM to clone it
	var clonedRoot = root.cloneNode(true);
	cloneData(root, clonedRoot);
	console.warn(DU.ppToXML(clonedRoot));
}

if (typeof module === "object") {
	module.exports.dumpDOM = dumpDOM;
}
