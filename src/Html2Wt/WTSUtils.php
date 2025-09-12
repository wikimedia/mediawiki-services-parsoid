<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt;

use Wikimedia\Assert\UnreachableException;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\DOM\Text;
use Wikimedia\Parsoid\NodeData\DataMw;
use Wikimedia\Parsoid\NodeData\DataMwAttrib;
use Wikimedia\Parsoid\Utils\DiffDOMUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\WTUtils;

class WTSUtils {

	public static function isValidSep( string $sep ): bool {
		/* TODO (Anomie)
		You might be able to simplify the regex a bit using a no-backtracking group:
		'/^(?>\s*<!--.*?-->)*\s*$/s'
		Although I'm not sure that'll actually run faster.*/
		return (bool)preg_match( '/^(\s|<!--([^\-]|-(?!->))*-->)*$/uD', $sep );
	}

	public static function hasValidTagWidths( ?DomSourceRange $dsr ): bool {
		return $dsr !== null && $dsr->hasValidTagWidths();
	}

	/**
	 * For new elements, attrs are always considered modified.  However, For
	 * old elements, we only consider an attribute modified if we have shadow
	 * info for it and it doesn't match the current value.
	 * Returns array with data:
	 * [
	 * value => mixed,
	 * modified => bool (If the value of the attribute changed since we parsed the wikitext),
	 * fromsrc => bool (Whether we got the value from source-based roundtripping)
	 * ]
	 *
	 * @param Element $node
	 * @param string $name
	 * @param ?string $curVal
	 * @return array{value: mixed, modified: bool, fromsrc: bool}
	 */
	public static function getShadowInfo( Element $node, string $name, ?string $curVal ): array {
		$dp = DOMDataUtils::getDataParsoid( $node );

		// Not the case, continue regular round-trip information.
		if ( !isset( $dp->a ) || !array_key_exists( $name, $dp->a ) ) {
			return [
				'value' => $curVal,
				// Mark as modified if a new element
				'modified' => WTUtils::isNewElt( $node ),
				'fromsrc' => false
			];
		} elseif ( $dp->a[$name] !== $curVal ) {
			return [
				'value' => $curVal,
				'modified' => true,
				'fromsrc' => false
			];
		} elseif ( !isset( $dp->sa ) || !array_key_exists( $name, $dp->sa ) ) {
			return [
				'value' => $curVal,
				'modified' => false,
				'fromsrc' => false
			];
		} else {
			return [
				'value' => $dp->sa[$name],
				'modified' => false,
				'fromsrc' => true
			];
		}
	}

	/**
	 * Get shadowed information about an attribute on a node.
	 * Returns array with data:
	 * [
	 * value => mixed,
	 * modified => bool (If the value of the attribute changed since we parsed the wikitext),
	 * fromsrc => bool (Whether we got the value from source-based roundtripping)
	 * ]
	 *
	 * @param Element $node
	 * @param string $name
	 * @return array
	 */
	public static function getAttributeShadowInfo( Element $node, string $name ): array {
		return self::getShadowInfo(
			$node,
			$name,
			DOMCompat::getAttribute( $node, $name )
		);
	}

	public static function commentWT( string $comment ): string {
		return '<!--' . WTUtils::decodeComment( $comment ) . '-->';
	}

	/**
	 * In wikitext, did origNode occur next to a block node which has been
	 * deleted? While looking for next, we look past DOM nodes that are
	 * transparent in rendering. (See emitsSolTransparentSingleLineWT for
	 * which nodes.)
	 *
	 * @param ?Node $origNode
	 * @param bool $before
	 * @return bool
	 */
	public static function nextToDeletedBlockNodeInWT(
		?Node $origNode, bool $before
	): bool {
		if ( !$origNode || DOMUtils::atTheTop( $origNode ) ) {
			return false;
		}

		while ( true ) {
			// Find the nearest node that shows up in HTML (ignore nodes that show up
			// in wikitext but don't affect sol-state or HTML rendering -- note that
			// whitespace is being ignored, but that whitespace occurs between block nodes).
			$node = $origNode;
			do {
				$node = $before ? $node->previousSibling : $node->nextSibling;
				if ( DiffUtils::maybeDeletedNode( $node ) ) {
					return DiffUtils::isDeletedBlockNode( $node );
				}
			} while ( $node && WTUtils::emitsSolTransparentSingleLineWT( $node ) );

			if ( $node ) {
				return false;
			} else {
				// Walk up past zero-width wikitext parents
				$node = $origNode->parentNode;
				if ( !WTUtils::isZeroWidthWikitextElt( $node ) ) {
					// If the parent occupies space in wikitext,
					// clearly, we are not next to a deleted block node!
					// We'll eventually hit BODY here and return.
					return false;
				}
				$origNode = $node;
			}
		}
	}

