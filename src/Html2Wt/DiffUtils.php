<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt;

use stdClass;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Comment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\DOM\Text;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;

class DiffUtils {
	/**
	 * Get a node's diff marker.
	 *
	 * @param Node $node
	 * @param Env $env
	 * @return stdClass|null
	 */
	public static function getDiffMark( Node $node, Env $env ): ?stdClass {
		if ( !( $node instanceof Element ) ) {
			return null;
		}

		$data = DOMDataUtils::getNodeData( $node );
		$dpd = $data->parsoid_diff ?? null;
		return ( $dpd && $dpd->id === $env->getPageConfig()->getPageId() ) ? $dpd : null;
	}

	/**
	 * Check that the diff markers on the node exist and are recent.
	 *
	 * @param Node $node
	 * @param Env $env
	 * @return bool
	 */
	public static function hasDiffMarkers( Node $node, Env $env ): bool {
		return self::getDiffMark( $node, $env ) !== null || DOMUtils::isDiffMarker( $node );
	}

	/**
	 * @param Node $node
	 * @param Env $env
	 * @param string $mark
	 * @return bool
	 */
	public static function hasDiffMark( Node $node, Env $env, string $mark ): bool {
		// For 'deletion' and 'insertion' markers on non-element nodes,
		// a mw:DiffMarker meta is added
		if ( $mark === 'deleted' || ( $mark === 'inserted' && !( $node instanceof Element ) ) ) {
			return DOMUtils::isDiffMarker( $node->previousSibling, $mark );
		} else {
			$diffMark = self::getDiffMark( $node, $env );
			return $diffMark && array_search( $mark, $diffMark->diff, true ) !== false;
		}
	}

	/**
	 * @param Node $node
	 * @param Env $env
	 * @return bool
	 */
	public static function hasInsertedDiffMark( Node $node, Env $env ): bool {
		return self::hasDiffMark( $node, $env, 'inserted' );
	}

	/**
	 * @param ?Node $node
	 * @return bool
	 */
	public static function maybeDeletedNode( ?Node $node ): bool {
		return $node instanceof Element && DOMUtils::isDiffMarker( $node, 'deleted' );
	}

	/**
	 * Is node a mw:DiffMarker node that represents a deleted block node?
	 * This annotation is added by the DOMDiff pass.
	 *
	 * @param ?Node $node
	 * @return bool
	 */
	public static function isDeletedBlockNode( ?Node $node ): bool {
		return $node instanceof Element && self::maybeDeletedNode( $node ) &&
			$node->hasAttribute( 'data-is-block' );
	}

	/**
	 * @param Node $node
	 * @param Env $env
	 * @return bool
	 */
	public static function directChildrenChanged( Node $node, Env $env ): bool {
		return self::hasDiffMark( $node, $env, 'children-changed' );
	}

	/**
	 * @param Element $node
	 * @param Env $env
	 * @return bool
	 */
	public static function onlySubtreeChanged( Element $node, Env $env ): bool {
		$dmark = self::getDiffMark( $node, $env );
		if ( !$dmark ) {
			return false;
		}

		foreach ( $dmark->diff as $mark ) {
			if ( $mark !== 'subtree-changed' && $mark !== 'children-changed' ) {
				return false;
			}
		}

		return true;
	}

	/**
	 * @param Node $node
	 * @param Env $env
	 * @param string $mark
	 */
	public static function addDiffMark( Node $node, Env $env, string $mark ): void {
		if ( $mark === 'deleted' || $mark === 'moved' ) {
			self::prependTypedMeta( $node, 'mw:DiffMarker/' . $mark );
		} elseif ( $node instanceof Text || $node instanceof Comment ) {
			if ( $mark !== 'inserted' ) {
				$env->log( 'error', 'BUG! CHANGE-marker for ', $node->nodeType, ' node is: ', $mark );
			}
			self::prependTypedMeta( $node, 'mw:DiffMarker/' . $mark );
		} else {
			self::setDiffMark( $node, $env, $mark );
		}
	}

	/**
	 * Set a diff marker on a node.
	 *
	 * @param Node $node
	 * @param Env $env
	 * @param string $change
	 */
	public static function setDiffMark( Node $node, Env $env, string $change ): void {
		if ( !( $node instanceof Element ) ) {
			return;
		}

		$dpd = self::getDiffMark( $node, $env );
		if ( $dpd ) {
			// Diff is up to date, append this change if it doesn't already exist
			if ( array_search( $change, $dpd->diff, true ) === false ) {
				$dpd->diff[] = $change;
			}
		} else {
			// Was an old diff entry or no diff at all, reset
			$dpd = (object)[ // FIXME object or array?
				// The base page revision this change happened on
				'id' => $env->getPageConfig()->getPageId(),
				'diff' => [ $change ]
			];
		}
		DOMDataUtils::getNodeData( $node )->parsoid_diff = $dpd;
	}

	/**
	 * Insert a meta element with the passed-in typeof attribute before a node.
	 *
	 * @param Node $node
	 * @param string $type
	 * @return Element
	 */
	public static function prependTypedMeta( Node $node, string $type ): Element {
		$meta = $node->ownerDocument->createElement( 'meta' );
		DOMUtils::addTypeOf( $meta, $type );
		$node->parentNode->insertBefore( $meta, $node );
		return $meta;
	}

	/**
	 * @param Element $node
	 * @param array $ignoreableAttribs
	 * @return array
	 */
	private static function getAttributes( Element $node, array $ignoreableAttribs ): array {
		$h = DOMUtils::attributes( $node );
		$count = 0;
		foreach ( $h as $name => $value ) {
			if ( in_array( $name, $ignoreableAttribs, true ) ) {
				$count++;
				unset( $h[$name] );
			}
		}
		// If there's no special attribute handler, we want a straight
		// comparison of these.
		if ( !in_array( 'data-parsoid', $ignoreableAttribs, true ) ) {
			$h['data-parsoid'] = DOMDataUtils::getDataParsoid( $node );
		}
		if ( !in_array( 'data-mw', $ignoreableAttribs, true ) && DOMDataUtils::validDataMw( $node ) ) {
			$h['data-mw'] = DOMDataUtils::getDataMw( $node );
		}
		return $h;
	}

	/**
	 * Attribute equality test.
	 *
	 * @param Element $nodeA
	 * @param Element $nodeB
	 * @param array $ignoreableAttribs
	 * @param array $specializedAttribHandlers
	 * @return bool
	 */
	public static function attribsEquals(
		Element $nodeA, Element $nodeB, array $ignoreableAttribs, array $specializedAttribHandlers
	): bool {
		$hA = self::getAttributes( $nodeA, $ignoreableAttribs );
		$hB = self::getAttributes( $nodeB, $ignoreableAttribs );

		if ( count( $hA ) !== count( $hB ) ) {
			return false;
		}

		$keysA = array_keys( $hA );
		sort( $keysA );
		$keysB = array_keys( $hB );
		sort( $keysB );

		foreach ( $keysA as $i => $k ) {
			if ( $k !== $keysB[$i] ) {
				return false;
			}

			$attribEquals = $specializedAttribHandlers[$k] ?? null;
			if ( $attribEquals ) {
				// Use a specialized compare function, if provided
				if ( !$hA[$k] || !$hB[$k] || !$attribEquals( $nodeA, $hA[$k], $nodeB, $hB[$k] ) ) {
					return false;
				}
			} elseif ( $hA[$k] !== $hB[$k] ) {
				return false;
			}
		}

		return true;
	}
}
