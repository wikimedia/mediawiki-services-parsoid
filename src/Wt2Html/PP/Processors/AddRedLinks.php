<?php
declare( strict_types = 1 );

namespace Parsoid\Wt2Html\PP\Processors;

use DOMElement;
use Parsoid\Config\Env;
use Parsoid\Utils\DOMCompat;

class AddRedLinks {
	/**
	 * Add red links to a document.
	 *
	 * @param DOMElement $rootNode
	 * @param Env $env
	 */
	public static function run( DOMElement $rootNode, Env $env ): void {
		$wikiLinks = DOMCompat::querySelectorAll( $rootNode, 'a[rel~="mw:WikiLink"]' );

		$titles = array_reduce(
			$wikiLinks,
			function ( array $s, DOMElement $a ): array {
				// Magic links, at least, don't have titles
				if ( $a->hasAttribute( 'title' ) ) {
					$s[] = $a->getAttribute( 'title' );
				}
				return $s;
			},
			[]
		);

		if ( !$titles ) {
			return;
		}

		$titleMap = $env->getDataAccess()->getPageInfo( $env->getPageConfig(), $titles );

		foreach ( $wikiLinks as $a ) {
			if ( !$a->hasAttribute( 'title' ) ) {
				return;
			}
			$k = $a->getAttribute( 'title' );
			$data = $titleMap[$k] ?? null;
			if ( $data === null ) {
				$env->log( 'warn', 'We should have data for the title: ' . $k );
				return;
			}
			$a->removeAttribute( 'class' ); // Clear all
			if ( !empty( $data['missing'] ) && empty( $data['known'] ) ) {
				DOMCompat::getClassList( $a )->add( 'new' );
			}
			if ( !empty( $data['redirect'] ) ) {
				DOMCompat::getClassList( $a )->add( 'mw-redirect' );
			}
			// Jforrester suggests that, "ideally this'd be a registry so that
			// extensions could, er, extend this functionality – this is an
			// API response/CSS class that is provided by the Disambigutation
			// extension."
			if ( !empty( $data['disambiguation'] ) ) {
				DOMCompat::getClassList( $a )->add( 'mw-disambig' );
			}
		}
	}
}
