<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMUtils as DOMUtils;

class DedupeStyles {
	public static function dedupe( $node, $env ) {
		if ( !$env->styleTagKeys ) {
			$env->styleTagKeys = new Set();
		}

		if ( !$node->hasAttribute( 'data-mw-deduplicate' ) ) {
			// Not a templatestyles <style> tag
			return true;
		}
		$key = $node->getAttribute( 'data-mw-deduplicate' );

		if ( !$env->styleTagKeys->has( $key ) ) {
			// Not a dupe
			$env->styleTagKeys->add( $key );
			return true;
		}

		if ( !DOMUtils::isFosterablePosition( $node ) ) {
			// Dupe - replace with a placeholder <link> reference
			$link = $node->ownerDocument->createElement( 'link' );
			$link->setAttribute( 'rel', 'mw-deduplicated-inline-style' );
			$link->setAttribute( 'href', 'mw-data:' . $key );
			$link->setAttribute( 'about', $node->getAttribute( 'about' ) );
			$link->setAttribute( 'typeof', $node->getAttribute( 'typeof' ) );
			DOMDataUtils::setDataParsoid( $link, DOMDataUtils::getDataParsoid( $node ) );
			DOMDataUtils::setDataMw( $link, DOMDataUtils::getDataMw( $node ) );
			$node->parentNode->replaceChild( $link, $node );
			return $link;
		} else {
			$env->log( 'info/wt2html/templatestyle',
				'Duplicate style tag found in fosterable position. '
. 'Not deduping it, but emptying out the style tag for performance reasons.'
			);
			$node->innerHTML = '';
			return true;
		}
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->DedupeStyles = $DedupeStyles;
}
