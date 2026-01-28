<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMUtils as DU;

/**
 * This class provides DOM helpers useful for extensions.
 */
class DOMUtils {
	/**
	 * Parse HTML, return the tree.
	 *
	 * @note The resulting document is not "prepared and loaded"; use
	 * ContentUtils::prepareAndLoadDocument() instead if that's what
	 * you need.
	 */
	public static function parseHTML(
		string $html, bool $validateXMLNames = false
	): Document {
		return DU::parseHTML( $html, $validateXMLNames );
	}

	/**
	 * innerHTML and outerHTML are not defined on DocumentFragment.
	 *
	 * Defined similarly to DOMCompat::getInnerHTML()
	 */
	public static function getFragmentInnerHTML( DocumentFragment $frag ): string {
		return DU::getFragmentInnerHTML( $frag );
	}

	/**
	 * innerHTML and outerHTML are not defined on DocumentFragment.
	 * @see DOMCompat::setInnerHTML() for the Element version
	 */
	public static function setFragmentInnerHTML( DocumentFragment $frag, string $html ): void {
		DU::setFragmentInnerHTML( $frag, $html );
	}

	public static function parseHTMLToFragment( Document $doc, string $html ): DocumentFragment {
		return DU::parseHTMLToFragment( $doc, $html );
	}

	/**
	 * Test if a node matches a given typeof.
	 * @param Node $node node
	 * @param string $type type
	 * @return bool
	 */
	public static function hasTypeOf( Node $node, string $type ): bool {
		return DU::hasTypeOf( $node, $type );
	}

	/**
	 * @param Element $element
	 * @param string $regex Partial regular expression, e.g. "foo|bar"
	 * @return bool
	 */
	public static function hasClass( Element $element, string $regex ): bool {
		return DU::hasClass( $element, $regex );
	}

	/**
	 * Determine whether the node matches the given `typeof` attribute value.
	 *
	 * @param Node $n The node to test
	 * @param string $typeRe Regular expression matching the expected value of
	 *   the `typeof` attribute.
	 * @return ?string The matching `typeof` value, or `null` if there is
	 *   no match.
	 */
	public static function matchTypeOf( Node $n, string $typeRe ): ?string {
		return DU::matchTypeOf( $n, $typeRe );
	}

	/**
	 * Add a type to the typeof attribute. If the elt already has an existing typeof,
	 * it makes that attribute a string of space separated types.
	 * @param Element $elt
	 * @param string $type type
	 */
	public static function addTypeOf( Element $elt, string $type ): void {
		DU::addTypeOf( $elt, $type );
	}

	/**
	 * Remove a type from the typeof attribute.
	 * @param Element $elt
	 * @param string $type type
	 */
	public static function removeTypeOf( Element $elt, string $type ): void {
		DU::removeTypeOf( $elt, $type );
	}

	/**
	 * Determine whether the node matches the given rel attribute value.
	 *
	 * @param Node $n
	 * @param string $rel Expected value of "rel" attribute, as a literal string.
	 * @return ?string The match if there is one, null otherwise
	 */
	public static function matchRel( Node $n, string $rel ): ?string {
		return DU::matchRel( $n, $rel );
	}

	/**
	 * Add a type to the rel attribute.  This method should almost always
	 * be used instead of `setAttribute`, to ensure we don't overwrite existing
	 * rel information.
	 *
	 * @param Element $node node
	 * @param string $rel type
	 */
	public static function addRel( Element $node, string $rel ): void {
		DU::addRel( $node, $rel );
	}

	/**
	 * Assert that this is a DOM element node.
	 * This is primarily to help phan analyze variable types.
	 * @phan-assert Element $node
	 * @param ?Node $node
	 * @return bool Always returns true
	 */
	public static function assertElt( ?Node $node ): bool {
		return DU::assertElt( $node );
	}

	/**
	 * Many DOM implementations will de-optimize the representation of a
	 * Node if `$node->childNodes` is accessed, converting the linked list
	 * of node children to an array which is then expensive to mutate.
	 *
	 * This method returns an array of child nodes, but uses the
	 * `->firstChild`/`->nextSibling` accessors to obtain it, avoiding
	 * deoptimization.  This is also robust against concurrent mutation.
	 *
	 * @param Node $n
	 * @return list<Node> the child nodes
	 */
	public static function childNodes( Node $n ): array {
		return DU::childNodes( $n );
	}

	/**
	 * Move 'from'.childNodes to 'to' adding them before 'beforeNode'
	 * If 'beforeNode' is null, the nodes are appended at the end.
	 * @param Node $from Source node. Children will be removed.
	 * @param Node $to Destination node. Children of $from will be added here
	 * @param ?Node $beforeNode Add the children before this node.
	 */
	public static function migrateChildren(
		Node $from, Node $to, ?Node $beforeNode = null
	): void {
		DU::migrateChildren( $from, $to, $beforeNode );
	}

	/**
	 * Add attributes to a node element.
	 *
	 * @param Element $elt element
	 * @param array $attrs attributes
	 */
	public static function addAttributes( Element $elt, array $attrs ): void {
		DU::addAttributes( $elt, $attrs );
	}

	/**
	 * Find an ancestor of $node with nodeName $name.
	 *
	 * @param Node $node
	 * @param string $name
	 * @return ?Element
	 */
	public static function findAncestorOfName( Node $node, string $name ): ?Element {
		return DU::findAncestorOfName( $node, $name );
	}

	/**
	 * Return the lower-case version of the node name.
	 * FIXME: HTML says this should be capitalized, but we are tailoring
	 * this to the PHP7.x DOM libraries that return lower-case names.
	 * @see DOMCompat::nodeName()
	 */
	public static function nodeName( Node $node ): string {
		return DU::nodeName( $node );
	}
}
