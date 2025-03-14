<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use stdClass;

/**
 * Information about the body of an extension tag.
 *
 * THIS IS A TEMPORARY STUB to help transition
 * the Cite extension.
 */
class DataMwBody {
	/**
	 * Transitional helper method to initialize a new value appropriate for DataMw::$body.
	 */
	public static function new( array $values ): stdClass {
		return (object)$values;
	}
}
