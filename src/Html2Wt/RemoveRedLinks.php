<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt;

use Wikimedia\Parsoid\Core\DOMCompat;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\UrlUtils;

class RemoveRedLinks {
	/**
	 * Remove redlinks from a document
	 */
	public static function handler( Node $a ): bool {
		'@phan-var Element $a';
		if ( DOMUtils::matchRel( $a, '#mw:WikiLink#' ) &&
			DOMCompat::getClassList( $a )->contains( 'new' )
		) {
			$href = DOMCompat::getAttribute( $a, 'href' );
			$qmPos = strpos( $href ?? '', '?' );
			if ( $qmPos !== false ) {
				$parsedURL = UrlUtils::parseUrl( $href );
				if ( isset( $parsedURL['query'] ) ) {
					$queryParams = $parsedURL['query'];
					$queryElts = [];
					parse_str( $queryParams, $queryElts );
					if ( isset( $queryElts['action'] ) && $queryElts['action'] === 'edit' ) {
						unset( $queryElts['action'] );
					}
					if ( isset( $queryElts['redlink'] ) && $queryElts['redlink'] === '1' ) {
						unset( $queryElts['redlink'] );
					}

					// My understanding of this method and of PHP array handling makes me
					// believe that the order of the parameters should not be modified here.
					// There is however no guarantee whatsoever in the documentation or spec
					// of these methods.

					if ( count( $queryElts ) === 0 ) {
						// avoids the insertion of ? on empty query string
						$parsedURL['query'] = null;
					} else {
						$parsedURL['query'] = http_build_query( $queryElts );
					}
					$href = UrlUtils::assembleUrl( $parsedURL );
				}
				$a->setAttribute( 'href', $href );
			}
		}

		return true;
	}
}
