<?php
declare( strict_types = 1 );

namespace Parsoid\Wt2Html\TT;

use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\TokenUtils;

/**
 * Simple noinclude / onlyinclude implementation.
 * Strips all tokens in noinclude sections.
 */
class IncludeOnly extends TokenCollector {
	/**
	 * IncludeOnly constructor.
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
		return 'includeonly';
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
		return false;
	}

	/**
	 * @param array $collection
	 * @return array
	 */
	public function transformation( array $collection ): array {
		$start = array_shift( $collection );

		// Handle self-closing tag case specially!
		if ( TokenUtils::getTokenType( $start ) === 'SelfclosingTagTk' ) {
			$token = TokenCollector::buildMetaToken( $this->manager, 'mw:Includes/IncludeOnly',
				false, ( $start->dataAttribs ?? (object)[ 'tsr' => [ null, null ] ] )->tsr, null );
			if ( $start->dataAttribs->src ) {
				$datamw = PHPUtils::jsonEncode( [ 'src' => $start->dataAttribs->src ] );
				$token->addAttribute( 'data-mw', $datamw );
			}
			return ( $this->options['isInclude'] ) ?
			[ 'tokens' => [] ] :
			[ 'tokens' => [ $token ] ];
		}

		$tokens = [];
		$end = array_pop( $collection );
		$eof = TokenUtils::getTokenType( $end ) === 'EOFTk';

		if ( $this->options['isInclude'] ) {
			// Just pass through the full collection including delimiters
			$tokens = array_merge( $tokens, $collection );
		} elseif ( !isset( $this->options['inTemplate'] ) ) {
			// Content is stripped
			// Add meta tags for open and close for roundtripping.
			//
			// We can make do entirely with a single meta-tag since
			// there is no real content.  However, we add a dummy end meta-tag
			// so that all <*include*> meta tags show up in open/close pairs
			// and can be handled similarly by downstream handlers.
			$name = 'mw:Includes/IncludeOnly';
			$tokens[] = TokenCollector::buildStrippedMetaToken( $this->manager, $name,
				$start, ( $eof ) ? null : $end );

			if ( $start->dataAttribs->src ) {
				$dataMw = PHPUtils::jsonEncode( [ 'src' => $start->dataAttribs->src ] );
				$tokens[ 0 ]->addAttribute( 'data-mw', $dataMw );
			}

			if ( $end && !$eof ) {
				// This token is just a placeholder for RT purposes. Since the
				// stripped token (above) got the entire tsr value, we are artificially
				// setting the tsr on this node to zero-width to ensure that
				// DSR computation comes out correct.
				$tsr = ( $end->dataAttribs ?? (object)[ 'tsr' => [ null, null ] ] )->tsr;
				$tokens[] = TokenCollector::buildMetaToken( $this->manager, $name,
					true, [ $tsr[ 1 ], $tsr[ 1 ] ], null );
			}
		}

		// Preserve EOF
		if ( $eof ) {
			$tokens[] = $end;
		}

		return [ 'tokens' => $tokens ];
	}
}
