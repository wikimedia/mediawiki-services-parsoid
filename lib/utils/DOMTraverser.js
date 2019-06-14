/**
 * Pre-order depth-first DOM traversal helper.
 * @module
 */

'use strict';

var DOMDataUtils = require('./DOMDataUtils.js').DOMDataUtils;
var DOMUtils = require('./DOMUtils.js').DOMUtils;
var JSUtils = require('./jsutils.js').JSUtils;
var WTUtils = require('./WTUtils.js').WTUtils;

/**
 * Class for helping us traverse the DOM.
 *
 * This class currently does a pre-order depth-first traversal.
 * See {@link DOMPostOrder} for post-order traversal.
 *
 * @class
 */
function DOMTraverser() {
	this.handlers = [];
}

/**
 * DOM traversal handler.
 * @callback module:utils/DOMTraverser~traverserHandler
 * @param {Node} node
 * @param {MWParserEnvironment} env
 * @param {boolean} atTopLevel
 * @param {Object} tplInfo Template information.
 * @return {Node|null|false|true}
 *   Return false if you want to stop any further callbacks from being
 *   called on the node.  Return the new node if you need to replace it or
 *   change its siblings; traversal will continue with the new node.
 */

/**
 * Add a handler to the DOM traverser.
 *
 * @param {string} nodeName
 * @param {traverserHandler} action
 *   A callback, called on each node we traverse that matches nodeName.
 */
DOMTraverser.prototype.addHandler = function(nodeName, action) {
	this.handlers.push({ action, nodeName });
};

/**
 * @private
 */
DOMTraverser.prototype.callHandlers = function(node, env, atTopLevel, tplInfo) {
	var name = (node.nodeName || '').toLowerCase();

	for (const handler of this.handlers) {
		if (handler.nodeName === null || handler.nodeName === name) {
			var result = handler.action(node, env, atTopLevel, tplInfo);
			if (result !== true) {
				if (result === undefined) {
					env.log("error",
						'DOMPostProcessor.traverse: undefined return!',
						'Bug in', handler.action.toString(),
						' when handling ', node.outerHTML);
				}
				// abort processing for this node
				return result;
			}
		}
	}

	return true;
};

/**
 * Traverse the DOM and fire the handlers that are registered.
 *
 * Handlers can return
 * - the next node to process
 *   - aborts processing for current node, continues with returned node
 *   - can also be `null`, so returning `workNode.nextSibling` works even when
 *     workNode is a last child of its parent
 * - `true`
 *   - continue regular processing on current node.
 *
 * @param {Node} workNode
 * @param {MWParserEnvironment} env
 * @param {Object} options
 * @param {boolean} atTopLevel
 * @param {Object} tplInfo Template information.
 * @return {Node|null|true}
 */
DOMTraverser.prototype.traverse = function(workNode, env, options, atTopLevel, tplInfo) {
	while (workNode !== null) {
		if (DOMUtils.isElt(workNode)) {
			// Identify the first template/extension node.
			// You'd think the !tplInfo check isn't necessary since
			// we don't have nested transclusions, however, you can
			// get extensions in transclusions.
			if (!tplInfo && WTUtils.isFirstEncapsulationWrapperNode(workNode)
					// Ensure this isn't just a meta marker, since we might
					// not be traversing after encapsulation.  Note that the
					// valid data-mw assertion is the same test as used in
					// cleanup.
					&& (!WTUtils.isTplMarkerMeta(workNode) || DOMDataUtils.validDataMw(workNode))
					// Encapsulation info on sections should not be used to
					// traverse with since it's designed to be dropped and
					// may have expanded ranges.
					&& !WTUtils.isParsoidSectionTag(workNode)) {
				var about = workNode.getAttribute("about") || '';
				tplInfo = {
					first: workNode,
					last: JSUtils.lastItem(WTUtils.getAboutSiblings(workNode, about)),
					clear: false,
				};
			}
		}

		// Call the handlers on this workNode
		var possibleNext = this.callHandlers(workNode, env, atTopLevel, tplInfo);

		// We may have walked passed the last about sibling or want to
		// ignore the template info in future processing.
		if (tplInfo && tplInfo.clear) {
			tplInfo = null;
		}

		if (possibleNext === true) {
			// the 'continue processing' case
			if (DOMUtils.isElt(workNode) && workNode.hasChildNodes()) {
				this.traverse(workNode.firstChild, env, options, atTopLevel, tplInfo);
			}
			possibleNext = workNode.nextSibling;
		}

		// Clear the template info after reaching the last about sibling.
		if (tplInfo && tplInfo.last === workNode) {
			tplInfo = null;
		}

		workNode = possibleNext;
	}
};

if (typeof module === "object") {
	module.exports.DOMTraverser = DOMTraverser;
}
