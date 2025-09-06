<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

/**
 * Merge strategies to use for ContentMetadataCollectors.
 *
 * Strategies should be order-independent, so that portions of the
 * final metadata can be generated and combined in any order.
 */
enum MergeStrategy: string {

	/**
	 * "Union" merge strategy means that values are strings, stored as
	 * a set, and exposed as a PHP associative array mapping from
	 * values to `true`.
	 */
	case UNION = 'union';

	/**
	 * "Sum" merge strategy means that values are integers and
	 * are summed to make the final ParserOutput.
	 */
	case SUM = 'sum';
}
