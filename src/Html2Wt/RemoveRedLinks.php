<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt;

use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMCompat;

class RemoveRedLinks {

	/**
	 * Remove redlinks from a document
	 * @param Element $root
	 */
	public function run( Node $root ): void {
		'@phan-var Element|DocumentFragment $root';  // @var Element|DocumentFragment $root
		$wikilinks = DOMCompat::querySelectorAll( $root, 'a[rel~="mw:WikiLink"]' );
		foreach ( $wikilinks as $a ) {
			$href = $a->getAttribute( 'href' );
			$qmPos = strpos( $href, '?' );
			if ( $qmPos !== false ) {
				$queryParams = parse_url( $href, PHP_URL_QUERY );
				// TODO this mitigates a bug in the AddRedLinks pass, which puts the query
				// parameters AFTER a fragment; the parse_url then interprets these query parameters
				// as part of the fragment. T227693 is somewhat related; let's deal with that as a
				// separate issue.
				if ( $queryParams === null ) {
					$href = str_replace(
						[ '?action=edit&redlink=1', '?action=edit&amp;redlink=1',
							'&action=edit&redlink=1', '&amp;action=edit&amp;redlink=1' ],
						[ '','','','' ],
						$href
					);
				} else {
					$args = [];
					parse_str( $queryParams, $args );
					if ( isset( $args['action'] ) && $args['action'] === 'edit' ) {
						unset( $args['action'] );
					}
					if ( isset( $args['redlink'] ) && $args['redlink'] === '1' ) {
						unset( $args['redlink'] );
					}

					// NOTE: This might modify the order of the arguments in the query; if URL
					// are compared with a string equality comparison, it might break.
					$newQueryParams = http_build_query( $args );

					// I actually want http_build_url, but I *probably* don't want to add a
					// dependency to pecl_http.
					if ( $queryParams !== $newQueryParams ) {
						if ( $newQueryParams !== '' ) {
							$href = str_replace( $queryParams, $newQueryParams, $href );
						} else {
							$href = str_replace( '?' . $queryParams, '', $href );
						}
					}
				}
				$a->setAttribute( 'href', $href );
			}
		}
	}
}
