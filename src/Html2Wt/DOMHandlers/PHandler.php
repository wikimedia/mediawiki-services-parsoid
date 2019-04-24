<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

$Consts = require '../../config/WikitextConstants.js'::WikitextConstants;

$temp0 = require '../../utils/DOMUtils.js';
$DOMUtils = $temp0::DOMUtils;
$temp1 = require '../../utils/DOMDataUtils.js';
$DOMDataUtils = $temp1::DOMDataUtils;
$temp2 = require '../../utils/WTUtils.js';
$WTUtils = $temp2::WTUtils;

$DOMHandler = require './DOMHandler.js';

class PHandler extends DOMHandler {
	public function __construct() {
		// Counterintuitive but seems right.
		// Otherwise the generated wikitext will parse as an indent-pre
		// escapeWikitext nowiking will deal with leading space for content
		// inside the p-tag, but forceSOL suppresses whitespace before the p-tag.
		parent::__construct( true );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		// XXX: Handle single-line mode by switching to HTML handler!
		/* await */ $state->serializeChildren( $node );
	}
	public function before( $node, $otherNode, $state ) {
		$otherNodeName = $otherNode->nodeName;
		$tableCellOrBody = new Set( [ 'TD', 'TH', 'BODY' ] );
		if ( $node->parentNode === $otherNode
&& ( DOMUtils::isListItem( $otherNode ) || $tableCellOrBody->has( $otherNodeName ) )
		) {
			if ( $tableCellOrBody->has( $otherNodeName ) ) {
				return [ 'min' => 0, 'max' => 1 ];
			} else {
				return [ 'min' => 0, 'max' => 0 ];
			}
		} elseif (
			$otherNode === DOMUtils::previousNonDeletedSibling( $node )
&& // p-p transition
				( $otherNodeName === 'P' && DOMDataUtils::getDataParsoid( $otherNode )->stx !== 'html' )
||
				self::treatAsPPTransition( $otherNode )
&& $otherNode === DOMUtils::previousNonSepSibling( $node )
&& // A new wikitext line could start at this P-tag. We have to figure out
					// if 'node' needs a separation of 2 newlines from that P-tag. Examine
					// previous siblings of 'node' to see if we emitted a block tag
					// there => we can make do with 1 newline separator instead of 2
					// before the P-tag.
					!$this->currWikitextLineHasBlockNode( $state->currLine, $otherNode )
		) {

			return [ 'min' => 2, 'max' => 2 ];
		} elseif ( self::treatAsPPTransition( $otherNode )
|| ( DOMUtils::isBlockNode( $otherNode ) && $otherNode->nodeName !== 'BLOCKQUOTE' && $node->parentNode === $otherNode )
|| // new p-node added after sol-transparent wikitext should always
				// get serialized onto a new wikitext line.
				( WTUtils::emitsSolTransparentSingleLineWT( $otherNode ) && WTUtils::isNewElt( $node ) )
		) {
			if ( !DOMUtils::hasAncestorOfName( $otherNode, 'FIGCAPTION' ) ) {
				return [ 'min' => 1, 'max' => 2 ];
			} else {
				return [ 'min' => 0, 'max' => 2 ];
			}
		} else {
			return [ 'min' => 0, 'max' => 2 ];
		}
	}
	public function after( $node, $otherNode, $state ) {
		if ( !( $node->lastChild && $node->lastChild->nodeName === 'BR' )
&& self::isPPTransition( $otherNode )
			// A new wikitext line could start at this P-tag. We have to figure out
			// if 'node' needs a separation of 2 newlines from that P-tag. Examine
			// previous siblings of 'node' to see if we emitted a block tag
			// there => we can make do with 1 newline separator instead of 2
			// before the P-tag.
			 && !$this->currWikitextLineHasBlockNode( $state->currLine, $node, true )
			// Since we are going to emit newlines before the other P-tag, we know it
			// is going to start a new wikitext line. We have to figure out if 'node'
			// needs a separation of 2 newlines from that P-tag. Examine following
			// siblings of 'node' to see if we might emit a block tag there => we can
			// make do with 1 newline separator instead of 2 before the P-tag.
			 && !$this->newWikitextLineMightHaveBlockNode( $otherNode )
		) {
			return [ 'min' => 2, 'max' => 2 ];
		} elseif ( DOMUtils::isBody( $otherNode ) ) {
			return [ 'min' => 0, 'max' => 2 ];
		} elseif ( self::treatAsPPTransition( $otherNode )
|| ( DOMUtils::isBlockNode( $otherNode ) && $otherNode->nodeName !== 'BLOCKQUOTE' && $node->parentNode === $otherNode )
		) {
			if ( !DOMUtils::hasAncestorOfName( $otherNode, 'FIGCAPTION' ) ) {
				return [ 'min' => 1, 'max' => 2 ];
			} else {
				return [ 'min' => 0, 'max' => 2 ];
			}
		} else {
			return [ 'min' => 0, 'max' => 2 ];
		}
	}

