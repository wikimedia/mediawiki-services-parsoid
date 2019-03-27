<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMUtils as DOMUtils;
use Parsoid\Util as Util;
use Parsoid\WTUtils as WTUtils;

class PrepareDOM {
	/**
	 * Migrate data-parsoid attributes into a property on each DOM node.
	 * We may migrate them back in the final DOM traversal.
	 *
	 * Various mw metas are converted to comments before the tree build to
	 * avoid fostering. Piggy-backing the reconversion here to avoid excess
	 * DOM traversals.
	 */
	public static function prepareDOM( $seenDataIds, $node, $env ) {
		if ( DOMUtils::isElt( $node ) ) {
			// Deduplicate docIds that come from splitting nodes because of
			// content model violations when treebuilding.
			$docId = $node->getAttribute( DOMDataUtils\DataObjectAttrName() );
			if ( $docId !== null ) {
				if ( $seenDataIds->has( $docId ) ) {
					$data = DOMDataUtils::getNodeData( $node );
					DOMDataUtils::setNodeData( $node, Util::clone( $data, true ) );
				} else {
					$seenDataIds->add( $docId );
				}
			}
			// Set title to display when present (last one wins).
			if ( $node->nodeName === 'META'
&& $node->getAttribute( 'property' ) === 'mw:PageProp/displaytitle'
			) {
				$env->page->meta->displayTitle = $node->getAttribute( 'content' );
			}
			return true;
		}
		$meta = WTUtils::reinsertFosterableContent( $env, $node, false );
		return ( $meta !== null ) ? $meta : true;
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->PrepareDOM = $PrepareDOM;
}
