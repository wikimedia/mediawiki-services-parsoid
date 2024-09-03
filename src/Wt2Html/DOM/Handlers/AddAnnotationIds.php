<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Handlers;

use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DTState;
use Wikimedia\Parsoid\Utils\WTUtils;

class AddAnnotationIds {
	/**
	 * @return bool|Node
	 */
	public static function handler( Element $node, DTState $state ) {
		$abouts = &$state->abouts;
		$abouts ??= [];
		$isStart = false;
		// isStart gets modified (not read) by extractAnnotationType
		$t = WTUtils::extractAnnotationType( $node, $isStart );
		if ( $t !== null ) {
			$about = null;
			if ( $isStart ) {
				// The 'mwa' prefix is specific to annotations;
				// if other DOM ranges are to use this mechanism, another prefix
				// should be used.
				$about = $state->env->newAnnotationId();
				if ( !array_key_exists( $t, $abouts ) ) {
					$abouts[$t] = [];
				}
				array_push( $abouts[$t], $about );
			} else {
				if ( array_key_exists( $t, $abouts ) ) {
					$about = array_pop( $abouts[$t] );
				}
			}
			if ( $about === null ) {
				// this doesn't have a start tag, so we don't handle it when creating
				// annotation ranges, and we replace it with a string
				$textAnn = $node->ownerDocument->createTextNode( '</' . $t . '>' );
				$parentNode = $node->parentNode;
				$parentNode->insertBefore( $textAnn, $node );
				DOMCompat::remove( $node );
				return $textAnn;
			}
			DOMDataUtils::getDataMw( $node )->rangeId = $about;
		}
		return true;
	}
}
