<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt\DOMHandlers;

use DOMElement;
use DOMNode;
use Wikimedia\Parsoid\Html2Wt\DiffUtils;
use Wikimedia\Parsoid\Html2Wt\SerializerState;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\WTUtils;

class LIHandler extends DOMHandler {

	public function __construct() {
		parent::__construct( true );
	}

	/** @inheritDoc */
	public function handle(
		DOMElement $node, SerializerState $state, bool $wrapperUnmodified = false
	): ?DOMNode {
		$firstChildElement = DOMUtils::firstNonSepChild( $node );
		if ( !DOMUtils::isList( $firstChildElement )
			 || WTUtils::isLiteralHTMLNode( $firstChildElement )
		) {
			$state->emitChunk( $this->getListBullets( $state, $node ), $node );
		}
		$liHandler = function ( $state, $text, $opts ) use ( $node ) {
			return $state->serializer->wteHandlers->liHandler( $node, $state, $text, $opts );
		};
		$state->singleLineContext->enforce();
		$state->serializeChildren( $node, $liHandler );

		// Recover trailing whitespace (only on unmodified innermost <li> nodes);
		// Consider "*** foo ". Since WS is only trimmed on the innermost <li> node,
		// it makes sense to recover this only for the innermost <li> node.
		// [ Given current DSR offsets, without this check, we'll recover one space for
		//   every nested <li> node which makes for lotsa dirty diffs. ]
		$lastChild = DOMUtils::lastNonSepChild( $node );
		if ( $lastChild && !DOMUtils::isList( $lastChild ) &&
			!DiffUtils::hasDiffMarkers( $lastChild, $state->getEnv() )
		) {
			$trailingSpace = $state->recoverTrimmedWhitespace( $node, false );
			if ( $trailingSpace ) {
				$state->appendSep( $trailingSpace, $node );
			}
		}

		$state->singleLineContext->pop();
		return $node->nextSibling;
	}

	/** @inheritDoc */
	public function before( DOMElement $node, DOMNode $otherNode, SerializerState $state ): array {
		if ( ( $otherNode === $node->parentNode
				&& in_array( $otherNode->nodeName, [ 'ul', 'ol' ], true ) )
			|| ( DOMUtils::isElt( $otherNode )
				&& $otherNode instanceof DOMElement // for static type analyzers
				&& ( DOMDataUtils::getDataParsoid( $otherNode )->stx ?? null ) === 'html' )
		) {
			return [];
		} else {
			return [ 'min' => 1, 'max' => 2 ];
		}
	}

	/** @inheritDoc */
	public function after( DOMElement $node, DOMNode $otherNode, SerializerState $state ): array {
		return $this->wtListEOL( $node, $otherNode );
	}

	/** @inheritDoc */
	public function firstChild( DOMElement $node, DOMNode $otherNode, SerializerState $state ): array {
		if ( !DOMUtils::isList( $otherNode ) ) {
			return [ 'min' => 0, 'max' => 0 ];
		} else {
			return [];
		}
	}

}
