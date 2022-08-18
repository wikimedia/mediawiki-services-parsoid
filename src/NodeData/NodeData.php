<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\Parsoid\Utils\Utils;

// phpcs:disable MediaWiki.Commenting.PropertyDocumentation.ObjectTypeHintVar

/**
 * This object stores data associated with a single DOM node.
 *
 * Using undeclared properties reduces memory usage and CPU time if the
 * property is null in more than about 75% of instances. There are typically
 * a very large number of NodeData objects, so this optimisation is worthwhile.
 *
 * @property object|null $parsoid_diff
 * @property object|null $mw_variant
 * @property int|null $storedId
 * @property DataMwI18n|null $i18n
 */
#[\AllowDynamicProperties]
class NodeData {
	/**
	 * @var DataParsoid|null The unserialized data-parsoid attribute
	 */
	public $parsoid;

	/**
	 * @var object|null The unserialized data-mw attribute
	 */
	public $mw;

	/**
	 * Deep clone this object
	 * @return self
	 */
	public function clone(): self {
		$cloneableData = get_object_vars( $this );
		// Don't clone $this->parsoid because it has a custom clone method
		unset( $cloneableData['parsoid'] );
		// Don't clone storedId because it doesn't need it
		unset( $cloneableData['storedId'] );
		// Deep clone everything else
		$cloneableData = Utils::clone( $cloneableData );
		$nd = clone $this;
		if ( $nd->parsoid ) {
			$nd->parsoid = $nd->parsoid->clone();
		}
		foreach ( $cloneableData as $key => $value ) {
			$nd->$key = $value;
		}
		return $nd;
	}
}
