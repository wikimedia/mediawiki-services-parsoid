<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Wt2Html\Frame;

/**
 * Utility transformation manager for expanding attributes
 * whose keys and/or values are not plain strings.
 */
class AttributeTransformManager {
	/**
	 * Expand both key and values of all key/value pairs. Used for generic
	 * (non-template) tokens in the AttributeExpander handler, which runs after
	 * templates are already expanded.
	 *
	 * @param Frame $frame
	 * @param array $options
	 *  - bool inTemplate (reqd) Is this being invoked while processing a template?
	 *  - bool expandTemplates (reqd) Should we expand templates encountered here?
	 * @param KV[] $attributes
	 * @return ?KV[] expanded attributes
	 */
	public static function process( Frame $frame, array $options, array $attributes ): ?array {
		$expanded = false;

		// Transform each argument (key and value).
		foreach ( $attributes as &$cur ) {
			$k = $cur->k;
			$v = $cur->v;
			if ( $cur->v === null ) {
				$cur->v = $v = '';
			}

			// fast path for string-only attributes
			if ( is_string( $k ) && is_string( $v ) ) {
				continue;
			}

			$expandV = false;
			if ( is_array( $v ) ) {
				foreach ( $v as $vv ) {
					if ( !is_string( $vv ) ) {
						$expandV = true;
						break;
					}
				}

				if ( $expandV ) {
					// transform the value
					$v = $frame->expand( $v, [
						'attrExpansion' => true,
						'expandTemplates' => $options['expandTemplates'],
						'inTemplate' => $options['inTemplate'],
						'srcOffsets' => $cur->srcOffsets->value,
					] );
				}
			}

			$expandK = false;
			if ( is_array( $k ) ) {
				foreach ( $k as $kk ) {
					if ( !is_string( $kk ) ) {
						$expandK = true;
						break;
					}
				}

				if ( $expandK ) {
					// transform the key
					$k = $frame->expand( $k, [
						'attrExpansion' => true,
						'expandTemplates' => $options['expandTemplates'],
						'inTemplate' => $options['inTemplate'],
						'srcOffsets' => $cur->srcOffsets->key,
					] );
				}
			}

			if ( $expandK || $expandV ) {
				$expanded = true;
				$cur = new KV( $k, $v, $cur->srcOffsets );
			}
		}

		return $expanded ? $attributes : null;
	}
}
