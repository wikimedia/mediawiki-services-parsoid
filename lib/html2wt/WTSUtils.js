"use strict";

var DU = require('../utils/DOMUtils.js').DOMUtils;

var WTSUtils = {
	isValidSep: function(sep) {
		return sep.match(/^(\s|<!--([^\-]|-(?!->))*-->)*$/);
	},

	hasValidTagWidths: function(dsr) {
		return dsr &&
			typeof (dsr[2]) === 'number' && dsr[2] >= 0 &&
			typeof (dsr[3]) === 'number' && dsr[3] >= 0;
	},

	commentWT: function(comment) {
		return '<!--' + DU.decodeComment(comment) + '-->';
	},

	/**
	 * Emit the start tag source when not round-trip testing, or when the node is
	 * not marked with autoInsertedStart
	 */
	emitStartTag: function(src, node, state, dontEmit) {
		if (!state.rtTestMode || !DU.getDataParsoid(node).autoInsertedStart) {
			if (!dontEmit) {
				state.emitChunk(src, node);
			}
			return true;
		} else {
			// drop content
			return false;
		}
	},

	/**
	 * Emit the start tag source when not round-trip testing, or when the node is
	 * not marked with autoInsertedStart
	 */
	emitEndTag: function(src, node, state, dontEmit) {
		if (!state.rtTestMode || !DU.getDataParsoid(node).autoInsertedEnd) {
			if (!dontEmit) {
				state.emitChunk(src, node);
			}
			return true;
		} else {
			// drop content
			return false;
		}
	},
};

WTSUtils.traceNodeName = function(node) {
	switch (node.nodeType) {
	case node.ELEMENT_NODE:
		return DU.isMarkerMeta(node, "mw:DiffMarker") ?
				"DIFF_MARK" : "NODE: " + node.nodeName;
	case node.TEXT_NODE:
		return "TEXT: " + JSON.stringify(node.nodeValue);
	case node.COMMENT_NODE:
		return "CMT : " + JSON.stringify(WTSUtils.commentWT(node.nodeValue));
	default:
		return node.nodeName;
	}
};


if (typeof module === "object") {
	module.exports.WTSUtils = WTSUtils;
}
