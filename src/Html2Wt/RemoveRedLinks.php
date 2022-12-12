<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMCompat;

class RemoveRedLinks {

	/**
	 * Remove redlinks from a document
	 * @param Element $root
	 * @param Env $env
	 */
	public function run( Node $root, Env $env ): void {
		'@phan-var Element|DocumentFragment $root';  // @var Element|DocumentFragment $root
		$wikilinks = DOMCompat::querySelectorAll( $root, 'a[rel~="mw:WikiLink"]' );
		foreach ( $wikilinks as $a ) {
			$href = $a->getAttribute( 'href' );
			$qmPos = strpos( $href, '?' );
			if ( $qmPos !== false ) {
				$queryParams = parse_url( $href, PHP_URL_QUERY );
				if ( $queryParams === null ) {
					// TODO this mitigates a bug in the AddRedLinks pass, which puts the query
					// parameters AFTER a fragment; the parse_url then interprets these query parameters
					// as part of the fragment.
					// 2022-12-01: That issue is solved in the "wt2html" direction, but some
					// RESTBase-stored content may still exist, so we'll have to remove this when
					// 2.7.0 is not longer being stored.
					$href = str_replace(
						[ '?action=edit&redlink=1', '?action=edit&amp;redlink=1',
							'&action=edit&redlink=1', '&amp;action=edit&amp;redlink=1' ],
						[ '', '', '', '' ],
						$href
					);
				} else {
					if ( $queryParams === false ) {
						$env->log( 'error/html2wt/link', 'Unhandled URL',
							$href, 'in red link removal' );
						$queryParams = '';
					}
					$args = [];
					parse_str( $queryParams, $args );
					if ( isset( $args['action'] ) && $args['action'] === 'edit' ) {
						unset( $args['action'] );
					}
					if ( isset( $args['redlink'] ) && $args['redlink'] === '1' ) {
						unset( $args['redlink'] );
					}

					// My understanding of this method and of PHP array handling makes me
					// believe that the order of the parameters should not be modified here.
					// There is however no guarantee whatsoever in the documentation or spec
					// of these methods.
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
