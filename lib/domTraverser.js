'use strict';

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;


/**
 * Class for helping us traverse the DOM.
 *
 * This class currently does a pre-order depth-first traversal.
 * There might be scenarios where a post-order depth-first traversal might be better.
 * We should add an option for doing this.
 *
 * @class
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {boolean} skipCheckIfAttached
 */
function DOMTraverser(env, skipCheckIfAttached) {
	this.handlers = [];
	this.env = env;
	this.checkIfAttached = !skipCheckIfAttached;
}

/**
 * Add a handler to the DOM traversal
 *
 * @param {string} nodeName
 * @param {Function} action
 *   A callback, called on each node we traverse that matches nodeName.
 * @param {Node} action.node
 *   The DOM node.
 * @param {boolean|Node} action.return
 *   Return false if you want to stop any further callbacks from being
 *   called on the node.  Return the new node if you need to replace it or
 *   change its siblings; traversal will continue with the new node.
 */
DOMTraverser.prototype.addHandler = function(nodeName, action) {
	var handler = {
		run: action,
		name: nodeName,
	};
	this.handlers.push(handler);
};

DOMTraverser.prototype.callHandlers = function(node, env, atTopLevel, tplInfo) {
	var name = (node.nodeName || '').toLowerCase();
	var document = node.ownerDocument;

	for (var ix = 0; ix < this.handlers.length; ix++) {
		if (this.handlers[ix].name === null || this.handlers[ix].name === name) {
			var result = this.handlers[ix].run(node, env, atTopLevel, tplInfo);
			if (result !== true) {
				if (result === undefined) {
					this.env.log("error",
						'DOMPostProcessor.traverse: undefined return!',
						'Bug in', this.handlers[ix].run.toString(),
						' when handling ', node.outerHTML);
				}
				// abort processing for this node
				return result;
			}

			// Sanity check for broken handlers
			if (this.checkIfAttached && !DU.isAncestorOf(document, node)) {
				console.error('DOMPostProcessor.traverse: detached node. ' +
					'Bug in ' + this.handlers[ix].run.toString() +
					' when handling', node.outerHTML);
			}
		}
	}

	return true;
};

/**
 * Traverse the DOM and fire the handlers that are registered
 *
 * Handlers can return
 * - the next node to process
 *   - aborts processing for current node, continues with returned node
 *   - can also be null, so .nextSibling works even on last child
 * - true
 *   - continue regular processing on current node
 */
DOMTraverser.prototype.traverse = function(workNode, env, options, atTopLevel, tplInfo) {
	while (workNode !== null) {
		if (DU.isElt(workNode)) {
			var typeOf = workNode.getAttribute("typeof");
			// Identify the first template/extension node.
			// You'd think the !tplInfo check isn't necessary since
			// we don't have nested transclusions, however, you can
			// get extensions in transclusions.
			if (!tplInfo && DU.isTplOrExtToplevelNode(workNode) &&
				// No case for Params yet.
				/(^|\s)mw:(Extension|Transclusion)/.test(typeOf)
			) {
				var about = workNode.getAttribute("about");
				tplInfo = {
					first: workNode,
					last: DU.getAboutSiblings(workNode, about).last(),
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
			if (DU.isElt(workNode) && workNode.childNodes.length > 0) {
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
