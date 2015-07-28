"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

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
	emitStartTag: function(src, node, state, cb) {
		if (!state.rtTestMode) {
			cb(src, node);
		} else if (!DU.getDataParsoid(node).autoInsertedStart) {
			cb(src, node);
		}
		// else: drop content
	},

	/**
	 * Emit the start tag source when not round-trip testing, or when the node is
	 * not marked with autoInsertedStart
	 */
	emitEndTag: function(src, node, state, cb) {
		if (!state.rtTestMode) {
			cb(src, node);
		} else if (!DU.getDataParsoid(node).autoInsertedEnd) {
			cb(src, node);
		}
		// else: drop content
	},
};

if (typeof module === "object") {
	module.exports.WTSUtils = WTSUtils;
}