	// IMPORTANT: Do not start walking from line.firstNode forward. Always
	// walk backward from node. This is because in selser mode, it looks like
	// line.firstNode doesn't always correspond to the wikitext line that is
	// being processed since the previous emitted node might have been an unmodified
	// DOM node that generated multiple wikitext lines.
	public function currWikitextLineHasBlockNode( $line, $node, $skipNode ) {
		$parentNode = $node->parentNode;
		if ( !$skipNode ) {
			// If this node could break this wikitext line and emit
			// non-ws content on a new line, the P-tag will be on that new line
			// with text content that needs P-wrapping.
			if ( preg_match( '/\n[^\s]/', $node->textContent ) ) {
				return false;
			}
		}
		$node = DOMUtils::previousNonDeletedSibling( $node );
		while ( !$node || !DOMUtils::atTheTop( $node ) ) {
			while ( $node ) {
				// If we hit a block node that will render on the same line, we are done!
				if ( WTUtils::isBlockNodeWithVisibleWT( $node ) ) {
					return true;
				}

				// If this node could break this wikitext line, we are done.
				// This is conservative because textContent could be looking at descendents
				// of 'node' that may not have been serialized yet. But this is safe.
				if ( preg_match( '/\n/', $node->textContent ) ) {
					return false;
				}

				$node = DOMUtils::previousNonDeletedSibling( $node );

				// Don't go past the current line in any case.
				if ( $line->firstNode && DOMUtils::isAncestorOf( $node, $line->firstNode ) ) {
					return false;
				}
			}
			$node = $parentNode;
			$parentNode = $node->parentNode;
		}

		return false;
	}

	public function newWikitextLineMightHaveBlockNode( $node ) {
		$node = DOMUtils::nextNonDeletedSibling( $node );
		while ( $node ) {
			if ( DOMUtils::isText( $node ) ) {
				// If this node will break this wikitext line, we are done!
				if ( preg_match( '/\n/', $node->nodeValue ) ) {
					return false;
				}
			} elseif ( DOMUtils::isElt( $node ) ) {
				// These tags will always serialize onto a new line
				if ( Consts\HTMLTagsRequiringSOLContext::has( $node->nodeName )
&& !WTUtils::isLiteralHTMLNode( $node )
				) {
					return false;
				}

				// We hit a block node that will render on the same line
				if ( WTUtils::isBlockNodeWithVisibleWT( $node ) ) {
					return true;
				}

				// Go conservative
				return false;
			}

			$node = DOMUtils::nextNonDeletedSibling( $node );
		}
		return false;
	}

	// node is being serialized before/after a P-tag.
	// While computing newline constraints, this function tests
	// if node should be treated as a P-wrapped node
	public static function treatAsPPTransition( $node ) {
		// Treat text/p similar to p/p transition
		// If an element, it should not be a:
		// * block node or literal HTML node
		// * template wrapper
		// * mw:Includes meta or a SOL-transparent link
		return DOMUtils::isText( $node )
|| !DOMUtils::isBody( $node )
&& !DOMUtils::isBlockNode( $node )
&& !WTUtils::isLiteralHTMLNode( $node )
&& !WTUtils::isEncapsulationWrapper( $node )
&& !WTUtils::isSolTransparentLink( $node )
&& !( preg_match( '/^mw:Includes\//', $node->getAttribute( 'typeof' ) || '' ) );
	}

	public static function isPPTransition( $node ) {
		return $node
&& ( ( $node->nodeName === 'P' && DOMDataUtils::getDataParsoid( $node )->stx !== 'html' )
|| self::treatAsPPTransition( $node ) );
	}
}

$module->exports = $PHandler;
