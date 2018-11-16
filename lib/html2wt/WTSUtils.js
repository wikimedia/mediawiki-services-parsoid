/** @module */

"use strict";

var DU = require('../utils/DOMUtils.js').DOMUtils;

const { KV, TagTk, EndTagTk } = require('../tokens/TokenTypes.js');

/** @namespace */
var WTSUtils = {
	isValidSep: function(sep) {
		return sep.match(/^(\s|<!--([^\-]|-(?!->))*-->)*$/);
	},

	hasValidTagWidths: function(dsr) {
		return dsr &&
			typeof (dsr[2]) === 'number' && dsr[2] >= 0 &&
			typeof (dsr[3]) === 'number' && dsr[3] >= 0;
	},

	/**
	 * Get the attributes on a node in an array of KV objects.
	 *
	 * @param {Node} node
	 * @return {KV[]}
	 */
	getAttributeKVArray: function(node) {
		var attribs = node.attributes;
		var kvs = [];
		for (var i = 0, l = attribs.length; i < l; i++) {
			var attrib = attribs.item(i);
			kvs.push(new KV(attrib.name, attrib.value));
		}
		return kvs;
	},

	/**
	 * Create a `TagTk` corresponding to a DOM node.
	 */
	mkTagTk: function(node) {
		var attribKVs = this.getAttributeKVArray(node);
		return new TagTk(node.nodeName.toLowerCase(), attribKVs, DU.getDataParsoid(node));
	},

	/**
	 * Create a `EndTagTk` corresponding to a DOM node.
	 */
	mkEndTagTk: function(node) {
		var attribKVs = this.getAttributeKVArray(node);
		return new EndTagTk(node.nodeName.toLowerCase(), attribKVs, DU.getDataParsoid(node));
	},

	/**
	 * For new elements, attrs are always considered modified.  However, For
	 * old elements, we only consider an attribute modified if we have shadow
	 * info for it and it doesn't match the current value.
	 * @return {Object}
	 *   @return {any} return.value
	 *   @return {boolean} return.modified If the value of the attribute changed since we parsed the wikitext.
	 *   @return {boolean} return.fromsrc Whether we got the value from source-based roundtripping.
	 */
	getShadowInfo: function(node, name, curVal) {
		var dp = DU.getDataParsoid(node);

		// Not the case, continue regular round-trip information.
		if (dp.a === undefined || dp.a[name] === undefined) {
			return {
				value: curVal,
				// Mark as modified if a new element
				modified: DU.isNewElt(node),
				fromsrc: false,
			};
		} else if (dp.a[name] !== curVal) {
			return {
				value: curVal,
				modified: true,
				fromsrc: false,
			};
		} else if (dp.sa === undefined || dp.sa[name] === undefined) {
			return {
				value: curVal,
				modified: false,
				fromsrc: false,
			};
		} else {
			return {
				value: dp.sa[name],
				modified: false,
				fromsrc: true,
			};
		}
	},

	/**
	 * Get shadowed information about an attribute on a node.
	 *
	 * @param {Node} node
	 * @param {string} name
	 * @return {Object}
	 *   @return {any} return.value
	 *   @return {boolean} return.modified If the value of the attribute changed since we parsed the wikitext.
	 *   @return {boolean} return.fromsrc Whether we got the value from source-based roundtripping.
	 */
	getAttributeShadowInfo: function(node, name) {
		return this.getShadowInfo(node, name, node.getAttribute(name));
	},

	commentWT: function(comment) {
		return '<!--' + DU.decodeComment(comment) + '-->';
	},

	/**
	 * Emit the start tag source when not round-trip testing, or when the node is
	 * not marked with autoInsertedStart.
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
	 * not marked with autoInsertedStart.
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
			return DU.isDiffMarker(node) ?
				"DIFF_MARK" : "NODE: " + node.nodeName;
		case node.TEXT_NODE:
			return "TEXT: " + JSON.stringify(node.nodeValue);
		case node.COMMENT_NODE:
			return "CMT : " + JSON.stringify(WTSUtils.commentWT(node.nodeValue));
		default:
			return node.nodeName;
	}
};

/**
 * In selser mode, check if an unedited node's wikitext from source wikitext
 * is reusable as is.
 * @param {MWParserEnvironment} env
 * @param {Node} node
 * @return {boolean}
 */
WTSUtils.origSrcValidInEditedContext = function(env, node) {
	var prev;

	if (DU.isRedirectLink(node)) {
		return DU.isBody(node.parentNode) && !node.previousSibling;
	} else if (node.nodeName === 'TH' || node.nodeName === 'TD') {
		// The wikitext representation for them is dependent
		// on cell position (first cell is always single char).

		// If there is no previous sibling, nothing to worry about.
		prev = node.previousSibling;
		if (!prev) {
			return true;
		}

		// If previous sibling is unmodified, nothing to worry about.
		if (!DU.isDiffMarker(prev) &&
			!DU.hasInsertedDiffMark(prev, env) &&
			!DU.directChildrenChanged(prev, env)) {
			return true;
		}

		// If it didn't have a stx marker that indicated that the cell
		// showed up on the same line via the "||" or "!!" syntax, nothing
		// to worry about.
		return DU.getDataParsoid(node).stx !== 'row';
	} else if (node.nodeName === 'TR' && !DU.getDataParsoid(node).startTagSrc) {
		// If this <tr> didn't have a startTagSrc, it would have been
		// the first row of a table in original wikitext. So, it is safe
		// to reuse the original source for the row (without a "|-") as long as
		// it continues to be the first row of the table.  If not, since we need to
		// insert a "|-" to separate it from the newly added row (in an edit),
		// we cannot simply reuse orig. wikitext for this <tr>.
		return !DU.previousNonSepSibling(node);
	} else if (DU.isNestedListOrListItem(node)) {
		// If there are no previous siblings, bullets were assigned to
		// containing elements in the ext.core.ListHandler. For example,
		//
		//   *** a
		//
		// Will assign bullets as,
		//
		//   <ul><li-*>
		//     <ul><li-*>
		//       <ul><li-*> a</li></ul>
		//     </li></ul>
		//   </li></ul>
		//
		// If we reuse the src for the inner li with the a, we'd be missing
		// two bullets because the tag handler for lists in the serializer only
		// emits start tag src when it hits a first child that isn't a list
		// element. We need to walk up and get them.
		prev = node.previousSibling;
		if (!prev) {
			return false;
		}

		// If a previous sibling was modified, we can't reuse the start dsr.
		while (prev) {
			if (DU.isDiffMarker(prev) ||
				DU.hasInsertedDiffMark(prev, env)
			) {
				return false;
			}
			prev = prev.previousSibling;
		}

		return true;
	} else {
		return true;
	}
};

if (typeof module === "object") {
	module.exports.WTSUtils = WTSUtils;
}
