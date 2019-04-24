<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\Util as Util;
use Parsoid\WTUtils as WTUtils;
use Parsoid\WTSUtils as WTSUtils;

class DOMHandler {
	public function __construct( $forceSOL ) {
		$this->forceSOL = $forceSOL;
		$this->handle = /* async */$this->handleG;
		$this->serializeTableTag = /* async */$this->serializeTableTagG;
		$this->serializeTableElement = /* async */$this->serializeTableElementG;
	}
	public $forceSOL;
	public $handle;
	public $serializeTableTag;
	public $serializeTableElement;

	public function handleG( $node, $state, $wrapperUnmodified ) {
 // eslint-disable-line require-yield
		throw new Error( 'Not implemented.' );
	}
	public function before( $node, $otherNode, $state ) {
		return [];
	}
	public function after( $node, $otherNode, $state ) {
		return [];
	}
	public function firstChild( $node, $otherNode, $state ) {
		return [];
	}
	public function lastChild( $node, $otherNode, $state ) {
		return [];
	}

	public function wtListEOL( $node, $otherNode ) {
		if ( !DOMUtils::isElt( $otherNode ) || DOMUtils::isBody( $otherNode ) ) {
			return [ 'min' => 0, 'max' => 2 ];
		}

		if ( WTUtils::isFirstEncapsulationWrapperNode( $otherNode ) ) {
			return [ 'min' => ( DOMUtils::isList( $node ) ) ? 1 : 0, 'max' => 2 ];
		}

		$nextSibling = DOMUtils::nextNonSepSibling( $node );
		$dp = DOMDataUtils::getDataParsoid( $otherNode );
		if ( $nextSibling === $otherNode && $dp->stx === 'html' || $dp->src !== null ) {
			return [ 'min' => 0, 'max' => 2 ];
		} elseif ( $nextSibling === $otherNode && DOMUtils::isListOrListItem( $otherNode ) ) {
			if ( DOMUtils::isList( $node ) && $otherNode->nodeName === $node->nodeName ) {
				// Adjacent lists of same type need extra newline
				return [ 'min' => 2, 'max' => 2 ];
			} elseif ( DOMUtils::isListItem( $node ) || isset( [ 'LI' => 1, 'DD' => 1 ][ $node->parentNode->nodeName ] ) ) {
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
			// A list in a block node (<div>, <td>, etc) doesn't need a trailing empty line
			// if it is the last non-separator child (ex: <div>..</ul></div>)
		} elseif ( DOMUtils::isBlockNode( $node->parentNode ) && DOMUtils::lastNonSepChild( $node->parentNode ) === $node ) {
			return [ 'min' => 1, 'max' => 2 ];
		} elseif ( DOMUtils::isFormattingElt( $otherNode ) ) {
			return [ 'min' => 1, 'max' => 1 ];
		} else {
			return [ 'min' => 2, 'max' => 2 ];
		}
	}

	/**
	 * List helper: DOM-based list bullet construction.
	 */
	public function getListBullets( $state, $node ) {
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

		$dp = null;
$nodeName = null;
$parentName = null;
		$res = '';
		while ( $node ) {
			$nodeName = strtolower( $node->nodeName );
			$dp = DOMDataUtils::getDataParsoid( $node );

			if ( $dp->stx !== 'html' && isset( $listTypes[ $nodeName ] ) ) {
				if ( $nodeName === 'li' ) {
					$parentNode = $node->parentNode;
					while ( $parentNode && !( isset( $parentTypes[ strtolower( $parentNode->nodeName ) ] ) ) ) {
						$parentNode = $parentNode->parentNode;
					}

					if ( $parentNode ) {
						$parentName = strtolower( $parentNode->nodeName );
						$res = $parentTypes[ $parentName ] + $res;
					} else {
						$state->env->log( 'error/html2wt', 'Input DOM is not well-formed.',
							"Top-level <li> found that is not nested in <ol>/<ul>\n LI-node:",
							$node->outerHTML
						);
					}
				} else {
					$res = $listTypes[ $nodeName ] + $res;
				}
			} elseif ( $dp->stx !== 'html' || !$dp->autoInsertedStart || !$dp->autoInsertedEnd ) {
				break;
			}

			$node = $node->parentNode;
		}

		// Don't emit a space if we aren't returning any bullets.
		return ( count( $res ) ) ? $res + $space : '';
	}

	public function getLeadingSpace( $state, $node, $newEltDefault ) {
		$space = '';
		$fc = DOMUtils::firstNonDeletedChild( $node );
		if ( WTUtils::isNewElt( $node ) ) {
			if ( $fc && ( !DOMUtils::isText( $fc ) || !preg_match( '/^\s/', $fc->nodeValue ) ) ) {
				$space = $newEltDefault;
			}
		} elseif ( $state->useWhitespaceHeuristics && $state->selserMode && ( !$fc || !DOMUtils::isElt( $fc ) ) ) {
			$dsr = DOMDataUtils::getDataParsoid( $node )->dsr;
			if ( Util::isValidDSR( $dsr, true ) ) {
				$offset = $dsr[ 0 ] + $dsr[ 2 ];
				$space = ( $offset < ( $dsr[ 1 ] - $dsr[ 3 ] ) ) ? $state->getOrigSrc( $offset, $offset + 1 ) : '';
				if ( !preg_match( '/[ \t]/', $space ) ) {
					$space = '';
				}
			}
		}
		return $space;
	}

	public function maxNLsInTable( $node, $origNode ) {
		return ( WTUtils::isNewElt( $node ) || WTUtils::isNewElt( $origNode ) ) ? 1 : 2;
	}

	public function serializeTableElementG( $symbol, $endSymbol, $state, $node ) {
		$token = WTSUtils::mkTagTk( $node );
		$sAttribs = /* await */ $state->serializer->_serializeAttributes( $node, $token );
		if ( count( $sAttribs ) > 0 ) {
			// IMPORTANT: 'endSymbol !== null' NOT 'endSymbol' since the
			// '' string is a falsy value and we want to treat it as a
			// truthy value.
			return $symbol . ' ' . $sAttribs
. ( ( $endSymbol !== null ) ? $endSymbol : ' |' );
		} else {
			return $symbol + ( $endSymbol || '' );
		}
	}

	public function serializeTableTagG( $symbol, $endSymbol, $state, $node, $wrapperUnmodified ) {
		if ( $wrapperUnmodified ) {
			$dsr = DOMDataUtils::getDataParsoid( $node )->dsr;
			return $state->getOrigSrc( $dsr[ 0 ], $dsr[ 0 ] + $dsr[ 2 ] );
		} else {
			return ( /* await */ $this->serializeTableElement( $symbol, $endSymbol, $state, $node ) );
		}
	}

	public function stxInfoValidForTableCell( $state, $node ) {
		// If row syntax is not set, nothing to worry about
		if ( DOMDataUtils::getDataParsoid( $node )->stx !== 'row' ) {
			return true;
		}

		// If we have an identical previous sibling, nothing to worry about
		$prev = DOMUtils::previousNonDeletedSibling( $node );
		return $prev !== null && $prev->nodeName === $node->nodeName;
	}

	public function getTrailingSpace( $state, $node, $newEltDefault ) {
		$space = '';
		$lc = DOMUtils::lastNonDeletedChild( $node );
		if ( WTUtils::isNewElt( $node ) ) {
			if ( $lc && ( !DOMUtils::isText( $lc ) || !preg_match( '/\s$/', $lc->nodeValue ) ) ) {
				$space = $newEltDefault;
			}
		} elseif ( $state->useWhitespaceHeuristics && $state->selserMode && ( !$lc || !DOMUtils::isElt( $lc ) ) ) {
			$dsr = DOMDataUtils::getDataParsoid( $node )->dsr;
			if ( Util::isValidDSR( $dsr, true ) ) {
				$offset = $dsr[ 1 ] - $dsr[ 3 ] - 1;
				// The > instead of >= is to deal with an edge case
				// = = where that single space is captured by the
				// getLeadingSpace case above
				$space = ( $offset > ( $dsr[ 0 ] + $dsr[ 2 ] ) ) ? $state->getOrigSrc( $offset, $offset + 1 ) : '';
				if ( !preg_match( '/[ \t]/', $space ) ) {
					$space = '';
				}
			}
		}

		return $space;
	}

	public function isBuilderInsertedElt( $node ) {
		if ( !DOMUtils::isElt( $node ) ) { return false;
  }
		$dp = DOMDataUtils::getDataParsoid( $node );
		return $dp && $dp->autoInsertedStart && $dp->autoInsertedEnd;
	}

	// Uneditable forms wrapped with mw:Placeholder tags OR unedited nowikis
	// N.B. We no longer emit self-closed nowikis as placeholders, so remove this
	// once all our stored content is updated.
	public function emitPlaceholderSrc( $node, $state ) {
		$dp = DOMDataUtils::getDataParsoid( $node );
		if ( preg_match( '/<nowiki\s*\/>/', $dp->src ) ) {
			$state->hasSelfClosingNowikis = true;
		}
		// FIXME: Should this also check for tabs and plain space
		// chars interspersed with newlines?
		if ( preg_match( '/^\n+$/', $dp->src ) ) {
			$state->appendSep( $dp->src );
		} else {
			$state->serializer->emitWikitext( $dp->src, $node );
		}
	}
}

$module->exports = $DOMHandler;
