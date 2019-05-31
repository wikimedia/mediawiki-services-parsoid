/**
 * Post-order DOM traversal helper.
 * @module
 */

'use strict';

/**
 * Non-recursive post-order traversal of a DOM tree.
 * @param {Node} root
 * @param {Function} visitFunc Called in post-order on each node.
 */
function DOMPostOrder(root, visitFunc) {
	let node = root;
	while (true) {
		// Find leftmost (grand)child, and visit that first.
		while (node.firstChild) {
			node = node.firstChild;
		}
		while (true) {
			visitFunc(node);
			if (node === root) {
				return; // Visiting the root is the last thing we do.
			}
			/* Look for right sibling to continue traversal. */
			if (node.nextSibling) {
				node = node.nextSibling;
				/* Loop back and visit its leftmost (grand)child first. */
				break;
			}
			/* Visit parent only after we've run out of right siblings. */
			node = node.parentNode;
		}
	}
}

module.exports.DOMPostOrder = DOMPostOrder;
