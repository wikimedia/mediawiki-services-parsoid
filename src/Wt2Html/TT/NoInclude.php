<?php
declare( strict_types = 1 );

/**
 * Simple noinclude implementation. Strips all tokens in
 * noinclude sections.
 */

namespace Parsoid\Wt2Html\TT;

use Parsoid\Utils\TokenUtils;

/**
 * @class
 */
class NoInclude extends TokenCollector {
	/**
	 * NoInclude constructor.
	 * @param object $manager manager environment
	 * @param array $options options
	 */
	public function __construct( $manager, array $options ) {
		parent::__construct( $manager, $options );
	}

	/**
	 * @return string
	 */
	public function type(): string {
		return 'tag';
	}

	/**
	 * @return string
	 */
	public function name(): string {
		return 'noinclude';
	}

	/**
	 * @return bool
	 */
	public function toEnd(): bool {
		return true;    // Match the end-of-input if </noinclude> is missing.
	}

	/**
	 * @return bool
	 */
	public function ackEnd(): bool {
		return true;
	}

	/**
	 * @param array $collection
	 * @return array
	 */
	public function transformation( array $collection ): array {
		$start = array_shift( $collection );
		$sc = TokenUtils::getTokenType( $start );

		// A stray end tag.
		if ( $sc === 'EndTagTk' ) {
			$meta = TokenCollector::buildMetaToken( $this->manager, 'mw:Includes/NoInclude',
				true, ( $start->dataAttribs->tsr ?? null ), null );
			return [ 'tokens' => [ $meta ] ];
		}

		// Handle self-closing tag case specially!
		if ( $sc === 'SelfclosingTagTk' ) {
			return ( $this->options['isInclude'] ) ?
			[ 'tokens' => [] ] :
			[ 'tokens' => [ TokenCollector::buildMetaToken( $this->manager, 'mw:Includes/NoInclude',
				false, ( $start->dataAttribs->tsr ?? null ), null ) ] ];
		}

		$tokens = [];
		$end = array_pop( $collection );
		$eof = TokenUtils::getTokenType( $end ) === 'EOFTk';

		if ( empty( $this->options['isInclude'] ) ) {
			// Content is preserved
			// Add meta tags for open and close
			$startTSR = $start->dataAttribs->tsr ?? null;
			$endTSR = $end->dataAttribs->tsr ?? null;
			$tokens[] = TokenCollector::buildMetaToken( $this->manager, 'mw:Includes/NoInclude',
				false, $startTSR, null );

			$tokens = array_merge( $tokens, $collection );
			if ( $end && !$eof ) {
				$tokens[] = TokenCollector::buildMetaToken( $this->manager, 'mw:Includes/NoInclude',
					true, $endTSR, null );
			}
		} elseif ( empty( $this->options['inTemplate'] ) ) {
			// Content is stripped
			$tokens[] = TokenCollector::buildStrippedMetaToken( $this->manager,
				'mw:Includes/NoInclude', $start, $end );
		}

		// Preserve EOF
		if ( $eof ) {
			$tokens[] = $end;
		}

		return [ 'tokens' => $tokens ];
	}
}
