"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

/**
 * Class for helping us traverse the DOM.
 *
 * @param node {HTMLNode} The node to be traversed
 */
function DOMTraverser(env, skipCheckIfAttached) {
	this.handlers = [];
	this.env = env;
	this.checkIfAttached = !skipCheckIfAttached;
}

/**
 * Add a handler to the DOM traversal
 *
 * @param {Function} action A callback, called on each node we
 * traverse that matches nodeName. First argument is the DOM
 * node. Return false if you want to stop any further callbacks from
 * being called on the node.  Return the new node if you need to replace
 * it or change its siblings; traversal will continue with the new node.
 */
DOMTraverser.prototype.addHandler = function ( nodeName, action ) {
	var handler = {
		run: action,
		name: nodeName
	};

	this.handlers.push( handler );
};

DOMTraverser.prototype.callHandlers = function ( node ) {
	var name = ( node.nodeName || '' ).toLowerCase(),
		document = node.ownerDocument,
		ix, result;

	for ( ix = 0; ix < this.handlers.length; ix++ ) {
		if ( this.handlers[ix].name === null ||
				this.handlers[ix].name === name ) {
			result = this.handlers[ix].run( node );
			if ( result !== true ) {
				if ( result === undefined ) {
					this.env.log("error",
						'DOMPostProcessor.traverse: undefined return!',
						'Bug in', this.handlers[ix].run.toString(),
						' when handling ', node.outerHTML);
				}

				// abort processing for this node
				return result;
			}

			// Sanity check for broken handlers
			if ( this.checkIfAttached && !DU.isAncestorOf( document, node ) ) {
				console.error( 'DOMPostProcessor.traverse: detached node. ' +
					'Bug in ' + this.handlers[ix].run.toString() +
					' when handling', node.outerHTML );
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
DOMTraverser.prototype.traverse = function ( workNode ) {
	var result;
	while ( workNode !== null ) {
		// Call the handlers on this workNode
		result = this.callHandlers( workNode );

		if ( result !== true ) {
			// Something changed.
			// Continue to work on the returned node, if not null.
			workNode = result;
		} else {
			// the 'continue processing' case
			if ( DU.isElt(workNode) && workNode.childNodes.length > 0 ) {
				this.traverse( workNode.firstChild );
			}
			workNode = workNode.nextSibling;
		}
	}
};

if (typeof module === "object") {
	module.exports.DOMTraverser = DOMTraverser;
}
