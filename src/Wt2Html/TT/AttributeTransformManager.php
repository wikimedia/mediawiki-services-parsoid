<?php
declare( strict_types = 1 );

namespace Parsoid\Wt2Html\TT;

use Parsoid\Tokens\KV;
use Parsoid\Utils\TokenUtils;
use Parsoid\Wt2Html\Frame;

/**
 * Utility transformation manager for expanding attributes
 * whose keys and/or values are not plain strings.
 */
class AttributeTransformManager {
	/**
	 * @var array
	 */
	private $options;

	/**
	 * @var Frame
	 */
	private $frame;

	/**
	 * Temporary holder for expanded KV values
	 * @var array
	 */
	private $expandedKVs;

	/**
	 * @param Frame $frame
	 * @param array $options
	 *  - bool inTemplate (reqd) Is this being invoked while processing a template?
	 *  - bool expandTemplates (reqd) Should we expand templates encountered here?
	 */
	public function __construct( Frame $frame, array $options ) {
		$this->options = $options;
		$this->frame = $frame;
		$this->expandedKVs = [];
	}

	private function processOne( KV $cur, int $i ): void {
		$k = $cur->k;
		$v = $cur->v;
		if ( $v === null ) {
			$cur->v = $v = '';
		}

		// fast path for string-only attributes
		if ( is_string( $k ) && is_string( $v ) ) {
			return;
		}

		$n = is_array( $v ) ? count( $v ) : -1;
		if ( $n > 1 || ( $n === 1 && !is_string( $v[0] ) ) ) {
			// transform the value
			$tokens = $this->frame->expand( $v, [
				'expandTemplates' => $this->options['expandTemplates'],
				'inTemplate' => $this->options['inTemplate'],
				'type' => 'tokens/x-mediawiki/expanded'
			] );
			$this->expandedKVs[] = [ 'index' => $i, 'v' => TokenUtils::stripEOFTkfromTokens( $tokens ) ];
		}

		$n = is_array( $k ) ? count( $k ) : -1;
		if ( $n > 1 || ( $n === 1 && !is_string( $k[0] ) ) ) {
			// transform the key
			$tokens = $this->frame->expand( $k, [
				'expandTemplates' => $this->options['expandTemplates'],
				'inTemplate' => $this->options['inTemplate'],
				'type' => 'tokens/x-mediawiki/expanded'
			] );
			$this->expandedKVs[] = [ 'index' => $i, 'k' => TokenUtils::stripEOFTkfromTokens( $tokens ) ];
		}
	}

	/**
	 * Expand both key and values of all key/value pairs. Used for generic
	 * (non-template) tokens in the AttributeExpander handler, which runs after
	 * templates are already expanded.
	 *
	 * @param KV[] $attributes
	 * @return KV[] expanded attributes
	 */
	public function process( array $attributes ): array {
		// Transform each argument (key and value).
		$i = 0;
		foreach ( $attributes as $attr ) {
			$this->processOne( $attr, $i++ );
		}

		$newKVs = [];
		$i = 0;
		foreach ( $attributes as $curr ) {
			$newKVs[$i++] = new KV( $curr->k, $curr->v, $curr->srcOffsets );
		}

		foreach ( $this->expandedKVs as $ekv ) {
			$i = $ekv['index'];
			if ( isset( $ekv['k'] ) ) {
				$newKVs[$i]->k = $ekv['k'];
			}
			if ( isset( $ekv['v'] ) ) {
				$newKVs[$i]->v = $ekv['v'];
			}
		}

		return $newKVs;
	}
}
