"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	Util = require('./mediawiki.Util.js').Util;

function saveDataParsoid( options, node) {
	if ( DU.isElt(node) && node.data ) {
		DU.saveDataAttribs( node );
	}
	return true;
}

function dumpDOM( options, root ) {
	function cloneData(node, clone) {
		var d = node.data;
		if (d && d.constructor === Object && (Object.keys(d.parsoid).length > 0)) {
			clone.data = Util.clone(d);
			saveDataParsoid( options, clone );
		}

		node = node.firstChild;
		clone = clone.firstChild;
		while (node) {
			cloneData(node, clone);
			node = node.nextSibling;
			clone = clone.nextSibling;
		}
	}

	root = root.documentElement;

	// cloneNode doesn't clone data => walk DOM to clone it
	var clonedRoot = root.cloneNode( true );
	cloneData(root, clonedRoot);
	console.warn(clonedRoot.innerHTML);
}

if (typeof module === "object") {
	module.exports.dumpDOM = dumpDOM;
}
