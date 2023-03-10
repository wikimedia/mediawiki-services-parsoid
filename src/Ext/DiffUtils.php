<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Html2Wt\DiffUtils as DU;

/**
 */
class DiffUtils {

	/**
	 * Check a node to see whether it's a diff marker.
	 *
	 * @param ?Node $node
	 * @param ?string $mark
	 * @return bool
	 */
	public static function isDiffMarker(
		?Node $node, ?string $mark = null
	): bool {
		return DU::isDiffMarker( $node, $mark );
	}

	/**
	 * Check that the diff markers on the node exist.
	 *
	 * @param Node $node
	 * @return bool
	 */
	public static function hasDiffMarkers( Node $node ): bool {
		return DU::hasDiffMarkers( $node );
	}

	/**
	 * @param Element $node
	 * @return bool
	 */
	public static function subtreeUnchanged( Element $node ): bool {
		return DU::subtreeUnchanged( $node );
	}

}
