<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use DOMElement;
use DOMNode;
use stdClass;
use Wikimedia\Parsoid\Core\DataParsoid;
use Wikimedia\Parsoid\Utils\DOMDataUtils as DDU;

/**
 * This class provides DOM data helpers needed by extensions.
 * These helpers support fetching / updating attributes of DOM nodes.
 */
class DOMDataUtils {
	/**
	 * Get data parsoid info from DOM element
	 * @param DOMElement $elt
	 * @return DataParsoid ( this is mostly used for type hinting )
	 */
	public static function getDataParsoid( DOMElement $elt ): stdClass {
		return DDU::getDataParsoid( $elt );
	}

	/**
	 * Set data parsoid info on a DOM element
	 * @param DOMElement $elt
	 * @param ?stdClass $dp data-parsoid
	 */
	public static function setDataParsoid( DOMElement $elt, ?stdClass $dp ): void {
		DDU::setDataParsoid( $elt, $dp );
	}

	/**
	 * Get data meta wiki info from a DOM element
	 * @param DOMElement $elt
	 * @return ?stdClass
	 */
	public static function getDataMw( DOMElement $elt ): ?stdClass {
		return DDU::getDataMw( $elt );
	}

	/**
	 * Check if there is meta wiki info on a DOM element
	 * @param DOMElement $elt
	 * @return bool
	 */
	public static function dataMwExists( DOMElement $elt ): bool {
		return DDU::validDataMw( $elt );
	}

	/**
	 * Set data meta wiki info from a DOM element
	 * @param DOMElement $elt
	 * @param ?stdClass $dmw data-mw
	 */
	public static function setDataMw( DOMElement $elt, ?stdClass $dmw ): void {
		DDU::setDataMw( $elt, $dmw );
	}

	/**
	 * Get data diff info from a DOM element.
	 * @param DOMElement $elt
	 * @return ?stdClass
	 */
	public static function getDataParsoidDiff( DOMElement $elt ): ?stdClass {
		return DDU::getDataParsoidDiff( $elt );
	}

	/**
	 * Set data diff info on a DOM element.
	 * @param DOMElement $elt
	 * @param ?stdClass $diffObj data-parsoid-diff object
	 */
	public static function setDataParsoidDiff( DOMElement $elt, ?stdClass $diffObj ): void {
		DDU::setDataParsoidDiff( $elt, $diffObj );
	}

	/**
	 * Does this node have any attributes? This method is the preferred way of
	 * interrogating this property since Parsoid DOMs might have Parsoid-internal
	 * attributes added.
	 * @param DOMElement $elt
	 * @return bool
	 */
	public static function noAttrs( DOMElement $elt ): bool {
		return DDU::noAttrs( $elt );
	}

	/**
	 * Test if a node matches a given typeof.
	 * @param DOMNode $node node
	 * @param string $type type
	 * @return bool
	 */
	public static function hasTypeOf( DOMNode $node, string $type ): bool {
		return DDU::hasTypeOf( $node, $type );
	}

	/**
	 * Add a type to the typeof attribute. If the elt already has an existing typeof,
	 * it makes that attribute a string of space separated types.
	 * @param DOMElement $elt
	 * @param string $type type
	 */
	public static function addTypeOf( DOMElement $elt, string $type ): void {
		DDU::addTypeOf( $elt, $type );
	}

	/**
	 * Remove a type from the typeof attribute.
	 * @param DOMElement $elt
	 * @param string $type type
	 */
	public static function removeTypeOf( DOMElement $elt, string $type ): void {
		DDU::removeTypeOf( $elt, $type );
	}

}
