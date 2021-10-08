<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

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
 */
class NodeData {
	/**
	 * @var object|null The unserialized data-parsoid attribute
	 */
	public $parsoid;

	/**
	 * @var object|null The unserialized data-mw attribute
	 */
	public $mw;
}
