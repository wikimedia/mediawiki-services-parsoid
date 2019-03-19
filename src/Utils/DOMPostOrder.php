<?php
declare( strict_types = 1 );

namespace Parsoid\Utils;

use DOMNode;

/**
 * Non-recursive post-order traversal of a DOM tree.
 */
class DOMPostOrder {
	// Porting note: the JS version's DOMPostOrder() function is replaced by the class method
	// DOMPostOrder::traverse(). PHP functions cannot be namespaced or autoloaded with makes
	// them annoying to work with.

	/**
	 * Non-recursive post-order traversal of a DOM tree.
	 * @param DOMNode $root
	 * @param callable $visitFunc Called in post-order on each node.
	 */
	public function traverse( DOMNode $root, callable $visitFunc ): void {
		$node = $root;
		while ( true ) {
			// Find leftmost (grand)child, and visit that first.
			while ( $node->firstChild ) {
				$node = $node->firstChild;
			}
			$visitFunc( $node );
			while ( true ) {
				if ( $node === $root ) {
					return; // Visiting the root is the last thing we do.
				}
				/* Look for right sibling to continue traversal. */
				if ( $node->nextSibling ) {
					$node = $node->nextSibling;
					/* Loop back and visit its leftmost (grand)child first. */
					break;
				}
				/* Visit parent only after we've run out of right siblings. */
				$node = $node->parentNode;
				$visitFunc( $node );
			}
		}
	}

}
