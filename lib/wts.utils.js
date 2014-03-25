"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

var WTSUtils = {
	isValidSep: function(sep) {
		return sep.match(/^(\s|<!--([^\-]|-(?!->))*-->)*$/);
	},

	hasValidTagWidths: function(dsr) {
		return dsr &&
			typeof(dsr[2]) === 'number' && dsr[2] >= 0 &&
			typeof(dsr[3]) === 'number' && dsr[3] >= 0;
	},

	isValidDSR: function(dsr) {
		return dsr &&
			typeof(dsr[0]) === 'number' && dsr[0] >= 0 &&
			typeof(dsr[1]) === 'number' && dsr[1] >= 0;
	},

	commentWT: function (comment) {
		return '<!--' + comment.replace(/-->/, '--&gt;') + '-->';
	},

	/**
	 * Skip the start tag source if it has autoInsertedFlag set AND
	 * - we are in rt-testing mode OR
	 * - the node is empty and dsr range for subtree is zero
	 */
	emitStartTag: function(src, node, state, cb) {
		var dp = DU.getDataParsoid(node);
		if (dp.autoInsertedStart
			&& (state.rtTesting
				|| !(node.firstChild
					&& this.isValidDSR(dp.dsr)
					&& this.hasValidTagWidths(dp.dsr)
					&& dp.dsr[1] - dp.dsr[0] === dp.dsr[3])))
		{
			/* jshint noempty: false */
			// drop content
		} else {
			cb(src, node);
		}
	},

	/**
	 * Skip the end tag source if it has autoInsertedFlag set AND
	 * - we are in rt-testing mode OR
	 * - the node is empty and dsr range for subtree is zero
	 */
	emitEndTag: function(src, node, state, cb) {
		var dp = DU.getDataParsoid(node);
		if (dp.autoInsertedEnd
			&& (state.rtTesting
				|| !(node.firstChild
					&& this.isValidDSR(dp.dsr)
					&& this.hasValidTagWidths(dp.dsr)
					&& dp.dsr[1] - dp.dsr[0] === dp.dsr[2])))
		{
			/* jshint noempty: false */
			// drop content
		} else {
			cb(src, node);
		}
	}
};

if (typeof module === "object") {
	module.exports.WTSUtils = WTSUtils;
}
