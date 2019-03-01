<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * @module
 */

namespace Parsoid;

use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMUtils as DOMUtils;

class DiffUtils {
	/**
	 * Get a node's diff marker.
	 *
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 * @return Object|null
	 */
	public static function getDiffMark( $node, $env ) {
		if ( !DOMUtils::isElt( $node ) ) { return null;
  }
		$data = DOMDataUtils::getNodeData( $node );
		$dpd = $data[ 'parsoid-diff' ];
		return ( $dpd && $dpd->id === $env->page->id ) ? $dpd : null;
	}

	/**
	 * Check that the diff markers on the node exist and are recent.
	 *
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 */
	public static function hasDiffMarkers( $node, $env ) {
		return $this->getDiffMark( $node, $env ) !== null || DOMUtils::isDiffMarker( $node );
	}

	public static function hasDiffMark( $node, $env, $mark ) {
		// For 'deletion' and 'insertion' markers on non-element nodes,
		// a mw:DiffMarker meta is added
		if ( $mark === 'deleted' || ( $mark === 'inserted' && !DOMUtils::isElt( $node ) ) ) {
			return DOMUtils::isDiffMarker( $node->previousSibling, $mark );
		} else {
			$diffMark = $this->getDiffMark( $node, $env );
			return $diffMark && array_search( $mark, $diffMark->diff ) >= 0;
		}
	}

	public static function hasInsertedDiffMark( $node, $env ) {
		return $this->hasDiffMark( $node, $env, 'inserted' );
	}

	public static function maybeDeletedNode( $node ) {
		return $node && DOMUtils::isElt( $node ) && DOMUtils::isDiffMarker( $node, 'deleted' );
	}

	/**
	 * Is node a mw:DiffMarker node that represents a deleted block node?
	 * This annotation is added by the DOMDiff pass.
	 */
	public static function isDeletedBlockNode( $node ) {
		return $this->maybeDeletedNode( $node ) && $node->hasAttribute( 'data-is-block' );
	}

	public static function directChildrenChanged( $node, $env ) {
		return $this->hasDiffMark( $node, $env, 'children-changed' );
	}

	public static function onlySubtreeChanged( $node, $env ) {
		$dmark = $this->getDiffMark( $node, $env );
		return $dmark && $dmark->diff->every( function /* subTreechangeMarker */( $mark ) {
					return $mark === 'subtree-changed' || $mark === 'children-changed';
		}
			);
	}

	public static function addDiffMark( $node, $env, $mark ) {
		if ( $mark === 'deleted' || $mark === 'moved' ) {
			$this->prependTypedMeta( $node, 'mw:DiffMarker/' . $mark );
		} elseif ( DOMUtils::isText( $node ) || DOMUtils::isComment( $node ) ) {
			if ( $mark !== 'inserted' ) {
				$env->log( 'error', 'BUG! CHANGE-marker for ', $node->nodeType, ' node is: ', $mark );
			}
			$this->prependTypedMeta( $node, 'mw:DiffMarker/' . $mark );
		} else {
			$this->setDiffMark( $node, $env, $mark );
		}
	}

	/**
	 * Set a diff marker on a node.
	 *
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 * @param {string} change
	 */
	public static function setDiffMark( $node, $env, $change ) {
		if ( !DOMUtils::isElt( $node ) ) { return;
  }
		$dpd = $this->getDiffMark( $node, $env );
		if ( $dpd ) {
			// Diff is up to date, append this change if it doesn't already exist
			if ( array_search( $change, $dpd->diff ) === -1 ) {
				$dpd->diff[] = $change;
			}
		} else {
			// Was an old diff entry or no diff at all, reset
			$dpd = [
				// The base page revision this change happened on
				'id' => $env->page->id,
				'diff' => [ $change ]
			];
		}
		DOMDataUtils::getNodeData( $node )[ 'parsoid-diff' ] = $dpd;
	}

	/**
	 * Store a diff marker on a node in a data attibute.
	 * Only to be used for dumping.
	 *
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 */
	public static function storeDiffMark( $node, $env ) {
		$dpd = $this->getDiffMark( $node, $env );
		if ( $dpd ) {
			DOMDataUtils::setJSONAttribute( $node, 'data-parsoid-diff', $dpd );
		}
	}

	/**
	 * Insert a meta element with the passed-in typeof attribute before a node.
	 *
	 * @param {Node} node
	 * @param {string} type
	 * @return Element The new meta.
	 */
	public static function prependTypedMeta( $node, $type ) {
		$meta = $node->ownerDocument->createElement( 'meta' );
		$meta->setAttribute( 'typeof', $type );
		$node->parentNode->insertBefore( $meta, $node );
		return $meta;
	}

	/**
	 * Attribute equality test.
	 * @param {Node} nodeA
	 * @param {Node} nodeB
	 * @param {Set} [ignoreableAttribs] Set of attributes that should be ignored.
	 * @param {Map} [specializedAttribHandlers] Map of attributes with specialized equals handlers.
	 */
	public static function attribsEquals( $nodeA, $nodeB, $ignoreableAttribs, $specializedAttribHandlers ) {
		if ( !$ignoreableAttribs ) {
			$ignoreableAttribs = new Set();
		}
		if ( !$specializedAttribHandlers ) {
			$specializedAttribHandlers = new Map();
		}

		function arrayToHash( $node ) use ( &$ignoreableAttribs, &$DOMDataUtils ) {
			$attrs = $node->attributes || [];
			$h = [];
			$count = 0;
			for ( $j = 0,  $n = count( $attrs );  $j < $n;  $j++ ) {
				$a = $attrs->item( $j );
				if ( !$ignoreableAttribs->has( $a->name ) ) {
					$count++;
					$h[ $a->name ] = $a->value;
				}
			}
			// If there's no special attribute handler, we want a straight
			// comparison of these.
			if ( !$ignoreableAttribs->has( 'data-parsoid' ) ) {
				$h[ 'data-parsoid' ] = DOMDataUtils::getDataParsoid( $node );
				$count++;
			}
			if ( !$ignoreableAttribs->has( 'data-mw' ) && DOMDataUtils::validDataMw( $node ) ) {
				$h[ 'data-mw' ] = DOMDataUtils::getDataMw( $node );
				$count++;
			}
			return [ 'h' => $h, 'count' => $count ];
		}

		$xA = arrayToHash( $nodeA );
		$xB = arrayToHash( $nodeB );

		if ( $xA->count !== $xB->count ) {
			return false;
		}

		$hA = $xA->h;
		$keysA = Object::keys( $hA )->sort();
		$hB = $xB->h;
		$keysB = Object::keys( $hB )->sort();

		for ( $i = 0;  $i < $xA->count;  $i++ ) {
			$k = $keysA[ $i ];
			if ( $k !== $keysB[ $i ] ) {
				return false;
			}

			$attribEquals = $specializedAttribHandlers->get( $k );
			if ( $attribEquals ) {
				// Use a specialized compare function, if provided
				if ( !$hA[ $k ] || !$hB[ $k ] || !$attribEquals( $nodeA, $hA[ $k ], $nodeB, $hB[ $k ] ) ) {
					return false;
				}
			} elseif ( $hA[ $k ] !== $hB[ $k ] ) {
				return false;
			}
		}

		return true;
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->DiffUtils = $DiffUtils;
}
