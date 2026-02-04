<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use Wikimedia\JsonCodec\Hint;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\NodeData\DataMw;
use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\NodeData\DataParsoidDiff;
use Wikimedia\Parsoid\Utils\DOMDataUtils as DDU;

/**
 * This class provides DOM data helpers needed by extensions.
 * These helpers support fetching / updating attributes of DOM nodes.
 */
class DOMDataUtils {
	/**
	 * Return the value of a rich attribute as a live (by-reference) object.
	 * This also serves as an assertion that there are not conflicting types.
	 *
	 * @template T
	 * @param Element $node The node on which the attribute is to be found.
	 * @param string $name The name of the attribute.
	 * @param class-string<T>|Hint<T>|null $classHint
	 *   If the hint is null, will use the registered abbreviation.
	 * @return T|null The attribute value, or null if not present.
	 */
	public static function getAttributeObject(
		Element $node, string $name, $classHint = null
	): ?object {
		return DDU::getAttributeObject( $node, $name, $classHint );
	}

	/**
	 * Return the value of a rich attribute as a live (by-reference)
	 * object.  This also serves as an assertion that there are not
	 * conflicting types.  If the value is not present, a default value
	 * will be created using `$codec->defaultValue()` falling back to
	 * `$className::defaultValue()` and stored as the value of the
	 * attribute.
	 *
	 * @note The $className should have be JsonCodecable (either directly
	 *  or via a custom JsonClassCodec).
	 *
	 * @template T
	 * @param Element $node The node on which the attribute is to be found.
	 * @param string $name The name of the attribute.
	 * @param class-string<T>|Hint<T>|null $classHint
	 *   If the hint is null, will use the registered abbreviation.
	 * @return T The attribute value, or a default value if not present.
	 */
	public static function getAttributeObjectDefault(
		Element $node, string $name, $classHint = null
	): object {
		return DDU::getAttributeObjectDefault( $node, $name, $classHint );
	}

	/**
	 * Set the value of a rich attribute, overwriting any previous
	 * value.  Generally mutating the result returned by the
	 * `::getAttribute*Default()` methods should be done instead of
	 * using this method, since the objects returned are live.
	 *
	 * @param Element $node The node on which the attribute is to be found.
	 * @param string $name The name of the attribute.
	 * @param object $value The new (object) value for the attribute
	 * @param class-string|Hint|null $classHint Optional serialization hint
	 */
	public static function setAttributeObject(
		Element $node, string $name, object $value, $classHint = null
	): void {
		DDU::setAttributeObject( $node, $name, $value, $classHint );
	}

	/**
	 * Remove a rich attribute.
	 *
	 * @param Element $node The node on which the attribute is to be found.
	 * @param string $name The name of the attribute.
	 */
	public static function removeAttributeObject(
		Element $node, string $name
	): void {
		DDU::removeAttributeObject( $node, $name );
	}

	/**
	 * Get data parsoid info from DOM element
	 * @param Element $elt
	 * @return DataParsoid ( this is mostly used for type hinting )
	 */
	public static function getDataParsoid( Element $elt ): DataParsoid {
		return DDU::getDataParsoid( $elt );
	}

	/**
	 * Set data parsoid info on a DOM element
	 */
	public static function setDataParsoid( Element $elt, ?DataParsoid $dp ): void {
		DDU::setDataParsoid( $elt, $dp );
	}

	/**
	 * Get data meta wiki info from a DOM element
	 */
	public static function getDataMw( Element $elt ): DataMw {
		return DDU::getDataMw( $elt );
	}

	/**
	 * Get data meta wiki info, but don't create it if it doesn't exist.
	 */
	public static function getDataMwIfExists( Element $node ): ?DataMw {
		return DDU::getDataMwIfExists( $node );
	}

	/**
	 * Check if there is meta wiki info on a DOM element
	 * @param Element $elt
	 * @return bool
	 */
	public static function dataMwExists( Element $elt ): bool {
		return !DDU::getDataMw( $elt )->isEmpty();
	}

	/**
	 * Set data meta wiki info from a DOM element
	 * @param Element $elt
	 * @param ?DataMw $dmw data-mw
	 */
	public static function setDataMw( Element $elt, ?DataMw $dmw ): void {
		DDU::setDataMw( $elt, $dmw );
	}

	/**
	 * Get data diff info from a DOM element.
	 * @param Element $elt
	 * @return ?DataParsoidDiff
	 */
	public static function getDataParsoidDiff( Element $elt ): ?DataParsoidDiff {
		return DDU::getDataParsoidDiff( $elt );
	}

	/**
	 * Set data diff info on a DOM element.
	 * @param Element $elt
	 * @param ?DataParsoidDiff $diffObj data-parsoid-diff object
	 */
	public static function setDataParsoidDiff( Element $elt, ?DataParsoidDiff $diffObj ): void {
		DDU::setDataParsoidDiff( $elt, $diffObj );
	}

	/**
	 * Does this node have any attributes? This method is the preferred way of
	 * interrogating this property since Parsoid DOMs might have Parsoid-internal
	 * attributes added.
	 * @param Element $elt
	 * @return bool
	 */
	public static function noAttrs( Element $elt ): bool {
		return DDU::noAttrs( $elt );
	}

	/**
	 * Clones a node and its data bag
	 * @param Node $node
	 * @param bool $deep
	 * @return Node
	 */
	public static function cloneNode( Node $node, bool $deep ): Node {
		return DDU::cloneNode( $node, $deep );
	}

	/**
	 * Clones an element and its data bag
	 * @param Element $elt
	 * @param bool $deep
	 * @return Element
	 */
	public static function cloneElement( Element $elt, bool $deep ): Element {
		return DDU::cloneElement( $elt, $deep );
	}

	/**
	 * Clones a document fragment and its data bag
	 * @param DocumentFragment $df
	 * @return DocumentFragment
	 */
	public static function cloneDocumentFragment( DocumentFragment $df ): DocumentFragment {
		return DDU::cloneDocumentFragment( $df );
	}
}
