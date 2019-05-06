<?php
declare( strict_types = 1 );

namespace Parsoid\Html2Wt\DOMHandlers;

use DOMElement;
use DOMNode;
use LogicException;
use Parsoid\Html2Wt\SerializerState;
use Parsoid\Html2Wt\WTSUtils;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\Util;
use Parsoid\Utils\WTUtils;

/**
 * PORT-FIXME: document class, methods & properties
 */
class DOMHandler {

	/** @var bool */
	private $forceSOL;

	/**
	 * @param bool $forceSOL
	 */
	public function __construct( bool $forceSOL ) {
		$this->forceSOL = $forceSOL;
	}

	/**
	 * Serialize a DOM node to wikitext.
	 * Serialized wikitext should be returned via $state::emitChunk().
	 * @param DOMElement $node
	 * @param SerializerState $state
	 * @param bool $wrapperUnmodified
	 * @return DOMElement|null The node to continue with. If $node is returned, the
	 *   serialization will continue with the next sibling. Returning null or the root node of
	 *   the serialization means serialization is finished.
	 */
	public function handle(
		DOMElement $node, SerializerState $state, bool $wrapperUnmodified = false
	): ?DOMElement {
		throw new LogicException( 'Not implemented.' );
	}

	/**
	 * @param DOMElement $node
	 * @param DOMNode $otherNode
	 * @param SerializerState $state
	 * @return array
	 */
	public function before( DOMElement $node, DOMNode $otherNode, SerializerState $state ): array {
		return [];
	}

	/**
	 * @param DOMElement $node
	 * @param DOMNode $otherNode
	 * @param SerializerState $state
	 * @return array
	 */
	public function after( DOMElement $node, DOMNode $otherNode, SerializerState $state ): array {
		return [];
	}

	/**
	 * @param DOMElement $node
	 * @param DOMNode $otherNode
	 * @param SerializerState $state
	 * @return array
	 */
	public function firstChild( DOMElement $node, DOMNode $otherNode, SerializerState $state ): array {
		return [];
	}

	/**
	 * @param DOMElement $node
	 * @param DOMNode $otherNode
	 * @param SerializerState $state
	 * @return array
	 */
	public function lastChild( DOMElement $node, DOMNode $otherNode, SerializerState $state ): array {
		return [];
	}

	/**
	 * @return bool
	 */
	public function isForceSOL(): bool {
		return $this->forceSOL;
	}

	/**
	 * @param DOMElement $node
	 * @param DOMNode $otherNode
	 * @return array An array in the form [ 'min' => <int>, 'max' => <int> ] or an empty array.
	 */
	protected function wtListEOL( DOMElement $node, DOMNode $otherNode ): array {
		if ( !DOMUtils::isElt( $otherNode ) || DOMUtils::isBody( $otherNode ) ) {
			return [ 'min' => 0, 'max' => 2 ];
		}
		'@phan-var DOMElement $otherNode';/** @var DOMElement $otherNode */

		if ( WTUtils::isFirstEncapsulationWrapperNode( $otherNode ) ) {
			return [ 'min' => DOMUtils::isList( $node ) ? 1 : 0, 'max' => 2 ];
		}

		$nextSibling = DOMUtils::nextNonSepSibling( $node );
		$dp = DOMDataUtils::getDataParsoid( $otherNode );
		if ( $nextSibling === $otherNode && ( $dp->stx ?? null ) === 'html' || isset( $dp->src ) ) {
			return [ 'min' => 0, 'max' => 2 ];
		} elseif ( $nextSibling === $otherNode && DOMUtils::isListOrListItem( $otherNode ) ) {
			if ( DOMUtils::isList( $node ) && $otherNode->nodeName === $node->nodeName ) {
				// Adjacent lists of same type need extra newline
				return [ 'min' => 2, 'max' => 2 ];
			} elseif ( DOMUtils::isListItem( $node )
				|| in_array( $node->parentNode->nodeName, [ 'li', 'dd' ], true )
			) {
				// Top-level list
				return [ 'min' => 1, 'max' => 1 ];
			} else {
				return [ 'min' => 1, 'max' => 2 ];
			}
		} elseif ( DOMUtils::isList( $otherNode )
			|| ( DOMUtils::isElt( $otherNode ) && $dp->stx === 'html' )
		) {
			// last child in ul/ol (the list element is our parent), defer
			// separator constraints to the list.
			return [];
		} elseif ( DOMUtils::isBlockNode( $node->parentNode )
			&& DOMUtils::lastNonSepChild( $node->parentNode ) === $node
		) {
			// A list in a block node (<div>, <td>, etc) doesn't need a trailing empty line
			// if it is the last non-separator child (ex: <div>..</ul></div>)
			return [ 'min' => 1, 'max' => 2 ];
		} elseif ( DOMUtils::isFormattingElt( $otherNode ) ) {
			return [ 'min' => 1, 'max' => 1 ];
		} else {
			return [ 'min' => 2, 'max' => 2 ];
		}
	}

