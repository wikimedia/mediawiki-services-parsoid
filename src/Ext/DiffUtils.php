<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

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

}