	/**
	 * Check if whitespace preceding this node would NOT trigger an indent-pre.
	 *
	 * @param Node $node
	 * @param Node $sepNode
	 * @return bool
	 */
	public static function precedingSpaceSuppressesIndentPre( Node $node, Node $sepNode ): bool {
		if ( $node !== $sepNode && $node instanceof Text ) {
			// if node is the same as sepNode, then the separator text
			// at the beginning of it has been stripped out already, and
			// we cannot use it to test it for indent-pre safety
			return (bool)preg_match( '/^[ \t]*\n/', $node->nodeValue );
		} elseif ( DOMUtils::nodeName( $node ) === 'br' ) {
			return true;
		} elseif ( WTUtils::isFirstEncapsulationWrapperNode( $node ) ) {
			'@phan-var Element $node'; // @var Element $node
			// Dont try any harder than this
			return !$node->hasChildNodes() || DOMCompat::getInnerHTML( $node )[0] === "\n";
		} else {
			return WTUtils::isBlockNodeWithVisibleWT( $node );
		}
	}

	public static function traceNodeName( Node $node ): string {
		switch ( $node->nodeType ) {
			case XML_ELEMENT_NODE:
				return ( DiffUtils::isDiffMarker( $node ) ) ? 'DIFF_MARK' : 'NODE: ' . DOMUtils::nodeName( $node );
			case XML_TEXT_NODE:
				return 'TEXT: ' . PHPUtils::jsonEncode( $node->nodeValue );
			case XML_COMMENT_NODE:
				return 'CMT : ' . PHPUtils::jsonEncode( self::commentWT( $node->nodeValue ) );
			default:
				return DOMUtils::nodeName( $node );
		}
	}

	/**
	 * In selser mode, check if an unedited node's wikitext from source wikitext
	 * is reusable as is.
	 *
	 * @param SerializerState $state
	 * @param Node $node
	 * @return bool
	 */
	public static function origSrcValidInEditedContext( SerializerState $state, Node $node ): bool {
		if ( WTUtils::isRedirectLink( $node ) ) {
			return DOMUtils::atTheTop( $node->parentNode ) && !$node->previousSibling;
		} elseif ( self::dsrContainsOpenExtendedRangeAnnotationTag( $node, $state ) ) {
			return false;
		} elseif ( DOMUtils::nodeName( $node ) === 'th' || DOMUtils::nodeName( $node ) === 'td' ) {
			'@phan-var Element $node'; // @var Element $node
			// The wikitext representation for them is dependent
			// on cell position (first cell is always single char).

			// If there is no previous sibling, nothing to worry about.
			$prev = $node->previousSibling;
			if ( !$prev ) {
				return true;
			}

			if (
				DiffUtils::hasInsertedDiffMark( $prev ) ||
				DiffUtils::hasInsertedDiffMark( $node )
			) {
				return false;
			}

			// If previous sibling is unmodified, nothing to worry about.
			if (
				!DiffUtils::isDiffMarker( $prev ) &&
				!DiffUtils::directChildrenChanged( $prev )
			) {
				return true;
			}

			// If it didn't have a stx marker that indicated that the cell
			// showed up on the same line via the "||" or "!!" syntax, nothing
			// to worry about.
			return ( DOMDataUtils::getDataParsoid( $node )->stx ?? '' ) !== 'row';
		} elseif (
			$node instanceof Element && DOMUtils::nodeName( $node ) === 'tr' &&
			!isset( DOMDataUtils::getDataParsoid( $node )->startTagSrc )
		) {
			// If this <tr> didn't have a startTagSrc, it would have been
			// the first row of a table in original wikitext. So, it is safe
			// to reuse the original source for the row (without a "|-") as long as
			// it continues to be the first row of the table.  If not, since we need to
			// insert a "|-" to separate it from the newly added row (in an edit),
			// we cannot simply reuse orig. wikitext for this <tr>.
			return !DiffDOMUtils::previousNonSepSibling( $node );
		} elseif ( DOMUtils::isNestedListOrListItem( $node ) ) {
			if ( DOMUtils::isList( $node ) ) {
				// Lists never get bullets assigned to them. So, unless they
				// start a fresh list ( => they have a previous sibling ),
				// we cannot reuse source for nested lists.
				if ( !$node->previousSibling ) {
					return false;
				}
			} else {
				// Consider this wikitext snippet and its output below:
				//
				//   ** a
				//   *** b
				//
				//   <ul><li-*>
				//   <ul><li-*> a              <-- cannot reuse source of this <li>
				//   <ul><li-***> b</li></ul>  <-- can reuse source of this <li>
				//   </li></ul>
				//   </li></ul>
				//
				// If we reuse the src for the inner li with the a, we'd be missing
				// one bullet because the tag handler for lists in the serializer only
				// emits start tag src when it hits a first child that isn't a list
				// element. We need to walk up and get the other bullet(s).
				//
				// The above logic can be condensed into this observation.
				// Reusable nested <li> nodes will always have multiple bullets.
				// Don't reuse source from any nested list
				$dp = DOMDataUtils::getDataParsoid( $node );
				if ( !isset( $dp->dsr ) || $dp->dsr->openWidth < 2 ) {
					return false;
				}
			}

			// If a previous sibling was modified, we can't reuse the start dsr.
			$prev = $node->previousSibling;
			while ( $prev ) {
				if ( DiffUtils::isDiffMarker( $prev ) || DiffUtils::hasInsertedDiffMark( $prev ) ) {
					return false;
				}
				$prev = $prev->previousSibling;
			}

			return true;
		} elseif ( WTUtils::isMovedMetaTag( $node ) ) {
			return false;
		} else {
			return true;
		}
	}