	/**
	 * List helper: DOM-based list bullet construction.
	 * @param SerializerState $state
	 * @param DOMElement $node
	 * @return string
	 */
	protected function getListBullets( SerializerState $state, DOMElement $node ): string {
		$parentTypes = [
			'ul' => '*',
			'ol' => '#'
		];
		$listTypes = [
			'ul' => '',
			'ol' => '',
			'dl' => '',
			'li' => '',
			'dt' => ';',
			'dd' => ':'
		];

		// For new elements, for prettier wikitext serialization,
		// emit a space after the last bullet (if required)
		$space = $this->getLeadingSpace( $state, $node, ' ' );

		$res = '';
		while ( $node ) {
			$dp = DOMDataUtils::getDataParsoid( $node );

			if ( $dp->stx !== 'html' && isset( $listTypes[$node->nodeName] ) ) {
				if ( $node->nodeName === 'li' ) {
					$parentNode = $node->parentNode;
					while ( $parentNode && !( isset( $parentTypes[$parentNode->nodeName] ) ) ) {
						$parentNode = $parentNode->parentNode;
					}

					if ( $parentNode ) {
						$res = $parentTypes[$parentNode->nodeName] . $res;
					} else {
						$state->getEnv()->log( 'error/html2wt', 'Input DOM is not well-formed.',
							"Top-level <li> found that is not nested in <ol>/<ul>\n LI-node:",
							DOMCompat::getOuterHTML( $node )
						);
					}
				} else {
					$res = $listTypes[$node->nodeName] . $res;
				}
			} elseif ( $dp->stx !== 'html' || !$dp->autoInsertedStart || !$dp->autoInsertedEnd ) {
				break;
			}

			$node = $node->parentNode;
		}

		// Don't emit a space if we aren't returning any bullets.
		return strlen( $res ) ? $res . $space : '';
	}

	/**
	 * @param SerializerState $state
	 * @param DOMElement $node
	 * @param string $newEltDefault
	 * @return string
	 */
	protected function getLeadingSpace(
		SerializerState $state, DOMElement $node, string $newEltDefault
	): string {
		$space = '';
		$fc = DOMUtils::firstNonDeletedChild( $node );
		if ( WTUtils::isNewElt( $node ) ) {
			// PORT-FIXME are different \s semantics going to be a problem?
			if ( $fc && ( !DOMUtils::isText( $fc ) || !preg_match( '/^\s/', $fc->nodeValue ) ) ) {
				$space = $newEltDefault;
			}
		} elseif ( $state->useWhitespaceHeuristics && $state->selserMode
			&& ( !$fc || !DOMUtils::isElt( $fc ) )
		) {
			$dsr = DOMDataUtils::getDataParsoid( $node )->dsr;
			if ( Util::isValidDSR( $dsr, true ) ) {
				$offset = $dsr[0] + $dsr[2];
				$space = ( $offset < $dsr[1] - $dsr[3] ) ? $state->getOrigSrc( $offset, $offset + 1 ) : '';
				if ( !preg_match( '/[ \t]/', $space ) ) {
					$space = '';
				}
			}
		}
		return $space;
	}

	/**
	 * @param DOMElement $node
	 * @param DOMNode $origNode
	 * @return int
	 */
	protected function maxNLsInTable( DOMElement $node, DOMNode $origNode ): int {
		return ( WTUtils::isNewElt( $node ) || WTUtils::isNewElt( $origNode ) ) ? 1 : 2;
	}

	/**
	 * @param string $symbol
	 * @param string|null $endSymbol
	 * @param SerializerState $state
	 * @param DOMElement $node
	 * @return bool|string
	 */
	private function serializeTableElement(
		string $symbol, ?string $endSymbol, SerializerState $state, DOMElement $node
	) {
		$token = WTSUtils::mkTagTk( $node );
		$sAttribs = $state->serializer->serializeAttributes( $node, $token );
		if ( $sAttribs !== '' ) {
			// IMPORTANT: use ?? not ?: in the first check because we want to preserve an
			// empty string. Use != '' in the second to avoid treating '0' as empty.
			return $symbol . ' ' . $sAttribs . ( $endSymbol ?? ' |' );
		} else {
			return $symbol . ( ( $endSymbol != '' ) ? $endSymbol : '' );
		}
	}

