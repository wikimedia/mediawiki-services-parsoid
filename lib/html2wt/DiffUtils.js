/**
 * @module
 */

'use strict';

const { DOMDataUtils } = require('../utils/DOMDataUtils.js');
const { DOMUtils } = require('../utils/DOMUtils.js');

class DiffUtils {
	/**
	 * Get a node's diff marker.
	 *
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 * @return {Object|null}
	 */
	static getDiffMark(node, env) {
		if (!DOMUtils.isElt(node)) { return null; }
		var data = DOMDataUtils.getNodeData(node);
		var dpd = data.parsoid_diff;
		return dpd && dpd.id === env.page.id ? dpd : null;
	}

	/**
	 * Check that the diff markers on the node exist and are recent.
	 *
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 */
	static hasDiffMarkers(node, env) {
		return this.getDiffMark(node, env) !== null || DOMUtils.isDiffMarker(node);
	}

	static hasDiffMark(node, env, mark) {
		// For 'deletion' and 'insertion' markers on non-element nodes,
		// a mw:DiffMarker meta is added
		if (mark === 'deleted' || (mark === 'inserted' && !DOMUtils.isElt(node))) {
			return DOMUtils.isDiffMarker(node.previousSibling, mark);
		} else {
			var diffMark = this.getDiffMark(node, env);
			return diffMark && diffMark.diff.indexOf(mark) >= 0;
		}
	}

	static hasInsertedDiffMark(node, env) {
		return this.hasDiffMark(node, env, 'inserted');
	}

	static maybeDeletedNode(node) {
		return node && DOMUtils.isElt(node) && DOMUtils.isDiffMarker(node, 'deleted');
	}

	/**
	 * Is node a mw:DiffMarker node that represents a deleted block node?
	 * This annotation is added by the DOMDiff pass.
	 */
	static isDeletedBlockNode(node) {
		return this.maybeDeletedNode(node) && node.hasAttribute('data-is-block');
	}

	static directChildrenChanged(node, env) {
		return this.hasDiffMark(node, env, 'children-changed');
	}

	static onlySubtreeChanged(node, env) {
		var dmark = this.getDiffMark(node, env);
		return dmark && dmark.diff.every(function subTreechangeMarker(mark) {
			return mark === 'subtree-changed' || mark === 'children-changed';
		});
	}

	static addDiffMark(node, env, mark) {
		if (mark === 'deleted' || mark === 'moved') {
			this.prependTypedMeta(node, 'mw:DiffMarker/' + mark);
		} else if (DOMUtils.isText(node) || DOMUtils.isComment(node)) {
			if (mark !== 'inserted') {
				env.log("error", "BUG! CHANGE-marker for ", node.nodeType, " node is: ", mark);
			}
			this.prependTypedMeta(node, 'mw:DiffMarker/' + mark);
		} else {
			this.setDiffMark(node, env, mark);
		}
	}

	/**
	 * Set a diff marker on a node.
	 *
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 * @param {string} change
	 */
	static setDiffMark(node, env, change) {
		if (!DOMUtils.isElt(node)) { return; }
		var dpd = this.getDiffMark(node, env);
		if (dpd) {
			// Diff is up to date, append this change if it doesn't already exist
			if (dpd.diff.indexOf(change) === -1) {
				dpd.diff.push(change);
			}
		} else {
			// Was an old diff entry or no diff at all, reset
			dpd = {
				// The base page revision this change happened on
				id: env.page.id,
				diff: [change],
			};
		}
		DOMDataUtils.getNodeData(node).parsoid_diff = dpd;
	}

	/**
	 * Insert a meta element with the passed-in typeof attribute before a node.
	 *
	 * @param {Node} node
	 * @param {string} type
	 * @return {Element} The new meta.
	 */
	static prependTypedMeta(node, type) {
		var meta = node.ownerDocument.createElement('meta');
		meta.setAttribute('typeof', type);
		node.parentNode.insertBefore(meta, node);
		return meta;
	}

	/**
	 * Attribute equality test.
	 * @param {Node} nodeA
	 * @param {Node} nodeB
	 * @param {Set} [ignoreableAttribs] Set of attributes that should be ignored.
	 * @param {Map} [specializedAttribHandlers] Map of attributes with specialized equals handlers.
	 */
	static attribsEquals(nodeA, nodeB, ignoreableAttribs, specializedAttribHandlers) {
		if (!ignoreableAttribs) {
			ignoreableAttribs = new Set();
		}
		if (!specializedAttribHandlers) {
			specializedAttribHandlers = new Map();
		}

		function arrayToHash(node) {
			var attrs = node.attributes || [];
			var h = {};
			var count = 0;
			for (var j = 0, n = attrs.length; j < n; j++) {
				var a = attrs.item(j);
				if (!ignoreableAttribs.has(a.name)) {
					count++;
					h[a.name] = a.value;
				}
			}
			// If there's no special attribute handler, we want a straight
			// comparison of these.
			if (!ignoreableAttribs.has('data-parsoid')) {
				h['data-parsoid'] = DOMDataUtils.getDataParsoid(node);
				count++;
			}
			if (!ignoreableAttribs.has('data-mw') && DOMDataUtils.validDataMw(node)) {
				h['data-mw'] = DOMDataUtils.getDataMw(node);
				count++;
			}
			return { h: h, count: count };
		}

		var xA = arrayToHash(nodeA);
		var xB = arrayToHash(nodeB);

		if (xA.count !== xB.count) {
			return false;
		}

		var hA = xA.h;
		var keysA = Object.keys(hA).sort();
		var hB = xB.h;
		var keysB = Object.keys(hB).sort();

		for (var i = 0; i < xA.count; i++) {
			var k = keysA[i];
			if (k !== keysB[i]) {
				return false;
			}

			var attribEquals = specializedAttribHandlers.get(k);
			if (attribEquals) {
				// Use a specialized compare function, if provided
				if (!hA[k] || !hB[k] || !attribEquals(nodeA, hA[k], nodeB, hB[k])) {
					return false;
				}
			} else if (hA[k] !== hB[k]) {
				return false;
			}
		}

		return true;
	}
}

if (typeof module === "object") {
	module.exports.DiffUtils = DiffUtils;
}
