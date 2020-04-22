<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use DOMElement;
use DOMNode;
use Wikimedia\Parsoid\Utils\DOMUtils as DU;

/**
 * This class provides DOM helpers useful for extensions.
 */
class DOMUtils {
	/**
	 * Test if a node matches a given typeof.
	 * @param DOMNode $node node
	 * @param string $type type
	 * @return bool
	 */
	public static function hasTypeOf( DOMNode $node, string $type ): bool {
		return DU::hasTypeOf( $node, $type );
	}

	/**
	 * Determine whether the node matches the given `typeof` attribute value.
	 *
	 * @param DOMNode $n The node to test
	 * @param string $typeRe Regular expression matching the expected value of
	 *   the `typeof` attribute.
	 * @return ?string The matching `typeof` value, or `null` if there is
	 *   no match.
	 */
	public static function matchTypeOf( DOMNode $n, string $typeRe ): ?string {
		return DU::matchTypeOf( $n, $typeRe );
	}

	/**
	 * Add a type to the typeof attribute. If the elt already has an existing typeof,
	 * it makes that attribute a string of space separated types.
	 * @param DOMElement $elt
	 * @param string $type type
	 */
	public static function addTypeOf( DOMElement $elt, string $type ): void {
		DU::addTypeOf( $elt, $type );
	}

	/**
	 * Remove a type from the typeof attribute.
	 * @param DOMElement $elt
	 * @param string $type type
	 */
	public static function removeTypeOf( DOMElement $elt, string $type ): void {
		DU::removeTypeOf( $elt, $type );
	}

	/**
	 * Check whether this is a DOM element node.
	 * @see http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param DOMNode|null $node
	 * @return bool
	 */
	public static function isElt( ?DOMNode $node ): bool {
		return DU::isElt( $node );
	}

	/**
	 * Check whether this is a DOM text node.
	 * @see http://dom.spec.whatwg.org/#dom-node-nodetype
	 * @param DOMNode|null $node
	 * @return bool
	 */
	public static function isText( ?DOMNode $node ): bool {
		return DU::isText( $node );
	}

	/**
	 * Move 'from'.childNodes to 'to' adding them before 'beforeNode'
	 * If 'beforeNode' is null, the nodes are appended at the end.
	 * @param DOMNode $from Source node. Children will be removed.
	 * @param DOMNode $to Destination node. Children of $from will be added here
	 * @param DOMNode|null $beforeNode Add the children before this node.
	 */
	public static function migrateChildren(
		DOMNode $from, DOMNode $to, DOMNode $beforeNode = null
	): void {
		DU::migrateChildren( $from, $to, $beforeNode );
	}

	/**
	 * Add attributes to a node element.
	 *
	 * @param DOMElement $elt element
	 * @param array $attrs attributes
	 */
	public static function addAttributes( DOMElement $elt, array $attrs ): void {
		DU::addAttributes( $elt, $attrs );
	}
}
