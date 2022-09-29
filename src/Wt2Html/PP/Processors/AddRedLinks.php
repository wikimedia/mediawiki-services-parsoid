<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class AddRedLinks implements Wt2HtmlDOMProcessor {
	/**
	 * Add red links to a document.
	 *
	 * @inheritDoc
	 */
	public function run(
		Env $env, Node $root, array $options = [], bool $atTopLevel = false
	): void {
		'@phan-var Element|DocumentFragment $root';  // @var Element|DocumentFragment $root
		$allLinks = DOMCompat::querySelectorAll( $root, 'a[rel~="mw:WikiLink"]' );

		if ( !is_array( $allLinks ) ) {
			// This is not reachable at present: DOMCompat says it can be
			// iterable but Zest always returns an array.
			$array = [];
			foreach ( $allLinks as $link ) {
				$array[] = $link;
			}
			$allLinks = $array;
		}

		// Split up processing into chunks of 1000 so that we don't exceed LinkCache::MAX_SIZE
		$chunks = array_chunk( $allLinks, 1000 );
		foreach ( $chunks as $links ) {
			$titles = [];
			foreach ( $links as $a ) {
				if ( $a->hasAttribute( 'title' ) ) {
					$titles[$a->getAttribute( 'title' )] = true;
				}
			}

			if ( !$titles ) {
				return;
			}

			$start = microtime( true );
			$titleMap = $env->getDataAccess()->getPageInfo( $env->getPageConfig(), array_keys( $titles ) );
			if ( $env->profiling() ) {
				$profile = $env->getCurrentProfile();
				$profile->bumpMWTime( "RedLinks", 1000 * ( microtime( true ) - $start ), "api" );
				$profile->bumpCount( "RedLinks" );
			}

			foreach ( $links as $a ) {
				if ( !$a->hasAttribute( 'title' ) ) {
					continue;
				}
				$k = $a->getAttribute( 'title' );
				if ( empty( $titleMap[$k] ) ) {
					// Likely a consequence of T237535; can be removed once
					// that is fixed.
					$env->log( 'warn', 'We should have data for the title: ' . $k );
					continue;
				}
				$data = $titleMap[$k];
				$a->removeAttribute( 'class' ); // Clear all
				if (
					!empty( $data['missing'] ) && empty( $data['known'] ) &&
					$k !== $env->getPageConfig()->getTitle()
				) {
					DOMCompat::getClassList( $a )->add( 'new' );
					WTUtils::addPageContentI18nAttribute( $a, 'title', 'red-link-title', [ $k ] );
					$href = $a->getAttribute( 'href' );
					$qmIndex = strpos( $href, '?' );
					if ( $qmIndex !== false ) {
						$urlParams = substr( $href, $qmIndex );
						// We check that it hadn't been added yet so that this pass is idempotent
						// This is particularly relevant for the pb2pb usecase - if the checks are
						// not in, calling pb2pb on HTML that already has redlinks (or calling
						// pb2pb repeatedly) will add multiple redlink markers here.
						if ( !str_contains( $urlParams, 'action=edit' ) ) {
							$href .= '&action=edit';
						}
						if ( !str_contains( $urlParams, 'redlink=1' ) ) {
							$href .= '&redlink=1';
						}
					} else {
						$href .= '?action=edit&redlink=1';
					}
					$a->setAttribute( 'href', $href );
				}
				if ( !empty( $data['redirect'] ) ) {
					DOMCompat::getClassList( $a )->add( 'mw-redirect' );
				}
				foreach ( $data['linkclasses'] ?? [] as $extraClass ) {
					DOMCompat::getClassList( $a )->add( $extraClass );
				}
			}
		}
	}
}