	/**
	 * @param string $symbol
	 * @param string|null $endSymbol
	 * @param SerializerState $state
	 * @param DOMElement $node
	 * @param bool $wrapperUnmodified
	 * @return string
	 */
	protected function serializeTableTag(
		string $symbol,
		?string $endSymbol,
		SerializerState $state,
		DOMElement $node,
		bool $wrapperUnmodified
	): string {
		if ( $wrapperUnmodified ) {
			$dsr = DOMDataUtils::getDataParsoid( $node )->dsr;
			return $state->getOrigSrc( $dsr[0], $dsr[0] + $dsr[2] );
		} else {
			return $this->serializeTableElement( $symbol, $endSymbol, $state, $node );
		}
	}

	/**
	 * @param SerializerState $state
	 * @param DOMElement $node
	 * @return bool
	 */
	protected function stxInfoValidForTableCell( SerializerState $state, DOMElement $node ): bool {
		// If row syntax is not set, nothing to worry about
		if ( ( DOMDataUtils::getDataParsoid( $node )->stx ?? null ) !== 'row' ) {
			return true;
		}

		// If we have an identical previous sibling, nothing to worry about
		$prev = DOMUtils::previousNonDeletedSibling( $node );
		return $prev !== null && $prev->nodeName === $node->nodeName;
	}

	/**
	 * @param SerializerState $state
	 * @param DOMElement $node
	 * @param string $newEltDefault
	 * @return string
	 */
	protected function getTrailingSpace(
		SerializerState $state, DOMElement $node, string $newEltDefault
	): string {
		$space = '';
		$lc = DOMUtils::lastNonDeletedChild( $node );
		if ( WTUtils::isNewElt( $node ) ) {
			// PORT-FIXME are different \s semantics going to be a problem?
			if ( $lc && ( !DOMUtils::isText( $lc ) || !preg_match( '/\s$/', $lc->nodeValue ) ) ) {
				$space = $newEltDefault;
			}
		} elseif ( $state->useWhitespaceHeuristics && $state->selserMode
			&& ( !$lc || !DOMUtils::isElt( $lc ) )
		) {
			$dsr = DOMDataUtils::getDataParsoid( $node )->dsr;
			if ( Util::isValidDSR( $dsr, true ) ) {
				$offset = $dsr[1] - $dsr[3] - 1;
				// The > instead of >= is to deal with an edge case
				// = = where that single space is captured by the
				// getLeadingSpace case above
				$space = ( $offset > $dsr[0] + $dsr[2] ) ? $state->getOrigSrc( $offset, $offset + 1 ) : '';
				if ( !preg_match( '/[ \t]/', $space ) ) {
					$space = '';
				}
			}
		}

		return $space;
	}

	/**
	 * @param DOMNode $node
	 * @return bool
	 */
	protected function isBuilderInsertedElt( DOMNode $node ): bool {
		if ( !DOMUtils::isElt( $node ) ) {
			return false;
		}
		'@phan-var DOMElement $node';/** @var DOMElement $node*/
		$dp = DOMDataUtils::getDataParsoid( $node );
		return $dp && !empty( $dp->autoInsertedStart ) && !empty( $dp->autoInsertedEnd );
	}

	/**
	 * Uneditable forms wrapped with mw:Placeholder tags OR unedited nowikis
	 * N.B. We no longer emit self-closed nowikis as placeholders, so remove this
	 * once all our stored content is updated.
	 * @param DOMElement $node
	 * @param SerializerState $state
	 */
	protected function emitPlaceholderSrc( DOMElement $node, SerializerState $state ) {
		$dp = DOMDataUtils::getDataParsoid( $node );
		if ( preg_match( '/<nowiki\s*\/>/', ( $dp->src ?? '' ) ) ) {
			$state->hasSelfClosingNowikis = true;
		}
		// FIXME: Should this also check for tabs and plain space
		// chars interspersed with newlines?
		if ( preg_match( '/^\n+$/', ( $dp->src ?? '' ) ) ) {
			$state->appendSep( $dp->src );
		} else {
			$state->serializer->emitWikitext( $dp->src, $node );
		}
	}

}