	/**
	 * We keep track in $state of all extended ranges that are currently open by a <meta> tag.
	 * This method checks whether the wikitext source pointed by the dsr of the node contains either
	 * an opening or closing tag matching that annotation (<translate> or </translate> for example.)
	 * @param Node $node
	 * @param SerializerState $state
	 * @return bool
	 */
	private static function dsrContainsOpenExtendedRangeAnnotationTag( Node $node,
		SerializerState $state
	): bool {
		if ( ( !$state->openAnnotations ) || !$node instanceof Element ) {
			return false;
		}

		$dsr = DOMDataUtils::getDataParsoid( $node )->dsr ?? null;
		if ( !$dsr ) {
			return false;
		}
		$src = $state->getOrigSrc( $dsr->innerRange() );
		foreach ( $state->openAnnotations as $ann => $extended ) {
			if ( $extended ) {
				if ( preg_match( '</?' . $ann . '.*>', $src ) ) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * FIXME: This method should probably be moved to DOMDataUtils class since
	 * it is used by both html2wt and wt2html code
	 *
	 * @param DataMw $dataMw
	 * @param string $key
	 * @param bool $keep
	 * @return ?DataMwAttrib
	 */
	public static function getAttrFromDataMw(
		DataMw $dataMw, string $key, bool $keep
	): ?DataMwAttrib {
		$arr = $dataMw->attribs ?? [];
		$i = false;
		foreach ( $arr as $k => $a ) {
			if ( is_string( $a->key ) ) {
				$txt = $a->key;
			} elseif ( is_array( $a->key ) ) {
				$txt = $a->key['txt'] ?? null;
			} else {
				throw new UnreachableException( 'Control should never get here!' );
			}
			if ( $txt === $key ) {
				$i = $k;
				break;
			}
		}
		if ( $i === false ) {
			return null;
		}

		$ret = $arr[$i];
		if ( !$keep && !isset( $ret->value['html'] ) ) {
			array_splice( $arr, $i, 1 );
			$dataMw->attribs = $arr;
		}
		return $ret;
	}

	/**
	 * Escape `<nowiki>` tags.
	 *
	 * @param string $text
	 * @return string
	 */
	public static function escapeNowikiTags( string $text ): string {
		return preg_replace( '#<(/?nowiki\s*/?\s*)>#i', '&lt;$1&gt;', $text );
	}

	public static function hasNonIgnorableAttributes( Element $node ): bool {
		foreach ( DOMCompat::attributes( $node ) as $k => $v ) {
			$k = (string)$k;
			if (
				!preg_match( '/^data-parsoid/', $k ) &&
				( $k !== DOMDataUtils::DATA_OBJECT_ATTR_NAME ) &&
				!( $k === 'id' && preg_match( '/^mw[\w-]{2,}$/D', $v ) )
			) {
				return true;
			}
		}
		return false;
	}

}
