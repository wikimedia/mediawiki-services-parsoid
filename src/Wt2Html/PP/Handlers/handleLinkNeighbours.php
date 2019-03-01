<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

$DOMDataUtils = require '../../../utils/DOMDataUtils.js'::DOMDataUtils;
$DOMUtils = require '../../../utils/DOMUtils.js'::DOMUtils;
$WTUtils = require '../../../utils/WTUtils.js'::WTUtils;

$findAndHandleNeighbour = null; // forward declaration

/**
 * Function for fetching the link prefix based on a link node.
 *
 * The content will be reversed, so be ready for that.
 * @private
 */
function getLinkPrefix( $env, $node ) {
	global $WTUtils;
	global $findAndHandleNeighbour;
	$baseAbout = null;
	$regex = $env->conf->wiki->linkPrefixRegex;

	if ( !$regex ) {
		return null;
	}

	if ( $node !== null && WTUtils::hasParsoidAboutId( $node ) ) {
		$baseAbout = $node->getAttribute( 'about' );
	}

	$node = ( $node === null ) ? $node : $node->previousSibling;
	return $findAndHandleNeighbour( $env, false, $regex, $node, $baseAbout );
}

/**
 * Function for fetching the link trail based on a link node.
 * @private
 */
function getLinkTrail( $env, $node ) {
	global $WTUtils;
	global $findAndHandleNeighbour;
	$baseAbout = null;
	$regex = $env->conf->wiki->linkTrailRegex;

	if ( !$regex ) {
		return null;
	}

	if ( $node !== null && WTUtils::hasParsoidAboutId( $node ) ) {
		$baseAbout = $node->getAttribute( 'about' );
	}

	$node = ( $node === null ) ? $node : $node->nextSibling;
	return $findAndHandleNeighbour( $env, true, $regex, $node, $baseAbout );
}

/**
 * Abstraction of both link-prefix and link-trail searches.
 * @private
 */
$findAndHandleNeighbour = function ( $env, $goForward, $regex, $node, $baseAbout ) use ( &$DOMUtils, &$WTUtils ) {
	$value = null;
	$nextNode = ( $goForward ) ? 'nextSibling' : 'previousSibling';
	$innerNode = ( $goForward ) ? 'firstChild' : 'lastChild';
	$getInnerNeighbour = ( $goForward ) ? $getLinkTrail : $getLinkPrefix;
	$result = [ 'content' => [], 'src' => '' ];

	while ( $node !== null ) {
		$nextSibling = $node[ $nextNode ];
		$document = $node->ownerDocument;

		if ( DOMUtils::isText( $node ) ) {
			$matches = preg_match( $regex, $node->nodeValue );
			$value = [ 'content' => $node, 'src' => $node->nodeValue ];
			if ( $matches !== null ) {
				$value->src = $matches[ 0 ];
				if ( $value->src === $node->nodeValue ) {
					// entire node matches linkprefix/trail
					$value->content = $node;
					$node->parentNode->removeChild( $node );
				} else {
					// part of node matches linkprefix/trail
					$value->content = $document->createTextNode( $matches[ 0 ] );
					$node->parentNode->replaceChild( $document->createTextNode( str_replace( $regex, '', $node->nodeValue ) ), $node );
				}
			} else {
				$value->content = null;
				break;
			}
		} elseif ( WTUtils::hasParsoidAboutId( $node )
&& $baseAbout !== '' && $baseAbout !== null
&& $node->getAttribute( 'about' ) === $baseAbout
		) {
			$value = $getInnerNeighbour( $env, $node[ $innerNode ] );
		} else {
			break;
		}

		if ( $value->content !== null ) {
			if ( $value->content instanceof $Array ) {
				$result->content = $result->content->concat( $value->content );
			} else {
				$result->content[] = $value->content;
			}

			if ( $goForward ) {
				$result->src += $value->src;
			} else {
				$result->src = $value->src + $result->src;
			}

			if ( $value->src !== $node->nodeValue ) {
				break;
			}
		} else {
			break;
		}
		$node = $nextSibling;
	}

	return $result;
};

/**
 * Workhorse function for bringing linktrails and link prefixes into link content.
 * NOTE that this function mutates the node's siblings on either side.
 */
function handleLinkNeighbours( $node, $env ) {
	global $DOMDataUtils;
	global $WTUtils;
	$rel = $node->getAttribute( 'rel' ) || '';
	if ( !preg_match( '/^mw:WikiLink(\/Interwiki)?$/', $rel ) ) {
		return true;
	}

	$dp = DOMDataUtils::getDataParsoid( $node );
	$ix = null;
$dataMW = null;
	$prefix = getLinkPrefix( $env, $node );
	$trail = getLinkTrail( $env, $node );

	if ( $prefix && $prefix->content ) {
		for ( $ix = 0;  $ix < count( $prefix->content );  $ix++ ) {
			$node->insertBefore( $prefix->content[ $ix ], $node->firstChild );
		}
		if ( count( $prefix->src ) > 0 ) {
			$dp->prefix = $prefix->src;
			if ( preg_match( '/(?:^|\s)mw:Transclusion(?:\s|$)/', $node->getAttribute( 'typeof' ) ) ) {
				// only necessary if we're the first
				$dataMW = DOMDataUtils::getDataMw( $node );
				if ( $dataMW->parts ) { array_unshift( $dataMW->parts, $prefix->src );
	   }
			}
			if ( $dp->dsr ) {
				$dp->dsr[ 0 ] -= count( $prefix->src );
				$dp->dsr[ 2 ] += count( $prefix->src );
			}
		}
	}

	if ( $trail && $trail->content && count( $trail->content ) ) {
		for ( $ix = 0;  $ix < count( $trail->content );  $ix++ ) {
			$node->appendChild( $trail->content[ $ix ] );
		}
		if ( count( $trail->src ) > 0 ) {
			$dp->tail = $trail->src;
			$about = $node->getAttribute( 'about' );
			if ( WTUtils::hasParsoidAboutId( $node )
&& count( WTUtils::getAboutSiblings( $node, $about ) ) === 1
			) {
				// search back for the first wrapper but
				// only if we're the last. otherwise can assume
				// template encapsulation will handle it
				$wrapper = WTUtils::findFirstEncapsulationWrapperNode( $node );
				if ( $wrapper !== null
&& preg_match( '/(?:^|\s)mw:Transclusion(?:\s|$)/', $wrapper->getAttribute( 'typeof' ) )
				) {
					$dataMW = DOMDataUtils::getDataMw( $wrapper );
					if ( $dataMW->parts ) { $dataMW->parts[] = $trail->src;
		   }
				}
			}
			if ( $dp->dsr ) {
				$dp->dsr[ 1 ] += count( $trail->src );
				$dp->dsr[ 3 ] += count( $trail->src );
			}
		}
		// indicate that the node's tail siblings have been consumed
		return $node;
	} else {
		return true;
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->handleLinkNeighbours = $handleLinkNeighbours;
}
