/**
 * Pre-order depth-first DOM traversal helper.
 * @module
 */

'use strict';

var DU = require('./DOMUtils.js').DOMUtils;
var JSUtils = require('./jsutils.js').JSUtils;


/**
 * Class for helping us traverse the DOM.
 *
 * This class currently does a pre-order depth-first traversal.
 * See {@link DOMPostOrder} for post-order traversal.
 *
 * @class
 * @param {MWParserEnvironment} env
 * @param {boolean} skipCheckIfAttached
 */
function DOMTraverser(env, skipCheckIfAttached) {
	this.handlers = [];
	this.env = env;
	this.checkIfAttached = !skipCheckIfAttached;
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
 * @param {Object} [context]
 *   A context object to use when the `action` is invoked.
 */
DOMTraverser.prototype.addHandler = function(nodeName, action, context) {
	this.handlers.push({ action, nodeName, context });
};

/**
 * @private
 */
DOMTraverser.prototype.callHandlers = function(node, env, atTopLevel, tplInfo) {
	var name = (node.nodeName || '').toLowerCase();
	var document = node.ownerDocument;

	for (const handler of this.handlers) {
		if (handler.nodeName === null || handler.nodeName === name) {
			var result = handler.action.call(handler.context, node, env, atTopLevel, tplInfo);
			if (result !== true) {
				if (result === undefined) {
					this.env.log("error",
						'DOMPostProcessor.traverse: undefined return!',
						'Bug in', handler.action.toString(),
						' when handling ', node.outerHTML);
				}
				// abort processing for this node
				return result;
			}

			// Sanity check for broken handlers
			if (this.checkIfAttached && !DU.isAncestorOf(document, node)) {
				console.error('DOMPostProcessor.traverse: detached node. ' +
					'Bug in ' + handler.action.toString() +
					' when handling', node.outerHTML);
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
		if (DU.isElt(workNode)) {
			// Identify the first template/extension node.
			// You'd think the !tplInfo check isn't necessary since
			// we don't have nested transclusions, however, you can
			// get extensions in transclusions.
			if (!tplInfo && DU.isFirstEncapsulationWrapperNode(workNode)
					// Encapsulation info on sections should not be used to
					// traverse with since it's designed to be dropped and
					// may have expanded ranges.
					&& !DU.isParsoidSectionTag(workNode)) {
				var about = workNode.getAttribute("about");
				tplInfo = {
					first: workNode,
					last: JSUtils.lastItem(DU.getAboutSiblings(workNode, about)),
					dsr: DU.getDataParsoid(workNode).dsr,
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
			if (DU.isElt(workNode) && workNode.hasChildNodes()) {
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
